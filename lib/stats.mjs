/**
 * stats.mjs — 90 天调用统计（唯一数据源：会话事件日志）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 红线（用户明确要求，任何改动不得越过）
 *   · **只读** `.dsh/sessions/`，绝不扫 `.dsh/dsh-checkpoint-rewind/` 那类
 *     单份上百万文件的快照目录；
 *   · 落盘的东西里只允许：会话 ID、会话昵称、时间戳、工具名、计数。
 *     **不允许任何对话文本**（tool 参数在 frames.mjs 里只被读一次、只取 skill 名）。
 *   · Skill 只能统计「被加载的次数 + 最近一次时间」——机制决定的，界面要如实标注。
 *
 * 结构：一个文件一份「part」（按 mtime+size 复用），聚合随时从 parts 重新合并。
 *   这样「刷新」只重读变化的会话（通常 1~2 个文件），而不是再花 40 秒。
 *
 * 实测基线（本机 2026-10-21）：811 个日志 / 455 MB / 59,776 次调用
 *   全量 39 秒（48 ms/文件）。
 * ══════════════════════════════════════════════════════════════════════════
 *
 * @module dsh-plugin-catalog/stats
 */

import { join } from "node:path";
import { listSessionFiles, readSessionFacts } from "./frames.mjs";
import { mtimeOf, readJson, writeJson } from "./store.mjs";

/** 缓存格式版本：字段变了就抬它，旧缓存自动作废（不猜格式）。 */
export const STATS_VERSION = 3;

export const DEFAULT_WINDOW_DAYS = 90;

/** 会话昵称最多留这么长（部分 fallback 标题是首句，截断即可）。 */
const TITLE_MAX = 80;

export function statsFile(dataDir) {
	return join(dataDir, "cache", "stats.json");
}

/**
 * 计算统计（可中断、可报进度）。
 *
 * ★ 去重口径（实测逼出来的）：**36 个会话目录里同时有 v3 与 v4 两份日志**，
 *   内容是同一批调用（callId 集合完全相同、标题相同、header id 相同），
 *   只是压缩格式换了一版。按文件累加会把那 36 个会话的调用**算两遍**
 *   （本机合计约 6,000 次，占 10%）。所以：
 *     ① 先按 `工作区 + 会话ID` 分组；② 组内多个文件按 **callId 去重合并**；
 *     ③ 缓存以**会话**为单位（src 记录每个源文件的 mtime+size 供增量复用）。
 *   按 callId 去重而不是"挑一个文件读"，是因为两种格式版本的内容可能各有缺失，
 *   取并集才不会漏。
 *
 * @param {object} options
 * @param {string} options.sessionsRoot `.dsh/sessions`
 * @param {string} options.dataDir 数据目录
 * @param {number} [options.windowDays=90]
 * @param {(p:{phase:string,done:number,total:number,reused:number,scanned:number,calls:number})=>void} [options.onProgress]
 * @param {{aborted:boolean}} [options.signal] 置 aborted=true 即停
 * @returns {Promise<{ok:boolean, aggregate:object, meta:object, error?:string}>}
 */
