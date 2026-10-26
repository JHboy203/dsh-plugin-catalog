/**
 * probe-history.mjs — 变化追踪的独立探针（R17）。
 *
 * 为什么单独一个探针：`history.mjs` 里全是**写反了也不报错**的判断 ——
 * 指纹稳不稳定、同一条目多处变化会不会被重复计数、来源覆盖算不算变化、
 * 快照裁剪会不会把最近的几条裁掉。这些错了以后面板照样显示"0 处变化"，
 * 而用户会以为"这两天什么都没变"。静态契约看不出来，只能在合成数据上跑一遍。
 *
 * 用法：`node dev/probe-history.mjs [--json]`；破任一不变式退出码 1。
 * 全程**不碰磁盘**：目录是内存里的合成数据，不读也不写 history.json。
 */

import { compactSnapshot, compareComposition, compareEntries, compositionDetailText, compositionSignalOf, describeChange, diffSnapshots, expandSnapshot, fingerprintOf, HISTORY_VERSION, normalizeAck, normalizeHistory, pruneSnapshots, sameSignal, serializeHistory, signalOf, snapshotOf, summarizeChanges, timelineOf } from "../lib/history.mjs";
import { signatureOf } from "../lib/composition.mjs";

const results = [];
function ok(name, condition, detail = "") {
	results.push({ name, pass: Boolean(condition), detail });
}

/** 合成目录：两个插件 + 一个 Skill。 */
function catalogOf(patch = {}) {
	return {
		plugins: [
			{ id: "plugin:alpha", name: "alpha", source: "self", version: patch.alphaVersion ?? "1.0.0", loadState: patch.alphaState ?? "bundle" },
			{ id: "plugin:beta", name: "beta", source: patch.betaSource ?? "third", version: "2.0.0", loadState: "transitive" },
			...(patch.dropBeta ? [] : []),
		],
		skills: [{ id: "skill:gamma", name: "gamma", source: "self", hasDescription: patch.gammaDescribed ?? true, contentHash: patch.gammaHash ?? "" }],
	};
}

const AT = 1760000000000;

/* ── H1 空目录也是合法快照（0 条，不是 null） ── */
{
	const snapshot = snapshotOf({ plugins: [], skills: [] }, null, AT);
	ok("H1 空目录 → 合法快照（0 条，指纹存在）", snapshot.count === 0 && typeof snapshot.fingerprint === "string" && snapshot.fingerprint.length === 12);
}

/* ── H2 指纹稳定：同输入两次一致，且与键顺序无关 ── */
{
	const a = snapshotOf(catalogOf(), null, AT);
	const b = snapshotOf(catalogOf(), null, AT + 999);
	const reversed = { plugins: [...catalogOf().plugins].reverse(), skills: catalogOf().skills };
	const c = snapshotOf(reversed, null, AT);
	ok("H2 指纹与时间、条目顺序无关（同一目录只认内容）", a.fingerprint === b.fingerprint && a.fingerprint === c.fingerprint, `${a.fingerprint} ${b.fingerprint} ${c.fingerprint}`);
}

/* ── H3 指纹敏感：版本变一位就变 ── */
{
	const base = snapshotOf(catalogOf(), null, AT);
	const bumped = snapshotOf(catalogOf({ alphaVersion: "1.0.1" }), null, AT);
	ok("H3 版本变 → 指纹变", base.fingerprint !== bumped.fingerprint);
}

/* ── H4 没变化：total=0，unchanged 等于全部条目 ── */
{
	const prev = snapshotOf(catalogOf(), null, AT);
	const next = snapshotOf(catalogOf(), null, AT + 1000);
	const diff = diffSnapshots(prev, next);
	ok("H4 无变化时 total=0 且全部计入 unchanged", diff.counts.total === 0 && diff.unchanged === 3, JSON.stringify(diff.counts));
}

/* ── H5 新增与消失各算各的 ── */
{
	const prev = snapshotOf(catalogOf(), null, AT);
	const addedCatalog = { ...catalogOf(), plugins: [...catalogOf().plugins, { id: "plugin:delta", name: "delta", source: "official", version: "3.0.0", loadState: "bundle" }] };
	const next = snapshotOf(addedCatalog, null, AT);
	const diff = diffSnapshots(prev, next);
	const back = diffSnapshots(next, prev);
	ok("H5 新增 / 消失能互相倒过来", diff.counts.added === 1 && diff.counts.removed === 0 && diff.added[0].name === "delta" && back.counts.removed === 1 && back.removed[0].name === "delta", JSON.stringify({ added: diff.added, removed: back.removed }));
}

