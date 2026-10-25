/**
 * dev/audit.mjs — 自洽体检（**不碰宿主、不 spawn、不联网**）。
 *
 * 这一层管的是「代码自己跟自己是否一致」：
 *   默认值有没有漂、工具契约齐不齐、标签与扫描规则覆盖不覆盖用户点名的那些、
 *   仓库命名规则对不对、多帧日志能不能真解出来、归属判定在构造样本上是否按预期分级。
 *
 * 用法：node dev/audit.mjs
 * 退出码：0 全过 / 1 有失败。
 */

import { mkdirSync, rmSync, writeFileSync, mkdtempSync, statSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";

/* R31：文档对账要数的两个真值 —— 探针清单（单一来源）与交接单项数（纯函数真跑） */
import { PROBES, PROBE_COUNT, LEGACY_PROBES } from "./probe-list.mjs";
import { buildHandoff } from "../lib/handoff.mjs";

import { DEFAULTS, FROZEN_DEFAULTS, normalizeSettings, SETTINGS_VERSION } from "../lib/settings.mjs";
import { BUILTIN_TAGS, addCustomTag, listTags, removeCustomTag, setEntryTags, tagsOfEntry, tagPrompt, loadTagsStore, saveTagsStore } from "../lib/tags.mjs";
import { buildCatalogTools } from "../lib/tools.mjs";
import { repoNameFor, applyUpload, makePublic, PUBLISHABLE_SOURCES, selectCandidates } from "../lib/publish.mjs";
import { NAME_RULES, CONTENT_RULES, maskValue, judgeHit, isBlocking } from "../lib/scan.mjs";
import { analyzeReadme, cjkCount, tbdCount, checkTbdParity, compareHeadingShape, proseOf, writeEnglish, ensureCrossLink } from "../lib/readme.mjs";
import { attributeTools } from "../lib/attrib.mjs";
import { buildAggregate, descendantsOf, STATS_VERSION } from "../lib/stats.mjs";
import { eachFrame, parseEvents, findFrameCuts } from "../lib/frames.mjs";
import { parseFrontmatter } from "../lib/catalog.mjs";
import { LOAD_STATES, parseComposition, resolveLoadPaths, isLoadedState, isDormantState, loadStateLabel } from "../lib/loadstate.mjs";
import { COMPOSITION_KINDS, DISABLE_KINDS, ENTRY_RESOLUTIONS, auditComposition, classifyCompositionName, compactComposition, mergeCompositionEntries, packageNameOf, parseDisabled, signatureOf, summarizeComposition } from "../lib/composition.mjs";
import { PROVENANCE, buildUninstallPlan, renderUninstallPlan, summarizeUninstallPlan } from "../lib/uninstall.mjs";
import { compareComposition, describeChange, diffSnapshots, snapshotOf } from "../lib/history.mjs";
import { computeStats } from "../lib/stats.mjs";

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, condition, detail = "") {
	if (condition) {
		passed += 1;
		return true;
	}
	failed += 1;
	failures.push(name + (detail ? " —— " + detail : ""));
	return false;
}

function eq(name, actual, expected) {
	const a = JSON.stringify(actual);
	const b = JSON.stringify(expected);
	return ok(name, a === b, "期望 " + b + "，实际 " + a);
}

const tmpRoot = mkdtempSync(join(tmpdir(), "dsh-catalog-audit-"));

/* ─────────── ① 设置层：默认值冻结 + 白名单夹取 ─────────── */
ok("默认值快照未漂移", JSON.stringify(DEFAULTS) === FROZEN_DEFAULTS);
ok("windowDays 默认 ≥ 90（用户要求覆盖最近 90 天）", DEFAULTS.windowDays >= 90, "实际 " + DEFAULTS.windowDays);
ok("allowPublic 默认必须是 false（默认所有仓私有）", DEFAULTS.allowPublic === false);
eq("AI 默认模型钉 deepseek-flash", DEFAULTS.aiModel, { provider: "deepseek-official", model: "deepseek-flash" });

const normalized = normalizeSettings({ windowDays: -5, sessionsPageSize: 9999, nonsenseKey: "should-be-dropped", allowPublic: true, aiModel: { provider: "", model: "x" } });
ok("非法 windowDays 回落默认", normalized.windowDays === DEFAULTS.windowDays, "实际 " + normalized.windowDays);
ok("sessionsPageSize 夹到上限", normalized.sessionsPageSize === 200, "实际 " + normalized.sessionsPageSize);
ok("未知键被丢弃", normalized.nonsenseKey === undefined);
ok("allowPublic 再怎么传都是 false", normalized.allowPublic === false);
eq("aiModel 空 provider 回退默认", normalized.aiModel.provider, DEFAULTS.aiModel.provider);

/* ─────────── ② 工具契约：每个都必须有 output{schema,render} ─────────── */
const stubService = new Proxy(
	{},
	{
		get: (_target, key) => {
			if (key === "then") return undefined;
			return async () => ({ ok: true });
		},
	},
);
const tools = buildCatalogTools({ service: stubService });
ok("工具数量 ≥ 6", tools.length >= 6, "实际 " + tools.length);
const requiredNames = ["catalog_list", "catalog_stats", "catalog_tag", "catalog_classify", "catalog_review", "catalog_publish", "catalog_health", "catalog_skill_sync", "catalog_handoff", "catalog_mcp"];
for (const name of requiredNames) {
	ok("存在工具 " + name, tools.some((tool) => tool.name === name));
}
for (const tool of tools) {
	ok(`工具 ${tool.name} 声明了 output.schema`, Boolean(tool.output && tool.output.schema));
	ok(`工具 ${tool.name} 声明了 output.render 函数`, typeof tool.output?.render === "function");
	ok(`工具 ${tool.name} 有描述`, typeof tool.description === "string" && tool.description.length > 20);
	ok(`工具 ${tool.name} 有 parameters`, tool.parameters?.type === "object");
	ok(`工具 ${tool.name} 有 execute`, typeof tool.execute === "function");
}
const publishTool = tools.find((tool) => tool.name === "catalog_publish");
ok("catalog_publish 的 action 枚举含 plan/apply/public", ["plan", "apply", "public"].every((action) => publishTool.parameters.properties.action.enum.includes(action)));
const reviewTool = tools.find((tool) => tool.name === "catalog_review");
ok("catalog_review 描述里讲清「只出建议、不改代码」", /只出建议|不改代码/.test(reviewTool.description));

/* ─────────── ③ 标签体系 ─────────── */
ok("内置标签三个维度齐全", ["purpose", "context", "origin"].every((dimension) => BUILTIN_TAGS.some((tag) => tag.dimension === dimension)));
ok("每个内置标签都有解释", BUILTIN_TAGS.every((tag) => typeof tag.gloss === "string" && tag.gloss.length >= 6));
ok("标签 id 不重复", new Set(BUILTIN_TAGS.map((tag) => tag.id)).size === BUILTIN_TAGS.length);
ok("截图/运维/游戏这几个用户点名的标签在 purpose 里", ["screenshot", "ops", "game"].every((id) => BUILTIN_TAGS.some((tag) => tag.id === id && tag.dimension === "purpose")));
ok("Web GUI / AstrBot / Minecraft 在 context 里", ["web-gui", "astrbot", "minecraft"].every((id) => BUILTIN_TAGS.some((tag) => tag.id === id && tag.dimension === "context")));

const store = { version: 2, custom: [], assignments: {}, updatedAt: 0 };
const noGloss = addCustomTag(store, { label: "视频", dimension: "purpose" });
ok("新增标签缺解释时被拒（AI 靠解释判断）", noGloss.ok === false && /解释/.test(noGloss.error));
const badDimension = addCustomTag(store, { label: "视频", dimension: "origin", gloss: "x" });
ok("origin 维度不允许自定义", badDimension.ok === false);
const added = addCustomTag(store, { label: "视频剪辑", dimension: "purpose", gloss: "处理视频素材：切片、转码、字幕" });
ok("带解释的自定义标签可以新增", added.ok === true);
const prompt = tagPrompt(store);
ok("喂给模型的标签清单包含自定义标签的解释", prompt.includes("处理视频素材"), "提示词里没找到解释");
ok("prompt 标注了哪个是用户自定义", prompt.includes("用户自定义"));

setEntryTags(store, "plugin:x", { purpose: [added.tag.id, "not-a-real-tag"], context: ["astrbot"] }, "user");
const assigned = store.assignments["plugin:x"];
ok("未知标签 id 被过滤（模型编的标签进不了库）", assigned.purpose.length === 1 && assigned.purpose[0] === added.tag.id);
eq("context 正常写入", assigned.context, ["astrbot"]);
const originOfSelf = tagsOfEntry(store, { id: "plugin:y", source: "self" });
eq("origin 由来源推导（自写）", originOfSelf.origin, ["src-self"]);
const originOfHybrid = tagsOfEntry(store, { id: "plugin:z", source: "hybrid" });
eq("origin 由来源推导（混血）", originOfHybrid.origin, ["src-hybrid"]);
const removed = removeCustomTag(store, added.tag.id);
ok("删除自定义标签会连带清掉分配", removed.ok === true && store.assignments["plugin:x"].purpose.length === 0);

/* ─────────── ④ 扫描规则：用户点名的覆盖项 ─────────── */
const mustMatch = [".env", ".env.local", "secrets/token.txt", "id.key", "server.pem", "configs/db-secret.json", "configs/app-config.json"];
for (const path of mustMatch) {
	ok("文件名规则命中 " + path, NAME_RULES.some((rule) => rule.re.test(path)));
}
ok("正常的 .js 不会被文件名规则误报", !NAME_RULES.some((rule) => rule.re.test("lib/index.js")));
/* ★ 夹具里的"密钥"必须**运行时拼**，不能写成字面量：
   否则本插件自己的密钥门禁会把它当成真泄漏，第一次上传就被自己拦下（真踩了）。
   dsh-github-backup 当年也是这么处理的。 */
const FIXTURE_KEY_HEAD = "-----BEGIN " + "OPENSSH PRIVATE KEY-----";
const FIXTURE_GITHUB_TOKEN = "ghp_" + "abcdefghijklmnopqrstuvwxyz0123456789";
const FIXTURE_OPENAI_TOKEN = "sk-" + "A1b2C3d4".repeat(5);

ok("maskValue 不回显明文", (() => {
	const masked = maskValue(FIXTURE_GITHUB_TOKEN);
	return masked.includes("…") && masked.length < 30 && !masked.includes("abcdefghij");
})());
ok("private key 内容规则命中", CONTENT_RULES.some((rule) => rule.re.test(FIXTURE_KEY_HEAD)));
ok("github token 内容规则命中", CONTENT_RULES.some((rule) => rule.re.test(FIXTURE_GITHUB_TOKEN)));

/* 三个真实假阳性（本机实测踩出来的），必须都不再算泄漏 */
const cookieRule = CONTENT_RULES.find((rule) => rule.id === "cookie-header");
/** 一行文本算不算泄漏：没有任何规则命中，或命中了但被 reject 排除 → 不算。 */
const notLeak = (line) => {
	const rule = CONTENT_RULES.find((item) => item.re.test(line));
	if (!rule) return true;
	return Boolean(rule.reject && rule.reject.test(line));
};
ok("代码里拼 header 不算泄漏（模板变量）", notLeak("headers: { Cookie: `vcut_token=${TOKEN}` }"));
ok("文档里的省略号示例不算泄漏", notLeak("set-cookie: ds_session_id=...; SameSite=Strict"));
ok("password 用环境变量不算泄漏（这正是推荐写法）", notLeak('password: process.env.PW'));
ok("占位符型 api key 不算泄漏", notLeak('apiKey: "<YOUR_API_KEY>"'));
/* 这条同样运行时拼：写成字面量的话，本插件自己的门禁会把它当成真 cookie 拦下 */
const FIXTURE_COOKIE = "sid=" + "8f3a1c9b7e2d4a6f0b5c3e1d9a8f7b6c";
ok("真实的 cookie 值仍然命中", !notLeak("Cookie: " + FIXTURE_COOKIE));
ok("cookie 规则不再匹配长自由文本", !cookieRule.re.test("Cookie: 这里是一段中文说明文字，不是凭据"));
eq("真实形态的 sk- 仍然命中", (() => {
	const rule = CONTENT_RULES.find((item) => item.id === "openai-key");
	return rule.re.test(FIXTURE_OPENAI_TOKEN) ? "hit" : "miss";
})(), "hit");
ok("私钥块仍然命中（夹具也报，由 judge 判可忽略）", !notLeak(FIXTURE_KEY_HEAD));
const fixtureJudge = judgeHit({ kind: "content", severity: "high", file: "test/fixtures/fake.json", line: 3, rule: "openai-key" });
eq("测试夹具里的命中判为可忽略", fixtureJudge.verdict, "likely-fixture");
const realJudge = judgeHit({ kind: "content", severity: "critical", file: "lib/config.js", line: 9, rule: "openai-key" });
eq("业务代码里的命中判为真实风险", realJudge.verdict, "real-risk");
ok("isBlocking 对 critical 命中返回 true", isBlocking({ hits: [{ severity: "critical" }] }) === true);
ok("isBlocking 对干净结果返回 false", isBlocking({ hits: [] }) === false);

/* ─────────── ⑤ 仓库命名 + 上传门禁 ─────────── */
eq("自写：dsh-screenshot 沿用", repoNameFor({ name: "dsh-screenshot", source: "self" }), "dsh-screenshot");
eq("自写：无前缀时补 dsh-", repoNameFor({ name: "catalog", source: "self" }), "dsh-catalog");
eq("混血：加 -local 不覆盖原仓", repoNameFor({ name: "dsh-screenshot", source: "hybrid" }), "dsh-screenshot-local");
eq("作用域包名去 scope", repoNameFor({ name: "@me/dsh-foo", source: "self" }), "dsh-foo");
ok("只有自写与混血可上传", JSON.stringify(PUBLISHABLE_SOURCES) === JSON.stringify(["self", "hybrid"]));
const candidates = selectCandidates({ plugins: [{ name: "a", source: "self" }, { name: "b", source: "third" }, { name: "c", source: "hybrid" }], skills: [{ name: "s1", source: "self" }, { name: "s2", source: "third" }] });
eq("候选只含自写/混血插件 + 自写 Skill", candidates.plugins.map((x) => x.name).concat(candidates.skills.map((x) => x.name)), ["a", "c", "s1"]);

const noConfirm = await applyUpload({ items: [], ghBin: "", login: "" }, {});
ok("apply 不带 confirm 直接拒绝", noConfirm.ok === false && /confirm/.test(noConfirm.error));
const publicNoConfirm = await makePublic({ repo: "x", dir: tmpRoot, confirm: false });
ok("公开操作不带 confirm 直接拒绝", publicNoConfirm.ok === false && /confirm/.test(publicNoConfirm.error));

/* ─────────── ⑥ README 判定（不无脑造英文版） ─────────── */
const dirs = {};
const mkdir = (name) => {
	const dir = join(tmpRoot, name);
	mkdirSync(dir, { recursive: true });
	dirs[name] = dir;
	return dir;
};

const englishDir = mkdir("english");
writeFileSync(join(englishDir, "README.md"), "# dsh-foo\n\nThis plugin does one thing.\n\n## Install\n\n```bash\ndsh plugin add dsh-foo\n```\n", "utf8");
const englishAnalyze = await analyzeReadme(englishDir);
ok("英文 README 不再生成英文版", englishAnalyze.needsEnglish === false && /英文/.test(englishAnalyze.reason));

const skeletonDir = mkdir("skeleton");
writeFileSync(join(skeletonDir, "README.md"), "# dsh-bar\n\n## 适用 profile\n待补充\n\n## 安装\n待补充\n\n## 已知限制\n待补充\n", "utf8");
const skeletonAnalyze = await analyzeReadme(skeletonDir);
ok("只有「待补充」骨架时不生成英文版", skeletonAnalyze.needsEnglish === false, skeletonAnalyze.reason);

const chineseDir = mkdir("chinese");
const chineseBody = "# dsh-baz\n\n这是一个用来抓屏与长截图的插件，支持窗口选择、覆盖层标注、离线 OCR 与像素级比对。它把抓屏放在宿主进程里做，因此不需要额外的浏览器依赖，也不会被渲染进程的权限限制影响。\n\n## 安装\n\n```bash\ndsh plugin add dsh-baz\n```\n\n## 已知限制\n\n只在 Windows 上验证过，DPI 混合缩放时标注坐标会偏移一个像素。\n";
writeFileSync(join(chineseDir, "README.md"), chineseBody, "utf8");
const chineseAnalyze = await analyzeReadme(chineseDir);
ok("有实内容的中文 README 需要英文版", chineseAnalyze.needsEnglish === true, chineseAnalyze.reason);
ok("cjkCount 忽略代码块里的字符", cjkCount("```\n中文\n```\nEnglish") === 0, "实际 " + cjkCount("```\n中文\n```\nEnglish"));
ok("tbdCount 认「待补充」与 TBD", tbdCount("待补充 TBD TODO") === 3);
const parity = checkTbdParity("这里待补充，那里待补充", "TBD here, TBD there");
ok("TBD 数量对齐时通过", parity.ok === true && parity.zhPending === 2 && parity.enTbd === 2);
const parityBad = checkTbdParity("这里待补充，那里待补充", "TBD here only");
ok("TBD 数量不足时被标出", parityBad.ok === false);
const shape = compareHeadingShape("# a\n## b\n### c\n", "# a\n## b\n## c\n");
ok("章节层级不一致能被发现", shape.same === false && shape.zhHeadings === 3 && shape.enHeadings === 3);
ok("proseOf 去掉围栏与行内代码", !proseOf("```js\nconst x=1\n```\n`y`\n中文").includes("const x"));

/* ─────────── ⑥b 双语 README：真按 applyUpload 的顺序走一遍（不碰 git） ─────────── */
{
	const bilingualDir = mkdir("bilingual");
	const zhText = "# dsh-bi\n\n这是一个双语 README 流程的测试插件。它会把中文版翻成英文版，插入互链，然后再判断一次是否还需要生成，避免每次发布都重复调用模型烧掉额度。中文正文必须足够长才能通过「有没有东西可翻」的判定，所以这里多写几句真实的说明文字，讲清楚它做了什么、不做什么，以及为什么要有这套流程。\n\n## 安装\n\n```bash\nnode .tools/dsh-plugin-install.cjs install dsh-bi \"<路径>\"\n```\n\n## 已知限制\n\n待补充\n";
	writeFileSync(join(bilingualDir, "README.md"), zhText, "utf8");

	const analysisBefore = await analyzeReadme(bilingualDir);
	ok("有实内容 → 需要英文版", analysisBefore.needsEnglish === true, analysisBefore.reason + "（汉字 " + analysisBefore.cjk + "）");
	ok("中文里数出了 1 处「待补充」", analysisBefore.tbd === 1, String(analysisBefore.tbd));

	/* 模拟 translateReadme 的产物：章节层级与中文一一对应、待补充写成 TBD */
	const en = "# dsh-bi\n\nThis is a test plugin for the bilingual README flow. It translates the Chinese version, inserts cross links, then re-checks whether another translation is needed — so a publish never burns model quota twice for nothing. The Chinese body has to be long enough to pass the \"is there anything to translate\" check. The placeholder and the command below must survive translation unchanged.\n\n## Install\n\n```bash\nnode .tools/dsh-plugin-install.cjs install dsh-bi \"<路径>\"\n```\n\n## Known limitations\n\nTBD\n";
	const written = await writeEnglish(bilingualDir, en, analysisBefore.enFile);
	eq("英文版写到固定文件名 README.en.md", written.name, "README.en.md");
	ok("英文版文件真的存在且非空", (() => {
		try {
			return statSync(written.file).size > 100;
		} catch (error) {
			return false;
		}
	})(), written.file);
	ok("英文版的 TBD 数量 ≥ 中文「待补充」数", checkTbdParity(zhText, en).ok === true, JSON.stringify(checkTbdParity(zhText, en)));
	ok("章节层级与中文一一对应", compareHeadingShape(zhText, en).same === true, JSON.stringify(compareHeadingShape(zhText, en)));
	ok("占位符与代码块原样保留", en.includes("<路径>") && en.includes("dsh-plugin-install.cjs install dsh-bi"), en.slice(0, 120));

	const linkZh = await ensureCrossLink(join(bilingualDir, "README.md"), "README.en.md", "English");
	ok("中文版插入了指向英文版的互链", linkZh.ok && linkZh.changed, JSON.stringify(linkZh));
	const linkEn = await ensureCrossLink(written.file, "README.md", "中文");
	ok("英文版插入了指向中文版的互链", linkEn.ok && linkEn.changed, JSON.stringify(linkEn));
	const again = await ensureCrossLink(written.file, "README.md", "中文");
	ok("互链是幂等的（第二次不再插入）", again.ok && again.changed === false, JSON.stringify(again));

	/* 关键：写完英文版之后，再判定应该"不需要再生成"——否则每次 apply 都会重复调模型 */
	const analysisAfter = await analyzeReadme(bilingualDir);
	ok("英文版比中文版新 → 不再生成（不重复烧 token）", analysisAfter.needsEnglish === false, analysisAfter.reason);
	ok("英文版不再需要时的理由是「已存在且不比中文版旧」", /已存在|不比中文版旧/.test(analysisAfter.reason), analysisAfter.reason);

	/* 反向：英文 README 本来就用英文写 → 一开始就不该生成 */
	const enOnly = mkdir("en-only");
	writeFileSync(join(enOnly, "README.md"), "# x\n\nThis plugin does one thing and has no Chinese prose at all, so no translation is needed.\n", "utf8");
	const enAnalysis = await analyzeReadme(enOnly);
	ok("英文 README 不会触发翻译", enAnalysis.needsEnglish === false && enAnalysis.alreadyEnglish === true, JSON.stringify({ needs: enAnalysis.needsEnglish, reason: enAnalysis.reason }));
}

