/**
 * dev/ship.mjs — 一条命令做「发版前体检」，并且能当**结构化接口**用（面板的「自检」按钮就走它）。
 *
 * 为什么要有它：这套东西的验收一直是「跑三条命令、人眼对数字、再看 git 干净不干净」。
 * 换会话接手时这一步最容易漏（漏了就等于没验）。把它固定成脚本后：
 *   - 三条自检自动跑、自动解析 passed/failed/skipped；
 *   - **第 4 项「副本同步」**：这台机器上有几个 Skill 的 staging（发布源）是旧的 —— R6 那次
 *     是"12 个 Skill 发出去的都是旧版"，靠人翻对话才发现。它**只报不拦**（与 git 脏同一条口径：
 *     改 Skill 的中途 staging 落后是常态，把它算失败会让这个脚本在最该用的时候变成噪音）；
 *   - 版本号与构建戳（package.json version ↔ client.js BUILD）不一致会直接报错 ——
 *     这是"改了代码忘了抬版本"的固定防线；
 *   - git 是否干净、HEAD 是否等于 origin/main 一并给；
 *   - 结论写成一份报告，路径给到面板/用户。
 *
 * 用法：
 *   node dev/ship.mjs                      # 人读的摘要 + 报告路径
 *   node dev/ship.mjs --json               # 只输出一段 JSON（面板 /preflight 用）
 *   node dev/ship.mjs --only audit,render  # 只跑其中几项
 *   node dev/ship.mjs --no-git             # 不查 git（沙箱里 git 可能不可用）
 *
 * ★ asar 断言的环境依赖：`app.asar` 只有 Electron 进程（或 `ELECTRON_RUN_AS_NODE=1` 的宿主 exe）
 *   才有 `process.resourcesPath`。普通 node 里 hosttest 会把那一条标成 SKIP（不算失败）。
 *   所以「面板点自检」拿到的是完整版，命令行 `node dev/ship.mjs` 少一条 —— 两者都如实写。
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { dataDir as catalogDataDir, skillRoots, workspaceRoot } from "../lib/hostinfo.js";
import { loadSettings, skillsStageDirOf } from "../lib/settings.mjs";
import { scanSkillStaging } from "../lib/staging.mjs";

const run = promisify(execFile);
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const asJson = args.includes("--json");
const noGit = args.includes("--no-git");
const onlyArg = (() => {
	const index = args.indexOf("--only");
	return index >= 0 && args[index + 1] ? args[index + 1].split(",").map((name) => name.trim()).filter(Boolean) : null;
})();
const reportArg = (() => {
	const index = args.indexOf("--report");
	return index >= 0 && args[index + 1] ? args[index + 1] : null;
})();

const CHECKS = [
	{ id: "audit", label: "自洽契约", script: "dev/audit.mjs" },
	{ id: "render", label: "界面渲染", script: "dev/render-check.cjs" },
	{ id: "hosttest", label: "宿主行为", script: "dev/hosttest.mjs" },
	/* 第 4 项在**本进程内**跑（不 spawn 子进程）：它只 stat 几十个 SKILL.md，比起一个 node 还快。
	   ★ informational：它报的是**这台机器的状态**（staging 旧了），不是代码缺陷 —— 只报不拦。 */
	{ id: "staging", label: "副本同步", inline: true, informational: true },
];

/** 子进程要用哪个解释器：宿主（Electron）下必须带 ELECTRON_RUN_AS_NODE 才能读到 app.asar。 */
function childEnv() {
	const env = { ...process.env };
	if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";
	delete env.DSH_CATALOG_KEEP; /* hosttest 自己会清理临时目录 */
	return env;
}

/** 从 "passed: 280 / failed: 0 / skipped: 1" 里取数（三条脚本格式一致）。 */
export function parseCheckOutput(text) {
	const pick = (key) => {
		const match = new RegExp("^\\s*" + key + ":\\s*(\\d+)", "m").exec(text);
		return match ? Number(match[1]) : null;
	};
	const failures = [];
	for (const line of String(text).split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.startsWith("✗ ")) failures.push(trimmed.slice(2).trim());
	}
	return { passed: pick("passed"), failed: pick("failed"), skipped: pick("skipped") ?? 0, failures };
}

