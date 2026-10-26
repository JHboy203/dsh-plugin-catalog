/**
 * freshness.mjs — 「这份结论还新不新」的**纯函数判据**（R34）。
 *
 * ★ 起因是一次真实的误导（2026-10-26 22:1x）：
 *   有人把 `dsh-screenshot` 加回了 `dsh.profile.bundles`（`package.json` mtime 22:15），
 *   而目录快照建于 21:47。面板 / `catalog_list loadState=dormant` / `catalog_uninstall`
 *   仍然写着「⚠️ 不会被加载」—— **结论是完全反的**，而且没有任何地方说"这条可能是旧的"。
 *
 * ★ 所以「旧」必须拆成两件事（混着说就会犯上面那个错）：
 *   · **ageStale**：数据比 TTL 老。只说明"没刷新过"，结论**未必错** —— 没人动过 profile，
 *     四态就没变。这种情况**不值得**重建（一次全量扫描几十秒，白烧）。
 *   · **factStale**：`profile/package.json`、`cordis.yml`、`cordis.patch.yml` 里**有文件的 mtime
 *     比快照的 builtAt 更新**。这说明事实已经变过，快照里的 loadState / bundles 判断**可能已经错**。
 *     只有它值得自动重建（service 里的三条闸门：事实才重建 / 有任务不抢 / 60 秒节流）。
 *
 * ★ 1 秒容差：`plugin_manager` 改 patch 与宿主重载插件几乎同秒发生，
 *   别把"同一次操作"读成"操作之后又改了"。
 *
 * 本模块**不 import fs**：只做比较，读 mtime 在 `hostinfo.profileMutation()`，
 * 于是 `dev/probe-retention.mjs` 能在合成数字上把这些判断跑一遍。
 *
 * @module dsh-plugin-catalog/freshness
 */

/** 目录快照的默认 TTL（与 settings 的 `catalogTtlSeconds` 默认值一致）。 */
export const DEFAULT_TTL_MS = 5 * 60 * 1000;
/** 事实变化的容差：同一次操作里的写入不该被判成"之后又改了"。 */
export const FACT_TOLERANCE_MS = 1000;

/**
 * @param {{builtAt?:number, ageMs?:number|null, ttlMs?:number, profileTouchedAt?:number}} input
 * @returns {{builtAt:number, ageMs:number|null, ttlMs:number, profileTouchedAt:number, ageStale:boolean, factStale:boolean, stale:boolean, reason:string}}
 *   `reason`：`"profile"`（事实变了）/ `"age"`（只是旧）/ `""`（不旧）。
 */
export function staleOf(input = {}) {
	const builtAt = Number(input.builtAt) || 0;
	const ageMs = Number.isFinite(input.ageMs) ? Number(input.ageMs) : null;
	const ttlMs = Number(input.ttlMs) > 0 ? Number(input.ttlMs) : DEFAULT_TTL_MS;
	const profileTouchedAt = Number(input.profileTouchedAt) || 0;
	/* 从没建过（builtAt = 0）也算过期 —— 但那时 factStale 无意义（没有"比它新"这回事） */
	const ageStale = builtAt === 0 || (ageMs !== null && ageMs > ttlMs);
	const factStale = builtAt > 0 && profileTouchedAt > builtAt + FACT_TOLERANCE_MS;
	return {
		builtAt,
		ageMs,
		ttlMs,
		profileTouchedAt,
		ageStale,
		factStale,
		stale: ageStale || factStale,
		reason: factStale ? "profile" : ageStale ? "age" : "",
	};
}
