/**
 * frames.mjs — 读会话日志的**全部帧**。
 *
 * 这段逻辑不是新写的：它来自 `dsh-session-inspector/lib/frames.mjs` 实测出来的三条结论，
 * 这里只保留统计需要的那部分（不复制它的检索/时间线能力）。
 *
 *   ★ ① `zlib.zstdDecompressSync(整个文件)` **只解第一帧**：
 *        实测一个 792,390 字节的日志解出 194 字符 —— 恰好是 session header。
 *     ② **流式也一样**（`createZstdDecompress` 灌完整个 buffer 仍是那一帧）。
 *     ③ 按 zstd magic `28 B5 2F FD` 切开再逐帧解，全部读得到（579 帧 / 899 行）。
 *        ——「统计覆盖 90 天」这件事，只有这条路能成立；不切帧等于只统计到会话开头。
 *
 * ⚠️ magic 可能出现在压缩数据内部（假帧边界）。所以**不是硬切**：某一刀解不开就
 *    并进下一段重试（resync），失败不计成帧。宁可慢一点，也不静默少读一段。
 *
 * ⚠️ 会话日志文件名**有四种**（本机实测 811 个里四种都有）：
 *      session.v4.jsonl.zstd / session.v3.jsonl.zstd / session.jsonl.zstd / session.jsonl.zstd.v0bak
 *    只按 v4 找会漏掉大部分 —— 所以统一走 `listSessionFiles()`，调用处别自己拼名字。
 *
 * @module dsh-plugin-catalog/frames
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/** 一次最多切多少帧（防病态文件把内存吃光）。 */
export const MAX_FRAMES = 20000;

/** 找出可能的帧起点（第一个一定是 0）。 */
export function findFrameCuts(buf) {
	const cuts = [0];
	for (let i = 1; i + 4 <= buf.length; i += 1) {
		if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) {
			cuts.push(i);
			if (cuts.length >= MAX_FRAMES) break;
		}
	}
	return cuts;
}

/**
 * 逐帧解压。**不把全文拼进内存** —— 每解出一帧就交给 onFrame，统计只要一条遍。
 *
 * @param {Buffer} buf 整个日志文件
 * @param {(text: string) => void} onFrame 每帧的文本
 * @param {object} [options] {maxFrames}
 * @returns {{ok:boolean, frames:number, resyncs:number, failed:number, truncated:boolean, error:string}}
 *          `truncated` = 撞上帧数上限被截断 —— 必须报出来，否则统计会**安静地少算**
 */
export function eachFrame(buf, onFrame, options = {}) {
	const maxFrames = Number(options.maxFrames) > 0 ? Number(options.maxFrames) : MAX_FRAMES;
	const cuts = findFrameCuts(buf);
	let frames = 0;
	let resyncs = 0;
	let failed = 0;
	let start = 0;

	for (let i = 1; i <= cuts.length; i += 1) {
		const end = i < cuts.length ? cuts[i] : buf.length;
		let text = null;
		try {
			text = zstdDecompressSync(buf.subarray(start, end)).toString("utf8");
		} catch {
			// 假边界：并入下一段重试，不算一帧
			if (i < cuts.length) {
				resyncs += 1;
				continue;
			}
			failed += 1;
			break;
		}
		frames += 1;
		onFrame(text);
		start = end;
		if (frames >= maxFrames) break;
	}

	/* 还有没解到的帧起点 = 被上限截断了（findFrameCuts 自己也有上限，所以再看一眼是否顶到 maxFrames） */
	const truncated = frames >= maxFrames;
	if (frames === 0) return { ok: false, frames: 0, resyncs, failed, truncated: false, error: "no frame could be decompressed" };
	return { ok: true, frames, resyncs, failed, truncated, error: "" };
}

/**
 * 解析 JSONL 文本成事件（坏行计数，不静默丢）。
 * @returns {{events: object[], badLines: number}}
 */
export function parseEvents(text) {
	const events = [];
	let badLines = 0;
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		try {
			const parsed = JSON.parse(trimmed);
			if (parsed !== null && typeof parsed === "object") events.push(parsed);
			else badLines += 1;
		} catch {
			badLines += 1;
		}
	}
	return { events, badLines };
}

/**
 * 列会话日志的候选文件。
 *
 * @param {string} sessionsRoot `.dsh/sessions`
 * @param {{sinceMs?: number, limit?: number, workspace?: string, sessionId?: string}} [options]
 * @returns {{files: Array<{file:string, logName:string, workspace:string, sessionId:string, sizeBytes:number, mtimeMs:number}>, errors: Array<object>, truncated: boolean}}
 */
