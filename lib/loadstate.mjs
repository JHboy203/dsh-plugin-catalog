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

/* ★ R22：组合文件的解析搬到 `lib/composition.mjs`（配置层健康要用更细的字段：
   块标量、`disabled` 的原始写法、行号、文件归属）。这里**只转出**，加载判据不变 ——
   把解析与判据分开，但只有一份实现（`parseComposition` 不再有第二份拷贝）。 */
export { parseComposition } from "./composition.mjs";

/**
 * 扫 `node_modules` 的依赖图（顶层 + 一层嵌套），给出「包名 → 声明的依赖」与「目录事实」。
 *
 * ★ 同名多份副本取**依赖并集**（R14 修正）。本机实测：`string-width` 有一份顶层、
 *   一份嵌套，两份的 `package.json` 不同 —— 顶层那份声明 `emoji-regex`，嵌套那份没有。
 *   若按"最后读到的那份"覆盖（原先 catalog / probe 就是这么写的），`emoji-regex` 会被判成
 *   `dormant`，而顶层 `string-width` 是随 `@anweat/dsh-browser` 加载的、正需要它 ——
 *   照那份清单删就弄坏加载。并集的方向是**保守**的：宁可少判一个 dormant（少删一个），
 *   也不要把"会被加载的包要用的库"标成没人要。
 *
 * ★ 只扫一层嵌套：更深的副本跟着父包走，不值得为它多付 O(千) 次 stat。
 *
 * @param {string} nodeModules
 * @returns {Promise<{installed: Map<string,string[]>, dirs: Array<object>, duplicates: string[], errors: Array<{path:string,error:string}>}>}
 */
export async function scanInstalledPackages(nodeModules) {
	const { readdir, readFile, lstat, realpath } = await import("node:fs/promises");
	const { join } = await import("node:path");
	const installed = new Map();
	const dirs = [];
	const errors = [];
	/* 同名多份副本：记下来（本机只有 string-width），既用于并集，也用于自述 */
	const copies = new Map();
	const mergeDeps = (name, deps) => {
		const previous = installed.get(name);
		if (!previous) {
			installed.set(name, deps);
			return;
		}
		if (deps.length === 0) return;
		installed.set(name, [...new Set([...previous, ...deps])]);
	};
	const readMeta = async (dir) => {
		try {
			const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
			if (!pkg || typeof pkg.name !== "string" || pkg.name === "") return null;
			const deps = [];
			for (const key of DEP_KEYS) {
				if (pkg[key] && typeof pkg[key] === "object") deps.push(...Object.keys(pkg[key]));
			}
			return { name: pkg.name, deps: [...new Set(deps)] };
		} catch (error) {
			errors.push({ path: dir, error: "读 package.json 失败：" + String(error?.message ?? error) });
			return null;
		}
	};
	const visit = async (dirName, dir) => {
		const info = await lstat(dir).catch(() => null);
		if (!info) {
			errors.push({ path: dir, error: "lstat 失败（断链？）" });
			return null;
		}
		const link = info.isSymbolicLink();
		const target = link ? await realpath(dir).catch(() => "") : "";
		const meta = await readMeta(dir);
		const name = meta ? meta.name : dirName;
		if (meta) {
			mergeDeps(meta.name, meta.deps);
			copies.set(meta.name, (copies.get(meta.name) || 0) + 1);
		}
		return { dirName, dir, pkg: name, deps: meta ? meta.deps : [], link, target, readOk: Boolean(meta) };
	};

	const top = await readdir(nodeModules).catch((error) => {
		errors.push({ path: nodeModules, error: "readdir node_modules 失败：" + String(error?.message ?? error) });
		return [];
	});
	const topDirs = [];
	for (const entry of top) {
		if (entry.startsWith(".")) continue;
		if (entry.startsWith("@")) {
			for (const sub of await readdir(join(nodeModules, entry)).catch(() => [])) topDirs.push([entry + "/" + sub, join(nodeModules, entry, sub)]);
		} else {
			topDirs.push([entry, join(nodeModules, entry)]);
		}
	}
	for (const [dirName, dir] of topDirs) {
		const item = await visit(dirName, dir);
		if (item) dirs.push(item);
	}
	/* 嵌套一层：只补依赖图（这些目录不归处置清单管，跟着父包走） */
	for (const [dirName, dir] of topDirs) {
		const nestedRoot = join(dir, "node_modules");
		const names = await readdir(nestedRoot).catch(() => []);
		for (const name of names) {
			if (name.startsWith(".")) continue;
			const list = name.startsWith("@") ? (await readdir(join(nestedRoot, name)).catch(() => [])).map((sub) => [name + "/" + sub, join(nestedRoot, name, sub)]) : [[name, join(nestedRoot, name)]];
			for (const [nestedName, target] of list) {
				const info = await lstat(target).catch(() => null);
				if (!info || !info.isDirectory()) continue;
				const meta = await readMeta(target);
				if (!meta) continue;
				mergeDeps(meta.name, meta.deps);
				copies.set(meta.name, (copies.get(meta.name) || 0) + 1);
				void dirName;
			}
		}
	}
	const duplicates = [...copies.entries()].filter(([, count]) => count > 1).map(([name]) => name).sort();
	return { installed, dirs, duplicates, errors };
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
