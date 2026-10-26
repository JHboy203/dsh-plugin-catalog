/**
 * composition.mjs — **配置层**（`cordis.yml` / `cordis.patch.yml`）的「声明层」健康。
 *
 * ★ 为什么要有它（R22 的真实动因）：
 *   面板此前对配置层的全部说法就是 `catalogMeta.errors` 里的一行，以及 health 里
 *   「配置挂载 0」。可这台机器的真相是：**两份组合文件里有 260+ 条顶层条目**，
 *   它们按 `name:` 挂起整个宿主；其中 1 条按 `file://` 路径挂载、1 条是 `cordis:group`、
 *   9 条用 `!!js` 表达式条件启用、25 条 `disabled: true`。
 *   这些事实**一条都没进过界面**，于是：
 *     · 「配置挂载 0」被当成"这台机器没有配置入口"，其实是**判据只看得见已装的包**；
 *     · `bundles` 里 7 个官方包在 node_modules 里没有（在 asar 里），与"真的缺"混在一行 errors；
 *     · `disabled: true` 的 25 条（含 20 个 tool 插件）到底是"关掉了"还是"被某个 bundle 的
 *       patch 层重新打开"，界面无法区分 —— 而这正是"不敢动配置"的来源。
 *
 * ★ 这一层的判据（**全部是声明，不求值**）：
 *   1. 顶层条目：列 0 的 `- id:` / `- name:`，以及它下面**恰好 2 空格缩进**的键；
 *      更深缩进是条目自己的 `config:`（本机有 40 多个模型定义，一起收进来会变成"挂了 200 个包"）。
 *   2. 块标量（`name: >-` / `|`）：本机真有一条按 `file://` 挂载的条目写成了折叠标量，
 *      旧解析器把它读成字面量 `>-` —— 于是那条目在统计里成了"名字叫 >- 的包"。
 *   3. `disabled` 的六种写法要分开：`true`（关掉）/ `false` / 空（开）/
 *      `!!js '…'`（**条件**，不求值）/ 其它（未知）。`disabled` 布尔量只有字面量 true 才算关 ——
 *      与 R12 的加载判据保持一致，**不在这里偷偷改判据**。
 *   4. 同一 id 出现在两份文件里 = **patch 覆盖**：后者的 name/disabled 覆盖前者。
 *      （本机 `skill-filesystem` / `llm-pi-ai` / `vision-router` 都是这样。）
 *   5. 解析：包名（含子路径 `pkg/sub` → 取包名）、`file://` 按路径、`cordis:*` 分组、
 *      没有 name 的"按 id 覆盖"。
 *
 * ★ 诚实的边界（写进面板脚注、README 与交接文件）：
 *   · **R33 起会展开 bundle 自带的 patch 层**（rc.3 的唯一入口来源）：`- insert:` 块里的条目
 *     按 bundles 顺序合并，profile 的 `cordis.patch.yml` 最后应用（同 id 后者胜）。
 *     `disabled: true` 仍然是**声明**，不是结论（本机 `tool-bash` 在基线里写着 disabled，
 *     却被某个 bundle 的 patch 重新打开 —— 判据只能看见"哪一层最后写了什么"）。
 *   · `!!js` 表达式**不求值**（那是任意 JS）：只给原文。
 *   · 按路径挂载只检查"文件在不在"，不 import 它。
 *   · asar 读不到时（纯 node / 探针环境），asar 内的包一律记 `unjudged`，
 *     **绝不当成"真的缺"** —— 这条与 R8 的「量不到就 null + 原因」是同一条纪律。
 *
 * @module dsh-plugin-catalog/composition
 */

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

/** 条目类型白名单（顺序即展示顺序）。 */
export const COMPOSITION_KINDS = Object.freeze(["package", "subpath", "file", "group", "id-only"]);

/** 解析结果白名单。`n/a` = 这一条不是"挂包"，无从判断"包在不在"。 */
export const ENTRY_RESOLUTIONS = Object.freeze(["present", "asar", "missing", "unjudged", "n/a"]);

/** `disabled:` 的三种语义。`expression` = 条件启用（不求值，也不当关掉）。 */
export const DISABLE_KINDS = Object.freeze(["on", "off", "expression"]);

/** 报告格式版本：字段形状变了就 +1（与 catalog / history 同一个纪律）。
 *  R33：+`model` / `layers` / `counts.byRole` —— 配置层从"两份文件"变成"分层"（v1 → 2）。 */
export const COMPOSITION_VERSION = 2;

/** 层角色（顺序即应用顺序：root → bundle 层（按 bundles 顺序）→ profile patch）。
 *  ★ 定义在这里（纯函数模块）而不是 patches.mjs：auditComposition 要用它，
 *    而 patches.mjs 需要读盘 —— 依赖方向只能是 patches → composition。 */