/* ── H6 版本变化带 from / to ── */
{
	const prev = snapshotOf(catalogOf(), null, AT);
	const next = snapshotOf(catalogOf({ alphaVersion: "1.1.0" }), null, AT);
	const diff = diffSnapshots(prev, next);
	ok("H6 版本变化带 from/to", diff.counts.version === 1 && diff.versionChanged[0].from === "1.0.0" && diff.versionChanged[0].to === "1.1.0", JSON.stringify(diff.versionChanged));
}

/* ── H7 来源覆盖（手工改的来源）本身算变化 ── */
{
	const prev = snapshotOf(catalogOf(), null, AT);
	const next = snapshotOf(catalogOf(), { sources: { "plugin:beta": "self" } }, AT);
	const diff = diffSnapshots(prev, next);
	ok("H7 手工改来源 → sourceChanged（否则改完来源下次重建又「没变」）", diff.counts.source === 1 && diff.sourceChanged[0].from === "third" && diff.sourceChanged[0].to === "self", JSON.stringify(diff));
}

/* ── H8 加载态变化能被看见（dormant ↔ bundle 是处置决策的分水岭） ── */
{
	const prev = snapshotOf(catalogOf(), null, AT);
	const next = snapshotOf(catalogOf({ alphaState: "dormant" }), null, AT);
	const diff = diffSnapshots(prev, next);
	ok("H8 加载态变化带 from/to", diff.counts.loadState === 1 && diff.loadStateChanged[0].from === "bundle" && diff.loadStateChanged[0].to === "dormant");
}

/* ── H9 同一个条目多处变化，total 只算一次（否则「共 N 处」会虚高） ── */
{
	const prev = snapshotOf(catalogOf(), null, AT);
	const next = snapshotOf(catalogOf({ alphaVersion: "9.9.9", alphaState: "config" }), { sources: { "plugin:alpha": "hybrid" } }, AT);
	const diff = diffSnapshots(prev, next);
	ok("H9 同一条目多处变化 total 去重（3 类变化只算 1 条）", diff.counts.total === 1 && diff.counts.version === 1 && diff.counts.source === 1 && diff.counts.loadState === 1, JSON.stringify(diff.counts));
}

/* ── H10 Skill 的描述有无也算变化（Skill 没有版本号，这是唯一能看见的编辑信号） ── */
{
	const prev = snapshotOf(catalogOf({ gammaDescribed: true }), null, AT);
	const next = snapshotOf(catalogOf({ gammaDescribed: false }), null, AT);
	const diff = diffSnapshots(prev, next);
	ok("H10 Skill 描述有无 → 算一处变化（必须单列类别，否则 sameSignal 说变了、total 还是 0）", diff.counts.total === 1 && diff.counts.edited === 1 && diff.counts.version === 0 && diff.unchanged === 2, JSON.stringify(diff.counts));
}

/* ── H11 裁剪：留最近 N 条、按时间升序（别把最新的裁掉） ── */
{
	const list = Array.from({ length: 25 }, (_, index) => ({ at: AT + index, entries: {} }));
	const kept = pruneSnapshots(list, 5);
	ok("H11 裁剪只留最近 N 条且升序", kept.length === 5 && kept[4].at === AT + 24 && kept[0].at === AT + 20, kept.map((item) => item.at - AT).join(","));
}

/* ── H12 坏历史文件当空历史（面板不该因为一行脏 JSON 打不开） ── */
{
	const broken = normalizeHistory({ snapshots: "nope" });
	const messy = normalizeHistory({ snapshots: [{ at: AT, entries: {} }, null, { at: "x" }, { at: AT + 1, entries: {} }] });
	ok("H12 坏 / 脏历史 → 空历史或只留合法条目", broken.version === HISTORY_VERSION && broken.snapshots.length === 0 && messy.snapshots.length === 2, JSON.stringify({ broken: broken.snapshots.length, messy: messy.snapshots.length }));
}

/* ── H13 人话措辞：四类各一句，且不会把 undefined 打出来 ── */
{
	const texts = [
		describeChange({ name: "alpha", version: "1.0.0" }, "added"),
		describeChange({ name: "alpha", version: "1.0.0" }, "removed"),
		describeChange({ name: "alpha", from: "1.0.0", to: "1.1.0" }, "version"),
		describeChange({ name: "alpha", from: "third", to: "self" }, "source"),
		describeChange({ name: "alpha", from: "bundle", to: "dormant" }, "loadState"),
	];
	ok("H13 人话措辞不出现 undefined", texts.every((text) => !/undefined|null/.test(text)) && texts[2] === "alpha 1.0.0 → 1.1.0", texts.join(" | "));
}

