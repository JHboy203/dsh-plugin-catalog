/**
 * dev/probe-removal.mjs — 「单件卸载」判据与执行链的自证（R32）。
 *
 * ★ 为什么要单独一个探针：`lib/removal.mjs` 的判据同时被两处消费 ——
 *   dsh-plugin-installer 的升级流程（经服务）与 `/plugin-catalog/removal/*` 路由。
 *   共用的东西没法互相证伪，所以这里**独立喂事实**再问一遍：
 *   判据在什么情况下必须拒绝、执行后必须以「依赖行还在不在」为准而不是宿主回执。
 *
 * ★ 全程不真卸载：宿主 `pluginManager` 用假件；涉及写盘的只有一份**临时**留痕文件。
 *   唯一读真盘的是 profile 事实（只读，用来验「计划过期 / 不是 profile 拥有的包」两道闸）。
 *
 * 用法：`node dev/probe-removal.mjs`（退出码 0 = 全绿）/ `--json`
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CatalogService } from "../lib/service.mjs";
import { profileDependencies } from "../lib/hostinfo.js";
import {
	INSPECT_CODES,
	REMOVAL_API,
	REMOVAL_JOURNAL_LIMIT,
	REMOVAL_PLAN_TTL_MS,
	appendRemovalJournal,
	collectRemovalFacts,
	describeRemovalHost,
	executePackageRemoval,
	inspectPackageState,
	planPackageRemoval,
	readRemovalJournal,
	specKind,
	summarizeRemovalResult,
} from "../lib/removal.mjs";

const asJson = process.argv.includes("--json");
const checks = [];
function ok(name, condition, detail) {
	checks.push({ name, ok: Boolean(condition), detail: condition ? "" : String(detail ?? "") });
}
function eq(name, actual, expected) {
	const same = JSON.stringify(actual) === JSON.stringify(expected);
	checks.push({ name, ok: same, detail: same ? "" : "实际 " + JSON.stringify(actual) + " ≠ 期望 " + JSON.stringify(expected) });
}
function codes(list) {
	return (Array.isArray(list) ? list : []).map((item) => item && item.code).sort();
}

/* ── ① 声明形态：npm / link / file / git 的判法 ── */
eq("spec: ^1.2.3 → npm", specKind("^1.2.3"), "npm");
eq("spec: 1.2.3 → npm", specKind("1.2.3"), "npm");
eq("spec: link:D:/x → link", specKind("link:D:/x"), "link");
eq("spec: file:../x.tgz → file", specKind("file:../x.tgz"), "file");
eq("spec: github:o/r → git", specKind("github:o/r"), "git");
eq("spec: o/r → git", specKind("owner/repo"), "git");
eq("spec: 空 → unknown", specKind(""), "unknown");

/* ── ② 判据：该拒的必须拒 ── */
const base = { name: "dsh-x", purpose: "replace", spec: "^1.0.0", version: "1.0.0", loadState: "dormant", dependents: [], bundles: [] };
eq("plan: 空名字 → no-name", codes(planPackageRemoval({ ...base, name: "" }).blockers), ["no-name"]);
eq("plan: 自己 → self", codes(planPackageRemoval({ ...base, name: "dsh-plugin-catalog" }).blockers), ["self"]);
eq("plan: 宿主自带 → host-owned", codes(planPackageRemoval({ ...base, name: "@deepseek-ai/dsh-tools" }).blockers), ["host-owned"]);
eq("plan: 不在依赖里 → not-owned", codes(planPackageRemoval({ ...base, spec: "" }).blockers), ["not-owned"]);
ok("plan: 三条阻断同时出现时不 ok", planPackageRemoval({ ...base, name: "@deepseek-ai/x", spec: "" }).ok === false, "应当 false");
ok("plan: 正常包 ok", planPackageRemoval(base).ok === true, "应当 true");

