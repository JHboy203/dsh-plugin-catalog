/**
 * dev/measure-layers.mjs — **组合层取证**（真机，只读）：一次回答"我是不是读少了"。
 *
 * ★ 为什么要有它（R33 真机）：DSH 0.2.1-rc.3 把 `profile\cordis.yml` 改成**空入口表**，
 *   树改由「每个 bundle 自带的 patch」拼出来。只读 profile 两份文件的旧判据因此从 246 条掉到 24 条
 *   （官方 asar 187 → 14）—— **不报错、只改数字**。当时是靠一段一次性的 node -e 脚本才看清的。
 *   这个脚本把那次的取证固化下来：下次宿主再换模型，先跑它，一眼看出"层在哪、我读了几层、少读多少"。
 *
 * ★ 它输出三样东西：
 *   ① **层清单**：每层的 role / source（profile|asar）/ 条目数 / 其中 `- insert:` 条目数；
 *   ② **合并后口径**：模型（flat / bundle-layers / empty）、解析数、生效数、按层分布；
 *   ③ **对照**：如果只按旧判据（profile 两份文件）会读到多少条 —— 差多少就是"模型换了"的信号。
 *
 * 用法：
 *   node dev/measure-layers.mjs            # 人读
 *   node dev/measure-layers.mjs --json     # 给脚本读
 * 退出码：0 = 层齐全（没有读不到的层）；1 = 有层读不到 / 明显读少（root 0 条且 bundle 层也 0 条）。
 *
 * ★ 纯 node 环境读不到 asar（`resourcesPath` 为空），asar 里的 7~8 层会记进 `missing` ——
 *   这是**如实**（不是失败）；要看完整口径就在宿主里跑：`host_selfcheck script=dev/measure-layers.mjs`。
 */

import { existsSync } from "node:fs";

import { listAsarPackageNames, asarPath, asarMode } from "../lib/asar.mjs";
import { auditComposition, parseComposition, summarizeComposition } from "../lib/composition.mjs";
import { profileBundles, profileComposition, profileNodeModules } from "../lib/hostinfo.js";
import { scanInstalledPackages } from "../lib/loadstate.mjs";
import { collectCompositionLayers } from "../lib/patches.mjs";

const asJson = process.argv.includes("--json");

/** 旧判据：只解析 profile 自己那两份文件（R22 之前的口径，用来做对照）。 */
function legacyEntries(files) {
	const parsed = files.flatMap((file) => parseComposition(file.text, { file: file.file }));
	const ids = new Map();
	for (const entry of parsed) {
		const id = entry.id || entry.name || "";
		if (id) ids.set(id, entry);
	}
	return { parsed: parsed.length, effective: ids.size };
}

const bundles = await profileBundles().catch(() => []);
const collected = await collectCompositionLayers({ bundles });
const layers = collected.files;
const installed = await scanInstalledPackages(profileNodeModules())
	.then((scan) => scan.installed)
	.catch(() => new Map());
const archive = asarPath();
const report = auditComposition({
	files: layers.map((file) => ({ file: file.file, text: file.text, role: file.role, source: file.source, bundle: file.bundle })),
	bundles,
	installed,
	asarNames: listAsarPackageNames(archive),
	missing: collected.missing,
});
const profile = await profileComposition().catch(() => ({ files: [] }));
const legacy = legacyEntries(profile.files || []);

const rows = layers.map((file) => ({
	role: file.role,
	source: file.source,
	bundle: file.bundle,
	file: String(file.file || "").replace(/\\\\/g, "/").split("/").slice(-2).join("/"),
	entries: parseComposition(file.text, { file: file.file }).length,
}));
const byRole = report.counts.byRole;
const layerFiles = rows.filter((row) => row.role === "bundle-patch");
const asarLayers = layerFiles.filter((row) => row.source === "asar").length;

const verdict =
	collected.missing.length > 0
		? "warn"
		: report.model === "bundle-layers" && layerFiles.length === 0
			? "bad"
			: report.model === "flat" && byRole.root === 0 && layerFiles.length === 0
				? "bad"
				: "ok";

const summary = {
	at: new Date().toISOString(),
	model: report.model,
	asar: { path: archive || "", mode: archive ? asarMode(archive) : "none", readable: report.asarReadable },
	bundles: { declared: bundles.length, layerFiles: layerFiles.length, fromAsar: asarLayers },
	layers: { total: rows.length, root: byRole.root, bundle: byRole["bundle-patch"], profile: byRole["profile-patch"], missing: collected.missing },
	merged: { parsed: report.counts.parsed, effective: report.counts.effective, inserted: report.counts.inserted },
	legacy: { parsed: legacy.parsed, effective: legacy.effective },
	gap: legacy.effective === 0 ? null : Math.round(((report.counts.effective - legacy.effective) / legacy.effective) * 100),
	verdict,
	line: summarizeComposition(report),
};

if (asJson) {
	console.log(JSON.stringify({ ...summary, rows }, null, 1));
} else {
	console.log("组合层取证（只读）· " + (archive ? "asar " + summary.asar.mode : "asar 读不到"));
	console.log("");
	console.log("层：" + rows.length + " 份（root " + byRole.root + " 条 / bundle 层 " + layerFiles.length + " 份 " + byRole["bundle-patch"] + " 条（asar " + asarLayers + " 份） / profile patch " + byRole["profile-patch"] + " 条）");
	console.log("模型：" + report.model + "　｜　合并：解析 " + report.counts.parsed + " → 生效 " + report.counts.effective + "（insert " + report.counts.inserted + " 条）");
	console.log("旧判据（只读 profile 两份文件）会读到：" + legacy.effective + " 条" + (summary.gap === null ? "" : "　→ 差 " + summary.gap + "%"));
	if (collected.missing.length > 0) console.log("读不到的层：" + collected.missing.length + " 份（" + collected.missing.slice(0, 6).join("、") + (collected.missing.length > 6 ? " 等" : "") + "）——纯 node 里读不到 asar 是正常的，宿主里跑才是完整口径");
	console.log("");
	console.log(summary.line);
	console.log("");
	for (const row of rows.filter((item) => item.role !== "bundle-patch")) console.log("  · [" + row.role + "/" + row.source + "] " + row.file + " — " + row.entries + " 条");
	for (const row of layerFiles.slice(0, 12)) console.log("  · [bundle/" + row.source + "] " + (row.bundle || row.file) + " — " + row.entries + " 条");
	if (layerFiles.length > 12) console.log("  · ……（bundle 层共 " + layerFiles.length + " 份；--json 看全部）");
	console.log("");
	console.log("结论：" + (verdict === "ok" ? "层齐全，模型与入口来源一致" : verdict === "warn" ? "有层读不到（先确认是不是纯 node 环境）" : "明显读少了：入口表 0 条且没有 bundle 层 —— 先查 bundles 与 patch 文件"));
	if (!existsSync(profileNodeModules() || "")) console.log("⚠️ profile 的 node_modules 不存在——这台机器可能没有 profile");
}

process.exit(verdict === "ok" || verdict === "warn" ? 0 : 1);
