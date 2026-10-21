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
		const BUILD = "r1.2";
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
			{ id: "recent", label: "最近使用" },
			{ id: "time", label: "时间" },
			{ id: "name", label: "名称" },
		];

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
			page: 1,
			pageSize: 24,
			open: null,
			detail: null,
			detailLoading: false,
			tagBusy: false,
			notice: null,
			plan: null,
			uploadBusy: false,
			uploadResult: null,
			report: null,
			reportBusy: false,
		};
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

		function openEntry(item) {
			set({ open: { id: item.id, page: 1, pageSize: 20 }, detail: null });
			loadDetail(item.id, 1, 20);
		}

		function closeEntry() {
			set({ open: null, detail: null });
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

		function fmtDateTime(ms) {
			if (!ms) return "—";
			const date = new Date(Number(ms));
			const pad = (n) => String(n).padStart(2, "0");
			return fmtTime(ms) + " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
		}

		function ago(ms) {
			if (!ms) return "从未";
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
			const zh = item.descriptionZh || "";
			const en = item.descriptionEn || "";
			/* 没有中文简介时直接拿英文当正文：否则每张卡都顶着一行「（还没有中文简介）」再接英文，
			   127 张卡一起看就是一片噪声。提示只留在详情里。 */
			const main = zh || en;
			const sub = zh && en ? en : "";
			return h(
				"button",
				{ className: "dpc-card" + (item.enabled === false ? " is-off" : ""), onClick: () => openEntry(item), title: "查看 " + item.name + " 的调用明细" },
				h(
					"div",
					{ className: "dpc-card-head" },
					h(SourceBadge, { source: item.source, why: item.sourceWhy }),
					h("span", { className: "dpc-name" }, item.name),
					item.kind === "skill" ? h("span", { className: "dpc-kind" }, "Skill") : null,
					item.askUser ? h("span", { className: "dpc-warn", title: "来源待你确认一次" }, "待确认") : null,
					h("span", { className: "dpc-calls", title: "总调用次数" }, fmtNumber(item.calls)),
				),
				main
					? h("div", { className: "dpc-zh" + (zh ? "" : " dpc-zh-plain"), title: main }, main)
					: h("div", { className: "dpc-zh" }, h("span", { className: "dpc-muted" }, item.kind === "skill" ? "（Skill 没有英文简介）" : "（还没有简介）")),
				sub ? h("div", { className: "dpc-en" }, sub) : null,
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
					if (query !== "") {
						const haystack = [item.name, item.title, item.descriptionZh, item.descriptionEn, (item.sourceWhy || []).join(" ")].join(" ").toLowerCase();
						if (!haystack.includes(query)) return false;
					}
					return true;
				});
				list = list.slice().sort((a, b) => {
					if (state.sort === "calls") return (b.calls || 0) - (a.calls || 0);
					if (state.sort === "recent") return (b.lastUsed || 0) - (a.lastUsed || 0);
					if (state.sort === "time") return (b.createdAt || 0) - (a.createdAt || 0);
					return String(a.name).localeCompare(String(b.name));
				});
				return list;
			}, [items, state.query, state.kind, state.source, state.sort]);

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

			return h(
				"div",
				{ className: "dpc-panel" },
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
					h("input", { className: "dpc-search", placeholder: "搜索名称 / 简介 / 判定依据…", value: state.query, onChange: (event) => set({ query: event.target.value, page: 1 }) }),
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
				),
				/* 卡片网格 */
				h(
					"div",
					{ className: "dpc-grid" },
					pageItems.map((item) => h(Card, { key: item.id, item, tags: all })),
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
			ago,
			tagLabel,
		};
		return exports;
	},
});