/* ─────────── ⑦ 归属判定：按可信度分级 ─────────── */
const fakeTools = [
	{ name: "diag_eval", description: "在渲染进程里跑一段 JS，把返回值直接回给 AI，用于量尺寸、读 React 状态、翻 localStorage。" },
	{ name: "mcp_status", description: "" },
	{ name: "read", description: "Read a UTF-8 text file and return line-numbered content." },
	{ name: "dup_tool", description: "这段描述在两个包都出现了，用来测试歧义处理：描述指纹命中的包不止一个时不能瞎猜归属。" },
	/* ★ 回归用例：源码里是**多行字符串拼接**，schema 里是拼好的一整句。
	   真机上就是这么栽的：一堆自写插件的工具被误判成"宿主"。 */
	{
		name: "concat_tool",
		description: "这个工具的描述在源码里被拆成两段字符串拼接，中间隔着加号和换行，所以直接拿整句去源码里找是找不到的。",
	},
	/* ★ 回归用例：源码里写的是转义的 \n，schema 里是真正的换行。 */
	{ name: "escaped_tool", description: "第一行描述\n第二行描述，这里用真正的换行符出现在 schema 里，而源码里是转义写法。" },
];
const fakePackages = [
	{ pkg: "dsh-diag", text: "const SPEC = { name: 'diag_eval', execute: async () => {}, description: '在渲染进程里跑一段 JS，把返回值直接回给 AI，用于量尺寸、读 React 状态、翻 localStorage。' }" },
	{ pkg: "some-mcp", text: "tools.push({ name: 'mcp_status', execute: async () => {} })" },
	{ pkg: "a-dup", text: "描述：这段描述在两个包都出现了，用来测试歧义处理：描述指纹命中的包不止一个时不能瞎猜归属。" },
	{ pkg: "b-dup", text: "描述：这段描述在两个包都出现了，用来测试歧义处理：描述指纹命中的包不止一个时不能瞎猜归属。" },
	{
		pkg: "dsh-concat",
		text: "tools.register({\n  name: 'concat_tool',\n  description: '这个工具的描述在源码里被拆成两段字符串拼接，' +\n    '中间隔着加号和换行，所以直接拿整句去源码里找是找不到的。',\n  execute: async () => {}\n});",
	},
	{
		pkg: "dsh-escaped",
		text: "tools.register({ name: 'escaped_tool', description: '第一行描述\\n第二行描述，这里用真正的换行符出现在 schema 里，而源码里是转义写法。', execute() {} });",
	},
];
const attribution = attributeTools(fakeTools, fakePackages, {});
eq("描述指纹唯一命中 → 归那个包", attribution.tools.diag_eval, { owner: "dsh-diag", how: "description", confidence: "high" });
eq("没有描述时用名字字面量（弱证据）", attribution.tools.mcp_status, { owner: "some-mcp", how: "name-literal", confidence: "medium" });
eq("有描述但哪都找不到 → 判为宿主", attribution.tools.read, { owner: "", how: "host", confidence: "high" });
ok("描述歧义时不瞎猜", attribution.tools.dup_tool.owner === "" && attribution.tools.dup_tool.how === "description-ambiguous", JSON.stringify(attribution.tools.dup_tool));
eq("源码里多行拼接的描述仍能认出来（压平后匹配）", attribution.tools.concat_tool, { owner: "dsh-concat", how: "description", confidence: "high" });
eq("源码里转义 \\n 的描述也能认出来", attribution.tools.escaped_tool, { owner: "dsh-escaped", how: "description", confidence: "high" });
const manual = attributeTools(fakeTools, fakePackages, { read: "my-own-pkg" });
eq("手工指定优先于一切推断", manual.tools.read, { owner: "my-own-pkg", how: "manual", confidence: "manual" });

/* ─────────── ⑧ 统计聚合：子代理拆分 + 去重 ─────────── */
const parts = {
	"ws|session-parent": {
		sid: "session-parent",
		ws: "ws",
		src: [["f1", 1, 10]],
		h: { c: 1000, p: "", o: "", d: 0, t: "" },
		t: "父会话",
		ts: "user",
		calls: [["pwsh", 2, 1, 0, 300, 2, 5000], ["read", 1, 0, 0, 100, 1, 4000]],
		skills: [["vex-ops", 1, 4500]],
		n: 3,
		dup: 0,
		fr: 5,
		bad: 0,
	},
	"ws|session-child": {
		sid: "session-child",
		ws: "ws",
		src: [["f2", 1, 10]],
		h: { c: 2000, p: "session-parent", o: "subagent", d: 1, t: "standard" },
		t: "子代理",
		ts: "fallback",
		calls: [["pwsh", 3, 0, 0, 600, 3, 6000]],
		skills: [],
		n: 3,
		dup: 0,
		fr: 3,
		bad: 0,
	},
};
const aggregate = buildAggregate(parts, { windowDays: 90 });
eq("工具总调用次数合并", aggregate.tools.get("pwsh").calls, 5);
eq("工具报错次数合并", aggregate.tools.get("pwsh").errors, 1);
eq("平均耗时按有配对的调用算", Math.round(aggregate.tools.get("pwsh").ms / aggregate.tools.get("pwsh").msCount), 180);
eq("工具涉及的会话数", aggregate.tools.get("pwsh").sessions, 2);
eq("Skill 次数", aggregate.skills.get("vex-ops").calls, 1);
eq("子代理会话计数", aggregate.totals.subagentSessions, 1);
eq("父会话的标题保留", aggregate.sessions.get("session-parent").title, "父会话");
const descendants = descendantsOf(aggregate.sessions, "session-parent");
eq("能沿 parentSession 找到子代理", descendants, ["session-child"]);
eq("子代理的父指针", aggregate.sessions.get("session-child").parent, "session-parent");
ok("统计缓存版本号已声明", STATS_VERSION >= 3);

/* 真跑一次 computeStats：造一个两帧 zstd 日志，验证「不是只读第一帧」 */
const sessionsRoot = join(tmpRoot, "sessions", "ws-one", "session-test-unit");
mkdirSync(sessionsRoot, { recursive: true });
const frame1 = JSON.stringify({ type: "session", version: 4, id: "session-test-unit", createdAt: 1, cwd: "x", delegationDepth: 0, agentPreset: "standard" }) + "\n";
const frame2 = [
	{ type: "tool/call", time: 100, data: { callId: "c1", name: "read" } },
	{ type: "tool/result", time: 180, data: { message: { toolCallId: "c1", isError: false } } },
	{ type: "tool/call", time: 200, data: { callId: "c2", name: "skill", arguments: JSON.stringify({ name: "vex-ops" }) } },
	{ type: "tool/result", time: 260, data: { message: { toolCallId: "c2", isError: true } } },
	{ type: "session/title", data: { title: "单元测试会话", source: { kind: "user" } } },
].map((event) => JSON.stringify(event)).join("\n") + "\n";
const twoFrames = Buffer.concat([zstdCompressSync(Buffer.from(frame1, "utf8")), zstdCompressSync(Buffer.from(frame2, "utf8"))]);
writeFileSync(join(sessionsRoot, "session.v4.jsonl.zstd"), twoFrames);

eq("切帧找到 2 个帧起点", findFrameCuts(twoFrames).length, 2, "实际 " + findFrameCuts(twoFrames).length);
let textFromFrames = "";
const frameOutcome = eachFrame(twoFrames, (text) => {
	textFromFrames += text;
});
ok("两帧都被解出来（只解第一帧的话这里只有 header）", frameOutcome.frames === 2 && textFromFrames.includes("tool/call"), "frames=" + frameOutcome.frames);
ok("没顶到上限时 truncated=false", frameOutcome.truncated === false, JSON.stringify(frameOutcome));
/* 撞上限必须自己报出来（否则统计会安静地少算） */
let limitedFrames = 0;
const limited = eachFrame(twoFrames, () => { limitedFrames += 1; }, { maxFrames: 1 });
ok("顶到帧数上限时 truncated=true", limited.truncated === true && limited.frames === 1 && limitedFrames === 1, JSON.stringify(limited));
const parsed = parseEvents(textFromFrames);
ok("解析出 6 个事件", parsed.events.length === 6, "实际 " + parsed.events.length);

const statsResult = await computeStats({ sessionsRoot: join(tmpRoot, "sessions"), dataDir: join(tmpRoot, "data"), windowDays: 90 });
ok("computeStats 跑通", statsResult.ok === true, statsResult.error);
eq("读到了那一个会话", statsResult.aggregate.totals.sessions, 1);
eq("读到 read 1 次", statsResult.aggregate.tools.get("read")?.calls, 1);
eq("读到 skill 调用 1 次并记了报错", statsResult.aggregate.tools.get("skill")?.errors, 1);
eq("Skill 名从参数里取出来", statsResult.aggregate.skills.get("vex-ops")?.calls, 1);
eq("会话昵称取到了", statsResult.aggregate.sessions.get("session-test-unit").title, "单元测试会话");
eq("调用耗时记下来了", statsResult.aggregate.tools.get("read").ms, 80);

/* 同目录两份日志（v3+v4）必须按 callId 去重，不能算两遍 */
const dupeDir = join(tmpRoot, "sessions", "ws-two", "session-dupe");
mkdirSync(dupeDir, { recursive: true });
const dupeFrame = (extraTitle) => {
	const head = JSON.stringify({ type: "session", version: 4, id: "session-dupe", createdAt: 2, cwd: "x", delegationDepth: 0, agentPreset: "standard" }) + "\n";
	const body = [
		{ type: "tool/call", time: 10, data: { callId: "dup-1", name: "pwsh" } },
		{ type: "tool/result", time: 20, data: { message: { toolCallId: "dup-1", isError: false } } },
		{ type: "session/title", data: { title: extraTitle, source: { kind: "user" } } },
	].map((event) => JSON.stringify(event)).join("\n") + "\n";
	return Buffer.concat([zstdCompressSync(Buffer.from(head, "utf8")), zstdCompressSync(Buffer.from(body, "utf8"))]);
};
writeFileSync(join(dupeDir, "session.v3.jsonl.zstd"), dupeFrame("重复会话"));
writeFileSync(join(dupeDir, "session.v4.jsonl.zstd"), dupeFrame("重复会话"));
const dupeStats = await computeStats({ sessionsRoot: join(tmpRoot, "sessions"), dataDir: join(tmpRoot, "data"), windowDays: 90 });
eq("同一会话的两份日志只算一次调用", dupeStats.aggregate.tools.get("pwsh")?.calls, 1, "实际 " + dupeStats.aggregate.tools.get("pwsh")?.calls);
ok("去重条数被记账", dupeStats.meta.duplicateCalls >= 1, "duplicateCalls=" + dupeStats.meta.duplicateCalls);

/* ─────────── ⑧b 每周任务：失败要退避、单仓失败不能拖垮整批 ─────────── */
const { loadWeekly, saveWeekly, runGapAnalysis, isDue } = await import("../lib/review.mjs");
const weeklyDir = join(tmpRoot, "weekly");
mkdirSync(weeklyDir, { recursive: true });
await saveWeekly(weeklyDir, { lastGapAt: 0, lastGapAttemptAt: 12345, lastSecurityAt: 0, gap: null, security: null });
const weeklyBack = await loadWeekly(weeklyDir);
eq("「尝试时间」能落盘再读回（失败也要退避，否则每次轮询都重试）", weeklyBack.lastGapAttemptAt, 12345);
ok("从来没有成功过时 isDue 为真", isDue(0) === true);
ok("刚成功过时 isDue 为假", isDue(Date.now()) === false);

const gapRepo = mkdir("gap-repo");
writeFileSync(join(gapRepo, "README.md"), "# t\n\n这是一个用来测试缺口分析失败隔离的插件，正文足够长以通过中文判定，避免被当成骨架。\n", "utf8");
writeFileSync(join(gapRepo, "package.json"), JSON.stringify({ name: "t", version: "1.0.0" }), "utf8");
const failingCtx = {
	llm: {
		async *stream() {
			throw new Error("no provider configured");
		},
	},
	agentDefaultModel: { currentSelection: () => ({ provider: "x", model: "y" }) },
};
let gapThrew = "";
let gapReport = null;
try {
	gapReport = await runGapAnalysis(failingCtx, { plugins: [{ name: "t", id: "plugin:t", realDir: gapRepo, source: "self" }], skills: [] }, { maxRepos: 1 });
} catch (error) {
	gapThrew = String(error?.message ?? error);
}
ok("模型不可用时缺口分析不抛异常（单仓失败被隔离）", gapThrew === "", gapThrew);
ok("失败的那一仓被记成 ok=false 且带 error", Boolean(gapReport && gapReport.results.length === 1 && gapReport.results[0].ok === false && /no provider/.test(gapReport.results[0].error)), JSON.stringify(gapReport && gapReport.results[0]));

/* ─────────── ⑨ frontmatter 解析 ─────────── */
const fm = parseFrontmatter('---\nname: vex-ops\ndescription: >\n  第一行\n  第二行\nwhenToUse: 维护 Vex\n---\n正文\n');
eq("frontmatter name", fm.data.name, "vex-ops");
ok("frontmatter 折行拼接", fm.data.description === "第一行 第二行", "实际 " + JSON.stringify(fm.data.description));
eq("frontmatter whenToUse", fm.data.whenToUse, "维护 Vex");
ok("没有 frontmatter 时标记出来", parseFrontmatter("# 标题\n正文").hasFrontmatter === false);
eq("正文不含 frontmatter", parseFrontmatter("---\nname: x\n---\n正文\n").body.trim(), "正文");

/* ─────────── ⑩ 数据目录读写：坏文件要留证 ─────────── */
const { readJson, writeJson } = await import("../lib/store.mjs");
const dataDir = join(tmpRoot, "store");
await writeJson(join(dataDir, "ok.json"), { a: 1 });
eq("原子写读回一致", await readJson(join(dataDir, "ok.json"), null), { a: 1 });
eq("文件不存在返回 fallback", await readJson(join(dataDir, "missing.json"), { fallback: true }), { fallback: true });
writeFileSync(join(dataDir, "broken.json"), "{ not json", "utf8");
eq("坏 JSON 返回 fallback 而不是抛", await readJson(join(dataDir, "broken.json"), { fallback: true }), { fallback: true });
const tagsRoundTrip = { version: 2, custom: [], assignments: { "plugin:x": { purpose: ["ops"], context: [], by: "user", at: 1 } }, updatedAt: 0 };
await saveTagsStore(dataDir, tagsRoundTrip);
const reloaded = await loadTagsStore(dataDir);
eq("标签库落盘再读回一致", reloaded.assignments["plugin:x"].purpose, ["ops"]);

/* ─────────── 客户端样式契约（2026-10-21 R1 那一轮踩出来的） ───────────
   这些规则都属于"改回去照样能渲染、但体验直接坏掉"的一类：
     · 面板不自己滚 → 官方中列 overflow:hidden 把第二屏整个裁掉（没滑块、翻不到页）
     · 口径退回 min-height:100% → 同上复发
     · 边框直接用 --dsw-alias-border → 深色主题下是一排刺眼白框
   固定成断言，改坏就红。 */
const clientSource = readFileSync(new URL("../client.js", import.meta.url), "utf8");
const cssStart = clientSource.indexOf("const CSS = `");
const cssSource = cssStart >= 0 ? clientSource.slice(cssStart) : "";

