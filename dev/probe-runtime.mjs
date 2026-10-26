/**
 * probe-runtime.mjs — 运行期真相层的独立探针（R35）。
 *
 * 为什么值得单独钉：这一层是**对账**，错的方向有两种，都很安静：
 *   · 把"读不到运行期"当成"没有失败" → 真故障被盖住（比误报更贵）；
 *   · 把 `moduleName` 带子路径（`pkg/sub`）当成另一个包 → 每条都判「Loader 里没有」，
 *     面板上一片警告，用户很快就不看了。
 * 所以这里不读宿主、不读磁盘，只用合成 `listPlugins()` 结果把判据钉死。
 *
 * 用法：`node dev/probe-runtime.mjs [--json]`；破任一不变式退出码 1。
 */

import { FIBER_PHASES, RUNTIME_STATES, RUNTIME_VERSION, indexRuntime, mergeRuntime, normalizeRuntimeRow, runtimeIssues, runtimeLabel, runtimeOf, runtimeTitle, summarizeRuntime } from "../lib/runtime.mjs";

const results = [];
function ok(name, condition, detail = "") {
	results.push({ name, pass: Boolean(condition), detail });
}

/* 一份合成的 Loader 列表：覆盖六种相位 + 子路径 + 别名 */
const LIST = [
	{ entryId: "e-active", moduleName: "dsh-active", enabled: true, fiberPhase: "active", patchId: "p1" },
	{ entryId: "e-failed", moduleName: "dsh-failed", enabled: true, fiberPhase: "failed", patchId: "p2" },
	{ entryId: "e-pending", moduleName: "dsh-pending", enabled: true, fiberPhase: "pending" },
	{ entryId: "e-loading", moduleName: "dsh-loading", enabled: true, fiberPhase: "loading" },
	{ entryId: "e-off", moduleName: "dsh-off", enabled: false, fiberPhase: null },
	{ entryId: "e-sub", moduleName: "@scope/pkg/sub", enabled: true, fiberPhase: "active", patchId: "p3" },
	{ entryId: "e-sub2", moduleName: "@scope/pkg/other", enabled: true, fiberPhase: "failed", patchId: "p4" },
	{ entryId: "e-ro", moduleName: "dsh-ro", enabled: true, fiberPhase: "active", readOnlyReason: "unaddressable" },
];

const index = indexRuntime(LIST);
ok("R1 归一：六种相位原样保留，null 不被当成字符串", normalizeRuntimeRow({ moduleName: "x", fiberPhase: null }).phase === null && FIBER_PHASES.includes(null));
ok("R2 归一：moduleName 带子路径时按**包名**归档", index.byPackage.has("@scope/pkg") && normalizeRuntimeRow({ moduleName: "@scope/pkg/sub" }).packageName === "@scope/pkg");
ok("R3 同一个包多条条目：按「最能说明问题」的取（failed 优先于 active）", index.byPackage.get("@scope/pkg").phase === "failed", JSON.stringify(index.byPackage.get("@scope/pkg")));
ok("R4 计数守恒：total = 各行之和（8 条），disabled 与 nullPhase 分开数", index.counts.total === 8 && index.counts.failed === 2 && index.counts.disabled === 1, JSON.stringify(index.counts));
ok("R5 byEntry 能按 entryId 反查（停用动作要靠它）", index.byEntry.get("e-active").patchId === "p1");
ok("R6 只读条目带 readOnlyReason（managed=false），可管理的带 patchId", normalizeRuntimeRow(LIST[7]).readOnlyReason === "unaddressable" && normalizeRuntimeRow(LIST[0]).patchId === "p1");

