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
import { LOAD_STATES, parseComposition, resolveLoadPaths, isLoadedState, isDormantState, loadStateLabel } from "../lib/loadstate.mjs";
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
const requiredNames = ["catalog_list", "catalog_stats", "catalog_tag", "catalog_classify", "catalog_review", "catalog_publish", "catalog_health", "catalog_skill_sync"];
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
ok("只持久化视图键（data / detail 不入库）", /const VIEW_KEYS = \["query", "source", "kind", "sort", "usage", "pageSize", "page", "orphanOnly", "dormantOnly"\]/.test(clientSource));
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
		!serviceSource.slice(serviceSource.indexOf("listEntries() {"), serviceSource.indexOf("totalsOf(plugins, skills)")).includes("dirSize(") &&
		/async computeSizes\(options = \{\}\)[\s\S]{0,2000}?await dirSize\(/.test(serviceSource),
);
ok("没有独立目录时如实返回 size:null + 原因（不返回 0）", serviceSource.includes("Skill 没有独立目录") && serviceSource.includes("在官方 asar 里，没有独立目录"));
ok("导出的落盘路径由服务端决定（reports/catalog-filtered-<时间戳>.md）", serviceSource.includes('"catalog-filtered-" + stamp + ".md"'));
ok("导出文件写明条数与「只覆盖这一屏」", serviceSource.includes("这份清单只覆盖") && serviceSource.includes("共 **"));
ok("导出按钮在筛选结果为 0 时禁用", /disabled: state\.exportBusy \|\| filtered\.length === 0/.test(clientSource));
ok("0 值档位有置灰类（.dpc-insight.is-empty）", cssSource.includes(".dpc-insight.is-empty{") && clientSource.includes('(insightCounts[option.id] === 0 ? " is-empty" : "")'));

/* ─────────── R5（2026-10-22 第四轮）：多选 + 批量体积 + 导出选中 ───────────
   锁三件事：批量体积有上限（不能把宿主线程占满）、选中项**不进 localStorage**
   （半个批次被忘在存储里比丢掉更糟）、选择模式与打开浮窗必须互斥。 */
