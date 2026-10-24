/**
 * probe-tags.mjs — 批量打标的独立探针（R15）。
 *
 * 为什么单独一个探针：`applyTagOps` 里全是**容易写反但不会报错**的判断 ——
 * 幂等、只加不减、维度校验、把标签全去掉时删记录而不是写空记录。
 * 这些错了以后，面板照样能开、标签照样显示，只是会悄悄把别人手标的标签清掉，
 * 或者让条目从此再也不被 AI 分类。静态契约看不出来，只能在真 store 上跑一遍。
 *
 * 用法：`node dev/probe-tags.mjs [--json]`；破任一不变式退出码 1。
 * 全程**不碰真数据**：store 是内存里的空壳，不读也不写 tags.json。
 */

import { applyTagOps, BUILTIN_TAGS, listTags, setEntryTags, tagsOfEntry } from "../lib/tags.mjs";

const results = [];
function ok(name, condition, detail = "") {
	results.push({ name, pass: Boolean(condition), detail });
}

function emptyStore() {
	return { version: 2, custom: [], assignments: {}, updatedAt: 0 };
}

function purposeOf(store, id) {
	return [...(tagsOfEntry(store, { id, source: "third" }).purpose || [])].sort();
}
function contextOf(store, id) {
	return [...(tagsOfEntry(store, { id, source: "third" }).context || [])].sort();
}

const A = "plugin:a";
const B = "skill:b";

/* ── T1 幂等：同一组「加上」连跑两次，第二次没有任何变化 ── */
{
	const store = emptyStore();
	const ops = [{ dimension: "purpose", tagId: "ui", op: "add" }];
	const first = applyTagOps(store, [A, B], ops, "user");
	const second = applyTagOps(store, [A, B], ops, "user");
	ok("T1 批量打标幂等（连跑两次，第二次 changed=0）", first.changed === 2 && second.changed === 0 && second.unchanged === 2, `first=${first.changed} second=${second.changed}`);
}

/* ── T2 只加不减：A 原有的别的标签在批量「加上」后必须还在 ──
   ★ 这是与 setEntryTags（整条替换）最关键的区别，也是这一轮最容易写错的地方。 */
{
	const store = emptyStore();
	setEntryTags(store, A, { purpose: ["docs", "data"], context: ["host"] }, "user");
	setEntryTags(store, B, { purpose: ["ops"], context: [] }, "user");
	applyTagOps(store, [A, B], [{ dimension: "purpose", tagId: "ui", op: "add" }], "user");
	ok("T2 批量「加上」不清掉其它标签（A 的 docs/data/host 都还在）", JSON.stringify(purposeOf(store, A)) === JSON.stringify(["data", "docs", "ui"]) && JSON.stringify(contextOf(store, A)) === JSON.stringify(["host"]), `A=${JSON.stringify(purposeOf(store, A))}/${JSON.stringify(contextOf(store, A))}`);
	ok("T2b 批次里另一个条目也只被加上、它的 ops 标签还在", JSON.stringify(purposeOf(store, B)) === JSON.stringify(["ops", "ui"]), JSON.stringify(purposeOf(store, B)));
}

/* ── T3 维度必须对得上，且只认已注册标签 ── */
{
	const store = emptyStore();
	const result = applyTagOps(store, [A], [
		{ dimension: "context", tagId: "ui", op: "add" }, /* ui 是 purpose，维度错了 */
		{ dimension: "purpose", tagId: "not-a-real-tag", op: "add" },
		{ dimension: "purpose", tagId: "media", op: "add" },
	], "user");
	ok("T3 维度不符 / 没注册的标签被拒并报出来", result.unknownTags.includes("ui") && result.unknownTags.includes("not-a-real-tag") && result.applied.length === 1, JSON.stringify(result.unknownTags));
	ok("T3b 合法的那个还是打上了（不能因为一个错标签整批丢弃）", JSON.stringify(purposeOf(store, A)) === JSON.stringify(["media"]) && contextOf(store, A).length === 0, JSON.stringify(purposeOf(store, A)));
}

