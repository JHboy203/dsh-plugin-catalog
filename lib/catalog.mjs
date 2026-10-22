/**
 * catalog.mjs — 枚举「本机有哪些插件与 Skill」，并判断**来源四分类**。
 *
 * 四分类的判据（每条都是文件系统事实，不是人设）：
 *
 *   官方   profile/node_modules 下 `@deepseek-ai/*` 的包。
 *   自写   ① profile 里那个条目是 **junction / symlink**，且真实路径在工作区
 *            （实测 22 个，`realpath` 直接穿到 `DSH-Plugin\<pkg>`）；
 *          ② 或 package.json 的 author 命中本人的 GitHub 账号；
 *          ③ 或它就在工作区 `DSH-Plugin\<pkg>` / `.gh-upload\<name>` 下。
 *   第三方 其余。
 *   混血   在上面任一基础上，再满足：**有 .git + origin 指向非本人仓 + 能比出差异**
 *          （工作区脏，或本地领先上游 commit）。比不出来（没有上游 ref）→ `pending`，
 *          进「待你标一次」队列，标完存盘不再问。
 *
 * ⚠️ 诚实的边界：**npm 装进来后被就地改过的包，本工具无法自动判定** ——
 *    没有基线可比（node_modules 里没有 .git，也没有发布包的哈希）。
 *    这类只能手工标。README 与面板上都要写清楚，不能假装能判。
 *
 * @module dsh-plugin-catalog/catalog
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
	ASAR_PKG_ROOT,
	asarMode,
	asarPath,
	listScopedPackages,
	readPackageJson,
	readPackageText,
} from "./asar.mjs";
import { currentBranch, divergenceVsUpstream, hasGit, originUrl, slugOf, webUrlOf } from "./gitops.mjs";
import {
	dataDir as defaultDataDir,
	profileBundles,
	profileDependencies,
	profileDir,
	profileNodeModules,
	realPathOf,
	skillRoots,
	workspaceRoot,
} from "./hostinfo.js";
import { readJson, writeJson } from "./store.mjs";

/**
 * 快照格式版本。
 * ★ v3：asar 读取改成「virtual 模式走成员路径」—— v2 的缓存里官方插件数是 0（错的），
 *   抬高版本号让旧缓存自动作废，别让用户第一次打开看到"官方 0 个"。
 */
/* ★ 条目形状变了就 +1：缓存的快照不会自动失效，旧快照里没有 `dir` 字段会让漂移检查拼错路径（R6 踩过）。 */
export const CATALOG_VERSION = 5;

/** 内置来源标记。 */
export const SOURCE_LABELS = {
	official: "官方",
	self: "自写",
	third: "第三方",
	hybrid: "混血",
	pending: "待标记",
};

/** 默认认为「本人」的 GitHub 账号（可在设置里改）。 */
export const DEFAULT_SELF_OWNERS = ["JHboy203"];

/** 自写 Skill 集合仓的暂存目录（这是「自写 Skill」最硬的证据）。 */
const SELF_SKILL_STAGE = [".gh-upload", "my-dsh-skills"];

export function catalogFile(dir) {
	return join(dir, "cache", "catalog.json");
}

/**
 * **只读缓存**，不建快照。
 *
 * ★ 为什么必须单独有这个函数：宿主启动时会执行插件的 `apply()`，
 *   如果那里调用 `buildCatalog()` 而缓存又过期了，就要现场跑 71 个包的
 *   `realpath + stat + git`（实测 **15 秒**）—— 那等于**把 DSH 的启动拖慢 15 秒**。
 *   正确做法：启动时只读缓存（哪怕过期），随后用后台任务刷新。
 *
 * @param {string} dir 数据目录
 * @returns {Promise<{snapshot: object|null, ageMs: number, version: number}>}
 */
export async function readCatalogCache(dir) {
	const raw = await readJson(catalogFile(dir), null);
	if (!raw || !Array.isArray(raw.plugins)) return { snapshot: null, ageMs: Infinity, version: 0 };
	return {
		snapshot: raw,
		ageMs: Date.now() - Number(raw.builtAt || 0),
		version: Number(raw.version) || 0,
	};
}