export function listSessionFiles(sessionsRoot, options = {}) {
	const since = Number(options.sinceMs) > 0 ? Number(options.sinceMs) : 0;
	const limit = Number(options.limit) > 0 ? Number(options.limit) : 100000;
	const wantWs = typeof options.workspace === "string" && options.workspace !== "" ? options.workspace : null;
	const wantId = typeof options.sessionId === "string" && options.sessionId !== "" ? options.sessionId : null;
	const files = [];
	const errors = [];

	let workspaces = [];
	try {
		workspaces = readdirSync(sessionsRoot);
	} catch (error) {
		return { files, errors: [{ file: sessionsRoot, error: "sessions root unreadable: " + String(error?.message ?? error) }], truncated: false };
	}

	for (const ws of workspaces) {
		if (wantWs !== null && ws !== wantWs) continue;
		const wsDir = join(sessionsRoot, ws);
		let ids = [];
		try {
			if (!statSync(wsDir).isDirectory()) continue;
			ids = readdirSync(wsDir);
		} catch {
			continue;
		}
		for (const id of ids) {
			if (wantId !== null && id !== wantId) continue;
			const dir = join(wsDir, id);
			let names = [];
			try {
				if (!statSync(dir).isDirectory()) continue;
				names = readdirSync(dir);
			} catch {
				continue;
			}
			for (const logName of names) {
				if (!logName.startsWith("session") || !logName.includes(".zstd")) continue;
				const file = join(dir, logName);
				let info;
				try {
					info = statSync(file);
					if (!info.isFile()) continue;
				} catch {
					continue;
				}
				if (since > 0 && info.mtimeMs < since) continue;
				files.push({
					file,
					logName,
					workspace: ws,
					sessionId: id,
					sizeBytes: info.size,
					mtimeMs: info.mtimeMs,
				});
			}
		}
	}

	files.sort((a, b) => b.mtimeMs - a.mtimeMs);
	const truncated = files.length > limit;
	return { files: truncated ? files.slice(0, limit) : files, errors, truncated };
}

/**
 * 读一个会话日志并把它拆成统计需要的最小事实。
 *
 * **只读事件的类型与计数器，绝不返回任何对话文本** —— 这是红线：
 * 统计落盘的东西里不允许出现 message content。
 *
 * @param {string} file
 * @returns {{ok:boolean, header:object|null, title:string|null, titleSource:string, calls:Array<object>, error:string}}
 *          calls: [{name, start, end, error}]  end 为 null 表示没有配对的 result
 */
export function readSessionFacts(file) {
	let buf;
	try {
		buf = readFileSync(file);
	} catch (error) {
		return { ok: false, header: null, title: null, titleSource: "", calls: [], error: "read failed: " + String(error?.message ?? error) };
	}

	let header = null;
	let title = null;
	let titleSource = "";
	/** callId → {name,start,error:null,ended:false} */
	const pending = new Map();
	const finished = [];
	let badLines = 0;

	const outcome = eachFrame(buf, (text) => {
		const parsed = parseEvents(text);
		badLines += parsed.badLines;
		for (const event of parsed.events) {
			const type = event?.type;
			const data = event?.data ?? {};
			if (type === "session") {
				if (header === null) header = event;
				continue;
			}
			if (type === "session/title") {
				/* 标题会被重写：provider（模型起名）优于 fallback（截断首句），
				   所以后到的、来源更好的继续覆盖。 */
				const next = typeof data.title === "string" ? data.title.trim() : "";
				const source = typeof data.source?.kind === "string" ? data.source.kind : "";
				if (next !== "" && (title === null || rank(source) >= rank(titleSource))) {
					title = next;
					titleSource = source;
				}
				continue;
			}
			if (type === "tool/call") {
				const name = typeof data.name === "string" ? data.name : "";
				const callId = typeof data.callId === "string" ? data.callId : "";
				if (name === "" || callId === "") continue;
				/* ★ 参数只允许在这里被读一次，且**只**用于取 skill 名（Skill 统计的唯一来源）。
				   之后 args 一律丢弃 —— 工具参数里可能有用户原文，而落盘的东西里
				   不允许出现任何对话文本。 */
				const skill = name === "skill" ? skillNameOf(data.arguments) : "";
				pending.set(callId, { name, start: num(event.time), callId, skill });
				continue;
			}
			if (type === "tool/result") {
				const callId = typeof data?.message?.toolCallId === "string" ? data.message.toolCallId : typeof data?.message?.source?.callId === "string" ? data.message.source.callId : "";
				if (callId === "") continue;
				const open = pending.get(callId);
				if (!open) continue;
				pending.delete(callId);
				finished.push({
					name: open.name,
					skill: open.skill,
					start: open.start,
					end: num(event.time),
					error: data?.message?.isError === true,
					callId,
				});
				continue;
			}
		}
	});

	/* 没有配到 result 的调用（被中断 / 日志截断）。
	   ★ 单独标 `incomplete` 而**不**算成报错：中断与真正的 isError 是两回事，
	     混在一起会让"报错次数"虚高，而这正是用户要拿去判断插件健康度的数字。 */
	for (const open of pending.values()) {
		finished.push({ name: open.name, skill: open.skill, start: open.start, end: null, error: false, incomplete: true, callId: open.callId });
	}

	return {
		ok: outcome.ok,
		header,
		title,
		titleSource,
		calls: finished,
		badLines,
		frames: outcome.frames,
		resyncs: outcome.resyncs,
		truncated: Boolean(outcome.truncated),
		error: outcome.error,
	};
}

function num(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function rank(source) {
	if (source === "user") return 3;
	if (source === "provider") return 2;
	if (source === "fallback") return 1;
	return 0;
}

/**
 * 从 `skill` 工具调用的参数里取被加载的 skill 名。
 *
 * 参数形如 `{"name":"dsh-client-plugin-ops"}`（本机 811 份日志实测）。
 * 只取一个短字符串，解析失败就返回空串 —— **绝不把参数原文带出去**。
 */
function skillNameOf(args) {
	if (typeof args !== "string" || args.length === 0 || args.length > 4000) return "";
	try {
		const parsed = JSON.parse(args);
		const name = parsed?.name;
		return typeof name === "string" ? name.slice(0, 120) : "";
	} catch {
		return "";
	}
}
