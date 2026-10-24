/**
 * probe-handoff.mjs — 交接单的独立探针（R26）。
 *
 * `lib/handoff.mjs` 只做判断与排版，错法全是「看起来正常」的：版本一致漏判、
 * ship 失败被忽略、脏工作区被当成可交接、下一步少写一条。静态契约看不出来，
 * 只能在合成数据上逐项跑一遍。
 *
 * 用法：`node dev/probe-handoff.mjs [--json]`；破任一不变式退出码 1。全程不碰磁盘。
 */

import { buildHandoff, HANDOFF_VERSION, renderHandoff } from "../lib/handoff.mjs";

const results = [];
function ok(name, condition, detail = "") {
	results.push({ name, pass: Boolean(condition), detail });
}

const NOW = 1761400000000;
const GOOD = {
	now: NOW,
	build: { version: "0.26.0", at: NOW, stale: false, newestFile: "lib/handoff.mjs" },
	loaded: { version: "0.26.0", at: NOW },
	tools: 12,
	composition: { line: "配置层：2 条", verdict: "ok", counts: { effective: 2 } },
	changes: { baselineAt: NOW - 1000, counts: { total: 2, composition: 0 } },
	ack: { at: NOW - 500, entries: 10 },
	timeline: { total: 3 },
	drift: { count: 0 },
	ship: { path: "D:\\x\\.cache\\ship-20261025.md", at: NOW, passed: 1200, failed: 0 },
	git: { head: "abcdef1", branch: "main", dirty: 0, ahead: 0, behind: 0 },
	report: { path: "D:\\x\\reports\\catalog-20261025.md", at: NOW },
};

/* ── 1. 全部对齐 → ok，九项都在，没有「下一步」 ── */
{
	const report = buildHandoff(GOOD);
	ok("H1 全部对齐 → verdict=ok、9 项核对、没有下一步", report.verdict === "ok" && report.checks.length === 9 && report.next.length === 0 && report.counts.bad === 0, JSON.stringify({ verdict: report.verdict, checks: report.checks.length, next: report.next }));
	ok("H1b 带版本号与表格的 Markdown", report.version === HANDOFF_VERSION && report.markdown.includes("# 交接单") && report.markdown.includes("| 项 | 状态 | 说明 |") && report.markdown.includes("可以直接换会话"), report.markdown.split("\n").slice(0, 3).join(" | "));
}

/* ── 2. 磁盘 vs 运行中不一致 → bad + 明确说重启（set_plugin 不重新 import） ── */
{
	const report = buildHandoff({ ...GOOD, loaded: { version: "0.25.0", at: NOW - 1000 } });
	const check = report.checks.find((item) => item.id === "version");
	ok("H2 版本戳不一致 → bad，并写「重启 DSH」而不是只说 stale", report.verdict === "bad" && check.status === "bad" && check.detail.includes("重启 DSH") && report.next.some((item) => item.includes("重启 DSH")), check.detail);
}

/* ── 3. 最新 ship 有失败 → bad；没跑过 → warn ── */
{
	const failed = buildHandoff({ ...GOOD, ship: { ...GOOD.ship, failed: 2 } });
	const missing = buildHandoff({ ...GOOD, ship: null });
	ok("H3 ship 失败 → bad；没跑过 → warn + 下一步", failed.verdict === "bad" && failed.checks.find((item) => item.id === "ship").status === "bad" && missing.verdict === "warn" && missing.next.some((item) => item.includes("dev/ship.mjs")), JSON.stringify({ failed: failed.verdict, missing: missing.verdict }));
}

/* ── 4. 脏工作区 / 未推送 → warn + 提交提醒 ── */
{
	const dirty = buildHandoff({ ...GOOD, git: { ...GOOD.git, dirty: 3 } });
	const ahead = buildHandoff({ ...GOOD, git: { ...GOOD.git, ahead: 2 } });
	ok("H4 脏 3 个 / 未推送 2 个 → warn，并提醒提交推送", dirty.verdict === "warn" && dirty.checks.find((item) => item.id === "git").detail.includes("脏 3") && dirty.next.some((item) => item.includes("git-commit")) && ahead.verdict === "warn", JSON.stringify({ dirty: dirty.checks.find((item) => item.id === "git")?.detail }));
}

/* ── 5. Skill staging 旧 → warn + 同步命令 ── */
{
	const report = buildHandoff({ ...GOOD, drift: { count: 2 } });
	ok("H5 staging 旧 2 个 → warn，并给 catalog_skill_sync", report.verdict === "warn" && report.next.some((item) => item.includes("catalog_skill_sync")), JSON.stringify(report.next));
}

/* ── 6. 配置层 bad → bad；变化里有配置层 → warn（提示别漏看） ── */
{
	const compBad = buildHandoff({ ...GOOD, composition: { line: "bundles 缺 1", verdict: "bad" } });
	const changed = buildHandoff({ ...GOOD, changes: { ...GOOD.changes, counts: { total: 1, composition: 1 } } });
	ok("H6 配置层 bad → bad；有配置层变化 → warn", compBad.verdict === "bad" && changed.verdict === "warn" && changed.checks.find((item) => item.id === "changes").status === "warn", JSON.stringify({ comp: compBad.verdict, changed: changed.verdict }));
}

/* ── 7. 没有报告 / 历史只有基线 → warn 并给下一步 ── */
{
	const report = buildHandoff({ ...GOOD, report: null, timeline: { total: 1 } });
	ok("H7 没报告 / 只有基线 → warn，并给 catalog_export", report.verdict === "warn" && report.next.some((item) => item.includes("catalog_export")), JSON.stringify(report.next));
}

/* ── 8. 空输入不炸（旧宿主 / 数据没准备好） ── */
{
	const report = buildHandoff({});
	ok("H8 空输入不抛（verdict=warn，九项仍齐全）", report.verdict === "warn" && report.checks.length === 9 && typeof renderHandoff(report) === "string", JSON.stringify({ verdict: report.verdict }));
}

const failed = results.filter((item) => !item.pass);
if (process.argv.includes("--json")) {
	console.log(JSON.stringify({ passed: results.length - failed.length, failed: failed.length, results }, null, 1));
} else {
	for (const item of results) console.log(`${item.pass ? "  ok" : "  FAIL"}  ${item.name}${item.pass || !item.detail ? "" : "  [" + item.detail + "]"}`);
	console.log(`\nprobe-handoff: passed ${results.length - failed.length} / failed ${failed.length}`);
}
if (failed.length > 0) process.exit(1);
