/**
 * dsh-plugin-catalog — 浏览器半边（客户端插件，classic script）。
 *
 * 只做展示与交互：读状态、搜索排序、开浮窗、点按钮。
 * **不读磁盘、不调模型、不碰 git** —— 那些全在宿主半边（lib/*.mjs）。
 *
 * 席位：
 *   sidebar.panellist  → 侧栏图标（id 与 main 的 key 相同，点图标即切面板）
 *   main               → 中央面板
 *
 * ⚠️ 本插件是**独立客户端插件**：禁用它（或从 dsh.profile.bundles 去掉
 *    dsh-plugin-catalog）即恢复官方界面。界面出问题时这一条能自救。
 *
 * ⚠️ CSS 是模板字符串：注释里**不能有反引号**（会把字符串截断，报一个指向 CSS
 *    中段的 SyntaxError —— 这个坑踩过）。
 *
 * ⚠️ 改了这个文件就提 BUILD 号：客户端会热重载，但没人保证"现在跑的是哪一版"。
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-catalog",
	factory: (require) => {
		const React = require("react");
		const h = React.createElement;
		const { useState, useEffect, useMemo, useRef } = React;

		const API = "/plugin-catalog";
		const PANEL_LABEL = "插件目录";
		const BUILD = "r7.0";
		const PANEL_ID = "catalog";

		const SOURCE_META = {
			official: { label: "官方", cls: "official" },
			self: { label: "自写", cls: "self" },
			third: { label: "第三方", cls: "third" },
			hybrid: { label: "混血", cls: "hybrid" },
			pending: { label: "待标记", cls: "pending" },
		};

		const SORTS = [
			{ id: "calls", label: "调用次数" },
			{ id: "errors", label: "报错次数" },
			/* 率比次数更能看出毛病：23/252 = 9% 和 6/6 = 100% 是两件事，按次数排会把后者藏起来 */
			{ id: "rate", label: "报错率" },
			{ id: "recent", label: "最近使用" },
			{ id: "time", label: "时间" },
			{ id: "name", label: "名称" },
		];

		/* 「用没用」的五个视角 —— 洞察条上就是这五个 chip，点一下就是一次筛选。
		   数字要能直接回答「哪些可以删」：本机 127 条里 86 条从未被调用过；
		   另有一部分**只被子代理调过** —— 这类删掉不会立刻报错，只会让某条委派链悄悄变差。 */
		const USAGE_FILTERS = [
			{ id: "any", label: "全部" },
			{ id: "used", label: "有调用" },
			{ id: "unused", label: "未使用" },
			{ id: "errors", label: "有报错" },
			{ id: "subonly", label: "仅子代理" },
		];

		/* 每个 chip 的说明书 —— 光给数字不解释的话，「仅子代理 0」会被误读成功能坏了 */
		const USAGE_HINTS = {
			any: "全部条目（插件 + Skill）",
			used: "至少被调用过一次",
			unused: "只显示从没被调用过的条目（优先清理对象）",
			errors: "只显示有报错的条目；配合「排序＝报错次数 / 报错率」看",
			subonly: "只显示「每一次调用都发生在子代理会话里」的条目 —— 删掉不会当场报错，只会让某条委派链悄悄变差",
		};

		/* 缓存超过这么久就自动补一次**增量**刷新（只重读变化的会话，实测 0.4~0.7 秒）。
		   ★ 别设得更短：面板每 20 秒轮询一次，阈值太短会退化成「一直在刷新」。 */
		const AUTO_REFRESH_MS = 10 * 60 * 1000;

		/* 列表每页可选条数（127 条一次铺完既卡又难扫，必须能分页） */
		const LIST_PAGE_SIZES = [12, 24, 48, 96, 0]; /* 0 = 全部 */

		/* ── 迷你 store（模块级：面板关着时图标也在用） ── */

		const store = {
			data: null,
			loading: true,
			error: null,
			query: "",
			source: "any",
			kind: "all",
			sort: "calls",
			/* 用没用：any / used / unused / errors / subonly —— 与 USAGE_FILTERS 一一对应 */
			usage: "any",
			page: 1,
			pageSize: 24,
			/* 滚动位置（只用于重载后恢复，不参与渲染） */
			scrollTop: 0,
			open: null,
			detail: null,
			detailLoading: false,
			/* 浮窗里的磁盘体积：懒算，打开一个条目才问一次 */
			size: null,
			sizeError: null,
			tagBusy: false,
			notice: null,
			plan: null,
			uploadBusy: false,
			uploadResult: null,
			report: null,
			reportBusy: false,
			/* 导出当前筛选结果（写进数据目录 reports/，路径给到用户） */
			exportBusy: false,
			exportPath: "",
			exportCount: 0,
			/* 多选（清理决策用）：选择模式下点卡片 = 选中，不进浮窗。
			   ★ 选中项不进 localStorage：重载后清空是**故意的**，避免半个批次被忘在那里。 */
			picking: false,
			picked: [],
			pickedBytes: null,
			pickedSizes: null,
			pickedBusy: false,
		};

		/* ── 视图状态持久化（热重载 / 刷新之后，筛选与滚动位置不再归零） ──
		   ★ 只存**用户动过**的那几个键；`data` / `detail` 每次轮询都变，绝不入库。
		   ★ localStorage 在无头自检里不存在，也可能被浏览器策略关掉 ——
		     所以读、写、恢复三步都必须是"安静地放弃"，不能抛到渲染里。 */
		const VIEW_KEY = "dsh-plugin-catalog/view-v1";
		const VIEW_KEYS = ["query", "source", "kind", "sort", "usage", "pageSize", "page"];

		function readView() {
			try {
				const raw = typeof localStorage !== "undefined" ? localStorage.getItem(VIEW_KEY) : null;
				if (!raw) return null;
				const parsed = JSON.parse(raw);
				if (!parsed || typeof parsed !== "object") return null;
				const view = {};
				for (const key of VIEW_KEYS) {
					if (parsed[key] !== undefined) view[key] = parsed[key];
				}
				view.scrollTop = Number(parsed.scrollTop) || 0;
				return view;
			} catch (error) {
				return null; /* 坏数据 / 存储被禁用，都退回默认视图 */
			}
		}

		function writeView() {
			try {
				if (typeof localStorage === "undefined") return false;
				const view = { scrollTop: store.scrollTop || 0 };
				for (const key of VIEW_KEYS) view[key] = store[key];
				localStorage.setItem(VIEW_KEY, JSON.stringify(view));
				return true;
			} catch (error) {
				return false;
			}
		}

		function touchesView(patch) {
			if (!patch) return false;
			return VIEW_KEYS.some((key) => key in patch);
		}

		/* 模块加载时就把上次的视图接回来（面板还没挂载，所以只改 store） */
		const restoredView = readView();
		if (restoredView) {
			for (const key of VIEW_KEYS) {
				if (restoredView[key] !== undefined) store[key] = restoredView[key];
			}
			store.scrollTop = restoredView.scrollTop || 0;
		}

		/* 滚动时记住位置：每 300ms 最多落一次盘，别让滚轮把 localStorage 打成瓶颈 */
		let scrollSavedAt = 0;
		function rememberScroll(event) {
			const panel = event && event.currentTarget;
			if (!panel) return;
			store.scrollTop = Number(panel.scrollTop) || 0;
			const now = Date.now();
			if (now - scrollSavedAt < 300) return;
			scrollSavedAt = now;
			writeView();
		}

		const listeners = new Set();
		function emit() {
			for (const fn of listeners) {
				try {
					fn();
				} catch (error) {
					/* 单个订阅者出错不能拖垮别的 */
				}
			}
		}
		function set(patch) {
			Object.assign(store, patch);
			/* 换筛选 / 换排序 / 换页之后必须回到顶部：否则第 2 页的第一条会落在屏幕外，
			   看起来像"点了下一页什么都没变"。 */
			if (patch && ("query" in patch || "source" in patch || "kind" in patch || "usage" in patch || "sort" in patch || "page" in patch || "pageSize" in patch)) {
				store.scrollTop = 0;
				try {
					const panel = typeof document !== "undefined" && typeof document.getElementById === "function" ? document.getElementById("dpc-panel") : null;
					if (panel) panel.scrollTop = 0;
				} catch (error) {
					/* 拿不到容器就算了，恢复逻辑本来就是尽力而为 */
				}
			}
			if (touchesView(patch)) writeView();
			emit();
		}
		function useStore() {
			const [, force] = useState(0);
			useEffect(() => {
				const fn = () => force((n) => n + 1);
				listeners.add(fn);
				return () => listeners.delete(fn);
			}, []);
			return store;
		}

		async function api(path, init) {
			const response = await fetch(API + path, {
				headers: { "content-type": "application/json" },
				...init,
			});
			let payload = null;
			try {
				payload = await response.json();
			} catch (error) {
				throw new Error("响应不是 JSON（HTTP " + response.status + "）");
			}
			if (!response.ok && !(payload && payload.ok === false)) {
				throw new Error((payload && payload.error) || "HTTP " + response.status);
			}
			return payload;
		}

		async function refresh() {
			try {
				const data = await api("/state");
				set({ data, loading: false, error: null });
				if (store.open) await loadDetail(store.open.id, store.open.page || 1, store.open.pageSize);
			} catch (error) {
				set({ loading: false, error: String((error && error.message) || error) });
			}
		}

		async function loadDetail(id, page, pageSize) {
			set({ detailLoading: true });
			try {
				const detail = await api("/entry?id=" + encodeURIComponent(id) + "&page=" + (page || 1) + "&pageSize=" + (pageSize || 20));
				set({ detail, detailLoading: false });
			} catch (error) {
				set({ detail: { ok: false, error: String((error && error.message) || error) }, detailLoading: false });
			}
		}

		/** 体积单算一路：慢也不挡浮窗先出来（大目录要递归，不能让详情等它）。 */
		async function loadSize(id) {
			try {
				const result = await api("/size?id=" + encodeURIComponent(id));
				if (store.open && store.open.id === id) set({ size: result.ok ? result.size : null, sizeError: result.ok ? (result.reason || null) : result.error });
			} catch (error) {
				if (store.open && store.open.id === id) set({ size: null, sizeError: String((error && error.message) || error) });
			}
		}

		function openEntry(item) {
			set({ open: { id: item.id, page: 1, pageSize: 20 }, detail: null, size: null, sizeError: null });
			loadDetail(item.id, 1, 20);
			loadSize(item.id);
		}

		function closeEntry() {
			set({ open: null, detail: null, size: null, sizeError: null });
		}

		/** 选中 / 取消选中一个条目（选择模式下点卡片走这里）。 */
		function togglePick(id) {
			const picked = store.picked.includes(id) ? store.picked.filter((item) => item !== id) : store.picked.concat(id);
			set({ picked, pickedBytes: null, pickedSizes: null });
		}

		/** 进出选择模式：退出时清空选中，避免"上次选的还在"这种幽灵状态。 */
		function togglePicking() {
			const picking = !store.picking;
			set({ picking, picked: picking ? store.picked : [], pickedBytes: picking ? store.pickedBytes : null, pickedSizes: picking ? store.pickedSizes : null });
		}

		/* 轮询：有任务在跑时 2.5 秒一拍（看进度），否则 20 秒一拍 */
		let timer = null;
		function startPolling() {
			stopPolling();
			const tick = async () => {
				try {
					const data = await api("/state");
					set({ data, loading: false, error: null });
					if (store.open && !store.detail) await loadDetail(store.open.id, 1, 20);
				} catch (error) {
					set({ error: String((error && error.message) || error) });
				}
				const busy = store.data && store.data.job && store.data.job.running;
				timer = setTimeout(tick, busy ? 2500 : 20000);
			};
			timer = setTimeout(tick, 3000);
		}
		function stopPolling() {
			if (timer) clearTimeout(timer);
			timer = null;
		}

		function post(path, body) {
			return api(path, { method: "POST", body: JSON.stringify(body || {}) });
		}

		/* ── 小工具 ── */

		function fmtNumber(value) {
			const number = Number(value) || 0;
			if (number >= 100000000) return (number / 100000000).toFixed(1) + "亿";
			if (number >= 10000) return (number / 10000).toFixed(1) + "万";
			return String(number);
		}

		function fmtTime(ms) {
			if (!ms) return "—";
			const date = new Date(Number(ms));
			if (Number.isNaN(date.getTime())) return "—";
			const pad = (n) => String(n).padStart(2, "0");
			return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
		}

		function fmtDateTime(ms) {			if (!ms) return "—";
			const date = new Date(Number(ms));
			const pad = (n) => String(n).padStart(2, "0");
			return fmtTime(ms) + " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
		}

		/* ── 副本漂移标签（纯函数，便于断言）──
		   profile 装的是**副本**，工作区里还有一份源码：两者不同步时，改源码根本不会生效。
		   这是本机反复踩的坑（dsh-ofm-ops 丢源码那回），所以要在卡片上直接标出来。 */
		function driftLabel(drift) {
			if (!drift) return "";
			const staged = Boolean(drift.staged);
			if (drift.verdict === "differs") return staged ? "staging 不同步" : "副本不同步";
			if (drift.verdict === "newer-workspace") return staged ? "staging 较新" : "副本较旧";
			if (drift.verdict === "newer-loaded") return staged ? "staging 较旧" : "工作区较旧";
			return "";
		}

		function driftDetail(drift) {
			if (!drift) return "";
			const parts = [];
			if (drift.differs && drift.differs.length > 0) parts.push("关键文件不同：" + drift.differs.join("、"));
			if (drift.staged) {
				if (drift.loadedDir) parts.push("DSH 加载的：" + drift.loadedDir);
				if (drift.workspaceDir) parts.push("staging（上传用）：" + drift.workspaceDir);
				parts.push("发布前先同步这两份 —— staging 是旧的那份时，推上去的就是旧版");
				return parts.join("\n");
			}
			if (drift.loadedDir) parts.push("加载的：" + drift.loadedDir);
			if (drift.workspaceDir) parts.push("工作区：" + drift.workspaceDir);
			if (drift.verdict === "newer-workspace") parts.push("工作区那份更新 —— 改它才会生效（先重新安装或改成 junction）");
			if (drift.verdict === "newer-loaded") parts.push("加载的那份更新 —— 工作区源码可能是旧的，别改错地方");
			return parts.join("\n");
		}

		/** 体积：只给人看，不参与判断（「12.3 MB · 318 个文件」） */		function fmtBytes(bytes) {
			const value = Number(bytes) || 0;
			if (value >= 1024 * 1024 * 1024) return (value / (1024 * 1024 * 1024)).toFixed(1) + " GB";
			if (value >= 1024 * 1024) return (value / (1024 * 1024)).toFixed(1) + " MB";
			if (value >= 1024) return (value / 1024).toFixed(0) + " KB";
			return value + " B";
		}

		function ago(ms) {			if (!ms) return "从未";
			const delta = Date.now() - Number(ms);
			if (delta < 60000) return "刚刚";
			if (delta < 3600000) return Math.floor(delta / 60000) + " 分钟前";
			if (delta < 86400000) return Math.floor(delta / 3600000) + " 小时前";
			return Math.floor(delta / 86400000) + " 天前";
		}

		function fmtMs(ms) {
			const value = Number(ms) || 0;
			if (value >= 60000) return (value / 60000).toFixed(1) + " 分钟";
			if (value >= 1000) return (value / 1000).toFixed(1) + " 秒";
			return value + " ms";
		}

		/* ── 用没用 / 搜得到 / 键盘（都是纯函数，自检里能直接断言） ── */

		/** 从未被调用过。 */
		function isUnused(item) {
			return !(item && item.calls > 0);
		}

		function hasErrors(item) {
			return Boolean(item && item.errors > 0);
		}

		/** 报错率（0~1）：没调用过就没有率可言，返回 0 而不是假装 100%。 */
		function errorRate(item) {
			const calls = Number(item && item.calls) || 0;
			return calls > 0 ? (Number(item.errors) || 0) / calls : 0;
		}

		/**
		 * 「只被子代理调过」：有调用，但每一次都发生在子代理会话里。
		 * 这类条目删掉**不会当场报错** —— 只会在某条委派链下次跑的时候悄悄变差，
		 * 所以清理前必须能单独看见它们。
		 */
		function isSubagentOnly(item) {
			const calls = Number(item && item.calls) || 0;
			return calls > 0 && calls === (Number(item && item.subagentCalls) || 0);
		}

		/**
		 * 搜索命中：把**命中的工具名**挑出来（最多 4 个）。
		 * 这是面板要能回答的第二个问题 —— 「这个工具是谁提供的」。
		 * 少于 2 个字符不搜，免得一个 `a` 把所有条目都点亮。
		 */
		function toolHits(item, query) {
			const needle = String(query || "").trim().toLowerCase();
			if (needle.length < 2) return [];
			const names = (item && item.toolNames) || [];
			return names.filter((name) => String(name).toLowerCase().includes(needle)).slice(0, 4);
		}

		/**
		 * 快捷键判定（纯函数：不碰 DOM，所以自检能直接断言）。
		 * `/` 聚焦搜索、`Esc` 清空搜索；在输入框里按这两个键不抢。
		 */
		function hotkeyOf(event) {
			if (!event || typeof event.key !== "string") return "";
			const target = event && event.target;
			const tag = target && typeof target.tagName === "string" ? target.tagName : "";
			const typing = tag === "INPUT" || tag === "TEXTAREA" || Boolean(target && target.isContentEditable);
			if (event.key === "/" && !typing) return "focus-search";
			if (event.key === "Escape" && !typing) return "clear-search";
			return "";
		}

		/**
		 * 复制到剪贴板：先走 navigator.clipboard，被拒/不可用时退回临时 textarea。
		 * 两条都失败就返回 false —— 调用方要给一句人话，不能静默失败。
		 */
		function copyText(text) {
			const value = String(text == null ? "" : text);
			try {
				if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
					navigator.clipboard.writeText(value).catch(() => {});
					return true;
				}
			} catch (error) {
				/* 落到下面的兜底 */
			}
			try {
				const area = document.createElement("textarea");
				area.value = value;
				area.style.position = "fixed";
				area.style.opacity = "0";
				document.body.appendChild(area);
				area.select();
				const copied = document.execCommand("copy");
				document.body.removeChild(area);
				return Boolean(copied);
			} catch (error) {
				return false;
			}
		}

		function tagLabel(all, id) {
			const found = (all || []).find((tag) => tag.id === id);
			return found ? found.label : id;
		}

		/**
		 * apply(ctx) 拿到的上下文要在组件里也能用（侧栏图标点击时调 layout.selectPanel）。
		 * ⚠️ 不能直接在组件里写 `ctx.xxx`：`ctx` 只是 apply 的形参，不在工厂作用域里 ——
		 *    那样写会在点击时抛 ReferenceError（还被 try/catch 吞掉，表现为"点了没反应"）。
		 */
		let clientCtx = null;

		function CatalogIcon(props) {
			const size = (props && props.size) || 18;
			return h(
				"svg",
				{ width: size, height: size, viewBox: "0 0 24 24", "aria-hidden": true, style: { display: "block", pointerEvents: "none" } },
				h("rect", { x: 3, y: 4.5, width: 7.5, height: 6, rx: 1.6, fill: "none", stroke: "currentColor", strokeWidth: 1.5, opacity: 0.75 }),
				h("rect", { x: 13.5, y: 4.5, width: 7.5, height: 6, rx: 1.6, fill: "none", stroke: "currentColor", strokeWidth: 1.5, opacity: 0.55 }),
				h("rect", { x: 3, y: 13.5, width: 7.5, height: 6, rx: 1.6, fill: "none", stroke: "currentColor", strokeWidth: 1.5, opacity: 0.55 }),
				h("rect", { x: 13.5, y: 13.5, width: 7.5, height: 6, rx: 1.6, fill: "none", stroke: "currentColor", strokeWidth: 1.5, opacity: 0.75 }),
			);
		}

		function SidebarEntry(props) {
			const state = useStore();
			const totals = state.data && state.data.totals;
			const pending = totals ? totals.askUser : 0;
			const size = (props && props.size) || 18;
			return h(
				"span",
				{
					className: "dpc-entry" + (props && props.active ? " is-active" : ""),
					title: pending > 0 ? PANEL_LABEL + " · " + pending + " 个来源待确认" : PANEL_LABEL,
					onClick: () => {
						try {
							if (clientCtx && clientCtx.layout && typeof clientCtx.layout.selectPanel === "function") clientCtx.layout.selectPanel(PANEL_ID);
						} catch (error) {
							/* 外壳自己也会处理点击，这里只是兜底 */
						}
					},
				},
				h(CatalogIcon, { size }),
				pending > 0 ? h("i", { className: "dpc-dot", "aria-label": pending + " 个待确认" }) : null,
			);
		}

		/* ── 来源徽章 / 标签 ── */

		function SourceBadge(props) {
			const meta = SOURCE_META[props.source] || { label: props.source, cls: "third" };
			return h("span", { className: "dpc-src dpc-src-" + meta.cls, title: (props.why || []).join("；") }, meta.label);
		}

		function TagChips(props) {
			const all = (props.all || []).filter((tag) => tag.dimension !== "origin");
			const ids = props.ids || [];
			return h(
				"span",
				{ className: "dpc-chips" },
				ids.map((id) => h("span", { key: id, className: "dpc-chip" }, tagLabel(props.all, id))),
				props.onRemove
					? ids.map((id) =>
							h("button", { key: "x" + id, className: "dpc-chip-x", title: "移除标签 " + tagLabel(all, id), onClick: (event) => { event.stopPropagation(); props.onRemove(id); } }, "×"),
						)
					: null,
			);
		}

		/* ── 卡片 ── */

		function Card(props) {
			const item = props.item;
			const all = props.tags || [];
			const hits = props.hits || [];
			const picked = Boolean(props.picked);
			const picking = Boolean(props.picking);
			const drift = props.drift || null;
			const zh = item.descriptionZh || "";
			const en = item.descriptionEn || "";
			/* 没有中文简介时直接拿英文当正文：否则每张卡都顶着一行「（还没有中文简介）」再接英文，
			   127 张卡一起看就是一片噪声。提示只留在详情里。 */
			const main = zh || en;
			const sub = zh && en ? en : "";
			return h(
				"button",
				{
					className: "dpc-card" + (item.enabled === false ? " is-off" : "") + (picked ? " is-picked" : "") + (picking ? " is-picking" : ""),
					onClick: () => (picking ? props.onPick(item.id) : openEntry(item)),
					title: picking ? (picked ? "取消选中 " + item.name : "选中 " + item.name) : "查看 " + item.name + " 的调用明细",
				},
				h(
					"div",
					{ className: "dpc-card-head" },
					picked ? h("span", { className: "dpc-pick-badge", "aria-label": "已选中" }, "✓") : null,
					h(SourceBadge, { source: item.source, why: item.sourceWhy }),
					h("span", { className: "dpc-name" }, item.name),
					item.kind === "skill" ? h("span", { className: "dpc-kind" }, "Skill") : null,
					driftLabel(drift) ? h("span", { className: "dpc-drift", title: driftDetail(drift) }, driftLabel(drift)) : null,
					item.askUser ? h("span", { className: "dpc-warn", title: "来源待你确认一次" }, "待确认") : null,
					hasErrors(item)
						? h("span", { className: "dpc-err", title: "报错 " + (item.errors || 0) + " 次 / 调用 " + (item.calls || 0) + " 次（" + Math.round(errorRate(item) * 100) + "%）" }, "报错 " + fmtNumber(item.errors || 0))
						: null,
					h("span", { className: "dpc-calls" + (isUnused(item) ? " is-zero" : ""), title: isUnused(item) ? "从没被调用过" : "总调用次数" }, fmtNumber(item.calls)),
				),
				main
					? h("div", { className: "dpc-zh" + (zh ? "" : " dpc-zh-plain"), title: main }, main)
					: h("div", { className: "dpc-zh" }, h("span", { className: "dpc-muted" }, item.kind === "skill" ? "（Skill 没有英文简介）" : "（还没有简介）")),
				sub ? h("div", { className: "dpc-en" }, sub) : null,
				hits.length > 0 ? h("div", { className: "dpc-hit", title: "搜索命中的工具名" }, "工具：" + hits.join(" · ")) : null,
				h(
					"div",
					{ className: "dpc-card-foot" },
					h(TagChips, { ids: (item.tags && item.tags.purpose) || [], all }),
					h(
						"span",
						{ className: "dpc-foot-meta" },
						item.subagentCalls > 0 ? "含子代理 " + fmtNumber(item.subagentCalls) + " · " : "",
						item.lastUsed ? "最近 " + ago(item.lastUsed) : "从未调用",
						item.createdAt ? " · 建于 " + fmtTime(item.createdAt) : "",
					),
				),
			);
		}

		/* ── 浮窗：条目详情 ── */

		function ToolTable(props) {
			const tools = props.tools || [];
			if (tools.length === 0) return h("div", { className: "dpc-muted" }, "没有可归属的工具调用（官方/第三方插件的工具可能被判为宿主核心，见列表里的「宿主核心工具」）。");
			/* 宿主核心那一列才有 owner（= 具体哪个官方包/插件包的），有时才显示，别给普通插件加空列 */
			const showOwner = tools.some((tool) => tool.owner);
			return h(
				"table",
				{ className: "dpc-table" },
				h(
					"thead",
					null,
					h(
						"tr",
						null,
						h("th", null, "工具"),
						showOwner ? h("th", null, "归属") : null,
						h("th", null, "调用"),
						h("th", null, "报错"),
						h("th", null, "平均耗时"),
						h("th", null, "会话"),
						h("th", null, "最近"),
					),
				),
				h(
					"tbody",
					null,
					tools.slice(0, 40).map((tool) =>
						h(
							"tr",
							{ key: tool.name },
							h("td", { className: "dpc-mono" }, tool.name),
							showOwner ? h("td", { className: "dpc-mono dpc-muted", title: tool.how ? "归属依据：" + tool.how : "" }, tool.owner || "—") : null,
							h("td", null, fmtNumber(tool.calls)),
							h("td", { className: tool.errors > 0 ? "dpc-bad" : "" }, String(tool.errors || 0)),
							h("td", null, fmtMs(tool.avgMs)),
							h("td", null, String(tool.sessions || 0)),
							h("td", { title: fmtDateTime(tool.lastUsed) }, ago(tool.lastUsed)),
						),
					),
				),
			);
		}

		function SessionList(props) {
			const sessions = props.sessions || { items: [], page: 1, pages: 1, total: 0, pageSize: 20, pageSizes: [10, 20, 50, 100] };
			const open = props.open;
			if (props.limited) {
				return h("div", { className: "dpc-note" }, "Skill 只能统计「被加载的次数 + 最近一次时间」—— 机制限制，无法细分到会话。这里不假装精确。");
			}
			return h(
				"div",
				null,
				h(
					"div",
					{ className: "dpc-sessions-head" },
					h("span", null, "涉及会话 " + sessions.total + " 个"),
					h(
						"label",
						{ className: "dpc-inline" },
						"每页 ",
						h(
							"select",
							{
								value: String(open.pageSize || sessions.pageSize || 20),
								onChange: (event) => {
									const size = Number(event.target.value) || 20;
									set({ open: { ...open, page: 1, pageSize: size } });
									loadDetail(open.id, 1, size);
								},
							},
							(sessions.pageSizes || [10, 20, 50, 100]).map((size) => h("option", { key: size, value: String(size) }, String(size))),
						),
						" 条",
					),
				),
				h(
					"div",
					{ className: "dpc-sessions" },
					(sessions.items || []).map((session) =>
						h(
							"div",
							{ key: session.id, className: "dpc-session" + (session.isSubagent ? " is-sub" : "") },
							h("span", { className: "dpc-session-calls" }, fmtNumber(session.calls)),
							h("span", { className: "dpc-session-title", title: session.id }, session.title || (session.id || "").slice(0, 8)),
							session.isSubagent ? h("span", { className: "dpc-sub-badge", title: "子代理会话" }, "子代理") : null,
							session.parentTitle ? h("span", { className: "dpc-muted" }, "父：" + session.parentTitle) : null,
							h("span", { className: "dpc-muted dpc-session-time" }, ago(session.lastAt)),
						),
					),
					(sessions.items || []).length === 0 ? h("div", { className: "dpc-muted" }, "还没有会话记录（或统计缓存还没算完）") : null,
				),
				h(
					"div",
					{ className: "dpc-pager" },
					h(
						"button",
						{
							className: "dpc-btn dpc-btn-sm",
							disabled: sessions.page <= 1,
							onClick: () => {
								const page = Math.max(1, sessions.page - 1);
								set({ open: { ...open, page } });
								loadDetail(open.id, page, open.pageSize || 20);
							},
						},
						"上一页",
					),
					h("span", { className: "dpc-muted" }, "第 " + sessions.page + " / " + sessions.pages + " 页"),
					h(
						"button",
						{
							className: "dpc-btn dpc-btn-sm",
							disabled: sessions.page >= sessions.pages,
							onClick: () => {
								const page = Math.min(sessions.pages, sessions.page + 1);
								set({ open: { ...open, page } });
								loadDetail(open.id, page, open.pageSize || 20);
							},
						},
						"下一页",
					),
				),
			);
		}

		function TagEditor(props) {
			const item = props.item;
			const all = props.all || [];
			const purpose = all.filter((tag) => tag.dimension === "purpose");
			const context = all.filter((tag) => tag.dimension === "context");
			const current = item.tags || { purpose: [], context: [] };
			const [adding, setAdding] = useState(false);
			const [label, setLabel] = useState("");
			const [gloss, setGloss] = useState("");
			const [dimension, setDimension] = useState("purpose");
			const [error, setError] = useState("");

			async function toggle(tagId, dim) {
				const list = new Set(current[dim] || []);
				if (list.has(tagId)) list.delete(tagId);
				else list.add(tagId);
				const payload = { id: item.id, purpose: dim === "purpose" ? [...list] : current.purpose, context: dim === "context" ? [...list] : current.context, by: "user" };
				await post("/tags", { action: "set", ...payload });
				await refresh();
			}

			async function add() {
				setError("");
				const result = await post("/tags", { action: "add", label, gloss, dimension });
				if (!result.ok) {
					setError(result.error || "新增失败");
					return;
				}
				setLabel("");
				setGloss("");
				setAdding(false);
				await refresh();
			}

			function renderGroup(title, dimensionName, tags) {
				return h(
					"div",
					{ className: "dpc-tag-group" },
					h("div", { className: "dpc-tag-group-title" }, title),
					h(
						"div",
						{ className: "dpc-tag-list" },
						tags.map((tag) =>
							h(
								"button",
								{
									key: tag.id,
									className: "dpc-tag" + ((current[dimensionName] || []).includes(tag.id) ? " is-on" : ""),
									title: tag.gloss || "",
									onClick: () => toggle(tag.id, dimensionName),
								},
								tag.label,
								tag.builtin ? null : h("span", { className: "dpc-tag-custom" }, "自定"),
							),
						),
					),
				);
			}

			return h(
				"div",
				{ className: "dpc-block" },
				h("div", { className: "dpc-block-title" }, "标签"),
				renderGroup("做什么", "purpose", purpose),
				renderGroup("用在哪里", "context", context),
				h(
					"div",
					{ className: "dpc-tag-add" },
					adding
						? h(
								"div",
								{ className: "dpc-add-form" },
								h("div", { className: "dpc-muted" }, "新增自定义标签（解释是必填项 —— AI 分类要靠它判断，否则只能猜）"),
								h("input", { placeholder: "标签名，例如 视频剪辑", value: label, onChange: (event) => setLabel(event.target.value) }),
								h("input", { placeholder: "一句解释：处理视频素材：切片、转码、字幕", value: gloss, onChange: (event) => setGloss(event.target.value) }),
								h(
									"select",
									{ value: dimension, onChange: (event) => setDimension(event.target.value) },
									h("option", { value: "purpose" }, "做什么"),
									h("option", { value: "context" }, "用在哪里"),
								),
								error ? h("div", { className: "dpc-bad" }, error) : null,
								h(
									"div",
									{ className: "dpc-row" },
									h("button", { className: "dpc-btn dpc-btn-sm", onClick: add }, "保存"),
									h("button", { className: "dpc-btn dpc-btn-sm dpc-btn-ghost", onClick: () => { setAdding(false); setError(""); } }, "取消"),
								),
							)
						: h("button", { className: "dpc-btn dpc-btn-sm dpc-btn-ghost", onClick: () => setAdding(true) }, "＋ 新增自定义标签"),
				),
			);
		}

		function EntryModal(props) {
			const state = useStore();
			const detail = state.detail;
			const open = state.open;
			const item = detail && detail.ok ? detail.item : null;
			const all = (state.data && state.data.tags && state.data.tags.all) || [];
			/* 复制源目录后按钮变「已复制」—— 面板里的操作反馈只能出现在面板里 */
			const [copiedPath, setCopiedPath] = useState(false);

			useEffect(() => {
				function onKey(event) {
					if (event.key === "Escape") closeEntry();
				}
				document.addEventListener("keydown", onKey);
				return () => document.removeEventListener("keydown", onKey);
			}, []);

			async function markSource(source) {
				await post("/source", { id: open.id, source, note: "面板手工标记" });
				await refresh();
				await loadDetail(open.id, open.page || 1, open.pageSize || 20);
			}

			async function runGap() {
				set({ reportBusy: true, report: null });
				await post("/review", { target: "gap", name: item.name });
				setTimeout(async () => {
					await refresh();
					set({ reportBusy: false });
				}, 1500);
			}

			const publishable = item && (item.source === "self" || item.source === "hybrid");

			return h(
				"div",
				{ className: "dpc-overlay", onClick: closeEntry, role: "dialog", "aria-label": item ? item.name : "插件详情" },
				h(
					"div",
					{ className: "dpc-modal", onClick: (event) => event.stopPropagation() },
					h(
						"div",
						{ className: "dpc-modal-head" },
						h(SourceBadge, { source: item ? item.source : "third", why: item ? item.sourceWhy : [] }),
						h("span", { className: "dpc-modal-title" }, item ? item.name : open.id),
						item && item.version ? h("span", { className: "dpc-muted" }, "v" + item.version) : null,
						h("span", { className: "dpc-grow" }),
						h("button", { className: "dpc-btn dpc-btn-sm dpc-btn-ghost", onClick: closeEntry }, "关闭"),
					),
					state.detailLoading && !item
						? h("div", { className: "dpc-muted dpc-pad" }, "读取中…")
						: !item
							? h("div", { className: "dpc-bad dpc-pad" }, (detail && detail.error) || "读不到详情")
							: h(
									"div",
									{ className: "dpc-modal-body" },
									/* 概览 */
									h(
										"div",
										{ className: "dpc-stats" },
										statCell("总调用", fmtNumber(item.calls)),
										statCell("报错", String(item.errors || 0)),
										statCell("涉及会话", String((detail.sessions && detail.sessions.total) || 0)),
										statCell("其中子代理", fmtNumber(item.subagentCalls || 0)),
										statCell("最近使用", ago(item.lastUsed)),
										statCell(item.kind === "skill" ? "创建" : "启用", item.kind === "skill" ? fmtTime(item.createdAt) : item.enabled === false ? "否" : "是"),
									),
									item.subagentCalls > 0
										? h("div", { className: "dpc-note" }, "总调用里包含子代理会话的 " + fmtNumber(item.subagentCalls) + " 次（父会话直呼 " + fmtNumber((item.calls || 0) - (item.subagentCalls || 0)) + " 次）—— 交接链里子代理占比很高时，看这个数才知道真实分布。")
										: null,
									/* 简介 */
									h(
										"div",
										{ className: "dpc-block" },
										h("div", { className: "dpc-block-title" }, "简介"),
										h("div", null, item.descriptionZh || h("span", { className: "dpc-muted" }, "（还没有中文简介）")),
										item.descriptionEn ? h("div", { className: "dpc-en dpc-en-block" }, item.descriptionEn) : null,
										item.whenToUse ? h("div", { className: "dpc-muted" }, "何时该用：" + item.whenToUse) : null,
									),
									/* 位置：装上了却不工作的时候，第一件事是看它到底在哪、是不是 junction */
									item.kind === "plugin"
										? h(
												"div",
												{ className: "dpc-block" },
												h("div", { className: "dpc-block-title" }, "位置与安装形态"),
												h(
													"div",
													{ className: "dpc-row" },
													h("span", { className: "dpc-muted" }, item.realDir ? "源目录" : "没有源目录（在官方 asar 里，或宿主半边还没重载）"),
													item.realDir ? h("code", { className: "dpc-path" }, item.realDir) : null,
													item.realDir
														? h(
																"button",
																{
																	className: "dpc-btn dpc-btn-sm dpc-btn-ghost" + (copiedPath ? " is-on" : ""),
																	onClick: () => {
																		const copied = copyText(item.realDir);
																		setCopiedPath(copied);
																		if (!copied) set({ notice: "复制失败：渲染进程不让写剪贴板，请手动选中目录复制" });
																	},
																},
																copiedPath ? "已复制" : "复制",
															)
														: null,
												),
												h(
													"div",
													{ className: "dpc-muted" },
													item.inAsar
														? "安装形态：在官方 asar 包内 —— 不能直接改，随 DSH 升级走"
														: item.isLink
															? "安装形态：junction / symlink —— 源目录就在工作区，改源码立即生效"
															: "安装形态：实体目录（profile 里的副本）—— 改工作区那份不会被加载",
												),
												/* dependency 是布尔：这个包有没有被写进 profile 的 package.json dependencies。
												   传递依赖/自动装的包在下次整理依赖树时可能消失 —— 这正是「上次还好的、这次没了」的常见来源。 */
												item.dependency
													? h("div", { className: "dpc-muted" }, "写在 profile 的 package.json dependencies 里 —— 不会被依赖树整理顺手清掉")
													: h("div", { className: "dpc-muted" }, "不在 profile 的 dependencies 里（传递依赖 / 自动装的）—— 整理依赖树时可能消失"),
												/* 体积：懒算（浮窗打开后才问一次 /size），删之前先看看它能省多少 */
												h(
													"div",
													{ className: "dpc-row" },
													h("span", { className: "dpc-muted" }, "体积"),
													state.size
														? h("span", null, fmtBytes(state.size.bytes) + " · " + fmtNumber(state.size.files) + " 个文件" + (state.size.truncated ? "（超过 1.5 秒/2 万文件，只算到这里）" : ""))
														: state.sizeError
															? h("span", { className: "dpc-muted" }, state.sizeError)
															: h("span", { className: "dpc-muted" }, "正在量…"),
												),
											)
										: null,
									/* 来源与证据 */
									h(
										"div",
										{ className: "dpc-block" },
										h("div", { className: "dpc-block-title" }, "来源判定（依据）"),
										h(
											"ul",
											{ className: "dpc-why" },
											(item.sourceWhy || []).map((why, index) => h("li", { key: index }, why)),
										),
										h(
											"div",
											{ className: "dpc-row" },
											h("span", { className: "dpc-muted" }, "判错了就标一次（存下来不再问）："),
											["self", "third", "hybrid", "official"].map((source) =>
												h(
													"button",
													{ key: source, className: "dpc-btn dpc-btn-sm dpc-btn-ghost" + (item.source === source ? " is-on" : ""), onClick: () => markSource(source) },
													SOURCE_META[source].label,
												),
											),
										),
									),
									/* 工具明细 */
									h(
										"div",
										{ className: "dpc-block" },
										h("div", { className: "dpc-block-title" }, "每个工具的调用（粒度到工具）"),
										h(ToolTable, { tools: detail.tools }),
									),
									/* 会话 */
									h(
										"div",
										{ className: "dpc-block" },
										h("div", { className: "dpc-block-title" }, "涉及哪些会话"),
										h(SessionList, { sessions: detail.sessions, open, limited: detail.statsLimited || item.kind === "skill" }),
									),
									/* 标签 */
									h(TagEditor, { item, all }),
									/* 副本同步：一份是加载的、另一份是源码 / staging —— 不同步意味着你改的那份不会被用 */
									(() => {
										const drift = (state.data && state.data.drift && state.data.drift[item.id]) || null;
										if (!drift) return null;
										const label = driftLabel(drift);
										const prefix = drift.staged ? "staging 同步" : "源码同步";
										const body =
											drift.verdict === "linked"
												? prefix + "：junction 指向工作区 —— 只有一份，改源码立即生效"
												: drift.verdict === "no-copy"
													? prefix + "：工作区里没有同名源码目录（只能改 profile 里这份）"
													: label
														? prefix + "：" + label + " —— " + driftDetail(drift).replace(/\n/g, "；")
														: prefix + "：两份一致";
										return h("div", { className: "dpc-block" }, h("div", { className: "dpc-block-title" }, "副本同步"), h("div", { className: "dpc-muted" }, body));
									})(),
									/* 仓库与操作 */
									h(
										"div",
										{ className: "dpc-block" },
										h("div", { className: "dpc-block-title" }, "仓库与操作"),
										h(
											"div",
											{ className: "dpc-row" },
											item.repoUrl ? h("a", { className: "dpc-link", href: item.repoUrl, target: "_blank", rel: "noreferrer" }, item.repoUrl) : h("span", { className: "dpc-muted" }, "还没有远端仓"),
										),
										h("div", { className: "dpc-muted" }, "创建/下载时间：" + fmtDateTime(item.createdAt)),
										publishable
											? h(
													"div",
													{ className: "dpc-row" },
													h("button", { className: "dpc-btn dpc-btn-sm", onClick: () => { set({ open: null }); startPlan(); } }, "上传 / 更新到 GitHub"),
													h("button", { className: "dpc-btn dpc-btn-sm dpc-btn-ghost", onClick: runGap, disabled: state.reportBusy }, state.reportBusy ? "分析中…" : "缺口分析"),
												)
											: h("div", { className: "dpc-muted" }, "只有「自写」与「混血」可以上传。"),
									),
								),
				),
			);
		}

		function statCell(label, value) {
			return h("div", { className: "dpc-stat", key: label }, h("div", { className: "dpc-stat-value" }, value), h("div", { className: "dpc-stat-label" }, label));
		}

		/* ── 上传计划浮窗 ── */

		function PlanModal(props) {
			const state = useStore();
			const plan = state.plan;
			/* 「我确认这些命中是测试夹具，本次允许推」—— 只对本次 apply 生效，不记忆 */
			const [acks, setAcks] = useState([]);
			if (!plan) return null;
			const summary = plan.summary || {};
			const blocking = (plan.items || []).filter((item) => item.action === "blocked-secrets");

			function toggleAck(repo) {
				setAcks((current) => (current.includes(repo) ? current.filter((item) => item !== repo) : [...current, repo]));
			}

			async function apply() {
				set({ uploadBusy: true, uploadResult: null });
				const result = await post("/upload", { action: "apply", planId: plan.planId, confirm: true, translate: true, ackRepos: acks });
				set({ uploadBusy: false, uploadResult: result });
				await refresh();
			}

			return h(
				"div",
				{ className: "dpc-overlay", onClick: () => set({ plan: null, uploadResult: null }), role: "dialog", "aria-label": "上传计划" },
				h(
					"div",
					{ className: "dpc-modal dpc-modal-wide", onClick: (event) => event.stopPropagation() },
					h(
						"div",
						{ className: "dpc-modal-head" },
						h("span", { className: "dpc-modal-title" }, "上传计划（默认全私有）"),
						h("span", { className: "dpc-grow" }),
						h("button", { className: "dpc-btn dpc-btn-sm dpc-btn-ghost", onClick: () => set({ plan: null, uploadResult: null }) }, "关闭"),
					),
					h(
						"div",
						{ className: "dpc-modal-body" },
						h(
							"div",
							{ className: "dpc-stats" },
							statCell("新建", String(summary.create || 0)),
							statCell("更新", String(summary.update || 0)),
							statCell("已同步", String(summary.upToDate || 0)),
							statCell("因密钥跳过", String(summary.blocked || 0)),
							statCell("待生成英文 README", String(summary.readmeNeedingEnglish || 0)),
							statCell("gh 用户", plan.login || "未登录"),
						),
						blocking.length > 0
							? h("div", { className: "dpc-note dpc-note-warn" }, "有 " + blocking.length + " 个仓扫到疑似密钥：它们会被跳过，其余照常推。清单在下面，处理完再跑一次即可。")
							: null,
						h(
							"div",
							{ className: "dpc-plan-list" },
							(plan.items || []).map((item) =>
								h(
									"div",
									{ key: item.id, className: "dpc-plan-item" },
									h("div", { className: "dpc-plan-head" },
										h("span", { className: "dpc-action dpc-action-" + item.action }, item.action === "blocked-secrets" ? "跳过" : item.action === "create" ? "新建" : item.action === "up-to-date" ? "已同步" : item.action === "error" ? "错误" : "更新"),
										h("span", { className: "dpc-mono" }, item.repo),
										h("span", { className: "dpc-muted" }, item.kind === "skills" ? "Skill 集合仓" : SOURCE_META[item.source] ? SOURCE_META[item.source].label : item.source),
									),
									(item.reasons || []).length ? h("div", { className: "dpc-muted" }, item.reasons.join("；")) : null,
									item.action === "blocked-secrets"
										? h(
												"label",
												{ className: "dpc-inline dpc-ack" },
												h("input", { type: "checkbox", checked: acks.includes(item.repo), onChange: () => toggleAck(item.repo) }),
												"我确认这些命中是测试夹具/示例，本次允许推送该仓（只对本次生效，不记忆）",
											)
										: null,
									item.scan && item.scan.hits && item.scan.hits.length
										? h(
												"div",
												{ className: "dpc-hits" },
												item.scan.hits.slice(0, 12).map((hit, index) =>
													h(
														"div",
														{ key: index, className: "dpc-hit" },
														h("span", { className: "dpc-sev dpc-sev-" + hit.severity }, hit.severity),
														h("span", { className: "dpc-mono" }, hit.file + (hit.line ? ":" + hit.line : "")),
														h("span", null, hit.rule),
														h("span", { className: "dpc-mono dpc-muted" }, hit.sample || ""),
														h("span", { className: "dpc-muted" }, hit.plain || ""),
													),
												),
											)
										: null,
								),
							),
						),
						state.uploadResult
							? h(
									"div",
									{ className: "dpc-block" },
									h("div", { className: "dpc-block-title" }, "执行结果"),
									h("pre", { className: "dpc-pre" }, JSON.stringify(state.uploadResult.result || state.uploadResult, null, 1)),
								)
							: null,
						h(
							"div",
							{ className: "dpc-row dpc-row-end" },
							h("button", { className: "dpc-btn dpc-btn-ghost", onClick: () => set({ plan: null, uploadResult: null }) }, "取消"),
							h("button", { className: "dpc-btn", onClick: apply, disabled: state.uploadBusy }, state.uploadBusy ? "推送中…" : "确认推送（" + ((plan.items || []).length - blocking.length) + " 个仓）"),
						),
						h("div", { className: "dpc-muted dpc-pad" }, "不 force push；密钥命中的仓不动；公开是另一次独立操作。"),
					),
				),
			);
		}

		/* ── 面板 ── */

		function Panel() {
			const state = useStore();
			const data = state.data;
			const items = (data && data.entries) || [];
			const all = (data && data.tags && data.tags.all) || [];
			const hostCore = data && data.hostCore;

			const filtered = useMemo(() => {
				const query = state.query.trim().toLowerCase();
				let list = items.filter((item) => {
					if (state.kind !== "all" && item.kind !== state.kind) return false;
					if (state.source !== "any" && item.source !== state.source) return false;
					/* 「用没用」五视角：未使用 / 有调用 / 有报错 / 仅子代理 */
					if (state.usage === "unused" && !isUnused(item)) return false;
					if (state.usage === "used" && isUnused(item)) return false;
					if (state.usage === "errors" && !hasErrors(item)) return false;
					if (state.usage === "subonly" && !isSubagentOnly(item)) return false;
					if (query !== "") {
						/* ★ 工具名也要进搜索域 —— 否则「pwsh 是谁给的」只能一个个点开看 */
						const haystack = [item.name, item.title, item.descriptionZh, item.descriptionEn, (item.sourceWhy || []).join(" "), (item.toolNames || []).join(" ")].join(" ").toLowerCase();
						if (!haystack.includes(query)) return false;
					}
					return true;
				});
				list = list.slice().sort((a, b) => {
					if (state.sort === "calls") return (b.calls || 0) - (a.calls || 0);
					/* 报错优先按次数排；同次数再看调用量，否则 1 次/1 次的一堆条目顺序随机 */
					if (state.sort === "errors") return (b.errors || 0) - (a.errors || 0) || (b.calls || 0) - (a.calls || 0);
					/* 报错率：6/6 排在 23/252 前面 —— 次数排序看不出后者其实很健康 */
					if (state.sort === "rate") return errorRate(b) - errorRate(a) || (b.errors || 0) - (a.errors || 0);
					if (state.sort === "recent") return (b.lastUsed || 0) - (a.lastUsed || 0);
					if (state.sort === "time") return (b.createdAt || 0) - (a.createdAt || 0);
					return String(a.name).localeCompare(String(b.name));
				});
				return list;
			}, [items, state.query, state.kind, state.source, state.usage, state.sort]);

			/* 洞察条的数字：**只受 kind/source 影响**，不被关键词与用法筛选带着跳 ——
			   否则「点开未使用后 未使用 变成 0」会让人以为数据没了。 */
			const insightCounts = useMemo(() => {
				const pool = items.filter((item) => (state.kind === "all" || item.kind === state.kind) && (state.source === "any" || item.source === state.source));
				return {
					any: pool.length,
					used: pool.filter((item) => !isUnused(item)).length,
					unused: pool.filter((item) => isUnused(item)).length,
					errors: pool.filter((item) => hasErrors(item)).length,
					subonly: pool.filter((item) => isSubagentOnly(item)).length,
				};
			}, [items, state.kind, state.source]);

			/* 缓存太旧就自动补一次增量刷新。
			   ★ 三条闸门缺一不可：本挂载只刷一次（否则 20 秒轮询会变成循环刷新）、
			     没有任务在跑（否则和后台任务抢）、确实超过 AUTO_REFRESH_MS。 */
			const autoRefreshed = useRef(false);
			const builtAt = data && data.stats && data.stats.meta ? Number(data.stats.meta.builtAt) || 0 : 0;
			useEffect(() => {
				if (autoRefreshed.current || !builtAt) return;
				if (data.job && data.job.running) return;
				if (Date.now() - builtAt < AUTO_REFRESH_MS) return;
				autoRefreshed.current = true;
				post("/refresh", { what: "stats" })
					.then(() => setTimeout(() => refresh(), 1200))
					.catch(() => {});
			}, [builtAt]);

			/* 快捷键：`/` 聚焦搜索、`Esc` 清空 —— 127 条里找一条，手不用离开键盘 */
			useEffect(() => {
				const onKey = (event) => {
					const action = hotkeyOf(event);
					if (action === "focus-search") {
						event.preventDefault();
						const input = document.getElementById("dpc-search");
						if (input && typeof input.focus === "function") input.focus();
					} else if (action === "clear-search" && store.query !== "") {
						set({ query: "", page: 1 });
					}
				};
				if (typeof window.addEventListener !== "function") return undefined;
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, []);

			/* 选中项的体积：一次问一批（服务端并发 4），250ms 防抖避免连点卡片打出一串请求 */
			const pickedKey = state.picked.join(",");
			useEffect(() => {
				if (state.picked.length === 0) return undefined;
				let alive = true;
				const timer = setTimeout(async () => {
					try {
						const result = await post("/sizes", { ids: store.picked });
						if (alive && result && result.ok) set({ pickedBytes: result.totalBytes, pickedSizes: result.sizes, pickedBusy: false });
					} catch (error) {
						if (alive) set({ pickedBusy: false });
					}
				}, 250);
				return () => {
					alive = false;
					clearTimeout(timer);
				};
			}, [pickedKey]);

			/* 重载（改客户端代码后必然发生一次）或刷新之后，把滚动位置放回原处。
			   ★ 只在**第一次拿到数据**时恢复一次：之后每次轮询重渲染都别把人拽回去。 */
			const restoredScroll = useRef(false);
			useEffect(() => {
				if (restoredScroll.current || !data) return;
				restoredScroll.current = true;
				const top = Number(store.scrollTop) || 0;
				if (!top) return;
				const panel = typeof document !== "undefined" && typeof document.getElementById === "function" ? document.getElementById("dpc-panel") : null;
				if (panel) panel.scrollTop = top;
			}, [Boolean(data)]);

			/* 分页：过滤/排序一改就回第 1 页；pageSize 为 0 表示「全部」 */
			const rawSize = Number(state.pageSize);
			const pageSize = Number.isFinite(rawSize) && rawSize >= 0 ? Math.floor(rawSize) : 24;
			const totalPages = pageSize === 0 ? 1 : Math.max(1, Math.ceil(filtered.length / pageSize));
			const page = Math.min(Math.max(1, state.page || 1), totalPages);
			const pageItems = pageSize === 0 ? filtered : filtered.slice((page - 1) * pageSize, page * pageSize);
			const gotoPage = (next) => set({ page: Math.min(Math.max(1, next), totalPages) });

			async function startPlan() {
				set({ uploadBusy: true });
				const result = await post("/upload", { action: "plan" });
				set({ uploadBusy: false, plan: result.ok ? result.plan : null, notice: result.ok ? null : result.error });
			}

			async function refreshStats() {
				await post("/refresh", { what: "stats" });
				await refresh();
			}

			async function refreshCatalog() {
				await post("/refresh", { what: "catalog" });
				await refresh();
			}

			async function runClassify() {
				await post("/classify", {});
				await refresh();
			}

			async function runIntros() {
				await post("/intro", { action: "generate" });
				await refresh();
			}

			async function runWeekly(target) {
				set({ reportBusy: true });
				await post("/review", { target });
				setTimeout(async () => {
					await refresh();
					set({ reportBusy: false });
				}, 1500);
			}

			/* 导出**当前这一屏**（顺序就是屏幕顺序，并带筛选条件说明）——
			   「我刚筛出来的这批要发给谁」不用再解释一遍筛了什么。 */
			async function runExport(ids) {
				set({ exportBusy: true });
				try {
					const result = await post("/export", { ids, filters: { query: state.query, source: state.source, kind: state.kind, usage: state.usage, sort: state.sort } });
					if (result && result.ok) set({ exportBusy: false, exportPath: result.path, exportCount: result.count, notice: null });
					else set({ exportBusy: false, notice: "导出失败：" + String((result && result.error) || "未知错误") });
				} catch (error) {
					set({ exportBusy: false, notice: "导出失败：" + String((error && error.message) || error) });
				}
			}
			function exportFiltered() {
				return runExport(filtered.map((item) => item.id));
			}
			function exportPicked() {
				return runExport(store.picked.slice());
			}

			if (state.loading && !data) {
				return h("div", { className: "dpc-panel" }, h("div", { className: "dpc-muted dpc-pad" }, "读取插件目录…"));
			}
			if (state.error && !data) {
				return h(
					"div",
					{ className: "dpc-panel" },
					h("div", { className: "dpc-bad dpc-pad" }, "读不到目录：" + state.error),
					h("div", { className: "dpc-pad" }, h("button", { className: "dpc-btn", onClick: refresh }, "重试")),
				);
			}

			const stats = data.stats || {};
			const meta = stats.meta || {};
			const job = data.job || { running: false };
			const totals = data.totals || {};
			const weeklyDue = data.weeklyDue || {};
			/* 副本漂移：哪些插件的工作区源码与加载的副本不同步 */
			const driftMap = (data && data.drift) || {};
			const driftBad = Object.keys(driftMap).filter((id) => driftLabel(driftMap[id]) !== "");

			return h(
				"div",
				{ className: "dpc-panel", id: "dpc-panel", onScroll: rememberScroll },
				/* 头部 */
				h(
					"div",
					{ className: "dpc-header" },
					h(
						"div",
						null,
						h("div", { className: "dpc-title" }, PANEL_LABEL),
						h(
							"div",
							{ className: "dpc-sub" },
							"插件 " + (totals.plugins || 0) + " · Skill " + (totals.skills || 0) + " · 官方 " + ((totals.bySource && totals.bySource.official) || 0) + " / 自写 " + ((totals.bySource && totals.bySource.self) || 0) + " / 第三方 " + ((totals.bySource && totals.bySource.third) || 0) + " / 混血 " + ((totals.bySource && totals.bySource.hybrid) || 0),
							stats.ready
								? h("span", null, "｜最近 " + (meta.windowDays || 90) + " 天 " + fmtNumber(meta.calls || 0) + " 次调用（" + (meta.sessions || 0) + " 会话）｜缓存 " + ago(meta.builtAt))
								: h("span", { className: "dpc-bad" }, "｜统计缓存还没生成（首次约 40~60 秒，已在后台算）"),
							h("span", { className: "dpc-muted" }, "｜build " + (data.build ? data.build.label : "?")),
						),
					),
					h(
						"div",
						{ className: "dpc-header-actions" },
						h("button", { className: "dpc-btn dpc-btn-sm", onClick: startPlan, disabled: state.uploadBusy }, state.uploadBusy ? "出计划…" : "上传备份到 GitHub"),
						h("button", { className: "dpc-btn dpc-btn-sm dpc-btn-ghost", onClick: refreshStats, disabled: job.running }, "刷新统计"),
						h("button", { className: "dpc-btn dpc-btn-sm dpc-btn-ghost", onClick: refreshCatalog, disabled: job.running }, "重新扫描"),
						h("button", { className: "dpc-btn dpc-btn-sm dpc-btn-ghost", onClick: runIntros }, "生成中文简介"),
						h("button", { className: "dpc-btn dpc-btn-sm dpc-btn-ghost", onClick: runClassify }, "AI 分类标签"),
						h("button", { className: "dpc-btn dpc-btn-sm dpc-btn-ghost" + (weeklyDue.gap ? " is-due" : ""), onClick: () => runWeekly("gap"), disabled: state.reportBusy }, weeklyDue.gap ? "缺口分析（已到期）" : "缺口分析"),
						h("button", { className: "dpc-btn dpc-btn-sm dpc-btn-ghost" + (weeklyDue.security ? " is-due" : ""), onClick: () => runWeekly("security"), disabled: state.reportBusy }, weeklyDue.security ? "安全审核（已到期）" : "安全审核"),
					),
				),
				/* 任务条 */
				job.running
					? h(
							"div",
							{ className: "dpc-jobbanner" },
							"后台任务：" + job.kind + " · " + (job.progress.done || 0) + "/" + (job.progress.total || 0) + (job.progress.paused ? "（已暂停）" : "") + "　界面可以继续用，算完自动刷新",
						)
					: null,
				/* 提示 */
				state.notice ? h("div", { className: "dpc-note dpc-note-warn" }, state.notice) : null,
				state.exportPath
					? h(							"div",
							{ className: "dpc-note" },
							"已导出 " + state.exportCount + " 条 → ",
							h("code", { className: "dpc-path" }, state.exportPath),
							" ",
							h("button", { className: "dpc-btn dpc-btn-sm dpc-btn-ghost", onClick: () => set({ notice: copyText(state.exportPath) ? null : "复制失败：渲染进程不让写剪贴板" }) }, "复制路径"),
						)
					: null,
				/* 副本漂移公告：改源码不生效的第一现场 */
				driftBad.length > 0
					? h(
							"div",
							{ className: "dpc-note dpc-note-warn" },
							"有 " +
								driftBad.length +
								" 个条目的两份副本不同步：" +
								driftBad
									.slice(0, 5)
									.map((id) => (items.find((entry) => entry.id === id) || {}).name || id)
									.join("、") +
								(driftBad.length > 5 ? " 等" : "") +
								" —— 插件看卡片上的「副本不同步」，Skill 看「staging 不同步」（发布的是 staging 那份）",
						)
					: null,
				data.weekly && data.weekly.gap && data.reports && data.reports.gap && data.reports.gap.repos > 0
					? h(
							"div",
							{ className: "dpc-note" },
							"上次缺口分析：" + ago(data.reports.gap.ranAt) + "｜high " + data.reports.gap.high + " / medium " + data.reports.gap.medium + " / low " + data.reports.gap.low + "｜最近安全审核：" + ago((data.reports.security || {}).ranAt || 0),
						)
					: null,
				/* 工具条 */
				h(
					"div",
					{ className: "dpc-toolbar" },
					h("input", { id: "dpc-search", className: "dpc-search", placeholder: "搜索名称 / 简介 / 工具名…（/ 聚焦）", value: state.query, onChange: (event) => set({ query: event.target.value, page: 1 }) }),
					h(
						"div",
						{ className: "dpc-seg" },
						[{ id: "any", label: "全部" }, { id: "official", label: "官方" }, { id: "self", label: "自写" }, { id: "third", label: "第三方" }, { id: "hybrid", label: "混血" }, { id: "pending", label: "待标记" }].map((option) =>
							h("button", { key: option.id, className: "dpc-seg-btn" + (state.source === option.id ? " is-on" : ""), onClick: () => set({ source: option.id, page: 1 }) }, option.label),
						),
					),
					h(
						"div",
						{ className: "dpc-seg" },
						[{ id: "all", label: "全部" }, { id: "plugin", label: "插件" }, { id: "skill", label: "Skill" }].map((option) =>
							h("button", { key: option.id, className: "dpc-seg-btn" + (state.kind === option.id ? " is-on" : ""), onClick: () => set({ kind: option.id, page: 1 }) }, option.label),
						),
					),
					h(
						"label",
						{ className: "dpc-inline" },
						"排序 ",
						h(
							"select",
							{ value: state.sort, onChange: (event) => set({ sort: event.target.value, page: 1 }) },
							SORTS.map((option) => h("option", { key: option.id, value: option.id }, option.label)),
						),
					),
					h("span", { className: "dpc-muted" }, filtered.length + " 条"),
					h(
						"div",
						{ className: "dpc-toolbar-actions" },
						h(
							"button",
							{ className: "dpc-btn dpc-btn-sm" + (state.picking ? " is-on" : ""), onClick: togglePicking, title: "多选：点卡片选中，再一次性导出这批（选中项不跨重载保留）" },
							state.picking ? "退出选择" : "选择",
						),
						h(
							"button",
							{ className: "dpc-btn dpc-btn-sm dpc-btn-ghost dpc-export", onClick: exportFiltered, disabled: state.exportBusy || filtered.length === 0, title: "把当前这一屏（含筛选条件）写成 Markdown，存到数据目录 reports/ 下" },
							state.exportBusy ? "导出中…" : "导出这 " + filtered.length + " 条",
						),
					),
				),
				/* 选择模式下的批次条：已选几条、一共多大、一次导出 */
				state.picking
					? h(
							"div",
							{ className: "dpc-pickedbar" },
							h("span", { className: "dpc-picked-count" }, "已选 " + state.picked.length + " 条"),
							h(
								"span",
								{ className: "dpc-muted" },
								state.picked.length === 0
									? "点卡片即可选中（再点取消）；可以跨筛选凑一批"
									: state.pickedBytes === null
										? "正在量总体积…"
										: "约 " +
											fmtBytes(state.pickedBytes) +
											(() => {
												const sizes = state.pickedSizes || {};
												const missing = state.picked.filter((id) => !(Number(sizes[id]) > 0)).length;
												return missing > 0 ? "（" + missing + " 条没有独立目录，按 0 计）" : "";
											})(),
							),
							h("button", { className: "dpc-btn dpc-btn-sm", onClick: exportPicked, disabled: state.exportBusy || state.picked.length === 0 }, "导出选中"),
							h(
								"button",
								{ className: "dpc-btn dpc-btn-sm dpc-btn-ghost", onClick: () => set({ picked: filtered.slice(0, 200).map((item) => item.id), pickedBytes: null, pickedBusy: true }), disabled: filtered.length === 0 },
								"选中当前 " + Math.min(200, filtered.length) + " 条",
							),
							h("button", { className: "dpc-btn dpc-btn-sm dpc-btn-ghost", onClick: () => set({ picked: [], pickedBytes: null, pickedSizes: null }), disabled: state.picked.length === 0 }, "清空"),
						)
					: null,
				/* 洞察条：一眼看出「哪些没用、哪些在报错」，点一下就是一次筛选 */
				h(
					"div",
					{ className: "dpc-insights" },
					USAGE_FILTERS.map((option) =>
						h(
							"button",
							{
								key: option.id,
								className: "dpc-insight" + (state.usage === option.id ? " is-on" : "") + (option.id === "errors" && insightCounts.errors > 0 ? " is-warn" : "") + (insightCounts[option.id] === 0 ? " is-empty" : ""),
								title: USAGE_HINTS[option.id] || "按「用没用」筛选",
								onClick: () => set({ usage: option.id, page: 1 }),
							},
							option.label + " " + insightCounts[option.id],
						),
					),
				),
				/* 卡片网格 */
				h(
					"div",
					{ className: "dpc-grid" },
					pageItems.map((item) => h(Card, { key: item.id, item, tags: all, hits: toolHits(item, state.query), picking: state.picking, picked: state.picked.includes(item.id), onPick: togglePick, drift: (data.drift || {})[item.id] || null })),
					pageItems.length === 0 ? h("div", { className: "dpc-muted dpc-pad" }, "没有匹配的条目。") : null,
				),
				/* 列表分页条 */
				h(
					"div",
					{ className: "dpc-listbar" },
					h("span", { className: "dpc-listbar-count" }, "共 " + filtered.length + " 条" + (pageSize === 0 || totalPages === 1 ? "" : "　·　第 " + page + " / " + totalPages + " 页")),
					h(
						"div",
						{ className: "dpc-listbar-nav" },
						pageSize === 0 || totalPages === 1
							? null
							: h(
									"div",
									{ className: "dpc-pager" },
									h("button", { className: "dpc-btn dpc-btn-ghost dpc-btn-sm", disabled: page <= 1, onClick: () => gotoPage(1), title: "第一页" }, "«"),
									h("button", { className: "dpc-btn dpc-btn-ghost dpc-btn-sm", disabled: page <= 1, onClick: () => gotoPage(page - 1) }, "上一页"),
									h("span", { className: "dpc-page-pill" }, page + " / " + totalPages),
									h("button", { className: "dpc-btn dpc-btn-ghost dpc-btn-sm", disabled: page >= totalPages, onClick: () => gotoPage(page + 1) }, "下一页"),
									h("button", { className: "dpc-btn dpc-btn-ghost dpc-btn-sm", disabled: page >= totalPages, onClick: () => gotoPage(totalPages), title: "最后一页" }, "»"),
								),
						h(
							"label",
							{ className: "dpc-inline" },
							"每页 ",
							h(
								"select",
								{ value: String(pageSize), onChange: (event) => set({ pageSize: Number(event.target.value), page: 1 }) },
								LIST_PAGE_SIZES.map((size) => h("option", { key: size, value: String(size) }, size === 0 ? "全部" : String(size))),
							),
							" 条",
						),
					),
				),
				/* 宿主核心（单列，不算进任何插件） */
				hostCore && hostCore.calls > 0
					? h(
							"div",
							{ className: "dpc-hostcore" },
							h(
								"button",
								{ className: "dpc-card dpc-card-host", onClick: () => { set({ open: { id: "host-core", page: 1, pageSize: 20 }, detail: null }); loadDetail("host-core", 1, 20); } },
								h("div", { className: "dpc-card-head" },
									h("span", { className: "dpc-src dpc-src-official" }, "官方/宿主"),
									h("span", { className: "dpc-name" }, "宿主核心工具"),
									h("span", { className: "dpc-calls" }, fmtNumber(hostCore.calls)),
								),
								h("div", { className: "dpc-zh" }, "由 DSH 宿主自带（在 app.asar 里）或归属不明的工具。它们不属于任何可上传插件，所以单列 —— 不把这些量算到插件头上。"),
								h("div", { className: "dpc-card-foot" }, h("span", { className: "dpc-foot-meta" }, "共 " + hostCore.tools.length + " 个工具，前几个：" + hostCore.tools.slice(0, 5).map((tool) => tool.name).join("、"))),
							),
						)
					: null,
				/* 尾部说明 */
				h(
					"div",
					{ className: "dpc-footer" },
					"统计口径：只读会话事件日志（90 天），只存会话 ID / 昵称 / 次数，不含任何对话文本。Skill 只能到「次数 + 最近一次」。",
					h("br"),
					"来源四分类由文件系统事实判定（link 安装 / author / 官方作用域 / git 与上游差异）；拿不准的会标「待确认」，标一次就记住。",
					h("br"),
					"数据目录：" + (data.dataDir || "?") + "　｜　禁用一个插件即恢复官方界面：从 dsh.profile.bundles 去掉 dsh-plugin-catalog。",
				),
				state.open ? h(EntryModal, {}) : null,
				state.plan ? h(PlanModal, {}) : null,
			);
		}

		/* ── 样式 ── */

		const CSS = `
.dpc-entry{display:inline-flex;align-items:center;justify-content:center;position:relative;color:inherit}
.dpc-entry.is-active{color:var(--dsw-alias-brand-primary)}
.dpc-dot{position:absolute;top:-2px;right:-2px;width:7px;height:7px;border-radius:50%;
  background:var(--dsw-alias-state-warn-primary,#d89614);box-shadow:0 0 0 2px var(--dsw-alias-bg-base,#fff)}
/* 面板自己当滚动容器：官方中列 div._centerCol 是 overflow:hidden，
   面板若不自己滚，超出一屏的内容会被**静默裁掉** —— 既没有滚动条，也翻不到下面。
   height:100% 撑满 + overflow-y:auto，并把滚动条显式画出来（默认主题里几乎看不见）。 */
.dpc-panel{display:flex;flex-direction:column;gap:12px;padding:18px 20px 40px;height:100%;
  box-sizing:border-box;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;
  scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--dsw-alias-label-primary,#888) 26%,transparent) transparent}
.dpc-panel::-webkit-scrollbar{width:10px}
.dpc-panel::-webkit-scrollbar-track{background:transparent}
.dpc-panel::-webkit-scrollbar-thumb{border-radius:999px;border:2px solid transparent;background-clip:content-box;
  background-color:color-mix(in srgb,var(--dsw-alias-label-primary,#888) 26%,transparent)}
.dpc-panel::-webkit-scrollbar-thumb:hover{background-color:color-mix(in srgb,var(--dpc-klein) 70%,transparent)}
/* 本地色板：全部由 label-primary 混出来，深色/浅色主题都跟着走。
   之前直接用 --dsw-alias-border，深色主题下是接近白的实线，一排排白勾边很难看。 */
.dpc-panel,.dpc-overlay{
  --dpc-line:color-mix(in srgb,var(--dsw-alias-label-primary,#1f2937) 13%,transparent);
  --dpc-line-soft:color-mix(in srgb,var(--dsw-alias-label-primary,#1f2937) 8%,transparent);
  --dpc-fill:color-mix(in srgb,var(--dsw-alias-label-primary,#1f2937) 4%,transparent);
  --dpc-fill-hover:color-mix(in srgb,var(--dsw-alias-label-primary,#1f2937) 7%,transparent);
  --dpc-klein:#002fa7;
  --dpc-klein-glow:rgba(0,47,167,.55)}
.dpc-header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap}
.dpc-title{font-size:19px;font-weight:650;letter-spacing:.2px}
.dpc-sub{font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280);margin-top:4px;line-height:1.6}
.dpc-header-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.dpc-btn{appearance:none;border:1px solid var(--dsw-alias-border-strong,#d0d5dd);background:var(--dsw-alias-brand-primary,#3964fe);
  color:var(--dsw-alias-bg-base,#fff);border-radius:9px;padding:8px 14px;font-size:13px;cursor:pointer;line-height:1.2}
.dpc-btn:disabled{opacity:.55;cursor:default}
.dpc-btn-sm{padding:6px 10px;font-size:12px}
.dpc-btn-ghost{background:transparent;color:var(--dsw-alias-label-primary,#1f2937);border-color:var(--dpc-line)}
.dpc-btn-ghost:hover{background:var(--dpc-fill-hover);border-color:color-mix(in srgb,var(--dpc-klein) 45%,var(--dpc-line))}
.dpc-btn-ghost.is-on{border-color:var(--dsw-alias-brand-primary,#3964fe);color:var(--dsw-alias-brand-primary,#3964fe)}
.dpc-btn-ghost.is-due{border-color:var(--dsw-alias-state-warn-primary,#d89614);color:var(--dsw-alias-state-warn-primary,#d89614)}
.dpc-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:10px 12px;border-radius:13px;
  border:1px solid var(--dpc-line-soft);background:var(--dpc-fill)}
.dpc-search{flex:1 1 240px;min-width:200px;padding:8px 11px;border-radius:9px;font-size:13px;
  border:1px solid var(--dpc-line);background:color-mix(in srgb,var(--dsw-alias-bg-base,#fff) 55%,transparent);
  color:var(--dsw-alias-label-primary,#1f2937);transition:border-color .15s ease,box-shadow .15s ease}
.dpc-search:focus{outline:none;border-color:var(--dpc-klein);box-shadow:0 0 0 2px rgba(0,47,167,.22)}
.dpc-seg{display:inline-flex;border:1px solid var(--dpc-line);border-radius:9px;overflow:hidden}
.dpc-seg-btn{appearance:none;border:0;background:transparent;padding:6px 10px;font-size:12px;cursor:pointer;
  color:var(--dsw-alias-label-secondary,#4b5563)}
.dpc-seg-btn.is-on{background:var(--dsw-alias-brand-primary,#3964fe);color:var(--dsw-alias-bg-base,#fff)}
.dpc-inline{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280)}
.dpc-inline select,.dpc-add-form select{font-size:12px;padding:5px 8px;border-radius:7px;
  border:1px solid var(--dpc-line);background:color-mix(in srgb,var(--dsw-alias-bg-base,#fff) 55%,transparent);
  color:var(--dsw-alias-label-primary,#1f2937)}
/* ── 洞察条（R2）：一眼看出「哪些没用、哪些在报错」 ── */
.dpc-insights{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.dpc-insight{appearance:none;border:1px solid var(--dpc-line);background:transparent;color:inherit;
  font-size:11.5px;padding:3px 10px;border-radius:999px;cursor:pointer;font-variant-numeric:tabular-nums;
  transition:border-color .15s ease,box-shadow .15s ease,background .15s ease,color .15s ease}
.dpc-insight:hover{border-color:rgba(0,47,167,.55);box-shadow:0 0 0 1px rgba(0,47,167,.14),0 0 14px rgba(0,47,167,.16)}
.dpc-insight.is-on{border-color:#002fa7;background:rgba(0,47,167,.10);color:#002fa7;font-weight:600}
.dpc-insight.is-warn{color:#b45309}
.dpc-insight.is-warn.is-on{border-color:#b45309;background:rgba(217,119,6,.12);color:#8a5a06}
/* 数字为 0 的档位置灰：仍然可点（点开是空态 + 解释），但别让它看起来和有用的一样重 */
.dpc-insight.is-empty{opacity:.55}
.dpc-insight.is-empty.is-on{opacity:1}
/* 导出按钮靠右，和「N 条」拉开距离，避免误点 */
.dpc-export{margin-left:auto}
/* ── 多选（清理决策）──
   选择模式下点卡片 = 选中；选中项用克莱因蓝描边 + 勾徽章，一眼看出"这批是我圈的" */
.dpc-toolbar-actions{margin-left:auto;display:flex;align-items:center;gap:8px}
.dpc-card.is-picking{cursor:copy}
.dpc-card.is-picked{border-color:#002fa7;
  box-shadow:0 0 0 1px rgba(0,47,167,.45),0 0 20px -6px var(--dpc-klein-glow)}
.dpc-pick-badge{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;
  border-radius:50%;background:#002fa7;color:#fff;font-size:11px;font-weight:700;flex:0 0 auto}
/* 副本不同步：琥珀色短标签，别用红 —— 红色已经表示"报错" */
.dpc-drift{font-size:10.5px;line-height:1.5;padding:1px 6px;border-radius:999px;font-weight:600;flex:0 0 auto;
  color:#8a5a06;background:rgba(217,119,6,.14);border:1px solid rgba(217,119,6,.35)}
.dpc-pickedbar{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:8px 11px;border-radius:11px;
  border:1px dashed color-mix(in srgb,#002fa7 45%,var(--dpc-line));background:rgba(0,47,167,.06);font-size:12px}
.dpc-picked-count{font-weight:650;color:#002fa7;font-variant-numeric:tabular-nums}
/* 搜索命中的工具名：蓝色等宽，和简介区分开，一眼看到「命中的是哪个工具」 */
.dpc-hit{font-size:11px;line-height:1.5;color:#002fa7;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  word-break:break-all}
/* 报错 chip：只有 errors>0 才出现，标题里带错误率 */
.dpc-err{font-size:10.5px;padding:1px 6px;border-radius:6px;border:1px solid rgba(185,28,28,.45);
  color:#b91c1c;background:rgba(220,38,38,.10);font-variant-numeric:tabular-nums}
.dpc-calls.is-zero{color:var(--dsw-alias-label-secondary,#8b93a1);font-weight:500}
.dpc-path{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;word-break:break-all;
  color:var(--dsw-alias-label-secondary,#4b5563);background:var(--dpc-fill);padding:2px 6px;border-radius:6px;
  border:1px solid var(--dpc-line-soft)}
.dpc-grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(300px,1fr))}
.dpc-card{appearance:none;text-align:left;display:flex;flex-direction:column;gap:7px;padding:14px 15px;
  border-radius:14px;border:1px solid var(--dpc-line);position:relative;overflow:hidden;
  background:linear-gradient(180deg,var(--dpc-fill),transparent 72%);
  color:inherit;cursor:pointer;
  transition:border-color .16s ease,box-shadow .18s ease,transform .16s ease}
/* 顶部一道极淡的高光，让卡片有“面”而不是一块纯色 */
.dpc-card::before{content:"";position:absolute;left:0;right:0;top:0;height:1px;pointer-events:none;
  background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--dsw-alias-label-primary,#fff) 22%,transparent),transparent)}
/* 悬停：边缘发一圈克莱因蓝的光（#002FA7） */
.dpc-card:hover{
  border-color:color-mix(in srgb,var(--dpc-klein) 66%,var(--dpc-line));
  box-shadow:0 0 0 1px rgba(0,47,167,.38),0 0 20px -3px var(--dpc-klein-glow),0 14px 30px -22px rgba(0,0,0,.55);
  transform:translateY(-1px)}
.dpc-card:focus-visible{outline:none;border-color:var(--dpc-klein);
  box-shadow:0 0 0 2px rgba(0,47,167,.5),0 0 22px -4px var(--dpc-klein-glow)}
.dpc-card.is-off{opacity:.72}
.dpc-card-host{grid-column:1/-1}
.dpc-card-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.dpc-name{font-weight:600;font-size:13.5px;word-break:break-all}
.dpc-kind{font-size:11px;padding:1px 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-3,rgba(0,0,0,.06));
  color:var(--dsw-alias-label-secondary,#4b5563)}
.dpc-warn{font-size:11px;padding:1px 6px;border-radius:6px;border:1px solid var(--dsw-alias-state-warn-primary,#d89614);
  color:var(--dsw-alias-state-warn-primary,#d89614)}
.dpc-calls{margin-left:auto;font-variant-numeric:tabular-nums;font-weight:650;font-size:13.5px;
  color:var(--dsw-alias-brand-primary,#3964fe)}
.dpc-zh{font-size:12.5px;line-height:1.55;color:var(--dsw-alias-label-primary,#1f2937);
  display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.dpc-zh-plain{color:var(--dsw-alias-label-secondary,#525a66)}
.dpc-en{font-size:11px;line-height:1.45;color:var(--dsw-alias-label-secondary,#8b93a1);
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.dpc-en-block{font-size:12px;margin-top:6px;-webkit-line-clamp:6}
.dpc-card-foot{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:2px}
.dpc-foot-meta{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary,#8b93a1)}
.dpc-chips{display:inline-flex;gap:4px;flex-wrap:wrap}
.dpc-chip{font-size:10.5px;padding:1px 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-3,rgba(0,0,0,.06));
  color:var(--dsw-alias-label-secondary,#4b5563)}
.dpc-src{font-size:10.5px;padding:1px 7px;border-radius:999px;white-space:nowrap;border:1px solid transparent}
.dpc-src-official{background:rgba(57,100,254,.12);color:#2f5fd0;border-color:rgba(57,100,254,.3)}
.dpc-src-self{background:rgba(22,163,74,.14);color:#15803d;border-color:rgba(22,163,74,.32)}
.dpc-src-third{background:rgba(107,114,128,.14);color:#4b5563;border-color:rgba(107,114,128,.28)}
.dpc-src-hybrid{background:rgba(217,119,6,.15);color:#b45309;border-color:rgba(217,119,6,.34)}
.dpc-src-pending{background:rgba(220,38,38,.12);color:#b91c1c;border-color:rgba(220,38,38,.34)}
.dpc-overlay{position:fixed;inset:0;z-index:70;background:rgba(15,23,42,.48);display:flex;
  align-items:center;justify-content:center;padding:20px}
.dpc-modal{width:min(780px,calc(100vw - 32px));max-height:calc(100vh - 48px);display:flex;flex-direction:column;
  border-radius:16px;background:var(--dsw-alias-bg-base,#fff);
  box-shadow:0 1px 0 color-mix(in srgb,var(--dsw-alias-label-primary,#000) 6%,transparent) inset,0 28px 72px rgba(0,0,0,.42);
  border:1px solid var(--dpc-line);overflow:hidden;color:var(--dsw-alias-label-primary,#1f2937)}
.dpc-modal-wide{width:min(940px,calc(100vw - 32px))}
.dpc-modal-head{display:flex;align-items:center;gap:9px;padding:13px 18px;flex:0 0 auto;z-index:2;
  border-bottom:1px solid var(--dpc-line-soft);
  background:color-mix(in srgb,var(--dsw-alias-bg-base,#fff) 86%,transparent);backdrop-filter:blur(10px)}
.dpc-modal-title{font-weight:650;font-size:15px;word-break:break-all;letter-spacing:.1px}
.dpc-grow{flex:1}
.dpc-modal-body{padding:16px 18px 22px;overflow:auto;display:flex;flex-direction:column;gap:12px}
.dpc-stats{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(104px,1fr))}
.dpc-stat{padding:10px 12px;border-radius:12px;border:1px solid var(--dpc-line-soft);background:var(--dpc-fill)}
.dpc-stat-value{font-size:17px;font-weight:650;font-variant-numeric:tabular-nums;line-height:1.25}
.dpc-stat-label{font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280);margin-top:3px}
/* 详情分区改成"一块卡片"，替掉原来一排虚线分隔 —— 之前每段之间只有一条虚线，看着散 */
.dpc-block{display:flex;flex-direction:column;gap:9px;padding:13px 14px;border-radius:14px;
  border:1px solid var(--dpc-line-soft);background:var(--dpc-fill)}
.dpc-block-title{display:flex;align-items:center;gap:8px;font-size:11.5px;font-weight:650;
  color:var(--dsw-alias-label-secondary,#4b5563);letter-spacing:.4px}
.dpc-block-title::before{content:"";width:3px;height:12px;border-radius:2px;background:var(--dpc-klein);opacity:.8;flex:0 0 auto}
.dpc-why{margin:0;padding-left:18px;font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary,#4b5563)}
.dpc-table{width:100%;border-collapse:collapse;font-size:12px}
.dpc-table th{text-align:left;font-weight:600;color:var(--dsw-alias-label-secondary,#6b7280);
  padding:6px 8px;border-bottom:1px solid var(--dpc-line);font-size:11px;white-space:nowrap}
.dpc-table td{padding:6px 8px;border-bottom:1px solid var(--dpc-line-soft);font-variant-numeric:tabular-nums}
.dpc-table tbody tr:nth-child(even){background:color-mix(in srgb,var(--dsw-alias-label-primary,#1f2937) 3%,transparent)}
.dpc-table tbody tr:last-child td{border-bottom:0}
.dpc-table tbody tr:hover{background:var(--dpc-fill-hover)}
.dpc-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px}
.dpc-bad{color:#b91c1c}
.dpc-muted{color:var(--dsw-alias-label-secondary,#8b93a1);font-size:11.5px}
.dpc-pad{padding:10px 0}
.dpc-note{font-size:12px;line-height:1.6;padding:8px 11px;border-radius:9px;
  background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.03));color:var(--dsw-alias-label-secondary,#4b5563)}
.dpc-note-warn{border:1px solid var(--dsw-alias-state-warn-primary,#d89614);color:#8a5a06}
.dpc-jobbanner{font-size:12px;padding:7px 11px;border-radius:9px;border:1px solid var(--dsw-alias-brand-primary,#3964fe);
  background:rgba(57,100,254,.08);color:#2f5fd0}
.dpc-sessions-head{display:flex;justify-content:space-between;align-items:center;font-size:12px;
  color:var(--dsw-alias-label-secondary,#4b5563);margin-bottom:4px}
.dpc-sessions{display:flex;flex-direction:column;gap:2px;max-height:300px;overflow:auto}
.dpc-session{display:flex;align-items:center;gap:8px;font-size:12px;padding:6px 9px;border-radius:9px;
  transition:background .12s ease}
.dpc-session:hover{background:var(--dpc-fill-hover)}
.dpc-session.is-sub{background:rgba(217,119,6,.07)}
.dpc-session-calls{font-variant-numeric:tabular-nums;font-weight:600;min-width:38px}
.dpc-session-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:320px}
.dpc-sub-badge{font-size:10px;padding:0 5px;border-radius:5px;border:1px solid rgba(217,119,6,.5);color:#b45309}
.dpc-session-time{margin-left:auto}
.dpc-pager{display:flex;align-items:center;gap:8px;margin-top:6px}
.dpc-listbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:2px 2px 4px}
.dpc-listbar-count{font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280);font-variant-numeric:tabular-nums}
.dpc-listbar-nav{margin-left:auto;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dpc-listbar-nav .dpc-pager{margin-top:0}
.dpc-page-pill{font-size:12px;font-variant-numeric:tabular-nums;padding:3px 11px;border-radius:999px;
  background:var(--dpc-fill);color:var(--dsw-alias-label-secondary,#4b5563);white-space:nowrap}
.dpc-row{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.dpc-row-end{justify-content:flex-end;padding-top:10px}
.dpc-link{font-size:11.5px;color:var(--dsw-alias-brand-primary,#3964fe);word-break:break-all}
.dpc-tag-group{display:flex;flex-direction:column;gap:4px}
.dpc-tag-group-title{font-size:11px;color:var(--dsw-alias-label-secondary,#8b93a1)}
.dpc-tag-list{display:flex;gap:4px;flex-wrap:wrap}
.dpc-tag{appearance:none;font-size:11px;padding:3px 9px;border-radius:999px;cursor:pointer;
  border:1px solid var(--dpc-line);background:var(--dpc-fill);color:var(--dsw-alias-label-secondary,#4b5563);
  transition:border-color .14s ease,color .14s ease,background .14s ease}
.dpc-tag:hover{border-color:var(--dpc-klein);color:var(--dpc-klein)}
.dpc-tag.is-on{background:var(--dsw-alias-brand-primary,#3964fe);border-color:var(--dsw-alias-brand-primary,#3964fe);
  color:var(--dsw-alias-bg-base,#fff)}
.dpc-tag-custom{font-size:9px;margin-left:4px;opacity:.75}
.dpc-chip-x{appearance:none;border:0;background:transparent;cursor:pointer;color:inherit;font-size:11px;padding:0 2px;opacity:.6}
.dpc-add-form{display:flex;flex-direction:column;gap:6px;padding:9px;border-radius:9px;
  border:1px dashed var(--dsw-alias-border-strong,#d0d5dd)}
.dpc-add-form input{padding:6px 9px;border-radius:7px;font-size:12px;
  border:1px solid var(--dsw-alias-border,#e5e7eb);background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.6));
  color:var(--dsw-alias-label-primary,#1f2937)}
.dpc-plan-list{display:flex;flex-direction:column;gap:6px;max-height:42vh;overflow:auto}
.dpc-plan-item{padding:8px 10px;border-radius:9px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.03));
  display:flex;flex-direction:column;gap:3px}
.dpc-plan-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.dpc-action{font-size:10.5px;padding:1px 7px;border-radius:999px;border:1px solid transparent}
.dpc-action-create{background:rgba(57,100,254,.12);color:#2f5fd0;border-color:rgba(57,100,254,.3)}
.dpc-action-update{background:rgba(22,163,74,.12);color:#15803d;border-color:rgba(22,163,74,.3)}
.dpc-action-up-to-date{background:rgba(107,114,128,.12);color:#4b5563;border-color:rgba(107,114,128,.3)}
.dpc-action-blocked-secrets,.dpc-action-error{background:rgba(220,38,38,.12);color:#b91c1c;border-color:rgba(220,38,38,.34)}
.dpc-hits{display:flex;flex-direction:column;gap:2px;margin-top:3px}
.dpc-hit{display:flex;align-items:center;gap:6px;font-size:11px;flex-wrap:wrap}
.dpc-ack{margin-top:4px;font-size:11px;color:var(--dsw-alias-label-secondary,#8b93a1)}
.dpc-ack input{margin:0}
.dpc-sev{font-size:10px;padding:0 5px;border-radius:5px}
.dpc-sev-critical{background:rgba(220,38,38,.16);color:#b91c1c}
.dpc-sev-high{background:rgba(234,88,12,.16);color:#c2410c}
.dpc-sev-medium{background:rgba(217,119,6,.16);color:#b45309}
.dpc-pre{font-size:11px;max-height:240px;overflow:auto;padding:9px;border-radius:9px;
  background:var(--dsw-alias-bg-layer-3,rgba(0,0,0,.05));white-space:pre-wrap;word-break:break-all}
.dpc-hostcore{margin-top:6px}
.dpc-footer{margin-top:10px;font-size:11px;line-height:1.8;color:var(--dsw-alias-label-secondary,#8b93a1)}
@media (max-width:760px){
  .dpc-panel{padding:12px 10px 32px}
  .dpc-grid{grid-template-columns:1fr}
  .dpc-overlay{padding:8px}
  .dpc-modal{max-height:calc(100vh - 16px)}
  .dpc-header-actions{justify-content:flex-start}
}
`;

		/* ── 插件体 ── */

		function apply(ctx) {
			clientCtx = ctx;
			ctx.effect(() => {
				const style = document.createElement("style");
				style.setAttribute("data-plugin", "dsh-plugin-catalog");
				style.textContent = CSS;
				document.head.appendChild(style);
				return () => {
					try {
						style.remove();
					} catch (error) {
						/* ignore */
					}
				};
			}, "plugin-catalog: styles");

			ctx.effect(() => {
				startPolling();
				return () => stopPolling();
			}, "plugin-catalog: polling");

			ctx.slots.inject("sidebar.panellist", () =>
				ctx.slots.register({ name: "sidebar.panellist", id: PANEL_ID, order: 20, label: () => PANEL_LABEL }, SidebarEntry),
			);

			ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: PANEL_ID }, Panel));
		}

		const exports = { apply, inject: ["slots", "layout"] };
		exports.__test = {
			apply,
			BUILD,
			PANEL_ID,
			PANEL_LABEL,
			SOURCE_META,
			SORTS,
			USAGE_FILTERS,
			USAGE_HINTS,
			AUTO_REFRESH_MS,
			store,
			refresh,
			loadDetail,
			openEntry,
			closeEntry,
			startPolling,
			stopPolling,
			Panel,
			Card,
			EntryModal,
			PlanModal,
			SessionList,
			ToolTable,
			TagEditor,
			SidebarEntry,
			CatalogIcon,
			fmtNumber,
			fmtMs,
			fmtBytes,
			loadSize,
			ago,
			tagLabel,
			isUnused,
			hasErrors,
			errorRate,
			isSubagentOnly,
			togglePick,
			togglePicking,
			driftLabel,
			driftDetail,
			toolHits,
			hotkeyOf,
			copyText,
			VIEW_KEY,
			VIEW_KEYS,
			readView,
			writeView,
		};
		return exports;
	},
});
