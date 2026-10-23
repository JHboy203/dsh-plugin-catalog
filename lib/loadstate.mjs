/**
 * loadstate.mjs — 「这个包装上之后，宿主到底会不会加载它」。
 *
 * ★ 为什么需要它（R12 的真实动因）：
 *   面板此前只有一个 `enabled`（= 在不在 `dsh.profile.bundles` 里），并且把它显示成
 *   「启用：是 / 否」。可 `bundles` **不是**唯一的加载入口：
 *     · `cordis.yml` / `cordis.patch.yml` 的顶层条目按 `name:` 直接挂包（不在 bundles 里也照跑）；
 *     · 被某个入口包**声明为依赖**的包，会随它一起被 import。
 *   于是本机实测：`enabled === false` 的 26 个包里，**24 个其实会被加载**
 *   （`@dsh-ops/bash-win32-x64` 等三个平台二进制 + 19 个 `dsh-mnemon-*` 子包）。
 *   把它们标成「启用：否」并置灰，等于在 354 MB 的必需二进制上写着"没启用" —— 照它删就坏。
 *
 * ★ 判据（全部是静态声明，不读运行时）：
 *   入口 roots = `bundles` ∩ 已装  ∪  `cordis*.yml` 顶层条目里 name 命中已装（且未被 `disabled: true` 摘掉）
 *   可达     = 从 roots 出发，沿 `dependencies / optionalDependencies / peerDependencies` 做 BFS
 *   四态：
 *     bundle     在 bundles 里（直接启用）
 *     config     不在 bundles，但被配置条目的 name 挂上
 *     transitive 不在前两者，但落在某个入口的依赖链上（随 X 加载）
 *     dormant    以上都不是 —— **没有任何入口引用它**，装了也不会被加载
 *
 * ★ 诚实的边界：这是「声明层面」的可达性。运行时 `require(路径)` 动态加载的包、
 *   以及在别处（另一个 profile / 全局）挂上的包，本判据看不见。所以 `dormant` 在界面上
 *   必须写成「不在任何加载入口上」，而不是"绝对没跑"。
 *
 * @module dsh-plugin-catalog/loadstate
 */

/** 四态。顺序即展示优先级。 */
export const LOAD_STATES = Object.freeze(["bundle", "config", "transitive", "dormant"]);

/** 三态判据用到的依赖键（与 catalog 的依赖图同源）。 */
export const DEP_KEYS = Object.freeze(["dependencies", "optionalDependencies", "peerDependencies"]);

/**
 * 解析一份 cordis 组合文件（`cordis.yml` / `cordis.patch.yml`）。
 *
 * ★ 只认**顶层条目**：列 0 的 `- id:`（或 `- name:`），以及它下面**恰好 2 个空格缩进**的键。
 *   更深缩进是条目自己的 `config:`（本机 `cordis.patch.yml` 里有 40 多个模型定义，
 *   每个都带 `id:` / `name:`）—— 一起收进来会得出"配置里挂了 200 个包"这种荒唐结论。
 *
 * @param {string} text
 * @returns {Array<{id:string, name:string, disabled:boolean}>}
 */
export function parseComposition(text) {
	const entries = [];
	let cur = null;
	for (const raw of String(text ?? "").split(/\r?\n/)) {
		const line = raw.replace(/\s+$/, "");
		if (line.trim() === "") continue;
		/* 顶层条目：`- id: x` 或 `- name: y` */
		if (/^-\s/.test(line)) {
			cur = { id: "", name: "", disabled: false };
			readKey(cur, line.slice(1).trim());
			entries.push(cur);
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
		readKey(cur, line.trim());
	}
	return entries;
}

function readKey(entry, fragment) {
	const id = /^id:\s*(.*)$/.exec(fragment);
	if (id) {
		entry.id = unquote(id[1]);
		return;
	}
	const name = /^name:\s*(.*)$/.exec(fragment);
	if (name) {
		const value = unquote(name[1]);
		if (value !== "" && !entry.name) entry.name = value;
		return;
	}
	const disabled = /^disabled:\s*(.*)$/.exec(fragment);
	if (disabled) entry.disabled = /^true$/i.test(unquote(disabled[1]));
}

function unquote(value) {
	const text = String(value ?? "").trim();
	if (text === "") return "";
	if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) return text.slice(1, -1);
	return text;
}

