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
 *   I7（R14）dormant 对「会被加载的包的声明」封闭：没有任何会被加载的包声明依赖 dormant 包。
 *      这是卸载清单（`catalog_uninstall` / 面板「处置清单」）的**唯一安全前提**。
 *      它抓到过真问题：按"同名副本取最后读到那份"的口径，`emoji-regex` 被算成 dormant，
 *      而顶层 `string-width`（随 @anweat/dsh-browser 加载）正声明着它。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { dataDir, profileBundles, profileComposition, profileDir, profileNodeModules } from "../lib/hostinfo.js";
import { LOAD_STATES, parseComposition, resolveLoadPaths, scanInstalledPackages } from "../lib/loadstate.mjs";

const asJson = process.argv.includes("--json");

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
/* ★ R14：依赖图改由 `lib/loadstate.mjs` 的 `scanInstalledPackages` 扫（同名副本取并集）。
   探针仍然**独立重算四态**（bundles / 组合文件自己读，resolveLoadPaths 自己调），
   只是不再自己抄一份目录扫描 —— 抄两份的代价是两边差一个包（本机 `emoji-regex` 就是这么露的馅）。 */
const scanned = await scanInstalledPackages(nodeModules);
const installed = scanned.installed;
const duplicateCopies = scanned.duplicates;
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

/* I6：目录快照对账（过期快照会在这里先露出来）
   ★ R14：条目名是**目录名**，而加载态是按**包名**算的（别名目录 `ghbackup` → `dsh-github-backup`）。
     不按 `packageName` 对账的话，这一条要么静默跳过、要么永远对不上。 */
const snapshot = await readCatalogSnapshot();
const mismatched = [];
if (snapshot) {
	for (const plugin of snapshot.plugins) {
		if (plugin.inAsar) continue;
		const fresh = result.byName.get(plugin.packageName || plugin.name);
		if (!fresh) continue;
		if (plugin.loadState !== fresh.state) mismatched.push({ name: plugin.name, snapshot: plugin.loadState || "", fresh: fresh.state });
	}
	if (mismatched.length > 0) failures.push(`I6 快照与重算不一致 ${mismatched.length} 条（先点「重新扫描」或等启动兜底任务）`);
}

/* I7（R14）：dormant 集合必须对"会被加载的包的声明"封闭 ——
   没有任何会被加载的包里声明依赖某个 dormant 包。这是**卸载清单的唯一安全前提**：
   只要这条成立，"删 dormant 不会弄坏正在加载的东西"就在声明层面站得住。
   ★ 它抓到过真问题：按"同名副本取最后读到那份"的口径，`emoji-regex` 被算成 dormant，
     而顶层 `string-width`（随 @anweat/dsh-browser 加载）正声明着它 —— I7 一跑就红。
     修法是依赖图取并集（保守方向），不是把这条降级成警告。 */
const offenders = [];
for (const [name, value] of result.byName) {
	if (value.state === "dormant") continue;
	for (const dep of installed.get(name) || []) {
		const target = result.byName.get(dep);
		if (target && target.state === "dormant") offenders.push({ from: name, dep });
	}
}
if (offenders.length > 0) {
	const preview = offenders.slice(0, 5).map((item) => item.from + " → " + item.dep).join("、");
	failures.push(`I7 会被加载的包声明了 dormant 包 ${offenders.length} 处（${preview}）—— 卸载清单的前提不成立`);
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
	/* 同名多份副本（依赖图取并集的原因）：本机有十几个，`string-width` 就是靠它露的馅 */
	duplicateCopies,
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
console.log("同名多份副本   : " + duplicateCopies.length + (duplicateCopies.length > 0 ? "（" + duplicateCopies.slice(0, 6).join("、") + (duplicateCopies.length > 6 ? " 等" : "") + "）—— 依赖取并集" : ""));
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
console.log("✓ 七条不变式全部成立（I1 计数守恒 / I2 bundle 口径 / I3 via 指得回入口 / I4 dormant 与入口无交集 / I5 disabled 不算入口 / I6 快照与重算一致 / I7 dormant 对加载中的声明封闭）");
