/**
 * dev/measure-attrib.mjs — 用**真实的工具 schema** 量归属覆盖率（只读）。
 *
 * 为什么需要它：归属是推断的，而"推得准不准"必须用真数据量，不能靠感觉。
 * 输入是 `cordis_inspect_query(host/Tool/listTools)` 的完整输出（含每个工具的 description）。
 *
 * 用法：
 *   node dev/measure-attrib.mjs <tool-schemas.json> [dataDir]
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { attributeTools, collectPackageText } from "../lib/attrib.mjs";
import { readOfficialToolPackages } from "../lib/catalog.mjs";
import { asarMode, asarPath } from "../lib/asar.mjs";
import { listPluginPackages } from "../lib/catalog.mjs";
import { loadAggregate } from "../lib/stats.mjs";
import { dataDir as dataDirOf } from "../lib/hostinfo.js";
import { loadSettings } from "../lib/settings.mjs";

const schemaPath = process.argv[2] || process.env.DSH_CATALOG_SCHEMAS;
if (!schemaPath) {
	console.error("用法: DSH_CATALOG_SCHEMAS=<tool-schemas.json> node dev/measure-attrib.mjs [dataDir]");
	process.exit(2);
}
const raw = JSON.parse(readFileSync(schemaPath, "utf8"));
/* 三种形状都认：裸数组 / {tools} / inspect 的 {data:{tools}} */
const tools = Array.isArray(raw) ? raw : raw?.tools || raw?.data?.tools || [];
if (tools.length === 0) {
	console.error("schema 文件里没有 tools");
	process.exit(2);
}

const dataDir = process.argv[3] || dataDirOf();
const settings = await loadSettings(dataDir);
const archive = asarPath();

console.log("工具 schema:", tools.length, "（带描述", tools.filter((tool) => tool.description).length, "）");
console.log("asar:", archive, "mode:", asarMode(archive));
console.log("dataDir:", dataDir);

/* 候选包：profile 里的插件 + asar 里的官方工具包 */
const { packages } = await listPluginPackages(settings);
const profileTexts = [];
for (const pack of packages) {
	const text = await collectPackageText(pack.realDir);
	if (text !== "") profileTexts.push({ pkg: pack.pkg, text, local: pack.isLink });
}
const officialTexts = await readOfficialToolPackages();
console.log("候选包：profile", profileTexts.length, "+ 官方 asar", officialTexts.length);

const started = Date.now();
const result = attributeTools(tools, [...profileTexts, ...officialTexts], {});
console.log("归属计算耗时:", Date.now() - started, "ms");
console.log("统计:", JSON.stringify(result.stats));

/* 用真实的 90 天调用量加权 */
const { aggregate } = await loadAggregate(dataDir, settings.windowDays);
const calls = new Map();
let totalCalls = 0;
if (aggregate) {
	for (const [name, tool] of aggregate.tools) {
		calls.set(name, tool.calls);
		totalCalls += tool.calls;
	}
}

const rows = tools.map((tool) => {
	const verdict = result.tools[tool.name] || { owner: "", how: "missing" };
	return { name: tool.name, calls: calls.get(tool.name) || 0, ...verdict };
});

function sumCalls(predicate) {
	return rows.filter(predicate).reduce((sum, row) => sum + row.calls, 0);
}

const pct = (value) => (totalCalls > 0 ? ((value / totalCalls) * 100).toFixed(1) + "%" : "—");
console.log("");
console.log("=== 按 90 天调用量加权（总计 " + totalCalls + " 次） ===");
console.log("  描述指纹唯一归属 :", sumCalls((row) => row.how === "description"), pct(sumCalls((row) => row.how === "description")));
console.log("  名字字面量归属   :", sumCalls((row) => row.how === "name-literal"), pct(sumCalls((row) => row.how === "name-literal")));
console.log("  判为宿主/官方    :", sumCalls((row) => row.how === "host"), pct(sumCalls((row) => row.how === "host")));
console.log("  歧义             :", sumCalls((row) => row.how.includes("ambiguous")), pct(sumCalls((row) => row.how.includes("ambiguous"))));
console.log("  未归属           :", sumCalls((row) => row.how === "missing" || row.how === "unknown"), pct(sumCalls((row) => row.how === "missing" || row.how === "unknown")));

const owners = new Map();
for (const row of rows) {
	if (!row.owner) continue;
	owners.set(row.owner, (owners.get(row.owner) || 0) + row.calls);
}
console.log("");
console.log("=== 调用量 Top 12 的归属包 ===");
for (const [owner, count] of [...owners.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
	console.log("  " + String(count).padStart(7), owner);
}

console.log("");
console.log("=== 未归属/歧义里调用量最大的 12 个 ===");
const unresolved = rows.filter((row) => !row.owner).sort((a, b) => b.calls - a.calls).slice(0, 12);
for (const row of unresolved) console.log("  " + String(row.calls).padStart(7), row.name.padEnd(28), row.how);