export const LAYER_ROLES = Object.freeze(["root", "bundle-patch", "profile-patch"]);

/** 组合模型：`flat` = 入口表里有条目（rc.2 及以前）；`bundle-layers` = 空入口表 + bundle 自带 patch（rc.3+）。 */
export const COMPOSITION_MODELS = Object.freeze(["flat", "bundle-layers", "empty"]);

/** 块标量头：`>` / `>-` / `|` / `|+` / `|2` 这类。 */
const BLOCK_HEADER = /^[>|][+-]?\d*$/;

function unquote(value) {
	const text = String(value ?? "").trim();
	if (text === "") return "";
	if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) return text.slice(1, -1);
	return text;
}

/** `disabled:` 的原文 → 三种语义之一。未知写法按"条件/未知"处理，绝不猜成 off。 */
export function parseDisabled(raw) {
	const text = unquote(raw);
	if (text === "") return { kind: "on", value: "" };
	if (/^true$/i.test(text)) return { kind: "off", value: text };
	if (/^false$/i.test(text)) return { kind: "on", value: text };
	return { kind: "expression", value: String(raw ?? "").trim() };
}

/**
 * 解析一份 cordis 组合文件。
 *
 * ★ 返回值**向后兼容** R12 的形状：`disabled` 仍是布尔量（只有字面量 true 为真），
 *   `resolveLoadPaths` 不需要改。新增字段都是附加的：
 *   `disabledRaw` / `disabledKind` / `hasName` / `hasDisabled` / `file` / `line`。
 *
 * @param {string|null} text
 * @param {{file?:string}} [options]
 * @returns {Array<{id:string,name:string,disabled:boolean,disabledRaw:string,disabledKind:string,hasName:boolean,hasDisabled:boolean,file:string,line:number}>}
 */
export function parseComposition(text, options = {}) {
	const file = typeof options.file === "string" ? options.file : "";
	const lines = String(text ?? "").split(/\r?\n/);
	const entries = [];
	let cur = null;
	/* 块标量收集：{ entry, key, folded, buffer, headerLine } —— 只对 name 生效（id/disabled 不会是块标量） */
	let block = null;
	const finishBlock = () => {
		if (!block) return;
		const joined = block.folded ? block.buffer.join(" ").replace(/[ \t]{2,}/g, " ") : block.buffer.join("\n");
		const value = joined.replace(/[ \t]+$/g, "").trim();
		applyKey(block.entry, block.key, value);
		block = null;
	};
	const applyKey = (entry, key, rawValue) => {
		if (!entry) return;
		if (key === "id") {
			entry.id = unquote(rawValue);
			return;
		}
		if (key === "name") {
			entry.hasName = true;
			const value = unquote(rawValue);
			if (value !== "" && !entry.name) entry.name = value;
			return;
		}
		if (key === "disabled") {
			const parsed = parseDisabled(rawValue);
			entry.hasDisabled = true;
			entry.disabledRaw = parsed.value;
			entry.disabledKind = parsed.kind;
			entry.disabled = parsed.kind === "off";
		}
	};
	const readFragment = (entry, fragment, keyIndent = 0) => {
		const match = /^(id|name|disabled):\s*(.*)$/.exec(fragment);
		if (!match) return;
		const key = match[1];
		const rawValue = match[2];
		if (key === "name" && BLOCK_HEADER.test(rawValue.trim())) {
			/* ★ R33 修：块标量的续行必须**比键更深**，不是"比 2 空格深"。
			   insert 块里的键在 6 空格，旧判据（indent > 2）会把下一条目的
			   `disabled: true` 吞进 name（真机 exp：name 变 "dsh-beta disabled: true"）。 */
			block = { entry, key, folded: rawValue.trim().startsWith(">"), buffer: [], keyIndent };
			return;
		}
		applyKey(entry, key, rawValue);
	};
	const makeEntry = (line) => ({
		id: "",
		name: "",
		disabled: false,
		disabledRaw: "",
		disabledKind: "on",
		hasName: false,
		hasDisabled: false,
		/* R33：rc.3 的 bundle patch 把条目写在 `- insert:` 块里（缩进 4 空格）。
		   `insert` 只用来分辨「这一条来自哪种块」，判据（name/disabled）与旧形状完全一致。 */
		insert: false,
		file,
		line,
	});
	/* `- insert:` 块：块内条目缩进 = 4，条目属性缩进 = 6，更深是 config 内部（一律不认）。 */
	let insertIndent = 0;
	const itemPattern = (indent) => new RegExp("^\\s{" + indent + "}-\\s+(.*)$");

	for (let index = 0; index < lines.length; index += 1) {
		const raw = lines[index];
		const line = raw.replace(/\s+$/, "");
		if (block) {
			if (line.trim() === "") {
				block.buffer.push("");
				continue;
			}
			const indent = /^\s*/.exec(line)[0].length;
			/* ★ insert 块里下一条目（缩进恰好等于条目缩进）必须结束块标量，
			   否则 `name: >-` 会把后面所有条目都吞进本体（旧解析器没这个场景）。 */
			const nextItem = insertIndent > 0 && indent === insertIndent && /^-\s/.test(line.trim());
			if (indent > (Number(block.keyIndent) || 0) && !nextItem) {
				block.buffer.push(line.trim());
				continue;
			}
			finishBlock();
		}
		if (line.trim() === "") continue;
		/* `- insert:` 块开始（列 0） */
		if (/^-\s+insert:\s*$/.test(line)) {
			insertIndent = 4;
			cur = null;
			continue;
		}
		if (insertIndent > 0 && !/^\S/.test(line)) {
			const item = itemPattern(insertIndent).exec(line);
			if (item) {
				cur = makeEntry(index + 1);
				cur.insert = true;
				entries.push(cur);
				readFragment(cur, item[1].trim(), insertIndent);
				continue;
			}
			/* 条目属性：缩进比条目多 2；更深的 config 内部不认 */
			if (cur && new RegExp("^\\s{" + (insertIndent + 2) + "}\\S").test(line)) {
				readFragment(cur, line.trim(), insertIndent + 2);
			}
			continue;
		}
		/* 列 0 的非条目行 → 退出 insert 块，按旧规则继续 */
		insertIndent = 0;
		/* 顶层条目：`- id: x` 或 `- name: y`（列 0） */
		if (/^-\s/.test(line)) {
			cur = makeEntry(index + 1);
			entries.push(cur);
			readFragment(cur, line.slice(1).trim(), 0);
			continue;
		}
		/* 列 0 的非条目（注释、文档段首）→ 结束当前条目 */
		if (/^\S/.test(line)) {
			cur = null;
			continue;
		}
		if (!cur) continue;
		/* 只收 2 空格缩进；更深是 config 内部 */
		if (!/^\s{2}\S/.test(line)) continue;
		readFragment(cur, line.trim(), 2);
	}
	finishBlock();
	return entries;
}