/* ── T4 去掉是精确的：只去掉指定标签，另一维不受影响 ── */
{
	const store = emptyStore();
	setEntryTags(store, A, { purpose: ["ui", "docs"], context: ["host", "windows"] }, "user");
	applyTagOps(store, [A], [{ dimension: "purpose", tagId: "ui", op: "remove" }], "user");
	ok("T4 去掉某个标签不动同一维的其它标签、也不动另一维", JSON.stringify(purposeOf(store, A)) === JSON.stringify(["docs"]) && JSON.stringify(contextOf(store, A)) === JSON.stringify(["host", "windows"]), `${JSON.stringify(purposeOf(store, A))} / ${JSON.stringify(contextOf(store, A))}`);
}

/* ── T5 把标签全去掉 → 删记录，不写空记录 ──
   ★ 写空记录会让 runClassify 永远跳过这条（它按 by==='user' 保护手标），
     条目从此既没标签也不会再被 AI 分类 —— 「清空」与「禁止自动分类」是两件事。 */
{
	const store = emptyStore();
	setEntryTags(store, A, { purpose: ["ui"], context: [] }, "user");
	applyTagOps(store, [A], [{ dimension: "purpose", tagId: "ui", op: "remove" }], "user");
	ok("T5 标签被清空后分配记录被删除（不是留一条空记录）", store.assignments[A] === undefined, JSON.stringify(store.assignments[A]));
	ok("T5b 该条目之后仍可被 AI 分类命中（assignment 不存在 = 未手标）", (store.assignments[A]?.by ?? "") !== "user", String(store.assignments[A]?.by));
}

/* ── T6 本来就没这个标签时「去掉」不算改动，也不留下记录 ── */
{
	const store = emptyStore();
	const result = applyTagOps(store, [A, B], [{ dimension: "purpose", tagId: "ui", op: "remove" }], "user");
	ok("T6 去掉一个本来就没有的标签：不写记录、changed=0", result.changed === 0 && store.assignments[A] === undefined && store.assignments[B] === undefined, JSON.stringify(result));
}

/* ── T7 空 ops 是安全的空操作（前端一个都没勾时不该动数据） ── */
{
	const store = emptyStore();
	const result = applyTagOps(store, [A], [], "user");
	ok("T7 空操作安全（不改数据、不报错）", result.changed === 0 && Object.keys(store.assignments).length === 0);
}

/* ── T8 内置标签的维度自洽（筛选用的是 dimension，写错的标签永远筛不出来） ── */
{
	const store = emptyStore();
	const all = listTags(store);
	const bad = all.filter((tag) => !["purpose", "context", "origin"].includes(tag.dimension) || typeof tag.label !== "string" || tag.label === "");
	ok(`T8 内置标签维度自洽（${BUILTIN_TAGS.length} 个，无非法 dimension / 空 label）`, bad.length === 0, bad.map((tag) => tag.id).join(","));
}

/* ── T9 批量里重复的条目 id 只算一次（去重后不会把 changed 撑大） ── */
{
	const store = emptyStore();
	const result = applyTagOps(store, [A, A, A], [{ dimension: "purpose", tagId: "ui", op: "add" }], "user");
	ok("T9 重复 id 去重（changed 只算 1 条）", result.changed === 1 && Object.keys(store.assignments).length === 1, `changed=${result.changed} keys=${Object.keys(store.assignments).length}`);
}

const failed = results.filter((item) => !item.pass);
if (process.argv.includes("--json")) {
	console.log(JSON.stringify({ passed: results.length - failed.length, failed: failed.length, results }, null, 1));
} else {
	for (const item of results) console.log(`${item.pass ? "  ok" : "  FAIL"}  ${item.name}${item.pass || !item.detail ? "" : "  [" + item.detail + "]"}`);
	console.log(`\nprobe-tags: passed ${results.length - failed.length} / failed ${failed.length}`);
}
if (failed.length > 0) process.exit(1);
