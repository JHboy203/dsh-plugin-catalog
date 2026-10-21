/**
 * dev/probe-stats.mjs — 真机验证 stats.mjs（只读日志、写临时数据目录）。
 * 用法：node dev/probe-stats.mjs [dataDir]
 */
import { join } from "node:path";
import { computeStats, loadAggregate } from "../lib/stats.mjs";
import { workspaceRoot, dshHome } from "../lib/hostinfo.js";

const ws = workspaceRoot();
const home = dshHome();
const sessionsRoot = join(home, "sessions");
const dataDir = process.argv[2] || join(ws || home, ".tmp-catalog-probe", "data");

console.log("workspace:", ws);
console.log("dshHome:", home);
console.log("sessionsRoot:", sessionsRoot);
console.log("dataDir:", dataDir);
console.log("");

const t0 = Date.now();
let lastPct = -1;
const result = await computeStats({
	sessionsRoot,
	dataDir,
	windowDays: 90,
	onProgress: (p) => {
		const pct = Math.floor((p.done / p.total) * 100);
		if (pct >= lastPct + 10) {
			lastPct = pct;
			console.log(`  progress ${pct}% (${p.done}/${p.total}) reused=${p.reused} scanned=${p.scanned}`);
		}
	},
});
const elapsed = Date.now() - t0;

if (!result.ok) {
	console.log("FAILED", result.error);
	process.exit(1);
}
const { aggregate, meta } = result;
console.log("");
console.log("=== FIRST RUN ===");
console.log("elapsedMs:", elapsed, " files:", meta.files, " scanned:", meta.scanned, " reused:", meta.reused);
console.log("frames:", meta.frames, " badLines:", meta.badLines, " bytesMB:", (meta.bytes / 1048576).toFixed(1));
console.log("totals:", JSON.stringify(aggregate.totals));

const top = [...aggregate.tools.values()].sort((a, b) => b.calls - a.calls);
console.log("");
console.log("=== TOP 15 TOOLS ===");
for (const tool of top.slice(0, 15)) {
	const avg = tool.msCount > 0 ? Math.round(tool.ms / tool.msCount) : 0;
	console.log(
		" ",
		String(tool.calls).padStart(6),
		tool.name.padEnd(28),
		"err=" + String(tool.errors).padStart(4),
		"avg=" + String(avg).padStart(6) + "ms",
		"sessions=" + String(tool.sessions).padStart(4),
		"last=" + new Date(tool.lastUsed).toISOString().slice(0, 16),
	);
}

const skillTop = [...aggregate.skills.values()].sort((a, b) => b.calls - a.calls);
console.log("");
console.log("=== SKILLS (被加载次数) ===  distinct:", aggregate.skills.size);
for (const skill of skillTop.slice(0, 12)) {
	console.log(" ", String(skill.calls).padStart(5), skill.name.padEnd(34), "last=" + new Date(skill.lastUsed).toISOString().slice(0, 16));
}

/* 会话维度：子代理占比 + 一个有子代理的父会话 */
const sessions = [...aggregate.sessions.values()];
const sub = sessions.filter((s) => s.parent || s.depth > 0);
console.log("");
console.log("=== SESSIONS ===");
console.log("total:", sessions.length, " subagent:", sub.length, " root:", sessions.length - sub.length);
const parents = sessions.filter((s) => !s.parent && sessions.some((c) => c.parent === s.id));
console.log("parents with children:", parents.length);
const sample = parents.sort((a, b) => b.calls - a.calls)[0];
if (sample) {
	const withTitles = sample.title && sample.title !== sample.id.slice(0, 8);
	console.log(" biggest parent:", sample.id.slice(0, 12), "| title:", JSON.stringify(sample.title), "| titleSource:", sample.titleSource, "| calls:", sample.calls);
	console.log("   title looks like a real nickname:", withTitles);
}

/* 第二遍：应当几乎全部命中缓存（增量刷新的关键） */
const t1 = Date.now();
const second = await computeStats({ sessionsRoot, dataDir, windowDays: 90 });
console.log("");
console.log("=== SECOND RUN (增量) ===");
console.log("elapsedMs:", Date.now() - t1, " scanned:", second.meta.scanned, " reused:", second.meta.reused);

const loaded = await loadAggregate(dataDir, 90);
console.log("cache load stale?", loaded.stale, " tools:", loaded.aggregate?.tools.size);
