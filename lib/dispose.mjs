/**
 * dispose.mjs — 面板动作的**执行层**（唯一碰盘的地方，写前一律备份）。
 *
 * 与 `actions.mjs` 的分工：
 *   · `actions.mjs` 只判"能不能、会发生什么"（纯函数，探针能钉死）；
 *   · 本模块只做"怎么做"：回收站、备份、原子写入、写后校验、留痕。
 *
 * ★ 五条硬纪律：
 *   1. **Skill 删除是可逆的**：整目录移进 `<数据目录>/trash/skills/<id>/`，绝不用 unlink/rmdir
 *      直接抹掉用户的东西；还原时移回原位（原位已存在就拒绝，不覆盖）。
 *   2. **改组合文件前先备份**：原名旁边留 `.bak-<时间戳>`；写后重新解析，
 *      校验失败**自动回滚**（把备份写回去），并如实报告"回滚了"。
 *   3. **原子写**：先写 `.tmp-*` 再 rename，避免半截文件把 DSH 的配置弄坏。
 *   4. **留痕**：成功与失败都记一条（最多 100 条）——"它怎么不见了"要能查到。
 *   5. **不猜路径**：所有路径由调用方（service）传入；本模块不 import hostinfo。
 *
 * @module dsh-plugin-catalog/dispose
 */

import { copyFile, cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

/* ───────────── 时间戳 / 小工具 ───────────── */

/** 与 staging 备份同一格式：`20261027-003015`（人能读、可排序）。 */
export function stampOf(ms = Date.now()) {
	const date = new Date(Number(ms) || Date.now());
	const pad = (n) => String(n).padStart(2, "0");
	return date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate()) + "-" + pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds());
}

/** 回收站里的目录名：只留 ASCII 安全字符（中文名保留，非法字符换 -）。 */
export function trashIdOf(name, ms = Date.now()) {
	const safe = String(name || "skill").replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "skill";
	return stampOf(ms) + "-" + safe;
}

/* ───────────── 留痕（actions-journal.json） ───────────── */

export const ACTION_JOURNAL_VERSION = 1;
export const ACTION_JOURNAL_LIMIT = 100;

export function actionJournalFile(dataDir) {
	return join(String(dataDir || ""), "actions-journal.json");
}

export async function readActionJournal(file) {
	try {
		const raw = JSON.parse(await readFile(file, "utf8"));
		if (raw && raw.version === ACTION_JOURNAL_VERSION && Array.isArray(raw.items)) return raw;
	} catch {
		/* 没有/坏了都当空：留痕不该让动作失败 */
	}
	return { version: ACTION_JOURNAL_VERSION, items: [] };
}

export async function appendActionJournal(file, entry, limit = ACTION_JOURNAL_LIMIT) {
	const journal = await readActionJournal(file);
	journal.items.push(entry);
	journal.items = journal.items.slice(-Math.max(1, Number(limit) || ACTION_JOURNAL_LIMIT));
	try {
		await mkdir(join(file, ".."), { recursive: true });
		await writeFile(file, JSON.stringify(journal, null, 0), "utf8");
	} catch {
		/* 留痕失败不能盖住动作结果 */
	}
	return journal;
}

/* ───────────── 回收站（trash/skills） ───────────── */

export const TRASH_INDEX_VERSION = 1;

export function trashRoot(dataDir) {
	return join(String(dataDir || ""), "trash", "skills");
}

export function trashIndexFile(dataDir) {
	return join(String(dataDir || ""), "trash", "skills.json");
}

export async function readTrashIndex(file) {
	try {
		const raw = JSON.parse(await readFile(file, "utf8"));
		if (raw && Array.isArray(raw.items)) return { version: TRASH_INDEX_VERSION, items: raw.items };
	} catch {
		/* 没有索引就是空回收站 */
	}
	return { version: TRASH_INDEX_VERSION, items: [] };
}

async function writeTrashIndex(file, index) {
	await mkdir(join(file, ".."), { recursive: true });
	await writeFile(file, JSON.stringify({ version: TRASH_INDEX_VERSION, items: index.items }, null, 0), "utf8");
}

