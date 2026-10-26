/**
 * probe-retention.mjs — R34 那一组「留存与判据」的独立探针。
 *
 * 三块**错了不会报错、只会安静骗人**的判据：
 *
 * ① `lib/freshness.mjs`：目录快照旧在哪 —— 「事实变了」（loadState 可能已经错）与
 *    「只是旧了」（结论仍然有效）必须分开。混成一句，就会像 2026-10-26 22:1x 那样：
 *    `dsh-screenshot` 已经加回 bundles，面板还说「不会被加载」。
 * ② `lib/review.mjs` 的 `reportOutcome`：一次全量跑**成功了几条**。旧口径只要跑完就写
 *    `lastGapAt`，于是本机 2026-10-21 那次 **12/12 全失败**在 health 里和成功一模一样，
 *    还白等 7 天才重试。
 * ③ `lib/reports.mjs`：`reports/` 的保留策略 —— 只动自己那五种前缀、md/json 同组、
 *    留最新 N 组。判错就是**删别人的文件**或**删掉正在用的那份 json**。
 *
 * 用法：`node dev/probe-retention.mjs [--json]`；破任一不变式退出码 1。
 * 全程**不碰磁盘**（纯函数 + 合成名字/数字）。
 */

import { DEFAULT_TTL_MS, FACT_TOLERANCE_MS, staleOf } from "../lib/freshness.mjs";
import { reportOutcome, summarizeReport } from "../lib/review.mjs";
import { planReportPrune, REPORT_KEEP, reportPrefixOf } from "../lib/reports.mjs";

const results = [];
function ok(name, condition, detail = "") {
	results.push({ name, pass: Boolean(condition), detail });
}

const AT = 1760000000000;

/* ─────────── ① 陈旧判据（freshness） ─────────── */

/* F1：事实变了 —— profile 比快照新 ⇒ factStale，理由写着 profile */
{
	const info = staleOf({ builtAt: AT, ageMs: 60 * 1000, ttlMs: DEFAULT_TTL_MS, profileTouchedAt: AT + 60 * 60 * 1000 });
	ok("F1 profile 比快照新 → factStale（结论可能已经错）", info.factStale === true && info.ageStale === false && info.stale === true && info.reason === "profile", JSON.stringify(info));
}

/* F2：只是旧了 —— 年龄超 TTL 但 profile 没动过 ⇒ ageStale、reason=age（不值得重建） */
{
	const info = staleOf({ builtAt: AT, ageMs: DEFAULT_TTL_MS + 1, ttlMs: DEFAULT_TTL_MS, profileTouchedAt: AT - 5000 });
	ok("F2 只有年龄过期 → ageStale、reason=age（事实没变，不该自动重建）", info.ageStale === true && info.factStale === false && info.reason === "age", JSON.stringify(info));
}

/* F3：1 秒容差 —— 同一次操作里 profile 比 builtAt 晚几百毫秒，不算"之后又改了" */
{
	const same = staleOf({ builtAt: AT, ageMs: 1000, profileTouchedAt: AT + FACT_TOLERANCE_MS });
	const after = staleOf({ builtAt: AT, ageMs: 1000, profileTouchedAt: AT + FACT_TOLERANCE_MS + 1 });
	ok("F3 容差 1 秒：同一次操作不算事实变化，晚 1 秒才算", same.factStale === false && after.factStale === true, JSON.stringify({ same: same.factStale, after: after.factStale }));
}

/* F4：新且没变 ⇒ 不旧（reason 空串，别硬塞一句"旧"） */
{
	const info = staleOf({ builtAt: AT, ageMs: 1000, ttlMs: DEFAULT_TTL_MS, profileTouchedAt: AT });
	ok("F4 又快又没变 → 不旧（reason 为空串）", info.stale === false && info.reason === "", JSON.stringify(info));
}

/* F5：从没建过（builtAt=0）⇒ 过期，但**不**判事实变化（没有"比它新"这回事） */
{
	const info = staleOf({ builtAt: 0, ageMs: null, profileTouchedAt: AT });
	ok("F5 还没建过快照 → 过期，但不误判成 profile 改了", info.ageStale === true && info.factStale === false && info.reason === "age", JSON.stringify(info));
}

