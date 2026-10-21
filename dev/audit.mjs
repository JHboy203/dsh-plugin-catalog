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

import { mkdirSync, rmSync, writeFileSync, mkdtempSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";

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
const requiredNames = ["catalog_list", "catalog_stats", "catalog_tag", "catalog_classify", "catalog_review", "catalog_publish", "catalog_health"];
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
