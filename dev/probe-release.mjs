/**
 * probe-release.mjs — **开源发版就绪**的独立探针（R36）。
 *
 * 为什么要有它：这一轮准备把仓库开放给别人下载，而"能不能拿出去"取决于一组**不会自己报错**的事实：
 *   · `package.json` 的 version 与 `client.js` 的 BUILD 对不上（装上去面板标签就是错的）；
 *   · 仓库里混进一条形似密钥的字符串（本插件自己的门禁也扫它，公开仓库上尤其难看）；
 *   · README 里少一个工具名 / 少一节安装说明（别人 clone 下来不会装）；
 *   · 新加的探针脚本没登记（发版体检静默少跑一条）。
 *
 * 口径三条（与 README / SKILL / 交接文件同一份真值）：
 *   ① 只读：不 spawn、不联网、不写盘；② 不读 `.git`（沙箱里 `git ls-files` 会 EPERM，改为遍历工作树并排除运行期目录）；
 *   ③ 密钥命中只给「文件:行 + 规则 + 掩码」，绝不回显明文。
 *
 * 用法：`node dev/probe-release.mjs [--json]`；破任一不变式退出码 1。
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";

import { buildCatalogTools } from "../lib/tools.mjs";
import { PROBES } from "./probe-list.mjs";
import { CONTENT_RULES, NAME_RULES, isBlocking, judgeHit, maskValue } from "../lib/scan.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const results = [];
function ok(name, condition, detail = "") {
	results.push({ name, pass: Boolean(condition), detail });
}
function read(rel) {
	try {
		return readFileSync(join(ROOT, rel), "utf8");
	} catch {
		return "";
	}
}
function readJson(rel) {
	try {
		return JSON.parse(read(rel));
	} catch {
		return null;
	}
}

/* ── ① 版本与包元数据 ── */
const pkg = readJson("package.json");
const client = read("client.js");
ok("P1 package.json 可解析且 name 是 dsh-plugin-catalog", Boolean(pkg) && pkg.name === "dsh-plugin-catalog", JSON.stringify(pkg && { name: pkg.name, version: pkg.version }));
const version = String(pkg?.version || "");
/* BUILD 的形状是 `r<minor>.<patch>`（历史如此：0.35.0 ↔ r35.0），不是完整 semver。 */
const build = (/const BUILD = "(r\d+\.\d+)";/.exec(client) || [])[1] || "";
const expectedBuild = "r" + version.split(".").slice(1).join(".");
ok("P2 version 是 semver，且与 client.js 的 BUILD 对得上（0.35.0 ↔ r35.0）", /^\d+\.\d+\.\d+$/.test(version) && build === expectedBuild, JSON.stringify({ version, build, expectedBuild }));
ok("P3 license = MIT，且 LICENSE 文件里有 MIT 正文", pkg?.license === "MIT" && /MIT License/i.test(read("LICENSE")) && /Permission is hereby granted/i.test(read("LICENSE")));
ok("P4 repository / homepage / bugs 指向真实仓库（别人能顺着装与提 issue）", /github\.com\/[^/]+\/dsh-plugin-catalog/.test(String(pkg?.repository?.url || "")) && /github\.com\/[^/]+\/dsh-plugin-catalog/.test(String(pkg?.homepage || "")) && /issues/.test(String(pkg?.bugs?.url || "")));
ok("P5 keywords 非空、engines.node 有下限", Array.isArray(pkg?.keywords) && pkg.keywords.length >= 4 && /^>=/.test(String(pkg?.engines?.node || "")));
const files = Array.isArray(pkg?.files) ? pkg.files : [];
ok(
	"P6 files[] 覆盖运行期必需项（入口 / 客户端 / lib / patch / 图标 / LICENSE / 双语文档）",
	["index.js", "client.js", "lib", "cordis.patch.yml", "icon.svg", "LICENSE", "README.md", "README.en.md"].every((name) => files.includes(name)),
	JSON.stringify(files),
);
ok("P7 运行期必需的 5 个文件都在盘上（files[] 写了但文件不在 = 发出去缺件）", ["index.js", "client.js", "cordis.patch.yml", "icon.svg", "LICENSE"].every((name) => existsSync(join(ROOT, name))));
ok("P8 icon.svg 是 SVG（面板图标不能是空文件）", /^\s*<svg[\s>]/i.test(read("icon.svg")));
ok("P9 cordis.patch.yml 存在且带 plugin-catalog 的条目 id", /plugin-catalog/.test(read("cordis.patch.yml")));

