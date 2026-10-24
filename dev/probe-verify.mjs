/**
 * probe-verify.mjs — 「执行并复核（对账）」的独立探针（R27）。
 *
 * 为什么单独一个探针：`verifyUninstallPlan` 里的判断**写反了也不会报错** ——
 * 「目录还在还是已经没了」「还在引用它的是入口 / 依赖键 / 组外的包」「计划是不是过期了」。
 * 这些错了以后工具照样出结果，只是把一份**白删**的计划报成"已经删干净"，
 * 或者反过来把还在盘上的 26 个目录报成"已回收 7.88 MB"。静态契约看不出来，只能喂图跑。
 *
 * 用法：`node dev/probe-verify.mjs [--json]`；破任一不变式退出码 1。
 * 全程**不碰磁盘**：`presence` 是注入的合成函数，`installed` 是内存里的合成图。
 */

import { verifyUninstallPlan } from "../lib/uninstall.mjs";

const results = [];
function ok(name, condition, detail = "") {
	results.push({ name, pass: Boolean(condition), detail });
}

const AT = 1_700_000_000_000; // 计划生成时间（固定，别用 Date.now()，否则 ageMs 断言会飘）
const NOW = AT + 2 * 86400000; // 对账时间：两天后

/** 造一份计划：members 是 {dirName, pkg, reclaimBytes, link, profileKeys} 的数组。 */
function makePlan(members, extra = {}) {
	return {
		ok: true,
		at: AT,
		nodeModules: "X",
		dormant: { dirCandidates: members.length, groups: 1 },
		groups: [{ key: "g1", name: "g", label: "g 组", count: members.length, members }],
		...extra,
	};
}
const member = (dirName, pkg, reclaimBytes = 1000, extra = {}) => ({ dirName, pkg: pkg || dirName, provenance: "entity", link: false, reclaimBytes, profileKeys: [], ...extra });

/** 在给定的「哪些目录还在」+ 今天的图下对账。 */
function verify(plan, present, input = {}) {
	const presence = new Set(present);
	return verifyUninstallPlan(plan, {
		presence: (dirName) => presence.has(dirName),
		installed: new Map(Object.entries(input.installed || {})),
		bundles: input.bundles || [],
		compositions: input.compositions || [],
		profileDeps: input.profileDeps || {},
		now: NOW,
	});
}

/* ── V1 空计划：不是「都删干净了」，是这份计划本身没内容 ── */
{
	const result = verifyUninstallPlan({ ok: true, groups: [] }, { now: NOW });
	ok("V1 空计划 → verdict=noplan（不许把「没内容」报成「干净」）", result.verdict === "noplan" && result.counts.total === 0, JSON.stringify({ verdict: result.verdict, counts: result.counts }));
}

/* ── V2 一个都没删：intact，而且「还能回收」必须等于计划的全部 ── */
{
	const plan = makePlan([member("a", "a", 1000), member("b", "b", 2000)]);
	const result = verify(plan, ["a", "b"]);
	ok(
		"V2 全在盘上 → intact，gone=0，remainingBytes=3000（不许虚报已回收）",
		result.verdict === "intact" && result.counts.gone === 0 && result.counts.remainingBytes === 3000 && result.counts.reclaimedBytes === 0,
		JSON.stringify(result.counts),
	);
}

/* ── V3 全删干净且没有任何引用：clean ── */
{
	const plan = makePlan([member("a", "a", 1000), member("b", "b", 2000)]);
	const result = verify(plan, []);
	ok(
		"V3 全删且无引用 → clean，fakeGone=0，已回收 3000",
		result.verdict === "clean" && result.fakeGone.length === 0 && result.counts.reclaimedBytes === 3000 && result.drift.length === 0,
		JSON.stringify({ verdict: result.verdict, counts: result.counts }),
	);
}

/* ── V4 已删但仍被 profile 依赖键钉住：删了会被装回来（最要紧的那类） ── */
{
	const plan = makePlan([member("a", "a"), member("b", "b")]);
	const result = verify(plan, ["b"], { profileDeps: { a: "^1.0.0" } });
	const hit = result.fakeGone.find((row) => row.dirName === "a");
	ok("V4 已删但 profile 还声明着 → fake + reasons 含 pinned", result.verdict === "fake" && Boolean(hit) && hit.reasons.includes("pinned"), JSON.stringify(result.fakeGone));
}

/* ── V5 已删但还在 bundles 里：启动入口指空 ── */
{
	const plan = makePlan([member("a", "a")]);
	const result = verify(plan, [], { bundles: ["a"] });
	const hit = result.fakeGone.find((row) => row.dirName === "a");
	ok("V5 已删但还在 bundles → fake + reasons 含 bundle", result.verdict === "fake" && Boolean(hit) && hit.reasons.includes("bundle"), JSON.stringify(result.fakeGone));
}

/* ── V6 已删但还有未关掉的配置条目写着它：why=config；关掉的那条不算 ── */
{
	const live = verify(makePlan([member("a", "a")]), [], { compositions: [{ id: "x", name: "a", disabled: false }] });
	const off = verify(makePlan([member("a", "a")]), [], { compositions: [{ id: "x", name: "a", disabled: true }] });
	ok(
		"V6 未关掉的配置条目算「还指着它」；`disabled: true` 的不算",
		live.verdict === "fake" && (live.fakeGone[0] || {}).reasons?.includes("config") && off.verdict === "clean",
		JSON.stringify({ live: live.verdict, off: off.verdict }),
	);
}

