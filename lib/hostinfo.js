/**
 * hostinfo.js — 宿主事实与路径解析（本插件的唯一"环境知识"入口）。
 *
 * 为什么统一收口：
 *   1. 宿主 cwd 是 **profile 目录**、不是工作区（dsh-client-plugin-ops 坑 14），
 *      任何模块自己猜路径都会猜错。
 *   2. 自写插件是以 **junction / link:** 装进 profile 的（实测 22 个），
 *      所以「插件目录」与「profile 里的条目」是同一个 inode、不是两份拷贝。
 *   3. 数据必须落在**工作区**的固定位置（`.dsh-plugin-catalog/`），
 *      不能写插件安装目录 —— 否则升级/重装即丢。
 *
 * @module dsh-plugin-catalog/hostinfo
 */

import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 插件自身目录（它可能就是 profile 里的 junction 目标）。 */
export const PLUGIN_DIR = fileURLToPath(new URL("..", import.meta.url));

/** 数据目录名（工作区下）。 */
export const DATA_DIR_NAME = ".dsh-plugin-catalog";

/** 只靠「env + 插件自身位置 + 用户目录」推断 .dsh，**不调用 profileDir()**（否则循环）。 */
function dshHomeRaw() {
	if (process.env.DSH_HOME) return process.env.DSH_HOME;
	const ws = pluginWorkspace();
	if (ws) {
		const candidate = join(ws, ".dsh");
		if (existsSync(candidate)) return candidate;
	}
	return join(homedir(), ".dsh");
}

/**
 * profile 目录：env 优先，其次 cwd（宿主 cwd 通常是 profile），
 * 再次插件位置里的 `profiles/<name>` 片段，最后在 .dsh 下找 `profiles/`。
 *
 * ★ 为什么需要最后那条：在插件目录里直接 `node dev/xxx.mjs` 时，
 *   上面三条都可能不成立（cwd 是插件目录、插件还没装进 profile），
 *   于是 profile 会被判成"不存在"→ 插件清单变成 0 个。
 *   这不是小事：那会让面板显示「本机没有任何插件」。
 */
export function profileDir() {
	const fromEnv = process.env.DSH_PROFILE_DIR;
	if (fromEnv) return fromEnv;
	const cwd = process.cwd();
	if (/profiles[\\/][^\\/]+$/.test(cwd)) return cwd;
	const marker = /^(.*)[\\/]profiles[\\/]([^\\/]+)[\\/]/.exec(PLUGIN_DIR);
	if (marker) return join(marker[1], "profiles", marker[2]);

	const profilesRoot = join(dshHomeRaw(), "profiles");
	try {
		const names = readdirSync(profilesRoot);
		if (names.includes("desktop")) return join(profilesRoot, "desktop");
		if (names.length > 0) return join(profilesRoot, names[0]);
	} catch {
		/* 没有 profiles 目录就是没有 */
	}
	return null;
}

export function profileName() {
	if (process.env.DSH_PROFILE) return process.env.DSH_PROFILE;
	const dir = profileDir();
	return dir ? dir.split(/[\\/]/).pop() : "desktop";
}

/**
 * 插件若以 `DSH-Plugin\<pkg>` 的形态存在，其上一级就是工作区。
 * 这是本机唯一一条**不依赖环境变量**也能成立的推断（junction 目标就在那儿）。
 */
export function pluginWorkspace() {
	if (/[\\/]DSH-Plugin[\\/]/i.test(PLUGIN_DIR)) return resolve(PLUGIN_DIR, "..", "..");
	return null;
}

/**
 * DSH 运行时目录（`.dsh`）。
 *
 * ★ 本机实况（2026-10-21 实测，别按常识猜）：
 *   - `<工作区>\.dsh` 才是真正在跑的那个：sessions / profiles / skills / storages 都在这儿；
 *   - `C:\Users\<user>\.dsh` 只有一个 `skills` 和 `dsh-power-menu`，**没有 sessions**。
 *   所以顺序必须是「profile 结构 → 工作区下的 .dsh → ~/.dsh」，
 *   否则统计会扫到一个空目录，然后安静地报告"零调用"。
 */
export function dshHome() {
	const dir = profileDir();
	if (dir && /[\\/]profiles[\\/][^\\/]+$/.test(dir)) return resolve(dir, "..", "..");
	return dshHomeRaw();
}

