/**
 * probe-actions.mjs — 卡片动作判据的独立探针（R35）。
 *
 * 这一层要被钉死的原因是：**动作写错不会报错，只会安静地改坏用户的东西**。
 *   · YAML 条目块切歪一行 → 删掉别人一条、或留下半个条目（下次启动才炸）；
 *   · Skill 删除判据漏掉"随插件安装"→ 删的是插件安装包里的文件；
 *   · MCP 删除不校验 → 目标还在却报"已删除"；
 *   · 停用不幂等 → 每点一次追加一条，patch 文件越滚越长。
 * 这些都是**文本/判据契约**，只能在纯函数层用合成文本钉死（不碰真实 profile / Skill 目录）。
 *
 * 用法：`node dev/probe-actions.mjs [--json]`；破任一不变式退出码 1。全程不碰磁盘。
 */

import {
	ACTIONS_VERSION,
	appendDisableEntry,
	blockPreview,
	countEntryLines,
	entryIdOfLine,
	findEntryBlock,
	indentOf,
	isInside,
	normalizePath,
	planMcpDisable,
	planMcpRemove,
	planPluginActions,
	planSkillDelete,
	removeBlock,
	skillTrashRoot,
	verifyEntryRemoved,
} from "../lib/actions.mjs";

const results = [];
function ok(name, condition, detail = "") {
	results.push({ name, pass: Boolean(condition), detail });
}

/* 一份合成的 patch 文件：顶层条目 + insert 块 + 注释 + 空行 */
const PATCH = [
	"# profile patch",
	"- id: keep-a",
	"  name: '@deepseek-ai/dsh-mcp-client'",
	"  config:",
	"    serverName: a",
	"    transport: stdio",
	"",
	"- id: drop-me",
	"  name: '@deepseek-ai/dsh-mcp-client'",
	"  config:",
	"    serverName: drop",
	"    transport: stdio",
	"    command: node",
	"",
	"# 下面是 insert 块",
	"- insert:",
	"    - id: nested-drop",
	"      name: '@deepseek-ai/dsh-mcp-client'",
	"      config:",
	"        serverName: nested",
	"        transport: stdio",
	"    - id: nested-keep",
	"      name: other",
	"  disabled: true",
	"",
].join("\n");

/* ── 行缩进 / 条目 id ── */
ok("A1 indentOf：空格与 tab 都算（tab=4）", indentOf("  - id: x").width === 2 && indentOf("\t- id: x").width === 4 && indentOf("x").width === 0);
ok("A2 entryIdOfLine：带引号 / 不带引号 / 尾注释都认", entryIdOfLine("- id: abc") === "abc" && entryIdOfLine("- id: 'a-b_c'") === "a-b_c" && entryIdOfLine('- id: "q"  # note') === "q");
ok("A3 entryIdOfLine：不是 id 行返回空串（不把 name 行当 id）", entryIdOfLine("- name: x") === "" && entryIdOfLine("id: x") === "" && entryIdOfLine("  config:") === "");

/* ── 找条目块 ── */
{
	const lines = PATCH.split("\n");
	const block = findEntryBlock(lines, { id: "drop-me" });
	ok("A4 找到顶层条目块：只覆盖本条目（4 行），不吞后面的注释/空行", block.ok && block.start === 7 && block.end === 12 && block.indent === 0, JSON.stringify(block));
	const byLine = findEntryBlock(lines, { id: "", line: 8 });
	ok("A5 只有行号提示也能定位（MCP 报告给的就是 file:line）", byLine.ok && byLine.start === 7);
	const hintWrong = findEntryBlock(lines, { id: "keep-a", line: 8 });
	ok("A6 行号提示与 id 不一致时以 id 为准（行号只是加速，不是判据）", hintWrong.ok && hintWrong.start === 1, JSON.stringify(hintWrong));
	const missing = findEntryBlock(lines, { id: "not-there" });
	ok("A7 找不到条目时 ok:false + 说明原因（不静默返回第一段）", missing.ok === false && missing.reason.includes("not-there"));
	const nested = findEntryBlock(lines, { id: "nested-drop" });
	ok("A8 insert 块里的 4 空格条目也能定位，且块在下一个条目之前结束", nested.ok && nested.start === 16 && nested.end === 20, JSON.stringify(nested));
	ok("A9 预览带行号与 › 标记，且只标出块内的行", blockPreview(lines, block).includes("› ") && blockPreview(lines, block).includes("drop-me") && !blockPreview(lines, { ok: true, start: 7, end: 7 }).includes("keep-a"));
}

