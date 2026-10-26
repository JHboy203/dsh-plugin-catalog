/**
 * dev/probe-list.mjs — 独立探针清单的**单一来源**（R31）。
 *
 * 为什么单独一份：`dev/run-probes.mjs` 要跑它们，`dev/audit.mjs` 要**数**它们
 * （文档里写的「十一个 / 231 条」必须等于真实清单，否则文档就是在撒谎）。
 * 两处各写一份的下场很清楚 —— 加一个探针，跑的是 11 个，文档还说 10 个。
 *
 * ★ 这里只放**数据**（id / 中文标签 / 脚本路径），不放执行逻辑：
 *   import 它不会起任何子进程，所以 audit 里可以安全地数。
 *
 * @module dsh-plugin-catalog/dev/probe-list
 */

export const PROBES = Object.freeze([
	{ id: "loadstate", label: "加载路径", file: "dev/probe-loadstate.mjs" },
	{ id: "uninstall", label: "处置清单", file: "dev/probe-uninstall.mjs" },
	{ id: "simulate", label: "删除预演", file: "dev/probe-simulate.mjs" },
	{ id: "verify", label: "处置对账", file: "dev/probe-verify.mjs" },
	{ id: "tags", label: "批量打标", file: "dev/probe-tags.mjs" },
	{ id: "history", label: "变化追踪", file: "dev/probe-history.mjs" },
	{ id: "staging", label: "副本判据", file: "dev/probe-staging.mjs" },
	{ id: "composition", label: "配置层", file: "dev/probe-composition.mjs" },
	{ id: "handoff", label: "交接单", file: "dev/probe-handoff.mjs" },
	{ id: "csv", label: "CSV 导出", file: "dev/probe-csv.mjs" },
	{ id: "mcp", label: "MCP 判据", file: "dev/probe-mcp.mjs" },
	/* R32：单件卸载（换版本的协作方）—— 判据与执行链，全程用假宿主，不真卸 */
	{ id: "removal", label: "单件卸载", file: "dev/probe-removal.mjs" },
	/* R34：留存与「还新不新」—— 快照陈旧判据（事实 vs 年龄）/ 每周任务全失败不许伪装成跑过 /
	   reports/ 保留策略（只动自己那五种前缀、md+json 同组、留最新 N 组） */
	{ id: "retention", label: "留存与陈旧", file: "dev/probe-retention.mjs" },
]);

/** 探针个数（文档里「11 个」的那个数）。 */
export const PROBE_COUNT = PROBES.length;

/**
 * 旧一代探针（R1–R9 的探索脚本）：**不在发版体检链上**，保留只作历史。
 *
 * R31 数出来的事实：`dev/` 里还有 9 个 `probe-*.mjs` 不在 PROBES 里 ——
 * 其中 5 个（asar / export / gitops / init / publish）README 还当命令写着，
 * 4 个（catalog / dupe / multifile / stats）连文档都没有。它们不是"断言"而是"打印"，
 * 而且有两条在沙箱里天然是红的（asar 读不到 → `mode none`；git 子进程 → `spawn EPERM`）。
 *
 * ★ 为什么登记而不是删掉：删掉就没人知道曾经验过什么；登记 + 一句"被谁接管"
 *   才能让后来者一眼分清「这是现行判据」还是「那是当年的探索」。
 * ★ audit 会核对：`dev/` 顶层的每个 `probe-*.mjs` 必须在这两张表里出现 ——
 *   新写的探针忘了挂链，红的是 audit，不是用户的信心。
 */
export const LEGACY_PROBES = Object.freeze([
	{ id: "asar", file: "dev/probe-asar.mjs", replacedBy: "hosttest 的 asar 断言（普通 node 里 SKIP）" },
	{ id: "catalog", file: "dev/probe-catalog.mjs", replacedBy: "audit 的目录扫描断言" },
	{ id: "dupe", file: "dev/probe-dupe.mjs", replacedBy: "无（一次性排查：同一会话多份日志）" },
	{ id: "export", file: "dev/probe-export.mjs", replacedBy: "probe-csv 与 hosttest 的导出断言" },
	{ id: "gitops", file: "dev/probe-gitops.mjs", replacedBy: "catalog_publish 的 plan/apply 闸门 + probe-publish 的只读核对" },
	{ id: "init", file: "dev/probe-init.mjs", replacedBy: "无（一次性测启动成本）" },
	{ id: "multifile", file: "dev/probe-multifile.mjs", replacedBy: "lib/frames.mjs 的多帧解析（probe-history 覆盖）" },
	{ id: "publish", file: "dev/probe-publish.mjs", replacedBy: "audit 的上传计划断言 + probe-gitops" },
	{ id: "stats", file: "dev/probe-stats.mjs", replacedBy: "probe-loadstate / hosttest 的统计断言" },
]);

/** 旧探针个数（只用于文档与计数，不参与「231 条」那个总数）。 */
export const LEGACY_COUNT = LEGACY_PROBES.length;