/* ── ② 双语文档：装、卸、能力、隐私、开源 ── */
const zh = read("README.md");
const en = read("README.en.md");
ok("P10 双语 README 都存在且 > 10 KB（不是占位骨架）", zh.length > 10 * 1024 && en.length > 10 * 1024, JSON.stringify({ zh: zh.length, en: en.length }));
ok("P11 中文 README 有 GitHub 安装 + 卸载 + 开源说明", zh.includes("git clone") && zh.includes("卸载") && zh.includes("开源版说明"));
ok("P12 英文 README 有 GitHub 安装 + Uninstall + open-source notes", /git clone/i.test(en) && /Uninstall/i.test(en) && /Open-source notes/i.test(en));
ok("P13 双语都提醒「不要用 pnpm」（本机踩过的 profile 覆写坑）", /不要用 pnpm/.test(zh) && /do not use pnpm/i.test(en));
ok("P14 双语都写了 R35 的两件事：运行期真相 + 卡片动作", /运行期真相/.test(zh) && /卡片底部直接操作/.test(zh) && /Runtime truth/.test(en) && /Card actions/.test(en));
ok("P15 双语都写了动作的安全模型（两段式 / 备份 / 回收站）", /两段式/.test(zh) && /回收站/.test(zh) && /自动回滚/.test(zh) && /Two-step/.test(en) && /backup/i.test(en) && /trash/i.test(en));
ok("P16 双语都写了数据与隐私（不含对话文本 / 不联网）", /没有任何对话文本/.test(zh) && /不联网/.test(zh) && /no conversation text/i.test(en) && /No telemetry/i.test(en));

/* 工具表逐个点名（两个语言都要） */
const tools = buildCatalogTools({ service: new Proxy({}, { get: () => async () => ({ ok: true }) }) });
ok("P17 工具定义可构造（14 个，含 catalog_runtime）", tools.length === 14 && tools.some((tool) => tool.name === "catalog_runtime"), String(tools.length));
ok(
	"P18 双语文档逐个点名每个 catalog_* 工具（加工具不忘写文档）",
	tools.every((tool) => zh.includes(tool.name) && en.includes(tool.name)),
	tools.filter((tool) => !zh.includes(tool.name) || !en.includes(tool.name)).map((tool) => tool.name).join(","),
);

/* 探针数 / 探针清单 */
const probeCount = PROBES.length;
ok(`P19 README 的探针数 == 清单真值（${probeCount} 个），且「串成一条」也一致`, zh.includes(`**${probeCount} 个独立探针**`) && zh.includes(`**${probeCount} 个探针串成一条**`));
const statedTotal = (/共\s*(\d+)\s*条/.exec(zh) || [])[1];
ok("P20 README 写的断言总数可解析（三处对账靠它）", Boolean(statedTotal), String(statedTotal));
ok("P21 探针清单里每个脚本都在盘上（清单写错路径 = 发版体检静默少跑）", PROBES.every((probe) => existsSync(join(ROOT, probe.file))));
ok("P22 README 提到三个新的真机/发版入口（runtime-live / actions-live / probe-release）", ["runtime-live.mjs", "actions-live.mjs", "probe-release.mjs"].every((name) => zh.includes(name)));