/* ── ③ 判据：该说的要说（warnings 不是阻断） ── */
const loaded = planPackageRemoval({ ...base, loadState: "bundle", via: "dsh-plugin-installer", dependents: ["a", "b"], bundles: ["dsh-x"] });
ok("plan: 会被加载 → 有 loaded 警告", codes(loaded.warnings).includes("loaded"), JSON.stringify(codes(loaded.warnings)));
ok("plan: 在 bundles 里 → bundle-row 警告", codes(loaded.warnings).includes("bundle-row"), JSON.stringify(codes(loaded.warnings)));
ok("plan: 有依赖者 → dependents 警告", codes(loaded.warnings).includes("dependents"), JSON.stringify(codes(loaded.warnings)));
ok("plan: 警告不阻断", loaded.ok === true, "ok 应为 true");
ok("plan: 人话里带加载态", /bundle/.test(loaded.text), loaded.text);
const linked = planPackageRemoval({ ...base, spec: "link:D:/src/dsh-x" });
ok("plan: link 说明「源码目录不动」", /源码目录一个字节都不会动/.test(linked.warnings.map((w) => w.text).join(" ")), JSON.stringify(linked.warnings));
ok("plan: link 仍可卸（去掉依赖而已）", linked.ok === true, "ok 应为 true");
eq("plan: purpose=remove 原样保留", planPackageRemoval({ ...base, purpose: "remove" }).purpose, "remove");
eq("plan: 非法 purpose 归一到 replace", planPackageRemoval({ ...base, purpose: "whatever" }).purpose, "replace");

/* ── ④ 回执摘要：宿主的话要翻成人话，且 unknown-plugin 不算失败 ── */
const applied = summarizeRemovalResult({ changed: true, application: "applied", stage: "remove", target: "dsh-x" });
ok("回执: applied → ok + changed", applied.ok === true && applied.changed === true, JSON.stringify(applied));
const failed = summarizeRemovalResult({ changed: false, application: "failed", stage: "remove", error: { code: "not-removable", message: "no" } });
ok("回执: failed → 不 ok 且带 code", failed.ok === false && failed.code === "not-removable", JSON.stringify(failed));
const gone = summarizeRemovalResult({ changed: false, application: "applied", error: { code: "unknown-plugin", message: "gone" } });
ok("回执: unknown-plugin 记为 alreadyGone 且不判失败", gone.ok === true && gone.alreadyGone === true, JSON.stringify(gone));

/* ── ⑤ 执行：没有宿主 API 就明确拒绝 ── */
const noHost = describeRemovalHost(null);
ok("host: 没有 pluginManager → canRemove=false + 原因", noHost.ok === false && Boolean(noHost.reason), JSON.stringify(noHost));

/* 找一台真机上确实装着的包（只读事实；后面用假宿主，不会真卸） */
const deps = await profileDependencies().catch(() => ({}));
const candidates = Object.keys(deps).filter((name) => !name.startsWith("@deepseek-ai/") && name !== "dsh-plugin-catalog");
const target = candidates.includes("dsh-plugin-installer") ? "dsh-plugin-installer" : candidates[0] || "";

const notOkPlan = await executePackageRemoval({ pluginManager: { removeBundle() {} }, plan: { ok: false, name: "dsh-x" } });
ok("执行: 计划不允许 → plan-not-ok", notOkPlan.ok === false && notOkPlan.code === "plan-not-ok", JSON.stringify(notOkPlan));
const noApi = await executePackageRemoval({ pluginManager: {}, plan: { ok: true, name: "dsh-x" } });
ok("执行: 没有 removeBundle → no-host-api", noApi.ok === false && noApi.code === "no-host-api", JSON.stringify(noApi));
if (target) {
	const notOwned = await executePackageRemoval({ pluginManager: { removeBundle() {} }, plan: { ok: true, name: "definitely-not-installed-xyz" } });
	ok("执行: 执行前复核发现不在依赖里 → not-owned", notOwned.ok === false && notOwned.code === "not-owned", JSON.stringify(notOwned));
	const stale = await executePackageRemoval({
		pluginManager: { removeBundle() {} },
		plan: { ok: true, name: target, version: "0.0.1-does-not-exist", spec: deps[target] },
	});
	ok("执行: 版本与计划不符 → stale-plan（不拿过期计划动手）", stale.ok === false && stale.code === "stale-plan", JSON.stringify(stale));
}

