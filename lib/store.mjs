/**
 * store.mjs — 数据目录的读写原语（原子写、坏文件留证）。
 *
 * 为什么不用裸 `writeFile`：
 *   统计缓存是「算 40 秒才得到」的东西，一次半截写入就会让它变成坏 JSON；
 *   而坏 JSON 如果被静默 catch 成"空数据"，下一次写入就会把真实缓存覆盖掉
 *   —— 这就是 dsh-usage-plugin 的 storage.js 当初要解决的问题，这里照同一条纪律办：
 *
 *     · 写：同目录临时文件 → fsync → rename 覆盖，失败时目标文件纹丝不动。
 *     · 读：文件不存在才算空；**解析失败就改名为 `.corrupt-<时间戳>` 留证**，
 *           然后才返回 fallback —— 既不崩界面，也不静默毁数据。
 *
 * @module dsh-plugin-catalog/store
 */

import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

const registeredWarnings = [];

/** 建目录（幂等）。 */
export async function ensureDir(dir) {
	await mkdir(dir, { recursive: true });
	return dir;
}

/**
 * 原子写 JSON。
 * @param {string} file 目标绝对路径
 * @param {unknown} value 可 JSON 化的值
 */
export async function writeJson(file, value) {
	const text = JSON.stringify(value, null, 1);
	await atomicWriteText(file, text);
}

/** 原子写文本。 */
export async function atomicWriteText(file, text) {
	await mkdir(dirname(file), { recursive: true });
	const temporary = file + "." + randomUUID() + ".tmp";
	let handle;
	try {
		handle = await open(temporary, "wx");
		await handle.writeFile(text, "utf8");
		await handle.sync();
		await handle.close();
		handle = null;
		await rename(temporary, file);
	} finally {
		if (handle) await handle.close().catch(() => {});
		await unlink(temporary).catch(() => {});
	}
}

/**
 * 读 JSON。
 * @param {string} file
 * @param {unknown} fallback 文件不存在 / 已损坏时返回
 * @returns {Promise<unknown>}
 */
export async function readJson(file, fallback = null) {
	let text;
	try {
		text = await readFile(file, "utf8");
	} catch (error) {
		if (error && error.code === "ENOENT") return fallback;
		registeredWarnings.push({ file, issue: "read-failed", detail: String(error?.message ?? error) });
		return fallback;
	}
	try {
		return JSON.parse(text);
	} catch (error) {
		const quarantine = file + ".corrupt-" + Date.now();
		await rename(file, quarantine).catch(() => {});
		registeredWarnings.push({ file, issue: "corrupt-quarantined", quarantine, detail: String(error?.message ?? error) });
		return fallback;
	}
}

/** 文件存在且非空？ */
export async function hasContent(file) {
	try {
		const info = await stat(file);
		return info.isFile() && info.size > 0;
	} catch {
		return false;
	}
}

/** 文件 mtime（毫秒）；不存在返回 0。 */
export async function mtimeOf(file) {
	try {
		return (await stat(file)).mtimeMs;
	} catch {
		return 0;
	}
}

/** 取出并清空本次进程产生的读警告（面板上要如实展示"缓存坏了，重算过"）。 */
export function drainWarnings() {
	const out = registeredWarnings.splice(0, registeredWarnings.length);
	return out;
}

/** 数据目录下的相对路径 → 绝对路径。 */
export function dataPath(root, ...parts) {
	return join(root, ...parts);
}
