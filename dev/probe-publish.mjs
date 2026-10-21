/**
 * dev/probe-publish.mjs — 只读预演上传计划（**不建仓、不提交、不推送**）。
 *
 * 它做的事就是面板上点「上传备份到 GitHub」后的第一步：
 *   扫盘 → 判断每个仓该 create/update/up-to-date → 密钥扫描 → README 英文版需求。
 *
 * 用法（需要能 spawn git/gh 的环境）：
 *   node dev/probe-publish.mjs [--verbose]
 */

import { buildCatalog } from "../lib/catalog.mjs";
import { planUpload } from "../lib/publish.mjs";
import { dataDir as dataDirOf } from "../lib/hostinfo.js";
import { loadSettings, skillsStageDirOf } from "../lib/settings.mjs";
import { workspaceRoot } from "../lib/hostinfo.js";

const verbose = process.argv.includes("--verbose");
const dataDir = dataDirOf();
const settings = await loadSettings(dataDir);
const workspace = workspaceRoot(settings.workspace);

console.log("dataDir:", dataDir);
console.log("workspace:", workspace);

const catalog = await buildCatalog({ dataDir, settings, force: true });
console.log(
	"catalog:",
	JSON.stringify(catalog.counts),
);

const started = Date.now();
const plan = await planUpload({
	catalog,
	settings: { ...settings, skillsStageDir: skillsStageDirOf(settings, workspace) },
});
const elapsed = Date.now() - started;

console.log("");
console.log("=== 计划摘要（耗时 " + elapsed + "ms）===");
console.log("gh 用户:", plan.login || "(未登录)");
console.log(JSON.stringify(plan.summary));

const byAction = {};
for (const item of plan.items) {
	byAction[item.action] = byAction[item.action] || [];
	byAction[item.action].push(item);
}

for (const action of ["create", "update", "up-to-date", "blocked-secrets", "error"]) {
	const list = byAction[action] || [];
	if (list.length === 0) continue;
	console.log("");
	console.log("--- " + action + " (" + list.length + ") ---");
	for (const item of list) {
		console.log("  " + item.repo.padEnd(34), item.kind === "skills" ? "Skill 集合" : item.source, "|", (item.reasons || []).join("；").slice(0, 110));
		if (item.scan && item.scan.hits.length > 0) {
			const top = item.scan.hits.slice(0, verbose ? 8 : 2);
			for (const hit of top) console.log("      ⚠ " + hit.file + ":" + hit.line + " " + hit.rule + " " + hit.sample + " —— " + hit.plain);
			if (item.scan.hits.length > top.length) console.log("      … 另有 " + (item.scan.hits.length - top.length) + " 条");
		}
	}
}

console.log("");
console.log("未推（有阻断级命中）:", plan.summary.blocked);
console.log("需要生成英文 README:", plan.summary.readmeNeedingEnglish);
console.log("");
console.log("本文件只出计划：没有 git init / commit / 建仓 / push。真推要走 catalog_publish action=apply + confirm。");