/* ── H14 sameSignal 是 diff 的唯一判据（两处各写一份迟早会差） ── */
{
	const a = signalOf({ version: "1", source: "self", loadState: "bundle", kind: "plugin" });
	const b = signalOf({ version: "1", source: "self", loadState: "bundle", kind: "plugin" });
	const c = signalOf({ version: "1", source: "self", loadState: "dormant", kind: "plugin" });
	ok("H14 sameSignal 逐字段比较", sameSignal(a, b) === true && sameSignal(a, c) === false);
}

/* ── H15 第一条快照不是"所有条目都新增" ──
   ★ hosttest 真机抓到过一次：first=true 但 counts.total=133 —— 第一次打开就报
     "133 处变化"，用户会以为刚装了一堆东西。摘要必须把它压成 0。 */
{
	const first = snapshotOf(catalogOf(), null, AT);
	const summary = summarizeChanges(null, first);
	const second = snapshotOf(catalogOf({ alphaVersion: "2.0.0" }), null, AT);
	const after = summarizeChanges(first, second);
	ok(
		"H15 第一条快照 0 处变化（不是 3 条新增），且 total 仍是条目总数",
		summary.first === true && summary.counts.total === 0 && summary.counts.added === 0 && summary.total === 3 && after.counts.total === 1,
		JSON.stringify({ first: summary.counts, after: after.counts }),
	);
}

/* ── R19：Skill 正文指纹（catalog 读 SKILL.md 时顺手算的 12 位哈希） ── */

/* ── H16 正文改了 → 被编辑（reason=content），带短哈希 ── */
{
	const prev = snapshotOf(catalogOf({ gammaHash: "aaaa11112222" }), null, AT);
	const next = snapshotOf(catalogOf({ gammaHash: "bbbb33334444" }), null, AT);
	const diff = diffSnapshots(prev, next);
	ok(
		"H16 正文指纹变 → 被编辑（reason=content，带 8 位短哈希）",
		diff.counts.total === 1 && diff.counts.edited === 1 && diff.edited[0].reason === "content" && diff.edited[0].from === "aaaa1111" && diff.edited[0].to === "bbbb3333" && diff.counts.version === 0,
		JSON.stringify(diff.counts) + " " + JSON.stringify(diff.edited),
	);
}

/* ── H17 升级迁移：旧快照没有 content 字段，不能把"开始记哈希"当编辑 ──
   ★ 否则 R19 第一次重建会把 58 个技能全报成「被编辑」，用户以为谁改了所有技能。 */
{
	const prev = snapshotOf(catalogOf({ gammaHash: "aaaa11112222" }), null, AT);
	delete prev.entries["skill:gamma"].content; /* 复刻 v1 历史文件的形状 */
	const next = snapshotOf(catalogOf({ gammaHash: "cccc55556666" }), null, AT);
	const diff = diffSnapshots(prev, next);
	ok("H17 旧快照没有正文哈希 → 升级不算编辑（total=0，全部计入没动）", diff.counts.total === 0 && diff.counts.edited === 0 && diff.unchanged === 3, JSON.stringify(diff.counts));
}

/* ── H18 正文与描述同时变 → 只报一行（内容哈希已包含描述，别报成两处） ── */
{
	const prev = snapshotOf(catalogOf({ gammaHash: "aaaa11112222", gammaDescribed: true }), null, AT);
	const next = snapshotOf(catalogOf({ gammaHash: "bbbb33334444", gammaDescribed: false }), null, AT);
	const diff = diffSnapshots(prev, next);
	ok("H18 正文 + 描述同时变 → 一行（reason=content）", diff.counts.total === 1 && diff.counts.edited === 1 && diff.edited.length === 1 && diff.edited[0].reason === "content", JSON.stringify(diff.edited));
}

/* ── H19 正文哈希进指纹：同内容稳定、改一字就变 ── */
{
	const a = snapshotOf(catalogOf({ gammaHash: "aaaa11112222" }), null, AT);
	const b = snapshotOf(catalogOf({ gammaHash: "aaaa11112222" }), null, AT + 5000);
	const c = snapshotOf(catalogOf({ gammaHash: "aaaa11112223" }), null, AT);
	ok("H19 指纹随正文变：同内容稳定、改一个字符就变", a.fingerprint === b.fingerprint && a.fingerprint !== c.fingerprint, a.fingerprint + " / " + c.fingerprint);
}

/* ── H20 措辞：正文改动写「正文已改」，不能打出 undefined ── */
{
	const text = describeChange({ name: "gamma", reason: "content", from: "aaaa1111", to: "bbbb3333" }, "edited");
	const descText = describeChange({ name: "gamma", reason: "description", from: "有描述", to: "无描述" }, "edited");
	ok("H20 正文改动措辞带「正文已改」与短哈希，描述改动仍走旧措辞", text.includes("正文已改") && text.includes("aaaa1111") && !/undefined|null/.test(text) && descText.includes("被编辑"), text + " | " + descText);
}