/**
 * 把一个目录移进回收站。
 *
 * @param {{dir:string, name:string, dataDir:string, at?:number, note?:string}} input
 * @returns {Promise<{ok:boolean, id:string, from:string, to:string, mode:string, error?:string, at:number}>}
 */
export async function moveToTrash(input = {}) {
	const dir = String(input.dir || "");
	const name = String(input.name || "");
	const dataDir = String(input.dataDir || "");
	const at = Number(input.at) || Date.now();
	const fail = (error, id = "") => ({ ok: false, id, from: dir, to: "", mode: "", error, at });
	if (dir === "") return fail("没有源目录");
	if (dataDir === "") return fail("没有数据目录（回收站无处可放）");
	let info;
	try {
		info = await stat(dir);
	} catch {
		return fail("源目录不存在：" + dir);
	}
	if (!info.isDirectory()) return fail("源路径不是目录：" + dir);
	const root = trashRoot(dataDir);
	const id = trashIdOf(name, at);
	const to = join(root, id);
	try {
		await mkdir(root, { recursive: true });
	} catch (error) {
		return fail("建回收站失败：" + String(error?.message ?? error));
	}
	if (existsSync(to)) return fail("回收站里已经有同名目标：" + to, id);
	let mode = "rename";
	try {
		await rename(dir, to);
	} catch {
		/* 跨卷 / 被占用时退回"复制 + 删除源"（先复制成功才删源） */
		try {
			await cp(dir, to, { recursive: true, force: false, errorOnExist: true });
		} catch (error) {
			return fail("移动失败（rename 与复制都不行）：" + String(error?.message ?? error), id);
		}
		try {
			await rm(dir, { recursive: true, force: true });
		} catch (error) {
			/* 复制成功但源删不掉：如实报错并保留下落，别谎报成功 */
			return { ok: false, id, from: dir, to, mode: "copy-partial", error: "已复制到回收站，但源目录删不掉：" + String(error?.message ?? error), at };
		}
		mode = "copy";
	}
	const index = await readTrashIndex(trashIndexFile(dataDir));
	index.items.push({ id, kind: "skill", name, from: dir, to, at, mode, note: String(input.note || "") });
	await writeTrashIndex(trashIndexFile(dataDir), index);
	return { ok: true, id, from: dir, to, mode, at };
}

/**
 * 从回收站还原。原位已存在就拒绝（绝不覆盖用户现在用的那份）。
 *
 * @param {{id:string, dataDir:string, at?:number}} input
 */
export async function restoreFromTrash(input = {}) {
	const id = String(input.id || "");
	const dataDir = String(input.dataDir || "");
	const at = Number(input.at) || Date.now();
	if (id === "") return { ok: false, code: "no-id", error: "没给回收站 id" };
	const index = await readTrashIndex(trashIndexFile(dataDir));
	const item = index.items.find((entry) => entry.id === id);
	if (!item) return { ok: false, code: "not-found", error: "回收站里没有这一条：" + id };
	if (item.restoredAt) return { ok: false, code: "already-restored", error: "它已经在 " + stampOf(item.restoredAt) + " 还原过了" };
	if (existsSync(item.to) === false) return { ok: false, code: "missing", error: "回收站里的目录已经不在了：" + item.to };
	if (existsSync(item.from)) return { ok: false, code: "occupied", error: "原位已经有同名目录：" + item.from + "（不覆盖，请先处理它）" };
	try {
		await mkdir(join(item.from, ".."), { recursive: true });
		await rename(item.to, item.from);
	} catch {
		try {
			await cp(item.to, item.from, { recursive: true, force: false, errorOnExist: true });
			await rm(item.to, { recursive: true, force: true });
		} catch (error) {
			return { ok: false, code: "move-failed", error: "还原失败：" + String(error?.message ?? error) };
		}
	}
	item.restoredAt = at;
	await writeTrashIndex(trashIndexFile(dataDir), index);
	return { ok: true, id, from: item.from, to: item.to, at, text: "已还原到 " + item.from };
}

