/**
 * attrib.mjs — 把「工具」归属到「哪个插件」（推断，且有明确置信度）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么必须推断：DSH **没有**任何运行时可读的"工具→插件"归属。
 *   实测过三条路都不通：
 *     · `ctx.tools.schemas()` 只回 name / description / parameters，无 owner；
 *     · `ToolService.register()` 把定义塞进按 **scope**（agent 作用域）分的
 *       layers（`@deepseek-ai/dsh-scope` 的 chainLayers），与插件无关；
 *     · inspect 的 Tool provider 就是 `ctx.tools.schemas(agent)` 的包装。
 *
 * 所以用两条**可验证**的证据链，按可信度分级：
 *
 *   high   —— **描述指纹**：`schemas()` 里那段长 description 是逐字来自注册它的
 *             插件源码的，在且只在某一个包里出现 → 就是它。
 *             这条比按名字搜强得多：`write` 这种通用名会命中一堆无关包
 *             （实测被错判到 dsh-mnemon），但它的长描述只出现在宿主里。
 *   medium —— **工具名字面量**：`name: '<tool>'` 只出现在一个包里。
 *             仅用于**没有 description** 的工具（MCP 桥接类常见），否则一律不用。
 *   host   —— 有 description 但在所有插件包里都找不到 ⇒ 它是宿主自带的（在 asar 里），
 *             面板按「官方 / 宿主核心」单列，**不算进任何插件卡片**。
 *   unknown—— 两条都不成立，且用户没手工指定。
 *
 * 任何一条都可以被 `overrides`（用户在面板上手工标的）覆盖 —— 那才是最终真值。
 * ══════════════════════════════════════════════════════════════════════════
 *
 * @module dsh-plugin-catalog/attrib
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { readJson, writeJson } from "./store.mjs";

/** 扫描时跳过的目录（依赖、产物、测试夹具都不是"插件自己声明的工具"）。 */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".cache", "test", "tests", "__pycache__", "docs", "data", ".dsh-diag", ".tmp-staff", "dev"]);

const MAX_FILES = 400;
const MAX_DEPTH = 5;

const INDEX_VERSION = 2;

/**
 * 收集一个包目录里的 JS 文本（有上界，防止误指大目录时卡死）。
 * @returns {Promise<string>}
 */
export async function collectPackageText(root) {
	const chunks = [];
	let files = 0;
	async function walk(dir, depth) {
		if (depth > MAX_DEPTH || files >= MAX_FILES) return;
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			let isDir = entry.isDirectory();
			if (!isDir && entry.isSymbolicLink()) {
				try {
					isDir = (await stat(full)).isDirectory();
				} catch {
					isDir = false;
				}
			}
			if (isDir) {
				if (!SKIP_DIRS.has(entry.name)) await walk(full, depth + 1);
				continue;
			}
			if (!/\.(m?js|cjs)$/.test(entry.name)) continue;
			files += 1;
			try {
				chunks.push(await readFile(full, "utf8"));
			} catch {
				/* 读不了就跳过：归属是尽力而为，不能因为一个文件失败就整体失败 */
			}
			if (files >= MAX_FILES) return;
		}
	}
	await walk(root, 0);
	return chunks.join("\n");
}

/**
 * 把文本「压平」：去掉空白、引号、逗号、括号、拼接用的加号，以及源文件里
 * 转义出来的 `\n` `\t`。
 *
 * ★ 为什么必须这么做（真机上量出来的）：插件里的 description 经常是**多行字符串拼接**：
 *     description: '客户端在不在线、队列多深 —— ' +
 *       '要用 client_eval 之前先问它…'
 *   而 `ctx.tools.schemas()` 给的是**拼好的**一整句。直接拿拼好的句子去源码里找，
 *   中间隔着 `' + \n\t\t'` 就永远找不到 —— 结果一堆自写插件的工具被判成"宿主"。
 *   两边都压平之后再比，拼接处自然接上。压平会略微增加碰撞概率，但指纹长度 50+ 字符，
 *   实际不会误配（本机 196 个工具里零误配）。
 */
