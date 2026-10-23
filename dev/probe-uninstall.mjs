/**
 * dev/probe-uninstall.mjs — 独立复核「处置清单」本身对不对（R14）。
 *
 * ★ 为什么要有它：清单里每一条都可以被人照着跑（删目录、改 profile 的 dependencies），
 *   所以它比"显示数字"危险得多。判据（dormant 四态）已经有 probe-loadstate 在证伪，
 *   这里证伪的是**计划**：
 *     I8  覆盖与不重叠：每个候选目录恰好落在一个组里，组内不重复，组成员数之和 = 候选数
 *     I9  体积口径：链接的"可回收"必须是 0（删链接不省空间）；量不到必须带原因，不许填 0；
 *         组和 = 成员之和
 *     I10 钉住键安全：别名 / 同项目第二份的成员，**不得**把"正在加载的那份"的包名列为可摘键
 *         （本机 `ghbackup` 与 `dsh-github-backup` 是同一个 link 依赖的两个键，摘错就删掉正在用的那份）
 *     I11 不误伤加载路径：每个成员要么是 dormant 包，要么是"同一项目的另一份安装"（包本身会被加载）
 *
 * 用法：
 *   node dev/probe-uninstall.mjs           # 人读：分组 + 体积 + 不变式结论
 *   node dev/probe-uninstall.mjs --json    # 机器读：一段 JSON
 *
 * 退出码：0 全部成立 / 1 有不变式被破坏（或环境不可用）。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { profileBundles, profileComposition, profileDir, profileNodeModules, workspaceRoot } from "../lib/hostinfo.js";
import { parseComposition, resolveLoadPaths, scanInstalledPackages } from "../lib/loadstate.mjs";
import { PROVENANCE, buildUninstallPlan } from "../lib/uninstall.mjs";
import { dirSize } from "../lib/service.mjs";

const asJson = process.argv.includes("--json");
const fmt = (bytes) => {
	const n = Number(bytes);
	if (!Number.isFinite(n) || n < 0) return "—";
	if (n < 1024) return n + " B";
	if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
	if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + " MB";
	return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
};

const nodeModules = profileNodeModules();
const profilePackage = JSON.parse(await readFile(join(profileDir(), "package.json"), "utf8"));
const profileDeps = profilePackage.dependencies && typeof profilePackage.dependencies === "object" ? profilePackage.dependencies : {};
const bundles = await profileBundles();
const composition = await profileComposition();
const compositions = composition.files.flatMap((file) => parseComposition(file.text));

const plan = await buildUninstallPlan({
	nodeModules,
	profileDeps,
	bundles,
	compositions,
	workspace: workspaceRoot(),
	sizeOf: (dir) => dirSize(dir),
});

/* 判据自己再算一遍（不读 plan 里的中间结论） */
const scanned = await scanInstalledPackages(nodeModules);
const loadPaths = resolveLoadPaths({ bundles, compositions, installed: scanned.installed });
const stateOf = (pkg) => loadPaths.byName.get(pkg)?.state || "dormant";
const loadedDeps = new Set();
for (const [name, deps] of scanned.installed) {
	if (stateOf(name) === "dormant") continue;
	for (const dep of deps) loadedDeps.add(dep);
}

const failures = [];
const members = (plan.groups || []).flatMap((group) => group.members.map((member) => ({ ...member, groupKey: group.key })));

/* ── I8 覆盖与不重叠 ── */
const seen = new Map();
for (const member of members) {
	if (seen.has(member.dirName)) failures.push(`I8 目录出现在多个组里：${member.dirName}（${seen.get(member.dirName)} / ${member.groupKey}）`);
	else seen.set(member.dirName, member.groupKey);
}
const groupSum = (plan.groups || []).reduce((sum, group) => sum + (Array.isArray(group.members) ? group.members.length : 0), 0);
if (groupSum !== members.length) failures.push(`I8 组成员数之和 ${groupSum} ≠ 摊平后的成员数 ${members.length}`);
if (members.length !== plan.dormant.dirCandidates) failures.push(`I8 成员数 ${members.length} ≠ 计划自述的候选目录数 ${plan.dormant.dirCandidates}`);
/* 候选目录必须正好是"dormant 包"或"同项目的另一份安装"，多一个少一个都说明判据漂了 */
for (const member of members) {
	const state = stateOf(member.pkg);
	const isDuplicate = member.provenance === "duplicate" || member.provenance === "alias-only";
	if (state === "dormant" && isDuplicate) failures.push(`I8 ${member.dirName} 的包是 dormant，却记成 ${member.provenance}`);
	if (state !== "dormant" && !isDuplicate) failures.push(`I8 ${member.dirName} 的包是 ${state}（会被加载），却当成可处置的 dormant`);
}