/* ── 对账：声明层 × 运行期 ── */
const base = { kind: "plugin", name: "dsh-active", packageName: "dsh-active", loadState: "bundle", enabled: true };
ok("R7 active + 声明在 bundles：state=active、没有 issue（不占版面）", runtimeOf(base, index).state === "active" && runtimeOf(base, index).issue === "");
const failed = runtimeOf({ ...base, name: "dsh-failed", packageName: "dsh-failed" }, index);
ok("R8 fiberPhase=failed：state=failed，issue 点名 apply 抛错与回滚（这是本轮最想抓的一类）", failed.state === "failed" && failed.issue.includes("failed"));
const absent = runtimeOf({ ...base, name: "dsh-ghost", packageName: "dsh-ghost", loadState: "bundle" }, index);
ok("R9 声明在 bundles、Loader 里没有：state=declared-absent（启动时被 skip 的那一类）", absent.state === "declared-absent" && absent.detail.includes("Loader 里没有这一条"));
ok("R10 声明层本来就不加载（dormant）且 Loader 里没有：**不报**（那不是异常）", runtimeOf({ ...base, name: "dsh-ghost2", packageName: "dsh-ghost2", loadState: "dormant" }, index).state === "unknown");
const off = runtimeOf({ ...base, name: "dsh-off", packageName: "dsh-off", loadState: "dormant", enabled: false }, index);
ok("R11 enabled=false（合法停用）：state=disabled，不算问题", off.state === "disabled" && off.issue === "");
const mismatch = runtimeOf({ ...base, name: "dsh-off", packageName: "dsh-off", loadState: "bundle", enabled: true }, index);
ok("R12 声明会加载但 Loader 说 enabled=false：判不一致（issue 说出来）", mismatch.issue.includes("两边不一致"));
const noIndex = runtimeOf(base, null);
ok("R13 读不到运行期：state=unknown / available=false，**绝不猜成 active**", noIndex.state === "unknown" && noIndex.available === false);
const emptyIndex = runtimeOf(base, { byPackage: new Map() });
ok("R14 读成功但列表里没有它（空 map 也是有效结果）：判 declared-absent 是对的；只有 index=null 才判 unknown", emptyIndex.state === "declared-absent");

/* ── mergeRuntime：不修改入参、非插件原样 ── */
{
	const entries = [base, { kind: "skill", name: "s", id: "skill:s" }];
	const merged = mergeRuntime(entries, index);
	ok("R15 merge 补上运行期字段，非插件条目原样返回（同一引用）", merged[0].runtimeState === "active" && merged[1] === entries[1] && entries[0].runtimeState === undefined);
}

/* ── 文案：active 不占版面、其它各一句 ── */
ok("R16 chip 文案：active 且无问题 → 空串；failed / declared-absent 各有自己的词", runtimeLabel({ kind: "plugin", runtimeState: "active" }) === "" && runtimeLabel({ kind: "plugin", runtimeState: "failed" }) === "运行期失败" && runtimeLabel({ kind: "plugin", runtimeState: "declared-absent" }) === "不在 loader");
ok("R17 chip 悬停解释包含原因与事实（不只是把标签重复一遍）", runtimeTitle({ kind: "plugin", runtimeState: "failed", runtimeIssue: "fiberPhase=failed", runtimeDetail: "运行时：failed" }).includes("fiberPhase=failed"));
ok("R18 非插件条目不参与运行期（Skill / MCP 没有 fiber）", runtimeLabel({ kind: "skill", runtimeState: "active" }) === "" && runtimeOf({ kind: "mcp" }, index).available === false);

/* ── 三类问题（洞察条 / health / 工具 / 交接单同一份判据） ── */
{
	const entries = [
		{ kind: "plugin", name: "a", runtimeState: "failed" },
		{ kind: "plugin", name: "b", runtimeState: "declared-absent" },
		{ kind: "plugin", name: "c", runtimeState: "active", runtimeIssue: "声明与运行时不一致" },
		{ kind: "plugin", name: "d", runtimeState: "active" },
		{ kind: "skill", name: "e", runtimeState: "failed" },
	];
	const issues = runtimeIssues(entries);
	ok("R19 三类问题分开数：failed 1 / absent 1 / mismatch 1（Skill 上伪造的 failed 不算）", issues.failed.length === 1 && issues.absent.length === 1 && issues.mismatch.length === 1 && issues.total === 3);
	ok("R20 问题名单给的是名字（面板横幅要点名，不能只说「有 3 个」）", issues.names.failed[0] === "a" && issues.names.absent[0] === "b");
}

/* ── 摘要：读不到要如实说 ── */
ok("R21 摘要：available=false 时写「读不到」+ 原因，不写成 0 条", summarizeRuntime({ available: false, reason: "no pluginManager" }).includes("读不到") && summarizeRuntime({ available: false, reason: "no pluginManager" }).includes("no pluginManager"));
ok("R22 摘要：有 failed 时写 ⚠️ 与名字；全绿时写「没有发现失败或缺失」", summarizeRuntime({ available: true, counts: { total: 3, active: 2, failed: 1, pending: 0, disabled: 0 }, issues: { failed: 1, absent: 0, mismatch: 0, names: { failed: ["x"] } } }).includes("⚠️") && summarizeRuntime({ available: true, counts: { total: 3, active: 3, failed: 0, pending: 0, disabled: 0 }, issues: { failed: 0, absent: 0, mismatch: 0, names: {} } }).includes("没有发现失败或缺失"));
ok("R23 版本与状态表是冻结的（客户端/工具按它判断字段）", RUNTIME_VERSION >= 1 && RUNTIME_STATES.includes("declared-absent") && RUNTIME_STATES.includes("failed"));

