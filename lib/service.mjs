/**
 * service.mjs — 面板与工具共用的**唯一能力层**。
 *
 * 三条原则：
 *   1. 面板（HTTP 路由）与内嵌 Agent（注册的工具）调**同一套方法** ——
 *      用户要求「同一套能力同时注册为工具」，不是两份实现各写一遍。
 *   2. 重活（扫 90 天日志、跑模型、推仓）一律走后台任务，接口立刻返回；
 *      面板先显示缓存，算完自动刷新。
 *   3. 统计口径只在这里定义一次（含「含子代理 N 次」），别让 UI 自己再算一遍。
 *
 * @module dsh-plugin-catalog/service
 */

import { join } from "node:path";
import { asarMode, asarPath } from "./asar.mjs";
import { buildCatalog, readCatalogCache, CATALOG_VERSION } from "./catalog.mjs";
import { buildToolIndex, readCachedIndex } from "./attrib.mjs";
import { computeStats, loadAggregate, DEFAULT_WINDOW_DAYS, descendantsOf } from "./stats.mjs";
import { buildStamp, dataDir as dataDirOf, dshHome, hostVersions, profileDir, skillRoots, workspaceRoot } from "./hostinfo.js";
import { addCustomTag, listTags, loadTagsStore, removeCustomTag, saveTagsStore, setEntryTags, tagPrompt, tagsOfEntry } from "./tags.mjs";
import { classifyEntries, generateZhIntros, translateReadme, readService } from "./ai.mjs";
import { applyUpload, makePublic, planUpload, repoNameFor, selectCandidates, skillsRepoName } from "./publish.mjs";
import { isDue, loadWeekly, runGapAnalysis, runSecurityAudit, saveWeekly, summarizeReport } from "./review.mjs";
import { loadSettings, saveSettings, skillsStageDirOf, DEFAULTS } from "./settings.mjs";
import { drainWarnings, readJson, writeJson } from "./store.mjs";

const OVERRIDES_VERSION = 1;

export class CatalogService {
	/**
	 * @param {object} deps
	 * @param {object} deps.ctx 宿主上下文
	 * @param {() => Array<{name:string,description?:string}>} deps.toolSchemas 实时工具 schema
	 */
	constructor(deps) {
		this.ctx = deps.ctx;
		this.toolSchemas = deps.toolSchemas || (() => []);
		this.settings = null;
		this.tags = null;
		this.overrides = { version: OVERRIDES_VERSION, sources: {}, tools: {} };
		this.catalog = null;
		this.aggregate = null;
		this.statsMeta = null;
		this.attrib = { index: {}, stats: {} };
		this.intros = null;
		this.job = null;
		this.lastPlan = null;
		this.lastReports = { gap: null, security: null };
		this.clientReport = null;
		this.weekly = null;
		this.startedAt = Date.now();
	}

	/* ───────────── 基础 ───────────── */

	get dir() {
		return dataDirOf(this.settings?.workspace);
	}

	get workspace() {
		return workspaceRoot(this.settings?.workspace);
	}

	overridesFile() {
		return join(this.dir, "overrides.json");
	}

	introsFile() {
		return join(this.dir, "intros.json");
	}

	async init() {
		this.settings = await loadSettings(this.dir);
		this.tags = await loadTagsStore(this.dir);
		this.overrides = (await readJson(this.overridesFile(), null)) || this.overrides;
		this.intros = (await readJson(this.introsFile(), null)) || { version: 1, byEntry: {}, model: "", generatedAt: 0 };
		this.weekly = await loadWeekly(this.dir);

		/* ★ 启动路径只读缓存，**绝不重建**。
		   重建要跑 71 个包的 realpath + stat + git（实测 15 秒）—— 放在 apply() 里
		   等于把 DSH 的启动拖慢 15 秒。过期也没关系：界面先显示旧数据，后台任务刷新。 */
		const cachedStats = await loadAggregate(this.dir, this.settings.windowDays);
		this.aggregate = cachedStats.aggregate;
		this.statsMeta = cachedStats.meta;
		this.statsStale = cachedStats.stale;
		this.statsNeedsRefresh = !this.aggregate;

		const cachedCatalog = await readCatalogCache(this.dir);
		if (cachedCatalog.snapshot && cachedCatalog.version === CATALOG_VERSION) {
			this.catalog = cachedCatalog.snapshot;
			this.catalogAgeMs = cachedCatalog.ageMs;
			/* 过期只做标记，不在这里重建 */
			this.catalogStale = cachedCatalog.ageMs > (Number(this.settings.catalogTtlSeconds) || 300) * 1000;
		} else {
			this.catalog = null;
			this.catalogAgeMs = Infinity;
			this.catalogStale = true;
		}

		/* 归属索引同样只读缓存：不读它的话，重启后的头几分钟
		   面板会把所有工具都显示成「宿主核心」（因为 index 是空的）。 */
		const cachedAttrib = await readCachedIndex(this.dir);
		if (cachedAttrib) {
			this.attrib = { index: cachedAttrib.index, stats: cachedAttrib.stats };
			this.attribNeedsRebuild = false;
		} else {
			this.attribNeedsRebuild = true;
		}
		return this;
	}

	async saveOverrides() {
		await writeJson(this.overridesFile(), { ...this.overrides, savedAt: Date.now() });
	}

	/* ───────────── 后台任务 ───────────── */

	get busy() {
		return this.job !== null;
	}