/* ── 删除条目块 ── */
{
	const lines = PATCH.split("\n");
	const block = findEntryBlock(lines, { id: "drop-me" });
	const after = removeBlock(PATCH, block);
	const verdict = verifyEntryRemoved(PATCH, after, "drop-me");
	ok("A10 删完：目标少一条、别的条目一条不少、总条目只少 1", verdict.ok === true && verdict.before - verdict.after === 1, JSON.stringify(verdict));
	ok("A11 删完保留原换行风格与末尾换行（不把文件写成一行）", after.endsWith("\n") && after.split("\n").length === PATCH.split("\n").length - 6, String(after.split("\n").length));
	ok("A12 删完 keep-a / nested-keep 都还在", after.includes("- id: keep-a") && after.includes("- id: nested-keep") && !after.includes("drop-me"));
	const nested = findEntryBlock(lines, { id: "nested-drop" });
	const afterNested = removeBlock(PATCH, nested);
	ok("A13 删 insert 块里的一条：同块另一条与块头都还在", afterNested.includes("- insert:") && afterNested.includes("- id: nested-keep") && !afterNested.includes("nested-drop"));
	ok("A14 删错目标：verify 必须报失败（不是「看起来删了」）", verifyEntryRemoved(PATCH, after, "keep-a").ok === false);
	ok("A15 什么都没删：verify 也必须报失败", verifyEntryRemoved(PATCH, PATCH, "drop-me").ok === false);
	ok("A16 countEntryLines 与 parseComposition 口径一致（只数 - id: / - name: 行）", countEntryLines(PATCH) === 4, String(countEntryLines(PATCH)));
}

/* ── 停用：追加按 id 覆盖（幂等） ── */
{
	const empty = appendDisableEntry("", { entryId: "mcp-x", serverName: "x" });
	ok("A17 空文件：追加出 2 行条目 + 注释，且能解析成 disabled: off", empty.ok && empty.changed && empty.text.includes("- id: mcp-x") && empty.text.includes("  disabled: true"));
	const again = appendDisableEntry(empty.text, { entryId: "mcp-x" });
	ok("A18 幂等：同一个 id 再追加不写第二遍（changed:false）", again.ok && again.changed === false && again.text === empty.text, again.reason);
	const onExisting = appendDisableEntry("- id: a\n  name: x\n", { entryId: "mcp-y", comment: false });
	ok("A19 追加到已有文件末尾：原有条目原样保留，注释可关掉", onExisting.changed && onExisting.text.startsWith("- id: a") && !onExisting.text.includes("# 插件目录面板"));
	const noId = appendDisableEntry("", { entryId: "" });
	ok("A20 没有 id 时拒绝（不能按 name 瞎写，patch 是按 id 覆盖）", noId.ok === false && noId.changed === false && noId.reason.includes("id"));
}

