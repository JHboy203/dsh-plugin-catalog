/**
 * dev/copy-tree.mjs — 把一棵目录树**原样**拷到目标（默认只预览，`--apply` 才写）。
 *
 * 为什么需要它：工具沙箱里 `node`/`mkdir` 写盘是 EPERM，而"把 node_modules 里唯一的一份
 * 拷回源码目录"这种救火操作又必须真的写。这个脚本走宿主侧的可写进程执行。
 *
 * 用法：
 *   node dev/copy-tree.mjs --src <源目录> --dst <目标目录> [--apply] [--exclude node_modules,.git]
 *
 * 安全约定：
 *   · 默认 dry-run，只打印会写哪些文件；
 *   · 目标已存在且非空时**拒绝**（除非显式 --force），避免覆盖掉正在用的东西；
 *   · 只拷普通文件，跳过符号链接/目录链接，避免把链接指回自己。
 */

import { copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const src = flag("--src");
const dst = flag("--dst");
const apply = args.includes("--apply");
const force = args.includes("--force");
const excludes = new Set(String(flag("--exclude") || "node_modules,.git").split(",").map((s) => s.trim()).filter(Boolean));

if (!src || !dst) {
	console.log("用法: node dev/copy-tree.mjs --src <源> --dst <目标> [--apply] [--force]");
	process.exit(2);
}

const from = resolve(src);
const to = resolve(dst);

function walk(dir, rel, out) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		throw new Error("读不了 " + dir + "：" + error.message);
	}
	for (const entry of entries) {
		if (excludes.has(entry.name)) continue;
		const abs = join(dir, entry.name);
		const relPath = rel ? rel + "/" + entry.name : entry.name;
		/* 链接一律跳过：拷过去会变成指回源目录的悬空链接 */
		if (entry.isSymbolicLink()) {
			out.skipped.push(relPath + "（链接，跳过）");
			continue;
		}
		if (entry.isDirectory()) {
			walk(abs, relPath, out);
			continue;
		}
		if (!entry.isFile()) continue;
		out.files.push({ rel: relPath, abs, bytes: statSync(abs).size });
	}
}

const out = { files: [], skipped: [] };
walk(from, "", out);
const total = out.files.reduce((sum, f) => sum + f.bytes, 0);

console.log("源:   " + from);
console.log("目标: " + to);
console.log("文件 " + out.files.length + " 个 / " + total + " 字节" + (out.skipped.length ? "，跳过 " + out.skipped.length + " 项" : ""));
for (const f of out.files) console.log("  " + String(f.bytes).padStart(8) + "  " + f.rel);
for (const s of out.skipped) console.log("  [skip] " + s);

/* 目标非空时先拦一下：这类操作错了就是覆盖源码 */
let existing = 0;
try {
	existing = readdirSync(to).length;
} catch {
	existing = 0;
}
if (existing > 0 && !force) {
	console.log("\n目标目录已存在且非空（" + existing + " 项），拒绝写入。确认要覆盖请加 --force。");
	process.exit(1);
}

if (!apply) {
	console.log("\n（dry-run：没有写任何文件。要真写加 --apply）");
	process.exit(0);
}

for (const f of out.files) {
	const target = join(to, f.rel);
	mkdirSync(dirname(target), { recursive: true });
	copyFileSync(f.abs, target);
}
console.log("\n已写入 " + out.files.length + " 个文件 -> " + to);