ok("client.js 里有 CSS 模板", cssSource.length > 2000);
ok("面板自己当滚动容器（overflow-y:auto + height:100%）", /\.dpc-panel\{[^}]*overflow-y:auto/.test(cssSource) && /\.dpc-panel\{[^}]*height:100%/.test(cssSource));
ok("面板不再退回 min-height:100% 的旧口径", !/\.dpc-panel\{[^}]*min-height:100%/.test(cssSource));
ok("滚动条被显式画出宽度（否则主题里几乎看不见）", /\.dpc-panel::-webkit-scrollbar\{width:\d+px\}/.test(cssSource));
ok("本地色板存在（--dpc-line / --dpc-fill）", cssSource.includes("--dpc-line:") && cssSource.includes("--dpc-fill:"));
ok("克莱因蓝被指定为 #002fa7", cssSource.includes("--dpc-klein:#002fa7"));
ok("卡片悬停有克莱因蓝光效", /\.dpc-card:hover\{[^}]*rgba\(0,47,167/.test(cssSource));
ok("卡片边框不再直接用 --dsw-alias-border", !/\.dpc-card\{[^}]*--dsw-alias-border/.test(cssSource));
ok("列表分页的类名与页大小常量都在", cssSource.includes(".dpc-listbar") && cssSource.includes(".dpc-page-pill") && clientSource.includes("const LIST_PAGE_SIZES"));

/* ─────────── 客户端行为契约（2026-10-22 R2 这一轮） ───────────
   R1 锁的是「样式别退回坏口径」，R2 锁的是「面板靠不靠得住」：
     · 搜索域没有工具名 → 「这个工具是谁给的」只能一个个点开看
     · 洞察条的口径若受关键词影响 → 点开筛选后数字自己变 0，看起来像数据丢了
     · 自动刷新没有闸门 → 20 秒轮询会把它变成"一直在刷新"
     · 快捷键只挂监听器不算数 → 判定必须抽成纯函数，才能被断言
   行为正确性由 dev/render-check.cjs 真渲染断言；这里锁常量、结构、类名。 */
const serviceSource = readFileSync(new URL("../lib/service.mjs", import.meta.url), "utf8");
const usageBlock = clientSource.slice(clientSource.indexOf("const USAGE_FILTERS"), clientSource.indexOf("const AUTO_REFRESH_MS"));

ok("服务端给列表项带上 toolNames（按工具名搜索的数据来源）", serviceSource.includes("toolNames: usage.tools.map"));
ok("服务端给列表项带上 realDir / isLink（装上了却不工作时要看这两个）", serviceSource.includes("realDir: plugin.realDir") && serviceSource.includes("isLink: Boolean(plugin.isLink)"));
ok("搜索域包含工具名", clientSource.includes('(item.toolNames || []).join(" ")'));
ok("洞察条五个视角齐全（any / used / unused / errors / subonly）", ["any", "used", "unused", "errors", "subonly"].every((id) => usageBlock.includes('id: "' + id + '"')));
ok("自动刷新的三条闸门都在（只刷一次 / 有任务不抢 / 阈值判断）", /autoRefreshed\.current/.test(clientSource) && clientSource.includes("data.job && data.job.running") && /if \(Date\.now\(\) - builtAt < AUTO_REFRESH_MS\)/.test(clientSource));
ok("自动刷新阈值不小于 5 分钟（20 秒轮询下更短会退化成一直刷新）", (() => {
	const match = clientSource.match(/AUTO_REFRESH_MS = (\d+) \* 60 \* 1000/);
	return Boolean(match) && Number(match[1]) >= 5;
})());
ok("快捷键判定是纯函数（不碰 DOM 也能断言）", /function hotkeyOf\(event\)/.test(clientSource));
ok("面板挂载后真的把 keydown 接上了（window 而非 document）", /window\.addEventListener\("keydown"/.test(clientSource));
ok("排序里有「报错次数」", /SORTS[\s\S]{0,400}id: "errors"/.test(clientSource));
ok("未调用的条目降级显示（dpc-calls is-zero）", clientSource.includes('"dpc-calls" + (isUnused(item) ? " is-zero" : "")'));
ok("报错 chip 只在有报错时渲染", clientSource.includes("hasErrors(item)") && cssSource.includes(".dpc-err{"));
ok("浮窗能复制源目录：clipboard + execCommand 两条路都有", /function copyText/.test(clientSource) && clientSource.includes('execCommand("copy")'));
ok("新增样式类都有定义（洞察条 / 命中工具 / 报错 chip / 源目录）", [".dpc-insights{", ".dpc-insight.is-on{", ".dpc-hit{", ".dpc-err{", ".dpc-path{"].every((needle) => cssSource.includes(needle)));

/* ─────────── R3（2026-10-22 第二轮）：仅子代理 / 报错率 / 视图持久化 ───────────
   这里锁的是**静默失效点**：localStorage 在无头环境不存在、在浏览器里也可能被策略禁用，
   所以读/写/恢复三步都必须包 try，且恢复只能发生一次（否则每次轮询都把滚动拽回顶部或底部）。 */
ok("排序里有「报错率」（率与次数是两种问题）", /SORTS[\s\S]{0,400}id: "rate"/.test(clientSource));
ok("五个 chip 都配了说明书（数字要有解释，否则「仅子代理 0」像坏了）", (() => {
	const hints = clientSource.slice(clientSource.indexOf("const USAGE_HINTS"), clientSource.indexOf("const AUTO_REFRESH_MS"));
	return ["any", "used", "unused", "errors", "subonly"].every((id) => new RegExp(id + ': "').test(hints)) && hints.includes("委派链");
})());ok("按报错率排序用 errorRate 而不是次数差", /state\.sort === "rate"\) return errorRate\(b\) - errorRate\(a\)/.test(clientSource));
ok("「仅子代理」是纯函数且要求 calls > 0", /function isSubagentOnly\(item\)/.test(clientSource) && /calls > 0 && calls === \(Number\(item && item\.subagentCalls\) \|\| 0\)/.test(clientSource));
ok("视图持久化的读、写都有 try（存储被禁用时不拖垮渲染）", (() => {
	const readBlock = clientSource.slice(clientSource.indexOf("function readView"), clientSource.indexOf("function writeView"));
	const writeBlock = clientSource.slice(clientSource.indexOf("function writeView"), clientSource.indexOf("function touchesView"));
	return readBlock.includes("try {") && readBlock.includes("catch (error)") && writeBlock.includes("try {") && writeBlock.includes("catch (error)");
})());
ok("读视图前先判断 typeof localStorage（无头 / 禁用存储都不能假设存在）", /typeof localStorage !== "undefined" \? localStorage\.getItem/.test(clientSource) && clientSource.includes('if (typeof localStorage === "undefined") return false'));
ok("只持久化视图键（data / detail 不入库）", /const VIEW_KEYS = \["query", "source", "kind", "sort", "usage", "pageSize", "page", "orphanOnly", "dormantOnly", "tagFilter"\]/.test(clientSource) && !/VIEW_KEYS = \[[^\]]*"data"/.test(clientSource) && !/VIEW_KEYS = \[[^\]]*"detail"/.test(clientSource));
ok("滚动位置恢复只发生一次（用 ref 挡后续轮询重渲染）", /const restoredScroll = useRef\(false\)/.test(clientSource) && /if \(restoredScroll\.current \|\| !data\) return;/.test(clientSource));
ok("换筛选 / 换页后回到顶部（否则第 2 页第一条落在屏幕外）", clientSource.includes('"page" in patch') && clientSource.includes("panel.scrollTop = 0"));
ok("滚动容器有稳定 id（恢复位置靠它）", clientSource.includes('id: "dpc-panel"') && /className: "dpc-panel", id: "dpc-panel", onScroll: rememberScroll/.test(clientSource));
ok("滚动落盘有节流（300ms 内不重复写 localStorage）", /if \(now - scrollSavedAt < 300\) return;/.test(clientSource));

/* ─────────── R4（2026-10-22 第三轮）：体积懒算 / 导出当前筛选 / 0 值置灰 ───────────
   锁的是性能与安全红线：体积绝不能进目录构建（会把打开从秒级拖到十秒级），
   跟随 junction 会走出 profile 甚至成环；导出必须由服务端定路径，不能让调用方指定。 */
const routeSource = readFileSync(new URL("../index.js", import.meta.url), "utf8");
ok("路由 /size 与 /export 都注册了", routeSource.includes('path === "/size" && method === "GET"') && routeSource.includes('path === "/export" && method === "POST"'));
ok("体积是懒算（dirSize + 5 分钟缓存 / 2 万文件 / 1.5 秒三道闸门）", serviceSource.includes("export async function dirSize(dir)") && /SIZE_TTL_MS = 5 \* 60 \* 1000/.test(serviceSource) && /SIZE_MAX_FILES = 20000/.test(serviceSource) && /SIZE_BUDGET_MS = 1500/.test(serviceSource));
ok("体积不跟随符号链接 / junction（只推入真目录）", serviceSource.includes("if (entry.isDirectory())") && serviceSource.includes("queue.push(join(current, entry.name))"));
ok(
	"构建目录 / 列表都不算体积（dirSize 只在 entrySize / entrySizes / computeSizes 三处）",
	(serviceSource.match(/await dirSize\(/g) || []).length === 3 &&
		!serviceSource.slice(serviceSource.indexOf("listEntries() {"), serviceSource.indexOf("totalsOf(plugins, skills")).includes("dirSize(") &&
		/async computeSizes\(options = \{\}\)[\s\S]{0,2000}?await dirSize\(/.test(serviceSource),
);
ok("没有独立目录时如实返回 size:null + 原因（不返回 0）", serviceSource.includes("Skill 没有独立目录") && serviceSource.includes("在官方 asar 里，没有独立目录"));
ok("导出的落盘路径由服务端决定（reports/catalog-filtered-<时间戳>.md|.csv，扩展名跟 format 走）", serviceSource.includes('"catalog-filtered-" + stamp + "." + format'));
ok("导出文件写明条数与「只覆盖这一屏」", serviceSource.includes("这份清单只覆盖") && serviceSource.includes("共 **"));
ok("导出按钮在筛选结果为 0 时禁用", /disabled: state\.exportBusy \|\| filtered\.length === 0/.test(clientSource));
ok("0 值档位有置灰类（.dpc-insight.is-empty）", cssSource.includes(".dpc-insight.is-empty{") && clientSource.includes('(insightCounts[option.id] === 0 ? " is-empty" : "")'));

/* ─────────── R5（2026-10-22 第四轮）：多选 + 批量体积 + 导出选中 ───────────
   锁三件事：批量体积有上限（不能把宿主线程占满）、选中项**不进 localStorage**
   （半个批次被忘在存储里比丢掉更糟）、选择模式与打开浮窗必须互斥。 */
ok("/sizes 批量路由注册了", routeSource.includes('path === "/sizes" && method === "POST"'));
ok("批量体积上限 200 条", /\.slice\(0, 200\)/.test(serviceSource) && serviceSource.includes("async entrySizes(ids)"));
ok("批量体积并发 4（串行会让 20 个选中项等到几秒）", serviceSource.includes("Math.min(4, Math.max(1, queue.length))"));
ok("选中项不进 localStorage（重启后不留幽灵批次）", /const VIEW_KEYS = \["query", "source", "kind", "sort", "usage", "pageSize", "page", "orphanOnly", "dormantOnly", "tagFilter"\]/.test(clientSource) && !/VIEW_KEYS = \[[^\]]*picked/.test(clientSource));
ok("选择模式下点卡片是选中，不是开浮窗", /onClick: \(\) => \(picking \? props\.onPick\(item\.id\) : openEntry\(item\)\)/.test(clientSource));
ok("退出选择模式会清空选中", /function togglePicking\(\)/.test(clientSource) && /picked: picking \? store\.picked : \[\]/.test(clientSource));
ok("选中态与批次条都有样式（is-picked / dpc-pickedbar / dpc-pick-badge）", [".dpc-card.is-picked{", ".dpc-pickedbar{", ".dpc-pick-badge{"].every((needle) => cssSource.includes(needle)));
ok("「导出选中」走同一个导出函数（口径不分叉）", /function exportPicked\(\) \{\s*return runExport\(store\.picked\.slice\(\)\)/.test(clientSource) && /function exportFiltered\(\) \{\s*return runExport\(filtered\.map/.test(clientSource));

/* ─────────── R6（2026-10-22 第五轮）：副本漂移 ───────────
   锁判据而不是文案：只比 4 个关键文件的 size+mtime（不读内容）、只看 size 与 60 秒容差、
   链接安装不进"漂移"（它本来就只有一份）、缓存必须能作废。 */
ok("漂移只看 4 个关键文件（不读内容，71 个包也快）", /const DRIFT_FILES = \["package\.json", "index\.js", "client\.js", "cordis\.patch\.yml"\]/.test(serviceSource));
ok("只差修改时间时有 60 秒容差（否则每次保存都报不同步）", /DRIFT_MTIME_TOLERANCE = 60 \* 1000/.test(serviceSource));
ok("大小不同即判 differs，不靠 mtime", /if \(left\.size !== right\.size\) \{\s*differs\.push\(name\)/.test(serviceSource));
ok("junction 安装单独记为 linked（只有一份，不算漂移）", /verdict: "linked"/.test(serviceSource) && /if \(plugin\.isLink\)/.test(serviceSource));
ok("漂移结果有 60 秒缓存，且重建目录会作废", serviceSource.includes("async driftOf({ fresh = false } = {})") && serviceSource.includes("this.driftCache = null;"));
ok("R16：写盘计划跳过缓存（刚改完 Skill 就点同步，不能因 60 秒缓存报「两份一致」）", serviceSource.includes("const drift = await this.driftOf({ fresh: true });"));
ok("state 里带 drift 映射", /drift: await this\.driftOf\(\)/.test(serviceSource) && /\.dpc-drift\{/.test(cssSource));
ok("卡片上的漂移标签走纯函数（可断言）", /function driftLabel\(drift\)/.test(clientSource) && /function driftDetail\(drift\)/.test(clientSource));
ok("Skill 也查 staging 副本（发布上去的那份可能是旧的）", /skillsStageDirOf\(this\.settings, this\.workspace\)/.test(serviceSource) && /const loadedStat = await skillStat\(liveDir\)/.test(serviceSource) && /skillVerdict\(loadedStat, stagedStat\)/.test(serviceSource) && /staged: true/.test(serviceSource));
ok("Skill 的真实目录来自 catalog 的 dir 字段（root 只是 skills 根，拼错会静默比错路径）", /const liveDir = skill\.dir \|\| skill\.root;/.test(serviceSource) && /dir: join\(root, entry\.name\)/.test(readFileSync(new URL("../lib/catalog.mjs", import.meta.url), "utf8")));
ok("staged 的标签与插件分开（staging 不同步 / staging 较旧）", /staged \? "staging 不同步" : "副本不同步"/.test(clientSource));

/* ─────────── R6b：build.label 的缓存必须有 TTL ───────────
   坑：Cordis 重载插件不会重新执行 hostinfo.js，永久缓存会让头部一直写升级前的版本号。 */
const hostinfoSource = readFileSync(new URL("../lib/hostinfo.js", import.meta.url), "utf8");
ok("buildStamp 缓存有 5 秒 TTL（否则升级后头部版本号不更新）", /BUILD_CACHE_MS = 5000/.test(hostinfoSource) && /Date\.now\(\) - cachedBuildAt < BUILD_CACHE_MS/.test(hostinfoSource) && /cachedBuildAt = Date\.now\(\)/.test(hostinfoSource));

/* ─────────── R8（2026-10-22 第八轮）：体积成为一等公民 ───────────
   锁的都是"不生效也不报错"的那类：
   ① 快照只由**后台任务**产生（目录构建里一次都不许有 dirSize，否则面板打开从秒级到十秒级）；
   ② 官方包在 asar 里：realDir 是虚拟成员路径，量不出来就**必须说原因**，绝不许写 0 B；
   ③ Skill 用 catalog 的 dir（root 是 skills 根，R6 栽过一次），插件自带的也要带 dir；
   ④ 客户端处处 null-safe：宿主还没重载时 sizes 字段缺失只会"不显示"，不许白屏。 */
const catalogSource = readFileSync(new URL("../lib/catalog.mjs", import.meta.url), "utf8");
ok("体积快照有版本号与并发闸（换口径就能作废旧快照）", /const SIZES_VERSION = 1/.test(serviceSource) && /const SIZES_CONCURRENCY = 4/.test(serviceSource));
ok("体积快照落 cache/sizes.json，且走原子写", /sizesFile\(\) \{\s*return join\(this\.dir, "cache", "sizes\.json"\);/.test(serviceSource) && /await writeJson\(this\.sizesFile\(\), snapshot\)/.test(serviceSource));
ok("computeSizes 跳过 asar 条目（虚拟路径量出来必然是 0）", /items\.filter\(\(item\) => item\.realDir && !item\.inAsar\)/.test(serviceSource));
ok("computeSizes 按目录复用旧值，force 时连进程缓存一起作废", /known\.dir === item\.realDir/.test(serviceSource) && /SIZE_CACHE\.delete\(item\.realDir\)/.test(serviceSource));
ok(
	"体积快照进 state（卡片体积 / 排序 / 合计都读它）",
	/sizes: this\.sizesSnapshot\(\),/.test(serviceSource) && /const bytes = size && Number\.isFinite\(size\.bytes\) \? size\.bytes : null;/.test(serviceSource) && /byId\[id\] = bytes;/.test(serviceSource),
);
ok("体积快照进 /health（换会话第一眼就看得出量没量）", serviceSource.includes("sizes: this.sizes") && routeSource.includes('path === "/health" && method === "GET"'));
ok("entrySize 对 asar 条目给原因、绝不返回 0 B", /if \(item\.inAsar\) return \{ ok: true, size: null, reason: "在官方 asar 里/.test(serviceSource));
ok("批量体积命中快照时不再递归（measured 才记录真实递归条数）", /measured \+= 1/.test(serviceSource) && /return \{ ok: true, count: wanted\.length, totalBytes, sizes, measured \}/.test(serviceSource));
ok("/refresh what=sizes 起后台任务", routeSource.includes('catalog.startJob("sizes"'));
ok("Skill 条目带上自己的目录（浮窗位置与体积都靠它）", /realDir: skill\.dir \|\| ""/.test(serviceSource) && /dir: join\(dir, entry\.name\)/.test(catalogSource));
ok("插件自带的 Skill 也带 dir（root 与 dir 语义不同，别混用）", /kind: "skill", root: dir, dir,/.test(catalogSource) && /kind: "skill", root: join\(dir, entry\.name\), dir: join\(dir, entry\.name\)/.test(catalogSource));
ok("条目形状变了 → CATALOG_VERSION 跟着 +1（R8 曾把它抬到 5，R9 又抬到 6）", /export const CATALOG_VERSION = \d+;/.test(catalogSource) && Number((catalogSource.match(/export const CATALOG_VERSION = (\d+);/) || [])[1]) >= 5);
ok("客户端有「体积」排序（清理决策的第一问是能省多少）", /SORTS[\s\S]{0,600}id: "size", label: "体积"/.test(clientSource));
ok("体积排序按字节降序，量不到的按 0 排后面", /state\.sort === "size"[\s\S]{0,260}sizeOfItem\(b, sizeMap\) \|\| 0\) - \(sizeOfItem\(a, sizeMap\) \|\| 0\)/.test(clientSource));
ok("sizeOfItem 量不到返回 null（绝不返回 0）", /function sizeOfItem\(item, sizeMap\)[\s\S]{0,200}return Number\.isFinite\(value\) \? value : null/.test(clientSource));
ok("卡片上有体积 chip，且有样式定义", cssSource.includes(".dpc-size{") && clientSource.includes('className: "dpc-size"'));
ok("量不到的条目卡片上不显示体积（于是也不会出现「0 B」）", /props\.size\s*\n\s*\? h\(\s*\n\s*"span",\s*\n\s*\{\s*\n\s*className: "dpc-size"/.test(clientSource) && clientSource.includes('fmtBytes(props.size) + (props.sizeTruncated ? "+" : "")'));
ok("超预算的条目带「+」并在 title 里说明（数字是下限）", clientSource.includes("只算到这里（实际只会更大）") && /fmtBytes\(props\.size\) \+ \(props\.sizeTruncated \? "\+" : ""\)/.test(clientSource));
ok("工具条显示当前筛选的体积合计，并点出「无可量目录」条数", clientSource.includes('"合计 " +') && clientSource.includes("条无可量目录") && clientSource.includes("条还没量"));
ok("自动量体积有闸门：本挂载一次 + 有任务不抢 + 过期才量", /const autoSized = useRef\(false\)/.test(clientSource) && /if \(data\.job && data\.job\.running\) return;/.test(clientSource) && /const SIZES_TTL_MS = 24 \* 60 \* 60 \* 1000/.test(clientSource));
ok("导出的表格带体积列（清单拿出去也要能支撑决策）", serviceSource.includes("| 体积 |") && serviceSource.includes("formatBytes(bytes)"));
ok("Skill 浮窗也有「位置与体积」块（不再只有插件才看得到）", clientSource.includes('"位置与体积"') && clientSource.includes("技能目录"));
ok("面板有「量体积」入口（不必等 24 小时的自动刷新）", clientSource.includes('sizesAt ? "重量体积" : "量体积"'));

/* ─────────── R9（2026-10-22 第九轮）：依赖归属 ───────────
   回答「体积 Top 里那个 354 MB 的二进制是谁带进来的」「删它会不会弄坏别人」。
   锁四件事，都是"结论错得很安静"的那种：
   ① 依赖图必须读**所有**包的 package.json —— 只读 DSH 插件会得出"没人依赖它、可以删"的错误结论；
   ② 「无人依赖」只能是**候选**（文案必须带确认），嵌套更深的声明可能漏读；
   ③ 嵌套 node_modules 至少展开一层，否则只被嵌套声明的包会被误判；
   ④ 条目形状变了 → CATALOG_VERSION 6。 */
const toolsSource = readFileSync(new URL("../lib/tools.mjs", import.meta.url), "utf8");
ok(
	"依赖图读所有包（先记依赖，再看它像不像 DSH 插件）",
	/const depIndex = new Map\(\)/.test(catalogSource) &&
		/if \(meta\) mergeDep\(meta\.name, meta\.deps\)/.test(catalogSource) &&
		catalogSource.indexOf("mergeDep(meta.name") < catalogSource.indexOf("const looksLikeDshPlugin"),
);
ok("依赖收集含 dependencies / optionalDependencies / peerDependencies 三类", /for \(const key of \["dependencies", "optionalDependencies", "peerDependencies"\]\)/.test(catalogSource));
ok("嵌套 node_modules 展开一层（否则只被嵌套声明的包会被误判成没人要）", /const nested = join\(dir, "node_modules"\)/.test(catalogSource) && /name\.startsWith\("@\"\) \? \(await readdir\(join\(nested, name\)\)/.test(catalogSource));
ok("反向索引：谁声明了它（一个依赖可被多个包声明）", /const dependentsOf = new Map\(\)/.test(catalogSource) && /dependentsOf\.get\(dep\)\.push\(name\)/.test(catalogSource));
ok(
	"条目带 dependents / dependentCount / dependsOn / dependsOnCount",
	["dependents: pack.dependents || []", "dependentCount: pack.dependentCount || 0", "dependsOn: pack.dependsOn || []", "dependsOnCount: pack.dependsOnCount || 0"].every((needle) => catalogSource.includes(needle)),
);
ok("条目形状变了 → CATALOG_VERSION = 10（R30 加 MCP 条目；R19 的 contentHash、R14 的 packageName / aliasOf 同一条线索）", /export const CATALOG_VERSION = 10;/.test(catalogSource));
ok("依赖图自述进快照（扫了多少包 / 多少直接依赖 / 几个候选 / 加载路径四态）", /dependencyMeta: depMeta \|\| \{ scanned: 0, direct: 0, orphanHint: 0, loadRoots: 0, loadCounts: \{ bundle: 0, config: 0, transitive: 0, dormant: 0 \}, compositionFiles: 0 \}/.test(catalogSource));
ok("state 与 /health 都带依赖图", (serviceSource.match(/dependency: this\.catalog\?\.dependencyMeta \|\| null,/g) || []).length === 2);
ok("导出清单加「被依赖 / 加载」两列（拿出去也要能判断）", serviceSource.includes('"| 名称 | 类型 | 来源 | 调用 | 报错 | 报错率 | 最近一次 | 体积 | 被依赖 | 加载 | 位置 |"'));
ok("体积 Top 表也带被依赖（大二进制不是可删插件）", serviceSource.includes('"| 名称 | 类型 | 来源 | 体积 | 文件数 | 被依赖 | 调用 | 最近 |"'));
ok("catalog_health 报依赖图（工具面也能问「能删什么」）", toolsSource.includes("依赖图：") && toolsSource.includes("health.dependency.scanned"));
ok("catalog_list 的条目点出被依赖 / 无人依赖", toolsSource.includes("被 ${item.dependentCount} 个包依赖") && toolsSource.includes("无人依赖（候选）"));
ok("客户端有 isOrphanHint / depLabel 两个纯函数（可直接断言）", /function isOrphanHint\(item\)/.test(clientSource) && /function depLabel\(item\)/.test(clientSource));
ok("卡片上有依赖 chip（有依赖=中性，无人依赖=琥珀）", cssSource.includes(".dpc-dep{") && cssSource.includes(".dpc-dep.is-orphan{") && clientSource.includes("depLabel(item)"));
ok("浮窗有「依赖关系」块（被谁依赖 / 它依赖谁）", clientSource.includes('"依赖关系"') && clientSource.includes("它自己声明依赖 "));
ok("工具条有「无人依赖」筛选按钮", clientSource.includes('"无人依赖 " + orphanCount'));
ok("候选措辞带「确认」（不许把候选写成结论）", clientSource.includes("这是候选，动之前用 npm ls / pnpm why 确认") && clientSource.includes("仍需 npm ls / pnpm why 确认"));
ok("「被依赖」的体积在合计里单独点出（不算可回收空间）", clientSource.includes("被其它插件依赖（删了会连带弄坏），不能算作可回收空间") && clientSource.includes("lockedBytes"));

/* ─────────── R10（2026-10-22 第十轮）：把验收固定成一条命令 ───────────
   以前"发版体检"= 人跑三条命令 + 人眼对数字 + 人看 git 干净不干净，换会话时最容易漏。
   现在：dev/ship.mjs 一条命令跑完，面板头部「自检」按钮走同一条路（POST /preflight）。
   锁四件事：① 体检必须走子进程（三条脚本会 process.exit，import 进来会把宿主带死）；
             ② 解释器要用宿主 exe + ELECTRON_RUN_AS_NODE（否则 asar 断言只能 SKIP）；
             ③ 版本号与构建戳不一致要算失败（"改了代码忘了抬版本"的固定防线）；
             ④ 环境跑不了的断言记 SKIP 而不是 FAIL，但要响亮地打出来。 */
const shipSource = readFileSync(new URL("../dev/ship.mjs", import.meta.url), "utf8");
/* R18：清单单独一份（ship 与面板 dry 共用）；不定义它，断言就只能盯着 ship.js 里那个别名 */
const shipChecksSource = readFileSync(new URL("../dev/ship-checks.mjs", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../index.js", import.meta.url), "utf8");
const hosttestSource = readFileSync(new URL("../dev/hosttest.mjs", import.meta.url), "utf8");
ok("发版体检清单是单源（dev/ship-checks.mjs），且默认跑五项（audit / render / hosttest / probes / staging）", ["audit", "render", "hosttest", "probes", "staging"].every((id) => shipChecksSource.includes('id: "' + id + '"')) && shipSource.includes("const CHECKS = SHIP_CHECKS"));
ok("体检脚本可被面板当接口用：--json 只输出一段 JSON，进度走 stderr", shipSource.includes("if (asJson) {") && shipSource.includes('process.stderr.write("ship:check:start:') && shipSource.includes("delete env.DSH_CATALOG_KEEP"));
ok("版本号 ↔ 构建戳对不上要算失败（并给出期望前缀）", /export function versionVerdict/.test(shipSource) && shipSource.includes("对不上（应形如 "));
ok("自检输出解析成 passed / failed / skipped（三条脚本格式一致）", /export function parseCheckOutput/.test(shipSource) && shipSource.includes('pick("skipped")'));
ok("结论只看「版本一致 + 三条全绿」，git 脏只报不拦", shipSource.includes("const ok = version.ok && results.every((result) => result.ok)") && shipSource.includes("只报不拦"));
ok("报告写在 .cache/ship-<时间戳>.md（.cache 不入库，路径给面板）", shipSource.includes('join(REPO, ".cache", "ship-" + stamp + ".md")'));
ok("宿主侧体检走子进程 + ELECTRON_RUN_AS_NODE（否则 asar 断言只能 SKIP）", serviceSource.includes("async runPreflight(") && serviceSource.includes('env.ELECTRON_RUN_AS_NODE = "1"') && serviceSource.includes("spawn(process.execPath, [script, \"--json\"]"));
ok("子进程结论解析不出来时如实报错（不假装通过）", serviceSource.includes("体检脚本没有给出 JSON 结论") && serviceSource.includes("体检结论不是合法 JSON"));
ok("路由 POST /preflight：dry=true 只回会跑什么，否则起后台任务", indexSource.includes('path === "/preflight"') && indexSource.includes("catalog.startJob(\"preflight\"") && indexSource.includes("body.dry === true"));
ok("面板头部有「自检」按钮，跑的时候禁用（单任务闸）", clientSource.includes('onClick: runPreflight') && clientSource.includes('"自检"') && /disabled: job\.running,\s*\n\s*title: "发版体检/.test(clientSource));
ok(
	"体检结论抬到提示条；且 refresh 与轮询**两条取数路径**都调（本轮真 bug：只写在 refresh 里 → 点完永远看不到结果）",
	clientSource.includes("function notePreflight(data)") && (clientSource.match(/notePreflight\(data\)/g) || []).length >= 2 && clientSource.includes("preflightNoticeAt") && clientSource.includes(`自检全绿："`),
);
ok("环境跑不了的断言记 SKIP（不算失败，但要打出来）", /function skip\(name, why\)/.test(hosttestSource) && hosttestSource.includes("skippedItems.length > 0"));
ok("README 双语都写了这一条命令", readFileSync(new URL("../README.md", import.meta.url), "utf8").includes("node dev/ship.mjs") && readFileSync(new URL("../README.en.md", import.meta.url), "utf8").includes("node dev/ship.mjs"));

/* ─────────── R11（2026-10-23 第十一轮）：从「发现问题」到「处置」 ───────────
   前几轮把「什么旧了 / 谁被谁依赖 / 删了能省多少」都查出来了，但**只能看**：
   面板上写着「3 个 Skill 的 staging 是旧的」，接下来还得让 Agent 开工具或人翻文档。
   这一轮把处置收进面板，并把这条判据固化成体检的第 4 项。锁五件事：
     ① 判据只有一份（lib/staging.mjs）—— 面板、工具、体检三方共用，不许各写一套；
     ② 同步只许单向 live → staging，覆盖前必须备份（方向反了就是把线上覆盖回旧版）；
     ③ 写盘闸在**服务端**（confirm:true），不在按钮上 —— 误点最多出一份计划；
     ④ 体检第 4 项只报不拦（与 git 脏同一条口径），且不进 passed 合计；
     ⑤ 面板能直接摊开体检失败项，不用先去 .cache 找报告。 */
const stagingSource = readFileSync(new URL("../lib/staging.mjs", import.meta.url), "utf8");
ok(
	"判据与复制收在一个模块里（面板、工具、体检共用，不许各写一套）",
	stagingSource.includes('export const SKILL_FILE = "SKILL.md"') &&
		stagingSource.includes("export const SKILL_MTIME_TOLERANCE_MS = 60 * 1000") &&
		["export function skillVerdict", "export async function scanSkillStaging", "export async function copySkillToStaging", "export function skillStamp", "export function isStaleVerdict"].every((needle) => stagingSource.includes(needle)),
);
ok("「旧了」是白名单判据（staging 更新不算，绝不能自动同步）", stagingSource.includes('export const STALE_VERDICTS = Object.freeze(["differs", "newer-loaded", "missing-staged"])'));
ok("复制只做单向 live → staging，并把 staging 那份备份成 .bak-<stamp>", stagingSource.includes("const source = join(loadedDir, SKILL_FILE)") && stagingSource.includes('const candidate = target + ".bak-" + stamp'));
ok("service 不再自己比 SKILL.md（改走 staging.mjs）", serviceSource.includes('from "./staging.mjs"') && !serviceSource.includes('fingerprintDir(staged, ["SKILL.md"])') && !serviceSource.includes('fingerprintDir(liveDir, ["SKILL.md"])'));
ok(
	"service 把 missing-* 归成 differs（客户端 driftLabel 的契约只有三种值，多一种会让卡片静默不标）",
	serviceSource.includes('comparison.verdict.startsWith("newer-")') && serviceSource.includes(': "differs";'),
);
ok("service 的同步走 copySkillToStaging（与新模块同一份备份/方向逻辑）", serviceSource.includes("await copySkillToStaging({ loadedDir: item.loadedDir, stagedDir: item.stagedDir, stamp })"));
ok("计划只收「旧了」的（isStaleVerdict），不再手写两种 verdict", serviceSource.includes("if (isStaleVerdict(entry.verdict))"));

ok("路由 POST /skillsync：不带 apply 只出计划，带 apply 必须再带 confirm", indexSource.includes('path === "/skillsync"') && indexSource.includes("catalog.syncStagedSkills({ ids })") && indexSource.includes("catalog.syncStagedSkills({ ids, apply: true, confirm: body.confirm === true })"));
ok("/preflight 的 dry 清单来自单源（不再硬编码：R18 收进探针后 dry 仍只报四项，hosttest 抓到过）", indexSource.includes("checks: shipCheckIds()"));
/* ★ R14：这条断言改成只看 runPreflight 的正文 —— 别的后台任务（处置清单）有自己的
   `total: 3`（三项固定阶段），拿整个文件做"不许出现 total: 3"会误伤。 */
const preflightBody = serviceSource.slice(serviceSource.indexOf("async runPreflight({ onProgress } = {})"), serviceSource.indexOf("async refreshStats("));
ok("runPreflight 的 total 由 ship 事件给（不写死 3，否则加一项进度条就骗人）", preflightBody.includes("ship:check:total:") && !preflightBody.includes("total: 3"));
ok("ship 发 total 事件（面板画「第 2/N 项」）", shipSource.includes('process.stderr.write("ship:check:total:" + selected.length'));
ok("副本同步在 ship 本进程内跑（只 stat 几十个文件，不值得再起一个 node）", shipChecksSource.includes("inline: true") && /async function stagingCheck\(/.test(shipSource) && shipSource.includes("scanSkillStaging({ roots: skillRoots(settings.workspace), stageDir })"));
ok("副本同步只报不拦，且不进 passed/failed 合计", shipChecksSource.includes("informational: true") && shipSource.includes("const counted = results.filter((result) => result.informational !== true)") && shipSource.includes("results.every((result) => result.ok)"));
ok("第 4 项自己坏掉要算失败（扫描抛错 ≠ staging 旧了）", shipSource.includes("副本同步检查自身失败"));
ok("人读输出把「只报不拦」写出来（别让人以为红了也不用管）", shipSource.includes("· 只报不拦"));
ok("报告单独一段写「几对里几个旧 + 目录 + 处理办法」", shipSource.includes('"## 副本同步（Skill 的 staging）"') && shipSource.includes("catalog_skill_sync action=apply confirm=true"));

ok(
	"客户端判据是白名单函数（isStageStale / staleSkillIds 可直接断言）",
	/function isStageStale\(drift\) \{/.test(clientSource) &&
		clientSource.includes('drift.verdict === "differs" || drift.verdict === "newer-loaded"') &&
		/function staleSkillIds\(driftMap\) \{/.test(clientSource),
);
ok("同步是「出计划 → 二次确认 → 写盘」三步，不是一点就写", clientSource.includes("async function planStageSync(ids)") && clientSource.includes("async function applyStageSync()") && clientSource.includes('post("/skillsync", { ids, apply: true, confirm: true })'));
ok(
	"计划不进 localStorage（重载后必须重新出计划，不能拿过期计划覆盖文件）",
	(() => {
		const match = /const VIEW_KEYS = \[([^\]]*)\];/.exec(clientSource);
		return Boolean(match) && !match[1].includes("syncPlan") && !match[1].includes("syncBusy");
	})(),
);
ok("公告条上就有入口（不用先想到开工具）", clientSource.includes('"同步 staging（"') && clientSource.includes("planStageSync(staleSkills)"));
ok("浮窗里也能同步这一份（只对 staging 旧了的两类）", clientSource.includes('"同步这一份 → staging"') && clientSource.includes("isStageStale(drift)"));
ok("浮窗只显示「只针对这一条」的确认计划（批量计划显示在单个浮窗里会误导）", clientSource.includes("state.syncPlan.items.length === 1") && clientSource.includes("state.syncPlan.items[0].id === item.id"));
ok("确认条写明：覆盖几个 / 方向 / 备份 / 不动加载的那份", clientSource.includes('" 个 Skill 的 SKILL.md 复制到 staging（"') && clientSource.includes("不会动 DSH 正在加载的那份"));
ok("体检结论卡把失败项摊在面板上（不再只有一行提示条）", clientSource.includes("function PreflightCard(props)") && clientSource.includes("preflightResult ? h(PreflightCard") && clientSource.includes("check.failures || []"));
ok("体检卡读服务端单独存的 `preflight`（不读 job 那一格：job 会被统计自愈顶掉）", clientSource.includes("(data && data.preflight) || null") && serviceSource.includes("preflight: this.lastPreflight") && serviceSource.includes("this.lastPreflight = finalPayload"));
ok("体检卡区分「informational」项（副本同步没有 passed/failed）", clientSource.includes("check.informational") && clientSource.includes("对\" + (Array.isArray(check.stale) && check.stale.length ? \" / \" + check.stale.length + \" 旧\""));
ok("提示条也按 informational 的口径说话（不再出现「staging ?」）", clientSource.includes('return check.id + " " + (check.ok === false ? "失败"'));
ok("新类名都有样式定义", [".dpc-preflight{", ".dpc-preflight-check.is-bad{", ".dpc-preflight-fail{", ".dpc-sync-bar{", ".dpc-sync-confirm{", ".dpc-sync-name{"].every((needle) => cssSource.includes(needle)));
ok("README 双语都写了面板上的「同步 staging」", readFileSync(new URL("../README.md", import.meta.url), "utf8").includes("同步 staging") && readFileSync(new URL("../README.en.md", import.meta.url), "utf8").includes("Sync staging"));


/* ─────────── R12（2026-10-23 第十二轮）：装了到底会不会跑 ───────────
   本轮的起点是一个**会误导人删坏东西**的显示 bug：面板只有 `enabled`（在不在 bundles），
   却把它写成「启用：是 / 否」并把 `false` 的卡片置灰。可 `bundles` 不是唯一入口 ——
   配置条目按 name 能直接挂包，依赖链也能带。本机实测 `enabled === false` 的 26 个包里
   **24 个其实在跑**（`@dsh-ops/bash-win32-x64` 354 MB + 19 个 `dsh-mnemon-*`）。
   这一轮锁六件事：
     ① 判据只有一份（lib/loadstate.mjs）：bundles ∪ 配置条目 = 入口，沿依赖 BFS 得四态；
     ② 入口要排除 `disabled: true` 的配置条目；配置里的**嵌套** id/name 不算条目；
     ③ 「不会被加载」只在 dormant 时说；宿主没给 loadState 时一律"未知"，绝不拿 enabled 猜；
     ④ 置灰只跟 dormant 走（旧口径把在跑的包置灰）；
     ⑤ 面板能用「不会被加载 N」筛出这批，工具/health/导出同一口径；
     ⑥ 新字段必须在旧快照上"退化"而不是报错（loadState 缺失时客户端按未知渲染）。 */
ok("四态是冻结白名单（顺序即展示优先级）", JSON.stringify(LOAD_STATES) === JSON.stringify(["bundle", "config", "transitive", "dormant"]) && Object.isFrozen(LOAD_STATES));

const compFixture = [
	"# 注释行不该影响解析",
	"- id: alpha",
	"  name: dsh-alpha",
	"  config:",
	"    - id: nested-entry",
	"      name: NESTED-MUST-NOT-COUNT",
	"    models:",
	"      - id: k3",
	"        name: Kimi K3",
	"- id: beta",
	"  name: '@scope/pkg'",
	"  disabled: true",
	"- id: gamma",
	'  name: "dsh-gamma"',
].join("\n");
const compEntries = parseComposition(compFixture);
eq("组合文件只收顶层条目（嵌套 config 里的 id/name 不算）", compEntries.map((entry) => entry.name), ["dsh-alpha", "@scope/pkg", "dsh-gamma"]);
ok("条目带 id / disabled（`disabled: true` 要被认出来，否则已摘掉的条目会被当入口）", compEntries[0].id === "alpha" && compEntries[1].disabled === true && compEntries[0].disabled === false);
ok("引号被剥掉（'@scope/pkg' 与 \"dsh-gamma\"）", compEntries[1].name === "@scope/pkg" && compEntries[2].name === "dsh-gamma");
eq("空文本 / null 不抛", parseComposition(""), []);
eq("null 输入也不抛", parseComposition(null), []);

const graph = new Map([
	["root-a", ["dep-x"]],
	["root-b", []],
	["dep-x", ["deep-y"]],
	["deep-y", []],
	["cfg-only", ["cfg-dep"]],
	["cfg-dep", []],
	["disabled-root", []],
	["lonely", []],
	["cycle-a", ["cycle-b"]],
	["cycle-b", ["cycle-a"]],
]);
const resolved = resolveLoadPaths({
	bundles: ["root-a", "root-b", "official-in-asar"],
	compositions: [
		{ id: "cfg-entry", name: "cfg-only", disabled: false },
		{ id: "off-entry", name: "disabled-root", disabled: true },
	],
	installed: graph,
});
const stateOf = (name) => resolved.byName.get(name) || { state: "", via: "" };
eq("bundles 命中 → bundle", stateOf("root-a").state, "bundle");
eq("配置条目名命中已装 → config（不在 bundles 也加载）", { state: stateOf("cfg-only").state, via: stateOf("cfg-only").via }, { state: "config", via: "cfg-entry" });
eq("被配置条目带到 → transitive，via 记的入口是那个配置条目 id", stateOf("cfg-dep"), { state: "transitive", via: "cfg-entry" });
eq("沿依赖链两跳也点亮（root-a → dep-x → deep-y）", stateOf("deep-y"), { state: "transitive", via: "root-a" });
eq("谁都不是 → dormant", stateOf("lonely"), { state: "dormant", via: "" });
ok("被 `disabled: true` 摘掉的配置条目不进入口（它自己不亮、也不许带亮依赖）", stateOf("disabled-root").state === "dormant");
eq("入口本身不在 installed 里也算入口（官方包在 asar）", resolved.roots.some((root) => root.name === "official-in-asar" && root.why === "bundle"), true);
eq("循环依赖不死循环", { a: stateOf("cycle-a").state, b: stateOf("cycle-b").state }, { a: "dormant", b: "dormant" });
eq("四态计数覆盖全部已装包（不许有包落不进任何一态）", LOAD_STATES.reduce((sum, state) => sum + resolved.counts[state], 0), graph.size);ok("isLoadedState / isDormantState 互斥且只认四态", isLoadedState("bundle") && isLoadedState("config") && isLoadedState("transitive") && !isLoadedState("dormant") && isDormantState("dormant") && !isDormantState("bundle") && isLoadedState("unknown") === false);
ok("四态各有一句人话，且互不相同（不许两种状态说同一句话）", new Set(LOAD_STATES.map((state) => loadStateLabel(state, "x"))).size === LOAD_STATES.length && loadStateLabel("transitive", "dsh-ops").includes("dsh-ops"));

ok("hostinfo 读的是两份组合文件（cordis.yml + cordis.patch.yml）", hostinfoSource.includes("export async function profileComposition()") && hostinfoSource.includes('["cordis.yml", "cordis.patch.yml"]'));
ok("catalog 把四态挂到条目上，并记入口数与组合文件数", catalogSource.includes("const loadPaths = resolveLoadPaths({ bundles: [...bundles], compositions, installed: depIndex })") && catalogSource.includes("loadState: pack.loadState ||") && catalogSource.includes("loadRoots: loadPaths.roots.length") && catalogSource.includes("compositionFiles: composition.files.length"));
ok("官方 asar 包直接记 bundle（它们的入口就是 bundles 本身）", catalogSource.includes('loadState: "bundle"'));
ok("service 把 loadState / loadVia 透传给面板（缺字段时客户端按未知渲染）", serviceSource.includes("loadState: plugin.loadState ||") && serviceSource.includes("loadVia: plugin.loadVia ||"));
ok("catalog_health 报加载路径四态（不再只报 bundles 口径）", toolsSource.includes("加载路径：") && toolsSource.includes("health.dependency.loadCounts.dormant") && toolsSource.includes("不在任何入口上"));
ok("catalog_list 不再用 enabled 说「未启用」（改为 dormant / config 两句话）", !toolsSource.includes('(item.enabled === false ? "｜未启用"') && toolsSource.includes("不会被加载（不在 bundles、没有配置条目、也不在任何依赖链上）"));

/* ── R14.1：工具面也能按加载态筛（此前只有面板能筛，工具只能翻页找） ── */
{
	const listTool = tools.find((tool) => tool.name === "catalog_list");
	const listParams = (listTool && listTool.parameters && listTool.parameters.properties) || {};
	const listDesc = String((listTool && listTool.description) || "");
	ok("catalog_list 有 loadState 过滤（enum：any / dormant / loaded）", Array.isArray(listParams.loadState && listParams.loadState.enum) && ["any", "dormant", "loaded"].every((value) => listParams.loadState.enum.includes(value)));
	ok("catalog_list 的描述让「哪些装了不会跑」可映射（点明 dormant 与 catalog_uninstall）", listDesc.includes("不会跑") && listDesc.includes("dormant") && listDesc.includes("catalog_uninstall"));
	/* 判据单源：工具面走 lib/loadstate.mjs，不许在这里另写一套四态比较式 */
	ok("工具面的加载态判据与 loadstate.mjs 同源（import isLoadedState，不另写比较式）", toolsSource.includes('import { isLoadedState } from "./loadstate.mjs"') && toolsSource.includes("!isLoadedState(item.loadState)") && !/item\.loadState === "(bundle|transitive)"/.test(toolsSource));
	ok("dormant 过滤只认字面量 dormant（与面板 isDormant 同一条件）", toolsSource.includes('loadState === "dormant" && item.loadState !== "dormant"'));
}

ok("客户端 isDormant 只认 loadState === 'dormant'（enabled === false 不算）", /function isDormant\(item\) \{/.test(clientSource) && clientSource.includes('return Boolean(item && item.loadState === "dormant");'));
ok("卡片置灰只跟 dormant 走（旧口径 `enabled === false ? \" is-off\"` 必须消失）", !clientSource.includes('(item.enabled === false ? " is-off"') && clientSource.includes('(isDormant(item) ? " is-off"'));
ok("卡片 chip 只给两档（不会被加载 / 配置入口），间接加载 152 条不占版面", clientSource.includes('if (item.loadState === "dormant") return "不会被加载";') && clientSource.includes('if (item.loadState === "config") return "配置入口";'));
ok("详情页「启用」格子按四态说人话（配置(id)/随 X/是/否）", clientSource.includes('if (item.loadState === "config") return "配置("') && clientSource.includes('if (item.loadState === "transitive") return "随 "') && clientSource.includes("loadCell(item)"));
ok("工具条有「不会被加载 N」筛选，且进 localStorage（视图记忆）", clientSource.includes('"不会被加载 " + dormantCount') && clientSource.includes("if (state.dormantOnly && !isDormant(item)) return false;"));
ok("筛选计数只受 kind/source 影响（不随关键词跳）", /const dormantCount = useMemo\(\(\) => \{[\s\S]{0,260}state\.kind === "all"[\s\S]{0,160}state\.source === "any"/.test(clientSource));
ok("新类名都有样式定义", [".dpc-load{", ".dpc-load.is-config{", ".dpc-load-warn{"].every((needle) => cssSource.includes(needle)));
ok("README 双语都写了「不会被加载」这个口径", readFileSync(new URL("../README.md", import.meta.url), "utf8").includes("不会被加载") && readFileSync(new URL("../README.en.md", import.meta.url), "utf8").includes("not loaded"));

/* ─────────── R13（2026-10-24 第十三轮）：收口 —— 把这一轮的过程与结果固化 ───────────
   R12 的判据同时被 catalog / health / 面板三处共用：好处是口径一致，
   坏处是**共用就没法互相证伪**（一起错就一起绿）。这一轮补两件"离开对话也还在"的东西：
     ① `dev/probe-loadstate.mjs`：自己扫 profile、用同一份判据**独立重算**，再和目录快照对账，
        六条不变式（计数守恒 / bundle 口径 / via 指得回入口 / dormant 与入口无交集 /
        disabled 不算入口 / 快照与重算一致），破一条就退出码 1；
     ② 报告口径：`catalog_export` 的概览带「加载路径」，并单开一节「不会被加载」，
        当前筛选的清单多一列「加载」—— 拿出去的清单也要能支撑"删不删"。 */
const probeSource = readFileSync(new URL("../dev/probe-loadstate.mjs", import.meta.url), "utf8");
ok(
	"独立探针存在，且用的是 lib 的判据（不是又抄一遍实现）",
	probeSource.includes('from "../lib/loadstate.mjs"') && probeSource.includes("resolveLoadPaths") && probeSource.includes("parseComposition"),
);
ok(
	"探针不硬编码本机路径（换机器/换 profile 也能跑）",
	!/D:[\\/]信息库/.test(probeSource) && !/C:[\\/]Users/.test(probeSource),
);
ok(
	"探针把六条不变式都列出来，破一条就非零退出（不是只打印数字）",
	["I1", "I2", "I3", "I4", "I5", "I6"].every((id) => probeSource.includes(id)) && probeSource.includes("process.exit(1)") && probeSource.includes("failures.push"),
);
ok(
	"探针的 dormant 清单带体积（能回答「删这批能省多少」）",
	probeSource.includes("dormantBytes") && probeSource.includes('"sizes.json"') && probeSource.includes("fmtBytes"),
);
ok("快照口径也进导出：概览有「加载路径」一行", serviceSource.includes('" 份组合文件）；直接 **"') && serviceSource.includes("不在任何入口上"));
ok("导出单开一节「不会被加载」（含声明层面的边界说明）", serviceSource.includes('"## 不会被加载（"') && serviceSource.includes("运行时按路径 `require()` 的动态加载看不见"));
ok("当前筛选的清单多一列「加载」（不会被加载 / 配置挂载 / 随 X 加载 / 是 / 未知）", serviceSource.includes('"| 名称 | 类型 | 来源 | 调用 | 报错 | 报错率 | 最近一次 | 体积 | 被依赖 | 加载 | 位置 |"') && serviceSource.includes('if (item.loadState === "dormant") return "不会被加载";'));
/* ─────────── R15（2026-10-24 第十五轮）：标签闭环 ───────────
   这一轮的起点是一个**事实**而不是一个想法：`.dsh-plugin-catalog/tags.json` 从来不存在 ——
   标签系统（内置 27 个标签 / 自定义 / AI 分类 / 详情浮窗编辑器 / catalog_tag 工具）代码齐全、
   却在这台机器上**一次都没被用过**。没跑过的子系统是最不可信的那部分代码，
   所以要补的不是"再来一个功能"，而是让标签这条链**真的有入口、有出口**：
     ① 入口：批量打标（面板多选 → 打标；工具 catalog_tag 传 ids）—— 逐条点 133 个条目不现实；
     ② 出口：按标签筛选（同维度 OR、跨维度 AND）—— 打了却筛不出来的标签等于没打。 */

const tagsSource = readFileSync(new URL("../lib/tags.mjs", import.meta.url), "utf8");

ok(
	"批量打标是独立的加减函数，不是复用「整条替换」",
	tagsSource.includes("export function applyTagOps(") && tagsSource.includes('op === "remove" ? "remove" : "add"') && !/applyTagOps[\s\S]{0,400}store\.assignments\[entryId\] = \{ \.\.\.clean/.test(tagsSource),
);
ok(
	"批量打标保持幂等：先算目标集合再与现状比，无变化就不写盘",
	tagsSource.includes("sameSet(previous[dimension] ?? [], next[dimension])") && tagsSource.includes("function sameSet("),
);
ok(
	"标签维度必须对得上（把「界面」当 context 打进去以后永远筛不出来）",
	tagsSource.includes("if (!tag || tag.dimension !== dimension)") && tagsSource.includes("unknownTags.push(tagId)"),
);
ok(
	"把标签全去掉时删分配记录、不写空记录（写空记录会让 AI 分类永远跳过这条）",
	tagsSource.includes("delete store.assignments[entryId]") && !/next\.purpose\.length === 0 && next\.context\.length === 0\) continue;/.test(tagsSource),
);
ok(
	"service 的 applyTags 先校验 id 在目录里（防 tags.json 长幽灵分配）",
	serviceSource.includes("async applyTags(entryIds, ops, by = \"user\")") && serviceSource.includes("new Set(this.listEntries().items.map((entry) => entry.id))") && serviceSource.includes("unknownIds"),
);
ok("/tags 路由注册了 batch 动作，并走同一个 service 方法", routeSource.includes('if (action === "batch")') && routeSource.includes("catalog.applyTags("));
ok(
	"catalog_tag 支持批量（ids）与去掉标签（untag），schema 里都声明了",
	toolsSource.includes('"untag"') && toolsSource.includes("ids: { type: \"array\"") && toolsSource.includes("service.applyTags(args.ids, ops"),
);
ok(
	"批量与单个的语义在工具描述里写清楚（追加/去掉 vs 整条替换）",
	/批量（传 ids）的语义是\*\*追加\/去掉\*\*/.test(toolsSource) && toolsSource.includes("整条替换"),
);
ok("面板有标签筛选状态，且进了视图持久化白名单", clientSource.includes("tagFilter: []") && /VIEW_KEYS = \[[^\]]*"tagFilter"/.test(clientSource));
ok(
	"筛选是「同维度 OR、跨维度 AND」（不是把所有选中标签取交集）",
	clientSource.includes("const grouped = { purpose: [], context: [] };") && clientSource.includes("grouped.purpose.some((id) => (item.tags?.purpose || []).includes(id))") && clientSource.includes("grouped.context.some((id) => (item.tags?.context || []).includes(id))"),
);
ok(
	"筛选行只列「真的有条目在用」的标签（0 命中的标签点进去是空页，不是筛选）",
	clientSource.includes("const tagUsage = useMemo(") && clientSource.includes("tagUsage.size > 0"),
);
ok("批次条上有「打标」入口，且只在有选中项时可点", clientSource.includes("onClick: () => set({ tagPick: { ids: state.picked.slice() } }),") && /disabled: state\.picked\.length === 0,[\s\S]{0,200}?title: "给选中的这批条目一次打上/.test(clientSource));
ok(
	"批量打标浮层是三态的（全有 / 部分有 / 已排上加减），不是二态开关",
	clientSource.includes("function TagBatchModal(props)") && clientSource.includes('return picked.length > 0 && have(tagId, dimension) === picked.length ? "remove" : "add";') && clientSource.includes('return n === picked.length ? " is-all" : " is-part";'),
);
ok(
	"浮层里的勾选是本地待提交（点应用才发一次请求，不会留半个批次）",
	clientSource.includes("const [ops, setOps] = useState({});") && clientSource.includes('post("/tags", { action: "batch", ids: picked.map((item) => item.id), ops: list })'),
);
ok("标签筛选行与三态都有样式", [".dpc-tagfilter{", ".dpc-facet-chip{", ".dpc-facet-chip.is-on{", ".dpc-tag.is-part{", ".dpc-tag.is-add{", ".dpc-tag.is-remove{"].every((needle) => cssSource.includes(needle)));

const tagsProbeSource = readFileSync(new URL("./probe-tags.mjs", import.meta.url), "utf8");
ok(
	"批量打标有独立探针（幂等 / 只加不减 / 清空删记录 —— 这三条静态契约看不出来）",
	tagsProbeSource.includes("applyTagOps") && ["T1", "T2", "T5", "T6"].every((id) => tagsProbeSource.includes(id)) && tagsProbeSource.includes("process.exit(1)"),
);
ok("探针不碰真数据（store 是内存空壳，不读也不写 tags.json）", tagsProbeSource.includes("function emptyStore()") && !tagsProbeSource.includes("loadTagsStore") && !tagsProbeSource.includes("saveTagsStore"));

/* ★ R29 故意不抬版本：这一轮只加 dev 工具与文档、零运行期改动。
   抬版本会让 live-check 的版本 canary 立刻变红（宿主还是旧的那份），换会话前反而要人多做一次重启 ——
   而版本钉子存在的意义是"改了运行期代码别忘了抬"，不是"每次动仓库都要抬"。 */
ok("版本号与构建戳同步抬到 0.30.0 / r30.0", /"version": "0\.30\.0"/.test(readFileSync(new URL("../package.json", import.meta.url), "utf8")) && clientSource.includes('const BUILD = "r30.0"'));


ok(
	"双语 README 都写了独立探针（英文版也要能照着跑）",
	readFileSync(new URL("../README.md", import.meta.url), "utf8").includes("dev/probe-loadstate.mjs") && readFileSync(new URL("../README.en.md", import.meta.url), "utf8").includes("dev/probe-loadstate.mjs"),
);

/* ─────────── R14：处置清单（不会被加载 → 怎么卸干净） ─────────── */
const uninstallSource = readFileSync(new URL("../lib/uninstall.mjs", import.meta.url), "utf8");
const loadstateSource = readFileSync(new URL("../lib/loadstate.mjs", import.meta.url), "utf8");
const uninstallProbeSource = readFileSync(new URL("../dev/probe-uninstall.mjs", import.meta.url), "utf8");
const probeLoadSource = readFileSync(new URL("../dev/probe-loadstate.mjs", import.meta.url), "utf8");
const readmeZh = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const readmeEn = readFileSync(new URL("../README.en.md", import.meta.url), "utf8");

/* ① 判据只有一份：扫描、四态、分类全部复用 lib */
ok("处置清单复用 `scanInstalledPackages`（不自己再扫一遍 node_modules）", uninstallSource.includes("scanInstalledPackages") && !/from "node:fs\/promises"/.test(uninstallSource) && !uninstallSource.includes("readdir("));
ok("同一个包的多份副本取**依赖并集**（并集写在 lib/loadstate.mjs 里，一处定义）", loadstateSource.includes("mergeDeps") && loadstateSource.includes("并集") && catalogSource.includes("mergeDep("));
ok("catalog 的加载态先按目录名、再按包名查（别名目录不再被误报成「不会被加载」）", catalogSource.includes("loadPaths.byName.get(pack.pkg) || loadPaths.byName.get(pack.packageName"));
ok("目录快照版本抬到 v10（判据改了，旧快照必须作废）", catalogSource.includes("export const CATALOG_VERSION = 10;"));

/* ② 只生成、不执行：源码里不许出现任何删除调用 */
ok(
	"处置清单里**没有任何删除调用**（只有给人复制的命令文本）",
	!/(rmSync|rmdirSync|unlinkSync|unlink\(|rmdir\(|await rm\(|\.rm\()/.test(uninstallSource) && uninstallSource.includes("本清单**不会执行任何删除**"),
);
ok("六种处置分类冻结成一张表（界面与清单读同一份，不许各写一句）", Object.isFrozen(PROVENANCE) && Object.keys(PROVENANCE).length === 6);
ok("链接的「可回收」恒为 0（删 junction 不省空间）", uninstallSource.includes("item.reclaimBytes = 0;") && uninstallProbeSource.includes("删链接不省空间"));
ok("别名 / 同项目第二份不把包名列为可摘键（摘错会删掉正在加载的那份）", uninstallSource.includes('item.provenance === "duplicate" || item.provenance === "alias-only"') && uninstallSource.includes("keepKeys"));

/* ③ 构造样本跑一遍分组与分类（不碰真机 profile） */
const planNm = join(tmpRoot, "plan-nm");
const writePkg = (dirName, name, deps = []) => {
	const dir = join(planNm, dirName);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", ...(deps.length > 0 ? { dependencies: Object.fromEntries(deps.map((dep) => [dep, "^1.0.0"])) } : {}) }), "utf8");
};
writePkg("alpha", "alpha");
writePkg("omega", "omega");
writePkg("beta", "beta", ["gamma"]);
writePkg("gamma", "gamma");
writePkg("delta", "delta", ["gamma"]);
writePkg("solo", "solo");
writePkg("aliasdir", "omega");
const fixturePlan = await buildUninstallPlan({
	nodeModules: planNm,
	profileDeps: { beta: "^1.0.0", omega: "link:D:/x" },
	bundles: ["alpha", "omega"],
	compositions: [],
	workspace: "D:/ws",
	/* solo 量不到体积：必须留 null + 原因，不许填 0 */
	sizeOf: async (dir) => (String(dir).includes("solo") ? { bytes: null } : { bytes: 1000, files: 1, truncated: false }),
});
const fixtureGroups = fixturePlan.groups;
eq("dormant 目录按弱连通分量分组（beta/gamma/delta 一组、solo 一组、别名目录一组）", fixtureGroups.length, 3);
const connected = fixtureGroups.find((group) => group.members.some((member) => member.dirName === "beta"));
eq("连边跨两跳：beta 声明 gamma、delta 也声明 gamma → 三个在同一组", connected.members.map((member) => member.dirName).sort(), ["beta", "delta", "gamma"]);
eq("组名取出度最高的成员（beta 与 delta 都是 1，按名字定序取 beta）", connected.name, "beta");
eq("被 profile 依赖钉住的实体目录 → pinned，并给出可摘的键（只给钉住的那个键）", [connected.kinds.includes("pinned"), connected.members.find((member) => member.dirName === "beta").profileKeys], [true, ["beta"]]);
eq("钉住的组第一个步骤就是「先摘 profile 依赖」", connected.steps[0].kind, "edit-profile");
ok("删目录步骤带可复制命令，且实体目录用 -Recurse", connected.steps.some((step) => step.kind === "delete" && step.commands.every((command) => command.command.includes("-Recurse -Force"))));
const aliasGroup = fixtureGroups.find((group) => group.members.some((member) => member.dirName === "aliasdir"));
eq("目录名与包名不同、且同项目另一份会被加载 → duplicate", aliasGroup.members[0].provenance, "duplicate");
eq("别名目录不把包名（omega）列为可摘键，而是列进「别动这些键」", [aliasGroup.members[0].profileKeys, (aliasGroup.members[0].keepKeys || []).map((entry) => entry.key)], [[], ["omega"]]);
const soloMember = fixtureGroups.flatMap((group) => group.members).find((member) => member.dirName === "solo");
ok("量不到的体积是 null + 原因（不许 0 糊过去）", soloMember.bytes === null && soloMember.sizeWhy !== "");
ok("汇总视图去掉每组命令文本（面板 20 秒轮询不该拖着一堆命令）", summarizeUninstallPlan(fixturePlan).groups.every((group) => group.steps === undefined) && summarizeUninstallPlan(fixturePlan).groups.length === 3);
const fixtureMd = renderUninstallPlan(fixturePlan);
ok("清单 Markdown 有结论、分类表、别动键与边界四块", fixtureMd.includes("## 一句话") && fixtureMd.includes("## 为什么分类") && fixtureMd.includes("别动这些键") && fixtureMd.includes("## 边界"));
ok("清单里写明「不会执行任何删除」+ 复核命令", fixtureMd.includes("不执行任何删除") && fixtureMd.includes("node dev/probe-uninstall.mjs"));

/* ④ 服务端：单独存结论（job 只有一格）、写盘要 confirm、state/health 各带一份 */
ok("service 有 runUninstall，并把结论存进 lastUninstall（不靠 job 那一格）", serviceSource.includes("async runUninstall({ onProgress } = {})") && serviceSource.includes("this.lastUninstall = plan;"));
ok("写盘要 confirm:true（闸在服务端）", serviceSource.includes("async writeUninstallReport({ confirm } = {})") && serviceSource.includes('if (confirm !== true) return { ok: false, error: "写盘必须带 confirm:true'));
ok("state 与 health 都带 uninstall 摘要（面板读 state、catalog_health 读 health）", serviceSource.includes("uninstall: this.uninstallSummary()") && serviceSource.includes("uninstall: this.lastUninstall"));
ok("体积走注入的 sizeOf（service 里 dirSize 调用点还是三处，懒算闸门没被打开）", serviceSource.includes("sizeOf: (dir) => dirSize(dir)") && (serviceSource.match(/await dirSize\(/g) || []).length === 3);
ok("路由 POST /uninstall：plan 起后台任务、apply+confirm 才写盘", indexSource.includes('if (path === "/uninstall" && method === "POST")') && indexSource.includes("catalog.writeUninstallReport({ confirm: body.confirm === true })"));
ok("工具 catalog_uninstall 存在且声明了 output（0.2.1 起漏了会整插件失活）", toolsSource.includes('name: "catalog_uninstall"') && toolsSource.includes("action: { type: \"string\", enum: [\"plan\", \"write\", \"simulate\", \"verify\"]"));
ok("工具没有在 description 里许诺「帮你删」（只生成清单）", toolsSource.includes("只生成、绝不执行删除") && !toolsSource.includes("catalog_uninstall 会删除"));

/* ⑤ 探针：I7 在 loadstate 探针、I8–I11 在 uninstall 探针 */
ok("probe-loadstate 用同一个扫描器，且带 I7（dormant 对加载中的声明封闭）", probeLoadSource.includes("scanInstalledPackages") && probeLoadSource.includes("I7 会被加载的包声明了 dormant 包"));
ok("probe-uninstall 四条不变式齐全，破一条就非零退出", ["I8", "I9", "I10", "I11"].every((id) => uninstallProbeSource.includes(id)) && uninstallProbeSource.includes("process.exit(1)") && uninstallProbeSource.includes("failures.push"));
ok("探针不硬编码本机路径（换机器也能跑）", !/D:[\\/]信息库/.test(uninstallProbeSource) && !/C:[\\/]Users/.test(uninstallProbeSource));

/* ⑥ 客户端：工具条入口 + 卡 + 二次确认 + 别名提示 */
ok("工具条有「处置清单」入口（不会被加载旁边），只生成不执行", clientSource.includes('"处置清单"') && clientSource.includes("只生成、永不执行删除"));
ok("处置清单卡 + 写入二次确认（第一下只是把按钮变成确认）", clientSource.includes("function UninstallCard(props)") && clientSource.includes("确认写入（不会删任何目录）"));
ok("详情页点明别名目录（同项目两份安装，不再让人以为它在跑 / 没跑）", clientSource.includes("别名目录：这个目录里装的是"));

/* ⑦ R16：删除预演 —— 只算不删，回答"真删了会不会有东西指空" */
const simProbeSource = readFileSync(new URL("./probe-simulate.mjs", import.meta.url), "utf8");
ok("预演是纯函数：图进结论出，函数体不碰磁盘", (() => {
	const at = uninstallSource.indexOf("export function simulateRemoval(input)");
	return at >= 0 && !/(readFile|writeFile|readdir|mkdirSync|createWriteStream)/.test(uninstallSource.slice(at));
})());
ok("预演保留「摘边不能点亮谁」的恒等（revived），探针拿它当不变式", uninstallSource.includes("revived") && simProbeSource.includes("S8"));
ok("「入口指空」直接对着 bundles 与组合条目查（不能从 after.roots 里挑：删掉的包恰好不在里面）", uninstallSource.includes("const bundleSet = new Set(bundles)") && uninstallSource.includes("item.name === name && !item.disabled"));
ok("服务端预演每次重扫依赖图（不吃上次清单缓存）", serviceSource.includes("async simulateUninstall({ packages } = {})") && serviceSource.includes("scanInstalledPackages(profileNodeModules())"));
ok("路由 /uninstall 的 simulate 分支只读（不经过 apply / confirm）", indexSource.includes('body.action === "simulate"') && indexSource.includes("catalog.simulateUninstall("));
ok("工具 simulate 可点名 packages；没有名单时给下一步而不是空结果", toolsSource.includes('packages: { type: "array"') && serviceSource.includes("还没有可预演的名单"));
ok("面板：SimBlock 摊开三类风险 + 加载态前后对比", clientSource.includes("function SimBlock(props)") && clientSource.includes("删完会指空的入口") && clientSource.includes("仍声明它们的包"));
ok("面板：预演按钮不含「删除」字样（卡里唯一的写动作仍是两次点击的写入）", clientSource.includes("预演（不动盘）") && !/预演删除/.test(clientSource));
ok("probe-simulate 覆盖 S1–S14 且破一条就非零退出", ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "S11", "S12", "S13", "S14"].every((id) => simProbeSource.includes(id + " ")) && simProbeSource.includes("process.exit(1)"));
ok("预演按**目录**算摘除（同名两份只删一份不算删掉那个包）", uninstallSource.includes("dirsByPkg") && uninstallSource.includes("removedDirs") && simProbeSource.includes("S13"));

/* ⑦b R27：执行并复核（对账）—— 拿计划与今天的磁盘事实比，只算不写盘 */
const verifyProbeSource = readFileSync(new URL("./probe-verify.mjs", import.meta.url), "utf8");
/* R31：探针清单搬到 dev/probe-list.mjs（audit 要数它、run-probes 要跑它 —— 单一来源） */
const probeListSource = readFileSync(new URL("./probe-list.mjs", import.meta.url), "utf8");
const runProbesSource = readFileSync(new URL("./run-probes.mjs", import.meta.url), "utf8");
ok("对账是纯函数：计划进结论出，函数体不碰磁盘（目录在不在由调用方注入 presence）", (() => {
	const at = uninstallSource.indexOf("export function verifyUninstallPlan(plan, input = {})");
	return at >= 0 && !/(readFile|writeFile|readdir|mkdirSync|createWriteStream|existsSync|statSync)/.test(uninstallSource.slice(at));
})());
ok("「白删」的三条来源都在：bundles / 未关掉的配置条目 / profile 依赖键", uninstallSource.includes("const bundleSet = new Set(bundles)") && uninstallSource.includes("item && !item.disabled") && uninstallSource.includes("profileKeySet.has(member.pkg)"));
ok("组内互相声明不算失守（计划按弱连通分量分组，整组一起走）", uninstallSource.includes("const memberNames = new Set()") && uninstallSource.includes("!memberNames.has(from)") && verifyProbeSource.includes("V9"));
ok("presence 缺失时保守判「还在」（不凭缺项宣布目录消失）", uninstallSource.includes("typeof input?.presence === \"function\" ? input.presence : () => true") && verifyProbeSource.includes("V11"));
ok("服务端对账每次重扫依赖图 + 逐个 stat 计划成员（不吃缓存）", serviceSource.includes("async verifyUninstall({ planPath } = {})") && serviceSource.includes("scanInstalledPackages(nodeModules)") && serviceSource.includes("existsSync(join(nodeModules, dirName))"));
ok("planPath 只许 reports/ 下的一份（不许把数据目录外的 JSON 读进报告）", serviceSource.includes("planPath 只能是 reports/ 下的一份计划") && serviceSource.includes("resolve(reports, wanted)"));
ok("对账结论**不进** /state（一份过期的「已删干净」会替人背书下一次动手）", !serviceSource.includes("this.lastVerify") && clientSource.includes("verify: null"));
ok("路由：verify 分支默认只读，confirm:true 才落报告", indexSource.includes('body.action === "verify"') && indexSource.includes("catalog.verifyUninstall({ planPath })") && indexSource.includes("catalog.writeVerifyReport({ confirm: true, planPath })"));
ok("工具 verify 可点名 planPath，且写明「只算不写盘」与落报告条件", toolsSource.includes('planPath: { type: "string"') && toolsSource.includes("action=verify") && toolsSource.includes("reports/uninstall-verify-*.md"));

/* ── R28-a：CSV 导出 ── */
const csvSource = readFileSync(new URL("../lib/csv.mjs", import.meta.url), "utf8");
ok("lib/csv.mjs 是纯函数层：列定义 / 单元格转义 / 序列化三样都在这里", csvSource.includes("export const ENTRY_COLUMNS") && csvSource.includes("export function csvCell") && csvSource.includes("export function renderCsv"));
ok("CSV 转义覆盖 RFC 4180 三条（逗号 / 双引号双写 / 换行），并默认带 BOM", csvSource.includes('/[",\\r\\n]/') && csvSource.includes(`replace(/"/g, '""')`) && csvSource.includes('"\\uFEFF"'), "");
ok("CSV 不 import 任何 service / fs（纯函数才测得住）", !/from "\.\/service\.mjs"|node:fs/.test(csvSource));
ok(
	"导出的事实只有一份实现：loadTextOf / depTextOf 各定义一次，Markdown 分支不再自带「不会被加载」字面量",
	(serviceSource.match(/export function loadTextOf/g) || []).length === 1 && (serviceSource.match(/export function depTextOf/g) || []).length === 1 && !serviceSource.includes('"**不会被加载**"') && serviceSource.includes("const text = loadTextOf(item);"),
);
ok(
	"CSV 与 Markdown 走同一批 picked：同一循环既 push 表格行也 push csvRows，最后只换序列化器",
	serviceSource.includes("csvRows.push(entryCsvRow(item, { sizeOf }))") && serviceSource.includes('format === "csv" ? renderCsv(csvRows, ENTRY_COLUMNS) : markdown'),
);
ok("catalog_export 支持 format=md|csv，且提示写明 CSV 的行数与 BOM", toolsSource.includes('format: { type: "string", enum: ["md", "csv"]') && toolsSource.includes("已导出 CSV"));
ok("index.js 的 /export 透传 format（面板与工具同一条链路，不是两套）", routeSource.includes('format: String(body.format || "md")'));

/* ── R28-b：还原到「更早的那一份」 ── */
ok("lib/staging.mjs 导出 pickBackupByName，且按**全名**精确比对（同一秒的两份不会随机挑）", stagingSource.includes("export function pickBackupByName") && stagingSource.includes("item.name === wanted || item.name === withPrefix"));
ok("catalog_skill_sync 有 backup 参数，并写明「省略 = 最近一份」", toolsSource.includes('backup: { type: "string"') && toolsSource.includes("省略 = 最近一份"));
ok("还原计划回传可选备份清单（backups / backupCount），点名不存在时给出可选项而不是静默", serviceSource.includes("backupCount: backups.count") && serviceSource.includes("没有这份备份"));
ok("写盘那一步带着**同一份**备份（否则会按「最近一份」重新解析，看起来还完全成功）", clientSource.includes("const backup = plan.backup ||") && routeSource.includes('const backup = body.backup ? String(body.backup) : "";'));
ok("面板还原确认里可以点「更早的备份」（onPick → 重新出计划），不是只能还原最近一份", clientSource.includes("onPick: (backup) => planStageRestore(item.id, backup)") && clientSource.includes("更早的备份"));
ok("CSV 两个入口都挂了按钮（当前这一屏 / 选中批次），且结果条会说清格式", clientSource.includes("onClick: exportFilteredCsv") && clientSource.includes("onClick: exportPickedCsv") && clientSource.includes('state.exportFormat === "csv"'));

/* ── R29：换会话前的最后一条命令（dev/deliver.mjs）── */
const deliverSource = readFileSync(new URL("../dev/deliver.mjs", import.meta.url), "utf8");
ok("dev/deliver.mjs 存在：把「换会话前做什么」固化成一条命令，而不是只写在交接文件里", deliverSource.includes("换会话 / 交付前的最后一条命令") && deliverSource.includes("dev/ship.mjs") && deliverSource.includes("dev/live-check.mjs"));
ok(
	"deliver 只**消费**判据、不自己重算（两处各写一份清单迟早差一次）",
	deliverSource.includes("parseShipJson") && deliverSource.includes('["--json"]') && deliverSource.includes("passed (\\d+) \\/ failed (\\d+)") && !deliverSource.includes("audit.mjs") && !deliverSource.includes("render-check"),
);
ok(
	"deliver 不执行任何写盘动作：不 spawn git、不调 staging 写接口，只把命令打出来",
	!/execFile\([^)]*"git"/.test(deliverSource) && !deliverSource.includes("copySkillToStaging") && !deliverSource.includes("restoreSkillBackup") && deliverSource.includes("不提交、不推送、不同步") && deliverSource.includes("host_selfcheck script=dev/git-commit.mjs"),
);
ok("deliver 的结论判据只有三条（ship 全绿 / 运行中一致 / 没有悬空项），且 --skip-ship 不算失败", deliverSource.includes("const ready = shipOk && Boolean(live) && (live.skipped || live.ok) && nextSteps.length === 0") && deliverSource.includes("const shipOk = ship ? Boolean(ship.ok) : true;"));
ok("deliver 把「沙箱 spawn 被拒」与「断言红了」分开报（否则人会以为插件坏了）", deliverSource.includes("spawnDenied") && deliverSource.includes("要在宿主里跑"));
ok("对账的措辞只在 uninstall.mjs 一处定义（面板/工具/报告共用）", uninstallSource.includes("export const VERIFY_REASON") && uninstallSource.includes("export const VERIFY_VERDICT") && toolsSource.includes("import { VERIFY_REASON, VERIFY_VERDICT }"));
ok("报告渲染把「白删 / 计划过期 / 逐成员 / 边界」四节都写出来", uninstallSource.includes("export function renderVerifyReport") && uninstallSource.includes("删了等于白删（最要紧）") && uninstallSource.includes("## 逐成员"));
ok("面板：VerifyBlock 结论与原因同时出现，且按钮不含「删除」字样", clientSource.includes("function VerifyBlock(props)") && clientSource.includes("对账（不动盘）") && clientSource.includes("白删（会被装回来 / 入口指空）：") && clientSource.includes("对账不改任何东西"));
ok("probe-verify 覆盖 V1–V15 且破一条就非零退出", ["V1", "V2", "V3", "V4", "V5", "V6", "V7", "V8", "V9", "V10", "V11", "V12", "V13", "V14", "V15"].every((id) => verifyProbeSource.includes(id + " ")) && verifyProbeSource.includes("process.exit(1)"));
ok("对账探针进了发版体检（probe-list 注册了 probe-verify）", probeListSource.includes('id: "verify"') && probeListSource.includes("dev/probe-verify.mjs") && runProbesSource.includes('from "./probe-list.mjs"'));

/* ⑧ R17：变化追踪（自上次快照以来变了什么） */
const historySource = readFileSync(new URL("../lib/history.mjs", import.meta.url), "utf8");
const historyProbeSource = readFileSync(new URL("./probe-history.mjs", import.meta.url), "utf8");
ok("history.mjs 是纯函数模块（不 import 任何 fs —— 落盘只在 service）", !/from "node:fs/.test(historySource) && /export function snapshotOf/.test(historySource) && /export function diffSnapshots/.test(historySource));
ok("指纹是 12 位（sha1 前 12 位），且与时间无关", historySource.includes("sha1") && historySource.includes("slice(0, 12)") && historyProbeSource.includes("H2"));
ok("指纹没变就不追加快照（否则基线被刷新，「自 X 以来」永远只剩几分钟）", serviceSource.includes("last.fingerprint === snapshot.fingerprint") && serviceSource.includes("return { recorded: false, changes: this.changes }"));
ok("启动路径也记一条（init 里，而不是只在重建时）", /if \(this\.catalog\) await this\.recordSnapshot\(\)\.catch\(\(\) => \{\}\);/.test(serviceSource));
ok("快照只留最近 20 条", historySource.includes("MAX_SNAPSHOTS = 20") && historySource.includes("export function pruneSnapshots"));
ok("变化摘要进 /state、health 与导出报告（三处同一份，不各算一遍）", serviceSource.includes("changes: this.changesSummary()") && serviceSource.includes("changes: this.changes") && serviceSource.includes('lines.push("## 变化"'));
ok("health 文案在「第一条快照」时如实说没有可比历史", toolsSource.includes("还没有可比的历史") && toolsSource.includes("变化：自 "));
ok("面板变化条：first / 0 处都不占版面，点开才列明细", clientSource.includes("function ChangesBar(props)") && clientSource.includes("if (!changes || changes.first) return null;") && clientSource.includes("dpc-changes-chip"));
ok("probe-history 覆盖 H1–H32 且破一条就非零退出", ["H1", "H2", "H3", "H4", "H5", "H6", "H7", "H8", "H9", "H10", "H11", "H12", "H13", "H14", "H15", "H16", "H17", "H18", "H19", "H20", "H21", "H22", "H23", "H24", "H25", "H26", "H27", "H28", "H29", "H30", "H31", "H32"].every((id) => historyProbeSource.includes(id + " ")) && historyProbeSource.includes("process.exit(1)"));
ok("摘要把「第一条快照」压成 0 处变化（不是 N 条新增），且这段逻辑在纯函数模块里", historySource.includes("export function summarizeChanges") && historySource.includes("if (!prev)") && serviceSource.includes("summarizeChanges"));

/* ⑧ R19：变化追踪收口 —— Skill 正文哈希 + 「已看过」确认窗口 */
ok("catalog 在读 SKILL.md 时顺手算正文哈希（不额外读文件），并抬了 CATALOG_VERSION", catalogSource.includes('createHash("sha1")') && catalogSource.includes("contentHash") && /export const CATALOG_VERSION = 10;/.test(catalogSource));
ok("history 信号含 content（仅 Skill），v3 加了升级迁移规则（旧快照没哈希 / 没配置层签名都不算变化）", historySource.includes('content: entry?.kind === "skill"') && /export const HISTORY_VERSION = 3;/.test(historySource) && historySource.includes("export function compareEntries") && historySource.includes('String(left.content ?? "") !== ""'));
ok("compareEntries 是 diff 与 sameSignal 的唯一判据（两处各写一份判据迟早会差）", historySource.includes("return !compareEntries(a, b).any;") && /const \{ changed, any \} = compareEntries\(old, entry\)/.test(historySource));
ok("正文改动单列成 edited（reason=content），且与描述改动互斥（只报一行）", historySource.includes('reason: "content"') && historySource.includes("else if (changed.description)") && historySource.includes("正文已改"));
ok("「已看过」基线单独存 history-ack.json（不改写 history.json），写回走原子写", serviceSource.includes('return join(this.dir, "history-ack.json")') && serviceSource.includes("await writeJson(this.ackFile(), ack)"));
ok("normalizeAck 在纯函数模块里（service 只负责读写文件，判据不分散）", historySource.includes("export function normalizeAck(") && !serviceSource.includes("export function normalizeAck"));
ok("基线冻结整份快照（不是时间戳），读回用 normalizeAck 兜坏文件 / 空目录", historySource.includes("export function normalizeAck") && serviceSource.includes("normalizeAck(raw)") && serviceSource.includes("ackSnapshotAt"));
ok("/ack 路由必须 confirm:true 才写盘（按钮可误点，接口不该给「少传一个字段」的机会）", /if \(path === "\/ack" && method === "POST"\)/.test(indexSource) && indexSource.includes("body.confirm !== true") && indexSource.includes("catalog.markAcked()"));
ok("/state 同时给两个窗口：changes（上次快照）与 sinceAck（上次确认），不互相冒充", serviceSource.includes("sinceAck: await this.sinceAckSummary()") && serviceSource.includes("changes: this.changesSummary()"));
ok("health 报出正文哈希覆盖率与确认时间（0/N、「没标记过」都要说得出来）", serviceSource.includes("skillHashes:") && serviceSource.includes("ack: ack") && toolsSource.includes("正文指纹：Skill") && toolsSource.includes("变化确认："));
ok("导出报告区分「自上次快照」与「自上次确认」，并删掉「正文改动看不见」的旧口径", serviceSource.includes("自上次确认（") && !serviceSource.includes("**Skill 正文改动看不见**"));
ok("面板：确认过的窗口优先（sinceAck），带「标记已看过」按钮，正文改动写成「正文已改」", clientSource.includes("props.sinceAck") && clientSource.includes("标记已看过") && clientSource.includes('api("/ack"') && clientSource.includes("正文已改"));
ok("hosttest 覆盖确认闭环：无 confirm 被拒 / 写基线 / 清零 / health 报得出", hosttestSource.includes('callRoute("/ack"') && hosttestSource.includes("history-ack.json") && hosttestSource.includes("sinceAck") && hosttestSource.includes("skillHashes"));

/* ⑧ R20：副本判据升级为正文哈希 + staging 备份可还原 */
const stagingProbeSource = readFileSync(new URL("./probe-staging.mjs", import.meta.url), "utf8");
ok("副本判据按正文哈希（sha1 前 12 位；SKILL.md 本来就要读，不额外开文件）", stagingSource.includes("export function hashSkillText") && stagingSource.includes('createHash("sha1")') && stagingSource.includes('digest("hex").slice(0, 12)') && stagingSource.includes('hash = hashSkillText(await readFile(file, "utf8"))'));
ok("哈希优先：内容相同直接 same（mtime 差异不再制造 newer-* 噪音）", /if \(loadedHash && stagedHash && loadedHash === stagedHash\) return \{ verdict: "same"/.test(stagingSource));
ok("同字数不同正文 + 时间差 ≤ 60 秒 → differs（R20 修掉的漏判）", /if \(Math\.abs\(delta\) <= SKILL_MTIME_TOLERANCE_MS\) return \{ verdict: "differs"/.test(stagingSource));
ok("读不到哈希时退回 size + mtime（宁可漏判也不误报）", stagingSource.includes("至少一边没有哈希") && /if \(Math\.abs\(delta\) <= SKILL_MTIME_TOLERANCE_MS\) return \{ verdict: "same"/.test(stagingSource));
ok("备份名格式唯一，还原拒绝路径穿越", stagingSource.includes("export const BACKUP_FILE_RE") && stagingSource.includes("basename(backup) !== backup") && stagingSource.includes("不允许路径"));
ok("还原只写 stagedDir（不碰 DSH 加载的那份），覆盖前先备份当前那份", stagingSource.includes("export async function restoreSkillBackup") && stagingSource.includes("const target = join(stagedDir, SKILL_FILE)") && stagingSource.includes("preRestore = await uniqueBackupTarget(stagedDir, stamp)") && !/export async function restoreSkillBackup[\s\S]{0,2400}?loadedDir/.test(stagingSource));
ok("备份与当前内容一致 → skipped（不制造无意义备份）", /if \(currentText !== null && hashSkillText\(currentText\) === hashSkillText\(backupText\)\) \{\s*return \{ ok: true, skipped: true/.test(stagingSource));
ok("staging 扫描把备份份数与哈希一并带给面板（drift 数据源）", serviceSource.includes("loadedHash: loadedStat ? loadedStat.hash : null") && serviceSource.includes("backups: { count: backups.count, latest:") && serviceSource.includes("await listSkillBackups(staged)"));
ok("还原计划只列与当前内容不同的备份，方向写清楚", serviceSource.includes("async restoreStagedSkillPlan(") && serviceSource.includes('direction: "backup → staging"') && serviceSource.includes("与 staging 当前内容一致"));
ok("还原写盘同样要 confirm:true（服务端拒，不靠按钮自觉）", /async restoreStagedSkills[\s\S]{0,900}options\.confirm !== true/.test(serviceSource) && serviceSource.includes("还原必须带 confirm:true"));
ok("/skillsync 支持 action=restore（不传 action 仍是同步，向后兼容）", indexSource.includes('String(body.action || "sync") === "restore"') && indexSource.includes("catalog.restoreStagedSkillPlan") && indexSource.includes("catalog.restoreStagedSkills"));
ok("工具 action 枚举含 restore，计划文案可读", /enum: \["plan", "apply", "restore"\]/.test(toolsSource) && toolsSource.includes("还原计划：") && toolsSource.includes("backup → staging"));
ok("面板：历史备份行 + 还原入口 + 二次确认条（两份一致时也能撤销）", clientSource.includes('"历史备份 " + drift.backups.count') && clientSource.includes('"还原到 " + latestBackup.stamp') && clientSource.includes("function RestoreConfirm") && clientSource.includes("确认还原（"));
ok("同步完成后的提示指向还原入口（写盘动作自带撤销说明）", clientSource.includes("要撤销就到条目浮窗点"));
ok("probe-staging 覆盖 P1–P16 且破一条非零退出", ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10", "P11", "P12", "P13", "P14", "P15", "P16"].every((id) => stagingProbeSource.includes(id + " ")) && stagingProbeSource.includes("process.exit(1)"));
ok("hosttest 覆盖还原：计划方向 / 无 confirm 被拒 / 真还原 + skipped / 备份列表", hosttestSource.includes('action: "restore"') && hosttestSource.includes("restoreSkillBackup") && hosttestSource.includes("listSkillBackups"));

/* ⑧ R21：更早窗口的时间线（history.json 里一直存着，此前只有最近一个窗口能看见） */
ok("history 导出 timelineOf：相邻快照相减、新的在前、基线不产出行", historySource.includes("export function timelineOf") && historySource.includes("diffSnapshots(prev, next)") && historySource.includes("rows.reverse()") && historySource.includes('if (prev.fingerprint && next.fingerprint && prev.fingerprint === next.fingerprint) continue;'));
ok("时间线的名字只带 cap 条、counts 保留真实数字（省略号不能骗人）", historySource.includes('diff.edited.slice(0, cap)') && historySource.includes("const cap = Math.max(1, Number(options.cap) || 4)"));
ok("/state 带 timeline（total + items），导出报告也有「历史」一节", serviceSource.includes("async historyTimeline()") && serviceSource.includes("timeline: await this.historyTimeline()") && serviceSource.includes('lines.push("### 历史（最近 "') && serviceSource.includes("timeline.items.slice(0, 8)"));
ok("面板：历史折叠入口 + 每个窗口一行（被编辑标「正文已改」），空时间线不占版面", clientSource.includes("showHistory: false") && clientSource.includes("timeline: data && data.timeline") && clientSource.includes("onToggleHistory") && clientSource.includes('"历史（" + timeline.length') && clientSource.includes("timeline.length > 0"));
ok("hosttest 覆盖 /state.timeline（total / items / 每行 counts 与分类数组）", hosttestSource.includes("/state.timeline") && hosttestSource.includes("stateTimeline.items.length <="));
/* R21 交接收口：把「每轮收尾都临时写一遍」的真机核验固化成 dev/live-check.mjs */
const liveCheckSource = readFileSync(new URL("./live-check.mjs", import.meta.url), "utf8");
ok(
	"dev/live-check.mjs：只读核验（版本一致 / 时间线 / drift 备份 / 还原计划 / 写盘闸）",
	liveCheckSource.includes('"/health"') && liveCheckSource.includes('"/state"') && liveCheckSource.includes('action: "restore"') && liveCheckSource.includes("confirm") && liveCheckSource.includes("process.exit(1)"),
);
ok("live-check 绝不写盘（源码里不出现 confirm:true —— 只发被拒的那条请求）", !/confirm:\s*true/.test(liveCheckSource) && liveCheckSource.includes("apply: true"));
ok("health 带 timeline 摘要（total / windows），工具输出有「历史：」一行", serviceSource.includes("timeline: { total: timeline.total, windows: timeline.items.length }") && toolsSource.includes("历史：共 "));

/* ⑧ R18：把「跑哪几条命令才算验完」与「宿主里跑的是新代码吗」都固化 */
const probesRunner = readFileSync(new URL("./run-probes.mjs", import.meta.url), "utf8");
ok("探针收进发版体检（第 5 项 probes，不再是「有人记得就跑」）", shipChecksSource.includes('id: "probes"') && shipChecksSource.includes('script: "dev/run-probes.mjs"'));
ok("面板 dry 与 ship 同一份清单（此前硬编码四项，收进探针后 dry 仍只报四项）", indexSource.includes("checks: shipCheckIds()") && indexSource.includes('from "./dev/ship-checks.mjs"'));
ok(
	"探针清单覆盖全部十一个（loadstate / uninstall / simulate / verify / tags / history / staging / composition / handoff / csv / mcp）",
	["probe-loadstate", "probe-uninstall", "probe-simulate", "probe-verify", "probe-tags", "probe-history", "probe-staging", "probe-composition", "probe-handoff", "probe-csv", "probe-mcp"].every((name) => probeListSource.includes("dev/" + name + ".mjs")),
);
ok("探针清单只有一份来源（run-probes 不再自带数组）", runProbesSource.includes('from "./probe-list.mjs"') && !runProbesSource.includes("probe-loadstate.mjs"));
ok("探针串兼容两种收尾格式（passed/failed 行 与 「N 条不变式全部成立」）", probesRunner.includes("function parseCounts") && probesRunner.includes("function parseInvariants") && probesRunner.includes("parseCounts(text) ||"));
ok("沙箱里跑探针串会明说「要在宿主里跑」，不会被误判成探针坏了", probesRunner.includes("EPERM") && probesRunner.includes("host_selfcheck"));
ok("运行中版本被定格（LOADED_VERSION）并与磁盘比（isStaleBuild）", serviceSource.includes("const LOADED_VERSION = (() =>") && serviceSource.includes("function isStaleBuild(") && serviceSource.includes("loaded: { version: LOADED_VERSION"));
ok("health 与 /state 都带「磁盘 vs 运行中」，不一致时点名下一步", serviceSource.includes("stale: isStaleBuild(build, LOADED_VERSION)") && toolsSource.includes("重载插件或重启 DSH 之后新代码才生效"));
ok("面板也标「运行中 X（未重载）」—— build 标签读的是磁盘，不标出来会让人以为已生效", clientSource.includes("data.build && data.build.stale") && clientSource.includes("（未重载）"));

/* ⑨ R22：配置层（声明层）—— 两份组合文件的顶层条目从没进过界面，
    health 里的「配置挂载 0」其实是判据只看得见已装的包。这一轮锁九件事：
      ① 解析只有一份（composition.mjs），块标量 `name: >-` 必须读到内容；
      ② `disabled` 三语义分开（true / false|空 / `!!js` 条件），只有字面量 true 改加载判据；
      ③ 同 id 按 patch 语义合并（后者覆盖 name/disabled），没 name 的也能覆盖基线；
      ④ 条目五类（包 / 子路径 / 按路径 / 组 / 只按 id），包名去子路径；
      ⑤ 解析五档（present / asar / missing / unjudged / n/a），asar 读不到只能是 unjudged；
      ⑥ 严重度：只有 bundles 点名却找不到才算 bad，组合条目静态查不到只到 warn；
      ⑦ 三组计数各自守恒（kind / resolution / state 都等于生效条目数）；
      ⑧ 面板/工具/health/导出同一份数据（compact + summarize + render 三处都来自 audit）；
      ⑨ 探针 C1–C14 覆盖上面每一条。 */
const compositionSource = readFileSync(new URL("../lib/composition.mjs", import.meta.url), "utf8");
ok("composition 是纯函数层（不 import node:fs，只做文本与 URL）", !/from "node:(fs|fs\/promises)"/.test(compositionSource) && compositionSource.includes('from "node:url"'));
ok("解析只有一份实现：loadstate 转出 composition 的 parseComposition，自己不再定义", !/export function parseComposition/.test(loadstateSource) && loadstateSource.includes('export { parseComposition } from "./composition.mjs"'));
const blockEntries = parseComposition(["- id: a", '  name: >-', "    file:///D:/x/y.mjs", "- id: b", "  name: dsh-b"].join("\n"));
ok("块标量 name（>）读到内容而不是字面量（R22 修掉的真实解析 bug）", blockEntries[0].name === "file:///D:/x/y.mjs" && blockEntries[1].name === "dsh-b", JSON.stringify(blockEntries.map((entry) => entry.name)));
eq("三组白名单冻结（类型 / 解析 / 禁用语义）", [Object.isFrozen(COMPOSITION_KINDS), Object.isFrozen(ENTRY_RESOLUTIONS), Object.isFrozen(DISABLE_KINDS)], [true, true, true]);
ok("disabled 只有字面量 true 算关掉（条件表达式不改加载判据）", parseDisabled("true").kind === "off" && parseDisabled("false").kind === "on" && parseDisabled("").kind === "on" && parseDisabled("!!js 'x'").kind === "expression" && parseDisabled("0").kind === "expression");
const mergedFixture = mergeCompositionEntries([...parseComposition("- id: a\n  name: dsh-a\n  disabled: true", { file: "cordis.yml" }), ...parseComposition("- id: a\n  disabled: false", { file: "cordis.patch.yml" })]);
ok("同 id 按 patch 语义合并（后者覆盖 disabled，并记下来源与覆盖次数）", mergedFixture.length === 1 && mergedFixture[0].disabled === false && mergedFixture[0].patches === 1 && mergedFixture[0].file === "cordis.patch.yml", JSON.stringify(mergedFixture));
ok("条目五类分得开 + 包名去子路径（scope 与裸名都试）", COMPOSITION_KINDS.join(",") === "package,subpath,file,group,id-only" && packageNameOf("@s/p/sub") === "@s/p" && packageNameOf("pkg/sub") === "pkg" && classifyCompositionName("file:///D:/a.mjs").kind === "file" && classifyCompositionName("cordis:group").kind === "group");
const compBundlesBad = auditComposition({ files: [{ file: "cordis.yml", text: "- id: a\n  name: dsh-a" }], bundles: ["dsh-ghost"], installed: new Map([["dsh-a", []]]), asarNames: new Set(), at: 1 });
ok("严重度：bundles 里点名却找不到才算 bad", compBundlesBad.verdict === "bad" && compBundlesBad.bundlesMissing.length === 1, JSON.stringify({ verdict: compBundlesBad.verdict, missing: compBundlesBad.bundlesMissing.length }));
const compEntryMissing = auditComposition({ files: [{ file: "cordis.yml", text: "- id: a\n  name: dsh-a\n- id: b\n  name: dsh-ghost" }], bundles: [], installed: new Map([["dsh-a", []]]), asarNames: new Set(), at: 1 });
ok("组合条目静态查不到只到 warn（运行期注入的虚拟模块看不见，不许喊必坏）", compEntryMissing.verdict === "warn" && compEntryMissing.missing.length === 1 && compEntryMissing.missing[0].why.includes("运行期注入"), JSON.stringify({ verdict: compEntryMissing.verdict, why: compEntryMissing.missing[0] && compEntryMissing.missing[0].why }));
const compUnjudged = auditComposition({ files: [{ file: "cordis.yml", text: "- id: a\n  name: dsh-a" }], bundles: ["dsh-a"], installed: new Map(), asarNames: null, at: 1 });
ok("asar 读不到时包条目 unjudged，绝不当成「缺」", compUnjudged.entries[0].resolution === "unjudged" && compUnjudged.packages.missing === 0 && compUnjudged.packages.unjudged === 1 && compUnjudged.asarReadable === false);
const compCounts = auditComposition({ files: [{ file: "cordis.yml", text: "- id: a\n  name: dsh-a\n- id: b\n  name: cordis:group\n- id: c\n  disabled: true" }], bundles: [], installed: new Map([["dsh-a", []]]), asarNames: new Set(), at: 1 });
const compKindSum = Object.values(compCounts.counts.byKind).reduce((sum, n) => sum + n, 0);
const compResolutionSum = Object.values(compCounts.counts.byResolution).reduce((sum, n) => sum + n, 0);
const compStateSum = Object.values(compCounts.counts.byState).reduce((sum, n) => sum + n, 0);
ok("三组计数各自守恒（kind / resolution / state 都等于生效条目数）", compKindSum === compCounts.counts.effective && compResolutionSum === compCounts.counts.effective && compStateSum === compCounts.counts.effective, `${compKindSum}/${compResolutionSum}/${compStateSum} vs ${compCounts.counts.effective}`);
ok("摘要与紧凑视图同源（summary 说「静态查不到」；compact 不带全量 entries）", summarizeComposition(compEntryMissing).includes("静态查不到") && compactComposition(compEntryMissing, 5).entries === undefined && compactComposition(compEntryMissing, 5).counts.byResolution.missing === 1);
ok("service：compositionAudit 60 秒缓存 + /state.composition + health 摘要 + 导出「配置层」一节", serviceSource.includes("async compositionAudit(") && serviceSource.includes("< 60 * 1000") && serviceSource.includes("composition: compactComposition(await this.compositionAudit())") && serviceSource.includes("renderCompositionSection(await this.compositionAudit())"));
ok("配置层与安装形态同源：重建目录时缓存一起作废", serviceSource.includes("this.compositionReport = null") && /rebuildCatalog[\s\S]{0,700}this\.compositionReport = null/.test(serviceSource));
ok("工具面第 11 个 catalog_composition（view 五档；描述写明不求值/不展开 patch 层）", tools.some((tool) => tool.name === "catalog_composition") && /enum: \["overview", "entries", "missing", "disabled", "conditional"\]/.test(toolsSource) && toolsSource.includes("不展开 bundle 自带的 patch 层"));
ok("catalog_health 打出配置层一行（读 health.composition.line）", toolsSource.includes("health.composition ? health.composition.line") && toolsSource.includes("配置层：还没读"));
ok("面板：头部「配置层」入口 + 浮层 + 四类清单 + 缺口公告只在 bad 时占位", clientSource.includes("showComposition: false") && clientSource.includes("function CompositionModal") && clientSource.includes("dpc-conf-link") && clientSource.includes("compositionBad") && clientSource.includes("dpc-conf-block"));
ok("浮层脚注写明三条边界（不展开 patch 层 / 表达式不求值 / 静态查不到不等于坏）", clientSource.includes("不展开 bundle 自带的 patch 层") && clientSource.includes("表达式不求值") && clientSource.includes("运行期注入"));
ok("浮层脚注给出缓存年龄（算于 X + 60 秒缓存 + 改完点重新扫描）—— R22.1", clientSource.includes("算于 ") && clientSource.includes("60 秒缓存") && clientSource.includes("重新扫描"));
ok("health 摘要带 at（配置层陈旧与否要有时间戳可判）—— R22.1", serviceSource.includes("at: composition.at") && serviceSource.includes("/* 审计时间：面板浮层与 /health 都显示"));
ok("新类名都有样式定义", [".dpc-conf-link{", ".dpc-conf-block{", ".dpc-conf-row{"].every((needle) => cssSource.includes(needle)));
const compositionProbeSource = readFileSync(new URL("./probe-composition.mjs", import.meta.url), "utf8");
ok("probe-composition 覆盖 C1–C14 且破一条非零退出", ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9", "C10", "C11", "C12", "C13", "C14"].every((id) => compositionProbeSource.includes(id + " ")) && compositionProbeSource.includes("process.exit(1)"));
ok("hosttest 覆盖 /state.composition（形状 / 计数守恒 / 每类都带 file+line）", hosttestSource.includes("/state.composition"));

/* ⑨ R23：配置层变化进历史 —— 改 disabled / 加 bundle 时目录条目一个都没变，
   v2 只比条目信号，这类改动完全看不见。这一轮锁五件事：
     ① 签名只解析声明（不扫包、不读 asar），指纹取 id/name/disabledKind + bundles；
     ② 签名折进快照指纹 —— 否则 recordSnapshot 认为没变、根本不追加快照；
     ③ diff 单列 composition 一类，并占 1 处 total（否则变化条不显示）；
     ④ 单边缺签名不判（与 R19 正文哈希同一条迁移规则）；
     ⑤ 面板 / health / 导出三处都写人话。 */
const sigA = signatureOf({ files: [{ file: "cordis.yml", text: "- id: a\n  name: dsh-a" }], bundles: ["dsh-a"] });
const sigSame = signatureOf({ files: [{ file: "cordis.yml", text: "- id: a\n  name: dsh-a" }], bundles: ["dsh-a"] });
const sigOff = signatureOf({ files: [{ file: "cordis.yml", text: "- id: a\n  name: dsh-a\n  disabled: true" }], bundles: ["dsh-a"] });
const sigBundle = signatureOf({ files: [{ file: "cordis.yml", text: "- id: a\n  name: dsh-a" }], bundles: ["dsh-a", "dsh-b"] });
const sigReordered = signatureOf({ files: [{ file: "cordis.yml", text: "- id: b\n  name: dsh-b\n- id: a\n  name: dsh-a" }], bundles: ["dsh-b", "dsh-a"] });
const sigBundleReordered = signatureOf({ files: [{ file: "cordis.yml", text: "- id: a\n  name: dsh-a\n- id: b\n  name: dsh-b" }], bundles: ["dsh-a", "dsh-b"] });
ok("配置层签名只解析声明（composition.mjs 里 signatureOf 不扫包 / 不读 asar）", compositionSource.includes("export function signatureOf") && !/export function signatureOf[\s\S]{0,1600}?(scanInstalledPackages|asarNames)/.test(compositionSource));
ok("签名稳定：同一声明的条目顺序 / bundles 顺序都不影响指纹", sigA.fingerprint === sigSame.fingerprint && sigReordered.fingerprint === sigBundleReordered.fingerprint && sigA.counts.entries === 1 && sigA.counts.bundles === 1);
ok("disabled 翻转 / 加 bundle 都改指纹（声明变了就必须看得见）", sigA.fingerprint !== sigOff.fingerprint && sigA.fingerprint !== sigBundle.fingerprint && sigOff.counts.off === 1 && sigBundle.counts.bundles === 2);
const snapPlain = snapshotOf({ plugins: [], skills: [] }, null, 1);
const snapWith = snapshotOf({ plugins: [], skills: [] }, null, 1, sigA);
const snapOff = snapshotOf({ plugins: [], skills: [] }, null, 2, sigOff);
ok("配置层签名进快照并存 {fingerprint, counts}（指纹也折进快照指纹）", snapWith.composition && snapWith.composition.fingerprint === sigA.fingerprint && snapWith.fingerprint !== snapPlain.fingerprint && snapPlain.composition === undefined);
ok("diff 单列 composition 并占 1 处 total（目录条目 0 条时 total 仍是 1）", (() => {
	const diff = diffSnapshots(snapWith, snapOff);
	return diff.counts.composition === 1 && diff.counts.total === 1 && diff.unchanged === 0 && diff.added.length === 0 && diff.compositionChanged[0].changed.some((item) => item.field === "off" && item.from === 0 && item.to === 1);
})());
ok("单边缺配置层签名 → 不判变化（升级后第一次重建不能报警）", compareComposition(snapPlain, snapWith) === null && compareComposition(snapWith, snapPlain) === null && diffSnapshots(snapPlain, snapWith).counts.total === 0);
ok("配置层措辞走 describeChange（不出现 undefined / null）", !/undefined|null/.test(describeChange(diffSnapshots(snapWith, snapOff).compositionChanged[0], "composition")) && describeChange(diffSnapshots(snapWith, snapOff).compositionChanged[0], "composition").includes("关掉 0 → 1"));
ok("service：签名只读两份组合文件 + bundles（不调 compositionAudit），recordSnapshot / 基线都带上", serviceSource.includes("async compositionSignature()") && /compositionSignature[\s\S]{0,700}profileComposition\(\)/.test(serviceSource) && !/async compositionSignature\(\)[\s\S]{0,800}await this\.compositionAudit\(/.test(serviceSource) && serviceSource.includes("if (files.length === 0) return null") && /snapshotOf\(this\.catalog, this\.overrides, at, composition\)/.test(serviceSource) && serviceSource.includes("await this.compositionSignature()"));
ok("ack 基线也带配置层签名（否则「自上次确认以来」永远看不见配置层）", serviceSource.includes("async ackSnapshotAt(") && /async ackSnapshotAt\([\s\S]{0,260}compositionSignature\(\)/.test(serviceSource) && serviceSource.includes("await this.ackSnapshotAt("));
ok("normalizeAck 保留 composition（否则读回基线就丢了）", historySource.includes("compositionSignalOf(stored.composition)") && historySource.includes("baseline.composition = composition"));
ok("面板：配置层单列一组（chip + 明细 + 时间线一句），不是塞进被编辑", clientSource.includes('["composition", "配置层", changes.compositionChanged, compositionText]') && clientSource.includes("const compositionText = (item)") && clientSource.includes('bits.push("配置层 "'));
ok("health / 导出 / 面板脚注都写配置层（三处同一口径）", toolsSource.includes("配置层 ${health.changes.counts.composition || 0}") && serviceSource.includes('["配置层", changes.compositionChanged, "composition"]') && clientSource.includes("配置层比**声明签名**"));
ok("probe-history 覆盖 H28–H32（配置层指纹 / 上报 / 单边缺跳过）", ["H28", "H29", "H30", "H31", "H32"].every((id) => historyProbeSource.includes(id + " ")) && historyProbeSource.includes("signatureOf"));

/* ⑨ R24：配置层条目可点跳卡片 + 「在 bundles 里吗」交叉引用 */
const compactFn = compositionSource.indexOf("export function compactComposition");
const compactBody = compactFn >= 0 ? compositionSource.slice(compactFn, compactFn + 2200) : "";
ok("紧凑视图带 bundleNames（去重 + 排序，只给包名、不传 bundles 整行）", compactBody.includes("bundleNames:") && compactBody.includes("new Set(") && compactBody.includes(".sort()") && !compactBody.includes("rows: report.bundles.rows"));
ok("面板：只有 profile / asar 行可点，点后写搜索词 + 关浮层 + 清筛选（否则目标卡被筛掉）", clientSource.includes("function jumpToCard(name)") && /kind: "all", source: "any", usage: "any", orphanOnly: false, dormantOnly: false, tagFilter: \[\], showComposition: false/.test(clientSource) && clientSource.includes('item.resolution === "present" || item.resolution === "asar"') && clientSource.includes("onKeyDown"));
ok("「在 bundles / 不在 bundles」交叉引用 + 解析徽标 + 新类名有样式", clientSource.includes('inside ? "在 bundles" : "不在 bundles"') && clientSource.includes("RES_LABEL") && clientSource.includes('row(item, null, true)') && [".dpc-conf-row.is-link{", ".dpc-conf-flag.is-in{", ".dpc-conf-flag.is-out{", ".dpc-conf-res.is-asar{"].every((needle) => cssSource.includes(needle)));
ok("hosttest / live-check / probe 都锁了 bundleNames（R24）", hosttestSource.includes("bundleNames") && liveCheckSource.includes("bundleNames") && compositionProbeSource.includes("C15") && compositionProbeSource.includes("C16"));

/* ⑩ R25：配置层变化下钻到具体 id / bundle */
const sigFn = compositionSource.indexOf("export function signatureOf");
const compositionSignatureSource = sigFn >= 0 ? compositionSource.slice(sigFn, sigFn + 2200) : "";
const historySourceAll = readFileSync(new URL("../lib/history.mjs", import.meta.url), "utf8");
ok("签名带 decls / bundles（去重排序的 identity 表），且不把解析结果写进历史", compositionSignatureSource.includes("decls") && compositionSignatureSource.includes("bundles: bundles.slice().sort()") && !compositionSignatureSource.includes("resolution"));
ok("下钻：compareComposition 返回 stateChanged / bundlesAdded，且单边缺 decls 不伪造明细", historySourceAll.includes("export function compareCompositionDetail") && historySourceAll.includes("stateChanged.push") && historySourceAll.includes("bundlesAdded.push") && historySourceAll.includes("if (left && right)") && historySourceAll.includes("hasDetail"));
ok("面板 / 报告同一份明细：client compositionText 与 describeChange 都点名 id", clientSource.includes("item.stateChanged") && clientSource.includes("bundles +") && historySourceAll.includes("compositionDetailText(item)") && historySourceAll.includes("DISABLED_KIND_LABELS"));
ok("快照升级补一条带明细的（老快照没有 decls 时只补一次）", serviceSource.includes("const enrich = Boolean(last && snapshot.composition?.decls && !last.composition?.decls)") && serviceSource.includes("&& !enrich"));
ok("probe-history 覆盖 H33–H37（decls 排序 / 点名翻转 / 点名 bundle / 单边缺 / 截断）", ["H33", "H34", "H35", "H36", "H37"].every((id) => historyProbeSource.includes(id + " ")));

/* ⑪ R26：交接单（catalog_handoff） */
const handoffSource = readFileSync(new URL("../lib/handoff.mjs", import.meta.url), "utf8");
const handoffProbeSource = readFileSync(new URL("./probe-handoff.mjs", import.meta.url), "utf8");
ok("交接单是纯函数（buildHandoff / renderHandoff，九项核对 + verdict + 下一步）", handoffSource.includes("export function buildHandoff") && handoffSource.includes("export function renderHandoff") && handoffSource.includes("HANDOFF_VERSION") && handoffSource.includes("checks.length") === false && handoffSource.includes('"version"') && handoffSource.includes('"ship"'));
ok("service 汇总既有结论（ship 报告 / git / drift / history / 最新导出），不新扫目录", serviceSource.includes("async handoffReport(") && serviceSource.includes("const PLUGIN_ROOT") && serviceSource.includes("^ship-") && serviceSource.includes("divergenceVsUpstream") && serviceSource.includes("buildHandoff({"));
ok("工具 catalog_handoff 默认只读、write:true 才落 reports/；hosttest 锁十项", toolsSource.includes('name: "catalog_handoff"') && toolsSource.includes("handoffReport({ write: args.write === true })") && hosttestSource.includes("catalog_handoff 返回十项核对") && handoffProbeSource.includes("H1 ") && handoffProbeSource.includes("H8 "));

/* ⑦ 文档 */
ok("双语 README 都写了配置层与 dev/probe-composition.mjs", readmeZh.includes("catalog_composition") && readmeEn.includes("catalog_composition") && readmeZh.includes("dev/probe-composition.mjs") && readmeEn.includes("dev/probe-composition.mjs"));
ok("双语 README 都写了 R23 配置层签名 / R24 点回卡片 / R25 下钻（声明层变化、导航与明细）", readmeZh.includes("只改配置也要看得见（R23）") && readmeEn.includes("Declaration-only edits become visible (R23)") && readmeZh.includes("从配置层点回卡片（R24）") && readmeEn.includes("From the composition popup back to the card (R24)") && readmeZh.includes("配置层变化下钻到具体条目（R25）") && readmeEn.includes("Drill down to the exact declaration (R25)"));
ok("双语 README 都写了 catalog_uninstall 与 dev/probe-uninstall.mjs", readmeZh.includes("catalog_uninstall") && readmeEn.includes("catalog_uninstall") && readmeZh.includes("dev/probe-uninstall.mjs") && readmeEn.includes("dev/probe-uninstall.mjs"));
/* 版本号那一条在 R12/R13 段落里已经有一条（同一条断言不写两遍，否则红了两行说的是同一件事） */

/* ⑦c R31：**文档数字与真值对账** —— 这一轮踩到的漂移全都长一个样：
 *     加了第 13 个工具，文档还写 12；探针从 177 涨到 231，SKILL 还写 177；
 *     交接单从九项变十项，SKILL 还写"九项"；live-check 从 14 涨到 15，手册还写 14。
 *     共同点：**没人会去改文档里的数字**，所以让机器去数。
 *
 * ★ 口径只有一条：文档里承担"现状"的那句话必须能被解析成数字，
 *   然后与**此刻的代码**比 —— 比的是真值，不是"上一次 ship 的报告"（那会自我循环）。
 * ★ 历史段落里的小数字（R22 的 116 条之类）不参与对账，这里只认现状句。
 */
const docTruth = (() => {
	/* dev/../.. = DSH-Plugin；再上一级才是工作区（Skill 装在 <ws>/.dsh/skills） */
	const skillUrl = new URL("../../../.dsh/skills/dsh-plugin-catalog/SKILL.md", import.meta.url);
	const skillText = existsSync(skillUrl) ? readFileSync(skillUrl, "utf8") : "";
	const liveCheckSource = readFileSync(new URL("./live-check.mjs", import.meta.url), "utf8");
	const handoffUrl = new URL("../★交接文件·插件目录面板.md", import.meta.url);
	const handoffText = existsSync(handoffUrl) ? readFileSync(handoffUrl, "utf8") : "";
	/** 只数"真的会执行"的断言行（缩进的 ok( 才是判据，注释里的不算）。 */
	const liveChecks = (liveCheckSource.match(/^\s*ok\(/gm) || []).length;
	/* 交接单的项数不是常量，是从 buildHandoff 真跑出来的 —— 文档写的必须是这个数 */
	const handoffChecks = buildHandoff({}).checks.length;
	const docProbeFiles = new Set((skillText.match(/dev\/probe-[a-z]+\.mjs/g) || []).map((item) => item));
	return { skillText, liveCheckSource, handoffText, liveChecks, handoffChecks, docProbeFiles, skillPresent: Boolean(skillText) };
})();

if (!docTruth.skillPresent) {
	ok("SKILL.md 不在本机（跳过文档对账；这是插件仓库，Skill 副本属于工作区）", true);
} else {
	ok(`文档工具数 == 实际工具数（${tools.length}）：SKILL 写「13 个 catalog_* 工具」这类现状句`, docTruth.skillText.includes(`与 ${tools.length} 个 \`catalog_*\` 工具`));
	ok(`SKILL 探针数 == 清单真值（${PROBE_COUNT} 个）`, docTruth.skillText.includes(`合计 ${PROBE_COUNT} 个探针`));
	ok(`README 探针数 == 清单真值（${PROBE_COUNT} 个）`, readmeZh.includes(`**${PROBE_COUNT} 个独立探针**`) && readmeZh.includes(`**${PROBE_COUNT} 个探针串成一条**`));
	ok("SKILL 给每个在链探针都留了一行（链上有、手册没写 = 没人跑它）", PROBES.every((item) => docTruth.skillText.includes(item.file)));
	ok("探针清单每条 file 在磁盘上都存在（清单写错路径 = 发版体检静默少跑一条）", PROBES.every((item) => existsSync(new URL("../" + item.file, import.meta.url))));
	ok("旧一代探针也都还认得出来（登记过的路径必须存在，否则清单在骗人）", LEGACY_PROBES.every((item) => existsSync(new URL("../" + item.file, import.meta.url))));
	ok("dev/ 顶层没有「没挂链也没登记」的探针（新写的探针必须进 PROBES 或 LEGACY_PROBES）", (() => {
		const known = new Set([...PROBES, ...LEGACY_PROBES].map((item) => item.file.replace("dev/", "")));
		const onDisk = readdirSync(new URL(".", import.meta.url)).filter((name) => /^probe-.+\.mjs$/.test(name) && name !== "probe-list.mjs");
		return onDisk.every((name) => known.has(name));
	})());
	ok(`live-check 断言条数 == 文档写的条数（真值 ${docTruth.liveChecks}）`, docTruth.skillText.includes(`（≈0.7 秒，${docTruth.liveChecks} 条）`));
	ok(`交接单项数 == 文档写的（真值 ${docTruth.handoffChecks} 项）`, docTruth.skillText.includes(`${docTruth.handoffChecks} 项核对`));
	/* 三处都写「共 231 条」这类聚合数：以 README 为基准，其余两处必须同数 —— 只改一处是最常见的半更新 */
	const statedTotal = (/共\s*(\d+)\s*条/.exec(readmeZh) || [])[1];
	ok("README / SKILL / 交接文件 写的探针断言总数一致（半更新会被抓到）", Boolean(statedTotal) && docTruth.skillText.includes(`${statedTotal} 条`) && (!docTruth.handoffText || docTruth.handoffText.includes(`${statedTotal} 条`)));
	ok("README 工具表逐个点名了每个 catalog_* 工具（加工具不忘写文档）", tools.every((tool) => readmeZh.includes(tool.name)));
}

/* ⑦d R31：MCP **停用**片段 —— 加有模板、停没有，是个真实的缺口。
 *   四条边界：视图在、片段只出文本（不写盘）、按 id 覆盖（不带 name/config）、声明在 patch 里的另说。 */
const mcpTool = tools.find((tool) => tool.name === "catalog_mcp");
const mcpSource = readFileSync(new URL("../lib/mcp.mjs", import.meta.url), "utf8");
const mcpToolView = mcpTool?.parameters?.properties?.view?.enum || mcpTool?.inputSchema?.properties?.view?.enum || [];
ok("catalog_mcp 有 disable 视图（加有模板，停也得有出口）", Array.isArray(mcpToolView) && mcpToolView.includes("disable"), JSON.stringify(mcpToolView));
ok("停用片段是纯函数、挂在 mcp.mjs 上（不在工具里临时拼字符串）", /export function renderDisablePatch\(/.test(mcpSource) && /renderDisablePatch/.test(toolsSource));
ok("disable 分支**只出文本**：没有 writeFile / appendFile（本插件的写盘一律不由工具发起）", (() => {
	const at = toolsSource.indexOf('view === "disable"');
	if (at < 0) return false;
	const branch = toolsSource.slice(at, at + 1400);
	return !/writeFile|appendFile|mkdirSync|renameSync/.test(branch) && branch.includes("只出文本");
})());
ok("probe-mcp 钉了 M12（片段形状 / 幂等 / patch 内条目另说）", readFileSync(new URL("./probe-mcp.mjs", import.meta.url), "utf8").includes("M12"));

/* ⑦e R31：传输压缩不能悄悄退化 —— 代码在不在 + 量它的脚本在不在。
 *   数字本身不在这里断言（`/state` 会随条目数长大），但「压缩这条路还在」必须钉死：
 *   删掉 gzip 分支不会让任何测试变红，只会让每 20 秒的轮询重新变成 357 KB。 */
ok("/state 的按需 gzip 还在（content-encoding + 阈值 + vary 三样都写着）", indexSource.includes('"content-encoding": "gzip"') && indexSource.includes("raw.length >= 1024") && indexSource.includes('vary: "Accept-Encoding"') && /from "node:zlib"/.test(indexSource));
ok("量传输代价的脚本在（换会话以后不用重写 curl）", existsSync(new URL("./measure-state.mjs", import.meta.url)));

/* ─────────── 汇总 ─────────── */
rmSync(tmpRoot, { recursive: true, force: true });

console.log("");
console.log("dsh-plugin-catalog / audit");
console.log("  passed: " + passed);
console.log("  failed: " + failed);
if (failed > 0) {
	console.log("");
	for (const failure of failures) console.log("  ✗ " + failure);
	console.log("");
	process.exit(1);
}
console.log("  all good");
