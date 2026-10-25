/**
 * dev/deliver.mjs — **换会话 / 交付前的最后一条命令**（R29）。
 *
 * 为什么要有它：这套东西"换会话前要做什么"一直是**五条命令 + 三条判据**，
 * 而这个知识只写在交接文件与 SKILL 里 —— 换句话说，只有读过文档的那个会话才知道。
 * 这一轮把它固定成脚本，判据只有三条：
 *   ① `dev/ship.mjs` 全绿（三层自检 + 十个探针 + 版本号↔构建戳 + git + 副本同步，**单源是它**，这里只消费它的 JSON）；
 *   ② 给了 `--base` 时，`dev/live-check.mjs` 也要全绿（**运行中的宿主是不是新代码**，只有它能回答）；
 *   ③ 没有"下一步该做什么"的悬空项（未提交 / 未推送 / staging 旧了 / 该重启）。
 *
 * ★ 它**不重复实现任何判据**：ship 与 live-check 各自跑自己的，deliver 只负责
 *   「把两条结论并起来 + 排好下一步 + 落一份给人看的交接单」。两处各写一份清单迟早差一次。
 * ★ 它**不写磁盘以外的任何东西**：不 commit、不 push、不同步 staging —— 只把命令打出来。
 *   写盘动作（提交、同步、还原）必须由人或在会话里显式发起。
 *
 * 用法：
 *   node dev/deliver.mjs                                   # 只跑 ship
 *   node dev/deliver.mjs --base http://127.0.0.1:<端口>     # ship + live-check（推荐：换会话前就这么跑）
 *   node dev/deliver.mjs --json                            # 一段 JSON，给脚本/工具消费
 *   node dev/deliver.mjs --skip-ship                       # 只跑 live-check（ship 刚跑过时省 40 秒）
 *
 * 退出码：0 = 可以换会话；1 = 还有悬空项（报告里逐条列出来）。
 * 报告：`.cache/deliver-<时间戳>.md`（与 ship 的报告同目录，两份一起归档）。
 */

import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

function argValue(name) {
	const at = args.indexOf(name);
	return at >= 0 && args[at + 1] && !args[at + 1].startsWith("--") ? args[at + 1] : "";
}

const asJson = args.includes("--json");
const skipShip = args.includes("--skip-ship");
const base = argValue("--base");

/** 跑一个 dev 脚本并吞掉非零退出（它的失败是**结论**，不是这里的异常）。 */
async function runNode(file, extra = []) {
	const startedAt = Date.now();
	try {
		const { stdout, stderr } = await run(process.execPath, [join(REPO, file), ...extra], {
			cwd: REPO,
			encoding: "utf8",
			maxBuffer: 32 * 1024 * 1024,
			timeout: 15 * 60 * 1000,
		});
		return { ok: true, code: 0, stdout, stderr, durationMs: Date.now() - startedAt };
	} catch (error) {
		const stderr = String(error?.stderr || error?.message || "");
		/* ★ 沙箱里 spawn 带管道的子进程会被拒（EPERM）。这不是"体检失败"，是"跑错了地方" ——
		   必须说清，否则人会以为是插件坏了（本机踩过太多次）。 */
		const spawnDenied = /EPERM|spawn/i.test(stderr) && /pipe|EPERM/i.test(stderr);
		return {
			ok: false,
			code: Number(error?.code) || 1,
			stdout: String(error?.stdout || ""),
			stderr,
			spawnDenied,
			durationMs: Date.now() - startedAt,
		};
	}
}

/** ship --json 只打一行 JSON；前面若干行是进度，所以从后往前找第一个能解析的 `{`。 */
function parseShipJson(text) {
	const lines = String(text || "").split(/\r?\n/).filter((line) => line.trim().startsWith("{"));
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		try {
			return JSON.parse(lines[index]);
		} catch {
			/* 继续往前找 */
		}
	}
	return null;
}

/* ── ① ship ── */
let ship = null;
if (!skipShip) {
	const result = await runNode("dev/ship.mjs", ["--json"]);
	ship = parseShipJson(result.stdout);
	if (ship === null) {
		ship = { ok: false, crashed: true, totals: { passed: 0, failed: 0, skipped: 0 }, checks: [], git: { skipped: true }, version: {} };
		console.error("ship 没有输出可解析的 JSON（它自己崩了？）");
		if (result.stderr) console.error(String(result.stderr).trim().slice(0, 800));
	}
	ship.exitCode = result.code;
	ship.durationMs = result.durationMs;
}