/* ── V7 已删但组外还有包声明它：那个包现在是半坏的 ── */
{
	const plan = makePlan([member("a", "a")]);
	const result = verify(plan, [], { installed: { other: ["a"] } });
	const hit = result.fakeGone.find((row) => row.dirName === "a");
	ok("V7 已删但组外包声明它 → fake + reasons 含 declared-outside（并点名是谁）", result.verdict === "fake" && Boolean(hit) && hit.reasons.includes("declared-outside") && hit.declarers.includes("other"), JSON.stringify(hit));
}

/* ── V8 成员还在，但今天它已经会被加载了：计划过期 ── */
{
	const plan = makePlan([member("a", "a")]);
	const result = verify(plan, ["a"], { bundles: ["a"], installed: { a: [] } });
	const hit = result.drift.find((row) => row.dirName === "a");
	ok("V8 还在盘上的成员今天成了 bundle 入口 → drift nowLoaded（state=bundle）", Boolean(hit) && hit.drift.includes("nowLoaded") && hit.state === "bundle", JSON.stringify(result.drift));
}

/* ── V9 ★ 组内互相声明**不是**失守（计划按弱连通分量分组，整组一起走） ── */
{
	const plan = makePlan([member("a", "a"), member("b", "b")]);
	const inside = verify(plan, ["a", "b"], { installed: { a: ["b"], b: [] } });
	const outside = verify(plan, ["a", "b"], { installed: { a: ["b"], b: [], zzz: ["b"] } });
	const insideHit = inside.drift.find((row) => row.dirName === "b");
	const outsideHit = outside.drift.find((row) => row.dirName === "b");
	ok(
		"V9 组内声明不算 drift；组外声明才算（并带出 declarers）",
		inside.drift.length === 0 && Boolean(outsideHit) && outsideHit.drift.includes("nowDeclared") && outsideHit.declarers.includes("zzz") && !insideHit,
		JSON.stringify({ inside: inside.drift.length, outside: outside.drift.map((row) => row.dirName) }),
	);
}

/* ── V10 字节账：已删的进「已回收」、还在的进「还能回收」，两者不重叠；链接恒 0 ── */
{
	const plan = makePlan([member("a", "a", 1000), member("b", "b", 2000), member("link", "pkg-link", 0, { link: true })]);
	const result = verify(plan, ["b", "link"]);
	ok(
		"V10 已回收只算已删的、还能回收只算还在的；链接成员恒 0 且进 linkBytes",
		result.counts.reclaimedBytes === 1000 && result.counts.remainingBytes === 2000 && result.counts.linkBytes === 0,
		JSON.stringify(result.counts),
	);
}

/* ── V11 没注入 presence → 一律当「还在」：绝不凭缺项宣布目录消失 ── */
{
	const result = verifyUninstallPlan(makePlan([member("a", "a")]), { now: NOW, installed: new Map() });
	ok("V11 presence 缺失时保守判「还在」（不虚报已删）", result.verdict === "intact" && result.counts.gone === 0, JSON.stringify(result.counts));
}

/* ── V12 同一目录在计划里出现两次（分组重叠）→ 只算一个成员 ── */
{
	const plan = makePlan([member("a", "a", 1000), member("a", "a", 1000)]);
	const result = verify(plan, []);
	ok("V12 计划里重复的目录名只算一个成员（体积不许重复计）", result.counts.total === 1 && result.counts.reclaimedBytes === 1000, JSON.stringify(result.counts));
}

/* ── V13 计划龄：ageMs = now - at；at 缺失时不许算出负数或 NaN ── */
{
	const withAt = verify(makePlan([member("a", "a")]), ["a"]);
	const noAt = verifyUninstallPlan({ ok: true, groups: [{ members: [member("a", "a")] }] }, { now: NOW });
	ok("V13 ageMs = 2 天；at 缺失时 ageMs=0（不出负数/NaN）", withAt.ageMs === 2 * 86400000 && noAt.ageMs === 0 && noAt.at === 0, JSON.stringify({ withAt: withAt.ageMs, noAt: noAt.ageMs }));
}

/* ── V14 结论优先级：白删压过「删了一部分」；一个没删时不叫白删 ── */
{
	const partial = verify(makePlan([member("a", "a"), member("b", "b")]), ["b"], { profileDeps: { a: "*" } });
	const allStill = verify(makePlan([member("a", "a")]), ["a"], { profileDeps: { a: "*" } });
	ok(
		"V14 有白删就报 fake（不是 partial）；一个都没删时报 intact（不误报白删）",
		partial.verdict === "fake" && allStill.verdict === "intact" && allStill.fakeGone.length === 0,
		JSON.stringify({ partial: partial.verdict, allStill: allStill.verdict }),
	);
}

/* ── V15 边界话术必须自带：这些结论只到声明层面，且本操作不改任何东西 ── */
{
	const result = verify(makePlan([member("a", "a")]), []);
	const text = (result.boundaries || []).join(" ");
	ok(
		"V15 边界四条齐全（声明层面 / 只 stat 计划里的目录 / 组内不算失守 / 不改任何东西）",
		(result.boundaries || []).length === 4 && /声明/.test(text) && /组内/.test(text) && /不改任何东西|不删目录/.test(text),
		JSON.stringify(result.boundaries),
	);
}

/* ── 收尾 ── */
const failed = results.filter((item) => !item.pass);
if (process.argv.includes("--json")) {
	console.log(JSON.stringify({ results, passed: results.length - failed.length, failed: failed.length }, null, 2));
} else {
	for (const item of results) console.log((item.pass ? "PASS " : "FAIL ") + item.name + (item.pass ? "" : "  <<< " + item.detail));
	console.log("");
	for (const item of failed) console.log("FAIL " + item.name + "  <<< " + item.detail);
	console.log("probe-verify: passed " + (results.length - failed.length) + " / failed " + failed.length);
}
if (failed.length > 0) process.exit(1);