	/**
	 * 起一个后台任务（同一时刻只允许一个，避免两个全量扫描互相踩）。
	 * @param {string} kind
	 * @param {(progress:(p:object)=>void) => Promise<object>} runner
	 */
	startJob(kind, runner) {
		if (this.job) return { ok: false, error: "已有任务在跑：" + this.job.kind, job: this.jobSnapshot() };
		const job = { kind, startedAt: Date.now(), progress: { phase: "start", done: 0, total: 1 }, error: "", result: null, finishedAt: 0 };
		this.job = job;
		Promise.resolve()
			.then(() => runner((patch) => Object.assign(job.progress, patch)))
			.then((result) => {
				job.result = result;
				job.finishedAt = Date.now();
			})
			.catch((error) => {
				job.error = String(error?.message ?? error);
				job.finishedAt = Date.now();
			})
			.finally(() => {
				/* 留最后一份快照给面板读，随后释放 */
				this.lastJob = { ...job };
				this.job = null;
			});
		return { ok: true, job: this.jobSnapshot() };
	}

	jobSnapshot() {
		const job = this.job || this.lastJob || null;
		if (!job) return { running: false, kind: "", progress: { phase: "idle", done: 0, total: 0 } };
		return {
			running: this.job !== null,
			kind: job.kind,
			startedAt: job.startedAt,
			finishedAt: job.finishedAt || 0,
			progress: job.progress,
			error: job.error || "",
			result: job.result || null,
		};
	}

	/** 重算统计（可被面板的「刷新」按钮或工具触发）。 */
	async refreshStats({ full = false } = {}) {
		const result = await computeStats({
			sessionsRoot: join(dshHome(), "sessions"),
			dataDir: this.dir,
			windowDays: this.settings.windowDays,
			signal: { aborted: false },
			onProgress: (progress) => this.job?.progress && Object.assign(this.job.progress, progress),
		});
		if (result.ok) {
			this.aggregate = result.aggregate;
			this.statsMeta = result.meta;
			this.statsStale = false;
			await this.rebuildAttribution();
		}
		return { ok: result.ok, meta: result.meta, error: result.error || "" };
	}

	async rebuildCatalog({ force = true } = {}) {
		this.catalog = await buildCatalog({ dataDir: this.dir, settings: this.settings, force });
		await this.rebuildAttribution();
		return { ok: true, counts: this.catalog?.counts || {} };
	}

	async rebuildAttribution() {
		const tools = this.toolSchemas();
		const packages = [];
		for (const plugin of this.catalog?.plugins ?? []) {
			if (plugin.inAsar) continue;
			packages.push({ pkg: plugin.name, root: plugin.realDir });
		}
		/* 官方工具包在 asar 里：不读它们，65% 的调用量会落在"未知" */
		try {
			const { readOfficialToolPackages } = await import("./catalog.mjs");
			for (const pack of await readOfficialToolPackages()) packages.push(pack);
		} catch {
			/* 读不到 asar 就退化为只有 profile 包 */
		}
		this.attrib = await buildToolIndex({ dataDir: this.dir, tools, packages, overrides: this.overrides.tools || {}, force: false });
		return this.attrib;
	}

	/* ───────────── 视图组装 ───────────── */

	/** 工具 → 归属包（含官方/宿主判定）。 */
	toolOwner(toolName) {
		const entry = this.attrib.index?.[toolName];
		return entry && entry.owner ? entry.owner : "";
	}

	/**
	 * 一个条目在统计上的汇总。
	 *
	 * 口径（写在这里一次，UI 直接显示）：
	 *   · calls：该插件的**全部工具**调用次数之和（含子代理会话里发生的）；
	 *   · subagentCalls：其中发生在**子代理会话**里的次数 —— 用户要的「含子代理 N 次」；
	 *   · sessions：去重后的会话数（同一会话多次调用算 1）。
	 */
	entryUsage(entry) {
		const aggregate = this.aggregate;
		const empty = { calls: 0, errors: 0, lastUsed: 0, sessions: 0, subagentCalls: 0, rootCalls: 0, tools: [] };
		if (!aggregate) return empty;

		if (entry.kind === "skill") {
			/* Skill 只有「次数 + 最近一次」—— 机制限制，不假装精确 */
			const skill = aggregate.skills.get(entry.skillName || entry.name);
			if (!skill) return { ...empty, limited: true };
			return { calls: skill.calls, errors: 0, lastUsed: skill.lastUsed, sessions: 0, subagentCalls: 0, rootCalls: skill.calls, tools: [], limited: true };
		}

		const tools = [];
		let calls = 0;
		let errors = 0;
		let lastUsed = 0;
		let subagentCalls = 0;
		const sessionIds = new Set();

		for (const [toolName, tool] of aggregate.tools) {
			if (this.toolOwner(toolName) !== entry.name) continue;
			tools.push({
				name: toolName,
				calls: tool.calls,
				errors: tool.errors,
				incomplete: tool.incomplete,
				avgMs: tool.msCount > 0 ? Math.round(tool.ms / tool.msCount) : 0,
				lastUsed: tool.lastUsed,
				sessions: tool.sessions,
			});
			calls += tool.calls;
			errors += tool.errors;
			if (tool.lastUsed > lastUsed) lastUsed = tool.lastUsed;
			for (const sessionId of tool.sessionCounts.keys()) {
				sessionIds.add(sessionId);
				const session = aggregate.sessions.get(sessionId);
				if (session && (session.parent || session.depth > 0)) subagentCalls += tool.sessionCounts.get(sessionId) || 0;
			}
		}

		tools.sort((a, b) => b.calls - a.calls);
		return { calls, errors, lastUsed, sessions: sessionIds.size, subagentCalls, rootCalls: calls - subagentCalls, tools };
	}