/* ── ② live-check（只有给了 --base 才有意义：它问的是**运行中的那个进程**） ── */
let live = null;
if (base) {
	const result = await runNode("dev/live-check.mjs", ["--base", base]);
	const text = result.stdout;
	const match = /passed (\d+) \/ failed (\d+)/.exec(text);
	const failures = text
		.split(/\r?\n/)
		.filter((line) => /^\s*FAIL\b/.test(line))
		.map((line) => line.replace(/^\s*FAIL\s*/, "").replace(/\s*\[.*$/, "").trim());
	live = {
		ok: result.ok && Boolean(match) && Number(match?.[2] || 0) === 0,
		passed: Number(match?.[1] || 0),
		failed: Number(match?.[2] || 0),
		failures,
		base,
		durationMs: result.durationMs,
		/* 跑不起来（沙箱 EPERM / 连不上 GUI）与"断言红了"是两件事，必须分开说 */
		error: result.ok || match ? "" : result.spawnDenied ? "spawn 被拒（沙箱禁止带管道子进程）—— 要在宿主里跑：host_selfcheck script=dev/deliver.mjs args=[\"--base\",\"<url>\"]" : String(result.stderr || "").trim().slice(0, 300) || "live-check 没输出可解析的计数",
	};
} else {
	live = { skipped: true, reason: "没给 --base：无法核对「运行中的宿主是不是新代码」" };
}

/* ── ③ 把"下一步"排出来（只打印，不执行） ── */
const nextSteps = [];
/* `--skip-ship` 时 ship 是"没跑"，不是"失败" —— 不能因此判红（否则这个开关就没法用来省时间） */
const shipOk = ship ? Boolean(ship.ok) : true;
if (ship && !shipOk) {
	const failed = (ship.checks || []).filter((check) => check.ok === false).map((check) => check.label || check.id);
	nextSteps.push("修好 ship 里红的项：" + (failed.length ? failed.join("、") : "（它自己崩了，看 stderr）"));
}
const git = ship?.git || { skipped: true };
if (!git.skipped && git.ok) {
	if (Number(git.dirty) > 0) nextSteps.push("提交：" + git.dirty + " 个文件未提交 → host_selfcheck script=dev/git-commit.mjs args=[\"--message-file\",\"<msg>\",\"--push\"]");
	else if (git.pushed === false) nextSteps.push("推送：HEAD " + git.headShort + " 还没推到远端");
}
const staging = (ship?.checks || []).find((check) => check.id === "staging");
if (staging && Array.isArray(staging.stale) && staging.stale.length > 0) {
	nextSteps.push("同步 Skill staging（" + staging.stale.length + " 个：" + staging.stale.slice(0, 4).join("、") + (staging.stale.length > 4 ? " 等" : "") + "）→ catalog_skill_sync action=apply confirm=true");
}
const versionMismatch = live && !live.skipped && live.failures.some((line) => /version matches disk/i.test(line));
if (versionMismatch) nextSteps.push("**重启 DSH**：宿主跑的还是旧代码（live-check 的版本 canary 红了），重启后它才 14/14");
if (live && live.skipped) nextSteps.push("补一次运行中核对：dev/deliver.mjs --base http://127.0.0.1:<GUI 端口>");
if (live && live.error) nextSteps.push("live-check 没跑成：" + live.error);

const ready = shipOk && Boolean(live) && (live.skipped || live.ok) && nextSteps.length === 0;

/* ── 报告 ── */
const pad = (n) => String(n).padStart(2, "0");
const now = new Date();
const stamp = now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + "-" + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
const reportPath = join(REPO, ".cache", "deliver-" + stamp + ".md");
const lines = [
	"# 交接/交付体检（dev/deliver.mjs）",
	"",
	"- 时间：" + now.toISOString(),
	"- 结论：" + (ready ? "**可以换会话**" : "**还有悬空项**（见下）"),
	"- 版本：" + (ship?.version?.version || "?") + " ｜ 构建戳：" + (ship?.version?.build || "?") + (ship?.version?.ok === false ? " ❌ 不一致" : ""),
	"",
	"## ship（三层自检 + 探针 + 副本同步）",
	"",
	ship
		? "- " + (ship.ok ? "✅ 全绿" : "❌ 有失败") + "：合计 " + (ship.totals?.passed ?? 0) + " 通过 / " + (ship.totals?.failed ?? 0) + " 失败 / " + (ship.totals?.skipped ?? 0) + " 跳过（" + Math.round((ship.durationMs || 0) / 1000) + "s）"
		: "- （已跳过）",
	...(ship?.checks || []).map((check) => "- " + (check.ok ? "✓" : "✗") + " " + (check.label || check.id) + "：passed " + (check.passed ?? "-") + " / failed " + (check.failed ?? 0) + (check.passed === null ? "（informational）" : "") + (check.durationMs ? " · " + Math.round(check.durationMs / 1000) + "s" : "")),
	"",
	"## 运行中 vs 磁盘（live-check）",
	"",
	live.skipped
		? "- （跳过：没给 --base）"
		: "- " + (live.ok ? "✅" : "❌") + " passed " + live.passed + " / failed " + live.failed + "（" + live.base + "）" + (live.error ? "\n  - " + live.error : "") + (live.failures.length ? "\n" + live.failures.map((line) => "  - " + line).join("\n") : ""),
	"",
	"## git",
	"",
	git.skipped ? "- （不可用：" + (git.error || "跳过") + "）" : "- HEAD " + git.headShort + (Number(git.dirty) > 0 ? " ｜ **" + git.dirty + " 个未提交**" : " ｜ 干净") + (git.pushed === null ? " ｜ 无 upstream" : git.pushed ? " ｜ 已推送" : " ｜ **未推送**（远端 " + git.remoteSha + "）"),
	"",
	"## 副本同步",
	"",
	staging
		? "- " + staging.pairs + " 对里 " + (staging.stale || []).length + " 个 Skill 的 staging 是旧的" + ((staging.stale || []).length ? "：" + staging.stale.join("、") : "") + "（只报不拦）"
		: "- （没有这一项）",
	"",
	"## 下一步",
	"",
	...(nextSteps.length ? nextSteps.map((step, index) => index + 1 + ". " + step) : ["（没有悬空项：可以换会话了）"]),
	"",
	"---",
	"",
	"> 判据单源：`dev/ship.mjs`（三层 + 探针 + 版本 + git + 副本）与 `dev/live-check.mjs`（运行中 vs 磁盘）。",
	"> 本脚本**不提交、不推送、不同步**：写盘动作一律由人显式发起。",
];
let wrote = "";
try {
	mkdirSync(dirname(reportPath), { recursive: true });
	writeFileSync(reportPath, lines.join("\n"), "utf8");
	wrote = reportPath;
} catch {
	/* 写不了报告不影响结论 */
}

if (asJson) {
	console.log(JSON.stringify({ ok: ready, at: Date.now(), ship, live, git, staging: staging || null, nextSteps, reportPath: wrote }));
} else {
	console.log("");
	console.log("  " + (ready ? "✓ 可以换会话" : "✗ 还有悬空项"));
	if (ship) console.log("  ship：" + (ship.ok ? "全绿" : "有失败") + "｜合计 " + (ship.totals?.passed ?? 0) + " 通过 / " + (ship.totals?.failed ?? 0) + " 失败 / " + (ship.totals?.skipped ?? 0) + " 跳过");
	else console.log("  ship：（已跳过，--skip-ship）");
	console.log("  版本 " + (ship?.version?.version || "?") + " ↔ " + (ship?.version?.build || "?"));
	console.log("  运行中：" + (live.skipped ? "（未核对，没给 --base）" : live.ok ? "与磁盘一致（" + live.passed + "/" + (live.passed + live.failed) + "）" : "**不一致**：" + (live.error || live.failures.slice(0, 2).join("；") || "未知")));
	if (!git.skipped && git.ok) console.log("  git " + git.headShort + (Number(git.dirty) > 0 ? " · " + git.dirty + " 个未提交" : " · 干净") + (git.pushed === null ? "" : git.pushed ? " · 已推送" : " · 未推送"));
	if (staging) console.log("  副本同步：" + (staging.stale || []).length + " 个 staging 旧了");
	if (nextSteps.length > 0) {
		console.log("");
		for (let index = 0; index < nextSteps.length; index += 1) console.log("  " + (index + 1) + ". " + nextSteps[index]);
	}
	if (wrote) console.log("\n  报告 " + wrote);
}

process.exit(ready ? 0 : 1);
