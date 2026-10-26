/**
 * reports.mjs — `reports/` 的**保留策略**（R34）。
 *
 * ★ 为什么要有它：`reports/` 只会被写、从来没人清。本机 2026-10-26 实测
 *   **30 份 / 362 KB**（`catalog-*` 每日快照、`filtered-*` 每次导出、`uninstall-*`、
 *   `handoff-*`、`uninstall-verify-*`），而且名字都带时间戳 ⇒ **永远不会互相覆盖**。
 *   一年下来是几百份、几 MB，交接时还得靠人眼挑"哪份是最近的"。
 *
 * ★ 判据刻意窄（别偷偷放宽）：
 *   ① **只动本插件自己命名的那五种前缀**（`catalog` / `handoff` / `uninstall` /
 *      `uninstall-verify` / `filtered`）—— 用户用 `path:` 指定的导出路径、以及任何别的东西，
 *      一律**不碰**（那可能是别人的文件）；
 *   ② 同一时间戳的 `.md` + `.json` **当一组**（按去掉扩展名的 stem 归并），
 *      不能只删 json 留 md（对账/恢复要用 json）；
 *   ③ 每组按**文件名倒序**（时间戳在尾部，字典序即时间序）留最新 N 组；
 *   ④ 纯函数：只给"该删哪些名字"，删的动作在 service（于是探针能在合成名字上跑一遍）。
 *
 * @module dsh-plugin-catalog/reports
 */

/**
 * 每种前缀留几**组**（一组 = 同一时间戳的 .md/.json/…）。
 * 口径：越容易被 `catalog_handoff` / 对账回读的留得越多。
 *
 * ★ `catalog-filtered` 必须单列：面板「导出这 N 条」写出来的名字是
 *   **`catalog-filtered-<stamp>.md`**，它以 `catalog-` 开头 —— 只写 `catalog` 的话，
 *   这些"一次性筛选导出"会挤进目录快照的 12 个名额里，把真正的 `catalog-<stamp>` 挤掉
 *   （R34 的 hosttest 就是这么抓到的：本以为留 12 组，实际只留到 10 组）。
 */
export const REPORT_KEEP = Object.freeze({
	"uninstall-verify": 8,
	"catalog-filtered": 10,
	uninstall: 6,
	catalog: 12,
	handoff: 12,
});
/** 认不出的名字一律不动。 */
export const UNKNOWN_KEEP = 0;

/** 前缀表：**长的在前**（`uninstall-verify-…` 也以 `uninstall-` 开头，顺序错就归错组）。 */
const PREFIXES = Object.freeze(Object.keys(REPORT_KEEP).sort((a, b) => b.length - a.length));

/** 文件名 → 前缀（认不出返回空串）。 */
export function reportPrefixOf(name) {
	const text = String(name ?? "");
	if (text === "") return "";
	for (const prefix of PREFIXES) if (text === prefix || text.startsWith(prefix + "-")) return prefix;
	return "";
}

/** 去掉扩展名（同时间戳的 md/json 归成同一组）。 */
function stemOf(name) {
	return String(name).replace(/\.[^.]+$/, "");
}

/**
 * @param {string[]} names `reports/` 目录里的文件名
 * @param {{keep?: Record<string, number>}} [options] 覆盖保留组数（探针用）
 * @returns {{keep: string[], drop: string[], groups: Array<{prefix:string, total:number, kept:number, dropped:number}>}}
 */
export function planReportPrune(names, options = {}) {
	const table = { ...REPORT_KEEP, ...(options.keep || {}) };
	const keep = [];
	const drop = [];
	const groups = [];
	const byPrefix = new Map();
	for (const name of Array.isArray(names) ? names : []) {
		if (typeof name !== "string" || name === "") continue;
		const prefix = reportPrefixOf(name);
		if (prefix === "") continue; /* 不是本插件的产物：不碰 */
		if (!byPrefix.has(prefix)) byPrefix.set(prefix, new Map());
		const map = byPrefix.get(prefix);
		const stem = stemOf(name);
		if (!map.has(stem)) map.set(stem, []);
		map.get(stem).push(name);
	}
	for (const [prefix, map] of byPrefix) {
		const stems = [...map.keys()].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)); /* 新的在前 */
		const limit = Math.max(0, Number(table[prefix]) || 0);
		let kept = 0;
		let dropped = 0;
		stems.forEach((stem, index) => {
			const files = map.get(stem).slice().sort();
			if (index < limit) {
				keep.push(...files);
				kept += files.length;
			} else {
				drop.push(...files);
				dropped += files.length;
			}
		});
		groups.push({ prefix, total: kept + dropped, kept, dropped });
	}
	return { keep, drop, groups };
}