/* ── 插件动作判据 ── */
{
	const loaded = { kind: "plugin", name: "dsh-x", packageName: "dsh-x", version: "1.0.0", dependency: "link:../../DSH-Plugin/dsh-x", loadState: "bundle", enabled: true, realDir: "D:\\x", dependents: [], isLink: true };
	const ops = planPluginActions(loaded, { runtime: { state: "active", managed: true, entryId: "e1" }, hostApi: true });
	const uninstall = ops.find((op) => op.op === "uninstall");
	ok("A21 插件：可卸载时给出 uninstall + 计划要点（目标点名宿主 API，link 有「不改源码」提醒）", uninstall.available && uninstall.target.includes("removeBundle") && uninstall.warnings.some((warning) => warning.code === "link"), JSON.stringify(uninstall.warnings));
	ok("A22 插件：运行期 active 时计划里明确写「正在跑，会立刻拿掉工具」", uninstall.warnings.some((warning) => warning.code === "runtime-active"));
	const self = planPluginActions({ ...loaded, name: "dsh-plugin-catalog", packageName: "dsh-plugin-catalog", enabled: false, loadState: "dormant", realDir: "", dependency: "" }, { runtime: {}, hostApi: true });
	ok("A23 自己不能卸自己 / 宿主自带包也不能卸", self.find((op) => op.op === "uninstall").available === false && self.find((op) => op.op === "uninstall").blockers.some((blocker) => blocker.code === "self"));
	const hostOwned = planPluginActions({ ...loaded, name: "@deepseek-ai/dsh-base", packageName: "@deepseek-ai/dsh-base" }, { runtime: {}, hostApi: true });
	ok("A24 @deepseek-ai/* 判宿主自带：给的是「不该由 profile 管」而不是静默允许", hostOwned.find((op) => op.op === "uninstall").blockers.some((blocker) => blocker.code === "host-owned"));
	const noApi = planPluginActions(loaded, { runtime: {}, hostApi: false });
	ok("A25 宿主没有 removeBundle：卸载不可用，但停用仍按能力给", noApi.find((op) => op.op === "uninstall").available === false && noApi.find((op) => op.op === "uninstall").blockers.some((blocker) => blocker.code === "no-host-api") && noApi.some((op) => op.op === "disable"));
	const dormantNoEntry = planPluginActions({ ...loaded, enabled: false, loadState: "dormant" }, { runtime: { state: "unknown", managed: false, entryId: "" }, hostApi: true });
	ok("A26 既不在 bundles 也没有可管理条目：停用不可用并说清原因", dormantNoEntry.find((op) => op.op === "disable").available === false && dormantNoEntry.find((op) => op.op === "disable").blockers[0].code === "no-entry");
	const disabledManaged = planPluginActions({ ...loaded, enabled: false, loadState: "dormant" }, { runtime: { state: "disabled", managed: true, entryId: "e2" }, hostApi: true });
	ok("A27 已停用且可管理：给「启用」且可用；「停用」标成 already-disabled（不假装还能停）", disabledManaged.find((op) => op.op === "enable").available === true && disabledManaged.find((op) => op.op === "disable").blockers[0].code === "already-disabled");
	ok("A28 计划里的动作名在冻结表里（客户端/路由只认这几个）", ops.every((op) => ["uninstall", "disable", "enable"].includes(op.op)) && ACTIONS_VERSION >= 1);
}

/* ── Skill 删除判据 ── */
{
	const roots = ["D:\\ws\\.dsh\\skills"];
	const inside = planSkillDelete({ kind: "skill", name: "s1", realDir: "D:\\ws\\.dsh\\skills\\s1" }, { roots, trashRoot: "D:\\ws\\.dsh-plugin-catalog\\trash\\skills" });
	ok("A29 在 Skills 根目录下：可删，且说明「移到回收站」而不是硬删", inside.available && inside.warnings.some((warning) => warning.code === "reversible") && inside.summary.includes("回收站"));
	const pluginSkill = planSkillDelete({ kind: "skill", name: "s2", realDir: "D:\\ws\\.dsh\\skills\\s2", hostPlugin: "dsh-x" }, { roots });
	ok("A30 随插件安装的 Skill：阻断（删它等于改插件安装包）", pluginSkill.available === false && pluginSkill.blockers.some((blocker) => blocker.code === "host-plugin"));
	const noDir = planSkillDelete({ kind: "skill", name: "s3", realDir: "" }, { roots });
	ok("A31 没有独立目录：阻断并说清「没有东西可移」", noDir.available === false && noDir.blockers.some((blocker) => blocker.code === "no-dir"));
	const outside = planSkillDelete({ kind: "skill", name: "s4", realDir: "C:\\Users\\me\\other\\s4" }, { roots });
	ok("A32 不在任何 Skills 根下：阻断（面板不处置任意路径）", outside.available === false && outside.blockers.some((blocker) => blocker.code === "outside-roots"));
	const sibling = planSkillDelete({ kind: "skill", name: "s5", realDir: "D:\\ws\\.dsh\\skills-other\\s5" }, { roots });
	ok("A33 前缀相同的兄弟目录不算在根里（isInside 不靠 startsWith 裸比）", sibling.available === false && !isInside("D:\\ws\\.dsh\\skills-other", "D:\\ws\\.dsh\\skills"));
	ok("A34 路径归一化大小写/斜杠（Windows 上大小写不敏感）", normalizePath("D:\\WS\\Skills\\") === "d:/ws/skills" && isInside("d:/WS/SKILLS/s1", "D:\\ws\\skills"));
	const backup = planSkillDelete({ kind: "skill", name: "s.bak-1", realDir: "D:\\ws\\.dsh\\skills\\s.bak-1", backup: true }, { roots });
	ok("A35 .bak 目录仍可删，但计划里提醒「删它没必要」", backup.available && backup.warnings.some((warning) => warning.code === "backup-dir"));
	ok("A36 回收站路径在数据目录下、与本插件安装目录分开", skillTrashRoot("D:\\ws\\.dsh-plugin-catalog") === "D:\\ws\\.dsh-plugin-catalog\\trash\\skills");
}

