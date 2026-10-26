/**
 * probe-composition.mjs — 配置层（声明层）的独立探针（R22）。
 *
 * 为什么单独一个探针：这一层全是**读文本、容易读错却不报错**的判据 ——
 *   · 块标量（`name: >-`）：本机真有一条按 `file://` 挂载的条目写成折叠标量，
 *     旧解析器把它读成字面量 `>-`（于是那条目成了"名字叫 >- 的包"）；
 *   · `disabled` 有六种写法：`true` / `false` / 空 / `!!js '…'` / `!!js process.platform…`；
 *     全归成布尔量就会把"条件启用"说成"关掉"或"开着"；
 *   · 同一 id 在两份文件里 = patch 覆盖：没 name 的那种也要能覆盖到基线，否则这条 patch 丢了；
 *   · 解析结果分五档（已装 / 官方 asar / 静态查不到 / 无法判定 / 不适用），
 *     任何一档被合并都会让面板在"asar 读不到"时报一堆假的"缺"。
 *
 * 用法：`node dev/probe-composition.mjs [--json]`；破任一断言退出码 1。
 * 全程**纯函数**：不读 profile、不读 asar、不碰真实配置文件（合成文本 + 合成包名表）。
 */

import { auditComposition, classifyCompositionName, compactComposition, mergeCompositionEntries, packageNameOf, parseComposition, parseDisabled, renderCompositionSection, summarizeComposition } from "../lib/composition.mjs";

const results = [];
function ok(name, condition, detail = "") {
	results.push({ name, pass: Boolean(condition), detail });
}

const FIXTURE = [
	"# 注释行",
	"- id: alpha",
	"  name: dsh-alpha",
	"  config:",
	"    - id: nested-entry",
	"      name: NESTED-MUST-NOT-COUNT",
	"- id: beta",
	"  name: '@scope/pkg'",
	"  disabled: true",
	"- id: gamma",
	"  name: >-",
	"    file:///D:/cfg/y.mjs",
	"- id: delta",
	"  disabled: !!js 'ctx.get(\"profile\")'",
].join("\n");

/* ── C1 顶层条目、引号、嵌套 config 里的 id/name 不算 ── */
{
	const entries = parseComposition(FIXTURE);
	ok("C1 组合文件只收顶层条目（嵌套 config 里的 id/name 不算）", entries.length === 4 && entries.map((entry) => entry.id).join(",") === "alpha,beta,gamma,delta", JSON.stringify(entries.map((entry) => entry.id)));
	ok("C1b 引号被剥掉（'@scope/pkg'）", entries[1].name === "@scope/pkg", entries[1].name);
	ok("C1c 空文本 / null 不抛（返回空数组）", parseComposition("").length === 0 && parseComposition(null).length === 0);
}

/* ── C2 块标量：`name: >-` 必须读成它的内容，不能是字面量 `>-` ──
   ★ 这是 R22 修掉的真实解析 bug：本机 `vision-router-web-connection-ready` 就是这么写的。 */
{
	const entries = parseComposition(FIXTURE, { file: "cordis.yml" });
	const gamma = entries.find((entry) => entry.id === "gamma");
	ok("C2 折叠块标量（name: >-）读到的是内容，不是 `>-`", gamma && gamma.name === "file:///D:/cfg/y.mjs", gamma ? JSON.stringify(gamma.name) : "missing");
	ok("C2b 条目带文件归属与行号（gamma 在 cordis.yml:10）", gamma && gamma.file === "cordis.yml" && gamma.line === 10, gamma ? gamma.file + ":" + gamma.line : "missing");
	ok("C2c 块标量后面的条目没有被吞掉（delta 还在，行号 13）", entries[3].id === "delta" && entries[3].line === 13, entries[3].id + ":" + entries[3].line);
}