/** 回收站现状（面板「回收站」用；只读）。 */
export async function trashStatus(dataDir) {
	const index = await readTrashIndex(trashIndexFile(dataDir));
	const items = [];
	for (const item of index.items.slice().reverse()) {
		let present = false;
		try {
			present = (await stat(item.to)).isDirectory();
		} catch {
			present = false;
		}
		items.push({ ...item, present: present && !item.restoredAt });
	}
	return { root: trashRoot(dataDir), file: trashIndexFile(dataDir), total: items.length, restorable: items.filter((item) => item.present).length, items: items.slice(0, 40) };
}

/* ───────────── 写盘：备份 + 原子写 + 写后校验 ───────────── */

/**
 * 改一个文本文件：先备份、再原子写、再用 `verify` 复核；复核失败**自动回滚**。
 *
 * @param {object} input
 * @param {string} input.file
 * @param {(text:string)=>string} input.transform 原文本 → 新文本（纯函数）
 * @param {(before:string, after:string)=>object} [input.verify] 返回 `{ok, reason}`
 * @param {number} [input.at]
 * @param {boolean} [input.createIfMissing]
 * @returns {Promise<object>}
 */
export async function rewriteTextFile(input = {}) {
	const file = String(input.file || "");
	const at = Number(input.at) || Date.now();
	if (file === "") return { ok: false, code: "no-file", error: "没给文件路径" };
	let before = "";
	let existed = true;
	try {
		before = await readFile(file, "utf8");
	} catch {
		existed = false;
		if (!input.createIfMissing) return { ok: false, code: "missing", error: "文件不存在：" + file };
	}
	const stamp = stampOf(at);
	const backup = existed ? file + ".bak-" + stamp : "";
	if (existed) {
		try {
			await copyFile(file, backup);
		} catch (error) {
			return { ok: false, code: "backup-failed", error: "备份失败（没敢动原文件）：" + String(error?.message ?? error) };
		}
	}
	let after;
	try {
		after = String(input.transform(before) ?? "");
	} catch (error) {
		return { ok: false, code: "transform-failed", error: "生成新内容失败：" + String(error?.message ?? error), backup };
	}
	if (after === before) return { ok: true, changed: false, file, backup, before: before.length, after: after.length, text: "内容没有变化（幂等，不写盘）" };
	const tmp = file + ".tmp-" + stamp + "-" + Math.random().toString(36).slice(2, 8);
	try {
		await mkdir(join(file, ".."), { recursive: true });
		await writeFile(tmp, after, "utf8");
		await rename(tmp, file);
	} catch (error) {
		try {
			await rm(tmp, { force: true });
		} catch {
			/* 临时文件删不掉不影响结论 */
		}
		return { ok: false, code: "write-failed", error: "写盘失败：" + String(error?.message ?? error), backup };
	}
	const verdict = typeof input.verify === "function" ? input.verify(before, after) : { ok: true, reason: "" };
	if (!verdict || verdict.ok !== true) {
		/* 复核不过：把备份写回原位（能救就救），并如实说"回滚了" */
		let rolledBack = false;
		if (existed) {
			try {
				await copyFile(backup, file);
				rolledBack = true;
			} catch {
				rolledBack = false;
			}
		}
		return {
			ok: false,
			code: "verify-failed",
			error: "写后校验没过：" + (verdict ? verdict.reason : "校验函数没返回") + (rolledBack ? "（已回滚原文件）" : "（回滚也失败了，请从备份恢复：" + backup + "）"),
			backup,
			rolledBack,
			file,
		};
	}
	return { ok: true, changed: true, file, backup, before: before.length, after: after.length, verify: verdict, text: "已写入 " + file + "（备份 " + backup + "）" };
}

/** 给面板看的一行（备份落在哪、字节怎么变）。 */
export function describeWriteResult(result) {
	const value = result || {};
	if (value.ok !== true) return "没写成：" + (value.error || value.code || "未知原因");
	if (value.changed === false) return value.text || "没有变化";
	return "已写入（" + (value.before || 0) + " → " + (value.after || 0) + " 字节）" + (value.backup ? "；备份 " + value.backup : "");
}