/**
 * 算每个已装包的加载态。
 *
 * @param {object} input
 * @param {string[]} [input.bundles]      `dsh.profile.bundles`
 * @param {Array<{id:string,name:string,disabled:boolean}>} [input.compositions] 两份组合文件的条目
 * @param {Map<string,string[]>|Record<string,string[]>} [input.installed] 包名 → 它声明的依赖
 * @returns {{byName: Map<string,{state:string, via:string}>, roots: Array<{name:string,why:string,id:string}>, counts: Record<string,number>}}
 */
export function resolveLoadPaths(input) {
	const bundles = Array.isArray(input?.bundles) ? input.bundles.filter((x) => typeof x === "string" && x !== "") : [];
	const compositions = Array.isArray(input?.compositions) ? input.compositions : [];
	const installed = input?.installed instanceof Map ? input.installed : new Map(Object.entries(input?.installed || {}));
	const has = (name) => installed.has(name);

	/* ① 入口：bundles（含 asar 里那些——它们不在 installed，但确实是入口） */
	const roots = [];
	const rootNames = new Set();
	for (const name of [...new Set(bundles)].sort((a, b) => a.localeCompare(b))) {
		roots.push({ name, why: "bundle", id: "" });
		rootNames.add(name);
	}
	/* ② 入口：配置条目（被 `disabled: true` 摘掉的不算入口） */
	const configSeen = new Set();
	for (const entry of compositions) {
		if (!entry || !entry.name || entry.disabled) continue;
		if (rootNames.has(entry.name) || configSeen.has(entry.name)) continue;
		if (!has(entry.name)) continue;
		configSeen.add(entry.name);
		roots.push({ name: entry.name, why: "config", id: entry.id || "" });
	}

	/* ③ 从入口出发，沿依赖链点亮。
	   `via` 记的是**入口**（不是直接上游）：面板上「随 dsh-ops 加载」比「随某个子依赖加载」
	   有用得多；入口本身不是已装包（官方包在 asar 里）时它不进 byName，只进 roots 清单。 */
	const byName = new Map();
	const queue = [];
	for (const root of roots) {
		if (!has(root.name)) continue;
		if (byName.has(root.name)) continue;
		const state = root.why === "config" ? "config" : "bundle";
		byName.set(root.name, { state, via: root.why === "config" ? root.id || root.name : "" });
		queue.push({ name: root.name, origin: root.why === "config" ? root.id || root.name : root.name });
	}
	while (queue.length > 0) {
		const { name, origin } = queue.shift();
		for (const dep of installed.get(name) || []) {
			if (byName.has(dep) || !has(dep)) continue;
			byName.set(dep, { state: "transitive", via: origin });
			queue.push({ name: dep, origin });
		}
	}
	/* ④ 剩下的：没有任何入口引用 */
	for (const name of installed.keys()) {
		if (!byName.has(name)) byName.set(name, { state: "dormant", via: "" });
	}

	const counts = { bundle: 0, config: 0, transitive: 0, dormant: 0 };
	for (const value of byName.values()) counts[value.state] = (counts[value.state] || 0) + 1;
	return { byName, roots, counts };
}

/** 这个状态算不算"会被加载"。 */
export function isLoadedState(state) {
	return state === "bundle" || state === "config" || state === "transitive";
}

/** 只在 `dormant` 时为真 —— 界面上的「不会被加载」筛选就用它。 */
export function isDormantState(state) {
	return state === "dormant";
}

/**
 * 给人看的一句话。`via` 是"谁把它带进来的"（bundle 态为空）。
 * @param {string} state
 * @param {string} [via]
 */
export function loadStateLabel(state, via = "") {
	if (state === "bundle") return "是（bundles 里直接启用）";
	if (state === "config") return "是（配置条目" + (via ? " " + via : "") + " 挂着，不在 bundles）";
	if (state === "transitive") return "随 " + (via || "某个入口") + " 加载（它声明依赖这个包）";
	if (state === "dormant") return "否 —— 不在 bundles、没有配置条目、也不在任何依赖链上";
	return "未知";
}
