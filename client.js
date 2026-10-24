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
		const BUILD = "r26.0";
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
			/* 体积：清理决策的第一问是「删这个能省多少」，排序就该能按它排（数据来自后台全量快照） */
			{ id: "size", label: "体积" },
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

		/* 体积快照多久算旧：超过它就自动在后台量一遍（全量量一次约几秒；阈值别设太短，
		   面板 20 秒轮询一次、体积又不会自己变）。 */
		const SIZES_TTL_MS = 24 * 60 * 60 * 1000;

		/* 列表每页可选条数（127 条一次铺完既卡又难扫，必须能分页） */
		const LIST_PAGE_SIZES = [12, 24, 48, 96, 0]; /* 0 = 全部 */

		/* ── 迷你 store（模块级：面板关着时图标也在用） ── */

		/* 上一次已经抬到提示条的体检结论时间戳（20 秒轮询不重复刷屏） */
		let preflightNoticeAt = 0;

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
			/* R9：只看「无人依赖」的候选（清理决策；候选不是结论，界面会带说明） */
			orphanOnly: false,
			/* R12：只看「不会被加载」的条目 —— 不在 bundles、不在配置条目、不在依赖链上，
			   属于装了也不会跑的那一类（本机实测 26 个包，含整个 mnemon 子系统）。 */
			dormantOnly: false,
			/* R15：标签筛选（可多选）。判据：**同维度 OR、跨维度 AND** ——
			   「做截图 或 做媒体」+「用在 Web GUI」＝ 这一块里我要的。 */
			tagFilter: [],
			/* R15：批量打标浮层（null = 关）。浮层里的勾选是**本地待提交状态**，
			   点「应用」才发一次 batch 请求 —— 逐条发请求会在中途失败时留下半个批次。 */
			tagPick: null,
			/* R11：「同步 staging」的二次确认（**服务端已经出过计划**才允许点确认写盘）。
			   ★ 这个和 picked 一样**不进 localStorage**：重载后必须重新出计划，
			     不能拿一份过期的计划去覆盖文件。 */
			syncPlan: null,
			syncBusy: false,
			/* R20：「还原 staging 备份」的二次确认。与 syncPlan 同一条纪律：
			   服务端先出还原计划（只读），人看着确认条点一次才写盘；计划不进 localStorage。 */
			restorePlan: null,
			restoreBusy: false,
			/* R14：「处置清单」的写入确认（两步：先出清单，再点一次才写 reports/）。
			   ★ 与服务端一致的纪律：清单**永远不执行删除**，写盘必须显式确认。 */
			uninstallBusy: false,
			uninstallConfirm: false,
			/* R16：删除预演的结论（只算不删）。**不进 localStorage** —— 它是按当前依赖图算出来的，
			   刷新后必须是「还没预演」，不能拿一份过期的"安全"结论去背书一次删除。 */
			sim: null,
			simBusy: false,
			/* R17：变化条默认收起（它是"接手时看一眼"的信息，不该长期占版面）。 */
			showChanges: false,
			/* R21：更早窗口的时间线（与当前变化窗口分开折叠，不抢版面） */
			showHistory: false,
			/* R22：配置层浮层（读**声明**：条目从哪来 / 关掉的 / 条件启用的 / bundles 缺口）。
			   ★ 不持久化：它是一个"现在看一眼"的面板，重载后不需要自动弹回来。 */
			showComposition: false,
		};

		/* ── 视图状态持久化（热重载 / 刷新之后，筛选与滚动位置不再归零） ──
		   ★ 只存**用户动过**的那几个键；`data` / `detail` 每次轮询都变，绝不入库。
		   ★ localStorage 在无头自检里不存在，也可能被浏览器策略关掉 ——
		     所以读、写、恢复三步都必须是"安静地放弃"，不能抛到渲染里。 */
		const VIEW_KEY = "dsh-plugin-catalog/view-v1";
		const VIEW_KEYS = ["query", "source", "kind", "sort", "usage", "pageSize", "page", "orphanOnly", "dormantOnly", "tagFilter"];

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

		/**
		 * R10：体检跑完把结论抬到提示条（同一次结论只抬一次，20 秒轮询不刷屏）。
		 * ★ 必须**两处都调**：`refresh()`（挂载 / 点按钮后）与轮询 tick（后台跑完那一刻）。
		 *   本轮真 bug：逻辑只写在 refresh 里，而 20 秒轮询走的是自己的 fetch —— 于是"点自检 → 结果永远不出现"，
		 *   界面看起来像"点了没反应"，其实任务早跑完了。
		 */
		function notePreflight(data) {
			const job = data && data.job;
			if (!job || job.running || job.kind !== "preflight" || !job.result || !job.finishedAt) return;
			if (job.finishedAt === preflightNoticeAt) return;
			preflightNoticeAt = job.finishedAt;
			const result = job.result || {};
			/* 第 4 项（副本同步）没有 passed/failed，只有一个"X 对里 Y 个旧"：
			   写成 `staging ?` 会让人以为这条没跑，所以单独给它的口径。 */
			const parts = (result.checks || []).map((check) => {
				if (check.informational) {
					const stale = Array.isArray(check.stale) ? check.stale.length : 0;
					return check.id + " " + (check.ok === false ? "失败" : (Number(check.pairs) || 0) + " 对/" + stale + " 旧");
				}
				return check.id + " " + (check.passed ?? "?") + (check.failed > 0 ? "（失败 " + check.failed + "）" : "");
			});
			set({
				notice: result.ok
					? "自检全绿：" + parts.join(" / ") + "，共 " + Math.round((result.durationMs || 0) / 1000) + " 秒｜报告 " + (result.reportPath || "")
					: "自检失败：" + (result.error || (result.checks || []).filter((check) => !check.ok).map((check) => check.id).join("、") || "未知原因") + "｜" + (result.reportPath || ""),
			});
		}

		async function refresh() {
			try {
				const data = await api("/state");
				set({ data, loading: false, error: null });
				notePreflight(data);
				if (store.open) await loadDetail(store.open.id, store.open.page || 1, store.open.pageSize);
			} catch (error) {
				set({ loading: false, error: String((error && error.message) || error) });
			}
		}

		/* ── R11：「同步 staging」三步（出计划 → 二次确认 → 写盘）──
		   ★ 走服务端 `/skillsync`，与 `catalog_skill_sync` 工具**同一个 service 方法**：
		     方向永远单向 `live → staging`，覆盖前备份 `.bak-<时间戳>`。
		   ★ 按钮本身拿不到写盘权限：apply 必须带 `confirm:true`，少了服务端直接拒 ——
		     这样"误点一下"最多出一份计划，不会改文件。
		   ★ 计划**不进 localStorage**：重载后必须重新出计划，不能拿过期计划去覆盖文件。 */
		async function planStageSync(ids) {
			set({ syncBusy: true, syncPlan: null });
			try {
				const result = await post("/skillsync", { ids: Array.isArray(ids) ? ids : [] });
				if (!result || result.ok !== true) {
					set({ syncBusy: false, notice: "取同步计划失败：" + String((result && result.error) || "未知错误") });
					return;
				}
				if (!Number(result.count)) {
					set({ syncBusy: false, syncPlan: null, notice: "没有需要同步的 Skill（staging 与加载的那份一致）" });
					return;
				}
				set({ syncBusy: false, syncPlan: result, notice: null });
			} catch (error) {
				set({ syncBusy: false, notice: "取同步计划失败：" + String((error && error.message) || error) });
			}
		}

		async function applyStageSync() {
			const plan = store.syncPlan;
			if (!plan) return;
			const ids = (plan.items || []).map((item) => item.id);
			set({ syncBusy: true });
			try {
				const result = await post("/skillsync", { ids, apply: true, confirm: true });
				set({ syncBusy: false, syncPlan: null });
				if (result && result.ok) {
					set({ notice: "已把 " + ((result.synced || []).length) + " 个 Skill 的 SKILL.md 同步到 staging（备份 " + ((result.backups || []).length) + " 份 .bak-" + (result.stamp || "") + "；要撤销就到条目浮窗点「还原到 " + (result.stamp || "") + "」）" });
				} else {
					const failedNames = result && Array.isArray(result.failed) ? result.failed.map((item) => item.name).join("、") : "";
					set({ notice: "同步失败：" + String((result && result.error) || "未知错误") + (failedNames ? "（" + failedNames + "）" : "") });
				}
			} catch (error) {
				set({ syncBusy: false, syncPlan: null, notice: "同步失败：" + String((error && error.message) || error) });
			}
			await refresh();
		}

		/* ── R20：「还原 staging 备份」三步（出计划 → 二次确认 → 写盘）──
		   ★ 与同步对称：方向 `backup → staging`，只动上传用的那份，永远不碰 DSH 加载的文件。
		   ★ 走服务端 `/skillsync {action:"restore"}`，与 `catalog_skill_sync action=restore`
		     是同一个 service 方法；apply 必须带 confirm:true，否则服务端直接拒。 */
		async function planStageRestore(id) {
			set({ restoreBusy: true, restorePlan: null });
			try {
				const result = await post("/skillsync", { action: "restore", ids: [id] });
				if (!result || result.ok !== true) {
					set({ restoreBusy: false, notice: "取还原计划失败：" + String((result && result.error) || "未知错误") });
					return;
				}
				if (!Number(result.count)) {
					const why = Array.isArray(result.skipped) && result.skipped[0] ? result.skipped[0].reason : "没有可还原的备份";
					set({ restoreBusy: false, restorePlan: null, notice: "没有可还原的备份：" + why });
					return;
				}
				set({ restoreBusy: false, restorePlan: result, syncPlan: null, notice: null });
			} catch (error) {
				set({ restoreBusy: false, notice: "取还原计划失败：" + String((error && error.message) || error) });
			}
		}

		async function applyStageRestore() {
			const plan = store.restorePlan;
			if (!plan) return;
			const ids = (plan.items || []).map((item) => item.id);
			set({ restoreBusy: true });
			try {
				const result = await post("/skillsync", { action: "restore", ids, apply: true, confirm: true });
				set({ restoreBusy: false, restorePlan: null });
				if (result && result.ok) {
					const unchanged = Array.isArray(result.unchanged) ? result.unchanged.length : 0;
					set({ notice: "已把 " + ((result.restored || []).length) + " 个 Skill 的 staging 还原到备份版本（还原前那份已另存 .bak-" + (result.stamp || "") + "；DSH 加载的文件没动）" + (unchanged ? "；" + unchanged + " 个与备份一致，未改" : "") });
				} else {
					const failedNames = result && Array.isArray(result.failed) ? result.failed.map((item) => item.name).join("、") : "";
					set({ notice: "还原失败：" + String((result && result.error) || "未知错误") + (failedNames ? "（" + failedNames + "）" : "") });
				}
			} catch (error) {
				set({ restoreBusy: false, restorePlan: null, notice: "还原失败：" + String((error && error.message) || error) });
			}
			await refresh();
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
					/* ★ 这条路必须也调：后台任务跑完的那一刻，只有轮询会看到（refresh 不一定被触发） */
					notePreflight(data);
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

		/* ── R11：staging 是否「旧了」的判据（纯函数，可直接断言）──
		   只有「内容不同」与「加载的那份更新」才该同步。
		   ★ `newer-workspace`（staging 更新）**绝不能自动同步** —— 那会把线上正在用的那份覆盖回旧版，
		     正是本轮"单向"铁律的反面。所以判据写成白名单而不是"不是 same 就算旧"。 */
		function isStageStale(drift) {
			if (!drift || drift.staged !== true) return false;
			return drift.verdict === "differs" || drift.verdict === "newer-loaded";
		}

		function staleSkillIds(driftMap) {
			if (!driftMap || typeof driftMap !== "object") return [];
			return Object.keys(driftMap).filter((id) => isStageStale(driftMap[id]));
		}

		/** 体积：只给人看，不参与判断（「12.3 MB · 318 个文件」） */		function fmtBytes(bytes) {
			const value = Number(bytes) || 0;
			if (value >= 1024 * 1024 * 1024) return (value / (1024 * 1024 * 1024)).toFixed(1) + " GB";
			if (value >= 1024 * 1024) return (value / (1024 * 1024)).toFixed(1) + " MB";
			if (value >= 1024) return (value / 1024).toFixed(0) + " KB";
			return value + " B";
		}

		/**
		 * 一个条目的体积（字节）。
		 * 没量过、或没有可量的目录（官方包在 asar 里 / Skill 没有独立目录）一律返回 **null**，
		 * 绝不返回 0 —— 「0 B」和「量不到」在清理决策里是两件事。纯函数，自检可直接断言。
		 */
		function sizeOfItem(item, sizeMap) {
			if (!item || !sizeMap) return null;
			const value = sizeMap[item.id];
			return Number.isFinite(value) ? value : null;
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
		 * R9：无人依赖的**候选**。服务端在 profile 里（含一层嵌套）扫描了每个 package.json 的
		 * dependencies / optionalDependencies / peerDependencies，没有任何一个声明依赖它。
		 * ★ 候选不是结论：嵌套更深的声明可能漏读，界面文案一律带"需确认"，不许写成"可以删"。
		 */
		function isOrphanHint(item) {
			return Boolean(item && item.orphanHint);
		}

		/**
		 * R9：卡片上的依赖 chip 文案（纯函数，自检可直接断言）。
		 * 「被 N 依赖」= 删了会让这些包坏；「无人依赖」= 候选。
		 */
		function depLabel(item) {
			if (!item || item.kind === "skill") return "";
			if (Number(item.dependentCount) > 0) return "被 " + item.dependentCount + " 依赖";
			if (item.orphanHint) return "无人依赖";
			return "";
		}

		/**
		 * R12：这个条目会不会被宿主加载。
		 *
		 * ★ 只有宿主明确说 `dormant`（不在 bundles、没有配置条目、也不在任何入口的依赖链上）
		 *   才算"不会被加载"。没有 `loadState`（旧快照 / 宿主还没重载）时一律当**未知**——
		 *   绝不能用 `enabled` 猜：旧口径正是拿"在不在 bundles"当加载判据，把 24 个实际在跑的包
		 *   （含 354 MB 的 `@dsh-ops/bash-win32-x64`）标成「启用：否」并置灰。
		 */
		function isDormant(item) {
			return Boolean(item && item.loadState === "dormant");
		}

		/** 配置条目挂载（不在 bundles 里，但确实会被加载）。 */
		function isConfigLoaded(item) {
			return Boolean(item && item.loadState === "config");
		}

		/** 卡片 chip：只给「不会被加载」与「配置入口」两档，间接加载 152 条不占版面。 */
		function loadLabel(item) {
			if (!item || item.kind === "skill") return "";
			if (item.loadState === "dormant") return "不会被加载";
			if (item.loadState === "config") return "配置入口";
			return "";
		}

		/** chip 的悬停说明书（四态各一句，别让读者自己去猜 enabled 与 loadState 的区别）。 */
		function loadTitle(item) {
			if (!item) return "";
			if (item.loadState === "dormant") return "不在 dsh.profile.bundles、没有 cordis 配置条目、也不在任何入口的依赖链上 —— 宿主不会加载它。删掉不影响当前加载；但如果你打算以后在 cordis.patch.yml 里挂它，就别删。";
			if (item.loadState === "config") return "不在 dsh.profile.bundles，但被 cordis 配置条目" + (item.loadVia ? " `" + item.loadVia + "`" : "") + " 挂着 —— 它会加载。";
			if (item.loadState === "transitive") return "不在 bundles，但 " + (item.loadVia || "某个入口") + " 声明依赖它 —— 随它一起加载，删了会连带弄坏。";
			if (item.loadState === "bundle") return "在 dsh.profile.bundles 里，直接启用。";
			return "宿主还没给出加载态（旧快照 / 还没重载）—— 别拿「在不在 bundles」当结论。";
		}

		/** 详情页「启用」格子的文案。 */
		function loadCell(item) {
			if (!item || item.kind === "skill") return "";
			if (item.loadState === "dormant") return "否";
			if (item.loadState === "config") return "配置(" + (item.loadVia || "条目") + ")";
			if (item.loadState === "transitive") return "随 " + (item.loadVia || "依赖");
			if (item.loadState === "bundle") return "是";
			return "未知";
		}

		/** 状态库里的 dormant 条目数（工具条上的「不会被加载 N」）。 */
		function dormantCountOf(items) {
			return (items || []).filter(isDormant).length;
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
					className: "dpc-card" + (isDormant(item) ? " is-off" : "") + (picked ? " is-picked" : "") + (picking ? " is-picking" : ""),
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
					/* R12：会不会被加载 —— 只有宿主给出 loadState 才敢下结论 */
					loadLabel(item) ? h("span", { className: "dpc-load" + (isConfigLoaded(item) ? " is-config" : ""), title: loadTitle(item) }, loadLabel(item)) : null,
					driftLabel(drift) ? h("span", { className: "dpc-drift", title: driftDetail(drift) }, driftLabel(drift)) : null,
					item.askUser ? h("span", { className: "dpc-warn", title: "来源待你确认一次" }, "待确认") : null,
					hasErrors(item)
						? h("span", { className: "dpc-err", title: "报错 " + (item.errors || 0) + " 次 / 调用 " + (item.calls || 0) + " 次（" + Math.round(errorRate(item) * 100) + "%）" }, "报错 " + fmtNumber(item.errors || 0))
						: null,
					/* 体积：量得到才显示。显示不出来不是 bug —— 官方包在 asar 里、或还没量（面板顶部有「量体积」）。
					   带「+」的是超过预算只算了一部分的条目，数字是下限。 */
					props.size
						? h(
								"span",
								{
									className: "dpc-size",
									title: props.sizeTruncated
										? "超过 1.5 秒 / 2 万文件预算，只算到这里（实际只会更大）"
										: item.inAsar
											? "在官方 asar 里，体积记在 DSH 安装包内"
											: "这个目录在磁盘上占 " + props.size + " 字节",
								},
								fmtBytes(props.size) + (props.sizeTruncated ? "+" : ""),
							)
						: null,
					/* R9：依赖关系 —— 「删了会弄坏谁」必须在卡片上就看得见，不能等点开浮窗 */
					depLabel(item)
						? h(
								"span",
								{
									className: "dpc-dep" + (Number(item.dependentCount) > 0 ? "" : " is-orphan"),
									title:
										Number(item.dependentCount) > 0
											? "被这些包依赖：" +
												(item.dependents || []).join("、") +
												(Number(item.dependentCount) > (item.dependents || []).length ? " 等 " + item.dependentCount + " 个" : "") +
												" —— 删它会让它们直接坏掉"
											: "profile 里没有任何包的 package.json 声明依赖它（嵌套只展开了一层）。这是候选，动之前用 npm ls / pnpm why 确认",
								},
								depLabel(item),
							)
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

		/* R15：批量打标浮层。
		   ★ 三态是这个浮层的全部难度：一个批次里的条目标签各不相同，
		     只画「开 / 关」会骗人 —— 那会让你以为点一下是"设成这个"，实际是"给缺的补上"。
		       全部都有 → 已选，点一下＝从这批里**去掉**（显示 −）
		       部分有   → 半选，点一下＝给缺的那些**加上**（不动已经有的）
		       都没有   → 空，点一下＝给全部**加上**
		   ★ 勾选只是**本地意图**，点「应用」才发一次 batch 请求；
		     逐条发请求会在中途失败时留下半个批次，而用户以为全成了。 */
		function TagBatchModal(props) {
			const state = useStore();
			const all = (state.data && state.data.tags && state.data.tags.all) || [];
			const ids = props.ids || [];
			const byId = new Map(((state.data && state.data.entries) || []).map((item) => [item.id, item]));
			/* props.ids 可能包含已被卸载的条目（选中后重扫过）：只对还存在的打标 */
			const picked = ids.map((id) => byId.get(id)).filter(Boolean);
			const [ops, setOps] = useState({});
			const [busy, setBusy] = useState(false);
			const [error, setError] = useState("");

			function have(tagId, dimension) {
				let n = 0;
				for (const item of picked) if ((item.tags?.[dimension] || []).includes(tagId)) n += 1;
				return n;
			}
			/* 没有待提交操作时的**默认意图**：全都有＝去掉，其余＝加上 */
			function defaultOp(tagId, dimension) {
				return picked.length > 0 && have(tagId, dimension) === picked.length ? "remove" : "add";
			}
			function toggle(tagId, dimension) {
				const key = dimension + ":" + tagId;
				const next = { ...ops };
				if (next[key]) delete next[key];
				else next[key] = defaultOp(tagId, dimension);
				setOps(next);
				setError("");
			}
			function stateClass(tagId, dimension) {
				const op = ops[dimension + ":" + tagId];
				if (op === "add") return " is-add";
				if (op === "remove") return " is-remove";
				const n = have(tagId, dimension);
				if (n === 0) return "";
				return n === picked.length ? " is-all" : " is-part";
			}
			async function apply() {
				const list = Object.entries(ops).map(([key, op]) => {
					const cut = key.indexOf(":");
					return { dimension: key.slice(0, cut), tagId: key.slice(cut + 1), op };
				});
				if (list.length === 0) return;
				setBusy(true);
				let result = null;
				try {
					result = await post("/tags", { action: "batch", ids: picked.map((item) => item.id), ops: list });
				} catch (err) {
					result = { ok: false, error: String((err && err.message) || err) };
				}
				setBusy(false);
				if (!result || result.ok === false) {
					setError((result && result.error) || "打标失败");
					return;
				}
				set({ tagPick: null, notice: "已给 " + result.changed + " 条打上/去掉标签（" + list.length + " 个标签操作，无变化 " + result.unchanged + " 条）" });
				await refresh();
			}

			function group(title, dimension) {
				const tags = all.filter((tag) => tag.dimension === dimension);
				if (tags.length === 0) return null;
				return h(
					"div",
					{ className: "dpc-block" },
					h("div", { className: "dpc-block-title" }, title),
					h(
						"div",
						{ className: "dpc-tag-list" },
						tags.map((tag) => {
							const n = have(tag.id, dimension);
							const op = ops[dimension + ":" + tag.id];
							/* 还没点过时也要说清「点一下会发生什么」—— 三态光靠实心/虚线是认不出来的 */
							const hint = op === "add" ? "　→ 应用后全部带上" : op === "remove" ? "　→ 应用后全部去掉" : n === picked.length && picked.length > 0 ? "　→ 点一下＝全部去掉" : "　→ 点一下＝给缺的补上";
							return h(
								"button",
								{
									key: tag.id,
									className: "dpc-tag" + stateClass(tag.id, dimension),
									title: (tag.gloss || tag.label) + "\n这批 " + picked.length + " 条里有 " + n + " 条已经带这个标签" + hint,
									onClick: () => toggle(tag.id, dimension),
								},
								op === "add" ? "＋ " : op === "remove" ? "− " : "",
								tag.label,
								h("span", { className: "dpc-tag-ratio" }, n + "/" + picked.length),
							);
						}),
					),
				);
			}

			const opCount = Object.keys(ops).length;
			return h(
				"div",
				{ className: "dpc-overlay", onClick: () => set({ tagPick: null }), role: "dialog", "aria-label": "批量打标" },
				h(
					"div",
					{ className: "dpc-modal", onClick: (event) => event.stopPropagation() },
					h(
						"div",
						{ className: "dpc-modal-head" },
						h("span", { className: "dpc-modal-title" }, "批量打标"),
						h("span", { className: "dpc-muted" }, "已选 " + picked.length + " 条"),
						h("span", { className: "dpc-grow" }),
						h("button", { className: "dpc-btn dpc-btn-sm dpc-btn-ghost", onClick: () => set({ tagPick: null }) }, "关闭"),
					),
					h(
						"div",
						{ className: "dpc-modal-body" },
						h(
							"div",
							{ className: "dpc-muted" },
							"点一下 = 排上「加」或「减」，再点一下撤回。只改你点过的标签，其它标签原样保留；应用后这批记为手标，AI 自动分类不再覆盖它们。",
						),
						group("做什么", "purpose"),
						group("用在哪里", "context"),
						error ? h("div", { className: "dpc-bad" }, error) : null,
						h(
							"div",
							{ className: "dpc-row" },
							h("button", { className: "dpc-btn dpc-btn-sm", onClick: apply, disabled: busy || opCount === 0 || picked.length === 0 }, busy ? "应用中…" : opCount === 0 ? "没改动可应用" : "应用 " + opCount + " 个标签操作"),
							h("button", { className: "dpc-btn dpc-btn-sm dpc-btn-ghost", onClick: () => { setOps({}); setError(""); }, disabled: opCount === 0 }, "全部撤回"),
						),
					),
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

			/* 体积行（插件与 Skill 共用）：先用全量快照，没有再退到懒算的 /size。
			   「量不到」必须说清原因 —— 官方包在 asar 里 / Skill 没有独立目录，都不是「0 B」。 */
			function sizeRow() {
				const snapshot = (state.data && state.data.sizes && state.data.sizes.byId) || {};
				const known = Number.isFinite(snapshot[open.id]) ? snapshot[open.id] : null;
				return h(
					"div",
					{ className: "dpc-row" },
					h("span", { className: "dpc-muted" }, "体积"),
					state.size
						? h("span", null, fmtBytes(state.size.bytes) + " · " + fmtNumber(state.size.files) + " 个文件" + (state.size.truncated ? "（超过 1.5 秒/2 万文件，只算到这里）" : ""))
						: /* 宿主的活答案优先于快照：它说"量不了"就是真的量不了（asar / 没目录） */
							state.sizeError
							? h("span", { className: "dpc-muted" }, state.sizeError)
							: known !== null
								? h("span", { title: "来自后台量好的全量快照" }, fmtBytes(known) + "（全量快照）")
								: h("span", { className: "dpc-muted" }, "正在量…"),
				);
			}

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
										statCell(item.kind === "skill" ? "创建" : "启用", item.kind === "skill" ? fmtTime(item.createdAt) : loadCell(item)),
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
												/* R14：别名目录（本机 `ghbackup` 里装的是 `dsh-github-backup`）。
												   同一个项目会以两个名字出现在列表里，不点明的话会让人以为"备份插件没在跑"。 */
												item.aliasOf
													? h("div", { className: "dpc-load-warn" }, "别名目录：这个目录里装的是 `" + item.aliasOf + "`（按包名找的是同名的那个目录）。同一个项目的两份安装 —— 删这份只是清理重复，不影响加载。")
													: null,
												/* R12：加载路径。这是「装了会不会跑」的判据，比 `enabled`（在不在 bundles）严格得多 */
												isDormant(item)
													? h("div", { className: "dpc-load-warn" }, "加载路径：❌ 不在 dsh.profile.bundles、没有 cordis 配置条目、也不在任何入口的依赖链上 —— 宿主不会加载它；删掉不影响当前加载（但别删你打算以后挂进 cordis.patch.yml 的包）。")
													: item.loadState === "config"
														? h("div", { className: "dpc-muted" }, "加载路径：配置条目 `" + (item.loadVia || "?") + "` 挂着（不在 bundles）—— 会加载。")
														: item.loadState === "transitive"
															? h("div", { className: "dpc-muted" }, "加载路径：随 " + (item.loadVia || "某个入口") + " 加载（它声明依赖这个包）—— 删了会连带弄坏。")
															: item.loadState === "bundle"
																? h("div", { className: "dpc-muted" }, "加载路径：在 bundles 里，直接启用。")
																: h("div", { className: "dpc-muted" }, "加载路径：宿主还没给出加载态（旧快照 / 还没重载）。"),
												/* 体积：先用全量快照（打开就有），没有再退到懒算的 /size */
												sizeRow(),
											)
										: h(
												"div",
												{ className: "dpc-block" },
												h("div", { className: "dpc-block-title" }, "位置与体积"),
												h(
													"div",
													{ className: "dpc-row" },
													h("span", { className: "dpc-muted" }, item.realDir ? "技能目录" : "没有目录（宿主半边还没重载到这一版）"),
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
												h("div", { className: "dpc-muted" }, "安装形态：Skill 目录 —— DSH 直接读这里的 SKILL.md，改完立即生效；发布推的是它的 staging 副本（见上面「副本同步」）"),
												sizeRow(),
											),
									/* R9：依赖关系 —— 「那个 354 MB 的二进制是谁带进来的」「删这个会弄坏谁」 */
									item.kind === "plugin"
										? h(
												"div",
												{ className: "dpc-block" },
												h("div", { className: "dpc-block-title" }, "依赖关系"),
												h(
													"div",
													{ className: "dpc-row" },
													h("span", { className: "dpc-muted" }, "直接声明"),
													h("span", null, item.dependency ? "写在 profile 的 package.json dependencies 里" : "不在 profile 的 dependencies 里（传递依赖 / 自动装的）"),
												),
												Number(item.dependentCount) > 0
													? h(
															"div",
															{ className: "dpc-muted" },
															"被 " +
																item.dependentCount +
																" 个包依赖：" +
																(item.dependents || []).join("、") +
																(Number(item.dependentCount) > (item.dependents || []).length ? " 等" : "") +
																" —— 删它会让这些包直接坏掉（体积合计里这部分不算可回收空间）",
														)
													: h(
															"div",
															{ className: "dpc-muted" },
															item.orphanHint
																? "没有任何包的 package.json 声明依赖它 —— 候选（很可能你早卸了用它的那个插件）。仍需 npm ls / pnpm why 确认后再动。"
																: "没有任何包声明依赖它，但它写在 profile 的 dependencies 里 —— 要删得同时改 profile 的 package.json。",
														),
												(Number(item.dependsOnCount) || 0) > 0
													? h(
															"div",
															{ className: "dpc-muted" },
															"它自己声明依赖 " +
																item.dependsOnCount +
																" 个包：" +
																(item.dependsOn || []).join("、") +
																(Number(item.dependsOnCount) > (item.dependsOn || []).length ? " 等" : "") +
																" —— 体积 Top 里那些 @dsh-ops/*-win32-x64 就是这一类（删了会连带弄坏它）",
														)
													: h("div", { className: "dpc-muted" }, "它没有声明任何运行时依赖（纯代码/单文件插件）"),
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
										/* R11：Skill 的两种"旧了"可以就地同步（live → staging）。
										   R20：反方向的「撤销」也在这里 —— 把 staging 还原到最近一份历史备份。 */
										const canSync = isStageStale(drift);
										/* 浮窗里的确认条**只显示只针对这一条**的计划：
										   从面板批量出的计划（可能 10 个）显示在任何单个浮窗里都会误导。 */
										const ownPlan =
											state.syncPlan && Array.isArray(state.syncPlan.items) && state.syncPlan.items.length === 1 && state.syncPlan.items[0] && state.syncPlan.items[0].id === item.id
												? state.syncPlan
												: null;
										const ownRestorePlan =
											state.restorePlan && Array.isArray(state.restorePlan.items) && state.restorePlan.items.length === 1 && state.restorePlan.items[0] && state.restorePlan.items[0].id === item.id
												? state.restorePlan
												: null;
										const latestBackup = drift.backups && drift.backups.latest ? drift.backups.latest : null;
										return h(
											"div",
											{ className: "dpc-block" },
											h("div", { className: "dpc-block-title" }, "副本同步"),
											h("div", { className: "dpc-muted" }, body),
											drift.backups && drift.backups.count
												? h(
														"div",
														{ className: "dpc-row" },
														h("span", { className: "dpc-muted" }, "历史备份 " + drift.backups.count + " 份 · 最近 " + (latestBackup ? latestBackup.stamp : "—") + (latestBackup ? "（" + fmtBytes(latestBackup.size) + "）" : "")),
														latestBackup
															? h("button", { className: "dpc-btn dpc-btn-sm dpc-btn-ghost", onClick: () => planStageRestore(item.id), disabled: state.restoreBusy || state.syncBusy }, state.restoreBusy ? "出计划…" : "还原到 " + latestBackup.stamp)
															: null,
													)
												: h("div", { className: "dpc-muted" }, "staging 里还没有历史备份（第一次同步时会把旧的那份存成 .bak-<时间戳>）"),
											canSync
												? h(
														"div",
														{ className: "dpc-row" },
														h("button", { className: "dpc-btn dpc-btn-sm", onClick: () => planStageSync([item.id]), disabled: state.syncBusy }, "同步这一份 → staging"),
														h("span", { className: "dpc-muted" }, "单向 live → staging；覆盖前把 staging 那份备份成 .bak-<时间戳>"),
													)
												: null,
											ownPlan ? h(SyncConfirm, { compact: true, plan: ownPlan, busy: state.syncBusy, onApply: applyStageSync, onCancel: () => set({ syncPlan: null }) }) : null,
											ownRestorePlan ? h(RestoreConfirm, { plan: ownRestorePlan, busy: state.restoreBusy, onApply: applyStageRestore, onCancel: () => set({ restorePlan: null }) }) : null,
										);
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

		/* ── R11：体检结论卡（面板上能点开的失败项）──
		   以前体检跑完只有一行提示条 + 一个报告路径：失败时得自己打开 .cache/ship-*.md 才知道哪条红了。
		   这里把 `job.result.checks[].failures` 直接摊在面板上 —— 报告仍在，但不用先去找它。 */
		function PreflightCard(props) {
			const result = props.result;
			const [showAll, setShowAll] = useState(false);
			if (!result) return null;
			const checks = Array.isArray(result.checks) ? result.checks : [];
			const failedChecks = checks.filter((check) => check.ok === false);
			const failures = [];
			for (const check of failedChecks) {
				for (const text of check.failures || []) failures.push({ where: check.label || check.id, text: String(text) });
			}
			/* 默认只摊 6 条：一次红 40 条时全铺开会把整个面板推下去，反而找不到结论 */
			const visible = showAll ? failures : failures.slice(0, 6);
			const git = result.git || null;
			const version = result.version || null;
			return h(
				"div",
				{ className: "dpc-preflight" + (result.ok ? " is-ok" : " is-bad") },
				h(
					"div",
					{ className: "dpc-preflight-head" },
					h("span", { className: "dpc-preflight-mark" }, result.ok ? "✓" : "✗"),
					h("span", { className: "dpc-preflight-title" }, "上次自检：" + (result.ok ? "全绿" : failedChecks.length + " 项失败")),
					h("span", { className: "dpc-muted" }, "｜" + Math.round((result.durationMs || 0) / 1000) + " 秒" + (result.at ? " · " + fmtDateTime(result.at) : "")),
					version ? h("span", { className: version.ok ? "dpc-muted" : "dpc-bad" }, "｜版本 " + version.version + " ↔ " + version.build + (version.ok ? "" : "（不一致）")) : null,
					git && git.ok && !git.skipped
						? h(
								"span",
								{ className: "dpc-muted" },
								"｜git " +
									(git.headShort || "") +
									(git.dirty > 0 ? " · " + git.dirty + " 个未提交" : " · 干净") +
									(git.pushed === false ? " · 未推送" : git.pushed === true ? " · 已推送" : ""),
							)
						: null,
				),
				h(
					"div",
					{ className: "dpc-preflight-checks" },
					checks.map((check) =>
						h(
							"span",
							{
								key: check.id,
								className: "dpc-preflight-check" + (check.ok === false ? " is-bad" : check.informational ? " is-info" : " is-ok"),
								title: (check.failures || []).join("\n") || (check.informational ? "Skill 的 staging（发布源）与 DSH 实际加载的那份是否一致" : ""),
							},
							(check.ok === false ? "✗ " : check.informational ? "ℹ " : "✓ ") +
								(check.label || check.id) +
								" " +
								(check.informational
									? (Number(check.pairs) || 0) + " 对" + (Array.isArray(check.stale) && check.stale.length ? " / " + check.stale.length + " 旧" : " / 一致")
									: (check.passed ?? "?") + " 通过" + (check.failed ? " · " + check.failed + " 失败" : "") + (check.skipped ? " · " + check.skipped + " 跳过" : "")) +
								" · " +
								Math.round((check.durationMs || 0) / 1000) +
								"s",
						),
					),
				),
				failures.length > 0
					? h(
							"div",
							{ className: "dpc-preflight-fails" },
							visible.map((failure, index) =>
								h("div", { key: index, className: "dpc-preflight-fail" }, h("span", { className: "dpc-preflight-where" }, failure.where), h("span", { className: "dpc-mono" }, failure.text)),
							),
							failures.length > visible.length
								? h("button", { className: "dpc-btn dpc-btn-sm dpc-btn-ghost", onClick: () => setShowAll(true) }, "还有 " + (failures.length - visible.length) + " 条，全部展开")
								: null,
						)
					: null,
				h(
					"div",
					{ className: "dpc-row" },
					result.reportPath
						? h(
								"button",
								{
									className: "dpc-btn dpc-btn-sm dpc-btn-ghost",
									onClick: () => set({ notice: copyText(result.reportPath) ? "已复制报告路径：" + result.reportPath : "复制失败：渲染进程不让写剪贴板" }),
								},
								"复制报告路径",
							)
						: null,
					h("button", { className: "dpc-btn dpc-btn-sm dpc-btn-ghost", onClick: props.onRerun, disabled: props.busy }, props.busy ? "正在跑…" : "重跑"),
					result.reportPath ? h("span", { className: "dpc-muted dpc-mono" }, result.reportPath) : null,
				),
			);
		}

		/* ── R11：「同步 staging」的二次确认条 ──
		   写盘前必须让人看见「会覆盖哪些文件、往哪个方向、备份落在哪」。
		   面板上（全局批次）与 Skill 浮窗里（单个）共用这一个组件。 */
		function SyncConfirm(props) {
			const plan = props.plan;
			if (!plan) return null;
			const items = Array.isArray(plan.items) ? plan.items : [];
			const names = items.map((item) => item.name || item.id);
			const visible = names.slice(0, 8);
			return h(
				"div",
				{ className: "dpc-sync-confirm" + (props.compact ? " is-compact" : ""), role: "group", "aria-label": "同步 staging 确认" },
				h(
					"div",
					{ className: "dpc-sync-title" },
					"将把 " + items.length + " 个 Skill 的 SKILL.md 复制到 staging（" + (plan.direction || "live → staging") + "）",
				),
				h("div", { className: "dpc-muted" }, "覆盖前把 staging 那份备份成 SKILL.md.bak-<时间戳>，回滚就是改回来；不会动 DSH 正在加载的那份。"),
				h(
					"div",
					{ className: "dpc-sync-names" },
					visible.map((name) => h("code", { key: name, className: "dpc-sync-name" }, name)),
					names.length > visible.length ? h("span", { className: "dpc-muted" }, "还有 " + (names.length - visible.length) + " 个") : null,
				),
				h(
					"div",
					{ className: "dpc-row" },
					h("button", { className: "dpc-btn dpc-btn-sm", onClick: props.onApply, disabled: props.busy }, props.busy ? "同步中…" : "确认同步（" + items.length + " 个）"),
					h("button", { className: "dpc-btn dpc-btn-sm dpc-btn-ghost", onClick: props.onCancel, disabled: props.busy }, "取消"),
				),
			);
		}

		/* ── R20：「还原 staging 备份」的二次确认条 ──
		   与 SyncConfirm 对称：写盘前让人看见「覆盖哪些、覆盖成哪份、备份落在哪」。
		   ★ 只出现在 Skill 浮窗里（一次一个），因为这个动作是"撤销某一份"，不是批量发布。 */
		function RestoreConfirm(props) {
			const plan = props.plan;
			if (!plan) return null;
			const items = Array.isArray(plan.items) ? plan.items : [];
			return h(
				"div",
				{ className: "dpc-sync-confirm is-compact", role: "group", "aria-label": "还原 staging 确认" },
				h("div", { className: "dpc-sync-title" }, "将把 " + items.length + " 个 Skill 的 staging 覆盖成备份版本（" + (plan.direction || "backup → staging") + "）"),
				h("div", { className: "dpc-muted" }, "只动 staging（上传用的那份），不动 DSH 正在加载的 SKILL.md；覆盖前会把 staging 当前这份另存成 SKILL.md.bak-<时间戳>，所以还原本身也能再撤销。"),
				h(
					"div",
					{ className: "dpc-sync-names" },
					items.slice(0, 5).map((item) => h("code", { key: item.id, className: "dpc-sync-name" }, item.name + " ← " + (item.backupStamp || item.backup))),
				),
				h(
					"div",
					{ className: "dpc-row" },
					h("button", { className: "dpc-btn dpc-btn-sm", onClick: props.onApply, disabled: props.busy }, props.busy ? "还原中…" : "确认还原（" + items.length + " 个）"),
					h("button", { className: "dpc-btn dpc-btn-sm dpc-btn-ghost", onClick: props.onCancel, disabled: props.busy }, "取消"),
				),
			);
		}

		/* ── R14：「不会被加载」的处置清单 ──
		   这一块回答的是**动手怎么做**，不是"有没有问题"：候选按弱连通分量分组（删父留子会留孤儿），
		   每组标出可回收体积与分类（实体 / 被 profile 钉住 / 链接 / 同项目第二份）。
		   ★ 一个删除动作都不提供：清单里的命令要人自己复制去跑。 */
		/* ── R16：删除预演的结果块 ──
		   回答的是「真删了会不会有东西指空」，不是「该不该删」。
		   ★ 三条风险各占一行，只在非空时出现；「安全」也必须把依据写出来（没入口悬空 / 没包声明它们），
		     否则一个绿字什么都不解释，等于让人闭眼删。 */
		function SimBlock(props) {
			const sim = props.sim;
			if (!sim) return null;
			const safe = sim.verdict === "safe";
			const names = (list, limit) => (list.length === 0 ? "无" : list.slice(0, limit).join("、") + (list.length > limit ? " 等 " + list.length + " 条" : ""));
			const counts = (value) => "bundle " + (value.bundle || 0) + " / config " + (value.config || 0) + " / 随依赖 " + (value.transitive || 0) + " / 不加载 " + (value.dormant || 0);
			const rows = [];
			rows.push(h("div", { key: "break", className: "dpc-sim-row" + (sim.breaking.length > 0 ? " dpc-bad" : "") }, "现在会被加载（本来就不该删）：" + names(sim.breaking.map((item) => item.name + "（" + item.state + "）"), 6)));
			rows.push(h("div", { key: "entries", className: "dpc-sim-row" + (sim.brokenEntries.length > 0 ? " dpc-bad" : "") }, "删完会指空的入口：" + names(sim.brokenEntries.map((item) => item.name + "（" + item.why + "）"), 6)));
			rows.push(h("div", { key: "dangling", className: "dpc-sim-row" + (sim.dangling.length > 0 ? " dpc-bad" : "") }, "仍声明它们的包：" + names(sim.dangling.map((item) => item.from + " → " + item.dep), 6)));
			rows.push(
				h(
					"div",
					{ key: "demoted", className: "dpc-sim-row" + (sim.demoted.length > 0 ? " dpc-sim-warn" : "") },
					"删完会掉回「不加载」：" + names(sim.demoted.map((item) => item.name), 6) + (sim.demoted.length > 0 ? "（还得再清一轮）" : ""),
				),
			);
			rows.push(h("div", { key: "counts", className: "dpc-sim-row dpc-muted" }, "加载态 " + counts(sim.before.counts) + " → " + counts(sim.after.counts)));
			return h(
				"div",
				{ className: "dpc-sim" + (safe ? " is-ok" : " is-bad") },
				h(
					"div",
					{ className: "dpc-sim-head" },
					h("span", { className: "dpc-sim-mark" }, safe ? "✓" : "!"),
					h("span", { className: "dpc-sim-title" }, "删除预演（只算不删）"),
					h("span", { className: "dpc-muted" }, "｜摘掉 " + (sim.remove || []).length + " 个包"),
					h("span", { className: "dpc-sim-verdict" }, safe ? "安全" : "有风险"),
					h("span", { className: "dpc-sim-ok dpc-muted" }, "｜可回收 " + fmtBytes((sim.bytes && sim.bytes.reclaimBytes) || 0)),
					(sim.unknown || []).length > 0 ? h("span", { className: "dpc-muted" }, "｜" + sim.unknown.length + " 个不在已装清单（拼错或已删）") : null,
				),
				rows,
				(sim.bytes && (sim.bytes.whyZero || []).length > 0)
					? h("div", { className: "dpc-sim-row dpc-muted" }, "删了省 0 B 的：" + names(sim.bytes.whyZero.map((item) => item.dirName), 6) + "（链接 / 被 profile 钉住 —— 删了不省或会被装回来）")
					: null,
				h("div", { className: "dpc-sim-foot dpc-muted" }, "判定口径：声明层面（运行时按路径 `require()` 看不见）；「仍声明它们的包」含 optional / peer，那一类可能只是软依赖。本操作不动盘、不删任何目录。"),
			);
		}

		function UninstallCard(props) {
			const plan = props.plan;
			if (!plan) return null;
			const dormant = plan.dormant || {};
			const groups = Array.isArray(plan.groups) ? plan.groups : [];
			const KIND_LABEL = { entity: "实体", pinned: "被钉住", "link-workspace": "链接→工作区", "link-other": "链接→外部", duplicate: "同项目第二份", "alias-only": "别名目录" };
			return h(
				"div",
				{ className: "dpc-preflight dpc-uninstall" },
				h(
					"div",
					{ className: "dpc-preflight-head" },
					h("span", { className: "dpc-preflight-mark" }, "⌫"),
					h("span", { className: "dpc-preflight-title" }, "处置清单（只生成、不执行）"),
					h("span", { className: "dpc-muted" }, "｜候选目录 " + (dormant.dirCandidates || 0) + " 个 / " + (dormant.groups || 0) + " 组"),
					h("span", { className: "dpc-sum" }, "可回收 " + fmtBytes(dormant.reclaimBytes || 0)),
					dormant.linkBytes > 0 ? h("span", { className: "dpc-muted" }, "｜另有 " + fmtBytes(dormant.linkBytes) + " 在链接目标里（删链接不省）") : null,
					plan.at ? h("span", { className: "dpc-muted" }, "｜" + fmtDateTime(plan.at)) : null,
				),
				h(
					"div",
					{ className: "dpc-uninstall-groups" },
					groups.map((group) =>
						h(
							"div",
							{ key: group.key, className: "dpc-uninstall-group" },
							h(
								"div",
								{ className: "dpc-uninstall-group-head" },
								h("span", { className: "dpc-uninstall-name" }, group.label),
								h("span", { className: "dpc-muted" }, "可回收 " + fmtBytes(group.reclaimBytes || 0)),
								(group.kinds || []).map((kind) => h("span", { key: kind, className: "dpc-uninstall-kind" }, KIND_LABEL[kind] || kind)),
								group.pinnedCount > 0 ? h("span", { className: "dpc-bad" }, group.duplicate ? "先摘别名依赖键" : "要先摘 profile 依赖") : null,
								group.linkCount > 0 ? h("span", { className: "dpc-muted" }, group.linkCount + " 个链接（删了省 0 B）") : null,
							),
							/* 只摊前 4 个名字：一组 20 个时全铺开会把面板推下去 */
							h(
								"div",
								{ className: "dpc-uninstall-members dpc-mono" },
								(group.members || []).slice(0, 4).map((member) => (member.link ? "→ " : "") + member.dirName).join("、") +
									((group.members || []).length > 4 ? " 等 " + (group.members || []).length + " 个" : ""),
							),
						),
					),
				),
				h(
					"div",
					{ className: "dpc-uninstall-steps" },
					"判定口径：按「弱连通分量」分组（组内互相声明依赖，单删一个会留孤儿）；被 `profile/package.json` 钉住的，只删目录下次 `pnpm install` 会装回来；只处置 `node_modules` 顶层目录；运行时按路径 `require()` 的动态加载看不见。",
				),
				/* R16：预演 —— 删之前先问一句「会不会有东西指空」 */
				props.sim ? h(SimBlock, { sim: props.sim }) : null,
				h(
					"div",
					{ className: "dpc-row" },
					h("button", { className: "dpc-btn dpc-btn-sm" + (props.confirm ? " is-on" : ""), onClick: props.onWrite, disabled: props.busy }, props.busy ? "写入中…" : props.confirm ? "确认写入（不会删任何目录）" : "写入 reports/"),
					props.confirm ? h("button", { className: "dpc-btn dpc-btn-sm dpc-btn-ghost", onClick: props.onCancelConfirm, disabled: props.busy }, "取消") : null,
					h("button", { className: "dpc-btn dpc-btn-sm dpc-btn-ghost", onClick: props.onSimulate, disabled: props.busy || props.simBusy, title: "在内存里把这些包从依赖图上摘掉、重算加载态：只算，不动盘、不删任何目录" }, props.simBusy ? "预演中…" : "预演（不动盘）"),
					h("button", { className: "dpc-btn dpc-btn-sm dpc-btn-ghost", onClick: props.onRerun, disabled: props.busy }, "重新算"),
					plan.savedTo ? h("span", { className: "dpc-muted dpc-mono" }, plan.savedTo) : null,
				),
			);
		}

		/* ── R22：配置层（声明层）浮层 ──
		   回答的是「这些条目从哪来、谁关掉了、谁指向找不到的东西」—— 与「装了会不会加载」是两件事：
		   后者看 `loadState`（bundles + 配置条目 + 依赖链），前者只看**两份组合文件的顶层条目**。
		   ★ 三条边界直接印在脚注里，不许省略：
		     ① 不展开 bundle 自带的 patch 层（`disabled: true` 可能被它重新打开）；
		     ② `!!js` 表达式不求值，只给原文；
		     ③ 组合条目「静态查不到」≠ 一定坏（运行期注入的虚拟模块看不见）。 */
		function CompositionModal(props) {
			const composition = props.composition;
			if (!composition) return null;
			const counts = composition.counts || {};
			const kind = counts.byKind || {};
			const state = counts.byState || {};
			const bundles = composition.bundles || {};
			const list = (value) => (Array.isArray(value) ? value : []);
			const shortFile = (file) => String(file || "").split(/[\\/]/).pop();
			const verdictText = composition.verdict === "bad" ? "bundles 有缺口" : composition.verdict === "warn" ? "有静态查不到 / 无法判定" : "没有缺口";
			/* R24：只有「profile 已装」或「官方 asar」的包才有卡片可跳；静态查不到 / 按路径 / 分组都没有。
			   交叉引用：关掉 / 条件启用的条目，额外标「在 bundles / 不在 bundles」。 */
			const bundleSet = new Set(list(composition.bundleNames).map(String));
			const canJump = (item) => Boolean(props.onJump && item && item.package) && (item.resolution === "present" || item.resolution === "asar");
			const RES_LABEL = { present: "profile", asar: "asar", missing: "查不到", unjudged: "无法判定" };
			const bundleFlag = (item) => {
				if (!item || !item.package || bundleSet.size === 0) return null;
				const inside = bundleSet.has(item.package);
				return h("span", { className: "dpc-conf-flag " + (inside ? "is-in" : "is-out") }, inside ? "在 bundles" : "不在 bundles");
			};
			const row = (item, extra, withBundle = false) => {
				const jump = canJump(item);
				return h(
					"div",
					{
						key: item.id + "|" + item.file + "|" + item.line + "|" + (item.name || ""),
						className: "dpc-conf-row" + (jump ? " is-link" : ""),
						title: jump ? "跳到这张卡片（会清掉筛选与搜索，只留这次定位）" : undefined,
						role: jump ? "button" : undefined,
						tabIndex: jump ? 0 : undefined,
						onClick: jump ? () => props.onJump(item.package) : undefined,
						onKeyDown: jump
							? (event) => {
									if (event.key === "Enter" || event.key === " ") {
										event.preventDefault();
										props.onJump(item.package);
									}
								}
							: undefined,
					},
					h("code", { className: "dpc-conf-name" }, item.name || "（无 name）"),
					item.id ? h("span", { className: "dpc-conf-id dpc-muted" }, item.id) : null,
					h("span", { className: "dpc-conf-file dpc-mono" }, shortFile(item.file) + ":" + item.line),
					RES_LABEL[item.resolution] ? h("span", { className: "dpc-conf-res is-" + item.resolution }, RES_LABEL[item.resolution]) : null,
					withBundle ? bundleFlag(item) : null,
					extra || null,
					jump ? h("span", { className: "dpc-conf-jump dpc-muted" }, "→ 卡片") : null,
				);
			};
			const block = (key, title, tone, children, note) =>
				h(
					"div",
					{ key, className: "dpc-conf-block" + (tone ? " is-" + tone : "") },
					h("div", { className: "dpc-conf-block-head" }, title),
					children,
					note ? h("div", { className: "dpc-conf-note dpc-muted" }, note) : null,
				);
			const missing = list(composition.missing);
			const conditional = list(composition.conditional);
			const disabled = list(composition.disabled);
			const bundlesMissing = list(composition.bundlesMissing);
			return h(
				"div",
				{ className: "dpc-overlay", onClick: props.onClose, role: "dialog", "aria-label": "配置层" },
				h(
					"div",
					{ className: "dpc-modal dpc-modal-wide", onClick: (event) => event.stopPropagation() },
					h(
						"div",
						{ className: "dpc-modal-head" },
						h("span", { className: "dpc-modal-title" }, "配置层（声明层）"),
						h("span", { className: composition.verdict === "ok" ? "dpc-muted" : "dpc-bad" }, verdictText),
						h("button", { className: "dpc-btn dpc-btn-sm dpc-btn-ghost", onClick: props.onClose }, "关闭"),
					),
					h(
						"div",
						{ className: "dpc-modal-body" },
						h(
							"div",
							{ className: "dpc-conf-sum" },
							h(
								"div",
								null,
								"两份组合文件：" +
									list(composition.files)
										.map((file) => shortFile(file.file) + " " + file.entries + " 条")
										.join(" + ") +
									"（顶层条目；按 id 合并后生效 " +
									(counts.effective || 0) +
									" 条）",
							),
							h(
								"div",
								null,
								"条目类型：包 " +
									(kind.package || 0) +
									" / 子路径 " +
									(kind.subpath || 0) +
									" / 按路径 " +
									(kind.file || 0) +
									" / 分组 " +
									(kind.group || 0) +
									" / 只按 id 覆盖 " +
									(kind["id-only"] || 0) +
									"；被 patch 覆盖 " +
									(counts.patched || 0) +
									" 条",
							),
							h(
								"div",
								null,
								"包解析：已装 " +
									((composition.packages && composition.packages.present) || 0) +
									" · 官方 asar " +
									((composition.packages && composition.packages.asar) || 0) +
									" · 静态查不到 " +
									((composition.packages && composition.packages.missing) || 0) +
									(composition.asarReadable ? "" : " · asar 读不到：" + ((composition.packages && composition.packages.unjudged) || 0) + " 条无法判定"),
							),
							h(
								"div",
								null,
								"声明状态：关掉 " +
									(state.off || 0) +
									" · 条件启用 " +
									(state.conditional || 0) +
									"（不求值） · bundles " +
									(bundles.declared || 0) +
									" → 已装 " +
									(bundles.present || 0) +
									" + asar " +
									(bundles.asar || 0) +
									" + " +
									(bundles.unjudged > 0 ? "无法判定 " + bundles.unjudged : "缺 " + (bundles.missing || 0)),
							),
						),
						bundlesMissing.length > 0
							? block(
									"bundles",
									"真的缺（bundles 里点名了，profile 与 asar 都没有）—— " + (bundles.missing || bundlesMissing.length) + " 个",
									"bad",
									bundlesMissing.map((item) => h("div", { key: item.name, className: "dpc-conf-row" }, h("code", { className: "dpc-conf-name" }, item.name), h("span", { className: "dpc-bad" }, "宿主启用它时会失败"))),
									"这一档才是「宿主起不来」的那类；下面的「静态查不到」不是。",
								)
							: null,
						missing.length > 0
							? block(
									"missing",
									"静态查不到的条目 —— " + ((composition.counts && composition.counts.byResolution && composition.counts.byResolution.missing) || missing.length) + " 条",
									"warn",
									missing.map((item) => row(item, h("span", { className: "dpc-muted" }, "可能由宿主 / 桌面端在运行期注入"), true)),
									"profile/node_modules 与官方 asar 里都没有这个包名。运行期注入的虚拟模块本工具看不见 —— 本机 `dsh-plugin-desktop` 就是这种。",
								)
							: null,
						!composition.asarReadable || list(composition.unjudged).length > 0
							? block(
									"unjudged",
									"无法判定（asar 读不到，不算「缺」）—— " + list(composition.unjudged).length + " 条",
									"info",
									h("div", { className: "dpc-conf-note" }, "这个进程没有读到官方 asar（纯 node / 探针环境），asar 内的包名无法核对。在宿主里打开面板时会有结论。"),
								)
							: null,
						conditional.length > 0
							? block(
									"conditional",
									"条件启用（`!!js` 表达式，不求值）—— " + (state.conditional || conditional.length) + " 条",
									"info",
									conditional.map((item) => row(item, item.disabledRaw ? h("code", { className: "dpc-conf-expr" }, item.disabledRaw) : null, true)),
									"表达式是任意 JS，本工具不求值 —— 想知道这条现在开没开，看运行中的 MCP/cordis 配置或直接问宿主。",
								)
							: null,
						disabled.length > 0
							? block(
									"disabled",
									"关掉的条目（`disabled: true`）—— " + (state.off || disabled.length) + " 条",
									"",
									disabled.map((item) => row(item, null, true)),
									"这是**声明**：bundle 自带的 patch 层可能把它们重新打开（本机 `tool-bash` / `tool-pwsh` 就写着 disabled，但工具确实在跑）。别照这张表判断「某个工具没启用」。",
								)
							: null,
						h(
							"div",
							{ className: "dpc-conf-foot dpc-muted" },
							(composition.at ? "算于 " + fmtDateTime(composition.at) + "（60 秒缓存；改完配置点头部「重新扫描」） · " : "") +
								"判据：只读**声明**（两份组合文件的顶层条目 + `dsh.profile.bundles` + `profile/node_modules` + asar 包名）。不展开 bundle 自带的 patch 层、`!!js` 表达式不求值；按路径挂载只检查文件在不在。清单最多列 40 条（完整清单：工具 catalog_composition view=entries）。",
						),
					),
				),
			);
		}

		/* ── R17：变化条（自上次目录快照以来变了什么）；R19 起：确认过的窗口优先 ──
		   只在**真有变化**时出现：第一条快照（first）与 0 处变化都不占版面 ——
		   "还没有历史"和"没变化"是两件事，界面上都不能画成一条空横幅。
		   ★ R19：标记过「已看过」之后显示的是**自那次确认以来**的窗口（sinceAck）；
		     没标记过才退回"自上次快照以来"。两个窗口语义不同，不能混着写。 */
		function ChangesBar(props) {
			const [acking, setAcking] = useState(false);
			const acked = props.sinceAck && !props.sinceAck.first ? props.sinceAck : null;
			const changes = acked || props.changes;
			if (!changes || changes.first) return null;
			const counts = changes.counts || {};
			if (!(Number(counts.total) > 0)) return null;
			/* R23：配置层（声明层）的变化不是"某个条目"，单独压一句话 —— 改 disabled / 加 bundle 时
			   目录条目一个都没变，这一行是它第一次能被看见的地方。 */
			const compositionText = (item) => {
				const labels = { entries: "生效条目", on: "启用", off: "关掉", conditional: "条件启用", patched: "被 patch 覆盖", bundles: "bundles", files: "组合文件" };
				const changed = Array.isArray(item.changed) ? item.changed : [];
				const bits = changed.map((change) => (labels[change.field] || change.field) + " " + change.from + " → " + change.to);
				/* R25：下钻 —— 计数说不清「换了谁」，这里补上具体 id（最多各 3 条，完整名单在快照里） */
				const kindLabels = { on: "启用", off: "关掉", expression: "条件" };
				for (const row of (Array.isArray(item.stateChanged) ? item.stateChanged : []).slice(0, 3)) bits.push((row.name || row.id) + " " + (kindLabels[row.from] || row.from) + "→" + (kindLabels[row.to] || row.to));
				for (const name of (Array.isArray(item.bundlesAdded) ? item.bundlesAdded : []).slice(0, 2)) bits.push("bundles +" + name);
				for (const name of (Array.isArray(item.bundlesRemoved) ? item.bundlesRemoved : []).slice(0, 2)) bits.push("bundles −" + name);
				for (const row of (Array.isArray(item.declsAdded) ? item.declsAdded : []).slice(0, 2)) bits.push("+ " + (row.name || row.id));
				for (const row of (Array.isArray(item.declsRemoved) ? item.declsRemoved : []).slice(0, 2)) bits.push("− " + (row.name || row.id));
				if (bits.length === 0) return "条目变了（生效 " + (Number(item.entries) || 0) + "）";
				return bits.join("，");
			};
			const groups = [
				["added", "新增", changes.added, (item) => "+ " + item.name + (item.version ? " " + item.version : "")],
				["removed", "消失", changes.removed, (item) => "− " + item.name],
				["version", "升版", changes.versionChanged, (item) => item.name + " " + (item.from || "?") + " → " + (item.to || "?")],
				["source", "来源变", changes.sourceChanged, (item) => item.name + " " + (item.from || "?") + " → " + (item.to || "?")],
				["loadState", "加载态变", changes.loadStateChanged, (item) => item.name + " " + (item.from || "未判") + " → " + (item.to || "未判")],
				["edited", "被编辑", changes.edited, (item) => (item.reason === "content" ? item.name + " 正文已改（" + (item.from || "?") + " → " + (item.to || "?") + "）" : item.name + "（" + item.from + " → " + item.to + "）")],
				["composition", "配置层", changes.compositionChanged, compositionText],
			].filter(([, , list]) => Array.isArray(list) && list.length > 0);
			/* R21：更早窗口的时间线。只写"谁变了"，不铺开哈希 —— 时间线是索引，明细在当前窗口里 */
			const timeline = props.timeline && Array.isArray(props.timeline.items) ? props.timeline.items : [];
			const timelineText = (row) => {
				const buckets = [
					["新增", row.added, "added"],
					["消失", row.removed, "removed"],
					["升版", row.versionChanged, "version"],
					["来源变", row.sourceChanged, "source"],
					["加载态变", row.loadStateChanged, "loadState"],
					["被编辑", row.edited, "edited"],
				];
				const bits = [];
				for (const [label, list, kind] of buckets) {
					const count = Number((row.counts || {})[kind]) || 0;
					if (count === 0) continue;
					const names = (Array.isArray(list) ? list : []).map((item) => (kind === "edited" && item.reason === "content" ? item.name + " 正文已改" : item.name || item.id)).filter(Boolean);
					bits.push(label + " " + count + (names.length > 0 ? "（" + names.join("、") + (names.length < count ? "…" : "") + "）" : ""));
				}
				/* R23：配置层的变化没有"名字"可列，直接给计数差 */
				const compositions = Array.isArray(row.compositionChanged) ? row.compositionChanged : [];
				if (compositions.length > 0) bits.push("配置层 " + compositions.length + "（" + compositionText(compositions[0]) + "）");
				return bits.join("；");
			};
			/* 把当前目录冻结成基线（服务端要求 confirm:true；只写数据目录里的 history-ack.json） */
			async function markAcked() {
				if (acking) return;
				setAcking(true);
				try {
					const result = await api("/ack", { method: "POST", body: JSON.stringify({ confirm: true }) });
					if (result && result.ok) set({ notice: "已标记看过（基线 " + fmtDateTime(result.ackAt) + "，共 " + (result.entries || 0) + " 条）—— 之后的变化会单独计数" });
					else set({ notice: "标记失败：" + String((result && result.error) || "未知错误") });
				} catch (error) {
					set({ notice: "标记失败：" + String((error && error.message) || error) });
				}
				setAcking(false);
				await refresh();
			}
			return h(
				"div",
				{ className: "dpc-changes" + (props.open ? " is-open" : "") },
				h(
					"div",
					{ className: "dpc-changes-headrow" },
					h(
						"button",
						{
							className: "dpc-changes-head",
							onClick: props.onToggle,
							title: "自上次目录快照以来：新增 / 消失 / 升版 / 来源变 / 加载态变 / 被编辑 / 配置层。点一下摊开明细；判据是声明层面（Skill 比正文内容哈希，改一个字也看得见；配置层比 disabled / bundles / 条目声明）",
						},
						h("span", { className: "dpc-changes-mark" }, props.open ? "▾" : "▸"),
						h("span", { className: "dpc-changes-title" }, acked ? "自你 " + fmtDateTime(changes.ackAt || changes.baselineAt) + " 确认以来" : "自 " + fmtDateTime(changes.baselineAt) + " 以来"),
						h("span", { className: "dpc-changes-count" }, (counts.total || 0) + " 处变化"),
						groups.map(([key, label, list]) => h("span", { key: key, className: "dpc-changes-chip" }, label + " " + list.length + (Number(counts[key]) > list.length ? "+" : ""))),
					),
					h("button", { className: "dpc-changes-ack", onClick: markAcked, disabled: acking, title: "把当前目录冻结成基线：之后的变化单独计数。只写数据目录里的 history-ack.json，不碰任何插件与 Skill 文件" }, acking ? "标记中…" : "标记已看过"),
				),
				/* R21：回看更早的窗口 —— history.json 里一直存着，此前只有最近一个窗口能看见 */
				timeline.length > 0
					? h(
							"div",
							{ className: "dpc-changes-history" },
							h(
								"button",
								{
									className: "dpc-changes-history-toggle" + (props.historyOpen ? " is-open" : ""),
									onClick: props.onToggleHistory,
									title: "回看更早的目录变化窗口：每行是两个相邻快照之间的新增 / 消失 / 升版 / 来源变 / 加载态变 / 被编辑 / 配置层（正文改了会标出来）。最多保留 20 条快照，基线本身不算一个窗口。",
								},
								(props.historyOpen ? "▾ " : "▸ ") + "历史（" + timeline.length + " 个窗口 / 共 " + (Number(props.timeline.total) || timeline.length + 1) + " 条快照）",
							),
							props.historyOpen
								? h(
										"div",
										{ className: "dpc-changes-list" },
										timeline.slice(0, 8).map((row) =>
											h(
												"div",
												{ key: row.at, className: "dpc-changes-row" },
												h("span", { className: "dpc-changes-tag" }, fmtDateTime(row.at)),
												h("span", { className: "dpc-mono" }, timelineText(row) || "0 处"),
											),
										),
										timeline.length > 8 ? h("div", { className: "dpc-changes-foot dpc-muted" }, "只列最近 8 个窗口（共 " + timeline.length + " 个）") : null,
									)
								: null,
						)
					: null,
				props.open
					? h(
							"div",
							{ className: "dpc-changes-list" },
							groups.map(([key, label, list, text]) =>
								h(
									"div",
									{ key: key, className: "dpc-changes-row" },
									h("span", { className: "dpc-changes-tag" }, label),
									h("span", { className: "dpc-mono" }, list.map(text).join("、") + (Number(counts[key]) > list.length ? "　等 " + counts[key] + " 条" : "")),
								),
							),
							h("div", { className: "dpc-changes-foot dpc-muted" }, "判据：插件比版本 / 来源 / 加载态，Skill 比来源 / 有没有描述 / **正文内容哈希**（改一个字也看得见），配置层比**声明签名**（disabled 翻转 / bundles 增删 / 条目增删）；工具数、体积、git 脏文件不算变化。只在指纹变化时追加一条，最多留 20 条；更早的窗口点「历史」回看。这次记于 " + (changes.at ? fmtDateTime(changes.at) : "?") + "。点「标记已看过」可把确认窗口清零。"),
						)
					: null,
			);
		}

		/* ── 面板 ── */

		function Panel() {
			const state = useStore();
			const data = state.data;
			const items = (data && data.entries) || [];
			const all = (data && data.tags && data.tags.all) || [];
			const hostCore = data && data.hostCore;
			/* 体积快照（后台全量量过一次；没有就是空表 —— 卡片不显示体积，排序把没量的排后面） */
			const sizeMap = (data && data.sizes && data.sizes.byId) || {};
			const sizesAt = (data && data.sizes && data.sizes.at) || 0;
			/* 超过 1.5 秒 / 2 万文件预算的条目：数字是"至少这么大"，卡片上要标出来 */
			const sizeTruncated = (data && data.sizes && data.sizes.truncated) || [];

			/* R24：配置层浮层里点「profile 已装 / 官方 asar」条目 → 定位到卡片。
			   ★ 必须清掉筛选：当前的来源 / 加载态 / 用法 / 标签筛选可能正好把目标卡藏起来，
			     只 set query 会得到一屏空白，看起来像"跳转坏了"。 */
			function jumpToCard(name) {
				if (!name) return;
				set({ query: name, page: 1, kind: "all", source: "any", usage: "any", orphanOnly: false, dormantOnly: false, tagFilter: [], showComposition: false });
			}

			/* R15：标签 id → ? 的索引。筛选要按维度分组判定，不能只看 id 在不在。 */
			const tagMap = useMemo(() => new Map(all.map((tag) => [tag.id, tag])), [all]);

			const filtered = useMemo(() => {
				const query = state.query.trim().toLowerCase();
				/* R15：标签筛选按维度分组 —— 同维度内 OR，跨维度 AND */
				const grouped = { purpose: [], context: [] };
				for (const id of state.tagFilter) {
					const tag = tagMap.get(id);
					if (tag && grouped[tag.dimension]) grouped[tag.dimension].push(id);
				}
				let list = items.filter((item) => {
					if (state.kind !== "all" && item.kind !== state.kind) return false;
					if (state.source !== "any" && item.source !== state.source) return false;
					/* 「用没用」五视角：未使用 / 有调用 / 有报错 / 仅子代理 */
					if (state.usage === "unused" && !isUnused(item)) return false;
					if (state.usage === "used" && isUnused(item)) return false;
					if (state.usage === "errors" && !hasErrors(item)) return false;
					if (state.usage === "subonly" && !isSubagentOnly(item)) return false;
					/* R9：只看无人依赖的候选（Skill 永远不参与：它们之间没有 npm 依赖） */
					if (state.orphanOnly && !isOrphanHint(item)) return false;
					/* R12：只看「不会被加载」的条目（宿主没给 loadState 时一条都不命中，不做猜测） */
					if (state.dormantOnly && !isDormant(item)) return false;
					/* R15：标签筛选 —— 选中了某一维的标签，条目就必须命中该维至少一个 */
					if (grouped.purpose.length > 0 && !grouped.purpose.some((id) => (item.tags?.purpose || []).includes(id))) return false;
					if (grouped.context.length > 0 && !grouped.context.some((id) => (item.tags?.context || []).includes(id))) return false;
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
					if (state.sort === "size") {
						/* 没量过（或没有可量目录）按 0 排在后面，再按名字定序 —— 否则一堆 0 的顺序每次都不一样 */
						const diff = (sizeOfItem(b, sizeMap) || 0) - (sizeOfItem(a, sizeMap) || 0);
						return diff !== 0 ? diff : String(a.name).localeCompare(String(b.name));
					}
					if (state.sort === "recent") return (b.lastUsed || 0) - (a.lastUsed || 0);
					if (state.sort === "time") return (b.createdAt || 0) - (a.createdAt || 0);
					return String(a.name).localeCompare(String(b.name));
				});
				return list;
			}, [items, state.query, state.kind, state.source, state.usage, state.sort, state.orphanOnly, state.dormantOnly, state.tagFilter, tagMap, sizeMap]);

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

			/* R9：「无人依赖」候选数（与洞察条同口径：只受来源/类型影响，不被关键词带着跳） */
			const orphanCount = useMemo(() => {
				return items.filter((item) => (state.kind === "all" || item.kind === state.kind) && (state.source === "any" || item.source === state.source) && isOrphanHint(item)).length;
			}, [items, state.kind, state.source]);

			/* R12：「不会被加载」的条数 —— 与洞察条同口径（只受 kind/source 影响，不随关键词跳） */
			const dormantCount = useMemo(() => {
				return dormantCountOf(items.filter((item) => (state.kind === "all" || item.kind === state.kind) && (state.source === "any" || item.source === state.source)));
			}, [items, state.kind, state.source]);

			/* R15：每个标签被多少条目用着（只算 purpose / context；origin 是推导值，不可筛）。
			   ★ 只列**真的有条目在用**的标签：27 个内置标签全铺出来会把工具条撑成三行，
			     而且 0 命中的标签点进去就是空页 —— 那不是筛选，是陷阱。 */
			const tagUsage = useMemo(() => {
				const counts = new Map();
				const pool = items.filter((item) => (state.kind === "all" || item.kind === state.kind) && (state.source === "any" || item.source === state.source));
				for (const item of pool) {
					for (const dimension of ["purpose", "context"]) {
						for (const id of item.tags?.[dimension] || []) counts.set(id, (counts.get(id) || 0) + 1);
					}
				}
				return counts;
			}, [items, state.kind, state.source]);

			/* 标签筛选行要展示的面板：按维度分组、按用量倒序 —— 用得最多的那几类应该最先点到 */
			const tagFacets = useMemo(() => {
				const byDim = { purpose: [], context: [] };
				for (const [id, count] of tagUsage) {
					const tag = tagMap.get(id);
					if (tag && byDim[tag.dimension]) byDim[tag.dimension].push({ ...tag, count });
				}
				for (const dimension of ["purpose", "context"]) byDim[dimension].sort((a, b) => b.count - a.count || String(a.label).localeCompare(String(b.label)));
				return byDim;
			}, [tagUsage, tagMap]);

			function renderTagFacet(dimension, prefix) {
				const list = tagFacets[dimension];
				if (list.length === 0) return null;
				return h(
					"span",
					{ className: "dpc-facet" },
					h("span", { className: "dpc-facet-dim", title: dimension === "purpose" ? "做什么" : "用在哪里" }, prefix),
					list.map((tag) =>
						h(
							"button",
							{
								key: tag.id,
								className: "dpc-facet-chip" + (state.tagFilter.includes(tag.id) ? " is-on" : ""),
								title: (tag.gloss || tag.label) + "　·　" + tag.count + " 条",
								onClick: () => {
									const has = state.tagFilter.includes(tag.id);
									set({ tagFilter: has ? state.tagFilter.filter((id) => id !== tag.id) : state.tagFilter.concat(tag.id), page: 1 });
								},
							},
							tag.label,
							h("span", { className: "dpc-facet-count" }, tag.count),
						),
					),
				);
			}

			/* 当前筛选结果的体积合计：回答「删这批能省多少」，不用逐个点开浮窗。
			   noDir = 量不到的条数（官方包在 asar 里 / 没有独立目录）—— 它们不计入合计，但要说出来。 */
			const filteredWeight = useMemo(() => {
				let bytes = 0;
				let noDir = 0;
				/* 量不到有两种：**没有可量目录**（asar / 无独立目录）与**还没量**（快照里没有它）。
				   混成一句会让"刚装上的插件"看起来像"不占空间"，所以分开数。 */
				let unmeasured = 0;
				/* R9：其中有多少字节是"别人依赖的运行时" —— 删它不能单独删，合计里要区分开 */
				let lockedBytes = 0;
				for (const item of filtered) {
					const size = sizeOfItem(item, sizeMap);
					if (size === null) {
						if (item.realDir && !item.inAsar) unmeasured += 1;
						else noDir += 1;
						continue;
					}
					bytes += size;
					if (Number(item.dependentCount) > 0) lockedBytes += size;
				}
				return { bytes, noDir, unmeasured, lockedBytes };
			}, [filtered, sizeMap]);

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

			/* 体积快照：没有、或超过 SIZES_TTL_MS 就自动在后台量一遍。
			   ★ 三条闸门与统计自愈同款：本挂载只触发一次、有任务在跑不抢、确实过期。
			     少了第二条会和「重新扫描」互相把对方挡掉（startJob 是单任务闸）。 */
			const autoSized = useRef(false);
			useEffect(() => {
				if (autoSized.current || !data) return;
				if (data.job && data.job.running) return;
				const age = sizesAt ? Date.now() - sizesAt : Infinity;
				if (age < SIZES_TTL_MS) return;
				autoSized.current = true;
				post("/refresh", { what: "sizes" }).catch(() => {});
			}, [sizesAt, Boolean(data)]);

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

			/* 量体积（全量，后台任务）：卡片上的体积、按体积排序、合计都靠这份快照 */
			async function runSizes() {
				await post("/refresh", { what: "sizes" });
				await refresh();
			}

			/* 发版体检（R10）：三层自检 + 版本一致性 + git，结论落在 .cache/ship-*.md。
			   已有任务在跑时服务端会拒绝（单任务闸），这里把原因说出来而不是静默。 */
			async function runPreflight() {
				const result = await post("/preflight", {});
				if (!result || result.ok === false) set({ notice: (result && result.error) || "起不来自检任务（可能已有任务在跑）" });
				await refresh();
			}

			/* R14：处置清单 —— 只生成、不执行。清单算完落在 `data.uninstall`（服务端单独存的，
			   不会被后面的后台任务顶掉），卡片就地渲染。 */
			async function runUninstall() {
				set({ uninstallBusy: true, uninstallConfirm: false });
				const result = await post("/uninstall", {});
				if (!result || result.ok === false) set({ notice: (result && (result.hint || result.error)) || "起不来处置清单任务（可能已有任务在跑）" });
				set({ uninstallBusy: false });
				await refresh();
			}

			/* 写盘：第二下才真的写（第一下只是把按钮变成"确认写入"） */
			async function writeUninstallReport() {
				if (!state.uninstallConfirm) {
					set({ uninstallConfirm: true, notice: "再点一次「确认写入」才写文件：reports/uninstall-*.md|.json（不会删任何目录）" });
					return;
				}
				set({ uninstallBusy: true });
				const result = await post("/uninstall", { apply: true, confirm: true });
				set({ uninstallBusy: false, uninstallConfirm: false });
				if (result && result.ok) set({ notice: "已写入处置清单：" + result.mdPath });
				else set({ notice: "写清单失败：" + String((result && result.error) || "未知错误") });
				await refresh();
			}

			/* R16：删除预演 —— 服务端在内存里把包从依赖图上摘掉、重算加载态，只算不删。
			   ★ 结论只放前端 state（不进 localStorage）：刷新后必须是「还没预演」。 */
			async function runSimulate() {
				set({ simBusy: true });
				const result = await post("/uninstall", { action: "simulate" });
				set({ simBusy: false });
				if (!result || result.ok === false) {
					set({ notice: (result && result.error) || "预演失败：先算一次处置清单", sim: null });
					return;
				}
				set({ sim: result, notice: null });
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
			/* R11：这里只算「该同步的 Skill」——staging 更新（newer-workspace）不算，方向反了会把线上覆盖回旧版 */
			const staleSkills = staleSkillIds(driftMap);
			/* 上一次体检的结论：读**服务端单独存的** `preflight`，不读 `job` 那一格 ——
			   job 只有一格，统计自愈/量体积一跑就把体检结论顶掉（真机上实测「卡片活不过 20 秒」）。 */
			const preflightResult = (data && data.preflight) || null;
			/* R14：处置清单也是服务端单独存的（同一理由），只在算过之后出现 */
			const uninstallPlan = (data && data.uninstall) || null;
			/* R22：配置层（声明层）—— 服务端 60 秒缓存一份紧凑视图，随 /state 一起下发 */
			const composition = (data && data.composition) || null;
			const compositionBad = composition && composition.verdict === "bad" ? composition : null;

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
							/* R18：磁盘已更新但宿主里还是旧模块 —— 这时新工具/新路由根本不存在，
							   而 build 标签读的是磁盘，不标出来会让人以为已经生效了 */
							data.build && data.build.stale ? h("span", { className: "dpc-bad", title: "磁盘上的代码已经更新，但宿主进程里跑的仍是旧模块。重载插件（plugin_manager set_plugin）或重启 DSH 后新代码才生效" }, "｜运行中 " + (data.build.loaded || "?") + "（未重载）") : null,
							/* R22：配置层入口 —— 不占头部按钮位（那里已经有 9 个），折进这一行里。
							   有缺口时把计数直接写在链接上，否则没人会点开看。 */
							data.composition
								? h(
										"button",
										{
											className: "dpc-conf-link" + (data.composition.verdict === "bad" ? " is-bad" : data.composition.verdict === "warn" ? " is-warn" : ""),
											onClick: () => set({ showComposition: true }),
											title: "配置层（声明）：两份组合文件的顶层条目、关掉/条件启用的条目、bundles 缺口。只读声明，不展开 bundle 自带的 patch 层",
										},
										"｜配置层" +
											(((composition.bundles && composition.bundles.missing) || 0) > 0
												? " 缺 " + composition.bundles.missing
												: ((composition.counts && composition.counts.byResolution && composition.counts.byResolution.missing) || 0) > 0
													? " 查不到 " + composition.counts.byResolution.missing
													: ""),
									)
								: null,
						),
					),
					h(
						"div",
						{ className: "dpc-header-actions" },
						h("button", { className: "dpc-btn dpc-btn-sm", onClick: startPlan, disabled: state.uploadBusy }, state.uploadBusy ? "出计划…" : "上传备份到 GitHub"),
						h("button", { className: "dpc-btn dpc-btn-sm dpc-btn-ghost", onClick: refreshStats, disabled: job.running }, "刷新统计"),
						/* 体积是清理决策的主要依据之一：给一个显式入口，不必等自动刷新 */
						h("button", { className: "dpc-btn dpc-btn-sm dpc-btn-ghost", onClick: runSizes, disabled: job.running, title: "量一遍全部条目的磁盘体积（后台任务；卡片体积、按体积排序、筛选合计都靠它）" }, sizesAt ? "重量体积" : "量体积"),
						h("button", { className: "dpc-btn dpc-btn-sm dpc-btn-ghost", onClick: refreshCatalog, disabled: job.running }, "重新扫描"),
						/* R10：一条命令的发版体检（三层自检 + 版本一致性 + git），换会话前点一次就够
						   R11：加了第 4 项「副本同步」（Skill 的 staging 是否旧了，只报不拦） */
						h(
							"button",
							{
								className: "dpc-btn dpc-btn-sm dpc-btn-ghost",
								onClick: runPreflight,
								disabled: job.running,
								title: "发版体检：audit / render-check / hosttest 三层自检 + 副本同步（Skill 的 staging 旧了没有）+ 版本号与构建戳一致性 + git 状态；结论写进 .cache/ship-*.md，失败项直接列在面板上。约 45 秒",
							},
							"自检",
						),
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
							"后台任务：" + job.kind + " · " + (job.progress.done || 0) + "/" + (job.progress.total || "?") + (job.progress.paused ? "（已暂停）" : "") + "　界面可以继续用，算完自动刷新",
						)
					: null,
				/* R17：自上次快照以来变了什么（真有变化才占版面）；R19：标记过「已看过」就只看那之后的窗口 */
				h(ChangesBar, {
					changes: data && data.changes,
					sinceAck: data && data.sinceAck,
					timeline: data && data.timeline,
					open: state.showChanges,
					onToggle: () => set({ showChanges: !state.showChanges }),
					historyOpen: state.showHistory,
					onToggleHistory: () => set({ showHistory: !state.showHistory }),
				}),
				/* R22：配置层有**真的缺**（bundles 里点名却找不到）才占用公告位 ——
				   `静态查不到` 只上琥珀色的链接角标，不在这里吓人（它可能由运行期注入满足）。 */
				compositionBad
					? h(
							"div",
							{ className: "dpc-note dpc-note-warn" },
							"配置层：`dsh.profile.bundles` 里有 " +
								compositionBad.bundles.missing +
								" 个包既没安装、也不在官方 asar 里 —— 宿主启用它们时会失败：" +
								(compositionBad.bundlesMissing || [])
									.slice(0, 4)
									.map((item) => item.name)
									.join("、") +
								((compositionBad.bundlesMissing || []).length > 4 ? " 等" : "") +
								"　",
							h("button", { className: "dpc-btn dpc-btn-sm dpc-btn-ghost", onClick: () => set({ showComposition: true }) }, "查看配置层"),
						)
					: null,
				/* 提示 */
				state.notice ? h("div", { className: "dpc-note dpc-note-warn" }, state.notice) : null,
				/* R11：体检结论（失败项直接摊开，不用先去 .cache 里找报告） */
				preflightResult ? h(PreflightCard, { result: preflightResult, busy: Boolean(job.running), onRerun: runPreflight }) : null,
				/* R14：处置清单（不会被加载 → 怎么卸干净）。点「处置清单」才算，算完就地摊开 */
				uninstallPlan
					? h(UninstallCard, {
							plan: uninstallPlan,
							busy: state.uninstallBusy,
							confirm: state.uninstallConfirm,
							sim: state.sim,
							simBusy: state.simBusy,
							onSimulate: runSimulate,
							onWrite: writeUninstallReport,
							onCancelConfirm: () => set({ uninstallConfirm: false }),
							onRerun: runUninstall,
						})
					: null,
				state.exportPath
					? h(							"div",
							{ className: "dpc-note" },
							"已导出 " + state.exportCount + " 条 → ",
							h("code", { className: "dpc-path" }, state.exportPath),
							" ",
							h("button", { className: "dpc-btn dpc-btn-sm dpc-btn-ghost", onClick: () => set({ notice: copyText(state.exportPath) ? null : "复制失败：渲染进程不让写剪贴板" }) }, "复制路径"),
						)
					: null,
				/* 副本漂移公告：改源码不生效的第一现场
				   R11：Skill 的「staging 旧了」在这里就能处置 —— 不用再去开工具/翻文档 */
				driftBad.length > 0
					? h(
							"div",
							{ className: "dpc-note dpc-note-warn" },
							h(
								"div",
								null,
								"有 " +
									driftBad.length +
									" 个条目的两份副本不同步：" +
									driftBad
										.slice(0, 5)
										.map((id) => (items.find((entry) => entry.id === id) || {}).name || id)
										.join("、") +
									(driftBad.length > 5 ? " 等" : "") +
									" —— 插件看卡片上的「副本不同步」，Skill 看「staging 不同步」（发布的是 staging 那份）",
							),
							staleSkills.length > 0
								? h(
										"div",
										{ className: "dpc-sync-bar" },
										h("span", { className: "dpc-muted" }, staleSkills.length + " 个 Skill 的 staging 是旧的（推上去的就是旧版）："),
										h(
											"button",
											{
												className: "dpc-btn dpc-btn-sm",
												onClick: () => planStageSync(staleSkills),
												disabled: state.syncBusy || Boolean(job.running),
												title: "出计划 → 二次确认 → 把 DSH 正在加载的那份 SKILL.md 单向复制到 staging（覆盖前备份 .bak-<时间戳>）",
											},
											state.syncBusy ? "出计划…" : "同步 staging（" + staleSkills.length + "）",
										),
									)
								: null,
						)
					: null,
				/* R11：同步确认条 —— 只在面板上（浮窗里有自己的一份，避免同一个确认出现两次） */
				state.syncPlan && !state.open
					? h(SyncConfirm, { plan: state.syncPlan, busy: state.syncBusy, onApply: applyStageSync, onCancel: () => set({ syncPlan: null }) })
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
					/* R9：只看「无人依赖」的候选 —— 与体积合计配合就是"能安全省多少"的入口 */
					orphanCount > 0 || state.orphanOnly
						? h(
								"button",
								{
									className: "dpc-btn dpc-btn-sm dpc-btn-ghost" + (state.orphanOnly ? " is-on" : ""),
									onClick: () => set({ orphanOnly: !state.orphanOnly, page: 1 }),
									title:
										"只看无人依赖的条目：profile 里所有 package.json（含一层嵌套）都没声明依赖它们。" +
										"这是候选不是结论 —— 动之前用 npm ls / pnpm why 确认；反过来说，「被 N 依赖」的条目删了会直接弄坏别人。",
								},
								(state.orphanOnly ? "✓ " : "") + "无人依赖 " + orphanCount,
							)
						: null,
					/* R12：只看「不会被加载」的条目 —— 这是最硬的死重量判据（装了根本不会跑），
					   比"未使用"更硬：未使用至少可能是暂时没用到。 */
					dormantCount > 0 || state.dormantOnly
						? h(
								"button",
								{
									className: "dpc-btn dpc-btn-sm dpc-btn-ghost" + (state.dormantOnly ? " is-on" : ""),
									onClick: () => set({ dormantOnly: !state.dormantOnly, page: 1 }),
									title:
										"只看「不会被加载」的条目：不在 dsh.profile.bundles、没有 cordis 配置条目、也不在任何入口的依赖链上 —— 宿主根本不会加载它们。" +
										"这是声明层面的判据（运行时按路径 require 的动态加载看不见），所以文案是「不会被加载」而不是「绝对没跑」。",
								},
								(state.dormantOnly ? "✓ " : "") + "不会被加载 " + dormantCount,
							)
						: null,
					/* R14：「不会被加载」只是判据，动手还得知道**怎么删、删了会不会回来** ——
					   这个按钮出一份按分量分组、分类清楚、只生成不执行的处置清单。 */
					dormantCount > 0 || uninstallPlan
						? h(
								"button",
								{
									className: "dpc-btn dpc-btn-sm dpc-btn-ghost" + (uninstallPlan ? " is-on" : ""),
									onClick: runUninstall,
									disabled: state.uninstallBusy || Boolean(job.running),
									title:
										"生成「不会被加载」的处置清单：按弱连通分量分组（组内互相依赖，单删一个会留孤儿），" +
										"每组给可回收体积与分类（实体 / 被 profile 依赖钉住 / 链接到工作区 / 同项目第二份），并写清步骤。" +
										"只生成、永不执行删除；写入 reports/ 需要再点一次确认。约 1 秒",
								},
								state.uninstallBusy ? "算清单…" : "处置清单",
							)
						: null,
					/* 当前筛选这一屏一共占多少盘 —— 点「未使用」就能直接看到"删这批能省多少" */
					filtered.length > 0 && sizesAt
						? h(
								"span",
								{
									className: "dpc-sum",
									title:
										"当前筛选结果的磁盘体积合计" +
										(filteredWeight.noDir > 0 ? "；" + filteredWeight.noDir + " 条没有可量目录（官方 asar 内 / Skill 没有独立目录），不计入" : "") +
										(filteredWeight.unmeasured > 0 ? "；" + filteredWeight.unmeasured + " 条还没量过体积（装/删之后点「重量体积」就能补上），不计入" : "") +
										(filteredWeight.lockedBytes > 0 ? "；其中 " + fmtBytes(filteredWeight.lockedBytes) + " 被其它插件依赖（删了会连带弄坏），不能算作可回收空间" : "") +
										(sizeTruncated.length > 0 ? "；" + sizeTruncated.length + " 条超过预算只算了一部分（标 + 的那些）" : "") +
										"。数据来自后台全量快照（" + ago(sizesAt) + "）",
								},
								"合计 " +
									fmtBytes(filteredWeight.bytes) +
									(filteredWeight.noDir > 0 || filteredWeight.unmeasured > 0
										? "（" +
											[filteredWeight.noDir > 0 ? filteredWeight.noDir + " 条无可量目录" : "", filteredWeight.unmeasured > 0 ? filteredWeight.unmeasured + " 条还没量" : ""].filter(Boolean).join("，") +
											"）"
										: ""),
							)
						: null,
					h(
						"div",
						{ className: "dpc-toolbar-actions" },
						h(
							"button",
							{ className: "dpc-btn dpc-btn-sm" + (state.picking ? " is-on" : ""), onClick: togglePicking, title: "多选：点卡片选中，再一次性导出 / 打标这批（选中项不跨重载保留）" },
							state.picking ? "退出选择" : "选择",
						),
						h(
							"button",
							{ className: "dpc-btn dpc-btn-sm dpc-btn-ghost dpc-export", onClick: exportFiltered, disabled: state.exportBusy || filtered.length === 0, title: "把当前这一屏（含筛选条件）写成 Markdown，存到数据目录 reports/ 下" },
							state.exportBusy ? "导出中…" : "导出这 " + filtered.length + " 条",
						),
					),
				),
				/* R15：标签筛选行 —— 只在「有标签真的被用着」时出现。
				   一条标签都没有时整行不占位，而不是显示一行空框等用户去猜。 */
				tagUsage.size > 0
					? h(
							"div",
							{ className: "dpc-tagfilter" },
							h(
								"span",
								{ className: "dpc-tagfilter-title", title: "同维度多选＝或（做截图 或 做媒体），跨维度＝且（再叠 用在 Web GUI）。\n标签可以在这个行里点、也可以在「选择 → 打标」里一次给一批加上。" },
								"标签",
							),
							renderTagFacet("purpose", "做"),
							renderTagFacet("context", "用"),
							state.tagFilter.length > 0
								? h("button", { className: "dpc-btn dpc-btn-sm dpc-btn-ghost", onClick: () => set({ tagFilter: [], page: 1 }), title: "清空标签筛选（其它筛选条件保持不变）" }, "清除标签")
								: null,
						)
					: null,
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
								{
									className: "dpc-btn dpc-btn-sm",
									onClick: () => set({ tagPick: { ids: state.picked.slice() } }),
									disabled: state.picked.length === 0,
									title: "给选中的这批条目一次打上 / 去掉标签。语义是「只加」「只减」，不会清掉它们各自已有的其它标签；标完记为手标，AI 不再覆盖。",
								},
								"打标",
							),
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
					pageItems.map((item) => h(Card, { key: item.id, item, tags: all, hits: toolHits(item, state.query), picking: state.picking, picked: state.picked.includes(item.id), onPick: togglePick, drift: (data.drift || {})[item.id] || null, size: sizeOfItem(item, sizeMap), sizeTruncated: sizeTruncated.includes(item.id) })),
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
				state.tagPick ? h(TagBatchModal, { ids: state.tagPick.ids }) : null,
				state.plan ? h(PlanModal, {}) : null,
				state.showComposition ? h(CompositionModal, { composition, onClose: () => set({ showComposition: false }), onJump: jumpToCard }) : null,
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
.dpc-toolbar-actions{margin-left:auto;display:flex;align-items:center;gap:8px}.dpc-card.is-picking{cursor:copy}
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
/* 体积 chip：清理决策要看得到；量不到（asar / 还没量）就干脆不出现，别写「0 B」 */
.dpc-size{font-size:10.5px;padding:1px 6px;border-radius:6px;font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-secondary,#6b7280);background:var(--dpc-fill);border:1px solid var(--dpc-line-soft)}
/* 依赖 chip（R9）：有依赖者=不能单独删（中性色）；无人依赖=候选（琥珀色，与「待确认」同族但更淡） */
.dpc-dep{font-size:10.5px;padding:1px 6px;border-radius:6px;font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-secondary,#4b5563);background:var(--dpc-fill);border:1px solid var(--dpc-line-soft)}
.dpc-dep.is-orphan{color:#8a5a06;background:rgba(217,119,6,.12);border-color:rgba(217,119,6,.32)}
/* 加载态 chip（R12）：「不会被加载」用灰底而不是红色（红色只留报告错）；
   「配置入口」是中性事实（不置灰）：它不在 bundles 里，但确实会被加载。 */
.dpc-load{font-size:10.5px;padding:1px 6px;border-radius:6px;font-weight:650;flex:0 0 auto;
  color:var(--dsw-alias-label-secondary,#6b7280);background:var(--dpc-fill);border:1px dashed var(--dpc-line)}
.dpc-load.is-config{color:#002fa7;background:rgba(0,47,167,.07);border:1px solid rgba(0,47,167,.32)}
.dpc-load-warn{padding:7px 10px;border-radius:9px;font-size:12px;line-height:1.6;
  color:#8a5a06;background:rgba(217,119,6,.10);border:1px solid rgba(217,119,6,.30)}
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
/* R11：体检结论卡 —— 失败项直接摊在面板上（以前只有一行提示条 + 一个报告路径） */
.dpc-preflight{display:flex;flex-direction:column;gap:7px;font-size:12px;padding:9px 11px;border-radius:10px;
  border:1px solid var(--dpc-line);background:var(--dpc-fill)}
.dpc-preflight.is-ok{border-color:rgba(22,163,74,.35)}
.dpc-preflight.is-bad{border-color:rgba(220,38,38,.4)}
.dpc-preflight-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dpc-preflight-mark{font-weight:700;font-size:13px}
.dpc-preflight.is-ok .dpc-preflight-mark{color:#15803d}
.dpc-preflight.is-bad .dpc-preflight-mark{color:#b91c1c}
.dpc-preflight-title{font-weight:600}
.dpc-preflight-checks{display:flex;gap:6px;flex-wrap:wrap}
.dpc-preflight-check{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid var(--dpc-line-soft);
  color:var(--dsw-alias-label-secondary,#4b5563);font-variant-numeric:tabular-nums}
.dpc-preflight-check.is-ok{border-color:rgba(22,163,74,.3);color:#15803d}
.dpc-preflight-check.is-bad{border-color:rgba(220,38,38,.45);color:#b91c1c;font-weight:600}
.dpc-preflight-check.is-info{border-style:dashed}
.dpc-preflight-fails{display:flex;flex-direction:column;gap:3px;max-height:230px;overflow:auto;padding:6px 8px;
  border-radius:8px;background:rgba(220,38,38,.05)}
.dpc-preflight-fail{display:flex;align-items:baseline;gap:7px;font-size:11.5px;line-height:1.5}
.dpc-preflight-where{flex:0 0 auto;font-size:10px;padding:0 5px;border-radius:5px;background:rgba(220,38,38,.14);color:#b91c1c;white-space:nowrap}
/* R14：处置清单卡 —— 只生成不执行；每组一行，名字那一行等宽截断，别把面板推下去 */
.dpc-uninstall .dpc-preflight-mark{color:var(--dpc-klein)}
.dpc-uninstall-groups{display:flex;flex-direction:column;gap:5px;max-height:240px;overflow:auto}
.dpc-uninstall-group{display:flex;flex-direction:column;gap:2px;padding:5px 7px;border-radius:8px;
  background:color-mix(in srgb,var(--dpc-klein) 5%,transparent);border:1px solid var(--dpc-line-soft)}
.dpc-uninstall-group-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11.5px}
.dpc-uninstall-name{font-weight:600;font-family:var(--dpc-mono,ui-monospace,monospace)}
.dpc-uninstall-kind{font-size:10px;padding:0 5px;border-radius:5px;background:rgba(57,100,254,.12);color:#2f5fd0;white-space:nowrap}
.dpc-uninstall-members{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary,#6b7280);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dpc-uninstall-steps{font-size:11px;line-height:1.65;color:var(--dsw-alias-label-secondary,#6b7280)}
/* R16：删除预演 —— 绿=没有入口指空，红=有风险；三条风险各占一行，空的不出现 */
.dpc-sim{margin-top:8px;padding:8px 10px;border-radius:10px;border:1px solid rgba(0,0,0,.08);
  display:flex;flex-direction:column;gap:3px;font-size:11.5px;line-height:1.6}
.dpc-sim.is-ok{border-color:rgba(22,163,74,.35);background:rgba(22,163,74,.05)}
.dpc-sim.is-bad{border-color:rgba(235,64,52,.35);background:rgba(235,64,52,.05)}
.dpc-sim-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dpc-sim-mark{font-weight:700}
.dpc-sim.is-ok .dpc-sim-mark{color:#16a34a}
.dpc-sim.is-bad .dpc-sim-mark{color:#eb4034}
.dpc-sim-title{font-weight:600}
.dpc-sim-verdict{font-size:10px;padding:0 5px;border-radius:5px;background:rgba(0,0,0,.06)}
.dpc-sim.is-ok .dpc-sim-verdict{background:rgba(22,163,74,.14);color:#15803d}
.dpc-sim.is-bad .dpc-sim-verdict{background:rgba(235,64,52,.14);color:#b91c1c}
.dpc-sim-row{color:var(--dsw-alias-label-secondary,#4b5563)}
.dpc-sim-warn{color:#b45309}
.dpc-sim-foot{margin-top:3px;font-size:11px;line-height:1.55}
/* R17：变化条 —— 一行摘要 + 点开明细；只在真有变化时出现 */
.dpc-changes{margin:0 0 6px;border-radius:10px;border:1px solid rgba(57,100,254,.22);background:rgba(57,100,254,.05)}
.dpc-changes-headrow{display:flex;align-items:center;gap:2px;padding-right:5px}
.dpc-changes-headrow .dpc-changes-head{flex:1;min-width:0;width:auto}
.dpc-changes-ack{flex:0 0 auto;font:inherit;font-size:10.5px;padding:2px 6px;border-radius:6px;border:1px solid rgba(57,100,254,.3);background:none;color:#2f5fd0;cursor:pointer;white-space:nowrap}
.dpc-changes-ack:hover{background:rgba(57,100,254,.08)}
.dpc-changes-ack:disabled{opacity:.55;cursor:default}
.dpc-changes-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap;width:100%;text-align:left;background:none;border:0;padding:6px 9px;cursor:pointer;font:inherit;color:inherit}
.dpc-changes-mark{color:var(--dpc-klein);font-weight:700}
.dpc-changes-title{font-size:11.5px;color:var(--dsw-alias-label-secondary,#6b7280)}
.dpc-changes-count{font-size:12px;font-weight:600}
.dpc-changes-chip{font-size:10.5px;padding:0 5px;border-radius:5px;background:rgba(57,100,254,.12);color:#2f5fd0;white-space:nowrap}
.dpc-changes-list{border-top:1px dashed rgba(57,100,254,.25);padding:6px 9px;display:flex;flex-direction:column;gap:3px}
.dpc-changes-row{display:flex;gap:7px;font-size:11.5px;line-height:1.6;align-items:baseline}
.dpc-changes-tag{flex:0 0 auto;font-size:10px;padding:0 5px;border-radius:5px;background:var(--dpc-fill-hover);color:var(--dsw-alias-label-secondary,#4b5563)}
.dpc-changes-foot{font-size:10.5px;line-height:1.55;margin-top:2px}
/* R21：更早窗口的时间线（折叠在变化条下方，不抢当前窗口的版面） */
.dpc-changes-history{margin:2px 9px 7px;padding-top:5px;border-top:1px dashed rgba(20,40,80,.12)}
.dpc-changes-history-toggle{font:inherit;font-size:10.5px;padding:1px 0;border:0;background:none;color:#2f5fd0;cursor:pointer}
.dpc-changes-history-toggle.is-open{font-weight:600}
/* R22：配置层 —— 头部链接角标 + 浮层里的四类清单 */
.dpc-conf-link{appearance:none;font:inherit;font-size:11.5px;padding:0 2px;border:0;background:none;
  color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer;white-space:nowrap}
.dpc-conf-link:hover{color:var(--dpc-klein);text-decoration:underline}
.dpc-conf-link.is-warn{color:#b45309}
.dpc-conf-link.is-bad{color:#b91c1c;font-weight:600}
.dpc-conf-sum{display:flex;flex-direction:column;gap:4px;font-size:12px;line-height:1.7;
  padding:9px 11px;border-radius:10px;background:var(--dpc-fill-hover)}
.dpc-conf-block{display:flex;flex-direction:column;gap:4px;padding:9px 11px;border-radius:10px;
  border:1px solid var(--dpc-line);background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.02))}
.dpc-conf-block.is-bad{border-color:rgba(220,38,38,.4);background:rgba(220,38,38,.05)}
.dpc-conf-block.is-warn{border-color:rgba(180,83,9,.4);background:rgba(217,119,6,.05)}
.dpc-conf-block.is-info{border-color:rgba(57,100,254,.3);background:rgba(57,100,254,.04)}
.dpc-conf-block-head{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2937)}
.dpc-conf-row{display:flex;align-items:baseline;gap:7px;flex-wrap:wrap;font-size:11.5px;line-height:1.65}
.dpc-conf-name{font-weight:600;word-break:break-all}
.dpc-conf-id{font-size:10.5px;opacity:.8}
.dpc-conf-file{font-size:10.5px;color:var(--dsw-alias-label-secondary,#8b93a1);white-space:nowrap}
.dpc-conf-row.is-link{cursor:pointer;border-radius:6px;padding:1px 4px;margin:0 -4px}
.dpc-conf-row.is-link:hover{background:var(--dpc-fill)}
.dpc-conf-row.is-link:focus-visible{outline:2px solid var(--dpc-klein);outline-offset:1px}
.dpc-conf-res{font-size:10px;padding:0 5px;border-radius:5px;background:var(--dpc-fill);color:var(--dsw-alias-label-secondary,#8b93a1)}
.dpc-conf-res.is-present{color:#166534}
.dpc-conf-res.is-asar{color:#1d4ed8}
.dpc-conf-res.is-missing{color:#b91c1c}
.dpc-conf-flag{font-size:10px;padding:0 5px;border-radius:5px;border:1px solid transparent}
.dpc-conf-flag.is-in{color:#166534;background:rgba(22,101,52,.08);border-color:rgba(22,101,52,.25)}
.dpc-conf-flag.is-out{color:var(--dsw-alias-label-secondary,#8b93a1);background:var(--dpc-fill)}
.dpc-conf-jump{font-size:10px;margin-left:auto}
.dpc-conf-expr{font-size:10.5px;padding:0 5px;border-radius:5px;background:var(--dpc-fill);
  color:#2f5fd0;word-break:break-all}
.dpc-conf-note{font-size:10.5px;line-height:1.55}
.dpc-conf-foot{font-size:10.5px;line-height:1.6;margin-top:2px}
/* R11：「同步 staging」——公告条里的入口 + 写盘前的二次确认 */
.dpc-sync-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px}
.dpc-sync-confirm{display:flex;flex-direction:column;gap:6px;font-size:12px;padding:9px 11px;border-radius:10px;
  border:1px solid var(--dpc-klein);background:color-mix(in srgb,var(--dpc-klein) 6%,transparent)}
.dpc-sync-confirm.is-compact{margin-top:6px;font-size:11.5px;padding:8px 10px}
.dpc-sync-title{font-weight:600;color:var(--dpc-klein)}
.dpc-sync-names{display:flex;gap:5px;flex-wrap:wrap}
.dpc-sync-name{font-size:11px;padding:1px 6px;border-radius:5px;background:var(--dpc-fill-hover);color:var(--dsw-alias-label-secondary,#4b5563)}
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
/* R15：批量打标的三态（全有 / 部分有 / 已排上加或减）—— 让"点一下会发生什么"在按之前就看得见 */
.dpc-tag.is-all{background:var(--dsw-alias-brand-primary,#3964fe);border-color:var(--dsw-alias-brand-primary,#3964fe);
  color:var(--dsw-alias-bg-base,#fff)}
.dpc-tag.is-part{border-style:dashed;border-color:var(--dpc-klein);color:var(--dpc-klein)}
.dpc-tag.is-add{border-color:#16a34a;color:#15803d;background:rgba(22,163,74,.08)}
.dpc-tag.is-remove{border-color:#dc2626;color:#b91c1c;background:rgba(220,38,38,.07);text-decoration:line-through}
.dpc-tag-ratio{font-size:9.5px;margin-left:5px;opacity:.72;font-variant-numeric:tabular-nums}
/* R15：标签筛选行（只在有标签被用着时才出现） */
.dpc-tagfilter{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:2px 2px 4px}
.dpc-tagfilter-title{font-size:11px;color:var(--dsw-alias-label-secondary,#8b93a1);flex:0 0 auto}
.dpc-facet{display:flex;align-items:center;gap:5px;flex-wrap:wrap}
.dpc-facet-dim{font-size:10px;padding:0 5px;border-radius:4px;background:var(--dpc-fill);
  color:var(--dsw-alias-label-secondary,#8b93a1);flex:0 0 auto}
.dpc-facet-chip{appearance:none;display:inline-flex;align-items:center;gap:5px;font-size:11px;
  padding:2px 8px;border-radius:999px;cursor:pointer;border:1px solid var(--dpc-line);
  background:var(--dpc-fill);color:var(--dsw-alias-label-secondary,#4b5563);
  transition:border-color .14s ease,color .14s ease,background .14s ease}
.dpc-facet-chip:hover{border-color:var(--dpc-klein);color:var(--dpc-klein)}
.dpc-facet-chip.is-on{background:var(--dpc-klein);border-color:var(--dpc-klein);color:#fff}
.dpc-facet-count{font-size:9.5px;opacity:.72;font-variant-numeric:tabular-nums}
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
			TagBatchModal,
			PlanModal,
			SessionList,
			ToolTable,
			TagEditor,
			SidebarEntry,
			CatalogIcon,
			fmtNumber,
			fmtMs,
			fmtBytes,
			sizeOfItem,
			SIZES_TTL_MS,
			loadSize,
			ago,
			tagLabel,
			isUnused,
			hasErrors,
			errorRate,
			isSubagentOnly,
			isOrphanHint,
			depLabel,
			/* R12：加载态三件套（纯函数，自检直接断言） */
			isDormant,
			isConfigLoaded,
			loadLabel,
			loadTitle,
			loadCell,
			dormantCountOf,
			togglePick,
			togglePicking,
			driftLabel,
			driftDetail,
			isStageStale,
			staleSkillIds,
			planStageSync,
			applyStageSync,
			PreflightCard,
			SyncConfirm,
			RestoreConfirm,
			/* R14：处置清单卡（只生成不执行） */
			UninstallCard,
			/* R22：配置层浮层（声明层；关掉的 / 条件启用的 / 静态查不到的 / bundles 缺口） */
			CompositionModal,
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