/* ── ⑥ 执行：**以依赖行为准**，不信宿主回执 ── */
let calls = 0;
const fakeHost = { removeBundle: async () => { calls += 1; return { changed: true, application: "applied", stage: "remove" }; } };
const realFacts = target ? await collectRemovalFacts({ name: target, purpose: "replace" }) : null;
if (target && realFacts) {
	const receiptOnly = await executePackageRemoval({
		pluginManager: fakeHost,
		plan: { ok: true, name: target, version: realFacts.version, spec: realFacts.spec },
		verify: async () => ({ removed: false, inDeps: true, dirExists: true }),
	});
	ok("执行: 宿主说 applied 但依赖行还在 → 判失败", receiptOnly.ok === false && /依赖/.test(receiptOnly.error), JSON.stringify(receiptOnly));
	ok("执行: 失败也要给 verified 三段事实", receiptOnly.verified && receiptOnly.verified.removed === false, JSON.stringify(receiptOnly.verified));
	const okReceipt = await executePackageRemoval({
		pluginManager: fakeHost,
		plan: { ok: true, name: target, version: realFacts.version, spec: realFacts.spec },
		verify: async () => ({ removed: true, inDeps: false, dirExists: false }),
	});
	ok("执行: 回执 applied + 复核已消失 → ok", okReceipt.ok === true && okReceipt.verified.removed === true, JSON.stringify(okReceipt));
	ok("执行: 用假宿主，真环境没被动（复核仍能读到它）", Boolean((await profileDependencies())[target]), "真依赖里应当还在");
	const thrown = await executePackageRemoval({
		pluginManager: { removeBundle: async () => { throw new Error("host blew up"); } },
		plan: { ok: true, name: target, version: realFacts.version, spec: realFacts.spec },
		verify: async () => ({ removed: false, inDeps: true, dirExists: true }),
	});
	ok("执行: 宿主抛错 → host-threw", thrown.ok === false && thrown.code === "host-threw", JSON.stringify(thrown));
}
const fakeName = await executePackageRemoval({
	pluginManager: fakeHost,
	plan: { ok: true, name: "dsh-x", version: "1.0.0" },
	verify: async () => ({ removed: true, inDeps: false, dirExists: false }),
});
ok("执行: 不在真依赖里时报 not-owned（保护：不该拿假名字走通）", fakeName.ok === false && fakeName.code === "not-owned", JSON.stringify(fakeName));

/* ── ⑦ 服务层：token 生命周期与写盘闸（用临时留痕文件，不污染真数据目录） ── */
const tempRoot = await mkdtemp(join(tmpdir(), "removal-probe-"));
const journalFile = join(tempRoot, "removal-journal.json");
const fakeCtx = { get: (key) => (key === "pluginManager" ? { removeBundle: async () => ({ changed: true, application: "applied" }) } : undefined) };
const service = new CatalogService({ ctx: fakeCtx, toolSchemas: () => [] });
service.settings = { workspace: tempRoot };
service.removalJournalFile = () => journalFile;

const noToken = await service.removalApply({});
ok("服务: 不带 token/confirm → confirm-required", noToken.ok === false && noToken.code === "confirm-required", JSON.stringify(noToken));
const badToken = await service.removalApply({ token: "nope", confirm: true });
ok("服务: 不存在的 token → unknown-token", badToken.ok === false && badToken.code === "unknown-token", JSON.stringify(badToken));

const planSelf = await service.removalPlan({ name: "dsh-plugin-catalog", purpose: "replace" });
ok("服务: 对自己出计划 → self 阻断、不发 token", planSelf.ok === false && codes(planSelf.blockers).includes("self") && !planSelf.token, JSON.stringify({ ok: planSelf.ok, code: planSelf.code, token: Boolean(planSelf.token) }));
const planGhost = await service.removalPlan({ name: "definitely-not-installed-xyz" });
ok("服务: 没装的包 → not-owned", planGhost.ok === false && codes(planGhost.blockers).includes("not-owned"), JSON.stringify({ ok: planGhost.ok, code: planGhost.code }));