export async function computeStats(options) {
	const started = Date.now();
	const windowDays = Number(options.windowDays) > 0 ? Number(options.windowDays) : DEFAULT_WINDOW_DAYS;
	const since = started - windowDays * 86400000;
	const file = statsFile(options.dataDir);
	const previous = await readJson(file, null);
	const previousParts = previous && previous.version === STATS_VERSION && previous.files && typeof previous.files === "object" ? previous.files : {};

	const { files, errors, truncated } = listSessionFiles(options.sessionsRoot, { sinceMs: since });

	/* ① 按会话分组（同一会话的多份日志合成一组） */
	const groups = new Map();
	for (const item of files) {
		const key = item.workspace + "|" + item.sessionId;
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(item);
	}

	const parts = {};
	let scanned = 0;
	let reused = 0;
	let frames = 0;
	let badLines = 0;
	let bytes = 0;
	let calls = 0;
	let duplicateCalls = 0;
	/* 撞上帧数上限的会话数：必须报出来，否则"少算了多少"没人知道 */
	let truncatedSessions = 0;
	const keys = [...groups.keys()];

	for (let index = 0; index < keys.length; index += 1) {
		if (options.signal?.aborted) {
			return { ok: false, aggregate: null, meta: { aborted: true }, error: "aborted" };
		}
		const key = keys[index];
		const group = groups.get(key);
		const groupBytes = group.reduce((sum, f) => sum + f.sizeBytes, 0);
		bytes += groupBytes;

		const cached = previousParts[key];
		if (cached && sameSources(cached.src, group)) {
			parts[key] = cached;
			reused += 1;
			frames += Number(cached.fr) || 0;
			badLines += Number(cached.bad) || 0;
			calls += Number(cached.n) || 0;
			/* 截断标记也要从缓存里读回来，否则增量刷新时这个数字会归零 */
			truncatedSessions += Number(cached.tr) || 0;
		} else {
			const merged = new Map();
			const skills = new Map();
			let header = null;
			let title = "";
			let titleSource = "";
			let groupFrames = 0;
			let groupBad = 0;
			let firstError = "";
			let dup = 0;
			let groupTruncated = false;

			for (const item of group) {
				const facts = readSessionFacts(item.file);
				if (!facts.ok) {
					firstError = firstError || facts.error;
					continue;
				}
				groupFrames += facts.frames || 0;
				groupBad += facts.badLines || 0;
				if (facts.truncated) groupTruncated = true;
				if (header === null && facts.header) header = facts.header;
				if (facts.title && (title === "" || rankTitle(facts.titleSource) >= rankTitle(titleSource))) {
					title = facts.title;
					titleSource = facts.titleSource;
				}
				for (const call of facts.calls) {
					const id = call.callId || call.name + "@" + (call.start ?? 0);
					if (merged.has(id)) {
						dup += 1;
						continue;
					}
					merged.set(id, call);
					if (call.name === "skill" && call.skill) {
						const slot = skills.get(call.skill) ?? { calls: 0, last: 0 };
						slot.calls += 1;
						if (call.start !== null && call.start > slot.last) slot.last = call.start;
						skills.set(call.skill, slot);
					}
				}
			}

			scanned += 1;
			duplicateCalls += dup;
			frames += groupFrames;
			badLines += groupBad;
			calls += merged.size;
			parts[key] = compactPart(key, header, title, titleSource, [...merged.values()], [...skills.entries()], group, groupFrames, groupBad, firstError, dup, groupTruncated);
			if (groupTruncated) truncatedSessions += 1;
		}

		if (typeof options.onProgress === "function" && (index % 25 === 0 || index === keys.length - 1)) {
			options.onProgress({ phase: "scan", done: index + 1, total: keys.length, reused, scanned, calls });
		}
	}

	const meta = {
		version: STATS_VERSION,
		builtAt: Date.now(),
		durationMs: Date.now() - started,
		windowDays,
		since,
		until: Date.now(),
		sessions: Object.keys(parts).length,
		files: files.length,
		scanned,
		reused,
		frames,
		badLines,
		bytes,
		calls,
		duplicateCalls,
		truncatedSessions,
		truncated,
		listErrors: errors.slice(0, 20),
		sessionsRoot: options.sessionsRoot,
	};

	await writeJson(file, { version: STATS_VERSION, meta, files: parts });
	const aggregate = buildAggregate(parts, meta);
	return { ok: true, aggregate, meta };
}

/** 缓存里记的源文件清单与当前分组是否完全一致（条数 + 每份 mtime/size）。 */
function sameSources(src, group) {
	if (!Array.isArray(src) || src.length !== group.length) return false;
	const byPath = new Map(group.map((item) => [item.file, item]));
	for (const row of src) {
		if (!Array.isArray(row) || row.length < 3) return false;
		const [path, mtime, size] = row;
		const current = byPath.get(path);
		if (!current || current.mtimeMs !== mtime || current.sizeBytes !== size) return false;
	}
	return true;
}

/**
 * 把**一个会话（可能由多份日志合并而成）**压成可落盘的 part。
 * **只有计数，没有文本。**
 */