	/** 宿主核心工具（无法归属到任何 profile 插件/官方工具包的那些）。 */
	hostCoreUsage() {
		const aggregate = this.aggregate;
		if (!aggregate) return { id: "host-core", name: "宿主核心工具", calls: 0, tools: [] };
		const knownOfficial = new Set((this.catalog?.plugins ?? []).map((plugin) => plugin.name));
		const tools = [];
		let calls = 0;
		for (const [name, tool] of aggregate.tools) {
			const owner = this.toolOwner(name);
			const entry = this.attrib.index?.[name];
			const isProfilePlugin = (this.catalog?.plugins ?? []).some((plugin) => plugin.name === owner && !plugin.inAsar);
			const isOfficialCard = knownOfficial.has(owner) && (this.catalog.plugins || []).find((plugin) => plugin.name === owner)?.inAsar;
			if (isProfilePlugin || isOfficialCard) continue;
			tools.push({
				name,
				calls: tool.calls,
				errors: tool.errors,
				avgMs: tool.msCount > 0 ? Math.round(tool.ms / tool.msCount) : 0,
				lastUsed: tool.lastUsed,
				sessions: tool.sessions,
				owner: owner || "",
				how: entry?.how || "unknown",
			});
			calls += tool.calls;
		}
		tools.sort((a, b) => b.calls - a.calls);
		return { id: "host-core", kind: "host", name: "宿主核心工具", calls, tools, sessions: 0, subagentCalls: 0 };
	}

	/** 面板列表项（卡片）。 */
	listEntries() {
		const aggregate = this.aggregate;
		const plugins = (this.catalog?.plugins ?? []).map((plugin) => {
			const source = this.overrides.sources?.[plugin.id] || plugin.source;
			const usage = this.entryUsage({ ...plugin, source });
			return {
				id: plugin.id,
				kind: "plugin",
				name: plugin.name,
				title: plugin.title,
				version: plugin.version,
				descriptionEn: plugin.description,
				descriptionZh: this.intros?.byEntry?.[plugin.id]?.zh || "",
				source,
				sourceWhy: plugin.sourceWhy,
				askUser: Boolean(plugin.askUser) && !this.overrides.sources?.[plugin.id],
				enabled: plugin.enabled,
				inAsar: Boolean(plugin.inAsar),
				repoUrl: plugin.repoUrl,
				createdAt: plugin.createdAt,
				author: plugin.author,
				license: plugin.license,
				keywords: plugin.keywords,
				calls: usage.calls,
				errors: usage.errors,
				lastUsed: usage.lastUsed,
				sessions: usage.sessions,
				subagentCalls: usage.subagentCalls,
				toolCount: usage.tools.length,
				tags: tagsOfEntry(this.tags, { id: plugin.id, source }),
				git: plugin.git,
			};
		});

		const skills = (this.catalog?.skills ?? [])
			.filter((skill) => !(this.settings.hideBackupSkills && skill.backup))
			.map((skill) => {
				const source = this.overrides.sources?.[skill.id] || skill.source;
				const usage = this.entryUsage({ ...skill, source, kind: "skill" });
				return {
					id: skill.id,
					kind: "skill",
					name: skill.name,
					title: skill.name,
					descriptionEn: skill.description,
					descriptionZh: this.intros?.byEntry?.[skill.id]?.zh || "",
					whenToUse: skill.whenToUse,
					hasDescription: Boolean(skill.hasDescription),
					source,
					sourceWhy: skill.sourceWhy,
					askUser: Boolean(skill.askUser) && !this.overrides.sources?.[skill.id],
					repoUrl: skill.repoUrl,
					createdAt: skill.createdAt,
					hostPlugin: skill.hostPlugin,
					backup: skill.backup,
					calls: usage.calls,
					errors: 0,
					lastUsed: usage.lastUsed,
					sessions: 0,
					subagentCalls: 0,
					toolCount: 0,
					tags: tagsOfEntry(this.tags, { id: skill.id, source }),
					statsLimited: true,
				};
			});

		const hostCore = this.hostCoreUsage();
		const items = [...plugins, ...skills];
		return { items, hostCore, totals: this.totalsOf(plugins, skills) };
	}

	totalsOf(plugins, skills) {
		return {
			plugins: plugins.length,
			skills: skills.length,
			calls: plugins.reduce((sum, item) => sum + item.calls, 0),
			errors: plugins.reduce((sum, item) => sum + item.errors, 0),
			subagentCalls: plugins.reduce((sum, item) => sum + item.subagentCalls, 0),
			hostCoreCalls: this.hostCoreUsage().calls,
			bySource: {
				official: [...plugins, ...skills].filter((item) => item.source === "official").length,
				self: [...plugins, ...skills].filter((item) => item.source === "self").length,
				third: [...plugins, ...skills].filter((item) => item.source === "third").length,
				hybrid: [...plugins, ...skills].filter((item) => item.source === "hybrid").length,
				pending: [...plugins, ...skills].filter((item) => item.source === "pending").length,
			},
			askUser: [...plugins, ...skills].filter((item) => item.askUser).length,
		};
	}

	/**
	 * 一个条目的详情（浮窗）。会话列表分页。
	 * @param {string} id
	 * @param {{page?:number, pageSize?:number}} [options]
	 */
	entryDetail(id, options = {}) {
		const { items, hostCore } = this.listEntries();
		if (id === "host-core") return this.hostCoreDetail(options, hostCore);
		const item = items.find((entry) => entry.id === id);
		if (!item) return { ok: false, error: "找不到条目：" + id };
		const aggregate = this.aggregate;
		const pageSize = Math.min(500, Math.max(5, Number(options.pageSize) || this.settings.sessionsPageSize));
		const page = Math.max(1, Number(options.page) || 1);

		const raw = aggregate ? (this.catalog.plugins.find((plugin) => plugin.id === id) ?? this.catalog.skills.find((skill) => skill.id === id)) : null;
		const usage = item.kind === "plugin" ? this.entryUsage({ ...raw, source: item.source }) : null;

		/* 会话列表：按「该工具的调用次数」聚合，标注是不是子代理 */
		let sessions = [];
		let totalSessions = 0;
		if (item.kind === "plugin" && aggregate) {
			const counts = new Map();
			for (const tool of usage.tools) {
				const full = aggregate.tools.get(tool.name);
				if (!full) continue;
				for (const [sessionId, count] of full.sessionCounts) counts.set(sessionId, (counts.get(sessionId) || 0) + count);
			}
			const rows = [...counts.entries()].map(([sessionId, count]) => {
				const session = aggregate.sessions.get(sessionId) || { id: sessionId, title: sessionId.slice(0, 8) };
				const isSubagent = Boolean(session.parent) || session.depth > 0;
				return {
					id: sessionId,
					title: session.title,
					titleSource: session.titleSource,
					workspace: session.workspace,
					calls: count,
					lastAt: session.lastAt,
					isSubagent,
					parentId: session.parent || "",
					parentTitle: session.parent ? aggregate.sessions.get(session.parent)?.title || session.parent.slice(0, 8) : "",
					depth: session.depth || 0,
				};
			});
			rows.sort((a, b) => b.calls - a.calls);
			totalSessions = rows.length;
			sessions = rows.slice((page - 1) * pageSize, page * pageSize);
		}

		const descendants = item.kind === "plugin" && aggregate && aggregate.sessions.has(id) ? descendantsOf(aggregate.sessions, id) : [];

		return {
			ok: true,
			item,
			tools: usage?.tools || [],
			sessions: {
				items: sessions,
				page,
				pageSize,
				total: totalSessions,
				pages: Math.max(1, Math.ceil(totalSessions / pageSize)),
				pageSizes: this.settings.pageSizes,
			},
			descendants: descendants.length,
			statsMeta: this.statsMeta,
			statsLimited: item.kind === "skill",
			readme: null,
		};
	}