/* ─────────────────────────── 插件枚举 ─────────────────────────── */

/**
 * 列出 profile 里的候选插件包。
 *
 * ★ 关键细节：`readdir(withFileTypes)` 对 **junction/symlink** 的 `isDirectory()` 是
 *   **false**。踩过一次：按它过滤会把全部自写插件（22 个）静默漏掉，
 *   然后得出"本机只有第三方插件"这种荒唐结论。所以一律用 stat 跟随链接。
 */
export async function listPluginPackages(settings = {}) {
	const nm = profileNodeModules();
	if (!nm) return { packages: [], errors: [{ error: "profile node_modules not found" }] };
	const bundles = new Set(await profileBundles());
	const deps = await profileDependencies();
	const selfOwners = normalizeOwners(settings.selfOwners);
	const packages = [];
	const errors = [];

	const consider = async (pkgName, dir) => {
		let info;
		try {
			info = await stat(dir);
		} catch {
			return;
		}
		if (!info.isDirectory()) return;

		let pj = null;
		try {
			pj = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
		} catch {
			pj = null;
		}
		const looksLikeDshPlugin = Boolean(pj && (pj.dsh || /(^|@)dsh[-/]/.test(pkgName) || /^dsh-/.test(pkgName)));
		if (!looksLikeDshPlugin) return;

		const realDir = await realPathOf(dir);
		const isLink = realDir.toLowerCase() !== dir.toLowerCase();
		const workspace = workspaceRoot(settings.workspace);
		/* ★ 判「在工作区里」必须排除 `.dsh`（运行时目录）：
		   profile 的 node_modules 就在 `<ws>/.dsh/profiles/...` 下，
		   不排除的话**每一个插件都会被判成"自写"**（实测 63/63 全中，荒唐）。 */
		const dshRoot = workspace ? join(workspace, ".dsh").toLowerCase() : "";
		const inWorkspace =
			Boolean(workspace) &&
			realDir.toLowerCase().startsWith(workspace.toLowerCase()) &&
			(dshRoot === "" || !realDir.toLowerCase().startsWith(dshRoot));

		const author = typeof pj?.author === "string" ? pj.author : pj?.author?.name || pj?.author?.url || "";
		const authorMine = selfOwners.some((owner) => author.toLowerCase().includes(owner.toLowerCase()));
		const repoField = typeof pj?.repository === "string" ? pj.repository : pj?.repository?.url || "";

		packages.push({
			pkg: pkgName,
			dir,
			realDir,
			isLink,
			inWorkspace,
			version: typeof pj?.version === "string" ? pj.version : "",
			description: typeof pj?.description === "string" ? pj.description : "",
			author,
			authorMine,
			repositoryField: repoField,
			homepage: typeof pj?.homepage === "string" ? pj.homepage : "",
			license: typeof pj?.license === "string" ? pj.license : "",
			enabled: bundles.has(pkgName),
			dependency: Object.prototype.hasOwnProperty.call(deps, pkgName),
			officialScope: pkgName.startsWith("@deepseek-ai/"),
			createdAt: await birthTimeOf(join(dir, "package.json"), dir),
			keywords: Array.isArray(pj?.keywords) ? pj.keywords.slice(0, 12).map(String) : [],
		});
	};

	let top = [];
	try {
		top = await readdir(nm);
	} catch (error) {
		return { packages, errors: [{ error: "readdir failed: " + String(error?.message ?? error) }] };
	}

	for (const entry of top) {
		if (entry.startsWith("@")) {
			let scoped = [];
			try {
				scoped = await readdir(join(nm, entry));
			} catch {
				continue;
			}
			for (const name of scoped) await consider(entry + "/" + name, join(nm, entry, name));
		} else if (!entry.startsWith(".")) {
			await consider(entry, join(nm, entry));
		}
	}

	packages.sort((a, b) => a.pkg.localeCompare(b.pkg));
	return { packages, errors };
}