function compactPart(key, header, title, titleSource, mergedCalls, skillEntries, group, frames, bad, error, duplicates, truncated) {
	const [workspace, sessionId] = key.split("|");
	const byTool = new Map();

	for (const call of mergedCalls) {
		const name = call.name || "(unknown)";
		let slot = byTool.get(name);
		if (!slot) {
			slot = { calls: 0, errors: 0, incomplete: 0, ms: 0, msCount: 0, last: 0 };
			byTool.set(name, slot);
		}
		slot.calls += 1;
		if (call.error) slot.errors += 1;
		if (call.incomplete) slot.incomplete += 1;
		if (call.start !== null && call.end !== null && call.end >= call.start) {
			slot.ms += call.end - call.start;
			slot.msCount += 1;
		}
		if (call.start !== null && call.start > slot.last) slot.last = call.start;
	}

	const h = header ?? {};
	/* calls 用数组而不是对象：同名字段重复上百次，数组能省掉一半键名开销。 */
	const calls = [...byTool.entries()].map(([name, s]) => [name, s.calls, s.errors, s.incomplete, Math.round(s.ms), s.msCount, s.last]);
	const maxMtime = group.reduce((max, item) => Math.max(max, item.mtimeMs), 0);

	return {
		sid: sessionId,
		ws: workspace,
		/* 源文件清单：[[path, mtimeMs, size], ...] —— 增量刷新只比这张表 */
		src: group.map((item) => [item.file, item.mtimeMs, item.sizeBytes]),
		m: maxMtime,
		h: {
			c: typeof h.createdAt === "number" ? h.createdAt : 0,
			p: typeof h.parentSession === "string" ? h.parentSession : "",
			o: typeof h.origin === "string" ? h.origin : "",
			d: typeof h.delegationDepth === "number" ? h.delegationDepth : 0,
			t: typeof h.agentPreset === "string" ? h.agentPreset : "",
		},
		t: typeof title === "string" ? title.slice(0, TITLE_MAX) : "",
		ts: titleSource || "",
		calls,
		skills: skillEntries.map(([name, s]) => [name, s.calls, s.last]),
		n: mergedCalls.length,
		dup: duplicates,
		fr: frames,
		bad,
		/* tr = 这个会话有日志撞上帧数上限被截断（增量刷新时也要能读回来） */
		tr: truncated ? 1 : 0,
		err: error || undefined,
	};
}

/**
 * 从 parts 合并出聚合视图。
 *
 * @param {object} parts
 * @param {object} meta
 * @returns {{tools: Map<string, object>, skills: Map<string, object>, sessions: Map<string, object>, totals: object, meta: object}}
 */
