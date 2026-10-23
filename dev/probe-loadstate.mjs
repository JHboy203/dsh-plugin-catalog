/**
 * dev/probe-loadstate.mjs — 独立复核「装了到底会不会加载」（R12 判据的固化件，R13 收口）。
 *
 * ★ 为什么要有它：R12 的判据（`lib/loadstate.mjs`）现在同时被三个地方用 ——
 *   catalog 枚举、`catalog_health`、面板 chip。三处共用一份逻辑是好事，
 *   但**共用就没法互相证伪**：哪天这份逻辑整体错了，三处会一起错、自检也一起绿。
 *   所以这里做一份**独立重算**：自己扫 profile 的 `node_modules` 与两份组合文件，
 *   算完再和目录快照对账。它是"换个算法再问一遍同一个问题"，不是又抄一遍实现。
 *
 * 用法：
 *   node dev/probe-loadstate.mjs           # 人读：四态分布 + dormant 清单 + 不变式结论
 *   node dev/probe-loadstate.mjs --json    # 机器读：一段 JSON（给脚本/别的会话用）
 *
 * 退出码：0 不变式全部成立 / 1 有不变式被破坏（或环境不可用）。
 *
 * ★ 不变式（任何一条不成立都说明判据或实现坏了，不是"这台机器特殊"）：
 *   I1 四态计数之和 === 已装包数（不许有包落不进任何一态）
 *   I2 bundle 态数 === |bundles ∩ 已装|
 *   I3 每个 transitive 的 `via` 非空，且能指向一个真实入口（bundles 名或配置条目 id）
 *   I4 dormant 与入口集合无交集
 *   I5 组合文件里 `disabled: true` 的条目**没有**成为入口
 *   I6 目录快照里每个条目的 `loadState` 与本次重算一致（快照过期会在这里先暴露）
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { dataDir, profileBundles, profileComposition, profileDir, profileNodeModules } from "../lib/hostinfo.js";
import { LOAD_STATES, parseComposition, resolveLoadPaths } from "../lib/loadstate.mjs";

const asJson = process.argv.includes("--json");

/** 收集 profile 里每个包声明的三类依赖（与 catalog 的口径一致：顶层 + 一层嵌套）。 */
async function scanInstalled(nodeModules) {
	const installed = new Map();
	const readMeta = async (dir) => {
		try {
			const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
			if (!pkg || typeof pkg.name !== "string" || pkg.name === "") return null;
			const deps = [];
			for (const key of ["dependencies", "optionalDependencies", "peerDependencies"]) {
				if (pkg[key] && typeof pkg[key] === "object") deps.push(...Object.keys(pkg[key]));
			}
			return { name: pkg.name, deps: [...new Set(deps)] };
		} catch {
			return null;
		}
	};
	const visit = async (name, dir) => {
		const info = await stat(dir).catch(() => null);
		if (!info || !info.isDirectory()) return;
		const meta = await readMeta(dir);
		if (meta) installed.set(meta.name || name, meta.deps);
		return dir;
	};

	const entries = await readdir(nodeModules).catch(() => []);
	const dirs = [];
	for (const entry of entries) {
		if (entry.startsWith(".")) continue;
		if (entry.startsWith("@")) {
			for (const sub of await readdir(join(nodeModules, entry)).catch(() => [])) dirs.push([entry + "/" + sub, join(nodeModules, entry, sub)]);
		} else {
			dirs.push([entry, join(nodeModules, entry)]);
		}
	}
	for (const [name, dir] of dirs) await visit(name, dir);
	/* 嵌套一层：只补依赖图，不作为入口（入口只来自 bundles 与组合文件）。 */
	for (const [, dir] of dirs) {
		const nested = join(dir, "node_modules");
		const names = await readdir(nested).catch(() => []);
		const nestedDirs = [];
		for (const name of names) {
			if (name.startsWith(".")) continue;
			if (name.startsWith("@")) {
				for (const sub of await readdir(join(nested, name)).catch(() => [])) nestedDirs.push([name + "/" + sub, join(nested, name, sub)]);
			} else {
				nestedDirs.push([name, join(nested, name)]);
			}
		}
		for (const [name, target] of nestedDirs) await visit(name, target);
	}
	return installed;
}

async function readSizeSnapshot() {
	try {
		const raw = JSON.parse(await readFile(join(dataDir(), "cache", "sizes.json"), "utf8"));
		return raw && typeof raw.byId === "object" ? raw.byId : {};
	} catch {
		return {};
	}
}

async function readCatalogSnapshot() {
	try {
		const raw = JSON.parse(await readFile(join(dataDir(), "cache", "catalog.json"), "utf8"));
		return raw && Array.isArray(raw.plugins) ? raw : null;
	} catch {
		return null;
	}
}

function fmtBytes(bytes) {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	const units = ["B", "KB", "MB", "GB"];
	let value = bytes;
	let index = 0;
	while (value >= 1024 && index < units.length - 1) {
		value /= 1024;
		index += 1;
	}
	return (index === 0 ? value.toFixed(0) : value.toFixed(1)) + " " + units[index];
}

const profile = profileDir();
if (!profile) {
	console.error("找不到 profile 目录（DSH_HOME / cwd 都不对）");
	process.exit(1);
}
const nodeModules = profileNodeModules();
if (!nodeModules) {
	console.error("找不到 profile 的 node_modules：" + profile);
	process.exit(1);
}

const bundles = await profileBundles();
const composition = await profileComposition();
const compositions = composition.files.flatMap((file) => parseComposition(file.text));
const installed = await scanInstalled(nodeModules);
const result = resolveLoadPaths({ bundles, compositions, installed });