/**
 * 工作区根。
 *
 * 判据顺序（互相印证的那几条本机都验证过）：
 *   ① env `DSH_WORKSPACE` / `DSH_WORKSPACE_DIR`（宿主会注入）
 *   ② 插件自己的位置若在 `<ws>/DSH-Plugin/<pkg>`，向上两级就是工作区
 *   ③ dshHome 的父目录（本机 `.dsh` 就长在工作区里）
 *   ④ 全都不成立时返回 null —— **不猜**，由调用方降级
 *
 * @param {string} [override] 设置里显式指定的工作区（优先级最高）
 * @returns {string|null}
 */
export function workspaceRoot(override) {
	if (override) return override;
	const env = process.env.DSH_WORKSPACE || process.env.DSH_WORKSPACE_DIR;
	if (env) return env;
	const ws = pluginWorkspace();
	if (ws) return ws;
	const home = dshHome();
	if (home.split(/[\\/]/).pop() === ".dsh") return resolve(home, "..");
	return null;
}

/**
 * 数据目录：`<workspace>/.dsh-plugin-catalog/`。
 * 工作区解析不出来时退到 `<dshHome>/.dsh-plugin-catalog/`（仍然不是插件目录）。
 */
export function dataDir(override) {
	if (process.env.DSH_CATALOG_DIR) return process.env.DSH_CATALOG_DIR;
	const ws = workspaceRoot(override);
	return join(ws || dshHome(), DATA_DIR_NAME);
}

/**
 * 技能根目录。
 *
 * 三处都要扫（本机实测都非空，漏一处就会把技能说成"没装"）：
 *   · `<工作区>/.dsh/skills`      —— 主战场（56 个目录，含 4 个 `.bak-*` 迁移残留）
 *   · `<DSH_HOME>/skills`         —— 用户级
 *   · `~/.dsh/skills`             —— 另一份历史落点（`C:\Users\<user>\.dsh\skills`）
 * 发现口径与 dsh-skill-filesystem 一致：**顶层** `<name>/SKILL.md`（嵌套的故意不发现）。
 */
export function skillRoots(workspaceOverride) {
	const home = dshHome();
	const list = [];
	if (process.env.DSH_SKILLS_DIR) list.push(process.env.DSH_SKILLS_DIR);
	const ws = workspaceRoot(workspaceOverride);
	if (ws) list.push(join(ws, ".dsh", "skills"));
	list.push(join(home, "skills"));
	list.push(join(homedir(), ".dsh", "skills"));
	const uniq = [];
	for (const dir of list) if (!uniq.some((x) => resolve(x) === resolve(dir))) uniq.push(dir);
	return uniq;
}

/** profile 的 package.json（bundle 清单与依赖都在里面）。 */
export async function profileManifest() {
	const dir = profileDir();
	if (!dir) return null;
	try {
		return JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
	} catch {
		return null;
	}
}

/** `dsh.profile.bundles` —— 只有列在这里的插件才会被加载。 */
export async function profileBundles() {
	const pkg = await profileManifest();
	const bundles = pkg?.dsh?.profile?.bundles;
	return Array.isArray(bundles) ? bundles.filter((x) => typeof x === "string") : [];
}

/** profile 的 dependencies（装了但可能没启用）。 */
export async function profileDependencies() {
	const pkg = await profileManifest();
	return pkg && pkg.dependencies && typeof pkg.dependencies === "object" ? pkg.dependencies : {};
}

/** profile 里 node_modules 的实际路径。 */
export function profileNodeModules() {
	const dir = profileDir();
	return dir ? join(dir, "node_modules") : null;
}

/**
 * 解析一个 profile 内包目录的**真实路径**。
 * 自写插件是 junction/symlink，`realpath` 会穿到 `DSH-Plugin\<pkg>` ——
 * 这正是「自写」判定最硬的那条证据（文件系统事实，不看人设）。
 */
export async function realPathOf(path) {
	try {
		return await realpath(path);
	} catch {
		return path;
	}
}

export async function pathExists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function readJson(file) {
	try {
		return JSON.parse(await readFile(file, "utf8"));
	} catch {
		return null;
	}
}

