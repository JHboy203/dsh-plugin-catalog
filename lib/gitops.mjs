/**
 * gitops.mjs — git / gh 的最小封装。
 *
 * 逻辑与纪律照搬 `dsh-github-backup/lib/git.js`（本机 27 仓实测过的那份）：
 *   1. 判「本地与远端是否一致」只看 **sha 相等**（git 按内容寻址，sha 同即字节级一致）；
 *   2. 传输层 SSH 优先、HTTPS 直连兜底（本机实测 SSH 稳，github.com 直连会整段超时）；
 *   3. 任何一步失败只返回结构化错误，**不抛给宿主**（一次网络抖动不该让面板挂掉）；
 *   4. **绝不 force push**：这里没有 `--force` 这条路径，也不要加。
 *
 * ⚠️ 沙箱注意：这些函数会 spawn 子进程。宿主半边跑在 Electron 主进程里不受沙箱限制；
 *    但在 dev/audit.mjs 那种沙箱里跑 shell 时要注意「不能建管道」的边界。
 *
 * @module dsh-plugin-catalog/gitops
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

async function exec(command, args, opts = {}) {
	return run(command, args, {
		maxBuffer: 16 * 1024 * 1024,
		windowsHide: true,
		timeout: opts.timeout ?? 60000,
		cwd: opts.cwd,
		env: { ...process.env, ...(opts.env ?? {}) },
		encoding: "utf8",
	});
}

/**
 * 在某个仓里跑 git。
 * @param {string} repo 仓库目录
 * @param {string[]} args
 * @param {{sshKey?:string, transport?:'ssh'|'https-direct', timeout?:number}} [opts]
 * @returns {Promise<{ok:boolean, stdout:string, stderr:string, code:number}>}
 */
export async function git(repo, args, opts = {}) {
	const extra = [];
	if (opts.sshKey) extra.push("-c", `core.sshCommand=ssh -i ${opts.sshKey} -o IdentitiesOnly=yes`);
	if (opts.transport === "https-direct") extra.push("-c", "http.https://github.com.proxy=");
	try {
		const { stdout, stderr } = await exec("git", [...extra, ...args], { cwd: repo, timeout: opts.timeout });
		return { ok: true, stdout: (stdout ?? "").trim(), stderr: (stderr ?? "").trim(), code: 0 };
	} catch (error) {
		return {
			ok: false,
			stdout: String(error?.stdout ?? "").trim(),
			stderr: String(error?.stderr ?? error?.message ?? "git failed").trim(),
			code: typeof error?.code === "number" ? error.code : 1,
		};
	}
}

/** 调 gh（返回结构化错误，不抛）。 */
export async function gh(ghBin, args, opts = {}) {
	const bin = ghBin || "gh";
	try {
		const { stdout } = await exec(bin, args, { timeout: opts.timeout ?? 60000, cwd: opts.cwd });
		return { ok: true, stdout: (stdout ?? "").trim(), stderr: "" };
	} catch (error) {
		return { ok: false, stdout: String(error?.stdout ?? "").trim(), stderr: String(error?.stderr ?? error?.message ?? "").trim() };
	}
}

/**
 * 找 gh 可执行文件。
 * ★ 本机实测：winget 装的 gh **不在 PATH 里**，实际在 `C:\Program Files\GitHub CLI\gh.exe`。
 */
export function resolveGh(explicit) {
	if (explicit) return explicit;
	const local = process.env.LOCALAPPDATA || "";
	const candidates = [
		"C:\\Program Files\\GitHub CLI\\gh.exe",
		local ? join(local, "Programs", "GitHub CLI", "gh.exe") : "",
		"C:\\Program Files (x86)\\GitHub CLI\\gh.exe",
	].filter((path) => path !== "" && existsSync(path));
	return candidates[0] || "gh";
}

/** 目录里有没有 .git。 */
export function hasGit(dir) {
	return Boolean(dir) && existsSync(join(dir, ".git"));
}

/** origin 的 URL；没有则 ''。 */
export async function originUrl(repo) {
	const result = await git(repo, ["remote", "get-url", "origin"]);
	return result.ok ? result.stdout : "";
}