/** 版本号 ↔ 构建戳：0.9.0 ↔ r9.0（改代码忘了抬版本，是最常见的"发出去了但其实没上"）。 */
export function versionVerdict(version, build) {
	const minor = String(version || "").split(".")[1];
	const expectedPrefix = "r" + minor + ".";
	const ok = Boolean(version) && Boolean(build) && String(build).startsWith(expectedPrefix);
	return { ok, version, build, expect: expectedPrefix + "N", reason: ok ? "" : "package.json version=" + version + " 与 client.js BUILD=" + build + " 对不上（应形如 " + expectedPrefix + "N）" };
}

async function gitFacts() {
	try {
		const { stdout: statusOut } = await run("git", ["status", "--porcelain"], { cwd: REPO, timeout: 20000 });
		const { stdout: headOut } = await run("git", ["rev-parse", "HEAD"], { cwd: REPO, timeout: 20000 });
		const dirty = statusOut.split(/\r?\n/).filter((line) => line.trim() !== "");
		let remote = null;
		let remoteSha = "";
		try {
			const { stdout: remoteName } = await run("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { cwd: REPO, timeout: 20000 });
			remote = remoteName.trim();
			const { stdout: remoteOut } = await run("git", ["rev-parse", remote], { cwd: REPO, timeout: 20000 });
			remoteSha = remoteOut.trim();
		} catch {
			/* 没有 upstream（本地库 / 未设 origin）不算失败 */
		}
		const head = headOut.trim();
		return { ok: true, head, headShort: head.slice(0, 7), dirty: dirty.length, dirtyFiles: dirty.slice(0, 8), remote, remoteSha: remoteSha ? remoteSha.slice(0, 7) : "", pushed: remote ? remoteSha === head : null };
	} catch (error) {
		return { ok: false, error: String(error?.message ?? error).split(/\r?\n/)[0] };
	}
}

/**
 * 第 4 项：Skill 的两份副本是否同步（`<ws>/.dsh/skills` vs staging）。
 *
 * ★ 为什么"只报不拦"：中途改 Skill 时 staging 落后是常态（可能正在写、可能还没发布）。
 *   把它算成失败会让这个脚本在最该用的时刻变成噪音 —— 与 git 脏/未推送完全同一条口径。
 *   它**仍然有价值**：R6 那次"12 个 Skill 发出去的是旧版"就是靠人翻对话才发现的，
 *   现在交接前跑一条命令就能看见。真正的失败只有一种：扫描本身抛错。
 */
async function stagingCheck() {
	const startedAt = Date.now();
	try {
		const settings = await loadSettings(catalogDataDir());
		const workspace = workspaceRoot(settings.workspace) || "";
		const stageDir = skillsStageDirOf(settings, workspace);
		const scan = await scanSkillStaging({ roots: skillRoots(settings.workspace), stageDir });
		return {
			id: "staging",
			label: "副本同步",
			ok: true,
			informational: true,
			passed: null,
			failed: 0,
			skipped: 0,
			pairs: scan.pairs,
			stale: scan.stale.map((item) => item.name),
			staleDetail: scan.stale,
			notPublished: scan.missing,
			newerStaged: scan.newerStaged,
			stageDir,
			durationMs: Date.now() - startedAt,
			failures: [],
		};
	} catch (error) {
		return {
			id: "staging",
			label: "副本同步",
			ok: false,
			informational: true,
			passed: null,
			failed: 0,
			skipped: 0,
			pairs: 0,
			stale: [],
			durationMs: Date.now() - startedAt,
			failures: ["副本同步检查自身失败：" + String(error?.message ?? error)],
		};
	}
}

async function runCheck(check) {
	const startedAt = Date.now();
	if (check.inline === true) {
		const result = await stagingCheck();
		return { ...result, durationMs: Date.now() - startedAt };
	}
	try {
		const { stdout, stderr } = await run(process.execPath, [join(REPO, check.script)], { cwd: REPO, env: childEnv(), timeout: 600000, maxBuffer: 16 * 1024 * 1024 });
		const text = String(stdout || "") + String(stderr || "");
		const parsed = parseCheckOutput(text);
		return { id: check.id, label: check.label, ok: parsed.failed === 0 && parsed.passed !== null, durationMs: Date.now() - startedAt, ...parsed, tail: text.split(/\r?\n/).filter(Boolean).slice(-3) };
	} catch (error) {
		const text = String(error?.stdout || "") + String(error?.stderr || "") + String(error?.message || "");
		const parsed = parseCheckOutput(text);
		return { id: check.id, label: check.label, ok: false, durationMs: Date.now() - startedAt, ...parsed, failures: parsed.failures.length > 0 ? parsed.failures : [String(error?.message ?? error).split(/\r?\n/)[0]], tail: text.split(/\r?\n/).filter(Boolean).slice(-5) };
	}
}

const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
const clientSource = readFileSync(join(REPO, "client.js"), "utf8");
const buildMatch = /const BUILD = "([^"]+)"/.exec(clientSource);
const version = versionVerdict(pkg.version, buildMatch ? buildMatch[1] : "");