/* F6：ageMs 缺失（旧服务端 / 刚从磁盘读出来还没算）按 null 处理，不抛、不 Infinity */
{
	const info = staleOf({ builtAt: AT, ageMs: undefined, profileTouchedAt: AT });
	ok("F6 ageMs 缺失 → null + 不旧（不抛、不 Infinity）", info.ageMs === null && info.stale === false, JSON.stringify(info));
}

/* ─────────── ② 每周任务「到底成了几条」（reportOutcome） ─────────── */

/* W1：12/12 全失败（本机 2026-10-21 的真实形状）⇒ allFailed，不能当成跑过了 */
{
	const report = { ranAt: AT, repos: 2, results: [{ name: "a", ok: false, error: "x" }, { name: "b", ok: false, error: "y" }] };
	const outcome = reportOutcome(report);
	ok("W1 全部失败 → allFailed（真实形状：本机那次 12/12 全红）", outcome.allFailed === true && outcome.ok === 0 && outcome.failed === 2, JSON.stringify(outcome));
}

/* W2：部分成功 ⇒ 不算全失败（有产出，正常推后一周） */
{
	const outcome = reportOutcome({ results: [{ ok: true }, { ok: false }] });
	ok("W2 部分成功 → 不算全失败", outcome.allFailed === false && outcome.ok === 1 && outcome.failed === 1, JSON.stringify(outcome));
}

/* W3：一条都没跑（0 仓）**不是**全失败 —— 那是"没跑过"，不是"跑了全红" */
{
	const outcome = reportOutcome({ results: [] });
	const nullOutcome = reportOutcome(null);
	ok("W3 0 个仓 / null 报告 → 不判全失败", outcome.allFailed === false && outcome.repos === 0 && nullOutcome.allFailed === false, JSON.stringify({ empty: outcome, none: nullOutcome }));
}

/* W4：summarizeReport 把 ok / failed / allFailed 带出去（health 与面板都读这一个） */
{
	const summary = summarizeReport({ ranAt: AT, repos: 2, results: [{ ok: true, findings: [{ severity: "high" }] }, { ok: false, findings: [] }] });
	const empty = summarizeReport(null);
	ok("W4 summarizeReport 带 ok/failed/allFailed（0 仓时是 0/0 而不是全失败）", summary.ok === 1 && summary.failed === 1 && summary.allFailed === false && summary.high === 1 && empty.allFailed === false && empty.ok === 0, JSON.stringify({ summary, empty }));
}

/* ─────────── ③ reports/ 保留策略（planReportPrune） ─────────── */

/* R1：前缀识别 —— `uninstall-verify-…` 与 `catalog-filtered-…` 都必须先归到它自己那一组（长的在前） */
{
	ok(
		"R1 前缀识别：uninstall-verify 不被吞进 uninstall、catalog-filtered 不被吞进 catalog",
		reportPrefixOf("uninstall-verify-20261026-0102.md") === "uninstall-verify" &&
			reportPrefixOf("uninstall-20261026-0102.json") === "uninstall" &&
			reportPrefixOf("catalog-filtered-20261026-0231.md") === "catalog-filtered" &&
			reportPrefixOf("catalog-20261026-0109.md") === "catalog" &&
			reportPrefixOf("handoff-x.md") === "handoff",
		[reportPrefixOf("uninstall-verify-20261026-0102.md"), reportPrefixOf("catalog-filtered-20261026-0231.md"), reportPrefixOf("catalog-20261026-0109.md")].join(" / "),
	);
}

/* R2：**不认识的别动** —— 用户用 path: 导出的、别人的文件，一个都不许出现在 drop 里 */
{
	const plan = planReportPrune(["my-notes.md", "catalog-20260101-0000.md", "invoices/x.json", "random.txt"]);
	ok("R2 不认识的名字一律不碰（只在 keep 之外一律不动）", plan.drop.length === 0 && plan.keep.length === 1, JSON.stringify(plan));
}

/* R3：md + json 同一时间戳**当一组** —— 不能只删 json 留下 md（对账要用 json） */
{
	const plan = planReportPrune(["uninstall-20260101-0000.md", "uninstall-20260101-0000.json", "uninstall-20260202-0000.md", "uninstall-20260202-0000.json"], { keep: { uninstall: 1 } });
	ok(
		"R3 同时间戳的 md/json 归一组：留最新一组、整组一起走",
		JSON.stringify(plan.keep.sort()) === JSON.stringify(["uninstall-20260202-0000.json", "uninstall-20260202-0000.md"]) && JSON.stringify(plan.drop.sort()) === JSON.stringify(["uninstall-20260101-0000.json", "uninstall-20260101-0000.md"]),
		JSON.stringify(plan),
	);
}