/* ── C3 disabled 的六种写法 ── */
{
	const cases = [
		["true", "off"],
		["false", "on"],
		["", "on"],
		["!!js '!ctx.get(''profileContext'')'", "expression"],
		["!!js process.platform === 'win32'", "expression"],
		["0", "expression"],
	];
	const got = cases.map(([raw]) => parseDisabled(raw).kind);
	ok("C3 disabled 六种写法分开（true=off / false 与空=on / !!js 与未知=expression）", JSON.stringify(got) === JSON.stringify(cases.map(([, kind]) => kind)), JSON.stringify(got));
	const entries = parseComposition(FIXTURE);
	const beta = entries.find((entry) => entry.id === "beta");
	const delta = entries.find((entry) => entry.id === "delta");
	ok("C3b 只有字面量 true 让 `disabled` 为真（条件启用不改加载判据）", beta.disabled === true && delta.disabled === false && delta.disabledKind === "expression", `beta=${beta.disabled} delta=${delta.disabled}/${delta.disabledKind}`);
	ok("C3c 条件条目保留表达式原文（给面板展示，不求值）", delta.disabledRaw.includes("ctx.get") && delta.hasDisabled === true, delta.disabledRaw);
}

/* ── C4 按 id 合并（patch 语义） ── */
{
	const base = parseComposition(["- id: a", "  name: dsh-a", "  disabled: true", "- id: b", "  name: dsh-b", "- id: c", "  disabled: true"].join("\n"), { file: "cordis.yml" });
	const patch = parseComposition(["- id: a", "  disabled: false", "- id: c", "  name: dsh-c"].join("\n"), { file: "cordis.patch.yml" });
	const merged = mergeCompositionEntries([...base, ...patch]);
	const a = merged.find((entry) => entry.id === "a");
	const c = merged.find((entry) => entry.id === "c");
	ok("C4 同 id 合并成一条（246 条生效就是这么来的）", merged.length === 3 && merged.map((entry) => entry.id).join(",") === "a,b,c", merged.map((entry) => entry.id).join(","));
	ok("C4b 后者的 disabled 覆盖前者（a: true → false）", a && a.disabled === false && a.patches === 1, a ? `${a.disabled}/${a.patches}` : "missing");
	ok("C4c 后者只给 name 时，前者的 disabled 保留（c 仍关着）", c && c.name === "dsh-c" && c.disabled === true, c ? `${c.name}/${c.disabled}` : "missing");
	ok("C4d 合并后记下来源文件（firstFile 与最后一次写入的 file）", a && a.firstFile === "cordis.yml" && a.file === "cordis.patch.yml" && a.patchedFiles.includes("cordis.patch.yml"), a ? `${a.firstFile} → ${a.file}` : "missing");
}

/* ── C5 包名与条目类型 ── */
{
	const names = ["@scope/pkg", "@scope/pkg/sub", "pkg", "pkg/sub", "", "@scope"];
	ok("C5 去子路径得到包名（scope / 子路径 / 裸名 / 空）", JSON.stringify(names.map(packageNameOf)) === JSON.stringify(["@scope/pkg", "@scope/pkg", "pkg", "pkg", "", "@scope"]), JSON.stringify(names.map(packageNameOf)));
	const kinds = [
		["dsh-x", "package"],
		["dsh-x/sub", "subpath"],
		["@s/p/sub", "subpath"],
		["file:///D:/a.mjs", "file"],
		["cordis:group", "group"],
		["", "id-only"],
	].map(([name]) => classifyCompositionName(name).kind);
	ok("C5b 五类条目分得开（包 / 子路径 / 按路径 / 分组 / 只按 id）", JSON.stringify(kinds) === JSON.stringify(["package", "subpath", "subpath", "file", "group", "id-only"]), JSON.stringify(kinds));
	const fileUrl = classifyCompositionName("file:///D:/cfg/y.mjs");
	ok("C5c 按路径挂载会被归一化成可比较的路径（小写 / 正斜杠 / 解码）", fileUrl.path === "d:/cfg/y.mjs", fileUrl.path);
}

