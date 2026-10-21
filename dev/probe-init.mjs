/**
 * dev/probe-init.mjs — 量**启动路径**的成本（只读，用真实数据目录）。
 *
 * 为什么单独量：`apply()` 是宿主启动时同步执行的，init 里多花 1 秒
 * 就是 DSH 启动多 1 秒。这里把它拆成几段，确认没有"顺手把 20MB 源码读一遍"这种事。
 *
 * 用法：DSH_RESOURCES_DIR=… node dev/probe-init.mjs
 */

import { CatalogService } from "../lib/service.mjs";
import { dataDir as dataDirOf } from "../lib/hostinfo.js";

const dataDir = dataDirOf();
console.log("dataDir:", dataDir);

/* 假 ctx：只要够 init 用（init 不碰 llm/webServer） */
const ctx = { get: () => null };

const t0 = Date.now();
const service = new CatalogService({ ctx, toolSchemas: () => [] });
const t1 = Date.now();
await service.init();
const t2 = Date.now();

console.log("");
console.log("构造:", t1 - t0, "ms");
console.log("init:", t2 - t1, "ms");
console.log("── init 之后的状态 ──");
console.log("  目录快照:", service.catalog ? `${service.catalog.plugins.length} 插件 / ${service.catalog.skills.length} Skill（age ${Math.round((service.catalogAgeMs || 0) / 1000)}s, stale=${Boolean(service.catalogStale)}）` : "（无缓存，等后台建）");
console.log("  统计缓存:", service.aggregate ? `${service.aggregate.totals.sessions} 会话 / ${service.aggregate.totals.calls} 调用` : "（无缓存，等后台算）");
console.log("  归属索引:", service.attrib && service.attrib.index ? `${Object.keys(service.attrib.index).length} 个工具已归属` : "（无缓存）");
console.log("  标签:", service.tags ? `${service.tags.custom.length} 个自定义` : "-");

const stateStart = Date.now();
const state = await service.state();
const stateMs = Date.now() - stateStart;
console.log("");
console.log("state() 组装:", stateMs, "ms（条目", state.entries.length, "个；宿主核心工具", state.hostCore.tools.length, "个）");
console.log("  四分类:", JSON.stringify(state.totals.bySource));
console.log("  归属统计:", JSON.stringify(state.attribution));

/* 一次详情查询（浮窗打开时的成本） */
const busiest = state.entries.slice().sort((a, b) => (b.calls || 0) - (a.calls || 0))[0];
if (busiest) {
	const detailStart = Date.now();
	const detail = service.entryDetail(busiest.id, { page: 1, pageSize: 20 });
	const detailMs = Date.now() - detailStart;
	console.log("");
	console.log("entryDetail(" + busiest.name + "):", detailMs, "ms｜工具", (detail.tools || []).length, "个｜会话", detail.sessions.total, "个（第", detail.sessions.page, "/", detail.sessions.pages, "页）");
	console.log("  前 3 个工具:", (detail.tools || []).slice(0, 3).map((tool) => tool.name + "×" + tool.calls).join(", "));
	const subagentSessions = (detail.sessions.items || []).filter((session) => session.isSubagent).length;
	console.log("  本页子代理会话:", subagentSessions, "个");
}

if (stateMs > 1500) {
	console.log("");
	console.log("⚠️ state() 超过 1.5 秒，值得查一下（通常是缓存没命中）");
	process.exit(1);
}