const selected = CHECKS.filter((check) => !onlyArg || onlyArg.includes(check.id));
const results = [];
/* total 先发：面板/`runPreflight` 靠它画"第 2/4 项"，写死在两处迟早漂 */
if (asJson) process.stderr.write("ship:check:total:" + selected.length + "\n");
for (const check of selected) {
	/* 进度走 stderr：stdout 在 --json 模式下必须只有最后那一段 JSON（面板要 JSON.parse） */
	if (asJson) process.stderr.write("ship:check:start:" + check.id + "\n");
	const result = await runCheck(check);
	results.push(result);
	if (asJson) process.stderr.write("ship:check:done:" + check.id + ":" + (result.ok ? "ok" : "fail") + "\n");
	if (!asJson) {
		if (result.informational) {
			/* 只报不拦的那一项：用 ℹ 而不是 ✓，并把"几个是旧的"直接写出来 */
			const stale = Array.isArray(result.stale) ? result.stale : [];
			console.log("  " + (result.ok ? "ℹ" : "✗") + " " + result.label + "（" + check.id + "）  " + (result.ok ? result.pairs + " 对里 " + stale.length + " 个是旧的" + (stale.length ? "｜" + stale.slice(0, 6).join("、") + (stale.length > 6 ? " 等" : "") : "") : "检查自身失败") + " · " + Math.round(result.durationMs / 1000) + "s");
			if (!result.ok && result.failures?.length) for (const failure of result.failures.slice(0, 6)) console.log("      ✗ " + failure);
			continue;
		}
		console.log("  " + (result.ok ? "✓" : "✗") + " " + result.label + "（" + check.id + "）  passed " + (result.passed ?? "?") + " · failed " + (result.failed ?? "?") + (result.skipped ? " · skipped " + result.skipped : "") + " · " + Math.round(result.durationMs / 1000) + "s");
		if (!result.ok && result.failures?.length) for (const failure of result.failures.slice(0, 6)) console.log("      ✗ " + failure);
	}
}

const git = noGit ? { ok: true, skipped: true } : await gitFacts();
const dotGit = existsSync(join(REPO, ".git"));

/* 合计只数"有 passed/failed 的检查"：副本同步报的是台机器的状态（X 对里 Y 个旧），
   把 pair 数加进"585 通过"会让这个数字失去意义 —— 它必须能直接对历史值比。 */
const counted = results.filter((result) => result.informational !== true);
const totals = counted.reduce(
	(sum, result) => ({ passed: sum.passed + (result.passed || 0), failed: sum.failed + (result.failed || 0), skipped: sum.skipped + (result.skipped || 0) }),
	{ passed: 0, failed: 0, skipped: 0 },
);
const staging = results.find((result) => result.id === "staging") || null;
/* 结论只看：版本一致 + 各项自检全绿。git 脏/未推送、Skill 的 staging 旧了**只报不拦** ——
   交接前通常还有没提交的改动、也可能正在改某个 Skill，把它们算失败会让这个脚本
   在真正该用的时刻变成噪音。 */
const ok = version.ok && results.every((result) => result.ok);