/* ── C6 解析五档：已装 / asar / 静态查不到 / 无法判定 / 不适用 ── */
function auditFixture(overrides = {}) {
	const files = overrides.files || [
		{
			file: "cordis.yml",
			text: [
				"- id: local",
				"  name: dsh-local",
				"- id: from-asar",
				"  name: dsh-asar",
				"- id: both",
				"  name: dsh-both",
				"- id: nope",
				"  name: dsh-nope",
				"- id: file-ok",
				"  name: file:///D:/cfg/ok.mjs",
				"- id: file-gone",
				"  name: file:///D:/cfg/gone.mjs",
				"- id: group",
				"  name: cordis:group",
				"- id: override-only",
				"  disabled: true",
				"- id: sub",
				"  name: dsh-local/sub",
			].join("\n"),
		},
	];
	return auditComposition({
		files,
		bundles: overrides.bundles || ["dsh-local"],
		installed: new Map([["dsh-local", []], ["dsh-both", []]]),
		asarNames: overrides.asarNames === undefined ? new Set(["dsh-asar", "dsh-both"]) : overrides.asarNames,
		existingFiles: overrides.existingFiles || ["D:\\cfg\\ok.mjs"],
		at: 1,
	});
}
{
	const report = auditFixture();
	const byId = new Map(report.entries.map((entry) => [entry.id, entry]));
	ok("C6 已装 → present / asar → asar / 两处都有时 present 优先", byId.get("local").resolution === "present" && byId.get("from-asar").resolution === "asar" && byId.get("both").resolution === "present", JSON.stringify([byId.get("local").resolution, byId.get("from-asar").resolution, byId.get("both").resolution]));
	ok("C6b 两处都没有 → missing，并给一句人话原因", byId.get("nope").resolution === "missing" && byId.get("nope").why.includes("静态判据看不见运行期注入"), byId.get("nope").why);
	ok("C6c 按路径挂载：文件在 → present，不在 → missing（原因写「文件不在」）", byId.get("file-ok").resolution === "present" && byId.get("file-gone").resolution === "missing" && byId.get("file-gone").why.includes("文件不在"), byId.get("file-gone").why);
	ok("C6d 分组 / 只按 id 覆盖 → n/a（不是「缺」）", byId.get("group").resolution === "n/a" && byId.get("override-only").resolution === "n/a", `${byId.get("group").resolution}/${byId.get("override-only").resolution}`);
	ok("C6e 子路径按包名判（dsh-local/sub 仍在 profile 里 → present）", byId.get("sub").kind === "subpath" && byId.get("sub").resolution === "present", byId.get("sub").resolution);
}

/* ── C7 bundles 的缺口（真的缺 / 官方 asar） ── */
{
	const report = auditFixture({ bundles: ["dsh-local", "dsh-asar", "dsh-nope"] });
	ok("C7 bundles 缺口三档分开（已装 / 官方 asar / 真的缺）", report.bundles.present === 1 && report.bundles.asar === 1 && report.bundles.missing === 1, JSON.stringify({ ...report.bundles, rows: undefined }));
	ok("C7b 真的缺的 bundle 单独成列（宿主启用它时会失败）", report.bundlesMissing.length === 1 && report.bundlesMissing[0].name === "dsh-nope", JSON.stringify(report.bundlesMissing));
}

/* ── C8 计数守恒 ── */
{
	const report = auditFixture();
	const kindSum = Object.values(report.counts.byKind).reduce((sum, n) => sum + n, 0);
	const resolutionSum = Object.values(report.counts.byResolution).reduce((sum, n) => sum + n, 0);
	const stateSum = Object.values(report.counts.byState).reduce((sum, n) => sum + n, 0);
	const packageSum = report.packages.present + report.packages.asar + report.packages.missing + report.packages.unjudged;
	ok("C8 每条生效条目都落进恰好一个 kind / 一个 resolution / 一个 state", kindSum === report.counts.effective && resolutionSum === report.counts.effective && stateSum === report.counts.effective, `${kindSum}/${resolutionSum}/${stateSum} vs ${report.counts.effective}`);
	ok("C8b 按包名去重后的四档之和 = 不同包数（不许有包落不进任何一档）", packageSum === report.packages.distinct, `${packageSum} vs ${report.packages.distinct}`);
}