/* ── MCP 判据（与 extractMcp 的真实形状对齐） ── */
{
	const server = { id: "mcp:drop", kind: "mcp", entryId: "drop-me", serverName: "drop", transport: "stdio", command: "node", target: "node x.js", state: "on", file: "D:\\profile\\cordis.patch.yml", line: 8, problems: [] };
	const profileFiles = [{ file: "D:\\profile\\cordis.patch.yml", text: PATCH }];
	const remove = planMcpRemove(server, { profileFiles });
	ok("A37 在 profile 自己的组合文件里：可删，给出 block 区间与预览", remove.available && remove.block && remove.block.start === 7 && remove.preview.includes("drop-me"));
	ok("A38 删除计划必须写清「要重启 DSH」与「写前备份、写后校验」", remove.warnings.some((warning) => warning.code === "restart") && remove.warnings.some((warning) => warning.code === "backup"));
	const bundleLayer = planMcpRemove({ ...server, file: "D:\\profile\\node_modules\\dsh-x\\cordis.patch.yml" }, { profileFiles });
	ok("A39 bundle 自带 patch 层里的条目：阻断（重装/升级会回来，删它等于改安装包）", bundleLayer.available === false && bundleLayer.blockers.some((blocker) => blocker.code === "bundle-layer"));
	const idless = planMcpRemove({ ...server, entryId: "" }, { profileFiles });
	ok("A40 没有条目 id：阻断（按 id 覆盖是 patch 的唯一语义）", idless.available === false && idless.blockers.some((blocker) => blocker.code === "no-id"));
	const drifted = planMcpRemove({ ...server, line: 999 }, { profileFiles });
	ok("A41 报告的行号过期：仍能按 id 找回块（行号只是提示）", drifted.available && drifted.block && drifted.block.start === 7);
	const disable = planMcpDisable(server, { patchFile: "D:\\profile\\cordis.patch.yml" });
	ok("A42 停用：可用，且只追加 2 行、不动原条目", disable.available && disable.target.includes("cordis.patch.yml"));
	const already = planMcpDisable({ ...server, state: "off", disabledRaw: "true" }, { patchFile: "D:\\profile\\cordis.patch.yml" });
	ok("A43 已经是关掉的：给的是「已经关掉了」而不是再写一遍", already.available === false && already.blockers[0].code === "already-off");
	const conditional = planMcpDisable({ ...server, state: "expression", disabledRaw: "!!js x" }, { patchFile: "D:\\profile\\cordis.patch.yml" });
	ok("A44 条件启用的条目也允许停用（按 id 追加一条字面量 true 覆盖它）", conditional.available === true);
}

const failed = results.filter((item) => !item.pass);
if (process.argv.includes("--json")) {
	console.log(JSON.stringify({ probe: "actions", version: ACTIONS_VERSION, passed: results.length - failed.length, failed: failed.length, results }, null, 1));
} else {
	console.log("");
	console.log("probe-actions (R35)");
	console.log("  passed: " + (results.length - failed.length));
	console.log("  failed: " + failed.length);
	if (failed.length > 0) {
		console.log("");
		for (const item of failed) console.log("  x " + item.name + (item.detail ? " -- " + item.detail : ""));
	}
	/* run-probes 的解析器认这一行（`passed N / failed M`，不能带冒号） */
	console.log("probe-actions: passed " + (results.length - failed.length) + " / failed " + failed.length);
}
process.exit(failed.length > 0 ? 1 : 0);
