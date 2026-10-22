/**
 * tools.mjs — 内嵌 Agent 的**工具面**（与面板同一套 service 方法）。
 *
 * 用户要求：「同一套能力同时注册为工具（不是 Skill），普通会话里能一句话调起
 * （『审一遍 dsh-xxx』『开放 xxx 仓』）」。所以工具名与描述必须让这句话**可映射**：
 *
 *   catalog_review   ← 审一遍 <name>（缺口分析 + 安全审核）
 *   catalog_publish  ← 开放/上传 <仓>（plan → apply → public 三档，默认只出计划）
 *   catalog_list     ← 有哪些插件/Skill
 *   catalog_stats    ← 调用统计（含子代理拆分）
 *   catalog_tag      ← 打标签 / 新增自定义标签（带解释）
 *   catalog_classify ← AI 分类（会把自定义标签的解释喂进去）
 *   catalog_health   ← 自检
 *   catalog_skill_sync ← 「staging 里的 Skill 是不是旧了」（plan 只出计划；apply 单向 live → staging）
 *
 * ⚠️ DSH 0.2.1 起每个工具都必须声明 `output: { schema, render }`，漏了会让
 *    `ctx.tools.register()` 抛错、插件静默失活；返回值必须是 **lossless JSON**。
 *    这两条一律走 TOOL_OUTPUT + prune()。
 *
 * @module dsh-plugin-catalog/tools
 */

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
				"列出本机所有 DSH 插件与 Skill（含来源四分类：官方/自写/第三方/混血、标签、启用状态、调用次数）。" +
				"想回答「我装了哪些插件」「有哪些自写插件」「哪些 Skill 没写 description」「哪些还没确认来源」时用它。" +
				"只会读本机清单，不联网。",
			parameters: compileParameters({
				kind: { type: "string", enum: ["all", "plugin", "skill"], description: "只看插件 / 只看 Skill / 全部（默认 all）" },
				source: { type: "string", enum: ["official", "self", "third", "hybrid", "pending", "any"], description: "按来源过滤（默认 any）" },
				query: { type: "string", description: "按名称或简介子串过滤（大小写不敏感）" },
				limit: { type: "number", description: "最多返回几条（默认 40，上限 200）" },
			}),
			output: TOOL_OUTPUT,
			async execute(args = {}) {
				const kind = String(args.kind || "all");
				const source = String(args.source || "any");
				const query = String(args.query || "").trim().toLowerCase();
				const limit = Math.min(200, Math.max(1, Number(args.limit) || 40));
				await service.rebuildIfCold();
				const { items, hostCore, totals } = service.listEntries();
				const filtered = items.filter((item) => {
					if (kind !== "all" && item.kind !== kind) return false;
					if (source !== "any" && item.source !== source) return false;
					if (query !== "") {
						const haystack = [item.name, item.title, item.descriptionZh, item.descriptionEn].filter(Boolean).join(" ").toLowerCase();
						if (!haystack.includes(query)) return false;
					}
					return true;
				});
				const shown = filtered.slice(0, limit);
				const lines = [
					`插件 ${totals.plugins} 个 / Skill ${totals.skills} 个；来源分布：官方 ${totals.bySource.official}、自写 ${totals.bySource.self}、第三方 ${totals.bySource.third}、混血 ${totals.bySource.hybrid}、待标记 ${totals.bySource.pending}`,
					`（列表只给前 ${limit} 条，共命中 ${filtered.length} 条）`,
					"",
				];
				for (const item of shown) {
					lines.push(
						`- [${SOURCE_LABEL[item.source] || item.source}] ${item.name}${item.kind === "skill" ? "（Skill）" : ""}｜调用 ${formatCalls(item.calls)} 次` +
							(item.subagentCalls > 0 ? `（含子代理 ${formatCalls(item.subagentCalls)}）` : "") +
							`｜最近 ${formatTime(item.lastUsed)}` +
							(item.enabled === false ? "｜未启用" : "") +
							(item.askUser ? "｜⚠️ 来源待你确认" : "") +
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
				"标签管理：列出全部标签（含解释）、给某个插件/Skill 打标签、新增自定义标签（**必须给一句解释**，AI 分类会读它）、删除自定义标签。" +
				"标签三个维度：purpose（做什么）/ context（用在哪里）/ origin（怎么来的，由来源自动推导，不能手填）。",
			parameters: compileParameters({
				action: { type: "string", enum: ["list", "set", "add", "remove", "source", "tool-owner"], description: "list 列出 / set 给条目打标 / add 新增自定义 / remove 删除自定义 / source 手工改来源 / tool-owner 手工改工具归属", required: true },
				id: { type: "string", description: "条目 id（set 时必填）" },
				purpose: { type: "array", items: { type: "string" }, description: "purpose 维度的标签 id 列表（set 时用）" },
				context: { type: "array", items: { type: "string" }, description: "context 维度的标签 id 列表（set 时用）" },
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
				if (action === "set") {
					if (!args.id) return withText({ ok: false, error: "set 需要 id" }, ["set 需要 id"]);
					const saved = await service.setTags(String(args.id), { purpose: args.purpose || [], context: args.context || [] }, "user");
					return withText({ ok: true, ...saved }, [`已给 ${args.id} 打标签：purpose=[${(args.purpose || []).join(", ")}] context=[${(args.context || []).join(", ")}]（用户手标，AI 不会覆盖）`]);
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
				path: { type: "string", description: "输出路径（省略 = <数据目录>/reports/catalog-<时间戳>.md）" },
			}),
			output: TOOL_OUTPUT,
			async execute(args = {}) {
				await service.rebuildIfCold();
				const result = await service.exportReport({ top: args.top, path: args.path });
				if (result.ok === false) return withText({ ok: false, error: result.error }, ["导出失败：" + result.error]);
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
					`宿主：dsh ${health.host.dsh || "?"} / dsh-tools ${health.host.dshTools || "?"} / node ${health.host.node}`,
					`工作区：${health.workspace || "(未解析)"}`,
					`profile：${health.profileDir || "(未解析)"}`,
					`数据目录：${health.dataDir}`,
					`工具：注册 ${health.toolsRegistered} 个（catalog_*）`,
					health.catalog ? `目录：插件 ${health.catalog.plugins} / Skill ${health.catalog.skills} / 官方(asar) ${health.catalog.officialFromAsar}` : "目录：还没建好",
					health.asar ? `asar：${health.asar.reachable ? "可读" : "读不到（官方插件会显示 0 个）"}${health.asar.path ? " · " + health.asar.path : ""}` : "",
					health.stats ? `统计：${health.stats.sessions} 会话 / ${health.stats.calls} 调用 / ${health.stats.windowDays} 天 / 耗时 ${health.stats.durationMs}ms / 去重 ${health.stats.duplicateCalls}` : "统计：缓存还没有（首次打开会自动算）",
					health.attribution ? `归属：${health.attribution.byDescription} 条靠描述指纹、${health.attribution.byName} 条靠名字、${health.attribution.host} 条判为宿主、${health.attribution.unknown} 条未知` : "归属：未建",
					health.sizes
						? `体积：已量 ${health.sizes.count} 条 / 合计 ${formatBytes(health.sizes.totalBytes)}（${formatTime(health.sizes.at)}）` + (health.sizes.truncated > 0 ? `｜${health.sizes.truncated} 条超过预算只算到一部分` : "")
						: "体积：还没量（面板点「量体积」或 POST /refresh {what:\"sizes\"}；卡片体积与排序靠它）",
					`任务：${health.job.running ? "在跑 " + health.job.kind + " " + health.job.progress.done + "/" + health.job.progress.total : "空闲"}`,
					`每周任务：缺口 ${health.weekly.lastGapAt ? formatTime(health.weekly.lastGapAt) : "从未跑"} / 安全 ${health.weekly.lastSecurityAt ? formatTime(health.weekly.lastSecurityAt) : "从未跑"}`,
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
			name: "catalog_skill_sync",
			description:
				"检查并同步 **Skill 的两份副本**：DSH 实际加载的 `.dsh/skills/<name>/SKILL.md` 与上传用的 staging（`.gh-upload/<技能仓>/<name>`）。" +
				"两者不一致时，`catalog_publish` 推上去的其实是**旧版**。默认只出计划（不写盘）；带 apply:true 且 confirm:true 才做**单向 live → staging**，" +
				"写前把被覆盖的 staging 文件备份成 `SKILL.md.bak-<时间戳>`。换会话接手、发布前跑一次 plan 就够。",
			parameters: compileParameters({
				action: { type: "string", enum: ["plan", "apply"], description: "plan 只出计划（默认）/ apply 真正写盘（必须同时给 confirm）" },
				ids: { type: "array", items: { type: "string" }, description: "只处理这些 Skill id（如 skill:vex-ops）；省略 = 所有不一致的" },
				confirm: { type: "boolean", description: "apply 时必须为 true，表示你确认要覆盖 staging" },
			}),
			output: TOOL_OUTPUT,
			async execute(args = {}) {
				const ids = Array.isArray(args.ids) ? args.ids.map(String) : [];
				if (String(args.action || "plan") === "apply") {
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
	];
}
