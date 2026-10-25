/**
 * tools.mjs — 内嵌 Agent 的**工具面**（与面板同一套 service 方法）。
 *
 * 用户要求：「同一套能力同时注册为工具（不是 Skill），普通会话里能一句话调起
 * （『审一遍 dsh-xxx』『开放 xxx 仓』）」。所以工具名与描述必须让这句话**可映射**：
 *
 *   catalog_review   ← 审一遍 <name>（缺口分析 + 安全审核）
 *   catalog_publish  ← 开放/上传 <仓>（plan → apply → public 三档，默认只出计划）
 *   catalog_list     ← 有哪些插件/Skill（R14 起可按加载态筛：`loadState=dormant` = 装了根本不会跑的）
 *   catalog_stats    ← 调用统计（含子代理拆分）
 *   catalog_tag      ← 打标签 / 新增自定义标签（带解释）
 *   catalog_classify ← AI 分类（会把自定义标签的解释喂进去）
 *   catalog_health   ← 自检
 *   catalog_skill_sync ← 「staging 里的 Skill 是不是旧了」（plan 只出计划；apply 单向 live → staging）
 *   catalog_uninstall  ← 「这些不会被加载的能不能删、怎么删」（只生成处置清单，永不执行删除）
 *   catalog_composition ← 「配置里到底挂了什么」（R22：声明层；关掉/条件/按路径/静态查不到）
 *
 * ⚠️ DSH 0.2.1 起每个工具都必须声明 `output: { schema, render }`，漏了会让
 *    `ctx.tools.register()` 抛错、插件静默失活；返回值必须是 **lossless JSON**。
 *    这两条一律走 TOOL_OUTPUT + prune()。
 *
 * @module dsh-plugin-catalog/tools
 */

/**
 * ★ 加载态只有一份定义（`lib/loadstate.mjs`），工具面也走同一条判据 ——
 * 面板的「不会被加载 N」、`catalog_health` 的计数、这里的 `loadState` 过滤，
 * 三处必须同源；各写一遍比较式就是下一次"两边一起错还都绿"。
 */
import { isLoadedState } from "./loadstate.mjs";
import { compactComposition, summarizeComposition } from "./composition.mjs";
/* R30：MCP 分类的人话（官方的分类器在 lib/mcp.mjs，这里只取文案，别各写一份） */
import { mcpSourceText, mcpStateText, renderDisablePatch, summarizeMcp } from "./mcp.mjs";
/* R27：对账的措辞只在一处定义（面板、工具、报告共用），别在这里再写一遍。 */
import { VERIFY_REASON, VERIFY_VERDICT } from "./uninstall.mjs";

function compileParameters(spec) {
	const properties = {};
	const required = [];
	for (const [key, prop] of Object.entries(spec)) {
		if (prop && prop.required === true) required.push(key);
		const node = {};
		if (prop && typeof prop.type === "string") node.type = prop.type;
		if (prop && typeof prop.description === "string") node.description = prop.description;
		if (prop && Array.isArray(prop.enum)) node.enum = prop.enum;
		if (prop && typeof prop.items === "object" && prop.items !== null) node.items = prop.items;
		properties[key] = node;
	}
	return { type: "object", properties, ...(required.length > 0 ? { required } : {}) };
}

/** 递归剔掉 undefined / 函数，非有限数换 null（lossless JSON 的硬要求）。 */
function prune(value) {
	if (Array.isArray(value)) return value.map((item) => {
		const pruned = prune(item);
		return pruned === undefined ? null : pruned;
	});
	if (value !== null && typeof value === "object") {
		const out = {};
		for (const [key, item] of Object.entries(value)) {
			if (item === undefined) continue;
			const pruned = prune(item);
			if (pruned !== undefined) out[key] = pruned;
		}
		return out;
	}
	if (typeof value === "function") return undefined;
	if (typeof value === "number" && !Number.isFinite(value)) return null;
	return value;
}

function withText(payload, lines) {
	const text = lines.filter((line) => typeof line === "string" && line !== "").join("\n");
	return prune({ ...payload, text });
}

const renderToolResult = (_args, value) => {
	if (typeof value === "string") return [{ type: "text", text: value }];
	if (value !== null && typeof value === "object" && typeof value.text === "string") return [{ type: "text", text: value.text }];
	return [{ type: "text", text: JSON.stringify(value, null, 1) }];
};

const TOOL_OUTPUT = { schema: { type: "object" }, render: renderToolResult };

const SOURCE_LABEL = { official: "官方", self: "自写", third: "第三方", hybrid: "混血", pending: "待标记" };

function formatCalls(n) {
	return n >= 10000 ? (n / 10000).toFixed(1) + " 万" : String(n);
}

function formatTime(ms) {
	if (!ms) return "—";
	const date = new Date(ms);
	const pad = (n) => String(n).padStart(2, "0");
	return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
}

/** 体积：与 service / 面板同一口径（1024 进制、MB 起一位小数）—— 三处不许各写一套。 */
function formatBytes(bytes) {
	const value = Number(bytes) || 0;
	if (value >= 1024 * 1024 * 1024) return (value / (1024 * 1024 * 1024)).toFixed(1) + " GB";
	if (value >= 1024 * 1024) return (value / (1024 * 1024)).toFixed(1) + " MB";
	if (value >= 1024) return (value / 1024).toFixed(0) + " KB";
	return value + " B";
}

/**
 * 构造工具定义（**不注册**，由 index.js 注册并统一处理失败）。
 *
 * @param {{service: object, getState: () => Promise<object>}} deps
 * @returns {Array<object>}
 */
