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
 *   正文哈希相同 → same（**哈希优先于 mtime**：同一份内容不管谁先写，都是同一份）
 *   size 不同    → differs
 *   size 相同但哈希不同（R20）→ 再看时间：
 *       |差| ≤ 60 秒 → **differs**（同字数改一个字，老口径会误判成 same —— 这正是要修的）
 *       staging 更新 → newer-workspace；live 更新 → newer-loaded
 *   至少一边读不到哈希（权限/编码）→ 退回 R20 之前的老口径（size + mtime）
 *
 * ★ R20 为什么敢读正文：SKILL.md 只有 ~20KB，17 对 × 2 份 ≈ 680KB；哈希一次 <10ms。
 *   老注释说"读内容纯属浪费"是按**发布体检**的频率估的，但面板 /state 每 20 秒轮询一次
 *   也走这份缓存（60 秒），实测这点读取根本量不出来 —— 而漏判一份旧副本的代价是发错版。
 *
 * @module dsh-plugin-catalog/staging
 */

import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";

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
 * 正文哈希：sha1 前 12 位十六进制。**与 `lib/catalog.mjs` 给目录条目算的是同一个算法**，
 * 所以「历史快照里的 contentHash」与「staging 判据里的 hash」可以直接对照。
 * @param {string} text
 * @returns {string}
 */
export function hashSkillText(text) {
	return createHash("sha1").update(String(text ?? ""), "utf8").digest("hex").slice(0, 12);
}

/**
 * 读一个 Skill 目录里 SKILL.md 的指纹（size + mtime + 正文哈希）。
 * 目录不存在 / 没有 SKILL.md / 读不到，一律 null —— **绝不返回 0 字节**（那是三种不同的东西）。
 * 读得到文件但读不到内容（极少见）→ hash:null，判据会退回 size + mtime。
 * @param {string} dir
 * @returns {Promise<{size:number, mtimeMs:number, hash:string|null}|null>}
 */
export async function skillStat(dir) {
	if (!dir) return null;
	const file = join(dir, SKILL_FILE);
	try {
		const info = await stat(file);
		if (!info.isFile()) return null;
		let hash = null;
		try {
			hash = hashSkillText(await readFile(file, "utf8"));
		} catch {
			hash = null; /* 读不到内容不改判「不存在」：文件是在的，只是这一份没法比正文 */
		}
		return { size: info.size, mtimeMs: info.mtimeMs, hash };
	} catch {
		return null;
	}
}

/**
 * 纯函数：两份指纹 → 判定。**不碰文件系统**，所以自检可以直接枚举边界。
 * ★ R20：两边都有哈希时**哈希优先** —— 内容相同就是 same（mtime 差异是噪音）；
 *   内容不同且 size 相同，才用 mtime 决定"哪边更新"；|差| ≤ 60 秒直接判 differs。
 * @param {{size:number,mtimeMs:number,hash?:string|null}|null} loaded
 * @param {{size:number,mtimeMs:number,hash?:string|null}|null} staged
 * @returns {{verdict:string, differs:string[]}}
 */