/* ── C9 严重度：只有 bundles 真的缺才算 bad ──
   ★ 组合条目「静态查不到」可能由运行期注入满足（本机 dsh-plugin-desktop），
     所以它只能是 warn —— 判成 bad 会让面板每次打开都在喊"要坏了"。 */
{
	const okReport = auditComposition({
		files: [{ file: "cordis.yml", text: "- id: a\n  name: dsh-local" }],
		bundles: ["dsh-local"],
		installed: new Map([["dsh-local", []]]),
		asarNames: new Set(),
		at: 1,
	});
	const warnReport = auditFixture();
	const badReport = auditFixture({ bundles: ["dsh-nope"] });
	ok("C9 verdict：无缺口 ok / 条目静态查不到 warn / bundle 真的缺 bad", okReport.verdict === "ok" && warnReport.verdict === "warn" && badReport.verdict === "bad", `${okReport.verdict}/${warnReport.verdict}/${badReport.verdict}`);
}

/* ── C10 asar 读不到时：一律 unjudged，绝不当成「缺」 ── */
{
	const report = auditFixture({ asarNames: null, bundles: ["dsh-local", "dsh-asar"] });
	const nope = report.entries.find((entry) => entry.id === "nope");
	ok("C10 asar 读不到 → 包条目 unjudged、包缺口 0、verdict 只到 warn", nope.resolution === "unjudged" && report.packages.missing === 0 && report.packages.unjudged === 2 && report.verdict === "warn", `${nope.resolution} packages.missing=${report.packages.missing} unjudged=${report.packages.unjudged} verdict=${report.verdict}`);
	ok("C10b 按路径挂载的「文件不在」不因 asar 读不到而变成 unjudged（它本来就能判）", report.missing.length === 1 && report.missing[0].id === "file-gone", JSON.stringify(report.missing.map((row) => row.id)));
	ok("C10b bundles 也区分「无法判定」与「真的缺」", report.bundles.unjudged === 1 && report.bundles.missing === 0 && report.bundlesMissing.length === 0, JSON.stringify({ ...report.bundles, rows: undefined }));
}

/* ── C11 只按 id 覆盖的 patch 条目不能变成"包" ── */
{
	const base = parseComposition(["- id: x", "  name: dsh-x", "  disabled: true"].join("\n"), { file: "cordis.yml" });
	const patch = parseComposition(["- id: x", "  disabled: false", "- id: y", "  disabled: true"].join("\n"), { file: "cordis.patch.yml" });
	const merged = mergeCompositionEntries([...base, ...patch]);
	const y = merged.find((entry) => entry.id === "y");
	const classified = classifyCompositionName(y.name);
	ok("C11 没 name 的 patch 条目 → kind=id-only、解析 n/a（不是「缺包」）", y && classified.kind === "id-only" && y.disabled === true, y ? `${classified.kind}/${y.disabled}` : "missing");
}

/* ── C12 摘要与紧凑视图（面板/health/工具读的就是这两份） ── */
{
	const report = auditFixture();
	const line = compactComposition(report).summary;
	/* ★ R35 修口径：这里数的是**所有**静态查不到的条目（含按路径挂载的文件），
	   与 chip（byResolution.missing）和浮层清单（report.missing）同一个数。
	   以前用 packages.missing（只数包）会出现「chip 说 2、摘要说 1」的自相矛盾。 */
	ok("C12 摘要里带两份文件的条目数、静态查不到（全部条目，不是只数包）与 bundles 缺口", line.includes("cordis.yml 9") && line.includes("静态查不到 " + report.missing.length) && line.includes("bundles 1 →"), line);
	const compact = compactComposition(report, 2);
	ok("C12b 紧凑视图按 cap 截断列表，但计数仍是真实数字", compact.missing.length <= 2 && compact.counts.byResolution.missing === report.missing.length && compact.entries === undefined, `missing=${compact.missing.length} counts=${compact.counts.byResolution.missing}`);
}

