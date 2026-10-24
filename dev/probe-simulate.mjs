/**
 * probe-simulate.mjs — 删除预演的独立探针（R16）。
 *
 * 为什么单独一个探针：`simulateRemoval` 全是**写反了也不会报错**的判断 ——
 * 「谁会被加载」「哪个入口删完指空」「谁还声明着它」「谁会掉回 dormant」。
 * 这些错了以后，面板照样出结果，只是把一次**有风险**的删除报成"安全"，
 * 或者反过来把安全的删成"有风险"，让人不敢动手。静态契约看不出来，只能喂图跑。
 *
 * 用法：`node dev/probe-simulate.mjs [--json]`；破任一不变式退出码 1。
 * 全程**不碰磁盘**：依赖图是内存里的合成图，不读也不写 node_modules。
 */

import { simulateRemoval } from "../lib/uninstall.mjs";

const results = [];
function ok(name, condition, detail = "") {
	results.push({ name, pass: Boolean(condition), detail });
}

/* 合成图：
       dsh-a（bundles 入口）→ lib-x
       dsh-b（配置条目）    → lib-y → lib-z
       dsh-dormant          → lib-d          ← 没有任何入口引用它俩
   于是：dsh-a=bundle / lib-x=transitive / dsh-b=config / lib-y、lib-z=transitive / dsh-dormant、lib-d=dormant */
function makeGraph() {
	return new Map([
		["dsh-a", ["lib-x"]],
		["lib-x", []],
		["dsh-b", ["lib-y"]],
		["lib-y", ["lib-z"]],
		["lib-z", []],
		["dsh-dormant", ["lib-d"]],
		["lib-d", []],
	]);
}
const BUNDLES = ["dsh-a"];
const COMPOSITIONS = [{ id: "b", name: "dsh-b", disabled: false }];

function sim(remove, extra = {}) {
	return simulateRemoval({ installed: makeGraph(), bundles: BUNDLES, compositions: COMPOSITIONS, remove, ...extra });
}

/* ── S1 空删除：前态与后态必须逐包一致（这是"没有副作用"的定义） ── */
{
	const result = sim([]);
	const names = [...makeGraph().keys()];
	const drift = names.filter((name) => JSON.stringify(result.before.counts) !== JSON.stringify(result.after.counts));
	ok("S1 空删除不改变任何加载态", drift.length === 0 && result.remove.length === 0 && result.verdict === "safe", JSON.stringify(result.after.counts));
}

/* ── S2 删真正的 dormant：安全，且不该出现「现在会被加载」 ── */
{
	const result = sim(["dsh-dormant", "lib-d"]);
	ok("S2 删 dormant 判安全（breaking / brokenEntries / dangling 全空）", result.verdict === "safe" && result.breaking.length === 0 && result.brokenEntries.length === 0 && result.dangling.length === 0, JSON.stringify({ breaking: result.breaking.length, dangling: result.dangling.length }));
}

/* ── S3 删一个 transitive：它在被点亮，必须进 breaking（不该删） ── */
{
	const result = sim(["lib-z"]);
	const hit = result.breaking.find((item) => item.name === "lib-z");
	ok("S3 删 transitive 会被点名（state=transitive，verdict=risky）", Boolean(hit) && hit.state === "transitive" && result.verdict === "risky", JSON.stringify(result.breaking));
}

/* ── S4 删 bundles 里的包：入口会指空 ── */
{
	const result = sim(["dsh-a"]);
	const hit = result.brokenEntries.find((item) => item.name === "dsh-a");
	ok("S4 删 bundles 入口会报「入口指空」（why=bundle）", Boolean(hit) && hit.why === "bundle" && result.verdict === "risky", JSON.stringify(result.brokenEntries));
}

/* ── S5 删配置条目挂的包：同样指空，但 why=config ── */
{
	const result = sim(["dsh-b"]);
	const hit = result.brokenEntries.find((item) => item.name === "dsh-b");
	ok("S5 删配置入口会报「入口指空」（why=config）", Boolean(hit) && hit.why === "config" && hit.id === "b", JSON.stringify(result.brokenEntries));
}

/* ── S6 保留的包还声明着被删包：必须在 dangling 里（否则启动后 require 直接失败） ── */
{
	const result = sim(["lib-x"]);
	const hit = result.dangling.find((item) => item.from === "dsh-a" && item.dep === "lib-x");
	ok("S6 留下的包声明被删包 → dangling", Boolean(hit) && result.verdict === "risky", JSON.stringify(result.dangling));
}

/* ── S7 只因被删包才被点亮的下游：删完会掉回 dormant ── */
{
	const result = sim(["dsh-a"]);
	const hit = result.demoted.find((item) => item.name === "lib-x");
	ok("S7 下游会从 transitive 掉回 dormant", Boolean(hit) && hit.state === "transitive" && result.after.counts.dormant > result.before.counts.dormant, JSON.stringify(result.demoted));
}