/* ── H21 插件没有"正文"这个概念：改版本只进升版，不进被编辑 ── */
{
	const prev = snapshotOf(catalogOf(), null, AT);
	const next = snapshotOf(catalogOf({ alphaVersion: "1.0.1" }), null, AT);
	const diff = diffSnapshots(prev, next);
	ok("H21 插件改版本只进升版（content 恒空，不参与比较）", diff.counts.version === 1 && diff.counts.edited === 0, JSON.stringify(diff.counts));
}

/* ── H22 compareEntries / sameSignal 同源：单边缺哈希不算变化（与 H17 同一个判据） ── */
{
	const withHash = signalOf({ version: "1", source: "self", loadState: "bundle", kind: "skill", contentHash: "aaaa11112222" });
	const without = signalOf({ version: "1", source: "self", loadState: "bundle", kind: "skill" });
	const compare = compareEntries(without, withHash);
	ok("H22 单边缺哈希 → sameSignal 判一致（diff 里也不会冒出一行）", sameSignal(without, withHash) === true && compare.changed.content === false, JSON.stringify(compare));
}

/* ── H23 「已看过」基线：合法的留着，坏的 / 空的 / 没有时间的当没标记过 ── */
{
	const valid = normalizeAck({ at: AT, snapshot: { at: AT, count: 2, entries: { "plugin:a": {}, "skill:b": {} }, fingerprint: "abcdef123456" } });
	const broken = normalizeAck({ at: AT, snapshot: { entries: "nope" } });
	const empty = normalizeAck({ at: AT, snapshot: { entries: {} } });
	const noAt = normalizeAck({ at: 0, snapshot: { entries: { "plugin:a": {} } } });
	const nothing = normalizeAck(null);
	ok("H23 已看过基线：合法保留、坏 / 空 / 无时间一律当没标记过", Boolean(valid) && valid.at === AT && valid.snapshot.count === 2 && broken === null && empty === null && noAt === null && nothing === null, JSON.stringify({ valid: valid && valid.snapshot.count, broken, empty, noAt, nothing }));
}

/* ── H24 时间线：只有基线（一条快照）时不产出窗口 ── */
{
	const base = snapshotOf(catalogOf({}), null, AT);
	ok("H24 时间线：只有基线 → 0 个窗口（不能把 133 条写成新增）", timelineOf([base]).length === 0);
}

/* ── H25 时间线：相邻快照相减，新的在前 ── */
{
	const base = snapshotOf(catalogOf({ gammaHash: "aaaa11112222" }), null, AT);
	const edited = snapshotOf(catalogOf({ gammaHash: "bbbb11112222" }), null, AT + 1000);
	const bumped = snapshotOf(catalogOf({ alphaVersion: "1.0.1", gammaHash: "bbbb11112222" }), null, AT + 2000);
	const rows = timelineOf([base, edited, bumped]);
	ok(
		"H25 时间线：3 条快照 → 2 个窗口，新的在前（升版 / 被编辑各归各的窗口）",
		rows.length === 2 && rows[0].at === AT + 2000 && rows[0].counts.version === 1 && rows[0].counts.edited === 0 && rows[1].counts.edited === 1 && rows[1].counts.version === 0,
		JSON.stringify(rows.map((row) => ({ at: row.at, counts: row.counts }))),
	);
}

/* ── H26 时间线：名字只带 cap 条，counts 永远是真实数字 ── */
{
	const before = { plugins: [], skills: Array.from({ length: 6 }, (_, index) => ({ id: "skill:s" + index, name: "s" + index, source: "self", hasDescription: true, contentHash: "aaaa0000" + index })) };
	const after = { plugins: [], skills: Array.from({ length: 6 }, (_, index) => ({ id: "skill:s" + index, name: "s" + index, source: "self", hasDescription: true, contentHash: "bbbb0000" + index })) };
	const rows = timelineOf([snapshotOf(before, null, AT), snapshotOf(after, null, AT + 1000)], { cap: 2 });
	ok("H26 时间线：edited 只带 cap 条名字，counts.edited 仍是 6", rows.length === 1 && rows[0].edited.length === 2 && rows[0].counts.edited === 6, JSON.stringify({ names: rows[0]?.edited.length, counts: rows[0]?.counts }));
}