ok("/sizes 批量路由注册了", routeSource.includes('path === "/sizes" && method === "POST"'));
ok("批量体积上限 200 条", /\.slice\(0, 200\)/.test(serviceSource) && serviceSource.includes("async entrySizes(ids)"));
ok("批量体积并发 4（串行会让 20 个选中项等到几秒）", serviceSource.includes("Math.min(4, Math.max(1, queue.length))"));
ok("选中项不进 localStorage（重启后不留幽灵批次）", /const VIEW_KEYS = \["query", "source", "kind", "sort", "usage", "pageSize", "page", "orphanOnly", "dormantOnly"\]/.test(clientSource) && !/VIEW_KEYS = \[[^\]]*picked/.test(clientSource));
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
ok("漂移结果有 60 秒缓存，且重建目录会作废", serviceSource.includes("async driftOf()") && serviceSource.includes("this.driftCache = null;"));
ok("state 里带 drift 映射", /drift: await this\.driftOf\(\)/.test(serviceSource) && /\.dpc-drift\{/.test(cssSource));
ok("卡片上的漂移标签走纯函数（可断言）", /function driftLabel\(drift\)/.test(clientSource) && /function driftDetail\(drift\)/.test(clientSource));
ok("Skill 也查 staging 副本（发布上去的那份可能是旧的）", /skillsStageDirOf\(this\.settings, this\.workspace\)/.test(serviceSource) && /skillVerdict\(await skillStat\(liveDir\), await skillStat\(staged\)\)/.test(serviceSource) && /staged: true/.test(serviceSource));
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
		/if \(meta\) depIndex\.set\(meta\.name, meta\.deps\)/.test(catalogSource) &&
		catalogSource.indexOf("depIndex.set(meta.name") < catalogSource.indexOf("const looksLikeDshPlugin"),
);
ok("依赖收集含 dependencies / optionalDependencies / peerDependencies 三类", /for \(const key of \["dependencies", "optionalDependencies", "peerDependencies"\]\)/.test(catalogSource));
ok("嵌套 node_modules 展开一层（否则只被嵌套声明的包会被误判成没人要）", /const nested = join\(dir, "node_modules"\)/.test(catalogSource) && /name\.startsWith\("@\"\) \? \(await readdir\(join\(nested, name\)\)/.test(catalogSource));
ok("反向索引：谁声明了它（一个依赖可被多个包声明）", /const dependentsOf = new Map\(\)/.test(catalogSource) && /dependentsOf\.get\(dep\)\.push\(name\)/.test(catalogSource));
ok(
	"条目带 dependents / dependentCount / dependsOn / dependsOnCount",
	["dependents: pack.dependents || []", "dependentCount: pack.dependentCount || 0", "dependsOn: pack.dependsOn || []", "dependsOnCount: pack.dependsOnCount || 0"].every((needle) => catalogSource.includes(needle)),
);
ok("条目形状变了 → CATALOG_VERSION = 7（R12 加了 loadState / loadVia）", /export const CATALOG_VERSION = 7;/.test(catalogSource));
ok("依赖图自述进快照（扫了多少包 / 多少直接依赖 / 几个候选 / 加载路径四态）", /dependencyMeta: depMeta \|\| \{ scanned: 0, direct: 0, orphanHint: 0, loadRoots: 0, loadCounts: \{ bundle: 0, config: 0, transitive: 0, dormant: 0 \}, compositionFiles: 0 \}/.test(catalogSource));
ok("state 与 /health 都带依赖图", (serviceSource.match(/dependency: this\.catalog\?\.dependencyMeta \|\| null,/g) || []).length === 2);
ok("导出清单加「被依赖」列（拿出去也要能判断）", serviceSource.includes('"| 名称 | 类型 | 来源 | 调用 | 报错 | 报错率 | 最近一次 | 体积 | 被依赖 | 位置 |"'));
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
const indexSource = readFileSync(new URL("../index.js", import.meta.url), "utf8");
const hosttestSource = readFileSync(new URL("../dev/hosttest.mjs", import.meta.url), "utf8");
ok("发版体检脚本存在，且默认跑四项（audit / render / hosttest / staging）", shipSource.includes('{ id: "audit"') && shipSource.includes('{ id: "render"') && shipSource.includes('{ id: "hosttest"') && shipSource.includes('{ id: "staging"'));
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
ok("/preflight 的 dry 清单含第 4 项（面板/调用方知道会跑什么）", indexSource.includes('checks: ["audit", "render-check.cjs", "hosttest", "staging"]'));
ok("runPreflight 的 total 由 ship 事件给（不写死 3，否则加一项进度条就骗人）", serviceSource.includes('ship:check:total:') && !serviceSource.includes("total: 3"));
ok("ship 发 total 事件（面板画「第 2/4 项」）", shipSource.includes('process.stderr.write("ship:check:total:" + selected.length'));
ok("第 4 项在本进程内跑（只 stat 几十个文件，不值得再起一个 node）", shipSource.includes("inline: true") && /async function stagingCheck\(/.test(shipSource) && shipSource.includes("scanSkillStaging({ roots: skillRoots(settings.workspace), stageDir })"));
ok("第 4 项只报不拦，且不进 passed/failed 合计", shipSource.includes("informational: true") && shipSource.includes("const counted = results.filter((result) => result.informational !== true)") && shipSource.includes("results.every((result) => result.ok)"));
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
ok("版本号与构建戳同步抬到 0.12.0 / r12.0", /"version": "0\.12\.0"/.test(readFileSync(new URL("../package.json", import.meta.url), "utf8")) && clientSource.includes('const BUILD = "r12.0"'));

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

ok("客户端 isDormant 只认 loadState === 'dormant'（enabled === false 不算）", /function isDormant\(item\) \{/.test(clientSource) && clientSource.includes('return Boolean(item && item.loadState === "dormant");'));
ok("卡片置灰只跟 dormant 走（旧口径 `enabled === false ? \" is-off\"` 必须消失）", !clientSource.includes('(item.enabled === false ? " is-off"') && clientSource.includes('(isDormant(item) ? " is-off"'));
ok("卡片 chip 只给两档（不会被加载 / 配置入口），间接加载 152 条不占版面", clientSource.includes('if (item.loadState === "dormant") return "不会被加载";') && clientSource.includes('if (item.loadState === "config") return "配置入口";'));
ok("详情页「启用」格子按四态说人话（配置(id)/随 X/是/否）", clientSource.includes('if (item.loadState === "config") return "配置("') && clientSource.includes('if (item.loadState === "transitive") return "随 "') && clientSource.includes("loadCell(item)"));
ok("工具条有「不会被加载 N」筛选，且进 localStorage（视图记忆）", clientSource.includes('"不会被加载 " + dormantCount') && clientSource.includes("if (state.dormantOnly && !isDormant(item)) return false;"));
ok("筛选计数只受 kind/source 影响（不随关键词跳）", /const dormantCount = useMemo\(\(\) => \{[\s\S]{0,260}state\.kind === "all"[\s\S]{0,160}state\.source === "any"/.test(clientSource));
ok("新类名都有样式定义", [".dpc-load{", ".dpc-load.is-config{", ".dpc-load-warn{"].every((needle) => cssSource.includes(needle)));
ok("README 双语都写了「不会被加载」这个口径", readFileSync(new URL("../README.md", import.meta.url), "utf8").includes("不会被加载") && readFileSync(new URL("../README.en.md", import.meta.url), "utf8").includes("not loaded"));

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