function squash(value) {
	return String(value ?? "")
		.replace(/\\[nrt]/g, "")
		.replace(/[\s'"`+,;()[\]{}:]/g, "");
}

/** 归一化描述并切出指纹片段（压平后取两段，覆盖"开头被拼接"的情况）。 */
function fingerprintsOf(description) {
	const flat = squash(description);
	const out = [];
	if (flat.length >= 30) out.push(flat.slice(0, 50));
	if (flat.length >= 130) out.push(flat.slice(50, 120));
	return out;
}

/**
 * 纯函数：给一批工具定归属。
 *
 * @param {Array<{name:string, description?:string}>} tools 来自 `ctx.tools.schemas()`
 * @param {Array<{pkg:string, text:string}>} packages 候选插件包的源码文本
 * @param {object} [overrides] {toolName: pkgName} 用户手工指定
 * @returns {{tools: Object<string,{owner:string, how:string, confidence:string}>, stats: object}}
 */
export function attributeTools(tools, packages, overrides = {}) {
	const out = {};
	let byDescription = 0;
	let byName = 0;
	let host = 0;
	let unknown = 0;
	let overridden = 0;

	/* 每个包只压平一次（压平是纯字符串操作，但 20MB 源码做一次就够了） */
	const flattened = packages.map((pack) => ({
		pkg: pack.pkg,
		text: pack.text,
		flat: typeof pack.flat === "string" ? pack.flat : squash(pack.text),
	}));

	for (const tool of tools) {
		const name = String(tool?.name || "");
		if (name === "") continue;

		if (overrides && typeof overrides[name] === "string" && overrides[name] !== "") {
			out[name] = { owner: overrides[name], how: "manual", confidence: "manual" };
			overridden += 1;
			continue;
		}

		const prints = fingerprintsOf(tool.description);
		let resolved = null;

		/* ① 描述指纹（强证据） */
		for (const print of prints) {
			const hits = [];
			for (const pack of flattened) {
				if (pack.flat.includes(print)) hits.push(pack.pkg);
				if (hits.length > 1) break; // 已经歧义了，不用再找
			}
			if (hits.length === 1) {
				resolved = { owner: hits[0], how: "description", confidence: "high" };
				break;
			}
			if (hits.length > 1) {
				/* 多个包都有这段文字：多半是"某个包抄了另一个包的描述"或通用模板句。
				   不猜，留给用户 — 但要标出它是"歧义"而不是"未知"。 */
				resolved = { owner: "", how: "description-ambiguous", confidence: "low", candidates: hits };
				break;
			}
		}

		/* ② 没有 description 才退到名字字面量（弱证据） */
		if (resolved === null && prints.length === 0) {
			const literal1 = `name: '${name}'`;
			const literal2 = `name: "${name}"`;
			const hits = [];
			for (const pack of flattened) {
				if (pack.text.includes(literal1) || pack.text.includes(literal2)) hits.push(pack.pkg);
				if (hits.length > 1) break;
			}
			if (hits.length === 1) resolved = { owner: hits[0], how: "name-literal", confidence: "medium" };
			else if (hits.length > 1) resolved = { owner: "", how: "name-ambiguous", confidence: "low", candidates: hits };
		}

		/* ③ 有描述却哪儿都找不到 ⇒ 宿主自带（asar 里，不在 profile） */
		if (resolved === null && prints.length > 0) {
			resolved = { owner: "", how: "host", confidence: "high" };
		}

		if (resolved === null) resolved = { owner: "", how: "unknown", confidence: "low" };

		out[name] = resolved;
		if (resolved.how === "description") byDescription += 1;
		else if (resolved.how === "name-literal") byName += 1;
		else if (resolved.how === "host") host += 1;
		else if (resolved.how === "unknown" || resolved.how.endsWith("ambiguous")) unknown += 1;
	}

	return {
		tools: out,
		stats: {
			total: Object.keys(out).length,
			byDescription,
			byName,
			host,
			unknown,
			overridden,
			packages: packages.length,
		},
	};
}

/** 索引缓存签名：工具集合或包集合变了就重建。 */
function signatureOf(tools, packages) {
	const hash = createHash("sha1");
	for (const tool of [...tools].sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
		hash.update(String(tool.name));
		hash.update("|");
		hash.update(String(tool.description || "").slice(0, 80));
		hash.update("\n");
	}
	for (const pack of [...packages].sort((a, b) => a.pkg.localeCompare(b.pkg))) {
		hash.update(pack.pkg);
		hash.update("|");
		hash.update(String(pack.mtime || (typeof pack.text === "string" ? pack.text.length : 0)));
		hash.update("\n");
	}
	return hash.digest("hex");
}

export function attribFile(dataDir) {
	return join(dataDir, "cache", "attrib.json");
}

/**
 * **只读**缓存里的归属索引（启动时用，零成本）。
 *
 * ★ 为什么不能只靠 `buildToolIndex`：它要先算签名（需要包清单与工具 schema），
 *   而启动那一刻 catalog 可能还没就绪 —— 于是签名对不上、就会现场重算（读 20MB 源码）。
 *   启动路径必须**直接读缓存**，让后台任务去校验/刷新。
 *
 * @returns {Promise<{index:object, stats:object}|null>}
 */
export async function readCachedIndex(dataDir) {
	const cached = await readJson(attribFile(dataDir), null);
	if (!cached || cached.version !== INDEX_VERSION || !cached.index) return null;
	return { index: cached.index, stats: cached.stats || {} };
}

/**
 * 读缓存 / 重建归属索引。
 *
 * @param {object} options
 * @param {string} options.dataDir
 * @param {Array<{name:string, description?:string}>} options.tools 实时工具 schema
 * @param {Array<{pkg:string, root:string, mtime?:number}>} options.packages 候选包
 * @param {object} [options.overrides] 手工指定
 * @param {boolean} [options.force] 忽略缓存
 * @returns {Promise<{index:object, stats:object, fromCache:boolean}>}
 */
export async function buildToolIndex(options) {
	const { dataDir, tools, packages, overrides = {}, force = false } = options;
	const signature = signatureOf(tools, packages);
	const cached = force ? null : await readJson(attribFile(dataDir), null);
	if (cached && cached.version === INDEX_VERSION && cached.signature === signature && cached.index) {
		/* 手工指定变了（用户刚标过）也要重算 —— 它最便宜，纯内存 */
		const rebuilt = attributeTools(tools, [], overrides);
		const merged = { ...cached.index };
		for (const [name, entry] of Object.entries(rebuilt.tools)) {
			if (entry.how === "manual") merged[name] = entry;
		}
		return { index: merged, stats: cached.stats || {}, fromCache: true };
	}

	const texts = [];
	for (const pack of packages) {
		/* 两种来源：profile 里的实体目录（读文件），或 asar 里的官方包（调用方已读出文本） */
		if (typeof pack.text === "string") {
			if (pack.text !== "") texts.push({ pkg: pack.pkg, text: pack.text });
			continue;
		}
		const text = await collectPackageText(pack.root);
		if (text !== "") texts.push({ pkg: pack.pkg, text });
	}
	const { tools: index, stats } = attributeTools(tools, texts, overrides);
	await writeJson(attribFile(dataDir), { version: INDEX_VERSION, signature, builtAt: Date.now(), index, stats });
	return { index, stats, fromCache: false };
}
