/**
 * lib/csv.mjs — R28：CSV 导出的**纯函数层**（不读盘、不 import service）。
 *
 * 为什么单独一个模块：
 * 1. 转义规则（逗号 / 引号 / 换行 / 前后空格）是**格式契约**，必须能被探针直接钉死，
 *    而不是藏在 service 的一个方法里只能靠"导出来看一眼"。
 * 2. 列定义只有**一份**：`catalog_export format=csv` 与面板「导出 CSV」都读 `ENTRY_COLUMNS`，
 *    增删列只改这里（两处各写一份的清单迟早差一次）。
 *
 * ★ 为什么不和 Markdown 表格共用行：Markdown 那一列要给名字加反引号、给「无人依赖」加粗，
 *   在 CSV 里都是噪音。**共用的是数字与措辞（service 里的 helper），各写各的是装饰**。
 * ★ BOM：Excel 打开不带 BOM 的 UTF-8 会把中文读成乱码，所以默认带 BOM（`\uFEFF`）。
 *   其它工具（pandas / Numbers / VS Code）都能正常忽略它。
 */

/** 列定义（唯一来源）：key 对应 service 里那一行的字段名。 */
export const ENTRY_COLUMNS = Object.freeze([
	{ key: "name", label: "名称" },
	{ key: "kind", label: "类型" },
	{ key: "source", label: "来源" },
	{ key: "version", label: "版本" },
	{ key: "load", label: "加载" },
	{ key: "calls", label: "调用" },
	{ key: "errors", label: "报错" },
	{ key: "rate", label: "报错率" },
	{ key: "lastUsed", label: "最近一次" },
	{ key: "size", label: "体积" },
	{ key: "dependents", label: "被依赖" },
	{ key: "dir", label: "位置" },
]);

/**
 * 一个单元格的 CSV 表示。
 * RFC 4180：含 `,` `"` CR LF 的字段必须整体加双引号，内部 `"` 写成 `""`。
 * 另外把**前后有空格**的值也加引号 —— 否则 `" 插件 "` 这种值到了表格里会悄悄掉空格。
 */
export function csvCell(value) {
	if (value === null || value === undefined) return "";
	const text = String(value);
	if (text === "") return "";
	const mustQuote = /[",\r\n]/.test(text) || /^\s/.test(text) || /\s$/.test(text);
	return mustQuote ? '"' + text.replace(/"/g, '""') + '"' : text;
}

/**
 * 行数组 → CSV 文本。
 * @param {Array<object>} rows
 * @param {Array<{key:string,label:string}>} [columns]
 * @param {{bom?:boolean}} [options] bom 默认 true（Excel 中文）
 */
export function renderCsv(rows, columns = ENTRY_COLUMNS, options = {}) {
	const cols = Array.isArray(columns) && columns.length > 0 ? columns : ENTRY_COLUMNS;
	const lines = [cols.map((column) => csvCell(column.label)).join(",")];
	for (const row of Array.isArray(rows) ? rows : []) {
		lines.push(cols.map((column) => csvCell(row ? row[column.key] : "")).join(","));
	}
	/* CRLF：Excel / Numbers 都认，也是 RFC 4180 的规定 */
	const text = lines.join("\r\n") + "\r\n";
	return options.bom === false ? text : "\uFEFF" + text;
}