/* ── C15 紧凑视图带 bundleNames（R24：面板拿它判「这条在不在 bundles 里」） ── */
{
	const compact = compactComposition(auditFixture({ bundles: ["dsh-local", "dsh-both", "dsh-local"] }));
	ok("C15 bundleNames 去重 + 排序（只给包名，不传 bundles 整行）", JSON.stringify(compact.bundleNames) === JSON.stringify(["dsh-both", "dsh-local"]) && compact.bundleNames.length === 2 && compact.bundles.rows === undefined, JSON.stringify(compact.bundleNames));
}

/* ── C16 没有 bundles 时给空数组（旧缓存 / 空 profile 不抛） ── */
{
	const compact = compactComposition(auditFixture({ bundles: [] }));
	ok("C16 没有 bundles → bundleNames 是空数组（不是 undefined）", Array.isArray(compact.bundleNames) && compact.bundleNames.length === 0);
}

/* ── C13 导出的一节：缺口为 0 时不许写"真的缺 N" ── */
{
	const clean = renderCompositionSection(auditFixture({ bundles: ["dsh-local"], files: [{ file: "cordis.yml", text: "- id: a\n  name: dsh-local" }] }));
	const dirty = renderCompositionSection(auditFixture({ bundles: ["dsh-nope"] }));
	const cleanText = clean.join("\n");
	const dirtyText = dirty.join("\n");
	ok("C13 没缺口时写「缺口：0」，不写「真的缺」", cleanText.includes("缺口：**0**") && !cleanText.includes("### 真的缺"), cleanText.split("\n").slice(0, 6).join(" | ").slice(0, 160));
	ok("C13b 有 bundle 缺口时单开一节，并写清「宿主启用它时会失败」", dirtyText.includes("### 真的缺") && dirtyText.includes("宿主启用它时会失败"), dirtyText.includes("### 真的缺"));
	ok(
		"C13c 边界说明必须写进报告（按 bundles 顺序合并 / 后者胜 / 表达式不求值 / 运行期虚拟模块看不见）",
		dirtyText.includes("bundles 顺序") && dirtyText.includes("后者胜") && dirtyText.includes("不求值") && dirtyText.includes("运行期注入"),
		"boundary",
	);
}

/* ── C17 R33：`- insert:` 块（rc.3 的 bundle patch 全是这个形状） ── */
{
	const text = [
		"- insert:",
		"    - id: alpha",
		"      name: dsh-alpha",
		"      config:",
		"        - id: not-an-entry",
		"          name: also-not",
		"    - id: beta",
		"      name: >-",
		"        dsh-beta",
		"      disabled: true",
		"    - id: gamma",
		"      name: dsh-gamma",
	].join("\n");
	const rows = parseComposition(text, { file: "bundle/cordis.patch.yml" });
	const byId = new Map(rows.map((row) => [row.id, row]));
	ok("C17 insert 块里的条目都解析出来（4 空格缩进）", rows.length === 3 && byId.has("alpha") && byId.has("beta") && byId.has("gamma"), `rows=${rows.length}`);
	ok("C17b config 内部的 10 空格 `- id:` 不算条目", !byId.has("not-an-entry") && !byId.has("also-not"), [...byId.keys()].join(","));
	ok("C17c 条目属性在 6 空格也读得到（disabled）", Boolean(byId.get("beta")) && byId.get("beta").disabled === true, JSON.stringify(byId.get("beta") || {}));
	ok("C17d 块标量 `name: >-` 在 insert 块里不吞下一条目", Boolean(byId.get("beta")) && byId.get("beta").name === "dsh-beta" && Boolean(byId.get("gamma")) && byId.get("gamma").name === "dsh-gamma", JSON.stringify([byId.get("beta") && byId.get("beta").name, byId.get("gamma") && byId.get("gamma").name]));
	ok("C17e insert 条目带 insert:true，列 0 条目不带", byId.get("alpha").insert === true && parseComposition("- id: top\n  name: dsh-top")[0].insert === false, "insert flag");
}