/**
 * Electron 的 resources 目录。
 *
 * 宿主里 `process.resourcesPath` 一定在；但在**纯 node**（dev 探针、自检脚本）里没有，
 * 所以额外认一个 `DSH_RESOURCES_DIR` 环境变量 —— 探针脚本必须显式指一下，
 * 不要靠"猜安装路径"（那会把本机路径写死进代码）。
 */
export function resourcesPath() {
	if (process.env.DSH_RESOURCES_DIR) return process.env.DSH_RESOURCES_DIR;
	if (process.resourcesPath) return process.resourcesPath;
	const exe = process.execPath || "";
	if (/[\\/]resources[\\/]/i.test(exe)) return dirname(dirname(exe));
	if (/\.exe$/i.test(exe)) {
		const candidate = join(dirname(exe), "resources");
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

let cachedVersions = null;

/**
 * 宿主版本事实。
 *
 * 不 `import("@deepseek-ai/dsh-tools")`：本插件以 junction 装进 profile，
 * 裸 import 会走就近解析落到 profile/node_modules —— 那里没有、也不该有宿主包
 * （有就是"陈旧 dsh-tools 覆盖宿主"那个坑）。所以只从**文件系统事实**读。
 */
export async function hostVersions(force = false) {
	if (cachedVersions && !force) return cachedVersions;
	const sources = [];
	let dsh = process.env.DSH_VERSION || null;
	let dshTools = null;
	const roots = [];
	const res = resourcesPath();
	if (res) roots.push(res);
	if (process.env.DSH_INSTALL_ROOT) roots.push(process.env.DSH_INSTALL_ROOT);
	for (const root of roots) {
		if (!dsh) {
			const pkg = await readJson(join(root, "app.asar", "package.json"));
			if (pkg?.version) {
				dsh = String(pkg.version);
				sources.push("app.asar/package.json");
			}
		}
		const toolsPkg = await readJson(join(root, "app.asar", "dsh", "node_modules", "@deepseek-ai", "dsh-tools", "package.json"));
		if (toolsPkg?.version) {
			dshTools = String(toolsPkg.version);
			sources.push("dsh-tools@" + dshTools);
		}
	}
	cachedVersions = { dsh, dshTools, node: process.versions.node, sources };
	return cachedVersions;
}

let cachedBuild = null;
let cachedBuildAt = 0;
/* ★ 缓存只留 5 秒：Cordis 重载插件时**不会**重新执行这个模块（module 缓存仍在），
   永久缓存会让面板头部一直显示升级前的版本号（R6 踩过：package.json 已是 0.6.0，头部还写 0.5.0）。
   一次 7 个 stat，20 秒轮询下代价可忽略。 */
const BUILD_CACHE_MS = 5000;

/**
 * 构建标记：版本号 + 源码最新 mtime。
 *
 * 宿主半边**不热重载**，光看版本号永远不知道「现在跑的是不是刚改的那份」。
 * 改了 index.js / client.js / lib/*.js 里任何一个，这个标签就会变。
 */
export async function buildStamp(force = false) {
	if (cachedBuild && !force && Date.now() - cachedBuildAt < BUILD_CACHE_MS) return cachedBuild;
	const pkg = await readJson(join(PLUGIN_DIR, "package.json"));
	const version = pkg?.version || "0.0.0";
	const candidates = ["index.js", "client.js"];
	try {
		for (const name of await readdir(join(PLUGIN_DIR, "lib"))) {
			if (name.endsWith(".js") || name.endsWith(".mjs")) candidates.push(join("lib", name));
		}
	} catch {
		/* 没有 lib 目录也照常工作 */
	}
	let newest = 0;
	let newestFile = null;
	for (const rel of candidates) {
		try {
			const info = await stat(join(PLUGIN_DIR, rel));
			if (info.mtimeMs > newest) {
				newest = info.mtimeMs;
				newestFile = rel;
			}
		} catch {
			/* 缺文件不算错 */
		}
	}
	const pad = (n) => String(n).padStart(2, "0");
	const at = newest > 0 ? new Date(newest) : new Date();
	const stamp =
		at.getFullYear() + "-" + pad(at.getMonth() + 1) + "-" + pad(at.getDate()) + " " + pad(at.getHours()) + ":" + pad(at.getMinutes());
	cachedBuild = { label: version + " · " + stamp, version, newestFile, files: candidates.length, at: newest > 0 ? at.toISOString() : null };
	cachedBuildAt = Date.now();
	return cachedBuild;
}