/* ── ③ 密钥与隐私（工作树，排除运行期目录；不 spawn git） ── */
const SKIP_DIRS = new Set(["node_modules", ".git", ".cache", ".state", "data", "dist", "coverage"]);
const TEXT_EXT = new Set([".js", ".mjs", ".cjs", ".json", ".md", ".yml", ".yaml", ".svg", ".txt", ".gitignore", ".npmrc", ".sh", ".ps1", ".cmd"]);
const BIN_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".zip", ".gz", ".tgz", ".exe", ".dll", ".node", ".pdf", ".map"]);
const MAX_BYTES = 1024 * 1024;
function walk(dir, out = [], depth = 0) {
	if (depth > 8) return out;
	let entries = [];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			walk(full, out, depth + 1);
		} else if (entry.isFile()) {
			out.push(full);
		}
	}
	return out;
}
const tree = walk(ROOT);
const scanned = [];
const nameHits = [];
for (const file of tree) {
	const rel = relative(ROOT, file).replace(/\\/g, "/");
	const base = rel.split("/").pop();
	const ext = extname(base).toLowerCase();
	for (const rule of NAME_RULES) {
		if (rule.re.test(rel) && (rule.severity === "critical" || rule.severity === "high")) nameHits.push({ file: rel, note: rule.note, severity: rule.severity });
	}
	if (BIN_EXT.has(ext)) continue;
	if (ext !== "" && !TEXT_EXT.has(ext) && base !== ".gitignore") continue;
	let info;
	try {
		info = statSync(file);
	} catch {
		continue;
	}
	if (info.size > MAX_BYTES) continue;
	let text = "";
	try {
		text = readFileSync(file, "utf8");
	} catch {
		continue;
	}
	scanned.push(rel);
	const lines = text.split(/\r?\n/);
	for (const rule of CONTENT_RULES) {
		for (let index = 0; index < lines.length; index += 1) {
			const line = lines[index];
			if (!rule.re.test(line)) continue;
			if (rule.reject && rule.reject.test(line)) continue;
			const hit = { kind: "content", file: rel, line: index + 1, rule: rule.id, severity: rule.severity, match: maskValue((line.match(rule.re) || [""])[0]) };
			if (rule.severity === "critical" || rule.severity === "high") {
				const verdict = judgeHit(hit, line);
				hit.verdict = verdict.verdict;
			}
			nameHits.push(hit);
			break;
		}
	}
}
ok("P23 工作树里没有密钥/证书类文件名（*.pem / *.key / .env / secrets/）", NAME_RULES.every((rule) => !(rule.severity === "critical" && tree.some((file) => rule.re.test(relative(ROOT, file).replace(/\\/g, "/"))))), nameHits.filter((hit) => hit.note).map((hit) => hit.file + "(" + hit.note + ")").join(", "));
ok("P24 文本文件内容扫描 0 条 critical/high 命中（只报掩码，不回显明文）", !nameHits.some((hit) => hit.severity === "critical" || hit.severity === "high"), nameHits.filter((hit) => hit.severity === "critical" || hit.severity === "high").slice(0, 5).map((hit) => hit.file + (hit.line ? ":" + hit.line : "") + " " + hit.rule + " " + hit.match).join(" | "));
ok("P25 扫描确实覆盖了源码与文档（不是空转：至少 60 个文本文件）", scanned.length >= 60, String(scanned.length));

/* ── ④ 卫生：绝对路径 / gitignore / 交付面 ── */
/* 只看**非注释行**：文档注释里出现 `C:\Users\<user>` 这种示例是正常的（说明"本机实测"），
   真正危险的是代码里写死路径（换台机器就找不到）。 */
const codeFiles = ["index.js", "client.js", ...tree.map((file) => relative(ROOT, file).replace(/\\/g, "/")).filter((rel) => /^lib\/.+\.(mjs|js)$/.test(rel))];
const codeOnly = (text) => text.split(/\r?\n/).filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
const absHits = codeFiles.filter((rel) => /[A-Za-z]:\\信息库|[A-Za-z]:\\Users[\\/]/.test(codeOnly(read(rel))));
ok("P26 交付代码里不写死本机绝对路径（index/client/lib 全部，注释除外）", absHits.length === 0, absHits.join(", "));
const ignore = read(".gitignore");
ok("P27 .gitignore 覆盖运行期产物与备份（node_modules / .cache / .state / *.log / *.bak-*）", ["node_modules/", ".cache/", ".state/", "*.log", "*.bak-*"].every((pattern) => ignore.includes(pattern)), ignore.replace(/\n/g, " "));
ok("P28 npm files[] 不把 dev/ 打进去（自检脚本属于仓库，不属于安装包）", !files.includes("dev") && !files.some((name) => String(name).startsWith("dev/")));

const failed = results.filter((item) => !item.pass);
if (process.argv.includes("--json")) {
	console.log(JSON.stringify({ probe: "release", passed: results.length - failed.length, failed: failed.length, scanned: scanned.length, hits: nameHits, results }, null, 1));
} else {
	console.log("");
	console.log("probe-release (R36)");
	console.log("  scanned: " + scanned.length + " text files");
	console.log("  passed: " + (results.length - failed.length));
	console.log("  failed: " + failed.length);
	if (failed.length > 0) {
		console.log("");
		for (const item of failed) console.log("  x " + item.name + (item.detail ? " -- " + item.detail : ""));
	}
	console.log("probe-release: passed " + (results.length - failed.length) + " / failed " + failed.length);
}
process.exit(failed.length > 0 ? 1 : 0);