/* ── C18 R33：分层合并（bundle 层在前、profile patch 在后，同 id 后者胜） ── */
{
	const files = [
		{ file: "cordis.yml", text: "# empty\n[]", role: "root" },
		{ file: "node_modules/a/cordis.patch.yml", text: "- insert:\n    - id: shared\n      name: dsh-a\n      disabled: false\n    - id: only-a\n      name: dsh-only-a", role: "bundle-patch", source: "profile", bundle: "a" },
		{ file: "node_modules/base/cordis.patch.yml", text: "- insert:\n    - id: shared\n      name: dsh-base\n      disabled: true", role: "bundle-patch", source: "asar", bundle: "base" },
		{ file: "cordis.patch.yml", text: "- id: shared\n  disabled: false\n- id: shared\n  disabled: true", role: "profile-patch" },
	];
	const report = auditComposition({ files, bundles: ["a"], installed: new Map([["dsh-a", []], ["dsh-only-a", []]]), asarNames: new Set() });
	const shared = report.entries.find((row) => row.id === "shared");
	ok("C18 同 id 后写的层胜（profile patch 最后应用）", Boolean(shared) && shared.state === "off" && shared.layer === "profile-patch", JSON.stringify(shared || {}));
	ok("C18b 层数 / 层内条数记全（root+bundle×2+profile=4 层）", report.layers.length === 4 && report.counts.byRole.root === 0 && report.counts.byRole["bundle-patch"] === 3 && report.counts.byRole["profile-patch"] === 2, JSON.stringify(report.counts.byRole));
	ok("C18c asar 来源的层要标出来", (report.layers.find((row) => row.bundle === "base") || {}).source === "asar", "source");
	ok("C18d 合并后生效条数少于解析条数（共享 id 被折叠）", report.counts.parsed === 5 && report.counts.effective === 2, `${report.counts.parsed}/${report.counts.effective}`);
}

/* ── C19 R33：组合模型（rc.2 flat / rc.3 bundle-layers / 空） ── */
{
	const flat = auditComposition({ files: [{ file: "cordis.yml", text: "- id: a\n  name: dsh-a" }] });
	const layered = auditComposition({ files: [{ file: "cordis.yml", text: "[]" }, { file: "x/cordis.patch.yml", text: "- insert:\n    - id: a\n      name: dsh-a", role: "bundle-patch", bundle: "x" }] });
	const empty = auditComposition({});
	ok("C19 入口表有条目 → flat；入口表空 + bundle 层 → bundle-layers；无文件 → empty", flat.model === "flat" && layered.model === "bundle-layers" && empty.model === "empty", [flat.model, layered.model, empty.model].join("/"));
	ok("C19b 空入口表 + 无 bundle 层 → 不冒充 bundle-layers", auditComposition({ files: [{ file: "cordis.yml", text: "[]" }] }).model === "flat", "single-empty-root");
}