/**
 * 按 id 合并两份文件的条目（patch 语义：后者覆盖前者的 name / disabled）。
 *
 * ★ 没有 name 的条目（本机 `mnemon-strategy-auto-capture`）是"按 id 覆盖已有条目"，
 *   不是"挂了一个没名字的包" —— 它必须能覆盖到基线里那条，否则这条 patch 就丢了。
 *
 * @param {Array<object>} entries
 * @returns {Array<object>} 生效条目（保持首次出现顺序）
 */
export function mergeCompositionEntries(entries) {
	const list = Array.isArray(entries) ? entries : [];
	const byId = new Map();
	const out = [];
	for (const entry of list) {
		if (!entry || typeof entry !== "object") continue;
		const id = String(entry.id || "");
		if (id === "") {
			out.push({ ...entry, firstFile: entry.file || "", patches: 0, patchedFiles: [] });
			continue;
		}
		const previous = byId.get(id);
		if (!previous) {
			const merged = { ...entry, firstFile: entry.file || "", patches: 0, patchedFiles: [] };
			byId.set(id, merged);
			out.push(merged);
			continue;
		}
		if (entry.hasName) {
			previous.hasName = true;
			previous.name = entry.name || "";
		}
		if (entry.hasDisabled) {
			previous.hasDisabled = true;
			previous.disabledRaw = entry.disabledRaw;
			previous.disabledKind = entry.disabledKind;
			previous.disabled = entry.disabled;
		}
		previous.file = entry.file || previous.file;
		previous.line = entry.line || previous.line;
		previous.patches = (previous.patches || 0) + 1;
		previous.patchedFiles = [...(previous.patchedFiles || []), entry.file || ""];
	}
	return out;
}

/**
 * 配置层「签名」（R23）：进历史的那一份。
 *
 * ★ 为什么不复用 `auditComposition`：历史在**每次目录重建**后都要记一条，
 *   而 audit 要 `scanInstalledPackages`（本机 222 个包）与 asar 包名索引 ——
 *   为一条历史再付一次不划算，也把冷启动拖慢。签名只解析**声明**本身。
 * ★ 指纹取 `id / name / disabledKind` + bundles（都排序后拼起来，sha1 前 12 位）：
 *   这四样正好覆盖「条目增删 / 改名 / disabled 翻转 / bundles 增删」。
 *   **刻意不取 present / asar / missing** —— 那些依赖安装态，换台机器就会变，
 *   混进指纹会把「另一台机器」误报成「配置被改」。
 * ★ counts 也只放声明层算得出来的数（生效 / 启用 / 关掉 / 条件 / 被 patch 覆盖 / bundles / 文件数）。
 *   这些数只用来在变化条上写人话，判「变没变」永远看指纹。
 *
 * @param {{files?:Array<{file?:string,text?:string}>, bundles?:string[]}} input
 * @returns {{fingerprint:string, counts:{entries:number,on:number,off:number,conditional:number,patched:number,bundles:number,files:number}}}
 */