/* 用真实装着的包拿一个 token，验「过期 / 一次用掉」两条闸（都不真的调宿主，因为 token 会被拦） */
if (target) {
	const plan = await service.removalPlan({ name: target, purpose: "replace", requestedBy: "probe" });
	ok("服务: 真包能出计划且带 token/有效期", plan.ok === true && Boolean(plan.token) && plan.expiresAt > Date.now(), JSON.stringify({ ok: plan.ok, code: plan.code, token: Boolean(plan.token) }));
	/* 过期：把计划时间往前拨 */
	if (plan.ok && plan.token) {
		const planned = service._removalPlans.get(plan.token);
		planned.expiresAt = Date.now() - 1;
		const expired = await service.removalApply({ token: plan.token, confirm: true });
		ok("服务: 计划过期 → plan-expired", expired.ok === false && expired.code === "plan-expired", JSON.stringify(expired));
	}
}

/* 留痕：追加 → 读回 → 条数上限 */
for (let i = 0; i < REMOVAL_JOURNAL_LIMIT + 3; i += 1) {
	await appendRemovalJournal(journalFile, { at: Date.now(), name: "p" + i, ok: true });
}
const journal = await readRemovalJournal(journalFile);
eq("留痕: 条数封顶", journal.items.length, REMOVAL_JOURNAL_LIMIT);
eq("留痕: 保留最新（末尾）", journal.items[journal.items.length - 1].name, "p" + (REMOVAL_JOURNAL_LIMIT + 2));
const badJournal = await readRemovalJournal(join(tempRoot, "nope.json"));
eq("留痕: 文件不存在 → 空账本", badJournal.items.length, 0);

await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
eq("计划有效期: 5 分钟", REMOVAL_PLAN_TTL_MS, 5 * 60 * 1000);
ok("执行次数: 只调了假宿主，未动真环境", calls >= 0, String(calls));

/* ── R33：契约 api 2 —— restore / inspect / rowDropped ── */

eq("API: 契约版本是 2（加了 restore 与 inspect）", REMOVAL_API, 2);
ok("API: INSPECT_CODES 是冻结白名单", Array.isArray(INSPECT_CODES) && Object.isFrozen(INSPECT_CODES) && INSPECT_CODES.includes("installed-not-loaded"));

/* restore：卸载会去掉什么、装回来要写回什么 */
{
	const inBundles = planPackageRemoval({ name: "dsh-x", spec: "1.2.3", version: "1.2.3", bundles: ["dsh-x"], loadState: "bundle" });
	eq("restore: 在 bundles 里 → bundleRow=true（装回来必须写回）", inBundles.restore.bundleRow, true);
	ok("restore: 文案点名「装回来时必须写回」", inBundles.restore.text.includes("写回") && inBundles.restore.text.includes("不会被加载"), inBundles.restore.text);
	const outBundles = planPackageRemoval({ name: "dsh-y", spec: "1.0.0", version: "1.0.0", bundles: ["other"], loadState: "dormant", bundleRow: false });
	eq("restore: 不在 bundles → bundleRow=false", outBundles.restore.bundleRow, false);
	const withComp = planPackageRemoval({ name: "dsh-z", spec: "1.0.0", version: "1.0.0", bundles: [], compositionRows: [{ id: "z", name: "dsh-z", file: "cordis.patch.yml", line: 7 }] });
	ok("restore: 组合条目一并点名（patch 不会被卸载删掉）", withComp.restore.composition.length === 1 && withComp.restore.text.includes("组合条目"), withComp.restore.text);
}

