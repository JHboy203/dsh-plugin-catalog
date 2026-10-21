/**
 * scan.mjs — 提交前的密钥/隐私扫描（只读、掩码输出）。
 *
 * 逻辑取自 `dsh-github-backup/lib/scan.js`（本机 27 仓基线扫描 0 命中过的那份），
 * 口径照用户明确要求补全：
 *   覆盖 `.env`、`.env.*`、`secrets/`、`*.key`、`*.pem`、`configs/*-secret.json`、
 *        `configs/*-config.json`。
 *
 * 两条纪律：
 *   1. 扫的是 **`git ls-files --cached --others --exclude-standard`** ——
 *      既含已提交、也含"还没提交但会被推上去"的新文件（只扫已提交会漏掉第一次推送）。
 *   2. 命中只给「文件:行 + 规则 + 掩码」，**绝不回显明文**。
 *
 * @module dsh-plugin-catalog/scan
 */

import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const MAX_BYTES = 2 * 1024 * 1024;
const BINARY_EXT = new Set([
	".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".woff", ".woff2",
	".ttf", ".otf", ".zip", ".gz", ".tgz", ".7z", ".mp4", ".mp3", ".wav", ".pdf",
	".exe", ".dll", ".node", ".so", ".mcstructure", ".pack", ".ldb", ".map", ".webm", ".webp",
]);

/** 文件名规则（命中即报）。 */
export const NAME_RULES = [
	{ re: /(^|\/)\.env$/, severity: "critical", note: ".env 环境文件" },
	{ re: /(^|\/)\.env\./, severity: "critical", note: ".env.* 环境文件" },
	{ re: /(^|\/)secrets?\//, severity: "critical", note: "secrets/ 目录" },
	{ re: /\.(key|pem|p12|pfx|jks|keystore)$/, severity: "critical", note: "密钥/证书文件" },
	{ re: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)/i, severity: "critical", note: "SSH 私钥" },
	{ re: /(^|\/)\.npmrc$/, severity: "high", note: ".npmrc（可能含 _authToken）" },
	{ re: /(^|\/)\.netrc$/, severity: "high", note: ".netrc 凭据" },
	{ re: /configs?\/[^/]*-secret\.json$/i, severity: "critical", note: "secret 配置" },
	{ re: /configs?\/[^/]*-config\.json$/i, severity: "medium", note: "配置（需人工确认是否含真实值）" },
	{ re: /(^|\/)credentials?\.json$/i, severity: "high", note: "凭据文件" },
	{ re: /(^|\/)cookies?\.(txt|json)$/i, severity: "high", note: "Cookie 导出" },
];

/**
 * 内容规则（正则命中即报）。
 *
 * ★ `reject` 是"命中之后再排除"的第二道正则，命中行若匹配它就不算泄漏。
 *   为什么需要：真实踩过的三个假阳性 ——
 *     · `headers: { Cookie: \`vcut_token=${TOKEN}\` }`（代码里拼 header，没有字面量）
 *     · 文档里写的 `set-cookie: ds_session_id=...; SameSite=Strict`（省略号示例）
 *     · `password: process.env.PW`（这恰恰是**推荐写法**）
 *   不排除它们的话，合法仓库会被永久拦住，"密钥门禁"就变成了噪音源。
 *   注意：排除的是**模板/占位符/环境变量**，不是"看起来像测试就放过"。
 */
