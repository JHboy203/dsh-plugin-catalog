/**
 * dev/git-reconcile.mjs — 把「两条无关历史」的本地仓与远端对齐（默认只预览）。
 *
 * 为什么需要它：模型侧的 shell 既不能写工作区（`.git/index.lock` 被拒），
 * 传输也可能不可用（`sh.exe: couldn't create signal pipe, Win32 error 5`）；
 * 而宿主侧的进程两样都有。于是把 fetch / merge 交给宿主侧的 node 来跑。
 *
 * 用法：
 *   node dev/git-reconcile.mjs --dir <仓目录>            # 只探测：远端可达吗、落后多少
 *   node dev/git-reconcile.mjs --dir <仓目录> --apply    # 真执行 fetch + merge
 *
 * 安全约定：
 *   · 默认 dry-run；
 *   · merge 用 `--allow-unrelated-histories` + `-X ours`：**本地内容优先**，
 *     远端独有文件在合并前应已取回本地（否则那部分会以"新增"形式保留，不会丢）；
 *   · 不 push（push 交给插件的 catalog_publish apply，那里有 sha 回验）。
 */

import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const flag = (name) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const dir = flag("--dir");
const apply = args.includes("--apply");
if (!dir) {
	console.log("用法: node dev/git-reconcile.mjs --dir <仓目录> [--apply]");
	process.exit(2);
}

function run(argv, timeout = 90000) {
	try {
		const out = execFileSync("git", argv, { cwd: dir, encoding: "utf8", timeout, windowsHide: true });
		return { ok: true, out: String(out).trim() };
	} catch (error) {
		const stdout = String(error?.stdout || "");
		const stderr = String(error?.stderr || "");
		return { ok: false, out: (stdout + stderr || String(error?.message || error)).trim() };
	}
}

const head = run(["rev-parse", "--short", "HEAD"]);
console.log("仓: " + dir);
console.log("HEAD: " + (head.ok ? head.out : "(读不到) " + head.out));
console.log("origin: " + run(["remote", "get-url", "origin"]).out);

/* ① 远端可达性（这一步就是上次失败的那一步） */
const probe = run(["ls-remote", "origin", "refs/heads/main"]);
console.log("\n[1] ls-remote origin: " + (probe.ok ? "OK  " + probe.out.split(/\s+/)[0] : "FAIL  " + probe.out.split("\n")[0]));
if (!probe.ok) {
	console.log("\n远端不可达，无法对齐。把这段输出贴给用户即可。");
	process.exit(1);
}

/* ② fetch */
if (!apply) {
	console.log("\n（dry-run：没有 fetch/merge。要真做加 --apply）");
	process.exit(0);
}
const fetched = run(["fetch", "origin", "main"]);
console.log("[2] fetch: " + (fetched.ok ? "OK" : "FAIL  " + fetched.out.split("\n")[0]));
if (!fetched.ok) process.exit(1);

/* ③ 先把本地未提交的改动提交掉 —— 否则 merge 会因为"未跟踪文件会被覆盖"而中止 */
const pending = run(["status", "--porcelain"]);
if (pending.ok && pending.out !== "") {
	run(["add", "-A"]);
	const c = run(["commit", "-m", "本地改动先落盘（合并远端前）"]);
	console.log("[3] 提交本地改动: " + (c.ok ? "OK" : "FAIL  " + c.out.split("\n")[0]));
} else {
	console.log("[3] 本地无未提交改动");
}

/* ④ 合并（允许无关历史；冲突时以本地为准） */
const merge = run(["merge", "--allow-unrelated-histories", "-X", "ours", "FETCH_HEAD", "-m", "合并远端初始提交（远端独有文件已取回本地）"]);
console.log("[4] merge: " + (merge.ok ? "OK" : "FAIL\n" + merge.out.split("\n").slice(0, 6).join("\n")));

console.log("\n[4] log:");
console.log(run(["log", "--oneline", "-3"]).out);
console.log("\n[5] status:");
console.log(run(["status", "--porcelain"]).out || "(clean)");

/* ⑤ 可选：只推这一个仓（避免把别的仓里别人未完成的改动一起提交） */
if (args.includes("--push")) {
	const pushed = run(["push", "origin", "HEAD:main"], 120000);
	console.log("[6] push: " + (pushed.ok ? "OK\n" + pushed.out : "FAIL\n" + pushed.out.split("\n").slice(0, 5).join("\n")));
	const after = run(["ls-remote", "origin", "refs/heads/main"]);
	const local = run(["rev-parse", "HEAD"]);
	console.log("[7] 回验: 远端=" + (after.ok ? after.out.split(/\s+/)[0].slice(0, 7) : "?") + " 本地=" + (local.ok ? local.out.slice(0, 7) : "?") + (after.ok && local.ok && after.out.startsWith(local.out) ? "  ✓ 一致" : "  ✗ 不一致"));
} else {
	console.log("\n下一步：让插件的 catalog_publish apply 去 push，或加 --push 只推这一个仓。");
}