/* ── I9 体积口径 ── */
for (const group of plan.groups || []) {
	const sum = (group.members || []).reduce((total, member) => total + (Number.isFinite(member.reclaimBytes) ? member.reclaimBytes : 0), 0);
	if (sum !== group.reclaimBytes) failures.push(`I9 ${group.label} 组可回收 ${group.reclaimBytes} ≠ 成员之和 ${sum}`);
	for (const member of group.members || []) {
		if (!member.provenance || !PROVENANCE[member.provenance]) failures.push(`I9 ${member.dirName} 的分类 ${member.provenance} 不在 PROVENANCE 里`);
		if (member.link && member.reclaimBytes !== 0) failures.push(`I9 ${member.dirName} 是链接，可回收却是 ${member.reclaimBytes}（删链接不省空间）`);
		if (!member.link && member.bytes !== member.reclaimBytes) failures.push(`I9 ${member.dirName} 是实体目录，可回收 ${member.reclaimBytes} ≠ 实测 ${member.bytes}`);
		if (member.bytes === null && !member.sizeWhy) failures.push(`I9 ${member.dirName} 量不到体积却没给原因（不许填 0 糊过去）`);
		if (member.bytes === 0 && !member.link) failures.push(`I9 ${member.dirName} 是实体目录却量出 0 字节（可疑：空目录还是量错了？）`);
		if (member.link && !member.target) failures.push(`I9 ${member.dirName} 是链接但没解析出目标`);
	}
}

/* ── I10 钉住键安全 ── */
for (const member of members) {
	const alias = member.provenance === "duplicate" || member.provenance === "alias-only";
	if (!alias) continue;
	if ((member.profileKeys || []).includes(member.pkg)) {
		failures.push(`I10 ${member.dirName} 是别名目录，却把包名 ${member.pkg} 列成可摘键 —— 摘掉会删掉正在加载的那份`);
	}
	if (Object.prototype.hasOwnProperty.call(profileDeps, member.pkg) && !(member.keepKeys || []).some((entry) => entry.key === member.pkg)) {
		failures.push(`I10 ${member.dirName} 的包名 ${member.pkg} 写在 profile 依赖里，却没进「别动这些键」`);
	}
}

/* ── I11 不误伤加载路径 ── */
for (const member of members) {
	const alias = member.provenance === "duplicate" || member.provenance === "alias-only";
	if (alias) continue;
	if (loadedDeps.has(member.pkg)) failures.push(`I11 ${member.dirName}（包 ${member.pkg}）被某个会被加载的包声明依赖 —— 删了会弄坏加载`);
	if ((member.profileKeys || []).some((key) => bundles.includes(key))) failures.push(`I11 ${member.dirName} 的某个可摘键在 dsh.profile.bundles 里（那是入口，不能摘）`);
}

const payload = {
	ok: failures.length === 0,
	profile: profileDir(),
	nodeModules,
	groups: (plan.groups || []).length,
	candidates: members.length,
	dormantPackages: loadPaths.counts.dormant,
	reclaimBytes: plan.dormant.reclaimBytes,
	linkBytes: plan.dormant.linkBytes,
	nestedOnly: plan.dormant.nestedOnly,
	duplicateCopies: plan.dormant.duplicateCopies,
	pinnedKeys: members.flatMap((member) => member.profileKeys || []),
	detail: (plan.groups || []).map((group) => ({
		label: group.label,
		count: group.count,
		reclaimBytes: group.reclaimBytes,
		linkBytes: group.linkBytes,
		kinds: group.kinds,
		members: (group.members || []).map((member) => ({ dirName: member.dirName, pkg: member.pkg, provenance: member.provenance, reclaimBytes: member.reclaimBytes, bytes: member.bytes, link: member.link })),
	})),
	failures,
};

if (asJson) {
	console.log(JSON.stringify(payload, null, 1));
	process.exit(payload.ok ? 0 : 1);
}

console.log("ds-plugin-catalog / probe-uninstall（处置清单自检，R14）");
console.log("");
console.log("profile        : " + payload.profile);
console.log("node_modules   : " + payload.nodeModules);
console.log("候选目录 / 组  : " + payload.candidates + " / " + payload.groups + "（dormant 包 " + payload.dormantPackages + "）");
console.log("可回收 / 链接  : " + fmt(payload.reclaimBytes) + " / " + fmt(payload.linkBytes) + (payload.linkBytes > 0 ? "（链接目标，删链接不省）" : ""));
console.log("会摘的依赖键   : " + (payload.pinnedKeys.length > 0 ? payload.pinnedKeys.join("、") : "无"));
console.log("嵌套专属 dormant: " + (payload.nestedOnly.length > 0 ? payload.nestedOnly.join("、") : "无"));
console.log("");
for (const group of payload.detail) {
	console.log("· " + group.label + "　" + group.count + " 个 · 可回收 " + fmt(group.reclaimBytes) + " · " + group.kinds.join("/"));
	for (const member of group.members.slice(0, 8)) {
		console.log("    " + member.dirName.padEnd(44) + (member.link ? "→链接  " : "       ") + "[" + member.provenance + "] " + fmt(member.reclaimBytes));
	}
	if (group.members.length > 8) console.log("    … 还有 " + (group.members.length - 8) + " 个");
}
console.log("");
if (failures.length > 0) {
	console.log("✗ 不变式被破坏（" + failures.length + " 条）：");
	for (const failure of failures) console.log("  · " + failure);
	process.exit(1);
}
console.log("✓ 四条不变式全部成立（I8 覆盖与不重叠 / I9 体积口径 / I10 钉住键安全 / I11 不误伤加载路径）");
