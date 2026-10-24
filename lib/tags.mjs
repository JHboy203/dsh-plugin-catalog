/**
 * tags.mjs — 标签体系：三个维度 + 自定义标签（带解释）+ 每个条目的标签分配。
 *
 * 三个维度（用户指定的口径）：
 *   purpose  做什么   —— 截图、运维、游戏…
 *   context  用在哪里 —— Web GUI、AstrBot、Minecraft…
 *   origin   怎么来的 —— 官方 / 自写 / 第三方 / 混血
 *
 * 两条硬约束：
 *   1. `origin` **不存**，它由 catalog 的四分类推导（存了就会与事实不一致，
 *      而且用户手工改来源时还得同步两处）。
 *   2. 自定义标签必须带**一句解释**。AI 分类时会把解释原样喂进提示词 ——
 *      否则模型只能看标签名猜，"视频剪辑"和"剪辑"会分出两套。
 *
 * 存盘位置：`<workspace>/.dsh-plugin-catalog/tags.json`（工作区固定位置，
 * 不写插件目录 —— 否则升级即丢）。
 *
 * @module dsh-plugin-catalog/tags
 */

import { join } from "node:path";
import { readJson, writeJson } from "./store.mjs";

export const TAGS_VERSION = 2;

/** 内置标签。`gloss` 同时用于给人看与喂给模型。 */
export const BUILTIN_TAGS = [
	/* ── 做什么 ── */
	{ id: "ui", dimension: "purpose", label: "界面", gloss: "改 Web GUI 的外观/交互：侧边栏、面板、卡片、浮窗、样式、主题。" },
	{ id: "screenshot", dimension: "purpose", label: "截图", gloss: "抓屏、长截图、录屏、标注、OCR、像素级比对。" },
	{ id: "ops", dimension: "purpose", label: "运维", gloss: "机器与服务的体检、清理、启停、端口与进程排查。" },
	{ id: "game", dimension: "purpose", label: "游戏", gloss: "Minecraft 服务端、世界数据、皮肤、模拟玩家等游戏相关处理。" },
	{ id: "media", dimension: "purpose", label: "媒体", gloss: "视频/音频的剪辑、转码、抽帧、字幕、下载。" },
	{ id: "docs", dimension: "purpose", label: "文档", gloss: "Word/Excel/PPT/PDF/Markdown 的生成、读取、转换与导出。" },
	{ id: "data", dimension: "purpose", label: "数据", gloss: "数据库、统计、账本、缓存、清单等结构化数据的读写与分析。" },
	{ id: "net", dimension: "purpose", label: "网络", gloss: "搜索、抓取、请求、远程访问、隧道与网页读取。" },
	{ id: "audit", dimension: "purpose", label: "审计", gloss: "密钥/隐私/依赖/合规类扫描与风险报告。" },
	{ id: "publish", dimension: "purpose", label: "发布", gloss: "打包、建仓、推送、版本与 README 维护。" },
	{ id: "llm", dimension: "purpose", label: "模型", gloss: "模型选型、路由、用量统计、提示词与子代理编排。" },
	{ id: "input", dimension: "purpose", label: "输入", gloss: "键鼠、窗口、剪贴板、输入法与桌面自动化。" },
	{ id: "memory", dimension: "purpose", label: "记忆", gloss: "会话存档、上下文压缩、知识库与文档检索。" },

	/* ── 用在哪里 ── */
	{ id: "web-gui", dimension: "context", label: "Web GUI", gloss: "作用在 DSH 的网页/桌面界面上（客户端插件、面板、槽位）。" },
	{ id: "host", dimension: "context", label: "DSH 宿主", gloss: "宿主半边：注册工具、路由、服务、事件、启动期行为。" },
	{ id: "astrbot", dimension: "context", label: "AstrBot", gloss: "AstrBot 实例、插件、人格、data_v4.db、QQ 机器人链路。" },
	{ id: "minecraft", dimension: "context", label: "Minecraft", gloss: "基岩版/Java 版服务端、世界库、玩家数据、假人。" },
	{ id: "windows", dimension: "context", label: "Windows", gloss: "本机操作系统层：注册表、服务、计划任务、资源管理器、DPI。" },
	{ id: "qq", dimension: "context", label: "QQ", gloss: "QQ 协议端、群消息、NapCat / SnowLuma。" },
	{ id: "github", dimension: "context", label: "GitHub", gloss: "仓库、私有备份、发布、Actions 与安全审核。" },
	{ id: "workspace", dimension: "context", label: "工作区", gloss: "读写本工作区的文件、脚本、素材与报告。" },
	{ id: "remote", dimension: "context", label: "远程", gloss: "跨机器：SSH、RDP、Tailscale、远程桌面取证。" },
	{ id: "browser", dimension: "context", label: "浏览器", gloss: "驱动真实浏览器：打开页面、执行脚本、取图。" },

	/* ── 怎么来的（由四分类推导，标签本身不由用户勾选） ── */
	{ id: "src-official", dimension: "origin", label: "官方", gloss: "DSH 官方随宿主提供或官方作用域安装的插件。" },
	{ id: "src-self", dimension: "origin", label: "自写", gloss: "本地目录 / link 安装 / author 是本人。" },
	{ id: "src-third", dimension: "origin", label: "第三方", gloss: "从 npm 或其它来源安装，非本人维护。" },
	{ id: "src-hybrid", dimension: "origin", label: "混血", gloss: "在官方或第三方基础上由本人改过的。" },
];

