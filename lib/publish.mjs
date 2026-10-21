/**
 * publish.mjs — 一键上传 GitHub（**默认只出计划**）。
 *
 * 安全模型（这几条是硬规则，改代码前先读）：
 *   1. **所有仓一律私有。** 全插件只有 `createPrivateRepo` 这一处建仓，写死 `--private`；
 *      公开是**独立的一次操作**（`makePublic`），必须带 `confirm:true`，且**公开前重扫一遍**。
 *   2. **密钥命中即停**：命中 critical/high 的仓跳过、其余照常推，最后给未推清单。
 *      计划阶段就标成 `blocked-secrets`，`apply` 阶段不会碰它。
 *   3. **不 force push**：gitops 里没有 `--force` 路径。
 *   4. 命名：自写 `dsh-<name>`、混血 `dsh-<name>-local`（不覆盖原仓）。
 *   5. 每条推送前把「将提交哪些文件、扫描结果、README 英文版状态」摊开给人看，
 *      确认后才真推 —— 与 dsh-plugin-publisher 的做法一致：不"默认即发布"。
 *
 * @module dsh-plugin-catalog/publish
 */

import { cp, readdir, readFile, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import {
	commitAll,
	createPrivateRepo,
	dirtyCount,
	gh,
	ghLogin,
	hasGit,
	localHead,
	originUrl,
	remoteHead,
	repoInfo,
	resolveGh,
	setOrigin,
	slugOf,
	probeRemote,
	push,
	currentBranch,
	git,
} from "./gitops.mjs";
import { analyzeReadme, checkTbdParity, compareHeadingShape, ensureCrossLink, writeEnglish } from "./readme.mjs";
import { isBlocking, scanRepo } from "./scan.mjs";

/** 只有这两类可以上传（用户明确要求）。 */
export const PUBLISHABLE_SOURCES = ["self", "hybrid"];

/**
 * 仓库名规则。
 *   自写：`dsh-<name>`（name 本身已带 dsh- 前缀就沿用）
 *   混血：`dsh-<name>-local`（不覆盖原仓）
 */
export function repoNameFor(entry) {
	const base = String(entry.name || "")
		.replace(/^@[^/]+\//, "")
		.replace(/[^A-Za-z0-9._-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	const withPrefix = /^dsh-/.test(base) ? base : "dsh-" + base;
	if (entry.source === "hybrid") return withPrefix + "-local";
	return withPrefix;
}

/**
 * 选出可上传的条目。
 * @param {object} catalog
 * @param {object} settings
 */
export function selectCandidates(catalog, settings = {}) {
	const plugins = (catalog.plugins || []).filter((entry) => PUBLISHABLE_SOURCES.includes(entry.source));
	const skills = (catalog.skills || []).filter((entry) => entry.source === "self" && !entry.backup);
	return { plugins, skills };
}

/** 技能集合仓（自写 Skill 一起进这一个仓）。 */
export function skillsRepoName(settings = {}) {
	return settings.skillsRepo || "my-dsh-skills";
}

/**
 * 生成上传计划（**只读**：扫盘 + 查远端，不动 git 索引、不提交）。
 *
 * @param {object} options
 * @param {object} options.catalog
 * @param {object} [options.settings]
 * @param {string} [options.ghBin]
 * @param {(p:object)=>void} [options.onProgress]
 * @returns {Promise<object>}
 */
export async function planUpload(options) {
	const settings = options.settings ?? {};
	const ghBin = resolveGh(settings.ghBin);
	const login = await ghLogin(ghBin);
	const { plugins, skills } = selectCandidates(options.catalog, settings);
	const progress = typeof options.onProgress === "function" ? options.onProgress : () => {};

	const items = [];
	const total = plugins.length + (skills.length > 0 ? 1 : 0);
	let done = 0;
	const note = () => {
		done += 1;
		progress({ phase: "plan", done, total, name: "" });
	};

	/* ★ 并发 4：计划阶段每个仓都要探一次远端，24 个仓串行要 2 分钟，
	   并发后 ~15 秒。保持小并发是因为 gh/git 共用一个 SSH 连接与令牌，
	   开太大反而更容易被限速。 */
	const pluginResults = await mapLimit(plugins, 4, async (entry) => {
		const item = await planPlugin(entry, { ghBin, login, settings });
		note();
		return item;
	});
	for (const item of pluginResults) items.push(item);

	if (skills.length > 0) {
		items.push(await planSkills(skills, { ghBin, login, settings }));
		note();
	}

	const summary = {
		total: items.length,
		create: items.filter((x) => x.action === "create").length,
		update: items.filter((x) => x.action === "update").length,
		upToDate: items.filter((x) => x.action === "up-to-date").length,
		blocked: items.filter((x) => x.action === "blocked-secrets").length,
		needsAttention: items.filter((x) => x.action === "error").length,
		scanHits: items.reduce((sum, x) => sum + (x.scan?.hits?.length || 0), 0),
		readmeNeedingEnglish: items.filter((x) => x.readme?.needsEnglish).length,
	};
	return { ghost: false, ghBin, login, generatedAt: Date.now(), settings, items, summary };
}

async function planPlugin(entry, context) {
	const dir = entry.realDir;
	const repo = repoNameFor(entry);
	const base = {
		kind: "plugin",
		id: entry.id,
		name: entry.name,
		displayName: entry.name,
		source: entry.source,
		dir,
		repo,
		visibility: "private",
		action: "update",
		reasons: [],
	};

	if (!dir) return { ...base, action: "error", error: "找不到插件目录" };

	const scan = await scanRepo(dir);
	const readme = await analyzeReadme(dir);
	const head = await localHead(dir);
	const dirty = await dirtyCount(dir);
	const origin = await originUrl(dir);
	const slug = slugFromOrigin(origin);
	const targetOwned = slug.owner !== "" && context.login !== "" && slug.owner.toLowerCase() === context.login.toLowerCase();

	/* 只对「origin 已经指向本人仓」的仓去探远端；还没 origin 的一律按"要建仓"处理。
	   这一条把网络往返从 2×N 降到 ~N，且不再需要 gh api。 */
	const remote = targetOwned ? await probeRemote(dir, "main", {}) : { exists: false, sha: "", transport: "", code: 128 };

	let action = "update";
	const reasons = [];
	if (isBlocking(scan)) {
		action = "blocked-secrets";
		reasons.push(`扫描命中 ${scan.hits.length} 条（最高 ${scan.worst}）—— 本仓不推，先处理`);
	}
	if (action !== "blocked-secrets") {
		if (!targetOwned && (slug.owner === "" || !origin)) {
			action = "create";
			reasons.push(`还没有 origin，将新建私有仓 ${context.login || "<本人>"}/${repo}`);
		} else if (targetOwned && !remote.exists) {
			action = "create";
			reasons.push(`远端 ${slug.owner}/${slug.name} 不存在，将新建私有仓`);
		} else if (head !== "") {
			if (remote.sha === head) {
				action = "up-to-date";
				reasons.push("本地 HEAD 与远端 main 一致（sha 相同）");
			} else {
				reasons.push(remote.sha === "" ? "远端 main 还没有提交，将推送" : "本地与远端不一致，将推送");
			}
		} else {
			reasons.push("本地仓还没有提交，将先提交再推");
		}
	}
	/* ★ 只比 HEAD sha 会漏报：工作区里还有未提交改动时，apply 照样会「提交 → 推送」，
	   但计划显示「已同步」，看起来"没东西可推"。所以脏工作区必须把状态提到 update。 */
	if (dirty > 0 && action !== "blocked-secrets") {
		if (action === "up-to-date") action = "update";
		reasons.push("工作区有 " + dirty + " 个未提交改动，将一并提交推送");
	}
	if (readme.needsEnglish) reasons.push("需要生成/更新英文 README（" + readme.reason + "）");

	return {
		...base,
		action,
		reasons,
		scan,
		readme: { zhFile: readme.zhFile, enFile: readme.enFile, needsEnglish: readme.needsEnglish, reason: readme.reason, tbd: readme.tbd },
		localHead: head,
		origin,
		remoteExists: Boolean(remote.exists),
	};
}

async function planSkills(skills, context) {
	const stage = context.settings.skillsStageDir;
	const repo = skillsRepoName(context.settings);
	const base = {
		kind: "skills",
		id: "skills:" + repo,
		name: repo,
		displayName: repo + "（" + skills.length + " 个 Skill）",
		source: "self",
		dir: stage || "",
		repo,
		visibility: "private",
		action: "update",
		reasons: [],
		skills: skills.map((skill) => skill.name),
	};
	if (!stage) return { ...base, action: "error", error: "设置里没有配置技能集合仓的暂存目录" };

	const scan = await scanRepo(stage);
	const readme = await analyzeReadme(stage);
	const head = await localHead(stage);
	const dirty = await dirtyCount(stage);
	const origin = await originUrl(stage);
	const slug = slugFromOrigin(origin);
	const targetOwned = slug.owner !== "" && context.login !== "" && slug.owner.toLowerCase() === context.login.toLowerCase();
	const info = targetOwned && slug.name !== "" ? await repoInfo(context.ghBin, slug.owner, slug.name) : { exists: false };
	let action = "update";
	const reasons = [];
	if (isBlocking(scan)) {
		action = "blocked-secrets";
		reasons.push(`扫描命中 ${scan.hits.length} 条（最高 ${scan.worst}）—— 本仓不推`);
	} else if (!info.exists) {
		action = "create";
		reasons.push("远端还没有 " + repo + "，将新建私有仓");
	} else if (head !== "") {
		const remote = await remoteHead(stage, "main", {});
		if (remote.sha === head) {
			action = "up-to-date";
			reasons.push("本地 HEAD 与远端 main 一致");
		}
	}
	if (dirty > 0 && action !== "blocked-secrets") {
		if (action === "up-to-date") action = "update";
		reasons.push("工作区有 " + dirty + " 个未提交改动，将一并提交推送");
	}
	if (readme.needsEnglish) reasons.push("需要生成/更新英文 README");
	return {
		...base,
		action,
		reasons,
		scan,
		readme: { zhFile: readme.zhFile, enFile: readme.enFile, needsEnglish: readme.needsEnglish, reason: readme.reason, tbd: readme.tbd },
		localHead: head,
		origin,
		remoteExists: Boolean(info.exists),
	};
}

function slugFromOrigin(url) {
	if (!url) return { owner: "", name: "" };
	return slugOf(url);
}

/** 小并发 map（保持顺序）。 */
async function mapLimit(items, limit, fn) {
	const results = new Array(items.length);
	let cursor = 0;
	const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
		while (cursor < items.length) {
			const index = cursor++;
			results[index] = await fn(items[index], index);
		}
	});
	await Promise.all(workers);
	return results;
}

/**
 * 执行计划（**会写盘、会联网**）。调用方必须已经拿到用户明确同意。
 *
 * @param {object} plan planUpload() 的结果
 * @param {object} options
 * @param {(item:object, zhText:string) => Promise<{ok:boolean,en:string,model:string,error?:string}>} [options.translate]
 * @param {boolean} [options.commit] 是否提交改动（默认 true）
 * @param {(p:object)=>void} [options.onProgress]
 * @returns {Promise<object>}
 */
export async function applyUpload(plan, options = {}) {
	/* ★ 门禁放在这一层，而不是只放在工具层 / 服务层：
	   任何调用路径（面板、工具、脚本）都必须带 confirm:true 才可能真推。
	   这是"每次发布前征求明确同意"的最后一个把门人。 */
	if (options.confirm !== true) {
		return { ok: false, error: "需要 confirm:true —— 先出计划给人看，确认后才推", pushed: 0, upToDate: 0, skipped: 0, failed: 0, results: [], notPushed: [] };
	}
	const progress = typeof options.onProgress === "function" ? options.onProgress : () => {};
	const ghBin = plan.ghBin;
	const login = plan.login;
	const identity = plan.settings?.gitIdentity || {};
	const results = [];

	for (let index = 0; index < plan.items.length; index += 1) {
		const item = plan.items[index];
		progress({ phase: "apply", done: index, total: plan.items.length, name: item.name });
		const ackRepos = Array.isArray(options.ackRepos) ? options.ackRepos : [];
		if (item.action === "blocked-secrets") {
			/* ★ 只有**这一次调用显式点名**要放过它，才会继续；不记账、不默认。
			   用户的要求是"处理完再继续"，所以默认永远是跳过。 */
			if (!ackRepos.includes(item.repo)) {
				results.push({ name: item.name, repo: item.repo, status: "skipped", reason: "密钥命中，未推送（见清单）" });
				continue;
			}
			const extra = await applyOne(item, { ghBin, login, identity, translate: options.translate, commit: options.commit !== false });
			results.push({ ...extra, acknowledged: true, ackReason: "用户在本次调用里显式确认了该仓的命中（ackRepos）" });
			continue;
		}
		if (item.action === "error") {
			results.push({ name: item.name, repo: item.repo, status: "error", reason: item.error || "计划阶段就失败了" });
			continue;
		}
		try {
			results.push(await applyOne(item, { ghBin, login, identity, translate: options.translate, commit: options.commit !== false }));
		} catch (error) {
			results.push({ name: item.name, repo: item.repo, status: "error", reason: String(error?.message ?? error) });
		}
	}

	progress({ phase: "apply", done: plan.items.length, total: plan.items.length, name: "" });
	const pushed = results.filter((x) => x.status === "pushed").length;
	const upToDate = results.filter((x) => x.status === "up-to-date").length;
	const skipped = results.filter((x) => x.status === "skipped").length;
	const failed = results.filter((x) => x.status === "error").length;
	return {
		ok: failed === 0,
		pushed,
		upToDate,
		skipped,
		failed,
		results,
		notPushed: results.filter((x) => x.status === "skipped" || x.status === "error"),
	};
}

async function applyOne(item, context) {
	const dir = item.dir;
	if (!dir) return { name: item.name, repo: item.repo, status: "error", reason: "没有目录" };

	/* ① 英文 README（只有真的需要时才花模型调用） */
	let readmeNote = "";
	if (item.readme?.needsEnglish && typeof context.translate === "function") {
		try {
			const zh = await readFile(join(dir, item.readme.zhFile), "utf8");
			const translated = await context.translate(item, zh);
			if (translated?.ok && translated.en) {
				const written = await writeEnglish(dir, translated.en, item.readme.enFile);
				const parity = checkTbdParity(zh, translated.en);
				const shape = compareHeadingShape(zh, translated.en);
				await ensureCrossLink(join(dir, item.readme.zhFile), written.name, "English");
				await ensureCrossLink(written.file, item.readme.zhFile, "中文");
				/* ★ 给中文 README 补互链，会把它改得比英文版「新」；而 `needsEnglish` 的判据是
				   `mtime(en) >= mtime(zh)`。不刷新英文文件的时间戳，下次 plan 就会把明明已译好的仓
				   再要求翻一遍（实测 dsh-screenshot 就是这样自激的）。这里把英文版时间戳压到最新。 */
				try {
					const now = new Date();
					await utimes(written.file, now, now);
				} catch {
					/* 时间戳刷不动不影响内容正确性 */
				}
				readmeNote = `已生成 ${written.name}（${translated.model}）` + (parity.ok ? "" : `；⚠️ 待补充 ${parity.zhPending} 处 / 英文 TBD ${parity.enTbd} 处，不一致`) + (shape.same ? "" : "；⚠️ 章节层级与中文版不一致");
			} else {
				readmeNote = "英文版未生成：" + (translated?.error || "模型没有返回内容");
			}
		} catch (error) {
			readmeNote = "英文版未生成：" + String(error?.message ?? error);
		}
	}

	/* ② 提交（新插件还没有 .git 就现建一个：默认分支 main） */
	if (context.commit) {
		if (!hasGit(dir)) {
			const init = await git(dir, ["init", "-b", "main"]);
			if (!init.ok) {
				/* 老版本 git 不认 -b，退回两步 */
				const fallback = await git(dir, ["init"]);
				if (!fallback.ok) return { name: item.name, repo: item.repo, status: "error", reason: "初始化仓库失败：" + fallback.stderr };
				await git(dir, ["checkout", "-b", "main"]);
			}
		}
		const commit = await commitAll(dir, `更新：${item.name}`, context.identity);
		if (!commit.ok) return { name: item.name, repo: item.repo, status: "error", reason: "提交失败：" + commit.detail };
	}

	const branch = (await currentBranch(dir)) || "main";

	/* ③ 建仓 / 设 origin（**一律私有**） */
	let created = false;
	const slug = slugFromOrigin(await originUrl(dir));
	const mine = slug.owner !== "" && context.login !== "" && slug.owner.toLowerCase() === context.login.toLowerCase();
	if (!mine) {
		const create = await createPrivateRepo(context.ghBin, item.repo, `DSH 插件/Skill：${item.name}`);
		if (!create.ok && !/already exists/i.test(create.detail)) {
			return { name: item.name, repo: item.repo, status: "error", reason: "建仓失败：" + create.detail };
		}
		created = create.ok;
		const set = await setOrigin(dir, context.login, item.repo);
		if (!set.ok) return { name: item.name, repo: item.repo, status: "error", reason: "设置 origin 失败：" + set.detail };
	}

	/* ④ 推送（不带 --force） */
	const head = await localHead(dir);
	const remote = await remoteHead(dir, branch, {});
	if (head !== "" && remote.sha === head) {
		return { name: item.name, repo: item.repo, status: "up-to-date", transport: remote.transport, readmeNote, created };
	}
	const pushed = await push(dir, branch, {});
	if (!pushed.ok) {
		const detail = pushed.attempts.map((x) => `${x.transport}: ${x.detail}`).join(" | ");
		return { name: item.name, repo: item.repo, status: "error", reason: "推送失败：" + detail };
	}

	/* ⑤ 回拉校验：远端 sha 必须等于本地 sha（内容寻址，相等即字节一致） */
	const verify = await remoteHead(dir, branch, {});
	const ok = verify.sha === head && head !== "";
	return {
		name: item.name,
		repo: item.repo,
		status: ok ? "pushed" : "error",
		reason: ok ? "" : "推送后校验不一致（本地 " + head.slice(0, 8) + " / 远端 " + (verify.sha || "空").slice(0, 8) + "）",
		transport: pushed.transport,
		created,
		readmeNote,
		branch,
		sha: head,
	};
}

/**
 * 把一个 Skill 目录同步进集合仓暂存目录（只复制，不删任何东西）。
 * @param {string} skillDir
 * @param {string} stageDir
 * @param {string} name
 */
export async function syncSkillToStage(skillDir, stageDir, name) {
	const target = join(stageDir, name);
	await cp(skillDir, target, { recursive: true, force: true });
	return target;
}

/**
 * 找集合仓暂存目录里的 skill 列表（给"哪些 Skill 还没进集合仓"用）。
 * @param {string} stageDir
 */
export async function listStagedSkills(stageDir) {
	try {
		const entries = await readdir(stageDir, { withFileTypes: true });
		const out = [];
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			try {
				await stat(join(stageDir, entry.name, "SKILL.md"));
				out.push(entry.name);
			} catch {
				/* 不是 skill 目录 */
			}
		}
		return out;
	} catch {
		return [];
	}
}

/**
 * 把一个仓改为**公开** —— 独立操作，必须人明确要求。
 *
 * ★ 这个函数做了三件必须先做的事：
 *   ① 重新全量扫一遍（不信任计划阶段的结果：被 review 过之后代码可能又变了）；
 *   ② 有阻断级命中就**拒绝**（不是"提示后继续"）；
 *   ③ 把「个人免费账户私有仓无法只读分享」这条写进返回，由面板展示给用户。
 *
 * @param {object} options
 * @param {string} options.repo 仓库名（owner 由 gh 登录账号决定）
 * @param {string} options.dir 本地目录（用于重扫）
 * @param {boolean} options.confirm 必须显式 true
 * @param {string} [options.ghBin]
 * @returns {Promise<object>}
 */
export async function makePublic(options) {
	if (options.confirm !== true) {
		return { ok: false, error: "公开操作必须显式确认（confirm:true）—— 默认所有仓都是私有的" };
	}
	const ghBin = resolveGh(options.ghBin);
	const login = await ghLogin(ghBin);
	if (!login) return { ok: false, error: "gh 未登录，无法执行公开操作" };

	const rescan = await scanRepo(options.dir);
	if (rescan.hits.length > 0) {
		return {
			ok: false,
			error: `重扫命中 ${rescan.hits.length} 条，拒绝公开`,
			scan: rescan,
			note: "先把这些处理掉（改环境变量 / 移出仓库 / 清理历史），再重新发起公开。",
		};
	}
	const result = await gh(ghBin, ["repo", "edit", `${login}/${options.repo}`, "--visibility", "public", "--accept-visibility-change-consequences"]);
	if (!result.ok) return { ok: false, error: result.stderr || "gh repo edit 失败", scan: rescan };
	return {
		ok: true,
		url: "https://github.com/" + login + "/" + options.repo,
		scan: rescan,
		accountNote: "个人免费账户的私有仓**没有只读分享档位**：要么私有（仅本人/受邀协作者），要么公开（所有人可读）。需要精细权限请建 Organization 并把仓放进去。",
	};
}

/** 读出某仓最近的提交（给缺口分析/收尾报告用）。 */
export async function recentCommits(dir, count = 5) {
	const result = await git(dir, ["log", `-${count}`, "--pretty=%h %ad %s", "--date=short"]);
	return result.ok ? result.stdout.split("\n").filter(Boolean) : [];
}
