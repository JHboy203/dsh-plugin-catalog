/**
 * dev/run-probes.mjs — 把九个**独立探针**串成一条（R18；R20 加副本判据；R22 加配置层；
 * R26 加交接单；R27 加处置对账）。
 *
 * ★ 为什么要有它：探针一直是「有人记得就跑一下」——交接文件里写着五条命令，
 *   而 `dev/ship.mjs` 只跑三层自检（audit / render-check / hosttest），
 *   于是**不变式探针从来没进过发版体检**。R16/R17 两轮都是靠人手动补跑才发现回归的。
 *   这条脚本把它们收进 ship 的第 5 项：一条命令 = 三层自检 + 七个探针 + 副本同步。
 *
 * ★ 为什么用子进程而不是 import：探针脚本失败时 `process.exit(1)`，
 *   import 进来会把整条巡检一起带走。而且它们各自「不碰真数据」的承诺，
 *   靠的正是"独立进程 + 自己的合成数据"。
 *
 * 用法：`node dev/run-probes.mjs`；任一探针失败 → 退出码 1。
 * 输出格式对齐 ship 的解析器（最后的 `  passed: N` / `  failed: M`）。
 */

import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
/* R31：清单搬到 dev/probe-list.mjs —— audit 要数它（文档里的「十一个 / 231 条」得与真实一致），
   这里只负责**跑**。import 数据文件不会起子进程，所以两边都安全。 */
import { PROBES } from "./probe-list.mjs";

const run = promisify(execFile);
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 探针收尾行形如 `probe-tags: passed 12 / failed 0`。 */
function parseCounts(text) {
	const match = /passed\s+(\d+)\s*\/\s*failed\s+(\d+)/.exec(String(text || ""));
	return match ? { passed: Number(match[1]), failed: Number(match[2]) } : null;
}

/**
 * 另两个探针（loadstate / uninstall）不报 passed/failed，而是收尾一行
 * `✓ 七条不变式全部成立（I1 … / I2 …）` —— 于是按里面列出的不变式编号计数，
 * 不靠中文数字（"七条"换个说法就解析不出来了）。
 */
function parseInvariants(text) {
	const line = String(text || "")
		.split(/\r?\n/)
		.reverse()
		.find((item) => /不变式全部成立/.test(item));
	if (!line) return null;
	const ids = new Set(line.match(/\bI\d+\b/g) || []);
	return ids.size > 0 ? { passed: ids.size, failed: 0 } : null;
}

let passed = 0;
let failed = 0;
const failures = [];

for (const probe of PROBES) {
	const script = join(REPO, probe.file);
	let text = "";
	let code = 0;
	try {
		const result = await run(process.execPath, [script], { cwd: REPO, timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
		text = String(result.stdout || "") + String(result.stderr || "");
	} catch (error) {
		code = 1;
		text = String(error?.stdout || "") + String(error?.stderr || "") + String(error?.message || "");
	}
	const counts = parseCounts(text) || (code === 0 ? parseInvariants(text) : null);
	if (!counts) {
		failed += 1;
		const why = /EPERM/.test(text) ? "沙箱禁止带管道 spawn —— 这条要在宿主里跑（host_selfcheck）" : "没有输出结果行（脚本可能语法错或被中断）";
		failures.push(probe.label + "（" + probe.id + "）：" + why);
		console.log("✗ " + probe.label + "（" + probe.id + "）：" + why);
		continue;
	}
	passed += counts.passed;
	failed += counts.failed;
	const ok = counts.failed === 0 && code === 0;
	console.log((ok ? "✓ " : "✗ ") + probe.label + "（" + probe.id + "）  passed " + counts.passed + " / failed " + counts.failed);
	for (const line of text.split(/\r?\n/)) {
		if (line.trim().startsWith("FAIL")) failures.push(probe.label + "：" + line.trim());
	}
	/* 退出码非零但自己报 0 失败：说明它中途崩了（比如断言之外的 TypeError），也是失败 */
	if (code !== 0 && counts.failed === 0) {
		failed += 1;
		failures.push(probe.label + "（" + probe.id + "）退出码 " + code + "，但自报 0 失败 —— 中途崩了");
	}
}

console.log("");
console.log("dsh-plugin-catalog / probes");
console.log("  passed: " + passed);
console.log("  failed: " + failed);
if (failures.length > 0) {
	console.log("");
	for (const failure of failures.slice(0, 20)) console.log("  ✗ " + failure);
}
if (failed > 0) process.exit(1);
