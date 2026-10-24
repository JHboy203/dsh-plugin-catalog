/**
 * asar.mjs — 读 Electron `app.asar` 里的文件。
 *
 * 为什么需要它：**官方插件与宿主核心工具根本不在 profile 里** ——
 * 本机实测 `profile/node_modules/@deepseek-ai/` 只有 cosmokit / dsh-brand /
 * dsh-util-values / schemastery 四个支撑库，而 `dsh.profile.bundles` 里 7 个
 * `@deepseek-ai/*` 条目（含 experimental-*）和 77 个 `dsh-tool-*` 全都在
 * `resources/app.asar` 内部。不读 asar，面板会把「官方」显示成 0 个。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 两种模式（这是踩过坑才写出来的）：
 *
 *   virtual（Electron 宿主里）：Electron 把 `app.asar` **当成目录**打在 fs 上。
 *       所以 `statSync('…app.asar')` 返回的是**目录**，而 `openSync` 打开**归档本身**
 *       会失败（"Electron 的 asar 层不支持打开归档本身"）。此时必须走**成员路径**：
 *         readFileSync('<archive>\\dsh\\node_modules\\@deepseek-ai\\<pkg>\\package.json')
 *
 *   header（纯 node / dev 探针里）：没有 Electron 补丁，按 asar 头解析
 *       （[0,16) 四个 uint32；JSON 长度 = 第 4 个（为 0 时用第 3 个）；数据基址 = 8 + 第 2 个）。
 *
 * 自动探测，别让调用方猜。
 * ══════════════════════════════════════════════════════════════════════════
 *
 * @module dsh-plugin-catalog/asar
 */

import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { resourcesPath } from "./hostinfo.js";

/** asar 里 DSH 包的根（以 / 开头，方便直接拼成员路径）。 */
export const ASAR_PKG_ROOT = "/dsh/node_modules";

const indexCache = new Map();
const modeCache = new Map();

/** app.asar 的完整路径（找不到返回 null）。 */
export function asarPath() {
	const res = resourcesPath();
	if (!res) return null;
	const candidate = join(res, "app.asar");
	try {
		statSync(candidate);
		return candidate;
	} catch {
		return null;
	}
}

/**
 * 探测这个 asar 该用哪种模式读。
 * @returns {'virtual'|'header'|'none'}
 */
export function asarMode(file) {
	if (!file) return "none";
	const cached = modeCache.get(file);
	if (cached) return cached;
	let mode = "none";
	try {
		const info = statSync(file);
		/* Electron 把归档当目录 → virtual；纯 node 里它是普通文件 → 试 header */
		if (info.isDirectory()) mode = "virtual";
	} catch {
		mode = "none";
	}
	if (mode === "none") {
		let fd;
		try {
			fd = openSync(file, "r");
			mode = "header";
		} catch {
			mode = "none";
		} finally {
			if (fd !== undefined) closeSync(fd);
		}
	}
	modeCache.set(file, mode);
	return mode;
}

/**
 * 读 asar 的文件索引（header 模式）。virtual 模式返回 null（用目录 API 代替）。
 * @returns {{file:string, base:number, entries: Map<string,{offset:number,size:number}>}|null}
 */
