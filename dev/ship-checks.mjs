/**
 * dev/ship-checks.mjs — 发版体检的检查清单（**单一来源**，R18）。
 *
 * 为什么单独一份：`dev/ship.mjs` 真跑这些项，面板的 `POST /preflight {dry:true}`
 * 又要报「会跑什么」。两处各写一份的结果是本机真实踩过的 ——
 * R18 把 5 个探针收进 ship 之后，dry 仍然只报四项（`["audit","render-check.cjs","hosttest","staging"]`），
 * hosttest 当场抓到。
 *
 * 所以：**id 只在这里定义一次**。ship 用它决定跑什么，index.js 用它决定报什么。
 * `staging` 是 inline + informational（只报不拦），这两点也一起在这里声明。
 *
 * @module dsh-plugin-catalog/dev/ship-checks
 */

export const SHIP_CHECKS = Object.freeze([
	{ id: "audit", label: "自洽契约", script: "dev/audit.mjs" },
	{ id: "render", label: "界面渲染", script: "dev/render-check.cjs" },
	{ id: "hosttest", label: "宿主行为", script: "dev/hosttest.mjs" },
	/* R18：五个独立探针（loadstate / uninstall / simulate / tags / history，共 52 条，约 2 秒）。
	   之前它们只是"交接文件里写着、有人记得就跑"，不变式从没进过发版体检。 */
	{ id: "probes", label: "独立探针", script: "dev/run-probes.mjs" },
	/* 最后一项在 ship **本进程内**跑（不 spawn）：只 stat 几十个 SKILL.md。
	   informational = 报的是这台机器的状态（staging 旧了），不是代码缺陷 —— 只报不拦。 */
	{ id: "staging", label: "副本同步", inline: true, informational: true },
]);

/** dry 模式报什么：只给 id 与标签，不暴露内部脚本路径。 */
export function shipCheckIds() {
	return SHIP_CHECKS.map((check) => check.id);
}