/* ── H27 时间线：指纹相同的相邻快照跳过（手工改文件才会出现） ── */
{
	const base = snapshotOf(catalogOf({ gammaHash: "aaaa11112222" }), null, AT);
	const same = snapshotOf(catalogOf({ gammaHash: "aaaa11112222" }), null, AT + 1000);
	const edited = snapshotOf(catalogOf({ gammaHash: "cccc11112222" }), null, AT + 2000);
	const rows = timelineOf([base, same, edited]);
	ok("H27 时间线：指纹相同的窗口不产出（不会多出一行 0 处变化）", rows.length === 1 && rows[0].counts.edited === 1, JSON.stringify(rows.map((row) => row.counts)));
}

/* ── R23：配置层（声明层）进历史 ── */

/** 合成组合文件：两行条目（parser 只认列 0 的 `- id:` 与 2 空格缩进字段）。 */
const CORDIS_MAIN = ["- id: alpha", "  name: alpha-pkg", "- id: beta", "  name: beta-pkg"].join("\n");
const CORDIS_MAIN_REORDERED = ["- id: beta", "  name: beta-pkg", "- id: alpha", "  name: alpha-pkg"].join("\n");
const CORDIS_OFF = ["- id: alpha", "  name: alpha-pkg", "  disabled: true", "- id: beta", "  name: beta-pkg"].join("\n");
const signature = (text, bundles = ["b-one", "b-two"], file = "cordis.yml") => signatureOf({ files: [{ file, text }], bundles });

/* ── H28 配置层指纹稳定：同一份声明、条目顺序与 bundles 顺序都不影响 ── */
{
	const a = signature(CORDIS_MAIN, ["b-one", "b-two"]);
	const b = signature(CORDIS_MAIN_REORDERED, ["b-two", "b-one"]);
	ok("H28 配置层指纹稳定：条目顺序 / bundles 顺序不影响", a.fingerprint === b.fingerprint && a.counts.entries === 2 && a.counts.bundles === 2 && a.counts.on === 2, a.fingerprint + " / " + b.fingerprint + " " + JSON.stringify(a.counts));
}

/* ── H29 disabled 翻转 → 配置层报 1 处（目录条目一个都没变，v2 会报 0 处） ── */
{
	const before = snapshotOf(catalogOf(), {}, AT, signature(CORDIS_MAIN));
	const after = snapshotOf(catalogOf(), {}, AT + 1, signature(CORDIS_OFF));
	const diff = diffSnapshots(before, after);
	const row = diff.compositionChanged[0] || {};
	ok(
		"H29 改 disabled → 配置层 1 处（目录条目没变、total 不能是 0）",
		diff.counts.total === 1 && diff.counts.composition === 1 && diff.added.length === 0 && diff.removed.length === 0 && diff.unchanged === 3 && (row.changed || []).some((item) => item.field === "off" && item.from === 0 && item.to === 1),
		JSON.stringify({ counts: diff.counts, changed: row.changed }),
	);
}

/* ── H30 单边缺composition → 不判变化（R19 迁移规则同型：升级后第一次重建不能报警） ── */
{
	const old = snapshotOf(catalogOf(), {}, AT);
	const next = snapshotOf(catalogOf(), {}, AT + 1, signature(CORDIS_MAIN));
	const forward = diffSnapshots(old, next);
	const backward = diffSnapshots(next, old);
	ok(
		"H30 单边缺配置层签名 → 不算变化（两个方向都是 0 处）",
		forward.counts.total === 0 && forward.counts.composition === 0 && backward.counts.total === 0 && backward.counts.composition === 0 && forward.unchanged === 3,
		JSON.stringify({ forward: forward.counts, backward: backward.counts }),
	);
}

/* ── H31 bundles 增删也进指纹与计数（只加一个 bundle 就该看见） ── */
{
	const before = signature(CORDIS_MAIN, ["b-one"]);
	const after = signature(CORDIS_MAIN, ["b-one", "b-two"]);
	const diff = diffSnapshots(snapshotOf(catalogOf(), {}, AT, before), snapshotOf(catalogOf(), {}, AT + 1, after));
	ok("H31 加一个 bundle → 指纹变、报「bundles 1 → 2」", before.fingerprint !== after.fingerprint && diff.counts.composition === 1 && describeChange(diff.compositionChanged[0], "composition").includes("bundles 1 → 2"), describeChange(diff.compositionChanged[0], "composition"));
}

/* ── H32 配置层签名折进快照指纹（否则 recordSnapshot 认为没变、根本不追加） ── */
{
	const plain = snapshotOf(catalogOf(), {}, AT);
	const withComposition = snapshotOf(catalogOf(), {}, AT, signature(CORDIS_MAIN));
	ok("H32 快照指纹包含配置层签名（只改声明也会追加一条）", plain.fingerprint !== withComposition.fingerprint && plain.fingerprint === fingerprintOf(plain) && withComposition.fingerprint === fingerprintOf(withComposition), plain.fingerprint + " / " + withComposition.fingerprint);
}