export function buildAggregate(parts, meta) {
	const tools = new Map();
	const skills = new Map();
	const sessions = new Map();

	const touchTool = (name) => {
		let entry = tools.get(name);
		if (!entry) {
			entry = { name, calls: 0, errors: 0, incomplete: 0, ms: 0, msCount: 0, lastUsed: 0, firstUsed: 0, sessionCounts: new Map(), sessions: 0 };
			tools.set(name, entry);
		}
		return entry;
	};
	const touchSkill = (name) => {
		let entry = skills.get(name);
		if (!entry) {
			entry = { name, calls: 0, lastUsed: 0, firstUsed: 0, sessions: 0 };
			skills.set(name, entry);
		}
		return entry;
	};

	for (const part of Object.values(parts)) {
		if (!part || !part.sid) continue;
		const key = part.sid;
		let session = sessions.get(key);
		if (!session) {
			session = {
				id: key,
				title: "",
				titleSource: "",
				workspace: part.ws || "",
				createdAt: 0,
				parent: "",
				origin: "",
				depth: 0,
				preset: "",
				calls: 0,
				errors: 0,
				firstAt: 0,
				lastAt: 0,
				files: 0,
				readError: "",
			};
			sessions.set(key, session);
		}
		session.files += 1;
		if (part.err) session.readError = String(part.err);
		if (part.t && (session.title === "" || rankTitle(part.ts) >= rankTitle(session.titleSource))) {
			session.title = part.t;
			session.titleSource = part.ts || "";
		}
		const h = part.h || {};
		if (!session.createdAt && h.c) session.createdAt = h.c;
		if (!session.parent && h.p) session.parent = h.p;
		if (!session.origin && h.o) session.origin = h.o;
		if ((h.d || 0) > session.depth) session.depth = h.d || 0;
		if (!session.preset && h.t) session.preset = h.t;

		for (const row of part.calls || []) {
			if (!Array.isArray(row) || row.length < 7) continue;
			const [name, calls, errors, incomplete, ms, msCount, last] = row;
			const tool = touchTool(name);
			tool.calls += calls;
			tool.errors += errors;
			tool.incomplete += incomplete;
			tool.ms += ms;
			tool.msCount += msCount;
			if (last > tool.lastUsed) tool.lastUsed = last;
			if (last > 0 && (tool.firstUsed === 0 || last < tool.firstUsed)) tool.firstUsed = last;
			tool.sessionCounts.set(key, (tool.sessionCounts.get(key) || 0) + calls);
			session.calls += calls;
			session.errors += errors;
			if (last > session.lastAt) session.lastAt = last;
			if (last > 0 && (session.firstAt === 0 || last < session.firstAt)) session.firstAt = last;
		}
		for (const row of part.skills || []) {
			if (!Array.isArray(row) || row.length < 3) continue;
			const [name, calls, last] = row;
			const skill = touchSkill(name);
			skill.calls += calls;
			if (last > skill.lastUsed) skill.lastUsed = last;
			if (last > 0 && (skill.firstUsed === 0 || last < skill.firstUsed)) skill.firstUsed = last;
		}
	}

	for (const tool of tools.values()) tool.sessions = tool.sessionCounts.size;

	/* 会话昵称缺失时用 ID 前 8 位兜底 —— 界面上不能出现一整列空白。 */
	for (const session of sessions.values()) {
		if (session.title === "") session.title = session.id.slice(0, 8);
		if (!session.createdAt) session.createdAt = session.firstAt;
		if (!session.lastAt) session.lastAt = session.createdAt;
	}

	const totals = {
		calls: 0,
		errors: 0,
		sessions: sessions.size,
		tools: tools.size,
		skills: skills.size,
		subagentSessions: 0,
	};
	for (const tool of tools.values()) {
		totals.calls += tool.calls;
		totals.errors += tool.errors;
	}
	for (const session of sessions.values()) if (session.parent || session.depth > 0) totals.subagentSessions += 1;

	return { tools, skills, sessions, totals, meta };
}

function rankTitle(source) {
	if (source === "user") return 3;
	if (source === "provider") return 2;
	if (source === "fallback") return 1;
	return 0;
}

/** 读缓存里的 parts 并直接出聚合（不写盘、不扫日志）。 */
export async function loadAggregate(dataDir, windowDays) {
	const cached = await readJson(statsFile(dataDir), null);
	if (!cached || cached.version !== STATS_VERSION || !cached.files) {
		return { aggregate: null, meta: null, stale: true };
	}
	const meta = cached.meta || {};
	const want = Number(windowDays) > 0 ? Number(windowDays) : DEFAULT_WINDOW_DAYS;
	if (Number(meta.windowDays) !== want) {
		/* 窗口变了：缓存口径不一致，先给出旧聚合并标 stale，由调用方决定是否重算 */
		return { aggregate: buildAggregate(cached.files, meta), meta, stale: true, reason: "window-changed" };
	}
	return { aggregate: buildAggregate(cached.files, meta), meta, stale: false };
}

/**
 * 某会话的**后代会话**（子代理链）。
 * 「父会话里显示含子代理 N 次」就靠它；深度实测最深处 3 层。
 */
export function descendantsOf(sessions, id, maxDepth = 6) {
	const children = new Map();
	for (const session of sessions.values()) {
		if (!session.parent) continue;
		if (!children.has(session.parent)) children.set(session.parent, []);
		children.get(session.parent).push(session.id);
	}
	const out = [];
	let frontier = [id];
	const seen = new Set([id]);
	for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
		const next = [];
		for (const current of frontier) {
			for (const child of children.get(current) ?? []) {
				if (seen.has(child)) continue;
				seen.add(child);
				out.push(child);
				next.push(child);
			}
		}
		frontier = next;
	}
	return out;
}

/** 缓存是否足够新（毫秒）；用于面板显示「数据是几分钟前的」。 */
export async function cacheAgeMs(dataDir) {
	const mtime = await mtimeOf(statsFile(dataDir));
	return mtime > 0 ? Date.now() - mtime : null;
}