	hostCoreDetail(options, hostCore) {
		const pageSize = Math.min(500, Math.max(5, Number(options.pageSize) || this.settings.sessionsPageSize));
		const page = Math.max(1, Number(options.page) || 1);
		const aggregate = this.aggregate;
		const counts = new Map();
		if (aggregate) {
			for (const tool of hostCore.tools) {
				const full = aggregate.tools.get(tool.name);
				if (!full) continue;
				for (const [sessionId, count] of full.sessionCounts) counts.set(sessionId, (counts.get(sessionId) || 0) + count);
			}
		}
		const rows = [...counts.entries()]
			.map(([sessionId, count]) => {
				const session = aggregate?.sessions.get(sessionId) || { id: sessionId, title: sessionId.slice(0, 8) };
				return { id: sessionId, title: session.title, calls: count, lastAt: session.lastAt, isSubagent: Boolean(session.parent) || session.depth > 0, parentTitle: session.parent ? aggregate?.sessions.get(session.parent)?.title || "" : "", depth: session.depth || 0 };
			})
			.sort((a, b) => b.calls - a.calls);

		return {
			ok: true,
			item: {
				id: "host-core",
				kind: "host",
				name: "宿主核心工具",
				title: "宿主核心工具",
				descriptionZh: "由 DSH 宿主自带（在 app.asar 里）或来源无法判定的工具。它们不属于任何可上传的插件，单列在这里。",
				descriptionEn: "Tools provided by the DSH host itself (inside app.asar), or whose owner could not be determined.",
				source: "official",
				sourceWhy: ["宿主自带 / 归属不明"],
				calls: hostCore.calls,
				tags: { purpose: [], context: [], origin: ["src-official"] },
			},
			tools: hostCore.tools,
			sessions: { items: rows.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total: rows.length, pages: Math.max(1, Math.ceil(rows.length / pageSize)), pageSizes: this.settings.pageSizes },
			statsMeta: this.statsMeta,
			statsLimited: false,
		};
	}

	/** 完整面板状态（一次请求给全，前端不再拼多次）。 */
	async state() {
		const list = this.listEntries();
		return {
			ok: true,
			build: await buildStamp(),
			host: await hostVersions(),
			profileDir: profileDir(),
			workspace: this.workspace,
			dataDir: this.dir,
			skillRoots: skillRoots(this.settings.workspace),
			settings: this.settings,
			defaults: loadSettingsDefaults(),
			tags: {
				all: listTags(this.tags),
				assignments: this.tags.assignments,
				prompt: tagPrompt(this.tags),
			},
			catalogMeta: {
				builtAt: this.catalog?.builtAt || 0,
				counts: this.catalog?.counts || {},
				errors: this.catalog?.errors || [],
				fromCache: Boolean(this.catalog?.fromCache),
				stale: Boolean(this.catalogStale),
				ageMs: Number.isFinite(this.catalogAgeMs) ? this.catalogAgeMs : null,
			},
			stats: {
				ready: Boolean(this.aggregate),
				stale: Boolean(this.statsStale),
				meta: this.statsMeta,
				cacheAgeMs: this.statsMeta ? Date.now() - Number(this.statsMeta.builtAt || 0) : null,
			},
			attribution: this.attrib.stats || {},
			job: this.jobSnapshot(),
			weekly: this.weekly,
			weeklyDue: { gap: isDue(this.weekly?.lastGapAt), security: isDue(this.weekly?.lastSecurityAt) },
			reports: { gap: summarizeReport(this.weekly?.gap), security: summarizeReport(this.weekly?.security) },
			intros: { model: this.intros?.model || "", generatedAt: this.intros?.generatedAt || 0, count: Object.keys(this.intros?.byEntry || {}).length },
			clientReport: this.clientReport,
			entries: list.items,
			hostCore: this.hostCoreUsage(),
			totals: list.totals,
			warnings: drainWarnings(),
			publishing: {
				publishable: selectCandidates(this.catalog || {}, this.settings),
				skillsRepo: skillsRepoName(this.settings),
				skillsStageDir: skillsStageDirOf(this.settings, this.workspace),
				lastPlan: this.lastPlan ? { planId: this.lastPlan.planId, summary: this.lastPlan.summary, generatedAt: this.lastPlan.generatedAt } : null,
			},
		};
	}

	/* ───────────── 标签 / 覆盖 ───────────── */

	async setTags(entryId, tags, by = "user") {
		const saved = setEntryTags(this.tags, entryId, tags, by);
		await saveTagsStore(this.dir, this.tags);
		return { ok: true, entryId, tags: saved };
	}