/* ── R25：配置层下钻（到底哪个 id 从开变关 / 哪个 bundle 被加减） ── */

/* H33：签名里带 decls（按 id 排序）+ bundles（排序）；指纹与计数不受影响 */
{
	const sig = signature(CORDIS_MAIN);
	ok(
		"H33 签名带 decls（id 排序 / kind 三态）与 bundles（排序）",
		Array.isArray(sig.decls) &&
			sig.decls.length === 2 &&
			sig.decls[0].id === "alpha" &&
			sig.decls[1].id === "beta" &&
			sig.decls.every((row) => row.kind === "on") &&
			JSON.stringify(sig.bundles) === JSON.stringify(["b-one", "b-two"]),
		JSON.stringify({ decls: sig.decls, bundles: sig.bundles }),
	);
}

/* H34：disabled 翻转 → stateChanged 点名到 id；describeChange 写「谁 启用→关掉」 */
{
	const before = signature(CORDIS_MAIN);
	const after = signature(CORDIS_OFF);
	const diff = diffSnapshots(snapshotOf(catalogOf(), {}, AT, before), snapshotOf(catalogOf(), {}, AT + 1, after));
	const row = diff.compositionChanged[0] || {};
	const text = describeChange(row, "composition");
	ok(
		"H34 下钻：disabled 翻转点名到 id（alpha 启用→关掉）",
		diff.counts.composition === 1 &&
			Array.isArray(row.stateChanged) &&
			row.stateChanged.length === 1 &&
			row.stateChanged[0].id === "alpha" &&
			row.stateChanged[0].from === "on" &&
			row.stateChanged[0].to === "off" &&
			text.includes("alpha-pkg 启用→关掉"),
		text,
	);
}

/* H35：bundles 增删 → bundlesAdded 点名；报告/面板同一份明细 */
{
	const before = signature(CORDIS_MAIN, ["b-one"]);
	const after = signature(CORDIS_MAIN, ["b-one", "b-two"]);
	const diff = diffSnapshots(snapshotOf(catalogOf(), {}, AT, before), snapshotOf(catalogOf(), {}, AT + 1, after));
	const row = diff.compositionChanged[0] || {};
	ok(
		"H35 下钻：加的 bundle 点名（bundles +b-two）",
		JSON.stringify(row.bundlesAdded) === JSON.stringify(["b-two"]) && Array.isArray(row.stateChanged) && row.stateChanged.length === 0 && describeChange(row, "composition").includes("bundles +b-two"),
		JSON.stringify({ added: row.bundlesAdded, text: describeChange(row, "composition") }),
	);
}

/* H36：旧快照没有 decls → 单边缺不判明细（不能把 50 个 bundle 全报成新加的） */
{
	const old = compositionSignalOf({ fingerprint: "aaaaaaaaaaaa", counts: { entries: 2, on: 2, bundles: 1, files: 1 } });
	const next = compositionSignalOf(signature(CORDIS_MAIN, ["b-one", "b-two"]));
	const cmp = compareComposition({ composition: old }, { composition: next });
	ok(
		"H36 旧快照缺 decls/bundles → 只报计数差，不伪造明细",
		old.decls === undefined && old.bundles === undefined && Boolean(cmp) && cmp.hasDetail === false && cmp.bundlesAdded.length === 0 && cmp.stateChanged.length === 0,
		JSON.stringify({ hasDetail: cmp?.hasDetail, added: cmp?.bundlesAdded, changed: cmp?.changed }),
	);
}

/* H37：明细最多 4 条，多的写「…等 N 条」 */
{
	const item = { stateChanged: Array.from({ length: 6 }, (_, index) => ({ id: "x" + index, name: "x" + index, from: "on", to: "off" })) };
	const text = compositionDetailText(item, 4);
	ok("H37 明细截断到 4 条 + 「…等 N 条」", text.length === 5 && text[4].includes("等 2 条"), JSON.stringify(text));
}

/* ───────────────── R34：v4 紧凑编码（判据不动，只换存盘的形态） ─────────────────
   ★ 这一组是**体积治理的自证**：编码必须是**无损**的（否则历史会悄悄丢字段），
     推不出来的 name / kind 必须进旁表（否则界面上的名字会变成空或变成 id），
     旧格式必须还能读（否则升级一次历史就全丢），并且真的要**瘦下来**（否则改了白改）。 */