export function buildCatalogTools(deps) {
	const { service } = deps;

	return [
		{
			name: "catalog_list",
			description:
				"列出本机所有 DSH 插件与 Skill（含来源四分类：官方/自写/第三方/混血、标签、启用状态、调用次数），以及 **MCP 服务器**（kind=mcp：组合文件里 `@deepseek-ai/dsh-mcp-client` 的每条条目，按官方/第三方/自己配置三分类）。" +
				"想回答「我装了哪些插件」「有哪些自写插件」「哪些 Skill 没写 description」「哪些还没确认来源」「哪些装了根本不会跑」「我配了哪些 MCP」时用它。" +
				"`loadState=dormant` 只列「不会被加载」的（处置候选，配合 catalog_uninstall 看怎么删）；`loaded` 只列会被加载的。" +
				"只会读本机清单，不联网。MCP 的完整报告（0 台时的可抄模板、孤儿调用、配置问题）用 catalog_mcp。",
			parameters: compileParameters({
				kind: { type: "string", enum: ["all", "plugin", "skill", "mcp"], description: "只看插件 / 只看 Skill / 只看 MCP 服务器 / 全部（默认 all）" },
				source: { type: "string", enum: ["official", "self", "third", "hybrid", "pending", "any"], description: "按来源过滤（默认 any）" },
				query: { type: "string", description: "按名称或简介子串过滤（大小写不敏感）" },
				loadState: {
					type: "string",
					enum: ["any", "dormant", "loaded"],
					description:
						"按「会不会被加载」过滤：dormant = 装了但不在 bundles、没有配置条目、也不在任何依赖链上；" +
						"loaded = 会被加载（bundle / config / 随依赖任一）。Skill 没有加载态，两种过滤都会排除它。默认 any",
				},
				limit: { type: "number", description: "最多返回几条（默认 40，上限 200）" },
			}),
			output: TOOL_OUTPUT,
			async execute(args = {}) {
				const kind = String(args.kind || "all");
				const source = String(args.source || "any");
				const query = String(args.query || "").trim().toLowerCase();
				const loadState = String(args.loadState || "any");
				const limit = Math.min(200, Math.max(1, Number(args.limit) || 40));
				await service.rebuildIfCold();
				const { items, hostCore, totals } = service.listEntries();
				const filtered = items.filter((item) => {
					if (kind !== "all" && item.kind !== kind) return false;
					if (source !== "any" && item.source !== source) return false;
					/* ★ 判据只用 isLoadedState / "dormant" 字面量，不在这里另写一套比较式。
					   MCP 没有加载态（它不在 bundles 里）—— dormant/loaded 两种过滤都排除它。 */
					if ((loadState === "dormant" || loadState === "loaded") && item.kind === "mcp") return false;
					if (loadState === "dormant" && item.loadState !== "dormant") return false;
					if (loadState === "loaded" && !isLoadedState(item.loadState)) return false;
					if (query !== "") {
						const haystack = [item.name, item.title, item.descriptionZh, item.descriptionEn].filter(Boolean).join(" ").toLowerCase();
						if (!haystack.includes(query)) return false;
					}
					return true;
				});
				const shown = filtered.slice(0, limit);
				const lines = [
					`插件 ${totals.plugins} 个 / Skill ${totals.skills} 个 / MCP ${totals.mcp || 0} 台；来源分布：官方 ${totals.bySource.official}、自写 ${totals.bySource.self}、第三方 ${totals.bySource.third}、混血 ${totals.bySource.hybrid}、待标记 ${totals.bySource.pending}`,
					loadState === "dormant"
						? `（只看「不会被加载」：不在 dsh.profile.bundles、没有配置条目、也不在任何依赖链上 —— 共 ${filtered.length} 条；怎么删看 catalog_uninstall）`
						: loadState === "loaded"
							? `（只看「会被加载」：bundle / config / 随依赖任一 —— 共 ${filtered.length} 条；Skill 没有加载态，已被排除）`
							: `（列表只给前 ${limit} 条，共命中 ${filtered.length} 条）`,
					"",
				];
				for (const item of shown) {
					lines.push(
						`- [${SOURCE_LABEL[item.source] || item.source}] ${item.name}${item.kind === "skill" ? "（Skill）" : item.kind === "mcp" ? "（MCP·" + (item.transport || "?") + "）" : ""}｜调用 ${formatCalls(item.calls)} 次` +
							(item.subagentCalls > 0 ? `（含子代理 ${formatCalls(item.subagentCalls)}）` : "") +
							`｜最近 ${formatTime(item.lastUsed)}` +
							(item.kind === "mcp" ? `｜${item.mcpState === "off" ? "⚠️ 已关掉｜" : ""}${item.target || ""}｜${item.file || ""}:${item.line || ""}` : "") +
							(item.loadState === "dormant"
								? "｜⚠️ 不会被加载（不在 bundles、没有配置条目、也不在任何依赖链上）"
								: item.loadState === "config"
									? "｜配置条目挂载（不在 bundles）"
									: "") +
							(item.askUser ? "｜⚠️ 来源待你确认" : "") +
							/* R9：被依赖的包不能单独删 —— 列表里就要看得见 */
							(Number(item.dependentCount) > 0 ? `｜被 ${item.dependentCount} 个包依赖` : item.orphanHint ? "｜无人依赖（候选）" : "") +
							(item.descriptionZh ? "｜" + item.descriptionZh.slice(0, 60) : ""),
					);
				}
				if (hostCore.calls > 0) lines.push("", `另有宿主核心工具 ${formatCalls(hostCore.calls)} 次调用（不属于任何可上传插件，条目 id = host-core）`);
				return withText({ ok: true, totals, hostCore: { calls: hostCore.calls, tools: hostCore.tools.slice(0, 15) }, items: shown }, lines);
			},
		},

		{
			name: "catalog_stats",
			description:
				"查调用统计：不传 id 给全局概览（工具 Top、子代理占比）；传 id 给该插件/Skill 的明细（每个工具的调用次数、报错、平均耗时、最近使用、涉及哪些会话及其昵称）。" +
				"统计来自会话事件日志，覆盖最近 90 天；**只含会话 ID/昵称与次数，不含任何对话内容**。Skill 只能到「次数 + 最近一次」，机制限制。",
			parameters: compileParameters({
				id: { type: "string", description: "条目 id，例如 plugin:dsh-screenshot / skill:vex-ops / host-core（省略 = 全局概览）" },
				tool: { type: "string", description: "只看某个工具名（省略 = 全部）" },
				page: { type: "number", description: "会话列表页码（默认 1）" },
				pageSize: { type: "number", description: "每页条数（默认 20）" },
			}),
			output: TOOL_OUTPUT,
			async execute(args = {}) {
				await service.rebuildIfCold();
				if (!service.aggregate) {
					const started = service.refreshStatsInBackground();
					return withText({ ok: true, computing: true, started }, ["统计缓存还没生成，已在后台开始算（首次约 40~60 秒）。算完再问一次，或看 catalog_health。"]);
				}
				const id = String(args.id || "");
				if (id !== "") {
					const detail = service.entryDetail(id, { page: Number(args.page) || 1, pageSize: Number(args.pageSize) || 20 });
					if (!detail.ok) return withText({ ok: false, error: detail.error }, [detail.error]);
					const item = detail.item;
					let tools = detail.tools;
					if (args.tool) tools = tools.filter((tool) => tool.name === String(args.tool));
					const lines = [
						`${item.name}（${item.kind === "skill" ? "Skill" : SOURCE_LABEL[item.source] || item.source}）`,
						`调用 ${formatCalls(item.calls)} 次｜报错 ${item.errors}｜最近 ${formatTime(item.lastUsed)}` +
							(item.subagentCalls > 0 ? `｜其中子代理会话 ${formatCalls(item.subagentCalls)} 次（父会话直呼 ${formatCalls(item.calls - item.subagentCalls)} 次）` : ""),
						`涉及会话 ${detail.sessions.total} 个（第 ${detail.sessions.page}/${detail.sessions.pages} 页）`,
					];
					if (item.kind === "skill") lines.push("⚠️ Skill 只能统计「被加载的次数 + 最近一次时间」，无法细分到会话 —— 机制限制。");
					if (tools.length > 0) {
						lines.push("", "工具明细：");
						for (const tool of tools.slice(0, 25)) {
							lines.push(`- ${tool.name}：${tool.calls} 次｜报错 ${tool.errors}｜平均 ${tool.avgMs}ms｜最近 ${formatTime(tool.lastUsed)}｜会话 ${tool.sessions} 个`);
						}
					}
					if (detail.sessions.items.length > 0) {
						lines.push("", "会话（按调用次数降序）：");
						for (const session of detail.sessions.items.slice(0, 15)) {
							lines.push(`- ${session.calls} 次｜${session.title}${session.isSubagent ? "（子代理" + (session.depth ? " L" + session.depth : "") + (session.parentTitle ? "，父：" + session.parentTitle : "") + "）" : ""}｜最近 ${formatTime(session.lastAt)}｜${session.id}`);
						}
					}
					return withText({ ok: true, item, tools, sessions: detail.sessions }, lines);
				}

				const { items, hostCore, totals } = service.listEntries();
				const top = items.filter((item) => item.calls > 0).sort((a, b) => b.calls - a.calls).slice(0, 12);
				const meta = service.statsMeta || {};
				const lines = [
					`窗口：最近 ${meta.windowDays || 90} 天｜${meta.sessions || 0} 个会话｜${formatCalls(meta.calls || 0)} 次调用｜报错 ${meta.errors || 0}`,
					`子代理会话 ${totals.subagentCalls > 0 ? "占比很高" : "—"}：合计子代理调用 ${formatCalls(totals.subagentCalls)} 次（总 ${formatCalls(totals.calls)} 次）`,
					`缓存生成于 ${formatTime(meta.builtAt)}（耗时 ${meta.durationMs || 0}ms，去重掉 ${meta.duplicateCalls || 0} 条重复日志${meta.truncatedSessions > 0 ? "，⚠️ " + meta.truncatedSessions + " 个会话超过帧数上限已截断" : ""}）`,
					"",
					"插件/Skill 调用 Top：",
				];
				for (const item of top) lines.push(`- ${formatCalls(item.calls)} 次｜${item.name}（${SOURCE_LABEL[item.source] || item.source}）｜子代理 ${formatCalls(item.subagentCalls)}`);
				if (hostCore.calls > 0) {
					lines.push("", `宿主核心工具 ${formatCalls(hostCore.calls)} 次（不属于任何插件）：`);
					for (const tool of hostCore.tools.slice(0, 10)) lines.push(`- ${formatCalls(tool.calls)} 次｜${tool.name}`);
				}
				return withText({ ok: true, totals, top, hostCore: { calls: hostCore.calls, tools: hostCore.tools.slice(0, 20) }, meta }, lines);
			},
		},

		{
			name: "catalog_tag",
			description:
				"标签管理：列出全部标签（含解释）、给插件/Skill 打标签（单个或**批量**）、新增自定义标签（**必须给一句解释**，AI 分类会读它）、删除自定义标签。" +
				"标签三个维度：purpose（做什么）/ context（用在哪里）/ origin（怎么来的，由来源自动推导，不能手填）。" +
				"批量（传 ids）的语义是**追加/去掉**，不会清掉条目已有的其它标签；单个（传 id）的语义是**整条替换**。",
			parameters: compileParameters({
				action: { type: "string", enum: ["list", "set", "untag", "add", "remove", "source", "tool-owner"], description: "list 列出 / set 打标 / untag 去掉标签 / add 新增自定义 / remove 删除自定义 / source 手工改来源 / tool-owner 手工改工具归属", required: true },
				id: { type: "string", description: "条目 id（set 单条时用，语义＝整条替换）" },
				ids: { type: "array", items: { type: "string" }, description: "条目 id 列表（set / untag 批量时用，语义＝只加/只减，不动其它标签）" },
				purpose: { type: "array", items: { type: "string" }, description: "purpose 维度的标签 id 列表" },
				context: { type: "array", items: { type: "string" }, description: "context 维度的标签 id 列表" },
				label: { type: "string", description: "新标签名（add 时必填）" },
				gloss: { type: "string", description: "新标签的解释（add 时必填，一句能让人和模型都看懂的话）" },
				dimension: { type: "string", enum: ["purpose", "context"], description: "新标签属于哪个维度（add，默认 purpose）" },
				tagId: { type: "string", description: "要删除的自定义标签 id（remove 时必填）" },
				source: { type: "string", enum: ["official", "self", "third", "hybrid", "pending"], description: "source 动作：把条目来源改成这个" },
				note: { type: "string", description: "source 动作：一句备注（可选）" },
				tool: { type: "string", description: "tool-owner 动作：工具名（如 pwsh）" },
				pkg: { type: "string", description: "tool-owner 动作：归属包名（如 @deepseek-ai/dsh-tool-pwsh）" },
			}),
			output: TOOL_OUTPUT,
			async execute(args = {}) {
				const action = String(args.action || "list");
				await service.rebuildIfCold();
				if (action === "list") {
					const tags = service.listTags();
					const lines = [];
					for (const dimension of ["purpose", "context", "origin"]) {
						lines.push(`【${dimension}】`);
						for (const tag of tags.filter((item) => item.dimension === dimension)) lines.push(`- ${tag.id}｜${tag.label}：${tag.gloss}${tag.builtin ? "" : "（自定义）"}`);
					}
					return withText({ ok: true, tags }, lines);
				}
				if (action === "set" || action === "untag") {
					const op = action === "untag" ? "remove" : "add";
					const ops = [
						...(args.purpose || []).map((tagId) => ({ dimension: "purpose", tagId, op })),
						...(args.context || []).map((tagId) => ({ dimension: "context", tagId, op })),
					];
					if (ops.length === 0) return withText({ ok: false, error: "没有给标签：purpose / context 至少给一个" }, ["没有给标签：purpose / context 至少给一个"]);
					/* 批量优先：把同一组标签一次应用到一批条目上（幂等，重复调用不会翻倍） */
					if (Array.isArray(args.ids) && args.ids.length > 0) {
						const result = await service.applyTags(args.ids, ops, "user");
						if (!result.ok) return withText(result, [result.error, ...(result.unknownIds || []).map((id) => "不在目录里：" + id)]);
						const lines = [
							(action === "untag" ? "已去掉" : "已打上") + "标签：" + ops.map((item) => item.dimension + ":" + item.tagId).join(", "),
							`批量结果：${result.ids} 条目标｜实际改动 ${result.changed} 条｜无变化 ${result.unchanged} 条`,
						];
						if (result.unknownTags.length > 0) lines.push("不认识的标签（维度不对或没注册，已忽略）：" + [...new Set(result.unknownTags)].join(", "));
						if (result.unknownIds.length > 0) lines.push("不在当前目录里的 id（已跳过）：" + result.unknownIds.join(", "));
						lines.push("★ 这批条目记为「用户手标」，之后 AI 自动分类不会再覆盖它们。");
						return withText({ ok: true, ...result, all: service.listTags() }, lines);
					}
					if (!args.id) return withText({ ok: false, error: "set 需要 id（单条）或 ids（批量）" }, ["set 需要 id（单条）或 ids（批量）"]);
					if (action === "untag") return withText({ ok: false, error: "untag 只支持批量（ids）" }, ["untag 只支持批量（ids）；单条请用 set 传完整列表"]);
					const saved = await service.setTags(String(args.id), { purpose: args.purpose || [], context: args.context || [] }, "user");
					return withText({ ok: true, ...saved }, [`已给 ${args.id} 打标签：purpose=[${(args.purpose || []).join(", ")}] context=[${(args.context || []).join(", ")}]（整条替换；用户手标，AI 不会覆盖）`]);
				}
				if (action === "add") {
					const result = await service.addTag({ label: args.label, gloss: args.gloss, dimension: args.dimension || "purpose" });
					if (!result.ok) return withText({ ok: false, error: result.error }, [result.error]);
					return withText({ ok: true, tag: result.tag, all: result.all }, [`已新增标签「${result.tag.label}」（${result.tag.id}，${result.tag.dimension}）：${result.tag.gloss}`]);
				}
				if (action === "remove") {
					const result = await service.removeTag(String(args.tagId || ""));
					return withText(result, [result.ok ? "已删除自定义标签 " + args.tagId : "没有这个自定义标签"]);
				}
				if (action === "source") {
					/* 手工改来源：混血最难自动识别，推不出来时就人标一次，存进 overrides.json 不再问 */
					const source = String(args.source || "");
					if (!args.id) return withText({ ok: false, error: "source 需要 id" }, ["source 需要 id"]);
					const result = await service.setSource(String(args.id), source, String(args.note || "工具手工标记"));
					if (!result.ok) return withText(result, [result.error || "改来源失败"]);
					return withText(result, [`已把 ${args.id} 的来源标成 ${source}（存进 overrides.json，之后不再问）`]);
				}
				if (action === "tool-owner") {
					/* 手工改工具归属：工具→插件没有运行时登记表，推断不出来时可以人指定 */
					const toolName = String(args.tool || "");
					const pkg = String(args.pkg || "");
					if (!toolName || !pkg) return withText({ ok: false, error: "tool-owner 需要 tool 与 pkg" }, ["tool-owner 需要 tool 与 pkg"]);
					const result = await service.setToolOwner(toolName, pkg);
					return withText(result, [`已把工具 ${toolName} 的归属指定为 ${pkg}`]);
				}
				return withText({ ok: false, error: "未知 action" }, ["未知 action"]);
			},
		},

		{
			name: "catalog_classify",
			description:
				"用模型给插件/Skill 自动打标签（purpose 做什么 / context 用在哪里）。会把**自定义标签的解释**一起喂给模型，并按解释判断。" +
				"不会覆盖你手标过的条目。不传 id 时只处理「还没打任何标签」的条目。",
			parameters: compileParameters({
				ids: { type: "array", items: { type: "string" }, description: "只处理这些条目 id（省略 = 只处理没标签的）" },
			}),
			output: TOOL_OUTPUT,
			async execute(args = {}) {
				await service.rebuildIfCold();
				const result = await service.runClassify(Array.isArray(args.ids) ? args.ids : []);
				if (!result.ok) return withText({ ok: false, error: result.error, model: result.model }, ["分类失败：" + result.error]);
				return withText(result, [`已用 ${result.model} 给 ${result.applied} 个条目打标签（请求 ${result.requested} 个，跳过你手标过的 ${result.skipped.length} 个）`]);
			},
		},

		{
			name: "catalog_review",
			description:
				"审一遍某个插件（或全部自写/混血插件）：**缺口分析**（README 缺哪些章节、构建产物该不该入库、package.json 有无自包含安装命令、有没有把宿主核心包误写进 dependencies、Skill 的 description 够不够用）+ " +
				"**安全审核**（工作流 pull_request_target/workflow_run 是否执行 fork 代码、GITHUB_TOKEN 是否最小权限、可疑 eval/spawn、依赖线索），按「文件+行号」给发现并按置信度排序。" +
				"只出建议，不改代码、不推送。",
			parameters: compileParameters({
				name: { type: "string", description: "插件名（例如 dsh-screenshot）。省略 = 审全部自写/混血插件" },
				scope: { type: "string", enum: ["both", "gap", "security"], description: "跑哪一半（默认 both）" },
			}),
			output: TOOL_OUTPUT,
			async execute(args = {}) {
				await service.rebuildIfCold();
				const scope = String(args.scope || "both");
				const name = String(args.name || "");
				const catalog = service.filteredCatalog(name);
				if (name !== "" && (!catalog.plugins || catalog.plugins.length === 0)) {
					const known = (service.catalog?.plugins || []).map((plugin) => plugin.name);
					const close = known.filter((candidate) => candidate.includes(name.replace(/^plugin:/, ""))).slice(0, 6);
					return withText({ ok: false, error: "找不到插件：" + name, close }, ["找不到插件：" + name + (close.length ? "。相近的有：" + close.join("、") : "")]);
				}
				const lines = [];
				const payload = { ok: true, name: name || "全部自写/混血插件" };
				if (scope === "both" || scope === "gap") {
					const gap = await service.runGap(catalog);
					payload.gap = gap.summary;
					lines.push(`缺口分析：${gap.summary.repos} 个仓，high ${gap.summary.high} / medium ${gap.summary.medium} / low ${gap.summary.low}`);
					for (const item of gap.summary.items.slice(0, 20)) lines.push(`- [${item.severity}] ${item.repo}｜${item.finding}｜建议：${item.suggestion}`);
					if (gap.summary.items.length === 0) lines.push("（没有发现缺口）");
				}
				if (scope === "both" || scope === "security") {
					const security = await service.runSecurity(catalog);
					payload.security = security.summary;
					lines.push("", `安全审核：${security.summary.repos} 个仓，high ${security.summary.high} / medium ${security.summary.medium} / low ${security.summary.low}`);
					for (const item of security.summary.items.slice(0, 20)) lines.push(`- [${item.severity} conf=${item.confidence}] ${item.repo} ${item.file}:${item.line}｜${item.title}｜可采纳：${item.accept}｜可拒绝：${item.reject}`);
					if (security.summary.items.length === 0) lines.push("（没有发现）");
					lines.push("", "边界说明：私有仓拿不到 GitHub 的 Secret Scanning / Dependabot / Push Protection（需付费 GHAS），依赖高危只能靠本地判断。");
				}
				return withText(payload, lines);
			},
		},

		{
			name: "catalog_publish",
			description:
				"把自写/混血插件与自写 Skill 备份到 GitHub **私有仓**。三档：" +
				"action=plan 出计划（新建/更新/已同步、密钥扫描结果、README 英文版需求，**不动任何东西**）；" +
				"action=apply 执行计划（必须带 planId + confirm:true，密钥命中的仓自动跳过、其余照推、不 force push）；" +
				"action=public 把某个仓改为公开（必须 confirm:true，且会**先重扫一遍**，有命中直接拒绝）。" +
				"默认所有仓私有。自写仓名 dsh-<name>，混血 dsh-<name>-local。",
			parameters: compileParameters({
				action: { type: "string", enum: ["plan", "apply", "public"], description: "plan 只出计划 / apply 执行 / public 改公开", required: true },
				planId: { type: "string", description: "apply 时必填：plan 返回的 planId" },
				confirm: { type: "boolean", description: "apply / public 必须 true —— 表示你已经看过计划并同意" },
				repo: { type: "string", description: "public 时的仓库名（不含 owner）" },
				translate: { type: "boolean", description: "apply 时是否生成英文 README（默认 true，没有需要译的内容时不会生成）" },
				ackRepos: {
					type: "array",
					items: { type: "string" },
					description:
						"apply 时点名「这些仓的命中我看过、确认是测试夹具，允许本次推送」。只在计划里这类仓被标成 blocked-secrets 时才需要；不传则一律跳过。",
				},
			}),
			output: TOOL_OUTPUT,
			async execute(args = {}) {
				await service.rebuildIfCold();
				const action = String(args.action || "plan");
				if (action === "plan") {
					const result = await service.planUpload();
					if (!result.ok) return withText(result, [result.error]);
					const plan = result.plan;
					const lines = [
						`计划（${plan.items.length} 个仓；gh 用户：${plan.login || "未登录"}）`,
						`新建 ${plan.summary.create}｜更新 ${plan.summary.update}｜已同步 ${plan.summary.upToDate}｜因密钥跳过 ${plan.summary.blocked}｜错误 ${plan.summary.needsAttention}`,
						"",
					];
					for (const item of plan.items) {
						lines.push(`- [${item.action}] ${item.repo}（${item.kind === "skills" ? "Skill 集合" : item.source}）${item.reasons.length ? "｜" + item.reasons.join("；") : ""}`);
						if (item.scan && item.scan.hits.length > 0) {
							for (const hit of item.scan.hits.slice(0, 6)) lines.push(`    ⚠️ ${hit.file}:${hit.line} ${hit.rule} ${hit.sample} —— ${hit.plain}`);
						}
					}
					lines.push("", `确认后调用 catalog_publish action=apply planId=${plan.planId} confirm=true。`);
					return withText({ ok: true, plan }, lines);
				}
				if (action === "apply") {
					if (args.confirm !== true) return withText({ ok: false, error: "需要 confirm:true" }, ["需要 confirm:true —— 先 plan 看一遍再推。"]);
					const result = await service.applyUpload({ planId: String(args.planId || ""), confirm: true, translate: args.translate !== false, ackRepos: Array.isArray(args.ackRepos) ? args.ackRepos : [] });
					if (!result.ok) return withText(result, [result.error || "执行失败"]);
					const r = result.result;
					const lines = [
						`推送完成：成功 ${r.pushed}｜已同步 ${r.upToDate}｜跳过 ${r.skipped}｜失败 ${r.failed}`,
					];
					for (const item of r.results) lines.push(`- [${item.status}] ${item.repo}${item.transport ? "（" + item.transport + "）" : ""}${item.reason ? "｜" + item.reason : ""}${item.readmeNote ? "｜" + item.readmeNote : ""}`);
					if (r.notPushed.length > 0) {
						lines.push("", "**未推清单**（处理完再跑一次）：");
						for (const item of r.notPushed) lines.push(`- ${item.repo}：${item.reason}`);
					}
					return withText(result, lines);
				}
				if (action === "public") {
					if (args.confirm !== true) return withText({ ok: false, error: "公开需要 confirm:true" }, ["公开是不可逆的可见性变更，必须显式 confirm:true，且会先重扫一遍。"]);
					const result = await service.publishPublic({ repo: String(args.repo || ""), confirm: true });
					return withText(result, result.ok ? ["已改为公开：" + result.url, result.accountNote] : ["公开失败：" + (result.error || "")]);
				}
				return withText({ ok: false, error: "未知 action" }, ["未知 action"]);
			},
		},

		{
			name: "catalog_export",
			description:
				"把当前目录快照导出成 Markdown 报告（插件/Skill 清单、来源四分类、调用 Top、自写/混血仓库与 git 状态、待标记来源、归属覆盖率、每周发现），写到数据目录的 reports/ 下。" +
				"换会话交接、写 README、给自写插件补文档、留证据时用它 —— 报告数字与面板**同源**，不会出现两套口径。",
			parameters: compileParameters({
				top: { type: "number", description: "调用 Top 多少条（默认 20，范围 5–60）" },
				path: { type: "string", description: "输出路径（省略 = <数据目录>/reports/catalog-<时间戳>.md 或 .csv）" },
				format: { type: "string", enum: ["md", "csv"], description: "md（默认）= 完整 Markdown 报告；csv = **全部条目一行一条**的表格（带 UTF-8 BOM，Excel 直接打开不乱码）" },
			}),
			output: TOOL_OUTPUT,
			async execute(args = {}) {
				await service.rebuildIfCold();
				const format = String(args.format || "md").toLowerCase() === "csv" ? "csv" : "md";
				const result = await service.exportReport({ top: args.top, path: args.path, format });
				if (result.ok === false) return withText({ ok: false, error: result.error }, ["导出失败：" + result.error]);
				if (format === "csv") {
					return withText(
						{ ok: true, format: "csv", path: result.path, rows: result.rows, bytes: result.bytes, columns: result.summary.columns },
						[
							`已导出 CSV：${result.path}（${result.rows} 行 / ${(result.bytes / 1024).toFixed(1)} KB）`,
							`列：${result.summary.columns.join(" | ")}`,
							"",
							result.preview,
							"",
							"（上面只是前 12 行；完整内容在文件里。带 BOM，Excel 打开中文不乱码。）",
						],
					);
				}
				return withText(
					{ ok: true, path: result.path, bytes: result.bytes, summary: result.summary },
					[
						`已导出：${result.path}（${(result.bytes / 1024).toFixed(1)} KB）`,
						`插件 ${result.summary.plugins} / Skill ${result.summary.skills}｜调用 ${formatCalls(result.summary.calls)}｜待标记 ${result.summary.askUser}`,
						"",
						result.preview,
						"",
						"（上面只是开头 900 字，完整内容在文件里。）",
					],
				);
			},
		},

		{
			name: "catalog_health",
			description:
				"目录面板自检：现在是哪一版代码、路径解析对不对（工作区/profile/数据目录）、统计缓存覆盖多少会话/多少调用、工具归属覆盖率、后台任务状态、每次每周任务的时间、AI 通道是否可用。换会话接手或面板行为异常时先跑它。",
			parameters: compileParameters({}),
			output: TOOL_OUTPUT,
			async execute() {
				const health = await service.health();
				const lines = [
					`构建：${health.build.label}（最新文件 ${health.build.newestFile || "?"}）`,
					/* R18：磁盘 vs 运行中。不一致不是坏，是"这次改动还没生效" —— 说清下一步，别让人猜 */
					health.loaded
						? health.loaded.stale
							? `⚠️ 运行中仍是 ${health.loaded.version || "?"}，磁盘已是 ${health.loaded.disk || "?"} —— **重载插件或重启 DSH 之后新代码才生效**（新工具/新路由现在还不存在）`
							: `运行中：${health.loaded.version || "?"}（与磁盘一致，改动已生效）`
						: "运行中：旧版本没有这个字段（重载一次就有了）",
					`宿主：dsh ${health.host.dsh || "?"} / dsh-tools ${health.host.dshTools || "?"} / node ${health.host.node}`,
					`工作区：${health.workspace || "(未解析)"}`,
					`profile：${health.profileDir || "(未解析)"}`,
					`数据目录：${health.dataDir}`,
					`工具：注册 ${health.toolsRegistered} 个（catalog_*）`,
					health.catalog ? `目录：插件 ${health.catalog.plugins} / Skill ${health.catalog.skills} / 官方(asar) ${health.catalog.officialFromAsar}` : "目录：还没建好",
					/* R19：变化追踪能不能看见 Skill 正文改动，取决于这个覆盖率 */
					health.skillHashes && health.skillHashes.total > 0 ? `正文指纹：Skill ${health.skillHashes.hashed}/${health.skillHashes.total} 有内容哈希${health.skillHashes.hashed < health.skillHashes.total ? "（缺的条目看不见正文改动，重建目录一次）" : ""}` : "",
					health.asar ? `asar：${health.asar.reachable ? "可读" : "读不到（官方插件会显示 0 个）"}${health.asar.path ? " · " + health.asar.path : ""}` : "",
					/* R31c：传输代价 —— 这条以前只能靠 curl 手量，现在 health 自己报 */
					health.transport
						? `传输：上次 /state ${health.transport.rawBytes} 字节${health.transport.gzipped ? ` → gzip ${health.transport.packedBytes} 字节（${Math.round(health.transport.ratio * 1000) / 10}%，${(health.transport.rawBytes / Math.max(health.transport.packedBytes, 1)).toFixed(2)}×）` : "（这次没压缩：客户端没带 accept-encoding: gzip）"}`
						: "传输：这个进程还没发过 /state（打开一次面板就会被量到）",
					health.stats ? `统计：${health.stats.sessions} 会话 / ${health.stats.calls} 调用 / ${health.stats.windowDays} 天 / 耗时 ${health.stats.durationMs}ms / 去重 ${health.stats.duplicateCalls}` : "统计：缓存还没有（首次打开会自动算）",
					health.attribution ? `归属：${health.attribution.byDescription} 条靠描述指纹、${health.attribution.byName} 条靠名字、${health.attribution.host} 条判为宿主、${health.attribution.unknown} 条未知` : "归属：未建",
					health.dependency ? `依赖图：${health.dependency.scanned} 个包 / ${health.dependency.direct} 个直接依赖 / ${health.dependency.orphanHint} 个「无人依赖」候选（候选不是结论，删前 npm ls 确认）` : "依赖图：目录还没建好",
					/* R12：加载路径。`enabled`（在不在 bundles）不是加载判据 —— 这里给四态的真实分布 */
					health.dependency && health.dependency.loadCounts
						? `加载路径：${health.dependency.loadRoots} 个入口（bundles + ${health.dependency.compositionFiles} 份组合文件）/ 直接 ${health.dependency.loadCounts.bundle}、配置挂载 ${health.dependency.loadCounts.config}、随依赖 ${health.dependency.loadCounts.transitive}、**不在任何入口上 ${health.dependency.loadCounts.dormant}**`
						: "加载路径：目录还没建好（旧快照没有 loadState；重建一次即可）",
					/* R22：配置层（声明层）。它回答的是"入口从哪来"，与上面四态是两件事
					   —— 本机 260+ 条顶层条目里 190+ 个官方 asar 包不在 profile 里，四态看不见它们 */
					health.composition ? health.composition.line : "配置层：还没读（没有组合文件或读失败）",
					health.sizes
						? `体积：已量 ${health.sizes.count} 条 / 合计 ${formatBytes(health.sizes.totalBytes)}（${formatTime(health.sizes.at)}）` + (health.sizes.truncated > 0 ? `｜${health.sizes.truncated} 条超过预算只算到一部分` : "")
						: "体积：还没量（面板点「量体积」或 POST /refresh {what:\"sizes\"}；卡片体积与排序靠它）",
					`任务：${health.job.running ? "在跑 " + health.job.kind + " " + health.job.progress.done + "/" + health.job.progress.total : "空闲"}`,
					`每周任务：缺口 ${health.weekly.lastGapAt ? formatTime(health.weekly.lastGapAt) : "从未跑"} / 安全 ${health.weekly.lastSecurityAt ? formatTime(health.weekly.lastSecurityAt) : "从未跑"}`,
					/* R17：变化追踪 —— 有的机器上「第一条快照」会一直是 0，也要如实说出来 */
					health.changes
						? health.changes.first
							? `变化：还没有可比的历史（第一条快照 ${formatTime(health.changes.at)}，${health.changes.counts.total} 处）—— 下次目录重建后这里会出现「自上次以来变了什么」`
							: `变化：自 ${formatTime(health.changes.baselineAt)} 起 ${health.changes.counts.total} 处（新增 ${health.changes.counts.added} / 消失 ${health.changes.counts.removed} / 升版 ${health.changes.counts.version} / 来源变 ${health.changes.counts.source} / 加载态变 ${health.changes.counts.loadState} / 被编辑 ${health.changes.counts.edited} / 配置层 ${health.changes.counts.composition || 0}），共 ${health.changes.snapshots} 条快照`
						: "变化：还没记录（等一次目录重建）",
					health.ack
						? `变化确认：已于 ${formatTime(health.ack.at)} 标记看过（基线 ${health.ack.entries} 条）；自那以来 ${health.ack.since ? health.ack.since.total : "?"} 处（新增 ${health.ack.since?.added ?? 0} / 消失 ${health.ack.since?.removed ?? 0} / 升版 ${health.ack.since?.version ?? 0} / 来源变 ${health.ack.since?.source ?? 0} / 加载态变 ${health.ack.since?.loadState ?? 0} / 被编辑 ${health.ack.since?.edited ?? 0} / 配置层 ${health.ack.since?.composition ?? 0}）`
						: "变化确认：还没标记过（面板变化条上点「标记已看过」可把确认窗口清零）",
					/* R21：更早窗口能回看到哪 —— 面板「历史」入口 / 报告「历史」一节 */
					health.timeline && health.timeline.total > 1
						? `历史：共 ${health.timeline.total} 条快照 / ${health.timeline.windows} 个窗口可回看（面板变化条下方「历史」；导出报告也有这一节）`
						: "历史：只有基线一条快照，还没有可回看的窗口",
					`AI：${health.ai.model.provider}/${health.ai.model.model}，通道${health.ai.available ? "可用" : "不可用"}`,
				];
				if (health.warnings.length > 0) for (const warning of health.warnings) lines.push(`⚠️ ${warning.file}：${warning.issue}`);
				try {
					const plan = await service.stagedSkillPlan();
					lines.push(`副本：${plan.count} 个 Skill 的 staging 是旧的` + (plan.count > 0 ? "（catalog_skill_sync 出计划 / apply 同步）" : ""));
				} catch (error) {
					lines.push("副本：检查失败（" + String(error?.message ?? error) + "）");
				}
				return withText(health, lines);
			},
		},

		{
			name: "catalog_handoff",
			description:
				"交接单：把「换会话之前必须对上的几件事」压成一个结论 —— 磁盘 vs 运行中（含重启提醒）、catalog_* 工具数、" +
				"配置层缺口、变化与确认、历史快照、Skill staging 是否旧、最新一次 dev/ship 体检、git 头部/脏文件/未推送、" +
				"最新目录快照报告。默认只读；`write:true` 时另存一份 `reports/handoff-<时间戳>.md`。换会话前跑它，" +
				"比逐项看 health 更不容易漏（R26：判断在 lib/handoff.mjs，纯函数、有合成数据探针）。",
			parameters: compileParameters({
				write: { type: "boolean", description: "true = 同时把交接单写成 reports/handoff-<时间戳>.md（默认只读）" },
			}),
			output: TOOL_OUTPUT,
			async execute(args = {}) {
				const result = await service.handoffReport({ write: args.write === true });
				const report = result.report;
				const lines = [
					`结论：**${report.verdict}**（ok ${report.counts.ok} / warn ${report.counts.warn} / bad ${report.counts.bad}）`,
					"",
				];
				for (const check of report.checks) lines.push((check.status === "ok" ? "✅" : check.status === "bad" ? "❌" : "⚠️") + ` ${check.label}：${check.detail}`);
				if (report.next.length > 0) {
					lines.push("", "下一步：");
					for (const item of report.next) lines.push("- " + item);
				} else if (report.verdict === "ok") {
					lines.push("", "全部核对通过 —— 可以直接换会话。");
				} else {
					lines.push("", "没有必须处理的待办 —— 上面的 ⚠️ 只是提示（配置层缺口 / 有未确认的变化），不阻塞交接。");
				}
				if (result.path) lines.push("", `交接单已写入：${result.path}`);
				return withText({ ok: true, verdict: report.verdict, counts: report.counts, checks: report.checks, next: report.next, path: result.path }, lines);
			},
		},

		{
			name: "catalog_skill_sync",
			description:
				"检查并同步 **Skill 的两份副本**：DSH 实际加载的 `.dsh/skills/<name>/SKILL.md` 与上传用的 staging（`.gh-upload/<技能仓>/<name>`）。" +
				"两者不一致时，`catalog_publish` 推上去的其实是**旧版**（R20 起按正文哈希判，同字数改一个字也认得出）。默认只出计划（不写盘）；" +
				"`action=apply` 带 `confirm:true` 才做**单向 live → staging**，写前把被覆盖的 staging 文件备份成 `SKILL.md.bak-<时间戳>`。" +
				"`action=restore` 是它的反向：把 staging 还原到最近一份历史备份（同样先出计划、confirm 才写；只动 staging，不动加载的那份）。",
			parameters: compileParameters({
				action: { type: "string", enum: ["plan", "apply", "restore"], description: "plan 只出同步计划（默认）/ apply 真正同步 live → staging（必须同时给 confirm）/ restore 还原 staging 到最近备份（不给 confirm 只出计划）" },
				ids: { type: "array", items: { type: "string" }, description: "只处理这些 Skill id（如 skill:vex-ops）；省略 = 所有不一致的（restore 时 = 所有有备份的）" },
				backup: { type: "string", description: "restore 专用：点名还原到**哪一份**备份 —— `SKILL.md.bak-<时间戳>` 或裸时间戳；省略 = 最近一份。可选名单在 plan 返回的 items[].backups 里" },
				confirm: { type: "boolean", description: "apply / restore 写盘时必须为 true，表示你确认要覆盖 staging" },
			}),
			output: TOOL_OUTPUT,
			async execute(args = {}) {
				const ids = Array.isArray(args.ids) ? args.ids.map(String) : [];
				const action = String(args.action || "plan");
				if (action === "restore") {
					const backup = args.backup ? String(args.backup) : "";
					if (args.confirm === true) {
						const result = await service.restoreStagedSkills({ ids, backup, apply: true, confirm: true });
						if (!result.ok) return withText(result, [`还原失败：${result.error || "未知错误"}`]);
						const lines = [
							`已还原 ${result.count} 个 Skill 的 staging（backup → staging，时间戳 ${result.stamp}）`,
							`还原前的那份已另存 ${result.backups.length} 份（.bak-${result.stamp}）；DSH 加载的那份没动`,
						];
						if (result.unchanged.length > 0) lines.push(`无需还原 ${result.unchanged.length} 个（备份与当前内容一致）`);
						if (result.failed.length > 0) lines.push(`失败 ${result.failed.length} 个：` + result.failed.map((item) => item.name + "（" + item.error + "）").join("、"));
						return withText(result, lines);
					}
					const plan = await service.restoreStagedSkillPlan(ids, { backup });
					const lines = [`还原计划：${plan.count} 个 Skill 可以把 staging 还原到${backup ? "指定的 " + backup : "最近"}备份（方向 ${plan.direction}）`];
					if (plan.count > 0) {
						lines.push("写盘要带 action=restore 且 confirm:true；写前会把 staging 当前那份另存成 .bak-<新时间戳>。");
					} else if (Array.isArray(plan.skipped) && plan.skipped.length > 0) {
						/* R28：不能笼统说「没有可还原的」—— 点名的那份不存在、和「内容一致无需还原」是两件事，
						   前者的下一步是换一份名字，后者是别再动了。 */
						lines.push(`没有可还原的：${plan.skipped.slice(0, 3).map((item) => String(item.name || "") + "（" + String(item.reason || "") + "）").join("；")}`);
					} else {
						lines.push("没有可还原的备份。");
					}
					if (plan.count > 0) {
						lines.push("");
						for (const item of plan.items) {
							lines.push(`- ${item.name}：[${item.verdict}] ← ${item.backupStamp}（${item.backupBytes} B）`);
							if (Array.isArray(item.backups) && item.backups.length > 1) {
								lines.push(
									"  可选的更早备份：" +
										item.backups.slice(0, 5).map((choice) => choice.stamp + (choice.sameAsStaged ? "(=当前)" : "")).join("、") +
										`（共 ${item.backupCount} 份；用 backup=<stamp> 点名）`,
								);
							}
						}
					}
					return withText(plan, lines);
				}
				if (action === "apply") {
					const result = await service.syncStagedSkills({ ids, apply: true, confirm: args.confirm === true });
					if (!result.ok) return withText(result, [`同步失败：${result.error || "未知错误"}`]);
					const lines = [
						`已同步 ${result.count} 个 Skill（live → staging，时间戳 ${result.stamp}）`,
						`备份 ${result.backups.length} 份（被覆盖的 staging 文件已改名 .bak-${result.stamp}）`,
					];
					if (result.failed.length > 0) lines.push(`失败 ${result.failed.length} 个：` + result.failed.map((item) => item.name + "（" + item.error + "）").join("、"));
					lines.push("", "下一步：catalog_publish action=plan 看要不要推上 GitHub。");
					return withText(result, lines);
				}
				const plan = await service.stagedSkillPlan(ids);
				const lines = [
					`计划：${plan.count} 个 Skill 的 staging 是旧的（方向 ${plan.direction}）`,
					plan.count > 0 ? "写盘要带 apply:true 且 confirm:true；写前会备份 staging 里被覆盖的文件。" : "没有需要同步的 Skill。",
				];
				if (plan.count > 0) {
					lines.push("");
					for (const item of plan.items) lines.push(`- ${item.name} [${item.verdict}] ${item.differs.join("、") || "时间不同"}`);
				}
				if (plan.skipped.length > 0) {
					lines.push("", `跳过 ${plan.skipped.length} 个：`);
					for (const item of plan.skipped.slice(0, 8)) lines.push(`- ${item.name}：${item.reason}`);
				}
				return withText(plan, lines);
			},
		},
		{
			name: "catalog_uninstall",
			description:
				"生成「不会被加载」（dormant）那些包的**处置清单**：按弱连通分量分组，逐组给出可回收体积、分类（实体目录 / 被 profile 依赖钉住 / 链接到工作区 / 同项目第二份）与操作步骤。" +
				"**只生成、绝不执行删除** —— 命令是给人复制粘贴的；action=write 才把清单写成 `reports/uninstall-*.md|.json`（要 confirm:true）。" +
				"action=simulate 在**内存里**把包从依赖图上摘掉、重算加载态，回答「真删了会不会有入口指空 / 还有谁声明着它们」——同样不动盘、不删目录。" +
				"action=verify 是它的**反向**：拿一份已经存在的计划，与**今天**的磁盘/声明事实对账 —— 哪些目录真的没了、哪些删了等于白删（还被 `bundles` / 配置条目 / `profile` 依赖键引用，会被装回来或指空）、哪些计划已经过期（今天它已经会被加载 / 组外已经有包声明它）。只算不写盘，带 confirm:true 才落一份 `reports/uninstall-verify-*.md`。" +
				"三条要点：被 profile 依赖钉住的，只删目录没用（`pnpm install` 会装回来）；junction 删了不省空间；同项目第二份删了不影响加载。",
			parameters: compileParameters({
				action: { type: "string", enum: ["plan", "write", "simulate", "verify"], description: "plan 只出清单（默认）/ write 把清单写成两份文件（必须同时给 confirm）/ simulate 预演「按这份清单删会怎样」（只算不删）/ verify 拿一份计划与今天的磁盘事实**对账**（只算不写盘；带 confirm:true 才落一份对账报告）" },
				confirm: { type: "boolean", description: "write 时必须为 true；verify 时带 true 表示允许落一份 `reports/uninstall-verify-*.md`" },
				packages: { type: "array", items: { type: "string" }, description: "simulate 时点名要删的**包名或目录名**（省略 = 按整份清单预演；同项目第二份有两份目录时，点名目录才只删那一份）" },
				planPath: { type: "string", description: "verify 时对账哪一份计划：`reports/` 下的文件名（如 `uninstall-20261024-0047.json`）。省略 = 本次会话算过的那份，再否则 `reports/` 里最新一份" },
			}),
			output: TOOL_OUTPUT,
			async execute(args = {}) {
				const action = String(args.action || "plan");
				const fmtB = (bytes) => {
					const n = Number(bytes) || 0;
					if (n < 1024) return n + " B";
					if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
					return (n / 1024 / 1024).toFixed(2) + " MB";
				};
				/* R16：删除预演 —— 只算不删。回答的是「真删了会不会有东西指空」，不是「该不该删」。 */
				if (action === "simulate") {
					const result = await service.simulateUninstall({ packages: Array.isArray(args.packages) ? args.packages.map(String) : [] });
					if (result.ok === false) return withText(result, [`预演失败：${result.error || "未知错误"}`]);
					const counts = (value) => `bundle ${value.bundle || 0} / config ${value.config || 0} / 随依赖 ${value.transitive || 0} / 不加载 ${value.dormant || 0}`;
					const lines = [
						`删除预演（只算不删）：摘掉 ${result.remove.length} 个包${result.unknown.length > 0 ? `（另有 ${result.unknown.length} 个不在已装清单：${result.unknown.slice(0, 5).join("、")}）` : ""}`,
						`结论：${result.verdict === "safe" ? "**安全** —— 没有入口指空、没有保留的包声明它们" : "**有风险** —— 见下面三条"}`,
						`- 现在会被加载的（本来就不该删）：${result.breaking.length === 0 ? "无" : result.breaking.slice(0, 8).map((item) => `${item.name}（${item.state}${item.via ? " · " + item.via : ""}）`).join("、")}`,
						`- 删完会指空的入口：${result.brokenEntries.length === 0 ? "无" : result.brokenEntries.slice(0, 8).map((item) => `${item.name}（${item.why}${item.id ? " " + item.id : ""}）`).join("、")}`,
						`- 仍声明它们的包：${result.dangling.length === 0 ? "无" : result.dangling.slice(0, 8).map((item) => `${item.from} → ${item.dep}`).join("、")}${result.dangling.length > 8 ? ` 等 ${result.dangling.length} 条` : ""}`,
						`- 只因它们才被点亮的：${result.demoted.length === 0 ? "无" : result.demoted.slice(0, 8).map((item) => item.name).join("、")}${result.demoted.length > 0 ? " —— 删完会掉回「不加载」，还得再清一轮" : ""}`,
						`加载态 ${counts(result.before.counts)} → ${counts(result.after.counts)}`,
						`可回收 ${fmtB(result.bytes?.reclaimBytes || 0)}${(result.bytes?.whyZero || []).length > 0 ? `（其中 ${result.bytes.whyZero.length} 个删了省 0 B：${result.bytes.whyZero.map((item) => item.dirName).join("、")}）` : ""}`,
					];
					if (!result.listed) lines.push("（按整份处置清单预演；想只试一个包就传 packages）");
					lines.push("边界：判据是**声明层面**（运行时按路径 `require()` 看不见）；`仍声明它们的包` 里含 optional/peer，那一类可能只是软依赖，要人看一眼。本操作不动盘、不删任何目录。");
					return withText({ ok: true, ...result }, lines);
				}
				/* R27：对账 —— 拿一份**已经存在的计划**与今天的磁盘/声明事实比对。
				   与 simulate 正好互为前后：simulate 问"删了会怎样"，verify 问"删完之后到底怎样"。 */
				if (action === "verify") {
					const planPath = String(args.planPath || "");
					const result = args.confirm === true ? await service.writeVerifyReport({ confirm: true, planPath }) : await service.verifyUninstall({ planPath });
					if (result.ok === false) return withText(result, [`对账失败：${result.error || "未知错误"}`]);
					const counts = result.counts || {};
					const days = result.ageMs > 0 ? (result.ageMs / 86400000).toFixed(1) + " 天前" : "本次会话算的";
					const reasonOf = (row) => [...(row.reasons || []), ...(row.drift || [])].map((kind) => VERIFY_REASON[kind] || kind).join("；");
					const names = (list, limit = 6) =>
						list.length === 0 ? "无" : list.slice(0, limit).map((row) => "`" + row.dirName + "`").join("、") + (list.length > limit ? ` 等 ${list.length} 个` : "");
					const lines = [
						`对账（不动盘）：计划 ${days} · 成员 ${counts.total || 0} 个（来源 ${result.from || "?"}）`,
						`结论：**${VERIFY_VERDICT[result.verdict] || String(result.verdict || "")}**`,
						`- 已不在盘上 ${counts.gone || 0} 个 / 还在 ${counts.still || 0} 个；已回收 ${fmtB(counts.reclaimedBytes || 0)}，还能回收 ${fmtB(counts.remainingBytes || 0)}`,
						`- 白删（会被装回来 / 入口指空）：${names(result.fakeGone || [])}${(result.fakeGone || []).length > 0 ? " —— " + (result.fakeGone || []).map(reasonOf).join("；") : ""}`,
						`- 计划过期：${names(result.drift || [])}${(result.drift || []).length > 0 ? " —— " + (result.drift || []).map((row) => `${row.dirName}：${reasonOf(row)}`).join("；") : ""}`,
					];
					if (result.verdict === "intact") lines.push("（一个都还在：这份计划还没被执行。按清单动手之后再回来对一次。）");
					if (result.verdict === "fake") lines.push("★ 先把引用摘干净（`bundles` / 配置条目 / `profile` 依赖键），否则删了会被装回来、或启动时入口指空。");
					lines.push("", "边界：" + (result.boundaries || []).join(" "));
					if (args.confirm === true) lines.push(`已写报告：\`${result.mdPath}\``);
					else lines.push("要文件：action=verify confirm=true（写 `reports/uninstall-verify-*.md`）。");
					return withText({ ok: true, ...result }, lines);
				}
				if (action === "write") {
					const result = await service.writeUninstallReport({ confirm: args.confirm === true });
					if (!result.ok) return withText(result, [`写清单失败：${result.error || "未知错误"}`]);
					return withText(result, ["已写入：", `- \`${result.mdPath}\``, `- \`${result.jsonPath}\``, `（${result.bytes} 字节；清单里的命令要人自己确认后再跑）`]);
				}
				const summary = await service.runUninstall({});
				const plan = service.lastUninstall || {};
				const dormant = plan.dormant || {};
				const fmt = (bytes) => {
					const n = Number(bytes) || 0;
					if (n < 1024) return n + " B";
					if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
					return (n / 1024 / 1024).toFixed(2) + " MB";
				};
				const lines = [
					`处置清单（只生成、不执行）：候选目录 ${dormant.dirCandidates || 0} 个 / ${dormant.groups || 0} 组，可回收 ${fmt(dormant.reclaimBytes)}`,
					dormant.linkBytes > 0 ? `另有 ${fmt(dormant.linkBytes)} 是 junction 指向的工作区/外部目录 —— 删链接不省这部分` : "",
				];
				for (const group of (plan.groups || []).slice(0, 12)) {
					const flags = [];
					if (group.pinnedCount > 0) flags.push("先摘 profile 依赖");
					if (group.duplicate) flags.push("同项目第二份");
					if (group.linkCount > 0) flags.push("含链接（删了省 0 B）");
					lines.push(`- ${group.label} · 可回收 ${fmt(group.reclaimBytes)}${flags.length > 0 ? " · " + flags.join(" / ") : ""}`);
				}
				lines.push("", "边界：判据是**声明层面**（运行时动态 require 看不见）；hoisted 下未声明的 `require('x')` 仍可能命中，删纯库前先 `pnpm why`；只处置 node_modules 顶层目录。");
				lines.push("要文件：action=write confirm=true（写 `reports/uninstall-*.md|.json`）。命令由人确认后再跑。");
				return withText(
					{
						ok: summary.ok !== false,
						...summary,
						groups: (plan.groups || []).map((group) => ({
							label: group.label,
							count: group.count,
							reclaimBytes: group.reclaimBytes,
							pinnedCount: group.pinnedCount,
							duplicate: group.duplicate,
							linkCount: group.linkCount,
							steps: group.steps.map((step) => step.kind),
						})),
					},
					lines,
				);
			},
		},
		{
			name: "catalog_composition",
			description:
				"读**配置层的声明**：`cordis.yml` / `cordis.patch.yml` 的顶层条目 —— 每条从哪份文件来、" +
				"挂的是包 / 子路径 / `file://` 路径 / `cordis:group` 分组、那个包在 profile 里还是官方 asar 里、" +
				"有没有被 `disabled: true` 关掉、`!!js` 条件表达式是什么；另外核对 `dsh.profile.bundles` 里有没有点名却不存在的包。" +
				"回答「配置里到底挂了什么」「这条 disabled 是真的关了吗」「bundles 里有没有指空」。只读。" +
				"**不展开 bundle 自带的 patch 层**、`!!js` 表达式**不求值** —— 所以「关掉」是声明不是结论；" +
				"组合条目「静态查不到」也不等于一定坏（运行期注入的虚拟模块看不见）。",
			parameters: compileParameters({
				view: {
					type: "string",
					enum: ["overview", "entries", "missing", "disabled", "conditional"],
					description: "overview 只给计数与缺口（默认）/ entries 逐条列出生效条目 / missing 只列静态查不到的 / disabled 只列关掉的 / conditional 只列条件启用的",
				},
				limit: { type: "number", description: "最多列几条（默认 40，上限 200）" },
			}),
			output: TOOL_OUTPUT,
			async execute(args = {}) {
				const view = String(args.view || "overview");
				const limit = Math.min(200, Math.max(1, Number(args.limit) || 40));
				const report = await service.compositionAudit();
				const short = (row) =>
					`${row.name || "（无 name）"}${row.kind === "subpath" ? "（子路径）" : ""}` +
					` · ${row.id || "（无 id）"} · ${String(row.file || "").split(/[\\/]/).pop()}:${row.line}` +
					` · ${row.resolution}${row.state === "off" ? " · 已关掉" : row.state === "conditional" ? " · 条件启用" : ""}`;
				const lines = [summarizeComposition(report)];
				if (view === "overview") {
					lines.push(
						`缺口：bundles 真的缺 ${report.bundlesMissing.length} 个（宿主启用会失败）/ 组合条目静态查不到 ${report.missing.length} 条` +
							(report.asarReadable ? "" : `（asar 读不到：另有 ${report.unjudged.length} 条无法判定，不算缺）`),
						`声明分布：关掉 ${report.counts.byState.off} / 条件启用 ${report.counts.byState.conditional}（不求值）/ 按路径 ${report.counts.byKind.file} / 分组 ${report.counts.byKind.group} / 只按 id 覆盖 ${report.counts.byKind["id-only"]} / 被 patch 覆盖 ${report.counts.patched}`,
					);
					for (const row of report.bundlesMissing.slice(0, 10)) lines.push(`- bundle 真的缺：${row.name}`);
					for (const row of report.missing.slice(0, 10)) lines.push(`- 静态查不到：${short(row)} —— ${row.why}`);
					lines.push("", "边界：只读声明；按 id 合并了两份文件（后者覆盖前者）；`disabled: true` 可能被 bundle 自带的 patch 层重新打开，本工具看不见那层。详细清单用 view=entries / disabled / conditional。");
				} else if (view === "entries") {
					lines.push("", `生效条目（按首次出现顺序，前 ${Math.min(limit, report.entries.length)} 条 / 共 ${report.entries.length} 条）：`);
					for (const row of report.entries.slice(0, limit)) lines.push(`- [${row.kind}] ${short(row)}`);
					if (report.entries.length > limit) lines.push(`（还有 ${report.entries.length - limit} 条；改 limit 或看 disabled / conditional）`);
				} else if (view === "missing") {
					if (report.bundlesMissing.length === 0 && report.missing.length === 0) lines.push("", "缺口：0 —— 每个 bundle 与每个包条目都能在 profile 或官方 asar 里找到。");
					for (const row of report.bundlesMissing.slice(0, limit)) lines.push(`- bundle 真的缺：${row.name}（宿主启用它时会失败）`);
					for (const row of report.missing.slice(0, limit)) lines.push(`- ${short(row)} —— ${row.why}`);
					if (!report.asarReadable) lines.push(`- asar 读不到：${report.unjudged.length} 条包条目无法判定（纯 node / 探针环境；在宿主里重跑才有结论）`);
				} else if (view === "disabled") {
					lines.push("", `关掉的条目（disabled: true，前 ${Math.min(limit, report.disabled.length)} 条 / 共 ${report.disabled.length} 条）：`);
					for (const row of report.disabled.slice(0, limit)) lines.push(`- ${short(row)}`);
					lines.push("", "这是**声明**：bundle 自带的 patch 层可能把它们重新打开（本机 tool-bash 就是一例），别照这张表说某个工具没启用。");
				} else {
					lines.push("", `条件启用的条目（\`!!js\` 表达式，不求值；前 ${Math.min(limit, report.conditional.length)} 条 / 共 ${report.conditional.length} 条）：`);
					for (const row of report.conditional.slice(0, limit)) lines.push(`- ${short(row)} —— \`${row.disabledRaw}\``);
				}
				const payload = compactComposition(report, limit);
				return withText({ ok: true, view, ...payload }, lines);
			},
		},
		{
			name: "catalog_mcp",
			description:
				"列出本机的 **MCP 服务器**（每台 = cordis 组合文件里一条 `@deepseek-ai/dsh-mcp-client` 条目：serverName / 传输方式 / 命令或 URL / 开或关 / 文件:行），" +
				"按来源三分类（官方 / 第三方 / 自己配置）计数，并把 `mcp__<serverName>__<tool>` 的调用按服务器归属 —— " +
				"还会指出**孤儿调用**（指向已经删掉/改名的服务器的历史调用）与**配置问题**（缺 serverName、重名、缺 command/url、transport 不认）。" +
				"一台都没有时会给出三种可抄的写法（自己配置 / 第三方 npx / streamable-http）。" +
				"`view=disable server=<名>` 还会给出**停用**那台的 patch 片段（只出文本，不写盘；改完要重启 DSH）。" +
				"回答「我配了哪些 MCP」「哪个 MCP 在报错」「mcp__x__y 是谁的工具」「怎么加一台」。只读，不联网。",
			parameters: compileParameters({
				view: {
					type: "string",
					enum: ["overview", "servers", "orphans", "problems", "template", "disable"],
					description: "overview 计数 + 状态（默认）/ servers 逐台列（含工具与调用）/ orphans 只列孤儿调用 / problems 只列配置问题 / template 给三种可抄写法 / disable 给「停用某一台」的 patch 片段（只出文本，不写盘）",
				},
				server: { type: "string", description: "只看某一台（按 serverName 精确匹配，可选）" },
			}),
			output: TOOL_OUTPUT,
			async execute(args = {}) {
				const view = String(args.view || "overview");
				const wanted = String(args.server || "").trim();
				await service.ensureMcp();
				const report = service.mcpReport;
				const digest = service.mcpDigest();
				const counts = report?.counts || { total: 0, bySource: {} };
				const servers = (report?.servers || []).filter((server) => wanted === "" || server.serverName === wanted);
				const lines = [summarizeMcp(report)];
				if (counts.total === 0) lines.push("（本机还没有配置任何 MCP 服务器 —— 想加一台看 view=template；改完要重启 DSH）");
				if (wanted !== "" && servers.length === 0) lines.push(`没有叫 \`${wanted}\` 的服务器。已知：${(report?.servers || []).map((server) => server.serverName || "(无名)").join("、") || "（一台都没有）"}`);

				if (view === "overview") {
					lines.push(
						"",
						`客户端包 ${report?.client?.package || "?"}：${report?.client?.present ? "在（" + (report.client.inAsar ? "官方 asar" : "profile") + "）" : "**缺失**"}　｜　资源包 ${report?.resources?.package || "?"}：${report?.resources?.present ? "在（" + (report.resources.rows || []).length + " 条声明）" : "不在"}`,
						`状态：启用 ${counts.on || 0} / 关掉 ${counts.off || 0} / 条件启用 ${counts.conditional || 0}　｜　配置问题 ${counts.withProblems || 0} 台 ${report?.problems?.length || 0} 条`,
						`调用（近 90 天）：mcp__* 共 ${digest.totalCalls || 0} 次${digest.orphans.calls > 0 ? `，其中 **孤儿 ${digest.orphans.calls} 次**（${digest.orphans.servers.join("、")}）` : ""}`,
					);
					for (const server of servers) {
						const usage = digest.byServer[server.serverName] || null;
						lines.push(
							`- [${mcpSourceText(server.source)}] \`${server.serverName || "(无名)"}\` · ${server.transport || "?"} · ${mcpStateText(server.state)} · 调用 ${formatCalls(usage?.calls || 0)} · 工具 ${usage?.tools?.length || 0}` +
								`${server.problems.length > 0 ? " · ⚠️ " + server.problems.length + " 个配置问题" : ""} · ${String(server.file || "").split(/[\\/]/).pop()}:${server.line}`,
						);
					}
					lines.push("", "边界：只读组合文件的**声明**；`env`/`headers` 的值不显示（只给键名），url 的凭据与 query 已隐藏。明细用 view=servers / orphans / problems / template。");
				} else if (view === "servers") {
					for (const server of servers) {
						const usage = digest.byServer[server.serverName] || null;
						lines.push(
							"",
							`### \`${server.serverName || "(无名)"}\`（${mcpSourceText(server.source)} · ${server.transport || "?"} · ${mcpStateText(server.state)}）`,
							`- 目标：\`${server.target}\``,
							`- 来源理由：${server.sourceWhy.join("；")}`,
							`- 位置：${server.file}:${server.line}${server.entryId ? " · 条目 id " + server.entryId : ""}`,
							server.envKeys.length > 0 ? `- env 键：${server.envKeys.join("、")}（值不显示）` : "",
							server.headerKeys.length > 0 ? `- header 键：${server.headerKeys.join("、")}（值不显示）` : "",
							`- 调用：${formatCalls(usage?.calls || 0)} 次（报错 ${usage?.errors || 0}）· 会话 ${usage?.sessions || 0} · 最近 ${formatTime(usage?.lastUsed || 0)}`,
							...(usage?.tools || []).map((tool) => `  - \`${tool.name}\`：${formatCalls(tool.calls)} 次 / 报错 ${tool.errors} / 均 ${tool.avgMs ? tool.avgMs + "ms" : "—"}`),
							...server.problems.map((problem) => `- ⚠️ ${problem.message}`),
						);
					}
					if (servers.length === 0) lines.push("", "（没有匹配的服务器）");
				} else if (view === "orphans") {
					if (digest.orphans.calls === 0) lines.push("", "孤儿调用：0 —— 每个 `mcp__*` 调用都能对上一台现在配置着的服务器。");
					else {
						lines.push("", `孤儿调用：${digest.orphans.calls} 次，指向 ${digest.orphans.servers.length} 个**现在没有配置**的服务器：`);
						for (const name of digest.orphans.servers) lines.push(`- \`${name}\`（统计里有、组合文件里没有 —— 删过条目 / 改了 serverName）`);
						lines.push("", "工具名：" + digest.orphans.tools.slice(0, 30).map((name) => "`" + name + "`").join("、"));
					}
				} else if (view === "problems") {
					if ((report?.problems || []).length === 0) lines.push("", "配置问题：0。");
					for (const problem of report?.problems || []) lines.push(`- ${problem.level === "bad" ? "❌" : "⚠️"} ${problem.name || problem.id}：${problem.message}`);
				} else if (view === "disable") {
					/* R31：加有模板、停没有 —— 这里只**出文本**，不碰任何文件 */
					const names = (report?.servers || []).map((server) => server.serverName || "(无名)");
					if (wanted === "") {
						lines.push("", "用法：`view=disable server=<serverName>`（只给片段，不写盘）。", names.length > 0 ? "可停的：" + names.map((name) => "`" + name + "`").join("、") : "（一台都没有，没什么可停的）");
					} else if (servers.length === 0) {
						lines.push("", `没有叫 \`${wanted}\` 的服务器 —— 先 view=servers 看确切名字。`);
					} else {
						for (const server of servers) {
							const snippet = renderDisablePatch(server);
							lines.push("", `### 停用 \`${server.serverName || "(无名)"}\``, "```yaml", snippet.text, "```", `- 位置：${snippet.at}${snippet.inPatch ? "（本来就声明在 patch 文件里）" : ""}`, `- 现在的状态：${snippet.alreadyOff ? "**已经是关掉的**（片段幂等）" : mcpStateText(server.state)}`);
						}
						lines.push("", "边界：**只出文本** —— 本工具不写任何文件；贴进 patch 文件后**重启 DSH** 才生效。");
					}
				} else {
					lines.push("", "### 自己配置（本地脚本 + 本地路径）", "```yaml", report?.template?.self || "", "```", "", "### 第三方（npx 拉外部包）", "```yaml", report?.template?.third || "", "```", "", "### 远程（streamable-http）", "```yaml", report?.template?.http || "", "```");
					lines.push("", "加完要**重启 DSH**（cordis.patch.yml 不热更）；工具名会是 `mcp__<serverName>__<tool>`。");
				}
				return withText(
					{
						ok: true,
						view,
						counts,
						client: report?.client || null,
						resources: report?.resources ? { present: report.resources.present, inAsar: report.resources.inAsar, rows: (report.resources.rows || []).length } : null,
						servers: servers.map((server) => ({ ...server, usage: digest.byServer[server.serverName] || null })),
						orphans: digest.orphans,
						totalCalls: digest.totalCalls,
						problems: report?.problems || [],
						template: report?.template || null,
					},
					lines.filter((line) => line !== ""),
				);
			},
		},
	];
}