/* 报告：默认写到 <plugin>/.cache/ship-<stamp>.md（.cache 不入库，但路径要给到面板/人） */
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const reportPath = reportArg || join(REPO, ".cache", "ship-" + stamp + ".md");
try {
	mkdirSync(dirname(reportPath), { recursive: true });
	const lines = [
		"# 发版体检（dev/ship.mjs）",
		"",
		"- 时间：" + new Date().toISOString(),
		"- 版本：" + version.version + " ｜ 构建戳：" + version.build + (version.ok ? " ✅ 一致" : " ❌ 不一致"),
		"- git：" + (git.skipped ? "（已跳过）" : git.ok ? "HEAD " + git.headShort + (git.dirty > 0 ? " ｜ **" + git.dirty + " 个未提交**" : " ｜ 干净") + (git.pushed === null ? " ｜ 无 upstream" : git.pushed ? " ｜ 已推送" : " ｜ **未推送**（远端 " + git.remoteSha + "）") : "不可用（" + git.error + "）"),
		"",
		"| 检查 | 通过 | 失败 | 跳过 | 耗时 |",
		"|---|---:|---:|---:|---:|",
		...results.map((result) => "| " + result.label + "（" + result.id + "） | " + (result.passed ?? "—") + " | " + (result.failed ?? "—") + " | " + (result.skipped ?? 0) + " | " + Math.round(result.durationMs / 1000) + "s |"),
		"",
		"合计：**" + totals.passed + " 通过** / " + totals.failed + " 失败 / " + totals.skipped + " 跳过",
		"",
	];
	/* 副本同步单独一段：它不是"通过/失败"，而是"这台机器上有几个 Skill 推出去会是旧版" */
	if (staging) {
		if (staging.ok) {
			lines.push("## 副本同步（Skill 的 staging）", "");
			lines.push("- 已发布对：**" + staging.pairs + "** ｜ 旧的：**" + (staging.stale || []).length + "** ｜ 一致：" + (staging.pairs - (staging.stale || []).length - (staging.newerStaged || 0)) + " ｜ 还没发布：" + (staging.notPublished || 0));
			if (staging.stageDir) lines.push("- staging 目录：`" + staging.stageDir + "`");
			for (const item of staging.staleDetail || []) lines.push("  - **" + item.name + "**：" + item.verdict + " —— `" + item.loadedDir + "` → `" + item.stagedDir + "`");
			if ((staging.stale || []).length > 0) lines.push("- 处理：面板点「同步 staging」（或工具 `catalog_skill_sync action=apply confirm=true`）—— 单向 live → staging，覆盖前备份 `.bak-<时间戳>`");
			lines.push("");
		} else {
			lines.push("## 副本同步（检查自身失败）", "");
			for (const failure of staging.failures || []) lines.push("- " + failure);
			lines.push("");
		}
	}
	for (const result of results) {
		if (result.ok) continue;
		lines.push("## " + result.label + "（" + result.id + "）失败项", "");
		for (const failure of result.failures) lines.push("- " + failure);
		lines.push("");
	}
	writeFileSync(reportPath, lines.join("\n"), "utf8");
} catch {
	/* 写不了报告不影响结论 */
}

const payload = {
	ok,
	version,
	git,
	reportPath,
	totals,
	checks: results.map(({ tail, ...rest }) => rest),
	at: Date.now(),
};

if (asJson) {
	console.log(JSON.stringify(payload));
} else {
	console.log("");
	console.log("  " + (ok ? "✓ 可以发版 / 交接" : "✗ 还有问题，别急着换会话"));
	console.log("  版本 " + version.version + " ↔ " + version.build + (version.ok ? "" : "（不一致！）"));
	if (!git.skipped && git.ok) console.log("  git " + git.headShort + (git.dirty > 0 ? " · " + git.dirty + " 个未提交" : " · 干净") + (git.pushed === null ? " · 无 upstream" : git.pushed ? " · 已推送" : " · 未推送"));
	if (!git.skipped && !git.ok) console.log("  git 不可用：" + git.error);
	console.log("  合计 " + totals.passed + " 通过 / " + totals.failed + " 失败 / " + totals.skipped + " 跳过");
	if (staging) {
		const staleNames = Array.isArray(staging.stale) ? staging.stale : [];
		console.log("  副本同步 " + (staging.ok ? staging.pairs + " 对里 " + staleNames.length + " 个 Skill 的 staging 是旧的" + (staleNames.length ? "（" + staleNames.slice(0, 4).join("、") + (staleNames.length > 4 ? " 等" : "") + "）" : "") + " · 只报不拦" : "检查自身失败"));
	}
	console.log("  报告 " + reportPath);
}

process.exit(ok ? 0 : 1);
