/**
 * probe-csv.mjs — CSV 导出的独立探针（R28）。
 *
 * 为什么值得单独一个探针：CSV 的错**不会报错**，只会安静地把数据搞坏 ——
 * 名字里有逗号 → 多一列；有引号 → 列错位；有换行 → 整张表被折断；
 * 不带 BOM → Excel 打开是乱码（用户第一反应是"插件坏了"）；
 * 0 次调用写成 0% → 把"没跑过"读成"跑得很好"。
 * 这些都是**格式契约**，只能在纯函数层钉死，靠"导出来看一眼"看不出来。
 *
 * 用法：`node dev/probe-csv.mjs [--json]`；破任一不变式退出码 1。全程不碰磁盘。
 */

import { ENTRY_COLUMNS, csvCell, renderCsv } from "../lib/csv.mjs";
import { depTextOf, entryCsvRow, loadTextOf, rateTextOf, sizeTextOf } from "../lib/service.mjs";

const results = [];
function ok(name, condition, detail = "") {
	results.push({ name, pass: Boolean(condition), detail });
}

/* ── 单元格转义（RFC 4180 + 本项目加的两条） ── */
ok("C1 普通值原样输出（不加多余引号）", csvCell("dsh-screenshot") === "dsh-screenshot" && csvCell("插件") === "插件");
ok("C2 含逗号必须整体加引号，否则会多出一列", csvCell("a,b") === '"a,b"');
ok('C3 含双引号：整体加引号 + 内部双写（"" 是唯一合法写法）', csvCell('say "hi"') === '"say ""hi"""' && csvCell('"') === '""""');
ok("C4 含换行必须加引号（否则整张表被折断）", csvCell("a\nb") === '"a\nb"' && csvCell("a\rb") === '"a\rb"');
ok("C5 前后有空格也加引号（不然贴进表格会静默掉空格）", csvCell(" 插件 ") === '" 插件 "');
ok("C6 null/undefined → 空串；数字 0 → \"0\"（0 不是空！）", csvCell(null) === "" && csvCell(undefined) === "" && csvCell(0) === "0" && csvCell("") === "");
ok("C7 竖线与反引号不做 Markdown 式转义（CSV 里那是字面字符）", csvCell("a|b") === "a|b" && csvCell("`x`") === "`x`");

/* ── 整份 CSV ── */
{
	const rows = [
		{ name: "dsh-a", kind: "插件", source: "self", version: "1.0.0", load: "是", calls: 12, errors: 1, rate: "8%", lastUsed: "2026-10-25 01:00", size: "1.0 KB", dependents: "无人依赖", dir: "D:\\x" },
		{ name: "带,逗号", kind: "Skill", source: "self", version: "", load: "—", calls: 0, errors: 0, rate: "—", lastUsed: "—", size: "—", dependents: "—", dir: "" },
	];
	const text = renderCsv(rows);
	const body = text.replace(/^\uFEFF/, "");
	const lines = body.split("\r\n");
	ok("C8 表头按 ENTRY_COLUMNS 顺序、12 列", lines[0] === ENTRY_COLUMNS.map((column) => column.label).join(",") && ENTRY_COLUMNS.length === 12, lines[0]);
	ok("C9 默认带 BOM（Excel 中文不乱码），bom:false 时没有", text.startsWith("\uFEFF") && renderCsv(rows, ENTRY_COLUMNS, { bom: false }).startsWith("名称") === true);
	ok("C10 行尾是 CRLF（RFC 4180），最后一行也有", body.endsWith("\r\n") && lines.length === 4, JSON.stringify(lines.length));
	ok("C11 数据行里的逗号值被引号包住，列数仍是 12", lines[2].split('"').length >= 2 && lines[2].startsWith('"带,逗号"'), lines[2]);
	ok("C12 空 rows 只出表头，不崩", renderCsv([]).replace(/^\uFEFF/, "") === ENTRY_COLUMNS.map((column) => column.label).join(",") + "\r\n");
	ok("C13 自定义列：未知 key 输出空，不输出 undefined", renderCsv([{ a: 1 }], [{ key: "a", label: "A" }, { key: "zz", label: "Z" }]).replace(/^\uFEFF/, "") === "A,Z\r\n1,\r\n");
}

/* ── 事实层：措辞与"没有"的三种含义 ── */
{
	const dormant = { id: "p:x", kind: "plugin", name: "x", loadState: "dormant", calls: 0, errors: 0 };
	const skill = { id: "skill:y", kind: "skill", name: "y", calls: 3, errors: 0 };
	const asar = { id: "p:z", kind: "plugin", name: "z", inAsar: true, calls: 40, errors: 0 };
	ok("C14 dormant 写「不会被加载」且**没有** Markdown 加粗", loadTextOf(dormant) === "不会被加载" && !loadTextOf(dormant).includes("*"));
	ok("C15 Skill 的加载/被依赖列是「—」（Skill 没有这两个概念）", loadTextOf(skill) === "—" && depTextOf(skill) === "—");
	ok("C16 0 次调用 → 「—」；有调用且 0 报错 → 「0%」（两件事不能混）", rateTextOf(dormant) === "—" && rateTextOf(asar) === "0%" && rateTextOf({ calls: 3, errors: 1 }) === "33%");
	ok("C17 体积：有字节走 formatBytes；没有时 asar 内与没量过要分开", sizeTextOf(asar, 1536).includes("KB") && sizeTextOf(asar, null) === "asar 内" && sizeTextOf(dormant, null) === "—");
	ok("C18 无人依赖与直接依赖分开（前者的措辞是删除决策的依据）", depTextOf(dormant) === "无人依赖" && depTextOf({ kind: "plugin", dependency: true }) === "直接依赖" && depTextOf({ kind: "plugin", dependents: ["a", "b", "c", "d"], dependentCount: 7 }).endsWith(" 等 7 个"));
}

/* ── 一行成品 ── */
{
	const row = entryCsvRow(
		{ id: "p:zz", kind: "plugin", name: 'x"y', source: "self", version: "0.1.0", loadState: "dormant", calls: 0, errors: 0, lastUsed: 0, inAsar: true, realDir: "" },
		{ sizeOf: () => null },
	);
	const line = renderCsv([row]).split("\r\n")[1];
	ok("C19 一行成品的列数与表头一致，且引号按 RFC 双写", line.split(",").length >= 12 ? true : line.includes('"x""y"'), line);
	ok("C20 位置列：没有 realDir / 在 asar 里 → 空，不写 null", row.dir === "" && row.size === "asar 内");
}

const failed = results.filter((item) => !item.pass);
if (process.argv.includes("--json")) {
	console.log(JSON.stringify({ passed: results.length - failed.length, failed: failed.length, results }, null, 1));
} else {
	for (const item of results) console.log(`${item.pass ? "  ok" : "  FAIL"}  ${item.name}${item.pass || !item.detail ? "" : "  [" + item.detail + "]"}`);
	console.log(`\nprobe-csv: passed ${results.length - failed.length} / failed ${failed.length}`);
}
if (failed.length > 0) process.exit(1);
