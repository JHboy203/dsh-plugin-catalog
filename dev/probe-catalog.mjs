/**
 * dev/probe-catalog.mjs — 真机验证 catalog.mjs + attrib.mjs（只读、写临时数据目录）。
 */
import { join } from "node:path";
import { buildCatalog, discoverSkills, listPluginPackages } from "../lib/catalog.mjs";
import { buildToolIndex } from "../lib/attrib.mjs";
import { buildAggregate, loadAggregate } from "../lib/stats.mjs";
import { dshHome, skillRoots, workspaceRoot } from "../lib/hostinfo.js";

const ws = workspaceRoot();
const dataDir = join(ws || dshHome(), ".tmp-catalog-probe", "data");
console.log("workspace:", ws);
console.log("dataDir:", dataDir);
console.log("skillRoots:", skillRoots());
console.log("");

const t0 = Date.now();
const catalog = await buildCatalog({ dataDir, settings: {}, force: true, onProgress: (p) => {
	if (p.total > 0 && p.done % 20 === 0) console.log(`  ${p.phase} ${p.done}/${p.total}`);
} });
console.log("buildCatalog ms:", Date.now() - t0, " fromCache:", catalog.fromCache);
console.log("counts:", JSON.stringify(catalog.counts));
console.log("errors:", JSON.stringify(catalog.errors).slice(0, 300));
console.log("");

console.log("=== 来源分布（插件） ===");
for (const source of ["official", "self", "third", "hybrid", "pending"]) {
	const list = catalog.plugins.filter((p) => p.source === source);
	console.log(source.padEnd(9), list.length, " ", list.slice(0, 6).map((p) => p.name).join(", "));
}
console.log("");
console.log("=== 前 8 个自写插件（含证据） ===");
for (const p of catalog.plugins.filter((x) => x.source === "self").slice(0, 8)) {
	console.log(" ", p.name, "| enabled=" + p.enabled, "| repo=" + (p.repoUrl || "-"), "| git=" + (p.git.hasGit ? "dirty:" + p.git.dirty + " ahead:" + p.git.ahead : "no"));
	console.log("     why:", p.sourceWhy.join(" / "));
}
console.log("");
console.log("=== 待标记（askUser） ===");
const pending = [...catalog.plugins, ...catalog.skills].filter((x) => x.askUser || x.source === "pending");
console.log("count:", pending.length);
for (const p of pending.slice(0, 10)) console.log(" ", p.kind, p.name, "|", p.sourceWhy.join(" / "));
console.log("");
console.log("=== Skills ===");
console.log("total:", catalog.skills.length, " self:", catalog.skills.filter((s) => s.source === "self").length, " backup:", catalog.skills.filter((s) => s.backup).length);
for (const s of catalog.skills.slice(0, 10)) {
	console.log(" ", s.name.padEnd(32), s.source.padEnd(8), "desc=" + (s.hasDescription ? "y" : "NO"), "backup=" + s.backup, "root=" + s.root.split(/[\\/]/).slice(-2).join("/"));
}
console.log("");
const missing = catalog.skills.filter((s) => !s.hasDescription);
console.log("skills missing description:", missing.length, missing.slice(0, 8).map((s) => s.name).join(", "));

/* 归属索引：需要实时工具 schema。宿主不在时用日志里出现过的工具名 + 空描述做近似，
   真机（宿主里）应传 ctx.tools.schemas()。这里先验证纯函数能跑通。 */
const stats = await loadAggregate(dataDir, 90);
if (stats.aggregate) {
	const names = [...stats.aggregate.tools.keys()].map((name) => ({ name }));
	const packages = catalog.plugins.map((p) => ({ pkg: p.name, root: p.realDir }));
	const t1 = Date.now();
	const built = await buildToolIndex({ dataDir, tools: names, packages, force: true });
	console.log("");
	console.log("=== 归属索引（无描述，仅名字证据） ===");
	console.log("elapsedMs:", Date.now() - t1, "stats:", JSON.stringify(built.stats));
	const owned = Object.entries(built.index).filter(([, v]) => v.owner);
	console.log("owned:", owned.length, "of", Object.keys(built.index).length);
	for (const [name, v] of owned.sort((a, b) => (stats.aggregate.tools.get(b[0])?.calls ?? 0) - (stats.aggregate.tools.get(a[0])?.calls ?? 0)).slice(0, 18)) {
		console.log(" ", String(stats.aggregate.tools.get(name)?.calls ?? 0).padStart(6), name.padEnd(28), "->", v.owner, "(" + v.how + ")");
	}
}

/* 单独验证 Skill 发现（不经 catalog 缓存） */
const pkgs = await listPluginPackages({});
const direct = await discoverSkills({}, pkgs.packages.map((p) => ({ pkg: p.pkg, realDir: p.realDir })));
console.log("");
console.log("discoverSkills (fresh):", direct.length, " of which plugin-bundled:", direct.filter((s) => s.hostPlugin).length);
for (const s of direct.filter((x) => x.hostPlugin).slice(0, 8)) console.log("  bundled:", s.name, "<-", s.hostPlugin);