export function signatureOf(input = {}) {
	const files = Array.isArray(input.files) ? input.files.filter((file) => file && typeof file === "object") : [];
	const bundles = (Array.isArray(input.bundles) ? input.bundles : []).map((name) => String(name ?? "").trim()).filter(Boolean);
	const parsed = files.flatMap((file) => parseComposition(file.text ?? "", { file: String(file.file || "") }));
	const rows = mergeCompositionEntries(parsed);
	const counts = { entries: 0, on: 0, off: 0, conditional: 0, patched: 0, bundles: bundles.length, files: files.length };
	for (const row of rows) {
		counts.entries += 1;
		if (row.disabledKind === "off") counts.off += 1;
		else if (row.disabledKind === "expression") counts.conditional += 1;
		else counts.on += 1;
		if (Number(row.patches) > 0) counts.patched += 1;
	}
	/* ★ 每一行先各自拼好再整体排序：直接 sort 数组再 join 也行，但这里明确按「行」排序，
	   避免有人后来把行内字段拆开排序后又以为指纹还稳定。 */
	const text =
		rows
			.map((row) => [String(row.id || ""), String(row.name || ""), String(row.disabledKind || "on")].join("\u0001"))
			.sort()
			.join("\u0002") +
		"\u0003" +
		bundles.slice().sort().join("\u0002");
	const fingerprint = createHash("sha1").update(text, "utf8").digest("hex").slice(0, 12);
	/* R25：把「到底哪条被关掉 / 哪个 bundle 被加减」压进快照，供变化条下钻。
	   只存 identity（id / name / kind）+ bundles 名单；不含解析结果（present/asar 是安装态，不进历史）。
	   ★ 体积：本机 246 条 × ~50 字节 ≈ 12 KB/快照，20 条封顶 ≈ 240 KB —— 比"面板只说计数"值。 */
	const decls = rows
		.map((row) => ({ id: String(row.id || ""), name: String(row.name || ""), kind: String(row.disabledKind || "on") }))
		.filter((row) => row.id !== "")
		.sort((left, right) => (left.id === right.id ? (left.name < right.name ? -1 : left.name > right.name ? 1 : 0) : left.id < right.id ? -1 : 1));
	return { fingerprint, counts, decls, bundles: bundles.slice().sort() };
}

/** 去掉子路径：`@scope/pkg/sub` → `@scope/pkg`；`pkg/sub` → `pkg`。 */
export function packageNameOf(name) {
	const text = String(name ?? "").trim();
	if (text === "") return "";
	const parts = text.split("/");
	if (parts[0].startsWith("@")) return parts.length >= 2 ? parts.slice(0, 2).join("/") : text;
	return parts[0];
}

/** asar / 工作区路径比较用的归一化（大小写不敏感、统一斜杠）。 */
function normalizePath(path) {
	return String(path ?? "")
		.replace(/\\/g, "/")
		.replace(/\/+$/, "")
		.toLowerCase();
}

/** `file:///D:/…` → `D:/…`；不是文件 URL 或非法 URL → ""。 */
export function localPathOf(name) {
	try {
		return normalizePath(fileURLToPath(String(name ?? "")));
	} catch {
		return "";
	}
}

/**
 * 一条 `name:` 是什么。
 * @param {string} name
 * @returns {{kind:string, package:string, path:string}}
 */
