/**
 * staging.mjs — Skill 的「两份副本」判据（**唯一真源**）。
 *
 * 为什么单独抽一个模块：同一套判据有两个使用方 ——
 *   ① `lib/service.mjs`：面板/Skill 浮窗/`catalog_skill_sync` 工具（要的是"哪一个旧了"）；
 *   ② `dev/ship.mjs`       ：发版体检的第 4 项（要的是"交接前这台机器上还有几个是旧的"）。
 * 两处各写一份的话迟早会漂：一边按 size+mtime 判、另一边按内容长度判，
 * 于是"面板说一致、体检说旧了"。所以比较规则只写在这里，两边都 import。
 *
 * 判据（与 `compareFingerprints` 同口径，只是文件数固定为 1）：
 *   两边都没有 → absent（不进任何列表）
 *   只有 live 有  → missing-staged（staging 里没有 SKILL.md = 发布出去是空壳）→ **算旧**
 *   只有 staging 有 → missing-loaded（加载的那份没 SKILL.md，DSH 根本读不到）→ 算不一致
 *   size 不同    → differs（**不读内容**：SKILL.md 动一个字 size 就变，读内容纯属浪费）
 *   时间差 > 60 秒 → newer-loaded / newer-workspace；否则 same
 *
 * @module dsh-plugin-catalog/staging
 */

import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** 每个 Skill 只比这一个文件。 */
export const SKILL_FILE = "SKILL.md";

/**
 * 时间容差（毫秒）。
 * ★ 60 秒不是随手取的：两边几乎同时写入时（同步脚本刚跑完、编辑器还在 flush），
 *   毫秒级差异会把"同一份"误报成"一边更新"。与 service 的 DRIFT_MTIME_TOLERANCE 同值。
 */
export const SKILL_MTIME_TOLERANCE_MS = 60 * 1000;

/** 算「旧了」的判定集合：这几种 verdict 下，推上去的都是旧版或空壳。 */
export const STALE_VERDICTS = Object.freeze(["differs", "newer-loaded", "missing-staged"]);

/**
 * 读一个 Skill 目录里 SKILL.md 的指纹（size + mtime）。
 * 目录不存在 / 没有 SKILL.md / 读不到，一律 null —— **绝不返回 0 字节**（那是三种不同的东西）。
 * @param {string} dir
 * @returns {Promise<{size:number, mtimeMs:number}|null>}
 */
export async function skillStat(dir) {
	if (!dir) return null;
	try {
		const info = await stat(join(dir, SKILL_FILE));
		if (!info.isFile()) return null;
		return { size: info.size, mtimeMs: info.mtimeMs };
	} catch {
		return null;
	}
}

/**
 * 纯函数：两份指纹 → 判定。**不碰文件系统**，所以自检可以直接枚举边界。
 * @param {{size:number,mtimeMs:number}|null} loaded
 * @param {{size:number,mtimeMs:number}|null} staged
 * @returns {{verdict:string, differs:string[]}}
 */
export function skillVerdict(loaded, staged) {
	if (!loaded && !staged) return { verdict: "absent", differs: [] };
	if (!loaded) return { verdict: "missing-loaded", differs: [SKILL_FILE + "（staging 有、加载的那份没有）"] };
	if (!staged) return { verdict: "missing-staged", differs: [SKILL_FILE + "（加载的那份有、staging 没有）"] };
	if (Number(loaded.size) !== Number(staged.size)) return { verdict: "differs", differs: [SKILL_FILE] };
	const delta = Number(staged.mtimeMs || 0) - Number(loaded.mtimeMs || 0);
	if (Math.abs(delta) <= SKILL_MTIME_TOLERANCE_MS) return { verdict: "same", differs: [] };
	return { verdict: delta > 0 ? "newer-workspace" : "newer-loaded", differs: [] };
}

/** 这个 verdict 是否意味着「推上去的是旧版/空壳」。 */
export function isStaleVerdict(verdict) {
	return STALE_VERDICTS.includes(String(verdict));
}

/**
 * 扫一遍「DSH 加载的 skills 目录」与「上传用的 staging 目录」。
 *
 * 只看**同名**对：staging 里没有这个 Skill = 还没发布过，不是"旧了"，单独归到 `missing`。
 * 名字以 `.` 开头的跳过（`.bak-*` 迁移残留不是真 Skill，catalog 也是这么隐藏的）。
 *
 * @param {{roots?: string[], stageDir?: string, limit?: number}} [options]
 * @returns {Promise<{ok:boolean, pairs:number, stale:object[], same:number, newerStaged:number, missing:number, skills:object[]}>}
 */