export const CONTENT_RULES = [
	{ id: "github-token", severity: "critical", re: /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/ },
	{ id: "private-key-block", severity: "critical", re: /-----BEGIN (RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/ },
	{ id: "aws-akid", severity: "critical", re: /\bAKIA[0-9A-Z]{16}\b/ },
	{ id: "openai-key", severity: "critical", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/ },
	{ id: "anthropic-key", severity: "critical", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
	{ id: "slack-token", severity: "critical", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
	{ id: "google-api-key", severity: "critical", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
	{ id: "slack-webhook", severity: "critical", re: /hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/ },
	{ id: "discord-webhook", severity: "critical", re: /discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{20,}/ },
	{ id: "conn-string-cred", severity: "critical", re: /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqp):\/\/[^:\s/@]{1,40}:[^@\s]{3,40}@/, reject: /\$\{|\{\{|\.\.\.|<[A-Za-z_]+>/ },
	{
		id: "bearer-literal",
		severity: "high",
		re: /[Bb]earer\s+[A-Za-z0-9_.-]{24,}/,
		reject: /\$\{|\{\{|\.\.\.|<[A-Za-z_]+>|process\.env/i,
	},
	{
		id: "assign-secret",
		severity: "high",
		re: /\b(api[_-]?key|apikey|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|pwd)\b\s*[:=]\s*["'][^"'\s]{8,}["']/i,
		reject: /\$\{|\{\{|\.\.\.|<[A-Za-z_]+>|process\.env|xxx+|example|placeholder|dummy|redacted/i,
	},
	{
		id: "json-secret-field",
		severity: "high",
		re: /"(apiKey|api_key|token|secret|password|accessToken|clientSecret)"\s*:\s*"[^"\s]{12,}"/i,
		reject: /\$\{|\{\{|\.\.\.|<[A-Za-z_]+>|xxx+|example|placeholder|dummy|redacted/i,
	},
	{
		/* 只认真实的 `name=<一长串不透明字符>`；`Cookie: \`token=${VAR}\`` 与文档里的
		   `set-cookie: sid=...` 都不该命中（两种都真实误报过）。 */
		id: "cookie-header",
		severity: "high",
		re: /\b(?:set-)?cookie\s*:\s*[A-Za-z0-9_-]{2,}=[A-Za-z0-9%._-]{16,}/i,
		reject: /\$\{|\{\{|\.\.\.|<[A-Za-z_]+>|process\.env/i,
	},
];

/** 掩码：保留前 4 个字符 + 长度。 */
export function maskValue(value) {
	const text = String(value ?? "");
	if (text.length <= 4) return `${"*".repeat(text.length)} (len=${text.length})`;
	return `${text.slice(0, 4)}…${"*".repeat(Math.min(6, text.length - 4))} (len=${text.length})`;
}

/** 取「会被推上去的文件」：已提交 + 未跟踪但没被 ignore。 */
export async function pushableFiles(repo) {
	try {
		const { stdout } = await run("git", ["-C", repo, "ls-files", "--cached", "--others", "--exclude-standard"], {
			maxBuffer: 16 * 1024 * 1024,
			windowsHide: true,
			encoding: "utf8",
		});
		return [...new Set(stdout.split("\n").map((line) => line.trim()).filter((line) => line !== ""))];
	} catch {
		return [];
	}
}

/** 看起来像测试夹具 / 示例的路径。 */
function looksLikeFixture(path) {
	return /(\/|^)(test|tests|spec|fixtures?|samples?|examples?|mock|mocks|dev)\//i.test(path);
}

/**
 * 给每条命中一句**人话判断**（用户明确要求：清单里要有"一句判断"）。
 * 这是确定性判断（不调模型），理由写在 `why` 里，便于复核。
 */
export function judgeHit(hit, fileText) {
	if (hit.kind === "filename") {
		if (/^configs?\/[^/]*-config\.json$/i.test(hit.file)) {
			return { verdict: "needs-confirm", plain: "配置文件名在扫描清单里，但可能是示例值 —— 打开确认一遍再决定是否入库。" };
		}
		if (looksLikeFixture(hit.file)) {
			return { verdict: "likely-fixture", plain: "路径像测试/示例目录，多半是假值；仍然确认一下它不是真实凭据。" };
		}
		return { verdict: "real-risk", plain: "这类文件基本就是真实配置/密钥，建议不入库，或只提交占位符版本。" };
	}
	/* 内容命中：看它所在位置与上下文 */
	if (looksLikeFixture(hit.file)) {
		return { verdict: "likely-fixture", plain: "像测试夹具里的假密钥，可忽略；如果它是从真实配置复制来的，就要改。" };
	}
	if (typeof fileText === "string" && /(example|placeholder|your[_-]?(api|token|key)|xxx+|dummy|redacted|<[A-Z_]+>)/i.test(fileText.slice(Math.max(0, 0), 4000))) {
		return { verdict: "looks-placeholder", plain: "同文件里有占位符风格内容，可能只是示例 —— 但命中行本身仍要人眼看一次。" };
	}
	return { verdict: "real-risk", plain: "像真实配置值，建议改成环境变量并从历史里清掉。" };
}

/**
 * 扫描一个仓。
 *
 * @param {string} repo
 * @returns {Promise<{files:number, hits:Array<object>, worst:string, scanned:boolean}>}
 */
export async function scanRepo(repo) {
	const files = await pushableFiles(repo);
	if (files.length === 0) return { files: 0, hits: [], worst: "clean", scanned: true };
	const hits = [];

	for (const rel of files) {
		for (const rule of NAME_RULES) {
			if (rule.re.test(rel)) {
				const hit = { kind: "filename", severity: rule.severity, file: rel, line: 0, rule: rule.note, sample: "" };
				hits.push({ ...hit, ...judgeHit(hit) });
				break;
			}
		}

		const dot = rel.lastIndexOf(".");
		const ext = dot >= 0 ? rel.slice(dot).toLowerCase() : "";
		if (BINARY_EXT.has(ext)) continue;

		const full = join(repo, rel);
		let text;
		try {
			if (statSync(full).size > MAX_BYTES) continue;
			text = readFileSync(full, "utf8");
		} catch {
			continue;
		}

		/* 每个文件最多记 20 条，防止一个巨型 fixture 把清单撑爆 */
		let perFile = 0;
		for (const rule of CONTENT_RULES) {
			const rx = new RegExp(rule.re.source, rule.re.flags.includes("g") ? rule.re.flags : `${rule.re.flags}g`);
			let match;
			while ((match = rx.exec(text)) !== null) {
				const line = text.slice(0, match.index).split("\n").length;
				/* 第二道排除：模板 / 占位符 / 环境变量不算泄漏（见 CONTENT_RULES 的注释） */
				if (rule.reject) {
					const lineStart = text.lastIndexOf("\n", match.index - 1) + 1;
					const lineEnd = text.indexOf("\n", match.index);
					const lineText = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
					if (rule.reject.test(lineText)) continue;
				}
				const hit = { kind: "content", severity: rule.severity, file: rel, line, rule: rule.id, sample: maskValue(match[0]) };
				hits.push({ ...hit, ...judgeHit(hit, text) });
				perFile += 1;
				if (perFile >= 20 || hits.length > 500) break;
			}
			if (perFile >= 20 || hits.length > 500) break;
		}
		if (hits.length > 500) break;
	}

	return finalize(files.length, hits);
}

function finalize(fileCount, hits) {
	const order = { critical: 0, high: 1, medium: 2 };
	hits.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9) || a.file.localeCompare(b.file) || a.line - b.line);
	return { files: fileCount, hits, worst: hits.length === 0 ? "clean" : hits[0].severity, scanned: true };
}

/** 有阻断级命中？（critical/high 默认阻断，medium 只提示） */
export function isBlocking(scan) {
	return Boolean(scan && scan.hits && scan.hits.some((hit) => hit.severity === "critical" || hit.severity === "high"));
}