/* H38：无损往返 —— 展开(紧凑(x)) 与原快照逐字段相等（含 fingerprint 与 composition） */
{
	const original = snapshotOf(catalogOf(), {}, AT, signature(CORDIS_MAIN, ["b-one"]));
	const round = expandSnapshot(compactSnapshot(original));
	ok(
		"H38 v4 编码无损：紧凑→展开 与原快照等价",
		round.at === original.at &&
			round.count === original.count &&
			round.fingerprint === original.fingerprint &&
			JSON.stringify(round.entries) === JSON.stringify(original.entries) &&
			JSON.stringify(round.composition) === JSON.stringify(original.composition),
		JSON.stringify({ a: Object.keys(original.entries).length, b: Object.keys(round.entries).length }),
	);
}

/* H39：name / kind 由 id 推导（插件 plugin:<pkg>、Skill skill:<name>），正常条目**不写旁表** */
{
	const compact = compactSnapshot(snapshotOf(catalogOf(), {}, AT));
	const expanded = expandSnapshot(compact);
	ok(
		"H39 v4：name/kind 由 id 推导，正常条目不带 n/k 旁表",
		Array.isArray(compact.e["plugin:alpha"]) &&
			compact.e["plugin:alpha"][0] === "1.0.0" &&
			compact.n === undefined &&
			compact.k === undefined &&
			expanded.entries["plugin:alpha"].name === "alpha" &&
			expanded.entries["plugin:alpha"].kind === "plugin" &&
			expanded.entries["skill:gamma"].kind === "skill",
		JSON.stringify({ row: compact.e["plugin:alpha"], n: compact.n, k: compact.k }),
	);
}

/* H40：推不出来时必须进旁表 —— 名字与 id 后缀不同 / kind 与前缀不符 / 脏 id（无前缀） */
{
	const snapshot = {
		at: AT,
		count: 3,
		entries: {
			"plugin:alias-dir": { name: "real-package", kind: "plugin", version: "1.0.0", source: "self", loadState: "bundle", description: 0, content: "" },
			"plugin:weird": { name: "weird", kind: "skill", version: "", source: "third", loadState: "dormant", description: 1, content: "abc123" },
			"noprefix": { name: "裸 id", kind: "plugin", version: "", source: "pending", loadState: "", description: 0, content: "" },
		},
		fingerprint: "abcdefabcdef",
	};
	const compact = compactSnapshot(snapshot);
	const round = expandSnapshot(compact);
	ok(
		"H40 v4：推不出来的 name/kind 进旁表，展开后一字不差",
		compact.n?.["plugin:alias-dir"] === "real-package" &&
			compact.k?.["plugin:weird"] === "skill" &&
			compact.n?.["noprefix"] === "裸 id" &&
			round.entries["plugin:alias-dir"].name === "real-package" &&
			round.entries["plugin:weird"].kind === "skill" &&
			round.entries["noprefix"].name === "裸 id" &&
			round.entries["noprefix"].description === 0,
		JSON.stringify({ n: compact.n, k: compact.k }),
	);
}

/* H41：旧格式（v1–v3 对象形态）仍能读 —— 升级不能让老历史失效 */
{
	const legacy = { at: AT, count: 1, fingerprint: "123456789012", entries: { "plugin:alpha": { name: "alpha", kind: "plugin", version: "0.9.0", source: "self", loadState: "bundle", description: 0, content: "" } } };
	const viaNormalize = normalizeHistory({ version: 3, snapshots: [legacy] });
	const viaExpand = expandSnapshot(legacy);
	ok(
		"H41 旧格式（对象形态）仍能读，且缺 name/kind 时按 id 补",
		viaNormalize.snapshots.length === 1 && viaNormalize.snapshots[0].entries["plugin:alpha"].version === "0.9.0" && viaExpand.entries["plugin:alpha"].name === "alpha" && HISTORY_VERSION === 5,
		JSON.stringify({ version: HISTORY_VERSION, kept: viaNormalize.snapshots.length }),
	);
}

/* H42：混装文件（老对象 + 新紧凑）同时可读；坏条目只丢自己，不抛 */
{
	const legacy = { at: AT - 1000, count: 1, fingerprint: "111111111111", entries: { "plugin:alpha": { name: "alpha", kind: "plugin", version: "1.0.0", source: "self", loadState: "bundle", description: 0, content: "" } } };
	const compact = compactSnapshot(snapshotOf(catalogOf(), {}, AT));
	const normalized = normalizeHistory({ version: 4, snapshots: [legacy, compact, { at: "坏" }, null] });
	ok(
		"H42 老对象 + 新紧凑混装可读；坏条目只丢自己（不抛）",
		normalized.snapshots.length === 2 && normalized.snapshots[0].at === AT - 1000 && normalized.snapshots[1].entries["skill:gamma"].kind === "skill",
		JSON.stringify(normalized.snapshots.map((row) => row.at)),
	);
}