/**
 * 当前分支名。
 *
 * ★ 刚 `git init -b main` 还没有第一次提交时，`rev-parse --abbrev-ref HEAD` 会说
 *   "HEAD"（unborn branch）。所以退化到 `symbolic-ref --short HEAD` —— 它在空仓上
 *   也能正确回答 main/master。否则新建仓的第一推会走到错误的默认分支上。
 */
export async function currentBranch(repo) {
	const result = await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
	if (result.ok && result.stdout !== "" && result.stdout !== "HEAD") return result.stdout;
	const symbolic = await git(repo, ["symbolic-ref", "--short", "HEAD"]);
	if (symbolic.ok && symbolic.stdout !== "") return symbolic.stdout;
	return "";
}

/** 本地 HEAD sha（空仓 ''）。 */
export async function localHead(repo) {
	const result = await git(repo, ["rev-parse", "HEAD"]);
	return result.ok ? result.stdout : "";
}

/** 工作区脏文件数（含未跟踪）；读失败 -1。 */
export async function dirtyCount(repo) {
	const result = await git(repo, ["status", "--porcelain"]);
	if (!result.ok) return -1;
	return result.stdout === "" ? 0 : result.stdout.split("\n").filter((line) => line.trim() !== "").length;
}

/**
 * 「相对上游有没有本地改动」——混血判定的核心证据。
 *
 * 只读本地已有信息（**不 fetch**）：上游 ref 是上次 fetch 时的快照，
 * 所以答案的口径是「截至上次 fetch 的差异」，够用来判「我改过」。
 *
 * @returns {Promise<{known:boolean, ahead:number, behind:number, upstream:string, dirty:number}>}
 */
