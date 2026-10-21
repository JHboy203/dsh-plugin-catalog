/**
 * dev/probe-gitops.mjs — 在**临时目录**里真跑一遍 git 发布机制（不碰任何真实仓、不联网）。
 *
 * 为什么单独有这个探针：上传流程是整条链里风险最高、也最难在沙箱里验的一段 ——
 * 它会 `git init / add / commit / remote / push`。沙箱里子进程 piped spawn 被禁（EPERM），
 * 所以只能放到宿主侧（`host_selfcheck`）跑；而真实仓不能拿来试，于是造一个临时仓。
 *
 * 覆盖：
 *   · init -b main / commitAll（有改动 → 提交；无改动 → skipped）
 *   · localHead / dirtyCount / currentBranch
 *   · originUrl 为空 / slugOf / webUrlOf
 *   · probeRemote：没有远端时必须返回 exists:false（**不抛**，网络都不该被调）
 *   · push：没有远端时必须结构化失败（不抛）
 *   · commitAll 的身份参数生效（-c user.name/email）
 */

import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	commitAll,
	currentBranch,
	dirtyCount,
	git,
	hasGit,
	localHead,
	originUrl,
	probeRemote,
	push,
	setOrigin,
	slugOf,
	webUrlOf,
} from "../lib/gitops.mjs";

const results = [];
const ok = (name, condition, detail = "") => results.push({ name, pass: Boolean(condition), detail: condition ? "" : detail });
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), "期望 " + JSON.stringify(expected) + "，实际 " + JSON.stringify(actual));

const root = join(tmpdir(), "dsh-catalog-gitops-" + Date.now());
mkdirSync(root, { recursive: true });
const repo = join(root, "demo-repo");
mkdirSync(repo, { recursive: true });

/* 清理只在最后做，而且**尽力而为**：Windows 上 git 可能还拿着 .git 里的句柄，
   rmSync 会 EPERM —— 那不该把一份已经跑完的验证变成失败（踩过一次）。 */
function cleanup() {
	for (const target of [repo, root]) {
		try {
			rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		} catch {
			/* 留着就留着，临时目录系统会清 */
		}
	}
}

try {
	/* ① 空目录：不该被当成仓 */
	ok("空目录 hasGit=false", hasGit(repo) === false);
	eq("没有 remote 时 originUrl 为空串", await originUrl(repo), "");
	const beforeRemote = await probeRemote(repo, "main", {});
	ok("没有仓时 probeRemote 不抛且 exists=false", beforeRemote && beforeRemote.exists === false, JSON.stringify(beforeRemote));

	/* ② init -b main */
	const init = await git(repo, ["init", "-b", "main"]);
	ok("git init -b main 成功（新插件没有仓时就用这条）", init.ok, init.stderr);
	ok("init 之后 hasGit=true", hasGit(repo) === true);
	eq("当前分支是 main", await currentBranch(repo), "main");
	eq("空仓 localHead 为空串", await localHead(repo), "");

	/* ③ 提交 */
	writeFileSync(join(repo, "README.md"), "# demo\n\n这是一个用于验证发布机制的临时仓。\n", "utf8");
	ok("写了文件之后 dirtyCount > 0", (await dirtyCount(repo)) > 0, String(await dirtyCount(repo)));
	const firstCommit = await commitAll(repo, "初始化：demo", { name: "Probe Bot", email: "probe@example.invalid" });
	ok("commitAll 提交成功", firstCommit.ok && firstCommit.skipped === false, JSON.stringify(firstCommit));
	eq("提交之后 dirtyCount 为 0", await dirtyCount(repo), 0);
	const head = await localHead(repo);
	ok("localHead 是 40 位 sha", /^[0-9a-f]{40}$/.test(head), head);

	/* 提交身份确实生效（不是用了全局配置） */
	const author = await git(repo, ["log", "-1", "--pretty=%an <%ae>"]);
	eq("提交身份用的是传入的 identity", author.stdout, "Probe Bot <probe@example.invalid>");

	/* ④ 无改动时 skipped（不生成空提交） */
	const secondCommit = await commitAll(repo, "再次提交（应跳过）", { name: "Probe Bot", email: "probe@example.invalid" });
	ok("无改动时 commitAll 返回 skipped", secondCommit.ok && secondCommit.skipped === true, JSON.stringify(secondCommit));
	eq("跳过之后 HEAD 没变", await localHead(repo), head);

	/* ⑤ 有 .git 但没有 remote：push 必须结构化失败，不能抛 */
	const pushed = await push(repo, "main", {});
	ok("没有远端时 push 返回 ok=false（不抛异常）", pushed.ok === false && Array.isArray(pushed.attempts), JSON.stringify(pushed).slice(0, 200));
	ok("两次传输都试过了（ssh + https 回退）", (pushed.attempts || []).length === 2, JSON.stringify(pushed.attempts));

	/* ⑥ setOrigin 写入 SSH 形式，slugOf/webUrlOf 能反解 */
	const set = await setOrigin(repo, "JHboy203", "dsh-demo");
	ok("setOrigin 成功", set.ok && set.url === "git@github.com:JHboy203/dsh-demo.git", JSON.stringify(set));
	eq("反解 slug", slugOf(await originUrl(repo)), { owner: "JHboy203", name: "dsh-demo" });
	eq("反解 web url", webUrlOf(await originUrl(repo)), "https://github.com/JHboy203/dsh-demo");
	eq("https 形式也能反解", slugOf("https://github.com/me/repo.git"), { owner: "me", name: "repo" });

	/* ⑦ 有 remote 但仓不存在：probeRemote 应返回 exists:false（网络失败也不能抛） */
	const probed = await probeRemote(repo, "main", {});
	ok("远端不存在时 probeRemote 返回 exists=false 且不抛", probed && probed.exists === false, JSON.stringify(probed));

	/* ⑧ .gitignore 生效：被忽略的文件不该进提交 */
	writeFileSync(join(repo, ".gitignore"), "dump/\n", "utf8");
	mkdirSync(join(repo, "dump"), { recursive: true });
	writeFileSync(join(repo, "dump", "big.bin"), "x", "utf8");
	await commitAll(repo, "忽略规则", { name: "Probe Bot", email: "probe@example.invalid" });
	const tracked = await git(repo, ["ls-files"]);
	ok(".gitignore 挡住的目录没被提交", !tracked.stdout.includes("dump/"), tracked.stdout);
	ok(".gitignore 本身被提交了", tracked.stdout.includes(".gitignore"), tracked.stdout);
} finally {
	/* 先留证：即使清理失败，结果也要打印出来 */
}
cleanup();

const failed = results.filter((item) => !item.pass);
console.log("");
console.log("dsh-plugin-catalog / gitops probe");
console.log("  passed: " + (results.length - failed.length));
console.log("  failed: " + failed.length);
if (failed.length > 0) {
	console.log("");
	for (const item of failed) console.log("  ✗ " + item.name + (item.detail ? " — " + item.detail : ""));
	console.log("");
	process.exit(1);
}
console.log("  all good");