function normalizeOwners(list) {
	const owners = Array.isArray(list) && list.length > 0 ? list : DEFAULT_SELF_OWNERS;
	return owners.map((x) => String(x).trim()).filter((x) => x !== "");
}

/** 文件（或目录）的创建时间；取不到返回首选项的 mtime。 */
async function birthTimeOf(file, fallbackDir) {
	for (const target of [file, fallbackDir]) {
		if (!target) continue;
		try {
			const info = await stat(target);
			if (Number.isFinite(info.birthtimeMs) && info.birthtimeMs > 0) return info.birthtimeMs;
			if (Number.isFinite(info.mtimeMs) && info.mtimeMs > 0) return info.mtimeMs;
		} catch {
			/* 下一个 */
		}
	}
	return 0;
}

/* ─────────────────────────── 混血判定 ─────────────────────────── */

/**
 * 读一个包的 git 事实（只在真有 .git 时才 spawn）。
 * @returns {Promise<object>}
 */
export async function gitFacts(dir, selfOwners) {
	if (!hasGit(dir)) return { hasGit: false };
	const remote = await originUrl(dir);
	const { owner } = slugOf(remote);
	const branch = await currentBranch(dir);
	const divergence = await divergenceVsUpstream(dir);
	const ownerMine = owner !== "" && selfOwners.some((x) => x.toLowerCase() === owner.toLowerCase());
	return {
		hasGit: true,
		remote,
		remoteOwner: owner,
		remoteWeb: webUrlOf(remote),
		branch,
		ownerMine,
		dirty: divergence.dirty,
		ahead: divergence.ahead,
		behind: divergence.behind,
		divergenceKnown: divergence.known,
		upstream: divergence.upstream,
	};
}

/**
 * 判来源。返回 {source, why[], askUser}。
 *
 * @param {object} pkg listPluginPackages() 的一项
 * @param {object|null} git gitFacts() 的结果
 * @param {string[]} selfOwners
 */