export const DIMENSIONS = ["purpose", "context"];
export const ALL_DIMENSIONS = ["purpose", "context", "origin"];

export function tagsFile(dataDir) {
	return join(dataDir, "tags.json");
}

function emptyStore() {
	return { version: TAGS_VERSION, custom: [], assignments: {}, updatedAt: 0 };
}

/**
 * 读标签库。自定义标签与分配都在这里；内置标签不入库（改了代码即生效）。
 */
export async function loadTagsStore(dataDir) {
	const raw = await readJson(tagsFile(dataDir), null);
	if (!raw || raw.version !== TAGS_VERSION) return emptyStore();
	const custom = Array.isArray(raw.custom) ? raw.custom.filter(isValidCustom) : [];
	const assignments = raw.assignments && typeof raw.assignments === "object" ? raw.assignments : {};
	return { version: TAGS_VERSION, custom, assignments, updatedAt: Number(raw.updatedAt) || 0 };
}

function isValidCustom(entry) {
	return entry && typeof entry.id === "string" && entry.id !== "" && DIMENSIONS.includes(entry.dimension) && typeof entry.label === "string" && entry.label !== "";
}

export async function saveTagsStore(dataDir, store) {
	const snapshot = { version: TAGS_VERSION, custom: store.custom, assignments: store.assignments, updatedAt: Date.now() };
	await writeJson(tagsFile(dataDir), snapshot);
	store.updatedAt = snapshot.updatedAt;
	return snapshot;
}

/** 合并内置 + 自定义（同 id 时自定义优先，便于覆盖解释）。 */
export function listTags(store) {
	const map = new Map();
	for (const tag of BUILTIN_TAGS) map.set(tag.id, { ...tag, builtin: true });
	for (const tag of store?.custom ?? []) map.set(tag.id, { ...tag, builtin: false });
	return [...map.values()];
}

/** 某维度的标签。 */
export function tagsOfDimension(store, dimension) {
	return listTags(store).filter((tag) => tag.dimension === dimension);
}

/**
 * 新增自定义标签（要求给解释）。
 * @returns {{ok:boolean, tag?:object, error?:string}}
 */
export function addCustomTag(store, input) {
	const dimension = String(input?.dimension || "purpose");
	const label = String(input?.label || "").trim();
	const gloss = String(input?.gloss || "").trim();
	if (!DIMENSIONS.includes(dimension)) return { ok: false, error: "维度只能是 purpose / context（origin 由四分类推导）" };
	if (label === "") return { ok: false, error: "标签名不能为空" };
	if (gloss === "") return { ok: false, error: "必须给一句解释 —— AI 分类要靠它判断，否则只能瞎猜" };
	if (listTags(store).some((tag) => tag.label === label)) return { ok: false, error: "已有同名标签：" + label };
	const id = "c-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
	const tag = { id, dimension, label, gloss, builtin: false, createdAt: Date.now() };
	store.custom = [...store.custom.filter((x) => x.id !== id), tag];
	return { ok: true, tag };
}

/** 删自定义标签（内置的删不掉）。 */
export function removeCustomTag(store, id) {
	const before = store.custom.length;
	store.custom = store.custom.filter((tag) => tag.id !== id);
	for (const entry of Object.values(store.assignments)) {
		for (const dimension of DIMENSIONS) {
			if (Array.isArray(entry?.[dimension])) entry[dimension] = entry[dimension].filter((x) => x !== id);
		}
	}
	return { ok: store.custom.length !== before };
}

/**
 * 给一个条目设置标签。
 * @param {object} store
 * @param {string} entryId
 * @param {{purpose?:string[], context?:string[]}} tags
 * @param {'user'|'ai'} by
 */
export function setEntryTags(store, entryId, tags, by = "user") {
	const known = new Set(listTags(store).map((tag) => tag.id));
	const clean = {};
	for (const dimension of DIMENSIONS) {
		const list = Array.isArray(tags?.[dimension]) ? tags[dimension] : [];
		/* 只接受已注册的标签：模型偶尔会编标签名，编的不能进库 */
		clean[dimension] = [...new Set(list.map(String).filter((id) => known.has(id)))];
	}
	store.assignments[entryId] = { ...clean, by, at: Date.now() };
	return store.assignments[entryId];
}