/* ── R35.1：bundle 是「层」，不是「插件条目」（真机第一跑就撞上的 7 条假警报） ── */
{
	const bundleIndex = indexRuntime(
		[{ entryId: "e-tool", moduleName: "@deepseek-ai/dsh-tool-bash", enabled: true, fiberPhase: "active" }],
		{ bundles: [{ name: "@deepseek-ai/dsh-base", enabled: true, availability: "installation" }, { name: "@local/dsh-preset-616", enabled: true, availability: "profile" }, { name: "dsh-ghost-bundle", enabled: true, availability: "missing" }, { name: "dsh-broken-bundle", enabled: true, availability: "profile", error: { code: "incompatible-version" } }] },
	);
	ok("R24 bundle 层不在 Loader 里**不算缺失**（dsh-base 是 96 条 insert 的官方大层，自己不作为插件运行）", runtimeOf({ kind: "plugin", packageName: "@deepseek-ai/dsh-base", loadState: "bundle" }, bundleIndex).state === "unknown");
	ok("R25 普通插件在 bundles 里、Loader 里没有：仍然判 declared-absent（这一条才是真 skip）", runtimeOf({ kind: "plugin", packageName: "dsh-plain", loadState: "bundle" }, bundleIndex).state === "declared-absent");
	ok("R26 transitive 永远不判缺失（@dsh-ops/bash-win32-x64 是原生二进制，本来就不注册插件）", runtimeOf({ kind: "plugin", packageName: "@dsh-ops/bash-win32-x64", loadState: "transitive" }, bundleIndex).state === "unknown");
	ok("R27 bundle 的问题来自 listBundles()（missing / error 两类分开点名）", bundleIndex.bundles.problems.length === 2 && bundleIndex.bundles.problems.some((item) => item.kind === "missing") && bundleIndex.bundles.problems.some((item) => item.kind === "error"));
	ok("R28 有 bundle 层映射时 active + 声明 enabled=false 不再误判不一致（别名目录那种情况）", (() => {
		const ix = indexRuntime([{ entryId: "e", moduleName: "dsh-github-backup", enabled: true, fiberPhase: "active" }], { bundles: [{ name: "dsh-github-backup", enabled: true, availability: "profile" }] });
		return runtimeOf({ kind: "plugin", name: "ghbackup", packageName: "dsh-github-backup", loadState: "bundle", enabled: false }, ix).issue === "";
	})());
	ok("R29 摘要把 bundle 问题写进一句话（读 health 的人不用再去开面板）", summarizeRuntime({ available: true, counts: { total: 1, active: 1 }, issues: { failed: 0, absent: 0, mismatch: 0, names: {} }, bundles: { problems: [{ name: "x-bundle", kind: "missing" }] } }).includes("bundle 有问题 1"));
	ok("R30 没有 listBundles 的旧宿主：bundles 为 null，规则退回「所有 bundle 都可能缺 loader 条目」", (() => {
		const ix = indexRuntime([]);
		return ix.bundles === null && runtimeOf({ kind: "plugin", packageName: "dsh-any", loadState: "bundle" }, ix).state === "declared-absent";
	})());
	ok("R31 未选中的离线官方 bundle（availability=missing 但 enabled=false）**不算问题** —— 本机两条假警报就是它", (() => {
		const ix = indexRuntime([], { bundles: [{ name: "@deepseek-ai/dsh-subagent-claude-code", enabled: false, availability: "missing" }, { name: "@deepseek-ai/dsh-subagent-codex", enabled: false, availability: "missing" }] });
		return ix.bundles.problems.length === 0 && ix.bundles.rows.length === 2;
	})());
}

const failedCases = results.filter((item) => !item.pass);
if (process.argv.includes("--json")) {
	console.log(JSON.stringify({ probe: "runtime", version: RUNTIME_VERSION, passed: results.length - failedCases.length, failed: failedCases.length, results }, null, 1));
} else {
	console.log("");
	console.log("probe-runtime (R35)");
	console.log("  passed: " + (results.length - failedCases.length));
	console.log("  failed: " + failedCases.length);
	if (failedCases.length > 0) {
		console.log("");
		for (const item of failedCases) console.log("  x " + item.name + (item.detail ? " -- " + item.detail : ""));
	}
	/* run-probes 的解析器认这一行（`passed N / failed M`，不能带冒号） */
	console.log("probe-runtime: passed " + (results.length - failedCases.length) + " / failed " + failedCases.length);
}
process.exit(failedCases.length > 0 ? 1 : 0);
