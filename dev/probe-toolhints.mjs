/**
 * probe-toolhints.mjs — 工具中文说明的独立探针（R39）。
 *
 * 为什么值得单独一个探针：`lib/toolhints.mjs` 的错**不会报错**，只会安静地把人带偏 ——
 *   · 查不到却编一句 → 鼠标停上去看到一段像模像样但错误的用途，比留空更坏；
 *   · AI 生成覆盖静态表时没做「空白串回退」→ 一句 `" "` 就把好说明顶掉；
 *   · 说明超长 / 带换行 → 详情页表格那行小字把行高撑开、或者只显示半句；
 *   · 静态表被别人删掉一半 → 面板照常打开，只是所有工具都「暂无中文说明」。
 * 这些都是**文案契约**，只能在纯函数层钉死。
 *
 * 用法：`node dev/probe-toolhints.mjs [--json]`；破任一不变式退出码 1。全程不碰磁盘、不联网。
 */

import { TOOL_HINTS, hintsForTools, staticToolHint, toolHintOf } from "../lib/toolhints.mjs";

const results = [];
function ok(name, condition, detail = "") {
	results.push({ name, pass: Boolean(condition), detail });
}

/* ── 静态表：覆盖（别让面板「全都没有说明」） ── */
ok("T1 覆盖宿主核心工具（pwsh / read / write / edit）", ["pwsh", "read", "write", "edit"].every((name) => staticToolHint(name).length > 0));
ok("T2 覆盖本插件的 catalog_*（14 个里至少 10 个有精确说明）", Object.keys(TOOL_HINTS).filter((name) => name.startsWith("catalog_")).length >= 10);
ok("T3 覆盖常见插件族（截图 / 监控 / 做片子 / 语音 / 会话取证）", ["shot_probe", "botwatch_status", "lemofilm_voice", "vexvoice_status", "session_search"].every((name) => staticToolHint(name).length > 0));
ok("T4 覆盖量下限（≥ 180 条；防有人把表删成一个空壳）", Object.keys(TOOL_HINTS).length >= 180, String(Object.keys(TOOL_HINTS).length));
ok("T5 每条说明都在展示预算内（≤ 64 字、不含换行、不是纯空白）", Object.entries(TOOL_HINTS).every(([, hint]) => typeof hint === "string" && hint.trim() !== "" && hint.length <= 64 && !/[\r\n]/.test(hint)));

/* ── 静态表：不编 ── */
ok("T6 完全没有规则命中的工具返回空串（绝不编一句像样的用途）", staticToolHint("no_such_tool_xyz") === "" && staticToolHint("zzz_unknown_tool") === "", staticToolHint("no_such_tool_xyz") + " / " + staticToolHint("zzz_unknown_tool"));
ok("T6b 前缀族说明只给「这一族是干什么的」，不是编造具体用途（dsh_* 未知名拿到的是族说明）", staticToolHint("dsh_some_unknown_tool").includes("DSH 本体") && !staticToolHint("dsh_some_unknown_tool").includes("未知名"));
ok("T7 空名 / null / undefined 返回空串（不抛错）", staticToolHint("") === "" && staticToolHint(null) === "" && staticToolHint(undefined) === "" && staticToolHint("   ") === "");

/* ── 前缀规则：一族一句，但不许吞掉精确表 ── */
ok("T8 前缀规则覆盖具体名（shot_* / catalog_* / vex_* 都有话说）", staticToolHint("shot_unknown_tool").length > 0 && staticToolHint("catalog_unknown_tool").length > 0 && staticToolHint("vex_unknown_tool").length > 0);
ok("T9 精确表优先于前缀规则（pwsh 命中精确说明，不是「Windows 桌面工具」那句）", staticToolHint("pwsh").includes("PowerShell") && staticToolHint("pwsh") !== staticToolHint("winperf_snapshot"));

/* ── 合并：AI 生成 > 静态表 > 空 ── */
ok("T10 AI 生成优先（更贴这个条目自己的说法）", toolHintOf("pwsh", { pwsh: "我自己的说法" }) === "我自己的说法");
ok("T11 AI 给空白串时回退静态表（否则一句空格就把好说明顶掉）", toolHintOf("pwsh", { pwsh: "   " }) === TOOL_HINTS.pwsh && toolHintOf("pwsh", { pwsh: "" }) === TOOL_HINTS.pwsh);
ok("T12 AI 给非字符串（数字 / 对象 / null）时回退静态表，不把对象塞进界面", toolHintOf("pwsh", { pwsh: 42 }) === TOOL_HINTS.pwsh && toolHintOf("pwsh", { pwsh: { text: "x" } }) === TOOL_HINTS.pwsh && toolHintOf("pwsh", { pwsh: null }) === TOOL_HINTS.pwsh);
ok("T13 AI 值截断到 80 字（不许一句 500 字的模型输出撑破表格）", toolHintOf("pwsh", { pwsh: "长".repeat(200) }).length === 80);
ok("T14 AI 表里没有这个工具时回退静态表（不是整条空）", toolHintOf("shot_probe", { other: "x" }) === TOOL_HINTS.shot_probe);

/* ── 批量（详情页一次取一整组） ── */
{
	const map = hintsForTools(["pwsh", "no_such_tool_xyz", "shot_probe"], null);
	ok("T15 批量只收有说明的（未知工具不占 key，界面就不会显示「（暂无）」两次）", Object.keys(map).join(",") === "pwsh,shot_probe", Object.keys(map).join(","));
}
ok("T16 批量：空数组 / null / 非数组都返回 {}（不抛）", Object.keys(hintsForTools([], null)).length === 0 && Object.keys(hintsForTools(null, null)).length === 0 && Object.keys(hintsForTools(undefined, {})).length === 0);
ok("T17 批量：AI 覆盖只影响被点名的那些（同一批里别的仍走静态表）", hintsForTools(["pwsh", "shot_probe"], { pwsh: "自定义" }).pwsh === "自定义" && hintsForTools(["pwsh", "shot_probe"], { pwsh: "自定义" }).shot_probe === TOOL_HINTS.shot_probe);

/* ── 表本身的自洽 ── */
ok("T18 静态表的 key 都是「工具名形状」（小写字母开头、无空格、无 mcp__ 前缀）", Object.keys(TOOL_HINTS).every((name) => /^[a-z][a-z0-9_]*$/.test(name)), Object.keys(TOOL_HINTS).filter((name) => !/^[a-z][a-z0-9_]*$/.test(name)).slice(0, 5).join(","));

const failed = results.filter((item) => !item.pass);
if (process.argv.includes("--json")) {
	console.log(JSON.stringify({ passed: results.length - failed.length, failed: failed.length, results }, null, 1));
} else {
	for (const item of results) console.log(`${item.pass ? "  ok" : "  FAIL"}  ${item.name}${item.pass || !item.detail ? "" : "  [" + item.detail + "]"}`);
	console.log(`\nprobe-toolhints: passed ${results.length - failed.length} / failed ${failed.length}`);
}
if (failed.length > 0) process.exit(1);