/* H43：**真的瘦了** —— 116 条 × 20 条快照必须落进 240 KB 预算（本机实测 983 KB → 目标 < 240 KB） */
{
	const plugins = Array.from({ length: 100 }, (_, index) => ({ id: "plugin:pkg-" + index, name: "pkg-" + index, source: "third", version: "0.1." + (index % 9), loadState: index % 3 === 0 ? "dormant" : "transitive" }));
	const skills = Array.from({ length: 16 }, (_, index) => ({ id: "skill:sk-" + index, name: "sk-" + index, source: "self", hasDescription: true, contentHash: "0123456789ab" }));
	const snapshots = Array.from({ length: 20 }, (_, index) => snapshotOf({ plugins, skills }, {}, AT + index * 1000, signature(CORDIS_MAIN, ["b-one"])));
	const file = serializeHistory(snapshots);
	const bytes = Buffer.byteLength(JSON.stringify(file), "utf8");
	const legacyBytes = Buffer.byteLength(JSON.stringify({ version: 3, snapshots }), "utf8");
	ok(
		"H43 v4 真的更小：116 条 × 20 快照 < 240 KB，且比旧对象形态小一半以上",
		bytes < 240 * 1024 && bytes * 2 < legacyBytes,
		JSON.stringify({ compact: bytes, legacy: legacyBytes, ratio: Math.round((bytes / legacyBytes) * 100) + "%" }),
	);
}

/* H44：serializeHistory 自己就会裁剪 —— service 不许自己拼文件对象，也就不会漏掉这一层 */
{
	const snapshots = Array.from({ length: 30 }, (_, index) => snapshotOf(catalogOf(), {}, AT + index * 1000));
	const file = serializeHistory(snapshots);
	const round = normalizeHistory(file);
	ok(
		"H44 serializeHistory 自带裁剪（30 → 20）且都是紧凑形态",
		file.snapshots.length === 20 && round.snapshots.length === 20 && file.snapshots.every((row) => row.e && !row.entries) && round.snapshots.every((row) => row.entries && row.fingerprint !== undefined),
		JSON.stringify({ file: file.snapshots.length, expanded: round.snapshots.length }),
	);
}


/* H45：声明明细按龄淘汰 —— 只有最近 DECLS_KEEP 条带 decls/bundles，更早的只留指纹与计数；
   「关掉 25 → 24」这类结论（counts）一条都不许丢 */
{
	const snapshots = Array.from({ length: 8 }, (_, index) => snapshotOf(catalogOf(), {}, AT + index * 1000, signature(CORDIS_MAIN, ["b-one"])));
	const file = serializeHistory(snapshots, 20, 3);
	const rows = file.snapshots;
	const withDetail = rows.filter((row) => row.composition && Array.isArray(row.composition.decls));
	const withCounts = rows.filter((row) => row.composition && row.composition.counts);
	ok(
		"H45 声明明细只留最近 3 条（更早只留计数），指纹与 counts 一条不丢",
		withDetail.length === 3 &&
			withCounts.length === 8 &&
			rows.every((row) => typeof row.fp === "string" && row.fp.length === 12) &&
			rows.slice(0, 5).every((row) => row.composition.bundles === undefined) &&
			rows.slice(5).every((row) => Array.isArray(row.composition.decls) && Array.isArray(row.composition.bundles)),
		JSON.stringify({ detail: withDetail.length, counts: withCounts.length, total: rows.length }),
	);
}

/* H46：丢掉明细后**下钻优雅降级** —— 单边缺 decls 时只报计数差，不伪造条目 */
{
	const older = compositionSignalOf(signature(CORDIS_MAIN, ["b-one"]));
	delete older.decls;
	delete older.bundles;
	const newer = compositionSignalOf(signature(CORDIS_OFF, ["b-one", "b-two"]));
	const cmp = compareComposition({ composition: older }, { composition: newer });
	ok(
		"H46 更早的快照没有明细时，只报计数差（hasDetail=false，不假装「246 条新增」）",
		Boolean(cmp) && cmp.hasDetail === false && cmp.declsAdded.length === 0 && cmp.bundlesAdded.length === 0 && cmp.changed.length > 0,
		JSON.stringify({ hasDetail: cmp?.hasDetail, changed: cmp?.changed }),
	);
}


const failed = results.filter((item) => !item.pass);
if (process.argv.includes("--json")) {
	console.log(JSON.stringify({ passed: results.length - failed.length, failed: failed.length, results }, null, 1));
} else {
	for (const item of results) console.log(`${item.pass ? "  ok" : "  FAIL"}  ${item.name}${item.pass || !item.detail ? "" : "  [" + item.detail + "]"}`);
	console.log(`\nprobe-history: passed ${results.length - failed.length} / failed ${failed.length}`);
}
if (failed.length > 0) process.exit(1);