export async function classifyPlugin(pkg, git, selfOwners) {
	const why = [];
	let base;
	if (pkg.officialScope) {
		base = "official";
		why.push("装在 node_modules/@deepseek-ai/ 下");
	} else if (pkg.isLink && (pkg.inWorkspace || /DSH-Plugin/i.test(pkg.realDir))) {
		base = "self";
		why.push("link/junction 安装，源目录就是工作区里的本地目录");
	} else if (pkg.authorMine) {
		base = "self";
		why.push("package.json 的 author 命中本人账号");
	} else if (pkg.inWorkspace) {
		base = "self";
		why.push("真实路径在工作区内");
	} else {
		base = "third";
		why.push(pkg.officialScope ? "官方作用域" : "从 npm/其它来源安装");
	}

	/* 混血覆盖：有 git + origin 非本人 + 能比出差异 */
	if (git?.hasGit && git.remoteOwner !== "" && !git.ownerMine) {
		const diverged = (git.dirty ?? 0) > 0 || (git.ahead ?? 0) > 0;
		if (git.divergenceKnown && diverged) {
			const bits = [];
			if (git.dirty > 0) bits.push(git.dirty + " 个文件有未提交改动");
			if (git.ahead > 0) bits.push("本地领先 " + git.upstream + " " + git.ahead + " 个提交");
			return {
				source: "hybrid",
				why: [...why, "git origin 指向 " + git.remoteOwner + "/（非本人），且" + bits.join("、")],
				askUser: false,
			};
		}
		if (!git.divergenceKnown) {
			return {
				source: "pending",
				why: [...why, "git origin 指向 " + git.remoteOwner + "/（非本人），但没有上游 ref，比不出差异"],
				askUser: true,
			};
		}
		return { source: base, why: [...why, "git origin 指向 " + git.remoteOwner + "/（非本人），但相对上游没有差异"], askUser: false };
	}

	/* 没有 git 的 npm 包：如果工作区里另有一个同名目录，可能是"拷进来改过" */
	if (!git?.hasGit && !pkg.officialScope && !pkg.isLink && pkg.inWorkspace === false) {
		const ws = workspaceRoot();
		if (ws) {
			const sibling = join(ws, "DSH-Plugin", pkg.pkg.replace(/^.*\//, ""));
			try {
				const info = await stat(sibling);
				if (info.isDirectory()) {
					return { source: "pending", why: [...why, "工作区 DSH-Plugin/ 下有同名目录，可能是本地改过的副本，需你确认"], askUser: true };
				}
			} catch {
				/* 没有就是没有 */
			}
		}
	}

	return { source: base, why, askUser: false };
}

/* ───────────────────── 官方插件（在 asar 里，不在 profile） ───────────────────── */

/**
 * 枚举「bundles 里声明了、但 profile/node_modules 里没有」的条目。
 *
 * 本机实况：`dsh.profile.bundles` 里有 7 个 `@deepseek-ai/*`（含 5 个 experimental-*），
 * 它们的代码在 `resources/app.asar/dsh/node_modules/` 内部。不读 asar 的话，
 * 面板会把「官方」这一类显示成 0 个 —— 而这正是用户要的四分类之一。
 *
 * @returns {Promise<{plugins: Array<object>, missing: Array<string>, asar: object}>}
 */
export async function listOfficialPlugins(settings = {}) {
	const archive = asarPath();
	const mode = asarMode(archive);
	const bundles = await profileBundles();
	const nm = profileNodeModules();
	const present = new Set();
	if (nm) {
		try {
			for (const entry of await readdir(nm)) {
				if (entry.startsWith("@")) {
					for (const sub of await readdir(join(nm, entry))) present.add(entry + "/" + sub);
				} else present.add(entry);
				}
		} catch {
			/* 读不到就当没有 */
		}
	}

	let asarMtime = 0;
	if (archive) {
		try {
			asarMtime = (await stat(archive)).mtimeMs;
		} catch {
			asarMtime = 0;
		}
	}

	const plugins = [];
	const missing = [];
	for (const name of bundles) {
		if (present.has(name)) continue;
		const pj = readPackageJson(archive, name);
		if (!pj) {
			missing.push(name);
			continue;
		}
		plugins.push({
			id: "plugin:" + name,
			kind: "plugin",
			name,
			title: name,
			version: typeof pj.version === "string" ? pj.version : "",
			description: typeof pj.description === "string" ? pj.description : "",
			author: typeof pj.author === "string" ? pj.author : pj?.author?.name || "",
			license: typeof pj.license === "string" ? pj.license : "",
			keywords: Array.isArray(pj.keywords) ? pj.keywords.slice(0, 12).map(String) : [],
			enabled: true,
			dependency: false,
			dir: archive ? archive + ASAR_PKG_ROOT + "/" + name : "",
			realDir: archive ? archive + ASAR_PKG_ROOT + "/" + name : "",
			isLink: false,
			inAsar: true,
			createdAt: asarMtime,
			repoUrl: typeof pj.repository === "string" ? pj.repository : pj?.repository?.url || pj?.homepage || "",
			repositoryField: typeof pj.repository === "string" ? pj.repository : pj?.repository?.url || "",
			git: { hasGit: false, remote: "", remoteOwner: "", dirty: 0, ahead: 0, behind: 0, known: false, branch: "" },
			source: "official",
			sourceWhy: ["bundles 里启用，代码在宿主 app.asar 内（profile 里没有这份包）"],
			askUser: false,
		});
	}
	return { plugins, missing, asar: { path: archive, mode, readable: mode !== "none" } };
}

/**
 * 读 asar 里全部官方工具包的源码文本（供归属判定用）。
 *
 * 77 个 `dsh-tool-*` 包，每个只读它自己的 .js（有上界）。
 * 不读它们的话，65% 的调用量（pwsh / read / edit / write …）会全部落在「未知来源」。
 *
 * @returns {Promise<Array<{pkg:string, text:string}>>}
 */
export async function readOfficialToolPackages() {
	const archive = asarPath();
	if (!archive || asarMode(archive) === "none") return [];
	const out = [];
	for (const name of listScopedPackages(archive)) {
		/* 只挑「工具包」与「experimental bundle」：其余是 UI/服务包，不会有工具定义 */
		if (!/^dsh-(tool|experimental)-/.test(name)) continue;
		const text = readPackageText(archive, "@deepseek-ai/" + name, 900_000);
		if (text !== "") out.push({ pkg: "@deepseek-ai/" + name, text });
	}
	return out;
}

/* ─────────────────────────── Skill 枚举 ─────────────────────────── */

/**
 * 极简 frontmatter 解析（只支持 SKILL.md 实际用到的形状：
 * `key: value`、`key: >` 折行、`key: |` 块、以及 `---` 分隔）。
 */
export function parseFrontmatter(text) {
	const source = String(text || "").replace(/^\uFEFF/, "");
	if (!source.startsWith("---")) return { data: {}, body: source, hasFrontmatter: false };
	const end = source.indexOf("\n---", 3);
	if (end < 0) return { data: {}, body: source, hasFrontmatter: false };
	const head = source.slice(3, end);
	const body = source.slice(end + 4);
	const data = {};
	let currentKey = null;
	let buffer = [];
	const flush = () => {
		if (currentKey === null) return;
		const value = buffer.join(" ").replace(/\s+/g, " ").trim();
		if (value !== "") data[currentKey] = value;
		currentKey = null;
		buffer = [];
	};
	for (const rawLine of head.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		if (/^\s*$/.test(line)) continue;
		const top = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
		if (top) {
			flush();
			const key = top[1];
			const rest = top[2].trim();
			currentKey = key;
			if (rest === ">" || rest === "|" || rest === ">-" || rest === "|-" || rest === "") {
				buffer = [];
			} else {
				data[key] = rest.replace(/^["']|["']$/g, "");
				currentKey = null;
			}
			continue;
		}
		if (currentKey !== null && /^\s+/.test(line)) buffer.push(line.trim());
	}
	flush();
	return { data, body, hasFrontmatter: true };
}

/** 读一个 skill 目录的元数据。 */
async function readSkillDir(dir, name) {
	const file = join(dir, "SKILL.md");
	let text;
	try {
		text = await readFile(file, "utf8");
	} catch {
		return null;
	}
	const { data, body } = parseFrontmatter(text);
	const description = typeof data.description === "string" ? data.description : "";
	const whenToUse = typeof data.whenToUse === "string" ? data.whenToUse : typeof data["when-to-use"] === "string" ? data["when-to-use"] : "";
	return {
		name: typeof data.name === "string" && data.name !== "" ? data.name : name,
		dirName: name,
		dir,
		description,
		whenToUse,
		hasFrontmatter: Object.keys(data).length > 0,
		hasDescription: description !== "",
		bodyChars: body.length,
		createdAt: await birthTimeOf(file, dir),
		invocable: data["disable-model-invocation"] !== "true",
	};
}

/**
 * 枚举全部 Skill。
 *
 * 三个来源：
 *   ① 各 skill 根目录下的 `<name>/SKILL.md`（口径与 dsh-skill-filesystem 一致：只认顶层）
 *   ② 插件包里自带的 skill（`assets/skill/SKILL.md` / `skill/SKILL.md` / `skills/<n>/SKILL.md`）
 *   ③ `.gh-upload/my-dsh-skills/` —— 自写集合仓的暂存目录，**这是「自写」最硬的证据**
 */
export async function discoverSkills(settings = {}, pluginPackages = []) {
	const roots = skillRoots(settings.workspace);
	const ws = workspaceRoot(settings.workspace);
	const selfStage = ws ? join(ws, ...SELF_SKILL_STAGE) : null;
	const selfNames = new Set();
	if (selfStage) {
		try {
			for (const entry of await readdir(selfStage, { withFileTypes: true })) {
				if (entry.isDirectory()) selfNames.add(entry.name);
			}
		} catch {
			/* 没有暂存目录就退化为"按手工标记" */
		}
	}

	const skills = [];
	const seen = new Set();

	for (const root of roots) {
		let entries = [];
		try {
			entries = await readdir(root, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			let isDir = entry.isDirectory();
			if (!isDir && entry.isSymbolicLink()) {
				try {
					isDir = (await stat(join(root, entry.name))).isDirectory();
				} catch {
					isDir = false;
				}
			}
			if (!isDir) continue;
			const meta = await readSkillDir(join(root, entry.name), entry.name);
			if (!meta) continue;
			if (seen.has(meta.name)) continue;
			seen.add(meta.name);
			const self = selfNames.has(entry.name);
			const backup = /\.bak-|\.bak$/.test(entry.name);
			skills.push({
				...meta,
				id: "skill:" + meta.name,
				kind: "skill",
				root,
				/* ★ 真正的 skill 目录要单独记：root 是 skills 根（如 .dsh/skills），
				   拼 join(root, name) 在 frontmatter name 与目录名不一致时会拼错（R6 踩过）。 */
				dir: join(root, entry.name),
				source: self ? "self" : "third",
				sourceWhy: self ? ["在 .gh-upload/my-dsh-skills（自写集合仓）里有同名目录"] : ["装在 skill 根目录下，但不在自写集合仓里"],
				/* ★ 不把每个第三方 skill 都推成「待标记」：那会让待办列表永远清不完。
				   "拿不准"只留给真正拿不准的（混血候选 / 插件自带）。 */
				askUser: false,
				backup,
				hostPlugin: "",
				repoUrl: self ? "https://github.com/" + normalizeOwners(settings.selfOwners)[0] + "/my-dsh-skills" : "",
			});
		}
	}

	/* ② 插件自带 skill：归属跟着插件走（官方插件自带的 skill 就是官方的） */
	for (const pack of pluginPackages) {
		const inherited = pack.source === "hybrid" || pack.source === "pending" ? "pending" : pack.source || "third";
		const candidates = [join(pack.realDir, "assets", "skill"), join(pack.realDir, "skill"), join(pack.realDir, "skills")];
		for (const dir of candidates) {
			let entries = [];
			try {
				entries = await readdir(dir, { withFileTypes: true });
			} catch {
				continue;
			}
			/* assets/skill 本身就可能是 skill 目录（直接含 SKILL.md） */
			const direct = await readSkillDir(dir, pack.pkg.replace(/^.*\//, ""));
			if (direct) {
				if (!seen.has(direct.name)) {
					seen.add(direct.name);
					/* ★ dir 一律指**这个 skill 自己的目录**（对插件自带的就是 assets/skill 本身）：
					   位置块与体积统计都靠它；root 在插件自带里是同一层，但语义不同，别混用。 */
					skills.push({ ...direct, id: "skill:" + direct.name, kind: "skill", root: dir, dir, source: inherited, sourceWhy: ["随插件 " + pack.pkg + " 一起安装"], askUser: inherited === "pending", hostPlugin: pack.pkg, backup: false, repoUrl: pack.repoUrl || "" });
				}
				continue;
			}
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				const meta = await readSkillDir(join(dir, entry.name), entry.name);
				if (!meta || seen.has(meta.name)) continue;
				seen.add(meta.name);
				skills.push({ ...meta, id: "skill:" + meta.name, kind: "skill", root: join(dir, entry.name), dir: join(dir, entry.name), source: inherited, sourceWhy: ["随插件 " + pack.pkg + " 一起安装"], askUser: inherited === "pending", hostPlugin: pack.pkg, backup: false, repoUrl: pack.repoUrl || "" });
			}
		}
	}

	skills.sort((a, b) => a.name.localeCompare(b.name));
	return skills;
}

/* ─────────────────────────── 汇总 ─────────────────────────── */

/**
 * 建目录快照（带缓存）。
 *
 * @param {object} options
 * @param {string} [options.dataDir]
 * @param {object} [options.settings]
 * @param {boolean} [options.force] 忽略缓存
 * @param {(p:object)=>void} [options.onProgress]
 */
export async function buildCatalog(options = {}) {
	const settings = options.settings ?? {};
	const dir = options.dataDir || defaultDataDir(settings.workspace);
	const ttlMs = (Number(settings.catalogTtlSeconds) > 0 ? Number(settings.catalogTtlSeconds) : 300) * 1000;
	const cached = await readJson(catalogFile(dir), null);
	if (!options.force && cached && cached.version === CATALOG_VERSION && Date.now() - Number(cached.builtAt || 0) < ttlMs) {
		return { ...cached, fromCache: true };
	}

	const selfOwners = normalizeOwners(settings.selfOwners);
	const { packages, errors } = await listPluginPackages(settings);
	const progress = typeof options.onProgress === "function" ? options.onProgress : () => {};

	const plugins = [];
	for (let index = 0; index < packages.length; index += 1) {
		const pack = packages[index];
		progress({ phase: "classify", done: index + 1, total: packages.length, pkg: pack.pkg });
		const git = await gitFacts(pack.realDir, selfOwners);
		const verdict = await classifyPlugin(pack, git, selfOwners);
		plugins.push({
			id: "plugin:" + pack.pkg,
			kind: "plugin",
			name: pack.pkg,
			title: pack.pkg,
			version: pack.version,
			description: pack.description,
			author: pack.author,
			license: pack.license,
			keywords: pack.keywords,
			enabled: pack.enabled,
			dependency: pack.dependency,
			dir: pack.dir,
			realDir: pack.realDir,
			isLink: pack.isLink,
			createdAt: pack.createdAt,
			repoUrl: git.remoteWeb || webUrlOf(pack.repositoryField) || pack.homepage || "",
			repositoryField: pack.repositoryField,
			git: {
				hasGit: git.hasGit,
				remote: git.remote || "",
				remoteOwner: git.remoteOwner || "",
				dirty: git.dirty ?? 0,
				ahead: git.ahead ?? 0,
				behind: git.behind ?? 0,
				known: git.divergenceKnown ?? false,
				branch: git.branch || "",
			},
			source: verdict.source,
			sourceWhy: verdict.why,
			askUser: verdict.askUser,
		});
	}

	progress({ phase: "official", done: 0, total: 1 });
	const official = await listOfficialPlugins(settings);
	const allPlugins = [...plugins, ...official.plugins].sort((a, b) => a.name.localeCompare(b.name));

	progress({ phase: "skills", done: 0, total: 1 });
	const skills = await discoverSkills(
		settings,
		allPlugins.map((p) => ({ pkg: p.name, realDir: p.realDir, repoUrl: p.repoUrl, source: p.source })),
	);

	const snapshot = {
		version: CATALOG_VERSION,
		builtAt: Date.now(),
		workspace: workspaceRoot(settings.workspace),
		profileDir: profileDir(),
		skillRoots: skillRoots(settings.workspace),
		selfSkillStage: ws_stage(workspaceRoot(settings.workspace)),
		plugins: allPlugins,
		skills,
		errors: [...(errors ?? []), ...official.missing.map((name) => ({ error: "bundle 里声明但找不到这个包：" + name }))],
		counts: {
			plugins: allPlugins.length,
			skills: skills.length,
			officialFromAsar: official.plugins.length,
			bySource: countBySource([...allPlugins, ...skills]),
		},
	};

	await writeJson(catalogFile(dir), snapshot);
	return { ...snapshot, fromCache: false };
}

function ws_stage(ws) {
	return ws ? join(ws, ...SELF_SKILL_STAGE) : null;
}

function countBySource(entries) {
	const out = { official: 0, self: 0, third: 0, hybrid: 0, pending: 0 };
	for (const entry of entries) {
		const key = entry.source || "third";
		out[key] = (out[key] || 0) + 1;
	}
	return out;
}