	async addTag(input) {
		const result = addCustomTag(this.tags, input);
		if (!result.ok) return result;
		await saveTagsStore(this.dir, this.tags);
		return { ok: true, tag: result.tag, all: listTags(this.tags) };
	}

	async removeTag(id) {
		const result = removeCustomTag(this.tags, id);
		if (result.ok) await saveTagsStore(this.dir, this.tags);
		return { ...result, all: listTags(this.tags) };
	}

	/** 手工指定来源（混血/自写拿不准时用一次，之后不再问）。 */
	async setSource(entryId, source, note = "") {
		if (!["official", "self", "third", "hybrid", "pending"].includes(source)) return { ok: false, error: "来源只能是 official/self/third/hybrid/pending" };
		this.overrides.sources = { ...(this.overrides.sources || {}), [entryId]: source };
		await this.saveOverrides();
		for (const collection of [this.catalog?.plugins, this.catalog?.skills]) {
			for (const entry of collection || []) {
				if (entry.id === entryId) {
					entry.sourceWhy = [...(entry.sourceWhy || []), `用户手工标记为 ${source}${note ? "：" + note : ""}`];
					entry.askUser = false;
				}
			}
		}
		return { ok: true, entryId, source };
	}

	/** 手工指定工具归属。 */
	async setToolOwner(toolName, pkg) {
		this.overrides.tools = { ...(this.overrides.tools || {}), [toolName]: pkg };
		await this.saveOverrides();
		this.attrib = await buildToolIndex({
			dataDir: this.dir,
			tools: this.toolSchemas(),
			packages: [],
			overrides: this.overrides.tools || {},
			force: false,
		});
		return { ok: true, toolName, owner: pkg };
	}

	/* ───────────── AI 任务 ───────────── */

	async runClassify(ids) {
		const { items } = this.listEntries();
		const targets = ids && ids.length > 0 ? items.filter((item) => ids.includes(item.id)) : items.filter((item) => item.tags.purpose.length === 0 && item.tags.context.length === 0);
		const model = this.settings.aiModel;
		const result = await classifyEntries(this.ctx, targets, tagPrompt(this.tags), { model });
		if (!result.ok) return { ok: false, error: result.error, model: result.model };
		let applied = 0;
		const skipped = [];
		for (const [id, tags] of Object.entries(result.assignments)) {
			const entry = items.find((item) => item.id === id);
			if (!entry) continue;
			if (this.tags.assignments?.[id]?.by === "user") {
				skipped.push(id); // 用户手标过的不覆盖
				continue;
			}
			setEntryTags(this.tags, id, { purpose: tags?.purpose, context: tags?.context }, "ai");
			applied += 1;
		}
		await saveTagsStore(this.dir, this.tags);
		return { ok: true, model: result.model, applied, skipped, requested: targets.length };
	}

	async runIntros(force = false) {
		const { items } = this.listEntries();
		const pending = items.filter((item) => (force || !this.intros.byEntry?.[item.id]) && item.descriptionEn);
		if (pending.length === 0) return { ok: true, generated: 0, model: this.intros.model || "", reason: "没有需要生成中文简介的条目" };
		const result = await generateZhIntros(this.ctx, pending, { model: this.settings.aiModel });
		if (!result.ok) return { ok: false, error: result.error, model: result.model };
		const byEntry = { ...(this.intros.byEntry || {}) };
		for (const [id, zh] of Object.entries(result.intros)) byEntry[id] = { zh, model: result.model, at: Date.now(), manual: false };
		this.intros = { version: 1, byEntry, model: result.model, generatedAt: Date.now() };
		await writeJson(this.introsFile(), this.intros);
		return { ok: true, generated: Object.keys(result.intros).length, model: result.model };
	}

	/** 用户在面板上手改中文简介。 */
	async setIntro(entryId, zh) {
		const byEntry = { ...(this.intros.byEntry || {}) };
		byEntry[entryId] = { zh: String(zh || "").slice(0, 200), model: "manual", at: Date.now(), manual: true };
		this.intros = { ...this.intros, byEntry, generatedAt: Date.now() };
		await writeJson(this.introsFile(), this.intros);
		return { ok: true };
	}

	/* ───────────── 上传 / 公开 ───────────── */

	async planUpload() {
		if (!this.catalog) return { ok: false, error: "目录还没就绪" };
		const plan = await planUpload({
			catalog: this.catalog,
			settings: { ...this.settings, skillsStageDir: skillsStageDirOf(this.settings, this.workspace) },
		});
		const planId = "plan-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
		this.lastPlan = { ...plan, planId };
		return { ok: true, plan: { planId, generatedAt: plan.generatedAt, login: plan.login, items: plan.items.map(publicPlanItem), summary: plan.summary } };
	}

	/**
	 * 执行上传。**必须**传 planId + confirm:true（= 用户看过计划并点确认）。
	 */
	async applyUpload({ planId, confirm, translate = true, ackRepos = [] }) {
		if (confirm !== true) return { ok: false, error: "需要 confirm:true —— 先看计划再推" };
		if (!this.lastPlan || this.lastPlan.planId !== planId) return { ok: false, error: "计划已失效，请重新生成计划（planUpload）" };
		if (this.busy) return { ok: false, error: "有任务在跑，稍后再试" };

		const plan = this.lastPlan;
		const translator = translate
			? async (item, zh) => translateReadme(this.ctx, { name: item.name, zh }, { model: this.settings.aiModel })
			: null;
		const result = await applyUpload(plan, {
			translate: translator,
			commit: true,
			confirm: true,
			ackRepos: Array.isArray(ackRepos) ? ackRepos.map(String) : [],
			onProgress: (progress) => this.job?.progress && Object.assign(this.job.progress, progress),
		});
		this.lastPlan = null;
		/* 推完刷新一次目录（远端状态变了） */
		await this.rebuildCatalog({ force: true }).catch(() => {});
		return { ok: result.ok, result };
	}