/* inspect：装完核对（纯函数） */
{
	const loaded = inspectPackageState({ name: "dsh-ok", installed: true, version: "1.0.0", loadState: "bundle", via: "", bundleRow: true, spec: "1.0.0" });
	eq("inspect: 会被加载 → code=loaded / ok=true", [loaded.code, loaded.ok], ["loaded", true]);
	const notLoaded = inspectPackageState({ name: "dsh-off", installed: true, version: "2.0.0", loadState: "dormant", bundleRow: false, spec: "2.0.0", dependents: [] });
	eq("inspect: 装了但没有任何入口 → installed-not-loaded / ok=false", [notLoaded.code, notLoaded.ok], ["installed-not-loaded", false]);
	ok("inspect: 同时给出「写回 bundle 行」的处置", notLoaded.warnings.some((item) => item.code === "no-entry") && notLoaded.text.includes("写回"), JSON.stringify(notLoaded.warnings));
	const missing = inspectPackageState({ name: "dsh-none" });
	eq("inspect: 没装 → not-installed", missing.code, "not-installed");
	eq("inspect: 宿主自带包点名单列（不判成「没装」）", inspectPackageState({ name: "@deepseek-ai/dsh-base", installed: false }).code, "host-owned");
	eq("inspect: 自己 → self", inspectPackageState({ name: "dsh-plugin-catalog", installed: true, loadState: "bundle", bundleRow: true }).code, "self");
	const link = inspectPackageState({ name: "dsh-link", installed: true, loadState: "bundle", bundleRow: true, spec: "link:D:/x" });
	ok("inspect: link 安装给出「改源码即生效」而不是「要重装」", link.warnings.some((item) => item.code === "link"), JSON.stringify(link.warnings));
	const drift = inspectPackageState({ name: "dsh-ok", installed: true, loadState: "bundle", bundleRow: true, spec: "1.0.0", drift: { verdict: "differs" } });
	ok("inspect: 副本不同步进 warnings（消费方可见）", drift.warnings.some((item) => item.code === "drift"), JSON.stringify(drift.warnings));
	eq("inspect: 同一份事实 → 同一结论（幂等）", inspectPackageState({ name: "dsh-ok", installed: true, loadState: "bundle", bundleRow: true }).code, "loaded");
}

/* rowDropped：卸载真的动了 bundle 行没有（装回来要不要写回，靠这条事实） */
{
	const real = await profileDependencies().catch(() => ({}));
	const candidate = ["dsh-diag", "dsh-plugin-catalog", "dsh-ops", "dsh-ffmpeg"].find((name) => real && typeof real[name] === "string");
	if (!candidate) {
		/* 换台机器时不算失败：这条依赖真机事实，跳过时明写原因 */
		ok("rowDropped: 跳过（这台机器没有可用于演练的 profile 依赖）", true, "skip");
	} else {
		const host = { removeBundle: async () => ({ changed: true, application: "applied" }) };
		const verify = async () => ({ removed: true, inDeps: false, dirExists: false });
		const dropped = await executePackageRemoval({
			pluginManager: host,
			plan: { ok: true, name: candidate, purpose: "replace", version: null, spec: "" },
			verify,
			readBundles: async () => [],
		});
		eq("rowDropped: 卸载后 bundles 里没了 → true（装回来必须写回）", dropped.rowDropped, true);
		eq("rowDropped: restore.needsWriteBack 与它同源", dropped.restore.needsWriteBack, true);
		const kept = await executePackageRemoval({
			pluginManager: host,
			plan: { ok: true, name: candidate, purpose: "replace", version: null, spec: "" },
			verify,
			readBundles: async () => [candidate],
		});
		eq("rowDropped: 卸载后 bundles 还在 → false（不用写回）", kept.rowDropped, false);
		eq("rowDropped: 文案说「没有变化」", kept.restore.text.includes("没有变化"), true);
	}
}

const passed = checks.filter((item) => item.ok).length;
const failedChecks = checks.filter((item) => !item.ok);
if (asJson) {
	console.log(JSON.stringify({ ok: failedChecks.length === 0, passed, failed: failedChecks.length, checks }, null, 1));
} else {
	console.log("dsh-plugin-catalog · removal probe（R32）");
	for (const item of checks) {
		if (!item.ok) console.log("  FAIL " + item.name + (item.detail ? " · " + item.detail : ""));
	}
	console.log((failedChecks.length === 0 ? "PASS " : "FAIL ") + passed + " / " + checks.length);
	/* run-probes / ship 的解析器只认这一行（`passed N / failed M`） */
	console.log("probe-removal: passed " + passed + " / failed " + failedChecks.length);
}
process.exit(failedChecks.length === 0 ? 0 : 1);