/**
 * 批量打标：对多条条目执行一组「加 / 减」操作，**幂等**。
 *
 * ★ 为什么不复用 setEntryTags：两者的语义必须分开。
 *   - `setEntryTags` 是「把这一个条目的标签**替换**成这组」—— 详情浮窗里用（用户看得见当前勾选）；
 *   - `applyTagOps` 是「给这一批条目**加上 / 去掉**这几个标签」—— 批量条里用。
 *   一个批次里的条目原本标签各不相同，用「替换」语义会把别人已有的标签静默清掉。
 *
 * @param {object} store
 * @param {string[]} entryIds
 * @param {Array<{dimension:string, tagId:string, op:'add'|'remove'}>} ops
 * @param {'user'|'ai'} by
 * @returns {{changed:number, unchanged:number, unknownTags:string[], applied:Array}}
 */
export function applyTagOps(store, entryIds, ops, by = "user") {
	const known = new Map(listTags(store).map((tag) => [tag.id, tag]));
	const unknownTags = [];
	const applied = [];
	for (const raw of Array.isArray(ops) ? ops : []) {
		const dimension = String(raw?.dimension || "");
		const tagId = String(raw?.tagId || "");
		if (!DIMENSIONS.includes(dimension)) continue;
		const op = raw?.op === "remove" ? "remove" : "add";
		/* 只接受**维度对得上**的已注册标签：把「界面」当 context 打进去，
		   这条分配以后永远不会被筛出来，比打错标签更难查 */
		const tag = known.get(tagId);
		if (!tag || tag.dimension !== dimension) {
			if (tagId !== "") unknownTags.push(tagId);
			continue;
		}
		applied.push({ dimension, tagId, op });
	}
	if (applied.length === 0) return { changed: 0, unchanged: 0, unknownTags, applied: [] };

	const ids = [...new Set((Array.isArray(entryIds) ? entryIds : []).map(String).filter((id) => id !== ""))];
	let changed = 0;
	for (const entryId of ids) {
		const previous = store.assignments[entryId] ?? null;
		const next = { purpose: [...(previous?.purpose ?? [])], context: [...(previous?.context ?? [])] };
		for (const { dimension, tagId, op } of applied) {
			const list = new Set(next[dimension]);
			if (op === "add") list.add(tagId);
			else list.delete(tagId);
			next[dimension] = [...list];
		}
		if (previous && DIMENSIONS.every((dimension) => sameSet(previous[dimension] ?? [], next[dimension]))) continue;
		/* ★ 一条标签都不剩时**删掉分配记录、而不是写空记录**：
		   写 `{purpose:[],context:[],by:'user'}` 会让 runClassify 永远跳过这条
		   （它按 `by === 'user'` 保护手标），条目从此既没标签也不会再被 AI 分类 —— 
		   「把标签全去掉」与「禁止自动分类」是两件事，不能顺手混成一件。 */
		if (next.purpose.length === 0 && next.context.length === 0) {
			if (previous) {
				delete store.assignments[entryId];
				changed += 1;
			}
			/* 本来就没有分配记录 + 现在也没有 → 什么都没变，不记 */
			continue;
		}
		store.assignments[entryId] = { ...next, by, at: Date.now() };
		changed += 1;
	}
	return { changed, unchanged: ids.length - changed, unknownTags, applied };
}

function sameSet(a, b) {
	if (a.length !== b.length) return false;
	const set = new Set(a);
	return b.every((item) => set.has(item));
}

/** 读一个条目的标签（含 origin 推导值）。 */
export function tagsOfEntry(store, entry) {
	const stored = store?.assignments?.[entry.id] ?? {};
	const originId = { official: "src-official", self: "src-self", third: "src-third", hybrid: "src-hybrid", pending: "src-third" }[entry.source] || "src-third";
	return {
		purpose: Array.isArray(stored.purpose) ? stored.purpose : [],
		context: Array.isArray(stored.context) ? stored.context : [],
		origin: [originId],
		by: stored.by || "",
		at: Number(stored.at) || 0,
	};
}

/**
 * 生成「给模型看的标签清单」。
 *
 * ★ 自定义标签的 `gloss` 必须原样出现 —— 这是用户明确要求的一条：
 *   「AI 自动分类时必须读取并使用自定义标签的解释」。
 */
export function tagPrompt(store) {
	const lines = [];
	for (const dimension of DIMENSIONS) {
		const title = dimension === "purpose" ? "做什么" : "用在哪里";
		lines.push(`【${title}】（只能从中选，可多选，最多 3 个）`);
		for (const tag of tagsOfDimension(store, dimension)) {
			lines.push(`- ${tag.id}｜${tag.label}：${tag.gloss || "（无解释）"}${tag.builtin ? "" : "  ← 用户自定义"}`);
		}
	}
	return lines.join("\n");
}