export function classifyCompositionName(name) {
	const text = String(name ?? "").trim();
	if (text === "") return { kind: "id-only", package: "", path: "" };
	if (/^cordis:/i.test(text)) return { kind: "group", package: "", path: "" };
	if (/^file:\/\//i.test(text) || /^[a-zA-Z]:[\\/]/.test(text) || /^\.{1,2}[\\/]/.test(text)) return { kind: "file", package: "", path: localPathOf(text) };
	const pkg = packageNameOf(text);
	return { kind: pkg === text ? "package" : "subpath", package: pkg, path: "" };
}

/**
 * 声明层审计（**纯函数**：图进、结论出，函数体不碰磁盘）。
 *
 * @param {object} input
 * @param {Array<{file:string,text:string,role?:string,source?:string,bundle?:string}>} input.files
 *        组合层原文（顺序 = 应用顺序）。R33 起由 `lib/patches.mjs` 交来 49 份；
 *        旧调用点只交两份 profile 文件也没问题（role 按文件名退化）。
 * @param {string[]} [input.bundles]                                `dsh.profile.bundles`
 * @param {string[]} [input.missing]                                读不到的层名（不算空层，单独列）
 * @param {Map<string,string[]>|Record<string,string[]>} [input.installed] profile/node_modules 里的包名
 * @param {Set<string>|string[]|null} [input.asarNames]             asar 里的包名；**null = 读不到**
 * @param {Set<string>|string[]} [input.existingFiles]              按路径挂载时"文件在不在"（只给存在的）
 * @param {number} [input.at]
 * @returns {object}
 */
export function auditComposition(input = {}) {
	const files = Array.isArray(input.files) ? input.files.filter((item) => item && typeof item.text === "string") : [];
	const bundles = Array.isArray(input.bundles) ? input.bundles.filter((name) => typeof name === "string" && name !== "") : [];
	const installed = input.installed instanceof Map ? input.installed : new Map(Object.entries(input.installed || {}).filter(([, value]) => Array.isArray(value)));
	const asarNames = input.asarNames instanceof Set ? input.asarNames : Array.isArray(input.asarNames) ? new Set(input.asarNames) : null;
	const existingFiles = new Set(
		(input.existingFiles instanceof Set ? [...input.existingFiles] : Array.isArray(input.existingFiles) ? input.existingFiles : []).map((path) => normalizePath(path)),
	);
	const at = Number(input.at) || Date.now();
	const missingLayers = Array.isArray(input.missing) ? input.missing.filter((name) => typeof name === "string" && name !== "") : [];

	/* ① 解析 → ② 按 id 合并（patch 层在后）
	   ★ R33：`files` 现在可以带 `role` / `source` / `bundle`（见 lib/patches.mjs）。
	     没带时按文件名退化：`cordis.yml` = root，其余 = profile-patch（旧调用点零改动）。 */
	const parsed = [];
	const fileRows = [];
	const roleOfFile = new Map();
	for (const file of files) {
		const entries = parseComposition(file.text, { file: file.file });
		const base = String(file.file || "").split(/[\\/]/).pop().toLowerCase();
		const role = LAYER_ROLES.includes(file.role) ? file.role : base === "cordis.yml" ? "root" : "profile-patch";
		const row = {
			file: file.file,
			role,
			source: file.source === "asar" ? "asar" : "profile",
			bundle: String(file.bundle || ""),
			entries: entries.length,
			insert: entries.filter((entry) => entry.insert === true).length,
		};
		fileRows.push(row);
		roleOfFile.set(String(file.file || ""), role);
		parsed.push(...entries);
	}
	const effective = mergeCompositionEntries(parsed);

	/* ★ 组合模型：rc.3 起入口表是空表，树由各 bundle 的 patch 拼出来。
	   这不是"配置丢了"，是**模型换了** —— 面板/工具必须能说出这件事，否则会把人吓一跳。 */
	const rootEntries = fileRows.filter((row) => row.role === "root").reduce((sum, row) => sum + row.entries, 0);
	const bundleEntries = fileRows.filter((row) => row.role === "bundle-patch").reduce((sum, row) => sum + row.entries, 0);
	const profileEntries = fileRows.filter((row) => row.role === "profile-patch").reduce((sum, row) => sum + row.entries, 0);
	const model = fileRows.length === 0 ? "empty" : rootEntries === 0 && bundleEntries > 0 ? "bundle-layers" : "flat";

	/* ③ 每条生效条目：类型、包名、解析结果 */
	const rows = effective.map((entry) => {
		const info = classifyCompositionName(entry.name);
		let resolution = "n/a";
		let why = "";
		if (info.kind === "package" || info.kind === "subpath") {
			if (installed.has(info.package)) resolution = "present";
			else if (asarNames === null) resolution = "unjudged";
			else if (asarNames.has(info.package)) resolution = "asar";
			else {
				resolution = "missing";
				why = "profile 的 node_modules 与官方 asar 里都没有（静态判据看不见运行期注入的虚拟模块）";
			}
		} else if (info.kind === "file") {
			if (info.path === "") {
				resolution = "missing";
				why = "不是合法的文件 URL / 路径";
			} else if (existingFiles.has(info.path)) resolution = "present";
			else {
				resolution = "missing";
				why = "按路径挂载，但那个文件不在";
			}
		} else if (info.kind === "group") {
			why = "cordis 分组条目，不挂具体包";
		} else {
			why = "只按 id 覆盖已有条目（patch 层），不新挂包";
		}
		return {
			id: entry.id || "",
			name: entry.name || "",
			kind: info.kind,
			package: info.package,
			path: info.path,
			resolution,
			why,
			state: entry.disabledKind === "off" ? "off" : entry.disabledKind === "expression" ? "conditional" : "on",
			disabledRaw: entry.disabledRaw || "",
			file: entry.file || "",
			/* R33：这一条最后是被哪一层写的（root / bundle-patch / profile-patch） */
			layer: roleOfFile.get(String(entry.file || "")) || "",
			line: Number(entry.line) || 0,
			patches: Number(entry.patches) || 0,
			patchedFiles: entry.patchedFiles || [],
		};
	});

	/* ④ bundles 的缺口：已装 / 官方 asar / 真的缺 / 无法判定 */
	const bundleRows = bundles.map((name) => {
		const pkg = packageNameOf(name);
		let resolution = "missing";
		if (installed.has(pkg)) resolution = "present";
		else if (asarNames === null) resolution = "unjudged";
		else if (asarNames.has(pkg)) resolution = "asar";
		return { name, package: pkg, resolution };
	});

	const counts = {
		parsed: parsed.length,
		effective: rows.length,
		byKind: Object.fromEntries(COMPOSITION_KINDS.map((kind) => [kind, 0])),
		byResolution: Object.fromEntries(ENTRY_RESOLUTIONS.map((resolution) => [resolution, 0])),
		byState: { on: 0, off: 0, conditional: 0 },
		patched: rows.filter((row) => row.patches > 0).length,
		/* R33：分层口径 —— 每层各解析出多少条（parsed 口径，不是生效口径），
		   以及其中多少条来自 `- insert:` 块。生效条数看 `effective`。 */
		byRole: {
			root: rootEntries,
			"bundle-patch": bundleEntries,
			"profile-patch": profileEntries,
		},
		inserted: parsed.filter((entry) => entry.insert === true).length,
		bundleLayers: fileRows.filter((row) => row.role === "bundle-patch").length,
	};
	for (const row of rows) {
		counts.byKind[row.kind] += 1;
		counts.byResolution[row.resolution] += 1;
		counts.byState[row.state] += 1;
	}

	/* ⑤ 按**包名**去重后的解析分布（一个包可能被两个 id 各挂一次） */
	const packageMap = new Map();
	for (const row of rows) {
		if (row.kind !== "package" && row.kind !== "subpath") continue;
		const known = packageMap.get(row.package);
		/* present > asar > unjudged > missing：同一包两次挂载若结论不同，取更"能加载"的那个 */
		const rank = { present: 4, asar: 3, unjudged: 2, missing: 1 };
		if (!known || rank[row.resolution] > rank[known]) packageMap.set(row.package, row.resolution);
	}
	const packages = { distinct: packageMap.size, present: 0, asar: 0, missing: 0, unjudged: 0 };
	for (const resolution of packageMap.values()) packages[resolution] += 1;

	/* ⑥ 清单：缺的 / 无法判定 / 条件 / 关掉 —— 面板与工具都读这一份 */
	const missing = rows.filter((row) => row.resolution === "missing");
	const unjudged = rows.filter((row) => row.resolution === "unjudged");
	const conditional = rows.filter((row) => row.state === "conditional");
	const disabled = rows.filter((row) => row.state === "off");
	const bundlesMissing = bundleRows.filter((row) => row.resolution === "missing");
	const bundlesUnjudged = bundleRows.filter((row) => row.resolution === "unjudged");

	const bundlesCounts = {
		declared: bundleRows.length,
		present: bundleRows.filter((row) => row.resolution === "present").length,
		asar: bundleRows.filter((row) => row.resolution === "asar").length,
		missing: bundlesMissing.length,
		unjudged: bundlesUnjudged.length,
	};

	/* ★ 严重度分开算：
	   `bundles` 是宿主自己的启用清单 —— 里面点名了却找不到，宿主启用它时必然失败（bad）。
	   组合条目则可能由**运行期注入**满足（本机 `dsh-plugin-desktop`：桌面端写的 patch 条目，
	   磁盘与 asar 里都搜不到这个包名，但桌面壳照常工作）—— 所以只算 warn，
	   措辞用「静态查不到」，不写「必坏」。 */
	const verdict = bundlesMissing.length > 0 ? "bad" : missing.length > 0 || unjudged.length > 0 || bundlesUnjudged.length > 0 ? "warn" : "ok";
	return {
		version: COMPOSITION_VERSION,
		at,
		/* ★ R33：模型 + 层。`files` 保留（旧字段），`layers` 是同义的显式名字。 */
		model,
		layers: fileRows,
		missingLayers,
		files: fileRows,
		entries: rows,
		counts,
		packages,
		bundles: { ...bundlesCounts, rows: bundleRows },
		missing,
		unjudged,
		conditional,
		disabled,
		bundlesMissing,
		bundlesUnjudged,
		asarReadable: asarNames !== null,
		verdict,
	};
}

/** 人话摘要（health / 工具首行 / 导出/面板同一句）。 */
export function summarizeComposition(report) {
	if (!report || !report.counts) return "配置层：还没读（没有组合文件或读失败）";
	const c = report.counts;
	const b = report.bundles;
	const layers = Array.isArray(report.layers) ? report.layers : Array.isArray(report.files) ? report.files : [];
	const head =
		report.model === "bundle-layers"
			? "配置层：入口表 0 条（bundle-layers 模型）→ bundle 层 " +
				Number(c.bundleLayers || 0) +
				" 份 patch 共 " +
				Number((c.byRole && c.byRole["bundle-patch"]) || 0) +
				" 条 + profile patch " +
				Number((c.byRole && c.byRole["profile-patch"]) || 0) +
				" 条 → 生效 " +
				c.effective +
				"（包 " +
				c.byKind.package +
				" / 子路径 " +
				c.byKind.subpath +
				" / 按路径 " +
				c.byKind.file +
				" / 组 " +
				c.byKind.group +
				" / 只按 id " +
				c.byKind["id-only"] +
				"）"
			: layers.length === 0
				? "配置层：没有读到组合文件"
				: "配置层：" +
					layers
						.filter((file) => file.role !== "bundle-patch")
						.map((file) => String(file.file || "").split(/[\\/]/).pop() + " " + file.entries)
						.join(" + ") +
					" 条顶层条目 → 生效 " +
					c.effective +
					"（包 " +
					c.byKind.package +
					" / 子路径 " +
					c.byKind.subpath +
					" / 按路径 " +
					c.byKind.file +
					" / 组 " +
					c.byKind.group +
					" / 只按 id " +
					c.byKind["id-only"] +
					"）";
	const resolution =
		report.asarReadable === false
			? "；已装 " + report.packages.present + "、asar 读不到（" + report.packages.unjudged + " 条包条目无法判定）、静态查不到 " + report.packages.missing
			: "；已装 " + report.packages.present + "、官方 asar " + report.packages.asar + "、**静态查不到 " + report.packages.missing + "**";
	const flags = "；关掉 " + c.byState.off + " / 条件 " + c.byState.conditional + "（不求值）";
	const bundle = "；bundles " + b.declared + " → 已装 " + b.present + " + asar " + b.asar + " + " + (b.unjudged > 0 ? "无法判定 " + b.unjudged : "缺 " + b.missing);
	const missingLayers = Array.isArray(report.missingLayers) ? report.missingLayers : [];
	const lost = missingLayers.length === 0 ? "" : "；**读不到的层 " + missingLayers.length + " 份**（" + missingLayers.slice(0, 3).join("、") + (missingLayers.length > 3 ? " 等" : "") + "）";
	return head + resolution + flags + bundle + lost;
}

/** 面板 / `/state` 用的紧凑视图（明细列表截断，避免 20 秒轮询里塞 250 条）。 */
export function compactComposition(report, cap = 40) {
	if (!report || !report.counts) return null;
	const cut = (list) => (Array.isArray(list) ? list.slice(0, cap) : []);
	const short = (row) => ({ id: row.id, name: row.name, package: row.package, kind: row.kind, resolution: row.resolution, state: row.state, disabledRaw: row.disabledRaw, file: row.file, line: row.line, why: row.why });
	const layers = Array.isArray(report.layers) ? report.layers : [];
	return {
		version: report.version,
		at: report.at,
		/* R33：面板要能说出「这是哪一种组合模型」与「每层各多少条」。
		   ★ 只给层名与计数，不给 49 条 file 全路径 —— /state 每 20 秒轮询一次。 */
		model: report.model || "",
		layers: {
			root: layers.filter((row) => row.role === "root").reduce((sum, row) => sum + Number(row.entries || 0), 0),
			bundleFiles: layers.filter((row) => row.role === "bundle-patch").length,
			bundleEntries: layers.filter((row) => row.role === "bundle-patch").reduce((sum, row) => sum + Number(row.entries || 0), 0),
			bundleFromAsar: layers.filter((row) => row.role === "bundle-patch" && row.source === "asar").length,
			profileEntries: layers.filter((row) => row.role === "profile-patch").reduce((sum, row) => sum + Number(row.entries || 0), 0),
			missing: Array.isArray(report.missingLayers) ? report.missingLayers : [],
		},
		verdict: report.verdict,
		asarReadable: report.asarReadable,
		files: report.files,
		counts: report.counts,
		packages: report.packages,
		bundles: { declared: report.bundles.declared, present: report.bundles.present, asar: report.bundles.asar, missing: report.bundles.missing, unjudged: report.bundles.unjudged },
		/* R24：面板要回答「这条 disabled / 条件条目在不在 bundles 里」—— 只给包名（50 个字），
		   ★ 不给整行：/state 每 20 秒轮询，rows 还带 file/line，没必要为一句交叉引用多传。 */
		bundleNames: [...new Set((report.bundles.rows || []).map((row) => row.package).filter(Boolean))].sort(),
		missing: cut(report.missing).map(short),
		unjudged: cut(report.unjudged).map(short),
		conditional: cut(report.conditional).map(short),
		disabled: cut(report.disabled).map(short),
		bundlesMissing: cut(report.bundlesMissing).map((row) => ({ name: row.name, package: row.package, resolution: row.resolution })),
		summary: summarizeComposition(report),
	};
}

/** 导出报告的一节（Markdown）。与面板/工具同一份数据，不另算。 */
export function renderCompositionSection(report) {
	const lines = [];
	lines.push("## 配置层（声明）");
	lines.push("");
	if (!report || !report.counts) {
		lines.push("- 没读到组合文件（`cordis.yml` / `cordis.patch.yml`）—— 这份报告里没有配置层结论");
		lines.push("");
		return lines;
	}
	lines.push("- " + summarizeComposition(report));
	lines.push(
		"- 判据：只读 **声明**（`dsh.profile.bundles` 里每个 bundle 自带的 `cordis.patch.yml` + profile 自己的 `cordis.yml` / `cordis.patch.yml`，" +
			"应用顺序 = bundles 顺序 → profile patch，同 id **后者胜**；再叠加 `profile/node_modules` 与 asar 包名）。" +
			"`!!js` 表达式**不求值**；按路径挂载只检查文件在不在；`config:` 内部一律不展开。" +
			"组合条目「静态查不到」≠ 一定坏 —— 运行期注入的虚拟模块（桌面端就是这样写 `dsh-plugin-desktop` 的）本工具看不见。" +
			"只有 `bundles` 里点名却找不到，才记为「真的缺」（宿主启用它时必然失败）。",
	);
	if (report.model === "bundle-layers") {
		lines.push(
			"- **组合模型：`bundle-layers`**（DSH 0.2.1-rc.3 起）。入口表 `cordis.yml` 是**空表**，" +
				"树由各 bundle 自带的 patch 层拼出来（`@deepseek-ai/dsh-base` 那一层在 asar 里，本机 96 条）。" +
				"所以「生效条数」不再是「`cordis.yml` 里有多少条」—— 只看入口表会得到「配置丢了 90%」的假象。",
		);
	}
	lines.push("");
	if (report.bundlesMissing.length > 0) {
		lines.push("### 真的缺（bundles 里点名了，但 profile 与 asar 都没有）—— " + report.bundlesMissing.length + " 个");
		lines.push("");
		for (const row of report.bundlesMissing.slice(0, 20)) lines.push("- bundle `" + row.name + "`：宿主启用它时会失败");
		lines.push("");
	}
	if (report.missing.length > 0) {
		lines.push("### 静态查不到的条目（" + report.missing.length + " 条）");
		lines.push("");
		for (const row of report.missing.slice(0, 20)) lines.push("- `" + row.name + "`（`" + row.id + "`，`" + row.file + ":" + row.line + "`）：" + row.why);
		if (report.missing.length > 20) lines.push("- ……（只列前 20 条）");
		lines.push("");
	}
	if (report.bundlesMissing.length === 0 && report.missing.length === 0) {
		lines.push("- 缺口：**0**（每个 bundle 与每个包条目都能在 profile 或官方 asar 里找到）");
		lines.push("");
	}
	if (report.unjudged.length > 0 || !report.asarReadable) {
		lines.push("### 无法判定（asar 读不到，不算「缺」）");
		lines.push("");
		lines.push("- 有 **" + report.unjudged.length + "** 条包条目可能指向 asar 内的包，但这次没读到 asar（纯 node / 探针环境）—— 在宿主里重跑才会有结论");
		lines.push("");
	}
	if (report.conditional.length > 0) {
		lines.push("### 条件启用（`!!js` 表达式，不求值）—— " + report.conditional.length + " 条");
		lines.push("");
		for (const row of report.conditional.slice(0, 20)) lines.push("- `" + row.id + "`（`" + row.name + "`，`" + row.file + ":" + row.line + "`）：`" + row.disabledRaw + "`");
		lines.push("");
	}
	lines.push("### 关掉的条目（`disabled: true`）—— " + report.disabled.length + " 条");
	lines.push("");
	lines.push(
		"- 这是**声明**，而且是**合并后**的声明（R33 起会展开 bundle 自带的 patch 层）：" +
			"某一条在基线里写着 `disabled: true`、却被后应用的某层重新打开时，这里就**不会**再出现它。" +
			"所以这张表回答的是「谁最后把它关掉了」，不是「某个工具为什么没出现」—— 后者要看宿主日志 / `plugin_manager`。",
	);
	lines.push("");
	if (report.disabled.length === 0) lines.push("- 没有");
	else {
		lines.push("- 只列前 40 条（完整清单在面板「配置层」里）：");
		for (const row of report.disabled.slice(0, 40)) lines.push("- `" + row.id + "`" + (row.name ? "（`" + row.name + "`）" : "") + " · `" + String(row.file || "").split(/[\\/]/).pop() + ":" + row.line + "`");
	}
	lines.push("");
	return lines;
}
