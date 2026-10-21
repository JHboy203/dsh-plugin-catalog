/**
 * review.mjs — 每周两件事：**缺口分析** 与 **安全审核**。
 *
 * 分工原则（省 token，也可复核）：
 *   · **确定性扫描先出证据**：文件清单、README 标题、package.json 依赖、
 *     工作流里的危险关键字与**行号** —— 这些不花 token，也不会编；
 *   · **模型只做判读**：给每条证据一个判断、置信度、以及「可采纳 / 可拒绝」的说明。
 *
 * 已知边界（必须如实告诉用户，不能假装有）：
 *   私有仓拿不到 GitHub 的 Secret Scanning / Dependabot / Push Protection（需付费 GHAS），
 *   所以「依赖已知高危」只能靠本地 grep + 模型常识，**准确度低于平台级扫描**。
 *
 * @module dsh-plugin-catalog/review
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { gapAnalysis, securityReview } from "./ai.mjs";
import { analyzeReadme, listFilesForAudit } from "./readme.mjs";
import { readJson, writeJson } from "./store.mjs";

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** 工作流里的危险模式（确定性证据）。 */
export const WORKFLOW_RULES = [
	{ id: "pull-request-target", re: /\bpull_request_target\b/, severity: "high", note: "pull_request_target：有写权限 + 可能跑 fork 代码" },
	{ id: "workflow-run", re: /\bworkflow_run\b/, severity: "medium", note: "workflow_run：可拿到上游 artifact，注意别执行不受信内容" },
	{ id: "checkout-pr-head", re: /refs\/pull\/|\$\{\{\s*github\.event\.pull_request\.head/, severity: "high", note: "检出了 PR 分支头（配合 pull_request_target 就是典型提权路径）" },
	{ id: "write-all", re: /permissions\s*:\s*write-all/, severity: "high", note: "GITHUB_TOKEN 给到 write-all" },
	{ id: "shell-interpolate", re: /run:\s*[^\n]*\$\{\{\s*github\.event\./, severity: "medium", note: "把事件字段直接拼进 run:（脚本注入面）" },
];

/** 源码里的可疑模式（确定性证据）。 */
export const CODE_RULES = [
	{ id: "eval", re: /\beval\s*\(/, severity: "medium", note: "eval" },
	{ id: "new-function", re: /new\s+Function\s*\(/, severity: "medium", note: "new Function（动态代码）" },
	{ id: "exec-concat", re: /\b(exec|execSync)\s*\(\s*[`'"]\s*[^`'"]*\$\{/, severity: "high", note: "把变量拼进 exec 命令串" },
	{ id: "child-process", re: /\b(child_process|execFile|spawnSync|execSync)\b/, severity: "low", note: "使用了子进程（多数插件本来就需要，仅作线索）" },
];

/** 宿主核心包：写进 dependencies 会遮蔽宿主（这是真实的踩坑点，不是理论风险）。 */
export const HOST_CORE_PREFIXES = ["@deepseek-ai/dsh-tools", "@deepseek-ai/dsh-agent", "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-app-boot"];
export const HOST_CORE_SCOPE = "@deepseek-ai/";

export function weeklyFile(dataDir) {
	return join(dataDir, "weekly.json");
}

/** 读每周任务状态。 */
export async function loadWeekly(dataDir) {
	const raw = await readJson(weeklyFile(dataDir), null);
	return {
		lastGapAt: Number(raw?.lastGapAt) || 0,
		/* 「尝试时间」与「成功时间」分开存：失败也要退避，否则面板每次轮询都会重试 */
		lastGapAttemptAt: Number(raw?.lastGapAttemptAt) || 0,
		lastSecurityAt: Number(raw?.lastSecurityAt) || 0,
		gap: raw?.gap ?? null,
		security: raw?.security ?? null,
	};
}

export async function saveWeekly(dataDir, state) {
	await writeJson(weeklyFile(dataDir), { ...state, savedAt: Date.now() });
}

export function isDue(lastAt, now = Date.now()) {
	return !lastAt || now - lastAt >= WEEK_MS;
}

/* ───────────────────────── 证据采集（确定性） ───────────────────────── */

async function readIfExists(file) {
	try {
		return await readFile(file, "utf8");
	} catch {
		return null;
	}
}

async function readPackageJson(dir) {
	const text = await readIfExists(join(dir, "package.json"));
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/**
 * 缺口分析材料。
 * @param {string} dir
 * @param {object} entry
 */
export async function gatherGapMaterial(dir, entry) {
	const pkg = await readPackageJson(dir);
	const readme = await analyzeReadme(dir);
	const files = await listFilesForAudit(dir);
	const headings = (readme.zhText || "")
		.split("\n")
		.filter((line) => /^#{1,6}\s/.test(line))
		.map((line) => line.trim())
		.slice(0, 40);

	const dependencies = pkg && pkg.dependencies ? Object.keys(pkg.dependencies) : {};
	const hostCoreInDeps = Object.keys(dependencies).filter((name) => HOST_CORE_PREFIXES.includes(name) || name.startsWith(HOST_CORE_SCOPE));

	const buildArtifacts = files.filter((file) => /^(dist|build|out)\//.test(file) || /\.(exe|asar|min\.js)$/.test(file)).slice(0, 20);
	const skillFile = await readIfExists(join(dir, "SKILL.md"));
	const hasLicense = files.some((file) => /^LICENSE/i.test(file));
	const hasGitignore = files.some((file) => /^\.gitignore$/.test(file));

	return {
		name: entry.name,
		kind: entry.kind,
		readmeHeadings: headings,
		readmeChars: (readme.zhText || "").length,
		hasReadme: readme.hasReadme,
		filesCount: files.length,
		files: files.slice(0, 80),
		hasLicense,
		hasGitignore,
		buildArtifacts,
		hostCoreInDeps,
		packageName: pkg?.name || "",
		packageVersion: pkg?.version || "",
		dependencies: Object.keys(dependencies).slice(0, 40),
		devDependencies: pkg?.devDependencies ? Object.keys(pkg.devDependencies).slice(0, 20) : [],
		hasSelfInstallCommand: typeof pkg?.dsh?.install === "string" || typeof pkg?.scripts?.install === "string",
		mainField: pkg?.main || "",
		skillDescription: skillFile ? (skillFile.match(/description:\s*([\s\S]{0,600}?)(?:\n[A-Za-z-]+:|$)/)?.[1] || "").trim().slice(0, 500) : "",
	};
}

/**
 * 安全审核材料。
 * @param {string} dir
 * @param {object} entry
 */
export async function gatherSecurityMaterial(dir, entry) {
	const workflowDir = join(dir, ".github", "workflows");
	let workflowFiles = [];
	try {
		workflowFiles = (await readdir(workflowDir)).filter((name) => /\.ya?ml$/i.test(name));
	} catch {
		workflowFiles = [];
	}

	const workflowHits = [];
	let workflowYaml = "";
	for (const name of workflowFiles.slice(0, 6)) {
		const path = join(workflowDir, name);
		const text = await readIfExists(path);
		if (!text) continue;
		workflowYaml += `\n# ── ${name} ──\n` + text.slice(0, 3000);
		const lines = text.split("\n");
		for (const rule of WORKFLOW_RULES) {
			lines.forEach((line, index) => {
				if (rule.re.test(line)) workflowHits.push({ file: ".github/workflows/" + name, line: index + 1, rule: rule.id, severity: rule.severity, note: rule.note, text: line.trim().slice(0, 160) });
			});
		}
	}

	/* 源码里的可疑点：只看 js/mjs/cjs，有上界 */
	const suspiciousHits = [];
	const files = await listFilesForAudit(dir, 200);
	for (const file of files) {
		if (file.endsWith("/")) continue;
		if (!/\.(m?js|cjs)$/i.test(file)) continue;
		if (suspiciousHits.length >= 40) break;
		const text = await readIfExists(join(dir, file));
		if (!text || text.length > 400_000) continue;
		const lines = text.split("\n");
		for (const rule of CODE_RULES) {
			for (let index = 0; index < lines.length; index += 1) {
				if (!rule.re.test(lines[index])) continue;
				suspiciousHits.push({ file, line: index + 1, rule: rule.id, severity: rule.severity, note: rule.note, text: lines[index].trim().slice(0, 160) });
				break; // 同一文件同一规则只记一行，够定位
			}
		}
	}

	const permissionsDeclared = /^\s*permissions\s*:/m.test(workflowYaml);
	const pkg = await readPackageJson(dir);
	return {
		name: entry.name,
		workflowPath: workflowFiles.length > 0 ? ".github/workflows/" + workflowFiles[0] : "",
		workflowFiles,
		workflowYaml: workflowYaml.slice(0, 6000),
		workflowHits,
		suspiciousHits,
		permissionsDeclared,
		dependencies: pkg?.dependencies ? Object.entries(pkg.dependencies).slice(0, 40).map(([name, version]) => name + "@" + version) : [],
		note: "私有仓没有平台级漏洞扫描（Secret Scanning / Dependabot / Push Protection 需付费 GHAS），依赖高危只能靠本地判断，准确度低于平台级扫描。",
	};
}

/* ───────────────────────── 批量执行 ───────────────────────── */

/** 哪些条目值得跑缺口分析：自写与混血（别把官方的 README 也审一遍）。 */
export function reviewableEntries(catalog) {
	return (catalog.plugins || []).filter((entry) => entry.source === "self" || entry.source === "hybrid");
}

/**
 * 跑缺口分析（每仓一次模型调用；有上界）。
 *
 * @param {object} ctx
 * @param {object} catalog
 * @param {{model?:object, maxRepos?:number, onProgress?:(p:object)=>void}} [options]
 */
export async function runGapAnalysis(ctx, catalog, options = {}) {
	const maxRepos = Number(options.maxRepos) > 0 ? Number(options.maxRepos) : 12;
	const entries = reviewableEntries(catalog).slice(0, maxRepos);
	const results = [];
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		options.onProgress?.({ phase: "gap", done: index, total: entries.length, name: entry.name });
		try {
			const material = await gatherGapMaterial(entry.realDir, entry);
			const analysis = await gapAnalysis(ctx, material, { model: options.model });
			results.push({
				name: entry.name,
				id: entry.id,
				ok: analysis.ok,
				model: analysis.model,
				summary: analysis.summary || "",
				findings: analysis.findings || [],
				error: analysis.error || "",
				deterministic: {
					hostCoreInDeps: material.hostCoreInDeps,
					missingLicense: !material.hasLicense,
					missingGitignore: !material.hasGitignore,
					buildArtifacts: material.buildArtifacts,
					readmeHeadings: material.readmeHeadings.length,
				},
			});
		} catch (error) {
			/* ★ 单仓失败不能拖垮整批：否则一个坏包会让"每周缺口分析"永远没有结果 */
			results.push({ name: entry.name, id: entry.id, ok: false, model: "", summary: "", findings: [], error: String(error?.message ?? error) });
		}
	}
	options.onProgress?.({ phase: "gap", done: entries.length, total: entries.length, name: "" });
	return { ranAt: Date.now(), repos: results.length, results };
}

/**
 * 跑安全审核。
 *
 * @param {object} ctx
 * @param {object} catalog
 * @param {{model?:object, maxRepos?:number, onProgress?:(p:object)=>void}} [options]
 */
export async function runSecurityAudit(ctx, catalog, options = {}) {
	const maxRepos = Number(options.maxRepos) > 0 ? Number(options.maxRepos) : 12;
	const entries = reviewableEntries(catalog).slice(0, maxRepos);
	const results = [];
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		options.onProgress?.({ phase: "security", done: index, total: entries.length, name: entry.name });
		try {
			const material = await gatherSecurityMaterial(entry.realDir, entry);
			/* 没有任何确定性证据就不调模型：省一次调用，也避免模型硬凑发现 */
			const hasEvidence = material.workflowHits.length > 0 || material.suspiciousHits.some((hit) => hit.severity !== "low");
			let analysis = { ok: true, findings: [], model: "" };
			if (hasEvidence) analysis = await securityReview(ctx, material, { model: options.model });
			results.push({
				name: entry.name,
				id: entry.id,
				ok: analysis.ok,
				model: analysis.model,
				findings: analysis.findings || [],
				skippedModel: !hasEvidence,
				evidence: {
					workflowHits: material.workflowHits.length,
					suspiciousHits: material.suspiciousHits.length,
					permissionsDeclared: material.permissionsDeclared,
					workflowFiles: material.workflowFiles,
				},
				boundary: material.note,
				error: analysis.error || "",
			});
		} catch (error) {
			/* 单仓失败不拖垮整批（同上） */
			results.push({ name: entry.name, id: entry.id, ok: false, model: "", findings: [], skippedModel: false, evidence: null, boundary: "", error: String(error?.message ?? error) });
		}
	}
	options.onProgress?.({ phase: "security", done: entries.length, total: entries.length, name: "" });
	return { ranAt: Date.now(), repos: results.length, results };
}

/** 汇总：把结果压成面板/工具可读的一页摘要。 */
export function summarizeReport(report) {
	if (!report) return { repos: 0, high: 0, medium: 0, low: 0, items: [] };
	const items = [];
	let high = 0;
	let medium = 0;
	let low = 0;
	for (const repo of report.results || []) {
		for (const finding of repo.findings || []) {
			const severity = finding.severity || "low";
			if (severity === "high") high += 1;
			else if (severity === "medium") medium += 1;
			else low += 1;
			items.push({ repo: repo.name, ...finding });
		}
	}
	return { ranAt: report.ranAt, repos: report.repos, high, medium, low, items };
}

/** 判断一个目录里的文件是否存在（小工具）。 */
export async function exists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}