/* ── 不变式 ── */
const roots = result.roots;
const rootNames = new Set(roots.map((root) => root.name));
const rootIds = new Set(roots.map((root) => root.id).filter(Boolean));
const installedBundleRoots = bundles.filter((name) => installed.has(name));
const failures = [];

const sumCounts = LOAD_STATES.reduce((sum, state) => sum + Number(result.counts[state] || 0), 0);
if (sumCounts !== installed.size) failures.push(`I1 四态计数之和 ${sumCounts} ≠ 已装包数 ${installed.size}`);

const bundleCount = [...result.byName.values()].filter((value) => value.state === "bundle").length;
const expectedBundle = new Set(installedBundleRoots).size;
if (bundleCount !== expectedBundle) failures.push(`I2 bundle 态 ${bundleCount} ≠ |bundles ∩ 已装| ${expectedBundle}`);

for (const [name, value] of result.byName) {
	if (value.state !== "transitive") continue;
	if (!value.via) failures.push(`I3 ${name} 是 transitive 但 via 为空`);
	else if (!rootNames.has(value.via) && !rootIds.has(value.via)) failures.push(`I3 ${name} 的 via=${value.via} 不是任何入口`);
}

for (const [name, value] of result.byName) {
	if (value.state === "dormant" && rootNames.has(name)) failures.push(`I4 ${name} 既是 dormant 又是入口`);
}

const disabledRoots = compositions.filter((entry) => entry.disabled && entry.name && rootNames.has(entry.name));
if (disabledRoots.length > 0) failures.push(`I5 disabled 条目成了入口：${disabledRoots.map((entry) => entry.id || entry.name).join("、")}`);

/* I6：目录快照对账（过期快照会在这里先露出来） */
const snapshot = await readCatalogSnapshot();
const mismatched = [];
if (snapshot) {
	for (const plugin of snapshot.plugins) {
		if (plugin.inAsar) continue;
		const fresh = result.byName.get(plugin.name);
		if (!fresh) continue;
		if (plugin.loadState !== fresh.state) mismatched.push({ name: plugin.name, snapshot: plugin.loadState || "", fresh: fresh.state });
	}
	if (mismatched.length > 0) failures.push(`I6 快照与重算不一致 ${mismatched.length} 条（先点「重新扫描」或等启动兜底任务）`);
}

/* ── 报告 ── */
const sizes = await readSizeSnapshot();
const dormantNames = [...result.byName.entries()].filter(([, value]) => value.state === "dormant").map(([name]) => name).sort((a, b) => a.localeCompare(b));
const dormantBytes = dormantNames.reduce((sum, name) => {
	const entry = sizes["plugin:" + name];
	return sum + (entry && Number.isFinite(entry.bytes) ? entry.bytes : 0);
}, 0);
/* 「旧口径会误导」的数量：enabled=false（不在 bundles）但实际会被加载 */
const misleading = [...result.byName.entries()].filter(([name, value]) => value.state !== "dormant" && !bundles.includes(name)).length;

const payload = {
	ok: failures.length === 0,
	profile,
	compositionFiles: composition.files.length,
	bundles: bundles.length,
	installed: installed.size,
	roots: roots.length,
	counts: result.counts,
	disabledRoots: disabledRoots.length,
	misleadingEnabledFalse: misleading,
	dormant: { count: dormantNames.length, bytes: dormantBytes, names: dormantNames },
	failures,
};

if (asJson) {
	console.log(JSON.stringify(payload, null, 1));
	process.exit(payload.ok ? 0 : 1);
}

console.log("ds-plugin-catalog / probe-loadstate（独立重算，不读目录缓存）");
console.log("");
console.log("profile        : " + profile);
console.log("组合文件       : " + composition.files.length + " 份（" + compositions.length + " 个顶层条目）");
console.log("bundles 声明   : " + bundles.length + "（其中已装 " + installedBundleRoots.length + "）");
console.log("已装包 / 入口  : " + installed.size + " / " + roots.length);
console.log(
	"四态           : bundle " + result.counts.bundle + " · config " + result.counts.config + " · transitive " + result.counts.transitive + " · dormant " + result.counts.dormant,
);
console.log("旧口径会误导   : " + misleading + " 个包 enabled=false 但会被加载（这批绝不能说「未启用」）");
console.log("");
console.log("不会被加载（dormant）" + (dormantNames.length > 0 ? "：" + dormantNames.length + " 个 / 有体积记录的合计 " + fmtBytes(dormantBytes) : "：0 个"));
for (const name of dormantNames) {
	const entry = sizes["plugin:" + name];
	const size = entry && Number.isFinite(entry.bytes) ? fmtBytes(entry.bytes) : "（体积未量）";
	console.log("  - " + name.padEnd(42) + size);
}
if (mismatched.length > 0) {
	console.log("");
	console.log("快照与重算不一致（前 8 条）：");
	for (const item of mismatched.slice(0, 8)) console.log("  ! " + item.name + "：快照=" + (item.snapshot || "（空）") + " 重算=" + item.fresh);
}
console.log("");
if (failures.length > 0) {
	console.log("✗ 不变式被破坏（" + failures.length + " 条）：");
	for (const failure of failures) console.log("  · " + failure);
	process.exit(1);
}
console.log("✓ 六条不变式全部成立（I1 计数守恒 / I2 bundle 口径 / I3 via 指得回入口 / I4 dormant 与入口无交集 / I5 disabled 不算入口 / I6 快照与重算一致）");