export async function scanSkillStaging(options = {}) {
	const roots = Array.isArray(options.roots) ? options.roots.filter(Boolean) : [];
	const stageDir = String(options.stageDir || "");
	const limit = Math.max(1, Math.min(5000, Number(options.limit) || 2000));

	/* live 侧：先收集所有「有 SKILL.md 的目录」，同名只认第一个根（roots 的顺序就是优先级） */
	const live = new Map();
	for (const root of roots) {
		let entries = [];
		try {
			entries = await readdir(root, { withFileTypes: true });
		} catch {
			continue; /* 这个根不存在（本机三处都有，别的机器不一定） */
		}
		for (const entry of entries) {
			if (live.size >= limit) break;
			if (!entry.name || entry.name.startsWith(".")) continue;
			/* ★ 不用 entry.isDirectory()：Windows 上 junction 的 isDirectory() 是 false，
			   而 Skill 目录有可能是 junction（本机踩过这个坑）。直接 stat SKILL.md 才可靠。 */
			const dir = join(root, entry.name);
			const info = await skillStat(dir);
			if (!info) continue;
			if (!live.has(entry.name)) live.set(entry.name, { name: entry.name, dir, stat: info });
		}
	}

	const skills = [];
	let missing = 0;
	if (stageDir) {
		for (const item of live.values()) {
			const stagedDir = join(stageDir, item.name);
			const staged = await skillStat(stagedDir);
			if (!staged) {
				/* 同名 staging 目录存在但没有 SKILL.md → 空壳（算旧）；目录都没有 → 还没发布（单列） */
				const dirExists = await pathIsDir(stagedDir);
				if (dirExists) {
					skills.push({ name: item.name, verdict: "missing-staged", loadedDir: item.dir, stagedDir, differs: [SKILL_FILE], loadedBytes: item.stat.size, stagedBytes: null });
				} else {
					missing += 1;
				}
				continue;
			}
			const verdict = skillVerdict(item.stat, staged);
			if (verdict.verdict === "absent") continue;
			skills.push({ name: item.name, verdict: verdict.verdict, loadedDir: item.dir, stagedDir, differs: verdict.differs, loadedBytes: item.stat.size, stagedBytes: staged.size });
		}
	}

	const stale = skills.filter((item) => isStaleVerdict(item.verdict));
	const butNewerStaged = skills.filter((item) => item.verdict === "newer-workspace");
	const same = skills.filter((item) => item.verdict === "same");
	return {
		ok: true,
		pairs: skills.length,
		stale,
		same: same.length,
		newerStaged: butNewerStaged.length,
		missing,
		skills,
	};
}

async function pathIsDir(path) {
	try {
		const info = await stat(path);
		return info.isDirectory();
	} catch {
		return false;
	}
}

/** 备份后缀用的时间戳：20261023-191500（与旧版 `.bak-<stamp>` 同格式，回滚时认得出来）。 */
export function skillStamp(now = new Date()) {
	const pad = (n) => String(n).padStart(2, "0");
	return now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + "-" + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
}

/**
 * 单向复制一份 SKILL.md：**live → staging**，先把 staging 那份备份成 `.bak-<stamp>`。
 *
 * 铁律：只许这个方向。反向（staging → live）会把线上正在加载的那份覆盖成旧版 ——
 * 那正是"改了没生效"的另一半来源，所以本模块刻意不提供。
 *
 * @param {{loadedDir:string, stagedDir:string, stamp?:string}} options
 * @returns {Promise<{ok:true, backup:string, bytes:number}>}
 */
export async function copySkillToStaging(options = {}) {
	const loadedDir = String(options.loadedDir || "");
	const stagedDir = String(options.stagedDir || "");
	if (!loadedDir || !stagedDir) throw new Error("copySkillToStaging 需要 loadedDir 与 stagedDir");
	const source = join(loadedDir, SKILL_FILE);
	const target = join(stagedDir, SKILL_FILE);
	const stamp = String(options.stamp || skillStamp());
	await mkdir(stagedDir, { recursive: true });
	let backup = "";
	try {
		const candidate = target + ".bak-" + stamp;
		await copyFile(target, candidate);
		backup = candidate;
	} catch {
		/* 目标不存在（staging 是新拉的空目录）就没有备份可做 —— 这不是失败 */
	}
	await copyFile(source, target);
	const info = await stat(target);
	return { ok: true, backup, bytes: info.size };
}
