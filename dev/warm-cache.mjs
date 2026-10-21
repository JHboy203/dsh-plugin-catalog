/**
 * dev/warm-cache.mjs — 预热真实数据目录（`.dsh-plugin-catalog/`）。
 *
 * 目的有两个：
 *   ① 让**第一次打开面板**立刻有数据（否则要等一次 40~60 秒的后台全量扫描）；
 *   ② 让「统计里不含任何对话文本」这条红线**能在真产物上被验证**，而不是只在单测里。
 *
 * 它不推任何仓、不调模型、不改任何插件目录。
 *
 * 用法：node dev/warm-cache.mjs [--schemas=<tool-schemas.json>]
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCatalog } from "../lib/catalog.mjs";
import { buildToolIndex } from "../lib/attrib.mjs";
import { computeStats, statsFile } from "../lib/stats.mjs";
import { readOfficialToolPackages } from "../lib/catalog.mjs";
import { listPluginPackages } from "../lib/catalog.mjs";
import { dataDir as dataDirOf, dshHome } from "../lib/hostinfo.js";
import { loadSettings } from "../lib/settings.mjs";
import { readJson } from "../lib/store.mjs";

const arg = process.argv.find((value) => value.startsWith("--schemas="));
/* env 优先（host_selfcheck 的 args 转发布稳，env 一定到得了） */
const schemaPath = process.env.DSH_CATALOG_SCHEMAS || (arg ? arg.slice("--schemas=".length) : "");

const dataDir = dataDirOf();
const settings = await loadSettings(dataDir);
const sessionsRoot = join(dshHome(), "sessions");
console.log("dataDir:", dataDir);
console.log("sessionsRoot:", sessionsRoot);

/* ① 目录快照 */
const catalogStarted = Date.now();
const catalog = await buildCatalog({ dataDir, settings, force: true });
console.log("catalog:", JSON.stringify(catalog.counts), "耗时", Date.now() - catalogStarted, "ms");
console.log("  bySource:", JSON.stringify(catalog.counts.bySource));

/* ② 90 天统计 */
const statsStarted = Date.now();
const stats = await computeStats({ sessionsRoot, dataDir, windowDays: settings.windowDays });
console.log(
	"stats:",
	stats.ok ? `会话 ${stats.meta.sessions} / 调用 ${stats.meta.calls} / 去重 ${stats.meta.duplicateCalls}` : "FAILED " + stats.error,
	"耗时",
	Date.now() - statsStarted,
	"ms",
);

/* ③ 归属索引（有真实工具清单就用真清单） */
let tools = [];
if (schemaPath) {
	const raw = JSON.parse(readFileSync(schemaPath, "utf8"));
	tools = (Array.isArray(raw) ? raw : raw?.tools || raw?.data?.tools || []).map((tool) => ({ name: tool.name, description: tool.description }));
}
if (tools.length > 0) {
	const { packages } = await listPluginPackages(settings);
	const packagesForIndex = packages.map((pack) => ({ pkg: pack.pkg, root: pack.realDir }));
	for (const pack of await readOfficialToolPackages()) packagesForIndex.push(pack);
	const index = await buildToolIndex({ dataDir, tools, packages: packagesForIndex, overrides: {}, force: true });
	console.log("attrib:", JSON.stringify(index.stats));
} else {
	console.log("attrib: 跳过（没给 --schemas，宿主起来后会自己建）");
}

/* ④ 红线自检：统计缓存里不许出现对话正文 */
const cache = await readJson(statsFile(dataDir), null);
const text = JSON.stringify(cache);
const forbidden = ["\"content\"", "assistant/message", "user/message", "\"text\":\"", "system/message"];
const hits = forbidden.filter((needle) => text.includes(needle));
const partCount = cache ? Object.keys(cache.files || {}).length : 0;
const bytes = Buffer.byteLength(text, "utf8");
console.log("");
console.log("=== 统计缓存红线自检 ===");
console.log("  文件:", statsFile(dataDir));
console.log("  会话数:", partCount, " 体积:", (bytes / 1024).toFixed(0) + " KB");
console.log("  禁止出现的字段:", forbidden.join(" / "));
console.log("  命中:", hits.length === 0 ? "0（干净）" : hits.join(", "));
if (hits.length > 0) process.exit(1);
console.log("");
console.log("预热完成：面板第一次打开就能直接显示（无需等后台扫描）。");
