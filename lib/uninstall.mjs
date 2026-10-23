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

import { DEP_KEYS, parseComposition, resolveLoadPaths, scanInstalledPackages } from "./loadstate.mjs";

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

export { fmtBytes };