export async function divergenceVsUpstream(repo) {
	const upstream = await git(repo, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
	const dirty = await dirtyCount(repo);
	if (!upstream.ok || upstream.stdout === "") return { known: false, ahead: 0, behind: 0, upstream: "", dirty };
	const counts = await git(repo, ["rev-list", "--left-right", "--count", `@{u}...HEAD`]);
	if (!counts.ok) return { known: false, ahead: 0, behind: 0, upstream: upstream.stdout, dirty };
	const [behind, ahead] = counts.stdout.split(/\s+/).map((n) => Number(n) || 0);
	return { known: true, ahead: ahead || 0, behind: behind || 0, upstream: upstream.stdout, dirty };
}

/** 远端某分支的 sha；两种传输都失败返回 ''。 */
export async function remoteHead(repo, branch = "main", opts = {}) {
	for (const transport of ["ssh", "https-direct"]) {
		const result = await git(repo, ["ls-remote", "origin", `refs/heads/${branch}`], { ...opts, transport, timeout: 60000 });
		if (result.ok && result.stdout !== "") return { sha: result.stdout.split(/\s+/)[0], transport };
	}
	return { sha: "", transport: "" };
}

/**
 * 一次探完「远端在不在 + main 的 sha」。
 *
 * 比 `remoteHead` + `gh repo view` 省一半往返：`ls-remote --exit-code` 的退出码
 * 能区分三件事 —— 0 = 有 refs、2 = 仓在但没有该 ref、128 = 仓不存在或没权限。
 * 计划阶段只要这三态，不需要问 gh（那还得再走一次 HTTPS API + 令牌）。
 *
 * @returns {Promise<{exists:boolean, sha:string, transport:string, code:number}>}
 */
export async function probeRemote(repo, branch = "main", opts = {}) {
	let lastCode = 128;
	for (const transport of ["ssh", "https-direct"]) {
		const result = await git(repo, ["ls-remote", "--exit-code", "origin", `refs/heads/${branch}`], { ...opts, transport, timeout: 45000 });
		lastCode = result.code;
		if (result.ok && result.stdout !== "") return { exists: true, sha: result.stdout.split(/\s+/)[0], transport, code: 0 };
		if (result.code === 2) return { exists: true, sha: "", transport, code: 2 };
		/* 其它非零（含认证失败）换传输再试；两次都不行就按"不存在"处理，
		   由后续 gh repo create 再确认一次（create 对已存在的仓会报 already exists，不算失败）。 */
	}
	return { exists: false, sha: "", transport: "", code: lastCode };
}

/** 把全部改动提交（无改动返回 skipped）。 */
export async function commitAll(repo, message, identity = {}) {
	const add = await git(repo, ["add", "-A"]);
	if (!add.ok) return { ok: false, step: "add", detail: add.stderr };
	const staged = await git(repo, ["diff", "--cached", "--name-only"]);
	if (staged.ok && staged.stdout === "") return { ok: true, step: "commit", skipped: true, detail: "无改动" };
	const args = [];
	if (identity.name) args.push("-c", `user.name=${identity.name}`);
	if (identity.email) args.push("-c", `user.email=${identity.email}`);
	args.push("commit", "-m", message, "--no-gpg-sign");
	const commit = await git(repo, args);
	if (!commit.ok) return { ok: false, step: "commit", detail: commit.stderr };
	return { ok: true, step: "commit", skipped: false, detail: commit.stdout.split("\n")[0] ?? "" };
}

/** 设定 origin（SSH 形式）。 */
export async function setOrigin(repo, owner, name) {
	const url = `git@github.com:${owner}/${name}.git`;
	const exists = await git(repo, ["remote", "get-url", "origin"]);
	if (exists.ok) {
		const set = await git(repo, ["remote", "set-url", "origin", url]);
		return { ok: set.ok, url, detail: set.stderr };
	}
	const add = await git(repo, ["remote", "add", "origin", url]);
	return { ok: add.ok, url, detail: add.stderr };
}

/** 推送当前分支到 origin（**不带 --force**），两种传输回退。 */
export async function push(repo, branch = "main", opts = {}) {
	const attempts = [];
	for (const transport of ["ssh", "https-direct"]) {
		const result = await git(repo, ["push", "-u", "origin", branch], { ...opts, transport, timeout: 300000 });
		attempts.push({ transport, ok: result.ok, detail: (result.stderr || result.stdout).split("\n").slice(-1)[0] ?? "" });
		if (result.ok) return { ok: true, transport, attempts };
	}
	return { ok: false, transport: "", attempts };
}

/**
 * 从 remote URL 猜测仓库 slug（owner/name）。
 * 认得的写法（都是本机真实出现过的）：
 *   `git@github.com:o/n.git`、`https://github.com/o/n(.git)`、
 *   **`git+https://github.com/o/n.git`**（package.json 的 repository.url 标准写法；
 *   R40 真机第一跑就栽在这里：没剥 `git+` 前缀 → 整仓被判「不是 GitHub 仓」，星标一栏永远是空的）。
 */
export function slugOf(url) {
	const text = String(url || "")
		.trim()
		.replace(/^git\+/, "")
		.replace(/\/+$/, "");
	let match = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/.exec(text);
	if (match) return { owner: match[1], name: match[2] };
	match = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/(.+?)(?:\.git)?$/.exec(text);
	if (match) return { owner: match[1], name: match[2] };
	return { owner: "", name: "" };
}

/** github.com/<owner>/<name> 的可点链接；猜不出来返回 ''。 */
export function webUrlOf(url) {
	const { owner, name } = slugOf(url);
	return owner && name ? `https://github.com/${owner}/${name}` : "";
}

let cachedLogin = null;

/** 当前 gh 登录账号（缓存；失败返回 ''）。 */
export async function ghLogin(ghBin, force = false) {
	if (cachedLogin && !force) return cachedLogin;
	const result = await gh(ghBin, ["api", "user", "--jq", ".login"]);
	if (result.ok && result.stdout !== "" && result.stdout !== "null") {
		cachedLogin = result.stdout;
		return cachedLogin;
	}
	return "";
}

/** 远端仓库是否存在（已登录前提下）。 */
export async function repoExists(ghBin, owner, name) {
	const result = await gh(ghBin, ["repo", "view", `${owner}/${name}`, "--json", "name"]);
	return result.ok;
}

/** 仓的可见性与地址。 */
export async function repoInfo(ghBin, owner, name) {
	const result = await gh(ghBin, ["repo", "view", `${owner}/${name}`, "--json", "name,visibility,url,defaultBranchRef,isPrivate"]);
	if (!result.ok) return { exists: false };
	try {
		const data = JSON.parse(result.stdout);
		return { exists: true, ...data };
	} catch {
		return { exists: false };
	}
}

/** 建**私有**仓。这是全插件唯一建仓的地方，且写死 --private。 */
export async function createPrivateRepo(ghBin, name, description) {
	const args = ["repo", "create", name, "--private", "--disable-wiki"];
	if (description) args.push("--description", String(description).slice(0, 200));
	const result = await gh(ghBin, args);
	return { ok: result.ok, detail: result.ok ? result.stdout : result.stderr };
}

/* ── R40：仓库的「创作者视角」数据（Star / Fork / Watch / 克隆 / 浏览 / 下载） ──
 *
 * 为什么不在 /state 里带：这些数字要联网、要走 GitHub API 的速率限制，而面板 20 秒轮询一次。
 * 所以按条目懒算（打开详情页才问一次）+ 进程内 10 分钟缓存。
 *
 * 三条口径（别混）：
 *   · stars / forks / watchers / openIssues —— 仓库元数据，`GET /repos/o/n` 直接给；
 *   · clones / views —— **流量接口**（14 天窗口），只有推送权限的人能读；别人（或未登录）会 403，
 *     这种情况如实报 `trafficDenied`，而不是写 0（0 会被读成"没人克隆"）；
 *   · downloads —— GitHub 没有"仓库下载数"，只有 **Release 资产的下载数**；没有 Release 时说清楚。
 */

const REPO_JQ = "{name,private,archived,stargazers_count,forks_count,subscribers_count,watchers_count,open_issues_count,size,pushed_at,created_at,license:.license.spdx_id,topics,description,default_branch,html_url,has_issues}";

/** 不带 gh 时用公开 API 兜底（未登录 / 不是自己的仓也能读到星数）。 */
async function publicApi(path) {
	try {
		const response = await fetch("https://api.github.com" + path, {
			headers: { accept: "application/vnd.github+json", "user-agent": "dsh-plugin-catalog" },
			signal: AbortSignal.timeout(8000),
		});
		if (!response.ok) return { ok: false, status: response.status };
		return { ok: true, json: await response.json() };
	} catch (error) {
		return { ok: false, status: 0, error: String((error && error.message) || error) };
	}
}

/**
 * 读一个 GitHub 仓的创作者数据。
 * @returns {Promise<{ok:boolean, owner?:string, name?:string, url?:string, stats?:object, error?:string}>}
 */
export async function repoStats(ghBin, owner, name) {
	if (!owner || !name) return { ok: false, error: "no-slug" };
	const base = `repos/${owner}/${name}`;
	const out = { ok: true, owner, name, url: `https://github.com/${owner}/${name}` };

	/* ① 元数据：先 gh（带登录、能吃私有仓），失败再走公开 API（别人的仓 / 没装 gh 也能看星数） */
	let meta = null;
	let source = "gh";
	const viaGh = await gh(ghBin, ["api", base, "--jq", REPO_JQ]);
	if (viaGh.ok && viaGh.stdout) {
		try {
			meta = JSON.parse(viaGh.stdout);
		} catch {
			meta = null;
		}
	}
	if (!meta) {
		source = "public";
		const pub = await publicApi("/" + base);
		if (pub.ok) meta = pub.json;
	}
	if (!meta) return { ok: false, error: "repo-unreachable", owner, name, url: out.url };

	/* ★ 两条来源的**形状不同**：gh 那条被 jq 收过（license 已经是 SPDX 字符串），
	   公开 API 那条是 GitHub 原文（license 是个对象）。不归一化的话，界面会把
	   整个 license 对象当字符串插进 DOM（[object Object]），而且「许可」一栏永远是空的。 */
	const license = typeof meta.license === "string" ? meta.license : meta.license && typeof meta.license === "object" ? meta.license.spdx_id || meta.license.key || "" : "";

	out.source = source;
	out.stats = {
		private: Boolean(meta.private),
		archived: Boolean(meta.archived),
		stars: Number(meta.stargazers_count) || 0,
		forks: Number(meta.forks_count) || 0,
		/* watchers_count 在 GitHub API 里其实是 star 数的别名；真·关注者是 subscribers_count */
		watchers: Number(meta.subscribers_count) || 0,
		watchersAlias: Number(meta.watchers_count) || 0,
		openIssues: Number(meta.open_issues_count) || 0,
		sizeKb: Number(meta.size) || 0,
		pushedAt: meta.pushed_at || "",
		createdAt: meta.created_at || "",
		license,
		topics: Array.isArray(meta.topics) ? meta.topics : [],
		description: meta.description || "",
		defaultBranch: meta.default_branch || "main",
		hasIssues: meta.has_issues !== false,
	};

	/* ② Release 下载数：仓库没有 Release 是常态（本机大部分插件仓都没有），要如实说 */
	let releaseList = [];
	const releases = await gh(ghBin, ["api", `${base}/releases?per_page=30`, "--jq", "[.[]|{tag:.tag_name,publishedAt:.published_at,downloads:([.assets[].download_count]|add // 0)}]"]);
	if (releases.ok && releases.stdout) {
		try {
			releaseList = JSON.parse(releases.stdout);
		} catch {
			releaseList = [];
		}
	} else {
		/* gh 用不了（不是自己的仓 / 没登录 / 被沙箱挡住）：公开 API 一样能读到 Release 资产 */
		const pubReleases = await publicApi(`/${base}/releases?per_page=30`);
		if (pubReleases.ok && Array.isArray(pubReleases.json)) {
			releaseList = pubReleases.json.map((item) => ({
				tag: item.tag_name,
				publishedAt: item.published_at,
				downloads: (item.assets || []).reduce((sum, asset) => sum + (Number(asset.download_count) || 0), 0),
			}));
		}
	}
	out.stats.releases = Array.isArray(releaseList) ? releaseList.length : 0;
	out.stats.downloads = (Array.isArray(releaseList) ? releaseList : []).reduce((sum, item) => sum + (Number(item.downloads) || 0), 0);
	out.stats.latestRelease = Array.isArray(releaseList) && releaseList.length > 0 ? releaseList[0] : null;

	/* ③ 流量（14 天）：只有推送权限能读，**没有公开替代**。
	   403 / 失败 = 没权限（不是 0），要分开报 —— 界面据此写「没权限」而不是画 0。 */
	const clones = await gh(ghBin, ["api", `${base}/traffic/clones`, "--jq", "{count,uniques}"]);
	const views = await gh(ghBin, ["api", `${base}/traffic/views`, "--jq", "{count,uniques}"]);
	try {
		out.stats.clones = clones.ok && clones.stdout ? JSON.parse(clones.stdout) : null;
	} catch {
		out.stats.clones = null;
	}
	try {
		out.stats.views = views.ok && views.stdout ? JSON.parse(views.stdout) : null;
	} catch {
		out.stats.views = null;
	}
	out.stats.trafficDenied = !clones.ok && !views.ok;
	out.stats.trafficError = clones.ok ? "" : String(clones.stderr || "").split("\n")[0].slice(0, 160);

	/* ④ 贡献者数（一页 100 个，超过 100 只报「100+」） */
	let contributorCount = null;
	const contributors = await gh(ghBin, ["api", `${base}/contributors?per_page=100&anon=1`, "--jq", "length"]);
	if (contributors.ok) contributorCount = Number(contributors.stdout) || 0;
	else {
		const pubContributors = await publicApi(`/${base}/contributors?per_page=100&anon=1`);
		if (pubContributors.ok && Array.isArray(pubContributors.json)) contributorCount = pubContributors.json.length;
	}
	out.stats.contributors = contributorCount;
	out.stats.contributorsCapped = contributorCount !== null && contributorCount >= 100;

	return out;
}