	/**
	 * 把某个仓改为公开。独立操作：必须 confirm:true，且**先重扫**。
	 */
	async publishPublic({ repo, dir, confirm }) {
		/* ★ 门禁先于一切：连"找不找得到本地目录"都不该在没 confirm 时先算 ——
		   否则报错信息会把人引到"路径不对"这条岔路上去。 */
		if (confirm !== true) return { ok: false, error: "公开操作必须显式确认（confirm:true）—— 默认所有仓都是私有的" };
		if (!repo) return { ok: false, error: "需要 repo 名" };
		const targetDir = dir || this.findDirForRepo(repo);
		if (!targetDir) return { ok: false, error: "找不到该仓的本地目录，请显式给 dir" };
		const result = await makePublic({ repo, dir: targetDir, confirm, ghBin: this.settings.ghBin });
		return result;
	}

	findDirForRepo(repo) {
		for (const plugin of this.catalog?.plugins ?? []) {
			if (repoNameFor(plugin) === repo) return plugin.realDir;
		}
		const stage = skillsStageDirOf(this.settings, this.workspace);
		if (stage && repo === skillsRepoName(this.settings)) return stage;
		return "";
	}

	/* ───────────── 每周任务 ───────────── */

	/** 只保留 `name` 对应的那一个插件（`name` 为空 = 全部自写/混血）。 */
	filteredCatalog(name) {
		const catalog = this.catalog || { plugins: [], skills: [] };
		if (!name) return catalog;
		const wanted = String(name).replace(/^plugin:/, "").trim().toLowerCase();
		const plugins = (catalog.plugins || []).filter((plugin) => {
			if (plugin.name.toLowerCase() === wanted) return true;
			const short = plugin.name.replace(/^@[^/]+\//, "").toLowerCase();
			return short === wanted || short === wanted.replace(/^dsh-/, "");
		});
		return { ...catalog, plugins, skills: (catalog.skills || []).filter((skill) => skill.name.toLowerCase() === wanted) };
	}

	async runGap(catalog = null) {
		const target = catalog || this.catalog || {};
		const report = await runGapAnalysis(this.ctx, target, { model: this.settings.aiModel });
		/* 只跑全量时才更新"上次执行时间"：单仓抽查不该把每周提醒推后 */
		if (!catalog) {
			this.weekly = { ...this.weekly, lastGapAt: report.ranAt, gap: report };
			await saveWeekly(this.dir, this.weekly);
		}
		return { ok: true, summary: summarizeReport(report), report };
	}

	async runSecurity(catalog = null) {
		const target = catalog || this.catalog || {};
		const report = await runSecurityAudit(this.ctx, target, { model: this.settings.aiModel });
		if (!catalog) {
			this.weekly = { ...this.weekly, lastSecurityAt: report.ranAt, security: report };
			await saveWeekly(this.dir, this.weekly);
		}
		return { ok: true, summary: summarizeReport(report), report };
	}

	/**
	 * 打开面板时调一次：到期就在**后台**跑（不阻塞），默认只跑缺口分析。
	 *
	 * ★ 必须记「尝试时间」（`lastGapAttemptAt`），不能只看「成功时间」：
	 *   面板每 2.5~20 秒轮询一次 `/state`，如果这次失败（AI 不可用 / 没默认模型），
	 *   `lastGapAt` 不会被写上 —— 于是**每一次轮询都会再试一次**，变成一个无限重试的
	 *   模型调用循环。这里加 1 小时退避。
	 */
	weeklyTick() {
		if (!this.weekly) return { started: false };
		const backoffMs = 60 * 60 * 1000;
		const attempted = Number(this.weekly.lastGapAttemptAt) || 0;
		if (Date.now() - attempted < backoffMs) return { started: false, reason: "recent-attempt" };
		if (!this.settings.weeklyGapAuto) return { started: false, reason: "disabled" };
		if (!isDue(this.weekly.lastGapAt)) return { started: false, reason: "not-due" };
		if (this.busy) return { started: false, reason: "busy" };

		this.weekly = { ...this.weekly, lastGapAttemptAt: Date.now() };
		saveWeekly(this.dir, this.weekly).catch(() => {});
		this.startJob("weekly-gap", async (progress) => await this.runGapWithProgress(progress));
		return { started: true, kind: "weekly-gap" };
	}

	async runGapWithProgress(progress) {
		const report = await runGapAnalysis(this.ctx, this.catalog || {}, {
			model: this.settings.aiModel,
			onProgress: (patch) => progress(patch),
		});
		this.weekly = { ...this.weekly, lastGapAt: report.ranAt, gap: report };
		await saveWeekly(this.dir, this.weekly);
		return { summary: summarizeReport(report) };
	}

	/* ───────────── 导出报告（换会话 / 交接 / 留证据） ───────────── */

	/**
	 * 把当前快照导出成 Markdown 报告。
	 *
	 * 为什么要固定成能力：这份内容每次交接都要手搓一遍（清点插件、来源分布、调用 Top、
	 * 待标记清单、归属覆盖率）。写进插件后一句话就能出，而且**数字与面板同源**
	 * （都走 listEntries/entryUsage），不会出现"报告与界面不一致"。
	 *
	 * @param {{path?:string, top?:number}} [options]
	 */
	async exportReport(options = {}) {
		const { mkdir, writeFile } = await import("node:fs/promises");
		const { join } = await import("node:path");
		const top = Math.min(60, Math.max(5, Number(options.top) || 20));
		const { items, hostCore, totals } = this.listEntries();
		const plugins = items.filter((item) => item.kind === "plugin");
		const skills = items.filter((item) => item.kind === "skill");
		const meta = this.statsMeta || {};
		const stats = this.attrib.stats || {};
		const pad = (n) => String(n).padStart(2, "0");
		const now = new Date();
		const stamp = now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + "-" + pad(now.getHours()) + pad(now.getMinutes());
		const at = now.toISOString();
		const fmtN = (value) => (Number(value) || 0).toLocaleString("en-US");
		/* ★ 用**本地时间**：toISOString 是 UTC，报告里写 17:54 而面板写 01:54 会对不上 */
		const fmtT = (ms) => {
			if (!ms) return "—";
			const date = new Date(Number(ms));
			const p = (n) => String(n).padStart(2, "0");
			return date.getFullYear() + "-" + p(date.getMonth() + 1) + "-" + p(date.getDate()) + " " + p(date.getHours()) + ":" + p(date.getMinutes());
		};
		/* ★ 子代理会话数在 aggregate.totals 里，不在 meta 里（曾在这里读错、报成 0%） */
		const subagentSessions = Number(this.aggregate?.totals?.subagentSessions) || 0;
		const subagentRatio = meta.sessions ? Math.round((subagentSessions / meta.sessions) * 100) : 0;

		/* 来源分布要**分开算**：totals.bySource 是「插件 + Skill」的合计，
		   直接写进"插件 71：官方7/自写40…"会出现 40 = 23 插件 + 17 Skill 的口径错乱（真踩过）。 */
		const pluginBySource = { official: 0, self: 0, third: 0, hybrid: 0, pending: 0 };
		for (const item of plugins) pluginBySource[item.source] = (pluginBySource[item.source] || 0) + 1;
		const skillSelf = skills.filter((item) => item.source === "self").length;

		const lines = [];
		lines.push("# DSH 插件/Skill 目录快照");
		lines.push("");
		lines.push("> 生成于 `" + fmtT(now.getTime()) + "`（本地时间）　｜　数据目录 `" + this.dir + "`");
		lines.push("> 本报告由 `dsh-plugin-catalog` 生成，数字与面板同源。");
		lines.push("");
		lines.push("## 概览");
		lines.push("");
		lines.push(
			"- 插件 **" + plugins.length + "**：官方 " + (pluginBySource.official || 0) + " / 自写 " + (pluginBySource.self || 0) + " / 第三方 " + (pluginBySource.third || 0) + " / 混血 " + (pluginBySource.hybrid || 0) + " / 待标记 " + (pluginBySource.pending || 0),
		);
		lines.push("- Skill **" + skills.length + "**（其中自写 " + skillSelf + "）");
		lines.push("- 最近 " + (meta.windowDays || 90) + " 天：**" + fmtN(meta.calls) + "** 次调用 / " + (meta.sessions || 0) + " 个会话 / 其中子代理 " + fmtN(subagentSessions) + " 个（" + subagentRatio + "%）");
		lines.push("- 归属：**" + (stats.total || 0) + "** 个工具（描述指纹 " + (stats.byDescription || 0) + "、名字 " + (stats.byName || 0) + "、判为宿主 " + (stats.host || 0) + "、歧义 " + (stats.unknown || 0) + "）");
		lines.push("- 统计缓存：生成于 " + fmtT(meta.builtAt) + "，耗时 " + (meta.durationMs || 0) + " ms，去重 " + (meta.duplicateCalls || 0) + " 条重复日志");
		lines.push("- 宿主核心工具：" + fmtN(hostCore.calls) + " 次（" + hostCore.tools.length + " 个工具，**不计入任何插件**）");
		lines.push("");

		lines.push("## 调用 Top " + top + "（插件）");
		lines.push("");
		lines.push("| 插件 | 来源 | 总调用 | 父会话直呼 | 含子代理 | 最近使用 | 工具数 |");
		lines.push("|---|---|---:|---:|---:|---|---:|");
		for (const item of plugins.slice().sort((a, b) => (b.calls || 0) - (a.calls || 0)).slice(0, top)) {
			lines.push(
				"| `" + item.name + "` | " + item.source + " | " + fmtN(item.calls) + " | " + fmtN((item.calls || 0) - (item.subagentCalls || 0)) + " | " + fmtN(item.subagentCalls) + " | " + fmtT(item.lastUsed) + " | " + (item.toolCount || 0) + " |",
			);
		}
		lines.push("");

		const uploadable = plugins.filter((item) => item.source === "self" || item.source === "hybrid");
		if (uploadable.length > 0) {
			lines.push("## 自写 / 混血（可上传）");
			lines.push("");
			lines.push("| 名称 | 版本 | 仓库 | git |");
			lines.push("|---|---|---|---|");
			for (const item of uploadable) {
				const git = item.git && item.git.hasGit ? "dirty " + (item.git.dirty ?? 0) + " / ahead " + (item.git.ahead ?? 0) : "（无 .git）";
				lines.push("| `" + item.name + "` | " + (item.version || "—") + " | " + (item.repoUrl || "—") + " | " + git + " |");
			}
			lines.push("");
		}

		const askUser = items.filter((item) => item.askUser);
		if (askUser.length > 0) {
			lines.push("## 待你标一次来源");
			lines.push("");
			for (const item of askUser) lines.push("- `" + item.name + "`（" + item.kind + "）：" + (item.sourceWhy || []).join("；").slice(0, 160));
			lines.push("");
		}

		if (skills.length > 0) {
			lines.push("## Skill");
			lines.push("");
			lines.push("| 名称 | 来源 | 调用 | 最近 | description |");
			lines.push("|---|---|---:|---|---|");
			for (const skill of skills.slice().sort((a, b) => (b.calls || 0) - (a.calls || 0))) {
				lines.push("| `" + skill.name + "` | " + skill.source + " | " + fmtN(skill.calls) + " | " + fmtT(skill.lastUsed) + " | " + (skill.hasDescription ? "有" : "**缺**") + " |");
			}
			lines.push("");
		}

		const weekly = this.weekly || {};
		if (weekly.gap || weekly.security) {
			const summarize = (report) => {
				if (!report || !report.results) return "";
				let high = 0;
				let medium = 0;
				let low = 0;
				for (const repo of report.results) {
					for (const finding of repo.findings || []) {
						if (finding.severity === "high") high += 1;
						else if (finding.severity === "medium") medium += 1;
						else low += 1;
					}
				}
				return "high " + high + " / medium " + medium + " / low " + low;
			};
			lines.push("## 每周任务最近结果");
			lines.push("");
			lines.push("- 缺口分析：" + (weekly.lastGapAt ? fmtT(weekly.lastGapAt) : "从未") + (summarize(weekly.gap) ? "（" + summarize(weekly.gap) + "）" : ""));
			lines.push("- 安全审核：" + (weekly.lastSecurityAt ? fmtT(weekly.lastSecurityAt) : "从未") + (summarize(weekly.security) ? "（" + summarize(weekly.security) + "）" : ""));
			lines.push("");
		}

		lines.push("## 口径与红线");
		lines.push("");
		lines.push("- 统计只读 `.dsh/sessions/**/session*.zstd` 的**全部帧**；同一会话的 v3+v4 双份日志按 `callId` 去重。");
		lines.push("- 落盘内容**只有**会话 ID / 昵称 / 时间戳 / 工具名 / 计数，**没有任何对话文本**。");
		lines.push("- Skill 只能统计「被加载的次数 + 最近一次时间」——机制限制。");
		lines.push("- 工具归属是推断（描述指纹 → 名字字面量 → 判宿主），可在面板手工覆盖。");
		lines.push("");

		const markdown = lines.join("\n");
		const outPath = options.path && typeof options.path === "string" ? options.path : join(this.dir, "reports", "catalog-" + stamp + ".md");
		try {
			await mkdir(join(outPath, ".."), { recursive: true });
			await writeFile(outPath, markdown, "utf8");
		} catch (error) {
			return { ok: false, error: "写报告失败：" + String(error?.message ?? error), markdown };
		}
		return {
			ok: true,
			path: outPath,
			bytes: Buffer.byteLength(markdown, "utf8"),
			summary: { plugins: plugins.length, skills: skills.length, calls: meta.calls || 0, bySource: totals.bySource, askUser: askUser.length },
			preview: markdown.slice(0, 900),
		};
	}

	/* ───────────── 设置 / 自检 ───────────── */

	/** 列全部标签（内置 + 自定义）。 */
	listTags() {
		return listTags(this.tags);
	}

	/**
	 * 冷启动兜底：目录或统计缓存还没有时，在**后台**补上，接口立刻返回。
	 * 面板首次打开走的就是这条路 —— 用户看到的是"正在算"，而不是转圈等到超时。
	 */
	async rebuildIfCold() {
		if (!this.catalog) {
			try {
				this.catalog = await buildCatalog({ dataDir: this.dir, settings: this.settings, force: false });
			} catch (error) {
				this.catalogError = String(error?.message ?? error);
			}
		}
		if (!this.aggregate) this.refreshStatsInBackground();
		return this;
	}

	/** 后台起一次统计重算（已有一个在跑就复用）。 */
	refreshStatsInBackground() {
		if (this.job && (this.job.kind === "stats" || this.job.kind === "weekly-gap")) return { started: false, reason: "已有任务在跑：" + this.job.kind };
		const started = this.startJob("stats", async () => await this.refreshStats({}));
		return started;
	}

	async updateSettings(patch) {
		this.settings = await saveSettings(this.dir, patch, this.settings);
		return this.settings;
	}

	/**
	 * 自检：**回答"现在是什么状态、卡在哪"**，而不是只报 ok。
	 */
	async health() {
		const build = await buildStamp(true);
		const versions = await hostVersions(true);
		const tools = this.toolSchemas().map((schema) => schema.name);
		const own = tools.filter((name) => String(name).startsWith("catalog_"));
		return {
			ok: true,
			build,
			host: versions,
			profileDir: profileDir(),
			workspace: this.workspace,
			dataDir: this.dir,
			/* ★ asar 读不到时「官方」会静默变成 0 个 —— 那看起来像"本机没有官方插件"，
			   其实是宿主安装路径没解析出来。所以把这件事显式报出来。 */
			asar: { path: asarPath(), mode: asarMode(asarPath()), reachable: asarMode(asarPath()) !== "none" },
			toolSchemas: tools.length,
			ownTools: own,
			toolsRegistered: own.length,
			catalog: this.catalog?.counts || null,
			stats: this.statsMeta ? { sessions: this.statsMeta.sessions, calls: this.statsMeta.calls, builtAt: this.statsMeta.builtAt, windowDays: this.statsMeta.windowDays, durationMs: this.statsMeta.durationMs, duplicateCalls: this.statsMeta.duplicateCalls, truncatedSessions: this.statsMeta.truncatedSessions || 0 } : null,
			attribution: this.attrib.stats || null,
			job: this.jobSnapshot(),
			weekly: { lastGapAt: this.weekly?.lastGapAt || 0, lastSecurityAt: this.weekly?.lastSecurityAt || 0 },
			ai: { model: this.settings.aiModel, available: Boolean(readService(this.ctx, "llm")?.stream) },
			warnings: drainWarnings(),
		};
	}
}

/** 计划项的公开视图（去掉内部字段；扫描只给掩码片段）。 */
function publicPlanItem(item) {
	return {
		kind: item.kind,
		id: item.id,
		name: item.name,
		displayName: item.displayName,
		source: item.source,
		repo: item.repo,
		visibility: item.visibility,
		action: item.action,
		reasons: item.reasons,
		localHead: item.localHead,
		remoteExists: item.remoteExists,
		readme: item.readme,
		skills: item.skills || null,
		scan: item.scan ? { files: item.scan.files, worst: item.scan.worst, hits: item.scan.hits.slice(0, 60) } : null,
		error: item.error || "",
	};
}

function loadSettingsDefaults() {
	return JSON.parse(JSON.stringify(DEFAULTS));
}
