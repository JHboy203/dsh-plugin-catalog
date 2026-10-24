/**
 * uninstall.mjs — 把「不会被加载」变成一份**照着做就行**的处置清单（只生成，永不执行）。
 *
 * ★ 为什么要单开一层（R14 的动因）：
 *   R12 判出了「装了但没有任何入口引用它」，界面上是一句「不会被加载」。可真到动手时，
 *   这 27 个目录**不是同一种东西**，处置方式完全相反：
 *
 *     · `duplicate`  同一项目的第二份安装（本机 `ghbackup` 是 `dsh-github-backup` 的
 *                    别名目录，按包名加载的是另一份）。删它只是清理重复 —— 不删也不会坏。
 *     · `link-workspace` junction 到工作区里的源码（`dpi-probe-bundle`、`dsh-toolfold`）。
 *                    **删链接一字节都不省**，空间在工作区；真要省得删源码。
 *     · `pinned`     实体目录，但 `profile/package.json` 的 `dependencies` 里钉着它
 *                    （本机 3 个：`dsh-mnemon` / `dsh-chat-import` / `dsh-plugin-video-player`，
 *                    还有 1 个别名键 `ghbackup`）。**只删目录，下次 `pnpm install` 会装回来** ——
 *                    这是最容易"以为删干净了"的一种。
 *     · `entity`     实体目录、没被钉住：只有这种是真的"删了就没了"。
 *
 * ★ 为什么按**弱连通分量**分组，而不是一个包一条：
 *   本机 `dsh-mnemon` 自己声明了 27 个依赖、其中 18 个同样 dormant；而
 *   `dsh-mnemon-source-*` 又反向声明 `dsh-mnemon`（有环）。单删父留子 = 留一堆孤儿；
 *   单删子 = 父（将来若启用）缺件。一组一起处置，才不会留下"半个包"。
 *
 * ★ 诚实的边界（必须原样出现在清单里，不许删）：
 *   1. 判据是**声明层面**：运行时 `require(路径)` 动态加载看不见；
 *   2. hoisted 扁平 node_modules 下，一个插件可以**不声明**却 `require('lodash')` 命中 ——
 *      所以删纯库前要 `pnpm why <name>` / 搜一遍引用；
 *   3. 只处理 `node_modules` 顶层的目录；嵌套在别的包里的同名副本跟着父包走；
 *   4. 永不执行：本模块只产出计划与命令文本，删不删由人决定。
 *
 * @module dsh-plugin-catalog/uninstall
 */

import { join } from "node:path";

import { DEP_KEYS, isLoadedState, parseComposition, resolveLoadPaths, scanInstalledPackages } from "./loadstate.mjs";

/** 处置分类 → 给人看的一句话。界面与清单都读这张表，别各写一份。 */
export const PROVENANCE = Object.freeze({
	entity: { label: "实体目录", hint: "删了就没了（没被 profile 依赖钉住）" },
	pinned: { label: "实体目录·被钉住", hint: "只删目录没用：profile/package.json 里还钉着，pnpm install 会装回来" },
	"link-workspace": { label: "链接→工作区", hint: "删链接一字节都不省，空间在工作区源码" },
	"link-other": { label: "链接→外部", hint: "删链接一字节都不省，目标在别处" },
	duplicate: { label: "同项目第二份", hint: "按包名加载的是另一份，删这份只是清理重复" },
	"alias-only": { label: "别名目录", hint: "包名没有同名目录，删了 require('<包名>') 会失效" },
});

function underPath(child, parent) {
	const c = String(child || "").replace(/[\\/]+/g, "/").toLowerCase();
	const p = String(parent || "").replace(/[\\/]+/g, "/").toLowerCase().replace(/\/+$/, "");
	return p !== "" && c.startsWith(p + "/");
}

/**
 * 依赖图与目录事实一律来自 `lib/loadstate.mjs` 的 `scanInstalledPackages`（R14 抽出来的）。
 * 这里不自己再扫一遍：同名多份副本要取**依赖并集**（本机 `string-width` 顶层那份声明
 * `emoji-regex`、嵌套那份没有），两处各写一份迟早会差出一个包 ——
 * 而"少判一个 dormant"正是这份清单唯一不允许犯的错。
 */

/** 弱连通分量：候选目录按"声明的依赖仍落在候选里"连边。 */
function componentsOf(candidates) {
	const byPkg = new Map();
	for (const item of candidates) {
		if (!byPkg.has(item.pkg)) byPkg.set(item.pkg, []);
		byPkg.get(item.pkg).push(item);
	}
	const parent = candidates.map((_, index) => index);
	const find = (index) => (parent[index] === index ? index : (parent[index] = find(parent[index])));
	const union = (a, b) => {
		const ra = find(a);
		const rb = find(b);
		if (ra !== rb) parent[ra] = rb;
	};
	const indexOf = new Map(candidates.map((item, index) => [item, index]));
	for (const item of candidates) {
		for (const dep of item.deps) {
			for (const other of byPkg.get(dep) || []) {
				if (other === item) continue;
				union(indexOf.get(item), indexOf.get(other));
			}
		}
	}
	const groups = new Map();
	for (let index = 0; index < candidates.length; index += 1) {
		const root = find(index);
		if (!groups.has(root)) groups.set(root, []);
		groups.get(root).push(candidates[index]);
	}
	return [...groups.values()];
}

/** 组名：出度最高的成员当"代表"（本机 mnemon 组 = 声明了 18 个子包的 `dsh-mnemon`）。 */
function pickHub(members, candidatePkgs) {
	const outDegree = (item) => item.deps.filter((dep) => candidatePkgs.has(dep)).length;
	return members
		.slice()
		.sort((a, b) => outDegree(b) - outDegree(a) || (b.size?.bytes || 0) - (a.size?.bytes || 0) || a.dirName.localeCompare(b.dirName))[0];
}