/* ── S8 摘边不可能凭空点亮谁（revived 恒空）——这是判据的单调性 ── */
{
	const cases = [[], ["lib-x"], ["dsh-a"], ["dsh-a", "dsh-b", "lib-y", "lib-z"], ["dsh-dormant"]];
	const bad = cases.map((remove) => sim(remove)).filter((result) => result.revived.length > 0);
	ok(`S8 任何删除都不会「点亮」新包（${cases.length} 组）`, bad.length === 0, bad.map((item) => JSON.stringify(item.revived)).join(" "));
}

/* ── S9 不在已装清单里的名字：进 unknown，不改变结论 ── */
{
	const result = sim(["definitely-not-installed"]);
	ok("S9 未知包进 unknown 且不污染结论", result.unknown.length === 1 && result.remove.length === 0 && result.verdict === "safe", JSON.stringify(result.unknown));
}

/* ── S10 名单会去重、会忽略空白项（否则同一行数字会重复计） ── */
{
	const result = sim(["lib-x", " lib-x ", "", "  ", null, undefined]);
	ok("S10 名单去重并忽略空白项", result.remove.length === 1 && result.remove[0] === "lib-x", JSON.stringify(result.remove));
}

/* ── S11 删掉的包不再出现在后态里（否则「删完还剩几个」会算错） ── */
{
	const result = sim(["lib-x", "lib-z"]);
	const totalAfter = result.after.total;
	const totalBefore = result.before.total;
	ok("S11 包数守恒：后态 = 前态 − 实际摘掉的数量", totalAfter === totalBefore - result.remove.length, `${totalBefore} - ${result.remove.length} vs ${totalAfter}`);
}

/* ── S12 前后态都覆盖「bundle / config / transitive / dormant」四态且总数对得上 ── */
{
	const result = sim(["dsh-dormant", "lib-d"]);
	const keys = ["bundle", "config", "transitive", "dormant"];
	const complete = keys.every((key) => Number.isInteger(result.before.counts[key]) && Number.isInteger(result.after.counts[key]));
	const sumOk = keys.reduce((sum, key) => sum + result.after.counts[key], 0) === result.after.total && result.after.total === 5;
	ok("S12 四态完整且删完剩 5 个包", complete && sumOk, JSON.stringify(result.after));
}

/* ── S13/S14 同一个包名两份目录（同项目第二份 / 别名目录）：只删一份不该算"删了这个包" ──
   ★ 这是本机真实存在的情况（`ghbackup` 目录与 `dsh-github-backup` 是同一个包名）。
     按包名整体算会把**正在被加载**的那一份也摘掉，于是把一次安全的清理报成"有风险"。 */
function simDuplicate(remove) {
	const installed = new Map([...makeGraph(), ["dup-pkg", []]]);
	const dirs = [
		{ dirName: "dup-pkg", pkg: "dup-pkg" },
		{ dirName: "ghbackup", pkg: "dup-pkg" },
		...[...makeGraph().keys()].map((name) => ({ dirName: name, pkg: name })),
	];
	return simulateRemoval({ installed, dirs, bundles: ["dsh-a", "dup-pkg"], compositions: COMPOSITIONS, remove });
}
{
	const one = simDuplicate(["ghbackup"]);
	ok(
		"S13 只删重复目录里的一份：包名仍有一份在盘上，不算摘掉（判安全、remove 为空）",
		one.remove.length === 0 && one.removedDirs.length === 1 && one.verdict === "safe" && one.breaking.length === 0,
		JSON.stringify({ remove: one.remove, dirs: one.removedDirs, verdict: one.verdict }),
	);
}
{
	const both = simDuplicate(["ghbackup", "dup-pkg"]);
	ok(
		"S14 两份目录都删：包才真的被摘掉，入口指空与「会被加载」都要点出来",
		both.remove.length === 1 && both.remove[0] === "dup-pkg" && both.verdict === "risky" && both.breaking.some((item) => item.name === "dup-pkg") && both.brokenEntries.some((item) => item.name === "dup-pkg"),
		JSON.stringify({ remove: both.remove, verdict: both.verdict, breaking: both.breaking.length }),
	);
}

const failed = results.filter((item) => !item.pass);
if (process.argv.includes("--json")) {
	console.log(JSON.stringify({ passed: results.length - failed.length, failed: failed.length, results }, null, 1));
} else {
	for (const item of results) console.log(`${item.pass ? "  ok" : "  FAIL"}  ${item.name}${item.pass || !item.detail ? "" : "  [" + item.detail + "]"}`);
	console.log(`\nprobe-simulate: passed ${results.length - failed.length} / failed ${failed.length}`);
}
if (failed.length > 0) process.exit(1);