export function asarIndex(file) {
	if (!file || asarMode(file) !== "header") return null;
	const cached = indexCache.get(file);
	if (cached) return cached;
	let fd;
	try {
		fd = openSync(file, "r");
		const head = Buffer.alloc(16);
		readSync(fd, head, 0, 16, 0);
		const b = head.readUInt32LE(4);
		const c = head.readUInt32LE(8);
		const d = head.readUInt32LE(12);
		const jsonLength = d || c;
		if (!jsonLength || jsonLength > 256 * 1024 * 1024) return null;
		const jsonBuf = Buffer.alloc(jsonLength);
		readSync(fd, jsonBuf, 0, jsonLength, 16);
		const header = JSON.parse(jsonBuf.toString("utf8"));
		const base = 8 + b;
		const entries = new Map();
		const walk = (node, prefix) => {
			if (!node || typeof node !== "object") return;
			if (node.files) {
				for (const [name, child] of Object.entries(node.files)) walk(child, prefix + "/" + name);
				return;
			}
			if (typeof node.offset === "string" || typeof node.offset === "number") {
				entries.set(prefix, { offset: Number(node.offset), size: Number(node.size || 0) });
			}
		};
		walk(header, "");
		const index = { file, base, entries };
		indexCache.set(file, index);
		return index;
	} catch {
		return null;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** 列 asar 里某个目录下的直接子项名（两种模式都支持）。 */
export function listDir(archive, memberDir) {
	if (!archive) return [];
	const mode = asarMode(archive);
	if (mode === "virtual") {
		try {
			return readdirSync(join(archive, memberDir));
		} catch {
			return [];
		}
	}
	if (mode === "header") {
		const index = asarIndex(archive);
		if (!index) return [];
		const prefix = (memberDir.endsWith("/") ? memberDir : memberDir + "/").toLowerCase();
		const names = new Set();
		for (const path of index.entries.keys()) {
			if (!path.toLowerCase().startsWith(prefix)) continue;
			const head = path.slice(prefix.length).split("/")[0];
			if (head !== "") names.add(head);
		}
		return [...names];
	}
	return [];
}

/** 读 asar 里一个文件成文本（两种模式都支持）。 */
export function readText(archive, memberPath) {
	if (!archive) return null;
	const mode = asarMode(archive);
	if (mode === "virtual") {
		try {
			return readFileSync(join(archive, memberPath), "utf8");
		} catch {
			return null;
		}
	}
	if (mode === "header") {
		const index = asarIndex(archive);
		if (!index) return null;
		const entry = index.entries.get(memberPath);
		if (!entry || entry.size <= 0) return null;
		let fd;
		try {
			fd = openSync(archive, "r");
			const buffer = Buffer.alloc(entry.size);
			readSync(fd, buffer, 0, entry.size, index.base + entry.offset);
			return buffer.toString("utf8");
		} catch {
			return null;
		} finally {
			if (fd !== undefined) closeSync(fd);
		}
	}
	return null;
}

/** 读 asar 里一个 package.json。 */
export function readPackageJson(archive, pkgName) {
	const text = readText(archive, ASAR_PKG_ROOT + "/" + pkgName + "/package.json");
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** 列 `<asar>/dsh/node_modules/@deepseek-ai` 下的包名。 */
export function listScopedPackages(archive) {
	return listDir(archive, ASAR_PKG_ROOT + "/@deepseek-ai");
}

/**
 * 列 asar 里**全部**包名（含 scope 全名：`@deepseek-ai/dsh-llm`、`foo`）。
 *
 * ★ R22：配置层健康要回答「这个 `name:` 指向的包到底在不在 asar 里」。
 *   以前只有 `readPackageJson(archive, name)` 一条路 —— 260 条条目就是 260 次读 JSON；
 *   这里一次列完，判据仍然是 asar 的索引/目录本身。
 *
 * @returns {Set<string>|null} asar 读不到时返回 **null**（"无法判定"，不是"没有"）
 */
export function listAsarPackageNames(archive) {
	if (!archive || asarMode(archive) === "none") return null;
	const names = new Set();
	for (const entry of listDir(archive, ASAR_PKG_ROOT)) {
		if (entry.startsWith("@")) {
			const scoped = listDir(archive, ASAR_PKG_ROOT + "/" + entry);
			for (const sub of scoped) names.add(entry + "/" + sub);
		} else if (!entry.startsWith(".")) {
			names.add(entry);
		}
	}
	return names;
}

/** 列一个包目录下的一层成员（只留 .js/.mjs/.cjs）。 */
function listPackageJs(archive, pkgName) {
	const base = ASAR_PKG_ROOT + "/" + pkgName;
	const out = [];
	const walk = (dir, depth) => {
		if (depth > 3 || out.length >= 200) return;
		for (const name of listDir(archive, dir)) {
			const child = dir + "/" + name;
			if (/\.(m?js|cjs)$/i.test(name)) {
				out.push(child);
				continue;
			}
			/* 目录名不含点，且不是文件扩展名 → 继续下探一层 */
			if (!name.includes(".")) walk(child, depth + 1);
		}
	};
	walk(base, 0);
	return out;
}

/** 读一个包里的全部 JS 文本（有上界，用于归属判定）。 */
export function readPackageText(archive, pkgName, maxChars = 1_200_000) {
	let text = "";
	for (const member of listPackageJs(archive, pkgName)) {
		const chunk = readText(archive, member);
		if (chunk) text += chunk + "\n";
		if (text.length >= maxChars) break;
	}
	return text;
}

/** 兼容旧接口：列某前缀下的直接子包名（header 模式用；virtual 模式走 listDir）。 */
export function packagesUnder(index, prefix) {
	if (!index) return [];
	const names = new Set();
	const normalized = prefix.endsWith("/") ? prefix : prefix + "/";
	for (const path of index.entries.keys()) {
		if (!path.startsWith(normalized)) continue;
		const head = path.slice(normalized.length).split("/")[0];
		if (head !== "") names.add(head);
	}
	return [...names].sort();
}