function fmtBytes(bytes) {
	const n = Number(bytes);
	if (!Number.isFinite(n) || n < 0) return "—";
	if (n < 1024) return n + " B";
	if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
	if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + " MB";
	return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

/**
 * 算一份处置计划。
 *
 * @param {object} input
 * @param {string} input.nodeModules           profile 的 node_modules
 * @param {Record<string,string>} input.profileDeps  `profile/package.json` 的 dependencies（键可能是别名）
 * @param {string[]} input.bundles             `dsh.profile.bundles`
 * @param {Array<{id:string,name:string,disabled:boolean}>} input.compositions 组合文件条目
 * @param {{files?: string[]}} [input.compositionMeta] 只用于自述（读了几份组合文件）
 * @param {string} [input.workspace]           工作区根（判"链接指向工作区"）
 * @param {(dir:string)=>Promise<{bytes:number|null, files?:number, truncated?:boolean}>} input.sizeOf
 *        体积必须由外部注入：本模块不 import dirSize，于是 audit 那条
 *        「dirSize 只在三处」的断言仍然成立（懒算的闸门不许被第三处悄悄打开）。
 * @returns {Promise<object>}
 */
export async function buildUninstallPlan(input) {
	const started = Date.now();
	const nodeModules = String(input.nodeModules || "");
	const profileDeps = input.profileDeps && typeof input.profileDeps === "object" ? input.profileDeps : {};
	const bundles = Array.isArray(input.bundles) ? input.bundles : [];
	const compositions = Array.isArray(input.compositions) ? input.compositions : [];
	const workspace = String(input.workspace || "");
	const sizeOf = typeof input.sizeOf === "function" ? input.sizeOf : null;
	const scanned = await scanInstalledPackages(nodeModules);
	const dirs = scanned.dirs;
	const installed = scanned.installed;
	const errors = [...scanned.errors];
	const loadPaths = resolveLoadPaths({ bundles, compositions, installed });
	const stateOf = (pkg) => loadPaths.byName.get(pkg)?.state || "dormant";
	/* 分组的连边用**并集**（与判据同源）：同一包的两份副本，只要有一份声明了某依赖就算声明，
	   否则"顶层声明、嵌套没声明"的那条边会消失，组会被切碎。 */
	for (const item of dirs) item.deps = installed.get(item.pkg) || item.deps;

	/* 同名的多份副本（本机只有 `string-width`）：依赖取并集，这里只用来在清单里自述 */
	const duplicateCopies = scanned.duplicates;

	/* `dsh.profile.bundles` 里的名字按**包名**解析（别名目录不算入口） */
	const dirsByPkg = new Map();
	for (const item of dirs) {
		if (!item.pkg) continue;
		if (!dirsByPkg.has(item.pkg)) dirsByPkg.set(item.pkg, []);
		dirsByPkg.get(item.pkg).push(item);
	}

	/* ── 候选目录 ── */
	const candidates = [];
	for (const item of dirs) {
		const state = stateOf(item.pkg);
		if (state === "dormant") {
			item.provenance = item.link ? (underPath(item.target, workspace) && !underPath(item.target, join(workspace, ".dsh")) ? "link-workspace" : "link-other") : "entity";
			candidates.push(item);
			continue;
		}
		/* 包会被加载，但这个**目录**不是加载的那份（别名目录 / 同项目第二份） */
		if (item.dirName === item.pkg) continue;
		const canonical = (dirsByPkg.get(item.pkg) || []).find((other) => other.dirName === item.pkg);
		item.provenance = canonical ? "duplicate" : "alias-only";
		item.duplicateOf = canonical ? canonical.dirName : "";
		candidates.push(item);
	}

	/* 被钉住的实体目录改记成 pinned（链接与重复安装不适用：它们本来就不该被钉）。
	   ★ 别名目录只能摘**别名键**：本机 `ghbackup` 与 `dsh-github-backup` 是同一个 link 依赖的
	     两个键，而 `dsh-github-backup` 就在 `dsh.profile.bundles` 里 —— 顺手把它从 dependencies
	     里摘掉，下次 `pnpm install` 就会把**正在加载的那份**删掉。这类"同项目两套名字"
	     必须分开说，否则清单会教人删错东西。 */
	for (const item of candidates) {
		const aliasOnly = item.provenance === "duplicate" || item.provenance === "alias-only";
		const keys = [item.dirName, item.pkg].filter((key, index, list) => {
			if (!key || list.indexOf(key) !== index) return false;
			if (!Object.prototype.hasOwnProperty.call(profileDeps, key)) return false;
			/* 被加载的那份（包名键）永远不进"可摘"清单 */
			return !(aliasOnly && key === item.pkg);
		});
		item.profileKeys = keys;
		item.profileSpecs = keys.map((key) => ({ key, spec: String(profileDeps[key]) }));
		/* 同组的包名键：只用来提醒"别动它" */
		item.keepKeys = aliasOnly && Object.prototype.hasOwnProperty.call(profileDeps, item.pkg) ? [{ key: item.pkg, spec: String(profileDeps[item.pkg]) }] : [];
		if (item.provenance === "entity" && keys.length > 0) item.provenance = "pinned";
	}
	/* 体积量不到的（例如断链）记一句原因，绝不写 0 */

	/* ── 体积 ── */
	const measure = async () => {
		const queue = candidates.slice();
		const worker = async () => {
			while (queue.length > 0) {
				const item = queue.shift();
				if (!sizeOf) {
					item.size = { bytes: null, files: 0, truncated: false };
					item.sizeWhy = "未注入 sizeOf";
					continue;
				}
				/* junction 的"可回收"是 0：删链接不省空间。真实内容体积单独量一份给人看。 */
				const target = item.link ? item.target || item.dir : item.dir;
				try {
					const measured = await sizeOf(target);
					const bytes = Number.isFinite(measured?.bytes) ? measured.bytes : null;
					item.size = { bytes, files: Number(measured?.files) || 0, truncated: Boolean(measured?.truncated) };
					item.sizeWhy = bytes === null ? "量不到（权限 / 目录不可读）" : "";
				} catch (error) {
					item.size = { bytes: null, files: 0, truncated: false };
					item.sizeWhy = "量不到：" + String(error?.message ?? error);
				}
				if (item.link) {
					item.reclaimBytes = 0;
					item.targetBytes = item.size.bytes;
				} else {
					item.reclaimBytes = item.size.bytes;
					item.targetBytes = null;
				}
			}
		};
		await Promise.all(Array.from({ length: Math.min(4, Math.max(1, queue.length)) }, worker));
	};
	await measure();

	/* ── 分组 ── */
	const candidatePkgs = new Set(candidates.map((item) => item.pkg));
	const groups = componentsOf(candidates).map((members, index) => {
		const hub = pickHub(members, candidatePkgs);
		const sorted = members.slice().sort((a, b) => (b.reclaimBytes || 0) - (a.reclaimBytes || 0) || a.dirName.localeCompare(b.dirName));
		const reclaimBytes = sorted.reduce((sum, item) => sum + (item.reclaimBytes || 0), 0);
		const linkBytes = sorted.reduce((sum, item) => sum + (item.link ? item.targetBytes || 0 : 0), 0);
		const pinned = sorted.filter((item) => item.profileKeys.length > 0);
		const duplicate = sorted.some((item) => item.provenance === "duplicate");
		const links = sorted.filter((item) => item.link);
		const steps = [];
		if (duplicate) {
			const dup = sorted.find((item) => item.provenance === "duplicate");
			steps.push({
				kind: "decide",
				text: "这一组里有**同项目的第二份安装**（`" + dup.dirName + "` → 包名 `" + dup.pkg + "`）；按包名加载的是 `node_modules/" + (dup.duplicateOf || dup.pkg) + "`。删掉这份只是清理重复，不影响加载。",
			});
		}
		if (links.length > 0) {
			steps.push({
				kind: "decide",
				text:
					links.length +
					" 个是 junction（删链接**不省空间**，默认建议**留着**）：" +
					links.map((item) => "`" + item.dirName + "` → `" + (item.target || "?") + "`（" + fmtBytes(item.targetBytes) + "）").join("；") +
					"。想让体积真的降下来，得决定工作区里那份还留不留（注意别删别的插件还在用的测试夹具）。",
			});
		}
		const keepKeys = sorted.flatMap((item) => (item.keepKeys || []).map((entry) => ({ dirName: item.dirName, ...entry })));
		if (keepKeys.length > 0) {
			steps.push({
				kind: "keep",
				text:
					"**别动这些键**：" +
					keepKeys.map((entry) => "`" + entry.key + "`（" + entry.spec + "）").join("；") +
					" —— 它们是 `dsh.profile.bundles` 里正在加载的入口（`" +
					keepKeys.map((entry) => entry.dirName).join("` / `") +
					"` 只是同一项目的别名目录）。把包名键从 dependencies 摘掉，下次安装会把正在用的那份删掉。",
			});
		}
		if (pinned.length > 0) {
			steps.push({
				kind: "edit-profile",
				text: "**先摘掉 profile 的依赖声明**，否则 `pnpm install` 会把它们装回来（" + pinned.length + " 个）：" + pinned.map((item) => "`" + item.profileKeys.join("` / `") + "`（" + item.profileSpecs.map((spec) => spec.key + ": " + spec.spec).join("；") + "）").join("；"),
				file: join("profile", "package.json"),
				keys: pinned.flatMap((item) => item.profileKeys),
			});
		}
		const removable = sorted.filter((item) => !item.link);
		const removableBytes = removable.reduce((sum, item) => sum + (item.reclaimBytes || 0), 0);
		if (removable.length > 0) {
			steps.push({
				kind: "delete",
				text: "删目录（" + removable.length + " 个，可回收 " + fmtBytes(removableBytes) + "）",
				commands: removable.map((item) => ({
					dirName: item.dirName,
					path: item.dir,
					link: false,
					command: "Remove-Item -LiteralPath '" + item.dir + "' -Recurse -Force",
				})),
			});
		}
		if (links.length > 0) {
			steps.push({
				kind: "delete-optional",
				text: "可选：只清掉挂载入口（" + links.length + " 个链接，回收 0 B；**默认不建议动**）",
				commands: links.map((item) => ({
					dirName: item.dirName,
					path: item.dir,
					link: true,
					command: "Remove-Item -LiteralPath '" + item.dir + "' -Force",
				})),
			});
		}
		steps.push({
			kind: "verify",
			text: "复核：`node dev/probe-loadstate.mjs`（dormant 应减少且六条不变式仍成立）；`node dev/probe-uninstall.mjs`（剩余候选应与现状一致）。宿主重载后打开面板确认这几条不再出现。",
		});
		return {
			key: "group-" + (index + 1) + ":" + hub.pkg,
			name: hub.pkg,
			label: sorted.length === 1 ? hub.pkg : hub.pkg + " 等 " + sorted.length + " 个",
			count: sorted.length,
			reclaimBytes,
			linkBytes,
			pinnedCount: pinned.length,
			duplicate,
			linkCount: links.length,
			kinds: [...new Set(sorted.map((item) => item.provenance))],
			members: sorted.map((item) => ({
				dirName: item.dirName,
				pkg: item.pkg,
				dir: item.dir,
				provenance: item.provenance,
				link: Boolean(item.link),
				target: item.target || "",
				duplicateOf: item.duplicateOf || "",
				profileKeys: item.profileKeys,
				profileSpecs: item.profileSpecs,
				keepKeys: item.keepKeys || [],
				reclaimBytes: item.reclaimBytes,
				targetBytes: item.targetBytes,
				bytes: item.size?.bytes ?? null,
				files: item.size?.files || 0,
				truncated: Boolean(item.size?.truncated),
				sizeWhy: item.sizeWhy || "",
				declaredBy: [], /* 下面补：还有哪些候选也声明了它 */
			})),
			steps,
		};
	});
	/* 组内"还有谁声明了它"：读清单时能知道为什么它们在同一组 */
	for (const group of groups) {
		for (const member of group.members) {
			member.declaredBy = group.members.filter((other) => other !== member && (candidates.find((item) => item.dirName === other.dirName)?.deps || []).includes(member.pkg)).map((other) => other.dirName);
		}
	}
	groups.sort((a, b) => b.reclaimBytes - a.reclaimBytes || b.count - a.count || a.name.localeCompare(b.name));

	/* 只出现在**嵌套** node_modules 里的 dormant 包：不归清单处置（跟着父包走） */
	const topPkgs = new Set(dirs.map((item) => item.pkg));
	const nestedDormant = [...loadPaths.byName.entries()].filter(([name, value]) => value.state === "dormant" && !topPkgs.has(name)).map(([name]) => name).sort();

	const reclaimBytes = groups.reduce((sum, group) => sum + group.reclaimBytes, 0);
	const linkBytes = groups.reduce((sum, group) => sum + group.linkBytes, 0);
	const plan = {
		ok: true,
		at: Date.now(),
		elapsedMs: 0,
		nodeModules,
		dormant: {
			dirCandidates: candidates.length,
			packages: loadPaths.counts.dormant || 0,
			groups: groups.length,
			reclaimBytes,
			linkBytes,
			nestedOnly: nestedDormant,
			duplicateCopies,
		},
		groups,
		profilePins: groups.flatMap((group) => group.steps.filter((step) => step.kind === "edit-profile").flatMap((step) => group.members.filter((member) => member.profileKeys.length > 0).map((member) => ({ dirName: member.dirName, pkg: member.pkg, keys: member.profileKeys, specs: member.profileSpecs })))),
		provenance: PROVENANCE,
		boundaries: [
			"判据是**声明层面**：运行时 `require(路径)` 动态加载的包看不见，所以清单写的是「不在任何加载入口上」而不是「绝对没跑」。",
			"同一个包有**多份副本**时（本机 " + duplicateCopies.length + " 个：" + (duplicateCopies.join("、") || "无") + "），依赖取**并集**：只要有一份声明了就当声明。方向是保守的 —— 宁可少判一个 dormant，也不把「会被加载的包要用的库」标成没人要（R14 就是这么抓到 `emoji-regex` 的）。",
			"hoisted 扁平 node_modules 下，一个插件可以**不声明**却 `require('lodash')` 命中。删纯库前先 `pnpm why <name>`，或在要保留的包里搜一遍 `from \"<name>\"`。",
			"只处置 node_modules **顶层**目录；嵌套在别的包里的同名副本跟着父包一起走（本机这类有 " + nestedDormant.length + " 个）。",
			"junction 删掉只少一个链接条目，**不回收它指向的体积**；那部分要动工作区源码。",
			"本清单**不会执行任何删除**：命令是给人复制粘贴的，删不删由人决定。",
			"以后想启用其中某个包：整组一起装回来（组内互相声明依赖，单装一个会缺件）。",
		],
		errors,
	};
	plan.elapsedMs = Date.now() - started;
	return plan;
}

/** 面板 /state 用的紧凑视图：不带每组 steps 的命令文本（那是点开才要的）。 */
export function summarizeUninstallPlan(plan) {
	if (!plan || plan.ok !== true) return null;
	return {
		at: plan.at,
		elapsedMs: plan.elapsedMs || 0,
		dormant: plan.dormant,
		groups: (plan.groups || []).map((group) => ({
			key: group.key,
			name: group.name,
			label: group.label,
			count: group.count,
			reclaimBytes: group.reclaimBytes,
			linkBytes: group.linkBytes,
			pinnedCount: group.pinnedCount,
			duplicate: group.duplicate,
			linkCount: group.linkCount,
			kinds: group.kinds,
		})),
	};
}

/**
 * 渲染成 Markdown（写进 `reports/uninstall-<stamp>.md`）。
 * @param {object} plan buildUninstallPlan 的结果
 * @param {{at?:number}} [options]
 */
export function renderUninstallPlan(plan, options = {}) {
	const at = new Date(Number(options.at) || Number(plan?.at) || Date.now());
	const pad = (value) => String(value).padStart(2, "0");
	const when = at.getFullYear() + "-" + pad(at.getMonth() + 1) + "-" + pad(at.getDate()) + " " + pad(at.getHours()) + ":" + pad(at.getMinutes());
	const lines = [];
	lines.push("# 「不会被加载」处置清单");
	lines.push("");
	lines.push("> 生成于 `" + when + "`（本地时间）　｜　node_modules `" + (plan?.nodeModules || "?") + "`");
	lines.push("> 由 `dsh-plugin-catalog` 生成。**本清单不执行任何删除**，命令是给人复制粘贴的。");
	lines.push("");
	const dormant = plan?.dormant || {};
	lines.push("## 一句话");
	lines.push("");
	lines.push("- 候选目录 **" + (dormant.dirCandidates || 0) + "** 个，分成 **" + (dormant.groups || 0) + "** 组；依赖图上 dormant 包共 **" + (dormant.packages || 0) + "** 个");
	if ((dormant.nestedOnly || []).length > 0) lines.push("- 其中 " + dormant.nestedOnly.length + " 个只存在于**嵌套** node_modules（" + dormant.nestedOnly.map((name) => "`" + name + "`").join("、") + "）—— 不单独处置，跟着父包一起走");
	lines.push("- 真能回收 **" + fmtBytes(dormant.reclaimBytes) + "**；另有 **" + fmtBytes(dormant.linkBytes) + "** 是链接指向的工作区/外部目录（删链接不省这部分）");
	const zeroGain = (plan?.groups || []).filter((group) => group.reclaimBytes === 0);
	if (zeroGain.length > 0) lines.push("- 其中 " + zeroGain.length + " 组删了省 0 B（链接 / 同项目第二份）：" + zeroGain.map((group) => "`" + group.label + "`").join("、") + " —— **默认建议留着**");
	lines.push("- 被 `profile/package.json` 钉住的：" + ((plan?.profilePins || []).map((pin) => "`" + pin.dirName + "`").join("、") || "无"));
	lines.push("");
	lines.push("## 为什么分类，而不是一个「删」字");
	lines.push("");
	lines.push("| 分类 | 含义 | 处置 |");
	lines.push("|---|---|---|");
	for (const [key, value] of Object.entries(PROVENANCE)) lines.push("| `" + key + "` | " + value.label + " | " + value.hint + " |");
	lines.push("");
	for (const group of plan?.groups || []) {
		lines.push("## " + group.label + "　（" + group.count + " 个 · 可回收 " + fmtBytes(group.reclaimBytes) + (group.linkBytes > 0 ? " · 链接 " + fmtBytes(group.linkBytes) : "") + "）");
		lines.push("");
		lines.push("| 目录 | 包名 | 分类 | 可回收 | 出现在 profile 依赖 | 同组内被谁声明 |");
		lines.push("|---|---|---|---:|---|---|");
		for (const member of group.members) {
			lines.push(
				"| `" + member.dirName + "` | `" + member.pkg + "` | " + (PROVENANCE[member.provenance]?.label || member.provenance) + " | " + (member.link ? "0（链接；目标 " + fmtBytes(member.targetBytes) + "）" : fmtBytes(member.reclaimBytes)) + " | " + (member.profileKeys.length > 0 ? "`" + member.profileKeys.join("` / `") + "`" : (member.keepKeys || []).length > 0 ? "（无；但**别动** `" + member.keepKeys.map((entry) => entry.key).join("` / `") + "`）" : "—") + " | " + (member.declaredBy.length > 0 ? member.declaredBy.map((name) => "`" + name + "`").join("、") : "—") + " |",
			);
		}
		lines.push("");
		const number = ["①", "②", "③", "④", "⑤", "⑥"];
		let index = 0;
		for (const step of group.steps) {
			const mark = number[index] || "·";
			index += 1;
			lines.push(mark + " " + step.text);
			lines.push("");
			if (Array.isArray(step.commands) && step.commands.length > 0) {
				lines.push("```powershell");
				for (const item of step.commands) lines.push(item.command);
				lines.push("```");
				lines.push("");
			}
		}
	}
	lines.push("## 边界（这些话说在前面）");
	lines.push("");
	for (const line of plan?.boundaries || []) lines.push("- " + line);
	lines.push("");
	if ((plan?.errors || []).length > 0) {
		lines.push("## 扫描时的小问题");
		lines.push("");
		for (const error of plan.errors.slice(0, 20)) lines.push("- `" + (error.dir || "?") + "`：" + error.error);
		lines.push("");
	}
	lines.push("## 怎么复核");
	lines.push("");
	lines.push("```bash");
	lines.push("node dev/probe-loadstate.mjs   # 六条不变式（判据本身没跑偏）");
	lines.push("node dev/probe-uninstall.mjs   # 这份计划本身：覆盖 / 不重叠 / 分类与体积自洽");
	lines.push("```");
	lines.push("");
	return lines.join("\n");
}

/**
 * 删除预演（R16）：在**内存里**把包从依赖图上摘掉，重算加载态，回答「真删了会怎样」。
 *
 * ★ 为什么要有它：R14 的清单回答的是"这些现在不会被加载、删了能省多少"，
 *   它**没有回答**"删完以后会不会有东西指空"。两个真会咬人的坑都能先在内存里算出来：
 *     · 要删的包其实挂在 `bundles` / 配置条目上 → 删完入口悬空，下次启动就是一串缺包；
 *     · 保留的包声明了它 → 扁平 node_modules 下 `require('<它>')` 直接失败，比入口悬空更难查。
 *   没必要真删一次才知道。
 *
 * ★ 它**不是**「删吧没问题」的背书：判据仍停在声明层面（模块头那三条边界原样适用）。
 *   特别是 `dangling` 把 optional/peer 也算进去了 —— 那一类有时只是软依赖，要人看一眼。
 *
 * @param {object} input
 * @param {Map<string,string[]>|Record<string,string[]>} input.installed 包名 → 它声明的依赖
 * @param {string[]} [input.bundles]     `dsh.profile.bundles`
 * @param {Array<{id:string,name:string,disabled:boolean}>} [input.compositions] 组合文件条目
 * @param {Array<{dirName:string,pkg:string}>} [input.dirs] 已装的目录
 *        ★ 一个包名可能对应**多个目录**（同项目第二份 / 别名目录：本机 `ghbackup` 与
 *          `dsh-github-backup` 目录是同一个包名）。按包名整体删会误伤**正在被加载**的那一份，
 *          所以有 dirs 时按目录算：只有这个包名下的**所有**目录都在名单里，才真的算摘掉。
 * @param {string[]} [input.remove]      要摘掉的**目录名或包名**（重复/空白会去重）
 * @returns {{ok:boolean, remove:string[], removedDirs:string[], unknown:string[], before:object, after:object,
 *   breaking:Array<object>, brokenEntries:Array<object>, dangling:Array<object>,
 *   demoted:Array<object>, revived:Array<object>, verdict:string, at:number}}
 */
export function simulateRemoval(input) {
	const installed = input?.installed instanceof Map ? input.installed : new Map(Object.entries(input?.installed || {}));
	const bundles = Array.isArray(input?.bundles) ? input.bundles : [];
	const compositions = Array.isArray(input?.compositions) ? input.compositions : [];
	const dirList = Array.isArray(input?.dirs) ? input.dirs.filter((item) => item && item.dirName && item.pkg) : [];
	const dirsByPkg = new Map();
	for (const item of dirList) {
		if (!dirsByPkg.has(item.pkg)) dirsByPkg.set(item.pkg, []);
		dirsByPkg.get(item.pkg).push(item.dirName);
	}
	const knownDirs = new Set(dirList.map((item) => item.dirName));
	const wanted = [...new Set((Array.isArray(input?.remove) ? input.remove : []).map((name) => String(name ?? "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
	/* 名字可以指目录（精确到那一份），也可以指包（= 这个包名的所有目录一起删） */
	const unknown = [];
	const removeDirs = new Set();
	for (const name of wanted) {
		if (knownDirs.has(name)) {
			removeDirs.add(name);
			continue;
		}
		if (!installed.has(name)) {
			unknown.push(name);
			continue;
		}
		const all = dirsByPkg.get(name) || [];
		if (all.length === 0) removeDirs.add(name);
		else for (const dirName of all) removeDirs.add(dirName);
	}
	/* 真正摘掉的包：它名下的目录**全部**在名单里（还有一份留在盘上，require 依旧命中） */
	const remove = [];
	for (const name of installed.keys()) {
		const all = dirsByPkg.get(name) || [];
		if (all.length === 0) {
			if (removeDirs.has(name)) remove.push(name);
			continue;
		}
		if (all.every((dirName) => removeDirs.has(dirName))) remove.push(name);
	}
	remove.sort((a, b) => a.localeCompare(b));
	const removedDirs = [...removeDirs].sort((a, b) => a.localeCompare(b));
	const removed = new Set(remove);
	const before = resolveLoadPaths({ bundles, compositions, installed });
	const afterMap = new Map([...installed].filter(([name]) => !removed.has(name)));
	const after = resolveLoadPaths({ bundles, compositions, installed: afterMap });
	const stateOf = (paths, name) => paths.byName.get(name) || { state: "dormant", via: "" };
	const sizeOf = (paths) => Object.values(paths.counts).reduce((sum, count) => sum + (Number(count) || 0), 0);

	/* ① 这些包现在**会被加载**吗 —— 会被加载的本来就不该进删除名单 */
	const breaking = remove
		.map((name) => ({ name, ...stateOf(before, name) }))
		.filter((item) => isLoadedState(item.state))
		.sort((a, b) => a.name.localeCompare(b.name));

	/* ② 删完以后哪些**入口**指空：bundles 条目 / 配置条目还写着它
	   ★ 不能从 `after.roots` 里挑：`resolveLoadPaths` 只把**已装**的配置条目算作入口
	     （`if (!has(entry.name)) continue`），删掉的包恰好不会出现在 after.roots 里。
	     所以这里直接对着 bundles 与组合文件条目查。 */
	const bundleSet = new Set(bundles);
	const brokenEntries = [];
	const seenEntry = new Set();
	for (const name of remove) {
		const inBundle = bundleSet.has(name);
		const entry = compositions.find((item) => item && item.name === name && !item.disabled);
		if (!inBundle && !entry) continue;
		const key = name + "|" + (inBundle ? "bundle" : "config");
		if (seenEntry.has(key)) continue;
		seenEntry.add(key);
		brokenEntries.push({ name, why: inBundle ? "bundle" : "config", id: entry?.id ?? "" });
	}
	brokenEntries.sort((a, b) => a.name.localeCompare(b.name) || a.why.localeCompare(b.why));

	/* ③ 保留的包里还有谁声明了被删的包（声明层面；含 optional / peer） */
	const dangling = [];
	for (const [from, deps] of afterMap) {
		for (const dep of deps || []) if (removed.has(dep)) dangling.push({ from, dep });
	}
	dangling.sort((a, b) => a.from.localeCompare(b.from) || a.dep.localeCompare(b.dep));

	/* ④ 只因这些包才被点亮的 transitive：删完会掉回 dormant（还得再清一轮） */
	const demoted = [];
	const revived = [];
	for (const [name, value] of after.byName) {
		const was = stateOf(before, name);
		if (value.state === "dormant" && isLoadedState(was.state)) demoted.push({ name, state: was.state, via: was.via || "" });
		/* 摘边不可能凭空点亮谁 —— 这条恒等式必须永远为空，probe 拿它当不变式 */
		if (isLoadedState(value.state) && was.state === "dormant") revived.push({ name, state: value.state });
	}
	demoted.sort((a, b) => a.name.localeCompare(b.name));
	revived.sort((a, b) => a.name.localeCompare(b.name));

	const verdict = breaking.length === 0 && brokenEntries.length === 0 && dangling.length === 0 ? "safe" : "risky";
	return {
		ok: true,
		at: Date.now(),
		remove,
		removedDirs,
		unknown,
		before: { counts: before.counts, total: sizeOf(before) },
		after: { counts: after.counts, total: sizeOf(after) },
		breaking,
		brokenEntries,
		dangling,
		demoted,
		revived,
		verdict,
	};
}

/* ─────────────────────── R27：执行并复核（对账） ─────────────────────── */

/** 对账查到的问题类型 → 一句人话（面板与报告共用一处措辞）。 */
export const VERIFY_REASON = Object.freeze({
	bundle: "还在 `dsh.profile.bundles` 里 —— 启动会去找它，入口指空",
	config: "还有**没关掉**的配置条目写着它 —— 启动会试着挂载",
	pinned: "`profile/package.json` 还声明着它 —— 下次 `pnpm install` 会装回来",
	"declared-outside": "组外还有已装的包声明它 —— 那个包现在是半坏的",
	nowLoaded: "今天它**已经会被加载**了 —— 当初「删了不影响」的前提没了",
	nowDeclared: "今天组外有包声明它 —— 单删它会连累那个包",
});

/** 对账结论 → 一句话（`verdict` 只在这里翻译成人话）。 */
export const VERIFY_VERDICT = Object.freeze({
	noplan: "计划里一个成员都没有 —— 不是「都删干净了」，是这份计划本身没内容",
	intact: "一个都还在盘上 —— 计划还没被执行（或执行了又被装回来）",
	clean: "计划里的都删干净了，且没有任何东西还引用它们",
	fake: "有成员**删了等于白删**：还有入口/依赖键引用它，会被装回来或指空",
	partial: "删了一部分，剩下的一批还能继续处置",
});

/**
 * 处置清单的**执行并复核**：拿一份计划（`reports/uninstall-*.json` 原样即可）与**今天的**事实对账。
 *
 * 回答的是人删完以后真正会问的三个问题（顺序即优先级）：
 *   ① 计划里的目录，现在还在不在盘上？—— `presence`（gone / still）
 *   ② 已经删掉的，还有东西引用这个名字吗？—— `fakeGone`（**删了等于白删**）
 *   ③ 还没删的，计划还成立吗？—— `drift`（今天已经会被加载 / 今天组外有包声明它）
 *
 * ★ 判据只有两处来源，不许各写一份：
 *   「会不会被加载 / 入口会不会指空 / 谁声明了谁」一律走 `resolveLoadPaths`（与 R16 同一个）；
 *   「目录在不在」由调用方**注入** `presence` —— 本模块不碰磁盘（`dev/audit.mjs` 拿这条当契约）。
 * ★ `presence` 缺失时一律当「还在」：宁可少报"已经删了"，也不许凭空宣布一个目录消失了。
 * ★ 组内互相声明**不是**失守：计划就是按弱连通分量分组的，整组会一起走。
 *
 * @param {object} plan  `buildUninstallPlan` 的结果
 * @param {{presence?:(dirName:string)=>boolean, installed?:Map<string,string[]>|Record<string,string[]>,
 *   bundles?:string[], compositions?:Array<object>, profileDeps?:Record<string,string>, now?:number}} [input]
 * @returns {{ok:boolean, at:number, now:number, ageMs:number, verdict:string, counts:object,
 *   members:Array<object>, fakeGone:Array<object>, drift:Array<object>, boundaries:string[]}}
 */
export function verifyUninstallPlan(plan, input = {}) {
	const groups = Array.isArray(plan?.groups) ? plan.groups : [];
	const members = [];
	const seen = new Set();
	for (const group of groups) {
		for (const member of Array.isArray(group?.members) ? group.members : []) {
			const dirName = String(member?.dirName || "").trim();
			if (dirName === "" || seen.has(dirName)) continue;
			seen.add(dirName);
			members.push({
				dirName,
				pkg: String(member?.pkg || dirName),
				groupLabel: String(group?.label || ""),
				provenance: String(member?.provenance || ""),
				link: member?.link === true,
				reclaimBytes: Number(member?.reclaimBytes) || 0,
				profileKeys: Array.isArray(member?.profileKeys) ? member.profileKeys.map(String) : [],
			});
		}
	}

	const installed = input?.installed instanceof Map ? input.installed : new Map(Object.entries(input?.installed || {}));
	const bundles = Array.isArray(input?.bundles) ? input.bundles.map(String) : [];
	const compositions = Array.isArray(input?.compositions) ? input.compositions : [];
	const profileDeps = input?.profileDeps && typeof input.profileDeps === "object" ? input.profileDeps : {};
	const now = Number(input?.now) || Date.now();
	const presence = typeof input?.presence === "function" ? input.presence : () => true;

	const bundleSet = new Set(bundles);
	const profileKeySet = new Set(Object.keys(profileDeps));
	/* 只看**没关掉**的条目：`disabled: true` 的条目启动时不会去挂包，不该算"还指着它"。 */
	const configNames = new Set(
		compositions
			.filter((item) => item && !item.disabled)
			.map((item) => String(item.name || ""))
			.filter(Boolean),
	);
	/* 今天的「谁声明了它」：组内互声明是预期，只有组外才算失守。 */
	const declaredBy = new Map();
	for (const [from, deps] of installed) {
		for (const dep of deps || []) {
			if (!declaredBy.has(dep)) declaredBy.set(dep, []);
			declaredBy.get(dep).push(String(from));
		}
	}
	const before = resolveLoadPaths({ bundles, compositions, installed });
	const stateOf = (name) => before.byName.get(name) || { state: "dormant", via: "" };
	const memberNames = new Set();
	for (const member of members) {
		memberNames.add(member.dirName);
		memberNames.add(member.pkg);
	}
	const outsideDeclarers = (member) =>
		(declaredBy.get(member.pkg) || [])
			.filter((from) => from !== member.pkg && !memberNames.has(from))
			.sort((a, b) => a.localeCompare(b));

	const rows = [];
	for (const member of members) {
		const present = presence(member.dirName) !== false;
		const row = { ...member, presence: present ? "still" : "gone", reasons: [], drift: [], state: "", via: "", declarers: [] };
		const outside = outsideDeclarers(member);
		row.declarers = outside.slice(0, 8);
		if (!present) {
			if (bundleSet.has(member.pkg) || bundleSet.has(member.dirName)) row.reasons.push("bundle");
			if (configNames.has(member.pkg) || configNames.has(member.dirName)) row.reasons.push("config");
			if (profileKeySet.has(member.pkg) || profileKeySet.has(member.dirName) || member.profileKeys.includes(member.pkg)) row.reasons.push("pinned");
			if (outside.length > 0) row.reasons.push("declared-outside");
		} else {
			/* 别名目录（`ghbackup` → `dsh-github-backup`）：两个名字都要看，取"会被加载"那个为准。 */
			const primary = stateOf(member.pkg);
			const secondary = member.dirName === member.pkg ? primary : stateOf(member.dirName);
			const chosen = isLoadedState(primary.state) || !isLoadedState(secondary.state) ? primary : secondary;
			row.state = chosen.state;
			row.via = chosen.via || "";
			if (isLoadedState(row.state)) row.drift.push("nowLoaded");
			if (outside.length > 0) row.drift.push("nowDeclared");
		}
		rows.push(row);
	}

	const gone = rows.filter((row) => row.presence === "gone");
	const still = rows.filter((row) => row.presence === "still");
	const fakeGone = gone.filter((row) => row.reasons.length > 0);
	const drift = rows.filter((row) => row.drift.length > 0);
	const sumOf = (list) => list.reduce((sum, row) => sum + (Number(row.reclaimBytes) || 0), 0);
	/* 链接成员的可回收恒为 0（删 junction 不省空间）—— R14 的判据，这里不另立一条。 */
	const reclaimedBytes = sumOf(gone.filter((row) => !row.link));
	const remainingBytes = sumOf(still.filter((row) => !row.link));
	const linkBytes = sumOf(rows.filter((row) => row.link));

	let verdict = "partial";
	if (rows.length === 0) verdict = "noplan";
	else if (gone.length === 0) verdict = "intact";
	else if (fakeGone.length > 0) verdict = "fake";
	else if (still.length === 0) verdict = "clean";

	const at = Number(plan?.at) || 0;
	return {
		ok: true,
		at,
		now,
		ageMs: at > 0 ? Math.max(0, now - at) : 0,
		nodeModules: String(plan?.nodeModules || ""),
		verdict,
		counts: {
			total: rows.length,
			gone: gone.length,
			still: still.length,
			fakeGone: fakeGone.length,
			drift: drift.length,
			reclaimedBytes,
			remainingBytes,
			linkBytes,
		},
		members: rows,
		fakeGone,
		drift,
		boundaries: [
			"「目录在不在」只 stat 计划里点名的那些目录（不会去遍历 node_modules）。",
			"「还会不会指空」是**声明层面**（bundles / 未关掉的配置条目 / `profile` 依赖键）：运行时按路径 `require()` 看不见。",
			"组内互相声明不算失守 —— 计划按弱连通分量分组，整组一起走才是预期。",
			"**对账不改任何东西**：不删目录、不摘依赖键、不写盘（要文件得另外带 confirm:true）。",
		],
	};
}

/**
 * 渲染成 Markdown（写进 `reports/uninstall-verify-<stamp>.md`）。
 * @param {object} result verifyUninstallPlan 的结果
 * @param {{at?:number}} [options]
 */
export function renderVerifyReport(result, options = {}) {
	const at = new Date(Number(options.at) || Number(result?.now) || Date.now());
	const pad = (value) => String(value).padStart(2, "0");
	const when = at.getFullYear() + "-" + pad(at.getMonth() + 1) + "-" + pad(at.getDate()) + " " + pad(at.getHours()) + ":" + pad(at.getMinutes());
	const planAt = Number(result?.at) || 0;
	const ageDays = planAt > 0 ? ((Number(result?.now) || Date.now()) - planAt) / 86400000 : 0;
	const planWhen = planAt > 0 ? new Date(planAt) : null;
	const planText = planWhen
		? planWhen.getFullYear() + "-" + pad(planWhen.getMonth() + 1) + "-" + pad(planWhen.getDate()) + " " + pad(planWhen.getHours()) + ":" + pad(planWhen.getMinutes())
		: "?";
	const counts = result?.counts || {};
	const lines = [];
	lines.push("# 处置清单 · 执行并复核（对账）");
	lines.push("");
	lines.push("> 对账于 `" + when + "`（本地时间）　｜　计划生成于 `" + planText + "`" + (planAt > 0 ? "（" + ageDays.toFixed(1) + " 天前）" : ""));
	lines.push("> 由 `dsh-plugin-catalog` 生成。**本报告不改任何东西** —— 不删目录、不摘依赖键。");
	lines.push("");
	lines.push("## 一句话");
	lines.push("");
	lines.push("- 结论：**" + (VERIFY_VERDICT[result?.verdict] || String(result?.verdict || "")) + "**");
	lines.push("- 计划成员 **" + (counts.total || 0) + "** 个：已不在盘上 **" + (counts.gone || 0) + "**，还在 **" + (counts.still || 0) + "**，其中**白删** " + (counts.fakeGone || 0) + " 个");
	lines.push("- 计划过期（今天的事实不再支持当初的判断）**" + (counts.drift || 0) + "** 个");
	lines.push("- 已经回收 **" + fmtBytes(counts.reclaimedBytes || 0) + "**；还能回收 **" + fmtBytes(counts.remainingBytes || 0) + "**" + (counts.linkBytes > 0 ? "；另有 " + fmtBytes(counts.linkBytes) + " 在链接目标里（删链接不省这部分）" : ""));
	lines.push("");
	lines.push("## 删了等于白删（最要紧）");
	lines.push("");
	if ((result?.fakeGone || []).length === 0) {
		lines.push("无。");
	} else {
		lines.push("| 目录 | 包名 | 为什么白删 |");
		lines.push("|---|---|---|");
		for (const row of result.fakeGone) {
			lines.push("| `" + row.dirName + "` | `" + row.pkg + "` | " + row.reasons.map((reason) => VERIFY_REASON[reason] || reason).join("；") + " |");
		}
	}
	lines.push("");
	lines.push("## 计划过期（成员还在，但当初的理由变了）");
	lines.push("");
	if ((result?.drift || []).length === 0) {
		lines.push("无。");
	} else {
		lines.push("| 目录 | 包名 | 今天的状态 | 变了什么 |");
		lines.push("|---|---|---|---|");
		for (const row of result.drift) {
			lines.push("| `" + row.dirName + "` | `" + row.pkg + "` | " + (row.state || "—") + (row.via ? " · " + row.via : "") + " | " + row.drift.map((kind) => VERIFY_REASON[kind] || kind).join("；") + (row.declarers.length > 0 ? "（" + row.declarers.map((name) => "`" + name + "`").join("、") + "）" : "") + " |");
		}
	}
	lines.push("");
	lines.push("## 逐成员");
	lines.push("");
	lines.push("| 目录 | 包名 | 分组 | 盘上 | 可回收 | 引用它的东西 |");
	lines.push("|---|---|---|---|---:|---|");
	for (const row of result?.members || []) {
		lines.push(
			"| `" + row.dirName + "` | `" + row.pkg + "` | " + (row.groupLabel || "—") + " | " + (row.presence === "gone" ? "已不在" : "在") + " | " + (row.link ? "0（链接）" : fmtBytes(row.reclaimBytes)) + " | " + ([...row.reasons, ...row.drift].map((kind) => VERIFY_REASON[kind] || kind).join("；") || "—") + " |",
		);
	}
	lines.push("");
	lines.push("## 边界（这些话说在前面）");
	lines.push("");
	for (const line of result?.boundaries || []) lines.push("- " + line);
	lines.push("");
	return lines.join("\n");
}

export { fmtBytes };