/* R4：每组按文件名倒序（时间戳在尾部 ⇒ 字典序即时间序），留最新 N 组 */
{
	const names = ["catalog-20260101-0000.md", "catalog-20260103-0000.md", "catalog-20260102-0000.md", "catalog-20260104-0000.md"];
	const plan = planReportPrune(names, { keep: { catalog: 2 } });
	ok("R4 留最新 2 组（不是最大的两个字符串）", JSON.stringify(plan.keep.sort()) === JSON.stringify(["catalog-20260103-0000.md", "catalog-20260104-0000.md"]) && plan.drop.length === 2, JSON.stringify(plan));
}

/* R5：各组独立计数（留着 catalog 的旧份，不该把 handoff 的也带走） */
{
	const plan = planReportPrune(["catalog-20260101-0000.md", "catalog-20260102-0000.md", "handoff-20260101010101.md"], { keep: { catalog: 1, handoff: 5 } });
	const byPrefix = Object.fromEntries(plan.groups.map((row) => [row.prefix, row]));
	ok("R5 每组独立计数（catalog 留 1、handoff 留满）", byPrefix.catalog.dropped === 1 && byPrefix.catalog.kept === 1 && byPrefix.handoff.dropped === 0 && byPrefix.handoff.kept === 1, JSON.stringify(byPrefix));
}

/* R6：默认表就是那几种前缀，且都是正整数（别写成 0 = 全删）；catalog-filtered 必须单列 ——
   它以 `catalog-` 开头，混进 catalog 组会挤掉真正的目录快照（R34 hosttest 抓到的真事） */
{
	const values = Object.values(REPORT_KEEP);
	ok(
		"R6 默认保留表：五种前缀、都是正整数，catalog-filtered 单列",
		Object.keys(REPORT_KEEP).length === 5 && values.every((value) => Number.isInteger(value) && value > 0) && Object.hasOwn(REPORT_KEEP, "catalog-filtered") && Object.hasOwn(REPORT_KEEP, "catalog"),
		JSON.stringify(REPORT_KEEP),
	);
}

/* R6b：catalog-filtered 与 catalog 各占一组 —— 两批文件互不挤占名额 */
{
	const names = ["catalog-20260101-0000.md", "catalog-20260102-0000.md", "catalog-filtered-20260101-0000.md", "catalog-filtered-20260102-0000.md"];
	const plan = planReportPrune(names, { keep: { catalog: 1, "catalog-filtered": 1 } });
	ok(
		"R6b catalog-filtered 独立成组：清的只是自己那组，目录快照不受影响",
		JSON.stringify(plan.keep.sort()) === JSON.stringify(["catalog-20260102-0000.md", "catalog-filtered-20260102-0000.md"]) && plan.drop.length === 2,
		JSON.stringify(plan),
	);
}

/* R7：空目录 / 非字符串输入不抛（启动路径第一次 tidy 时目录可能还不存在） */
{
	const plan = planReportPrune([null, 42, "", "catalog-20260101-0000.md"]);
	ok("R7 空/脏输入不抛，只处理合法名字", plan.keep.length === 1 && plan.drop.length === 0, JSON.stringify(plan));
}

/* R8：keep=0 时整组全清（语义保留，但不用于默认表；防止"配 0 还以为在留"） */
{
	const plan = planReportPrune(["handoff-a.md", "handoff-b.md"], { keep: { handoff: 0 } });
	ok("R8 keep=0 → 整组全清（显式语义）", plan.keep.length === 0 && plan.drop.length === 2, JSON.stringify(plan));
}

const failed = results.filter((item) => !item.pass);
if (process.argv.includes("--json")) {
	console.log(JSON.stringify({ passed: results.length - failed.length, failed: failed.length, results }, null, 1));
} else {
	for (const item of results) console.log(`${item.pass ? "  ok" : "  FAIL"}  ${item.name}${item.pass || !item.detail ? "" : "  [" + item.detail + "]"}`);
	console.log(`\nprobe-retention: passed ${results.length - failed.length} / failed ${failed.length}`);
}
if (failed.length > 0) process.exit(1);