/* ── C20 R33：计数守恒（分层不重不漏） ── */
{
	const files = [
		{ file: "cordis.yml", text: "[]", role: "root" },
		{ file: "a/cordis.patch.yml", text: "- insert:\n    - id: a1\n      name: dsh-a1\n    - id: a2\n      name: dsh-a2", role: "bundle-patch", bundle: "a" },
		{ file: "cordis.patch.yml", text: "- id: a1\n  disabled: true\n- id: p1\n  name: dsh-p1", role: "profile-patch" },
	];
	const report = auditComposition({ files, installed: new Map([["dsh-a1", []], ["dsh-a2", []], ["dsh-p1", []]]) });
	const sumLayers = report.layers.reduce((sum, row) => sum + row.entries, 0);
	const sumRoles = report.counts.byRole.root + report.counts.byRole["bundle-patch"] + report.counts.byRole["profile-patch"];
	ok("C20 counts.parsed = 各层条目之和 = byRole 之和", report.counts.parsed === sumLayers && sumLayers === sumRoles, `${report.counts.parsed}/${sumLayers}/${sumRoles}`);
	ok("C20b 生效 ≤ 解析，且 insert 条数单独可读", report.counts.effective <= report.counts.parsed && report.counts.inserted === 2, `${report.counts.effective}/${report.counts.parsed}/${report.counts.inserted}`);
}

/* ── C21 R33：摘要与紧凑视图（面板 20 秒轮询只拿计数） ── */
{
	const files = [
		{ file: "cordis.yml", text: "[]", role: "root" },
		{ file: "a/cordis.patch.yml", text: "- insert:\n    - id: a1\n      name: dsh-a1", role: "bundle-patch", source: "asar", bundle: "a" },
		{ file: "cordis.patch.yml", text: "- id: a1\n  disabled: true", role: "profile-patch" },
	];
	const report = auditComposition({ files, installed: new Map([["dsh-a1", []]]) });
	const summary = summarizeComposition(report);
	const compact = compactComposition(report);
	ok("C21 摘要写明 bundle-layers 模型与两层条数", summary.includes("bundle-layers") && summary.includes("bundle 层 1 份") && summary.includes("profile patch 1 条"), summary.slice(0, 90));
	ok("C21b compact 带 model + layers 计数（不塞 49 条路径）", compact.model === "bundle-layers" && compact.layers.bundleFiles === 1 && compact.layers.profileEntries === 1 && !JSON.stringify(compact.layers).includes("cordis.patch.yml"), JSON.stringify(compact.layers));
}

/* ── C22 R33：读不到的层不算空层（要能说出来） ── */
{
	const report = auditComposition({ files: [{ file: "cordis.yml", text: "[]", role: "root" }], missing: ["@deepseek-ai/dsh-base", "dsh-x"] });
	const summary = summarizeComposition(report);
	ok("C22 读不到的层进 missingLayers（不静默成 0 条）", report.missingLayers.length === 2 && summary.includes("读不到的层 2 份"), JSON.stringify(report.missingLayers));
	ok("C22b 没有 missing 时不写这句（避免噪音）", !summarizeComposition(auditComposition({ files: [{ file: "cordis.yml", text: "[]" }] })).includes("读不到的层"), "no-missing");
}

/* ── C14 空输入 / 坏输入不炸（旧 profile、没有组合文件、坏 types） ── */
{
	const empty = auditComposition({});
	const nulls = auditComposition({ files: [null, { text: null }, { file: "x", text: "" }], bundles: null, installed: null, asarNames: undefined });
	ok("C14 没有组合文件 / 坏类型不抛（空报告、verdict=ok）", empty.counts.effective === 0 && empty.verdict === "ok" && nulls.counts.effective === 0, `${empty.verdict}/${nulls.counts.effective}`);
}

const failed = results.filter((item) => !item.pass);
if (process.argv.includes("--json")) {
	console.log(JSON.stringify({ passed: results.length - failed.length, failed: failed.length, results }, null, 1));
} else {
	for (const item of results) console.log(`${item.pass ? "  ok" : "  FAIL"}  ${item.name}${item.pass || !item.detail ? "" : "  [" + item.detail + "]"}`);
	console.log(`\nprobe-composition: passed ${results.length - failed.length} / failed ${failed.length}`);
}
if (failed.length > 0) process.exit(1);