export function skillVerdict(loaded, staged) {
	if (!loaded && !staged) return { verdict: "absent", differs: [] };
	if (!loaded) return { verdict: "missing-loaded", differs: [SKILL_FILE + "（staging 有、加载的那份没有）"] };
	if (!staged) return { verdict: "missing-staged", differs: [SKILL_FILE + "（加载的那份有、staging 没有）"] };
	const loadedHash = loaded.hash ? String(loaded.hash) : "";
	const stagedHash = staged.hash ? String(staged.hash) : "";
	if (loadedHash && stagedHash && loadedHash === stagedHash) return { verdict: "same", differs: [] };
	if (Number(loaded.size) !== Number(staged.size)) return { verdict: "differs", differs: [SKILL_FILE] };
	const delta = Number(staged.mtimeMs || 0) - Number(loaded.mtimeMs || 0);
	if (loadedHash && stagedHash) {
		/* 同字数、不同正文：这才是老口径会漏掉的那种「改了一个字」 */
		if (Math.abs(delta) <= SKILL_MTIME_TOLERANCE_MS) return { verdict: "differs", differs: [SKILL_FILE] };
		return { verdict: delta > 0 ? "newer-workspace" : "newer-loaded", differs: [] };
	}
	/* 至少一边没有哈希（读不到内容）：退回老口径，宁可漏判也不误报 */
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

/* ───────────────────────── R20：staging 的历史备份与还原 ───────────────────────── */

/**
 * 备份文件名：`SKILL.md.bak-20261024-135500`，同一秒里第二次写入退化成 `…-2`。
 * 只认这个格式 —— 还原接口拿到别的名字（尤其是带路径的）必须拒绝。
 */
export const BACKUP_FILE_RE = /^SKILL\.md\.bak-(\d{8}-\d{6})(?:-(\d+))?$/;

/** 从备份名里取出时间戳与同秒序号；不是备份名 → null。 */
export function backupStampOf(name) {
	const match = BACKUP_FILE_RE.exec(String(name || ""));
	if (!match) return null;
	return { stamp: match[1], copy: match[2] ? Number(match[2]) : 0 };
}

/** 备份名排序：时间戳新的在前；同一秒里 `-2` 比无后缀的新（它是后来那次覆盖留下的）。 */
export function compareBackupNames(a, b) {
	const left = backupStampOf(a);
	const right = backupStampOf(b);
	if (!left && !right) return 0;
	if (!left) return 1;
	if (!right) return -1;
	if (left.stamp !== right.stamp) return left.stamp < right.stamp ? 1 : -1;
	return right.copy - left.copy;
}

/** 纯函数：一串文件名里挑最新的一份备份（不是备份名的一律忽略）。 */
export function pickLatestBackup(names) {
	const valid = (Array.isArray(names) ? names : []).filter((name) => backupStampOf(name));
	if (valid.length === 0) return null;
	return valid.sort(compareBackupNames)[0];
}

/**
 * 列一个 staging Skill 目录里的历史备份（新的在前）。
 * `withHash:true` 时顺手算正文哈希（还原计划用它判断「这份备份是不是和现在一样」）；
 * 面板轮询只取 count / latest，不读正文。
 * @param {string} dir
 * @param {{withHash?:boolean}} [options]
 */
export async function listSkillBackups(dir, options = {}) {
	const withHash = options.withHash === true;
	const items = [];
	if (!dir) return { count: 0, items };
	let entries = [];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return { count: 0, items };
	}
	for (const entry of entries) {
		if (!entry || entry.isDirectory()) continue;
		const meta = backupStampOf(entry.name);
		if (!meta) continue;
		const file = join(dir, entry.name);
		try {
			const info = await stat(file);
			if (!info.isFile()) continue;
			const item = { name: entry.name, stamp: meta.stamp, copy: meta.copy, size: info.size, mtimeMs: info.mtimeMs };
			if (withHash) {
				try {
					item.hash = hashSkillText(await readFile(file, "utf8"));
				} catch {
					item.hash = null;
				}
			}
			items.push(item);
		} catch {
			/* 这一份读不到就跳过，不让一份坏备份把整个列表打掉 */
		}
	}
	items.sort((a, b) => compareBackupNames(a.name, b.name));
	return { count: items.length, items };
}

/** 从 stamp 开始找一个还没被占用的备份名（同一秒里连续还原两次也不会覆盖前一份）。 */
async function uniqueBackupTarget(dir, stamp) {
	for (let copy = 1; copy <= 99; copy += 1) {
		const name = SKILL_FILE + ".bak-" + stamp + (copy > 1 ? "-" + copy : "");
		try {
			await stat(join(dir, name));
		} catch {
			return name;
		}
	}
	throw new Error("同一秒里备份名用完了（99 份）");
}

/**
 * 把 staging 的一份历史备份**还原回 staging**（R20）。
 *
 * 铁律：
 *   ① 只动 staging：`stagedDir` 这一层，**永远不碰 DSH 加载的那份**（反向覆盖 live 是另一半事故来源）；
 *   ② `backup` 只接受本模块生成的 `SKILL.md.bak-<时间戳>`（拒绝路径穿越）；
 *   ③ 覆盖前先把 staging 当前这份另存成 `SKILL.md.bak-<新时间戳>` —— 还原本身也可撤销；
 *   ④ 备份与当前内容一致 → 什么都不做（skipped），不制造无意义的备份。
 *
 * @param {{stagedDir:string, backup:string, stamp?:string}} options
 * @returns {Promise<{ok:true, skipped:boolean, backup:string, preRestore:string, bytes:number}>}
 */
export async function restoreSkillBackup(options = {}) {
	const stagedDir = String(options.stagedDir || "");
	const backup = String(options.backup || "");
	if (!stagedDir) throw new Error("restoreSkillBackup 需要 stagedDir");
	if (!backup || basename(backup) !== backup || !backupStampOf(backup)) {
		throw new Error("备份名必须是 SKILL.md.bak-<时间戳>（不允许路径）");
	}
	const source = join(stagedDir, backup);
	let backupText;
	try {
		backupText = await readFile(source, "utf8");
	} catch {
		throw new Error("备份不存在或读不到：" + backup);
	}
	const target = join(stagedDir, SKILL_FILE);
	let currentText = null;
	try {
		currentText = await readFile(target, "utf8");
	} catch {
		currentText = null; /* staging 里没有 SKILL.md：还原就是补一份，不需要 pre-restore 备份 */
	}
	if (currentText !== null && hashSkillText(currentText) === hashSkillText(backupText)) {
		return { ok: true, skipped: true, backup, preRestore: "", bytes: Buffer.byteLength(backupText, "utf8") };
	}
	const stamp = String(options.stamp || skillStamp());
	let preRestore = "";
	if (currentText !== null) {
		preRestore = await uniqueBackupTarget(stagedDir, stamp);
		await copyFile(target, join(stagedDir, preRestore));
	}
	await copyFile(source, target);
	const info = await stat(target);
	return { ok: true, skipped: false, backup, preRestore, bytes: info.size };
}
