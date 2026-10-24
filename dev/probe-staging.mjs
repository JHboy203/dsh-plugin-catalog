/**
 * probe-staging.mjs — 副本判据与「还原 staging 备份」的独立探针（R20）。
 *
 * 为什么单独一个探针：`staging.mjs` 判的是「发布出去的是不是旧版」——
 * 判错了不会报错，只会让 `catalog_publish` 静默推一份旧文件上去。R20 之前
 * 只比 size，**同字数改一个字**正好落在盲区里；还原接口则会把文件覆盖回去，
 * 路径校验错一行就是写坏别人的目录。这两类都只能靠合成数据在独立进程里钉死。
 *
 * 用法：`node dev/probe-staging.mjs [--json]`；破任一不变式退出码 1。
 * 全程只写系统临时目录（mkdtemp），不碰真 Skill、不碰 staging。
 */

import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { backupStampOf, compareBackupNames, hashSkillText, listSkillBackups, pickLatestBackup, restoreSkillBackup, scanSkillStaging, skillStat, skillVerdict } from "../lib/staging.mjs";

const results = [];
function ok(name, condition, detail = "") {
	results.push({ name, pass: Boolean(condition), detail });
}

function statOf(text, mtimeMs = 1760000000000) {
	return { size: Buffer.byteLength(text, "utf8"), mtimeMs, hash: hashSkillText(text) };
}

/* ── P1 正文哈希：12 位十六进制，改一个字就变 ── */
{
	const a = hashSkillText("# same body\n");
	const b = hashSkillText("# same body\n");
	const c = hashSkillText("# same body!");
	ok("P1 哈希稳定且区分单个字符", a === b && a !== c && /^[0-9a-f]{12}$/.test(a), JSON.stringify({ a, b, c }));
}

/* ── P2 哈希优先：内容相同、mtime 差一小时 → 仍是 same（mtime 是噪音） ── */
{
	const loaded = statOf("SAME", 1000);
	const staged = statOf("SAME", 1000 + 3600 * 1000);
	const verdict = skillVerdict(loaded, staged);
	ok("P2 内容相同 → same（不再被 mtime 带偏）", verdict.verdict === "same", verdict.verdict);
}

/* ── P3 ★ 本轮要修的洞：同字数、不同正文、时间差在容差内 → 必须 differs ── */
{
	const loaded = statOf("AAAA-1111", 1760000000000);
	const staged = statOf("BBBB-1111", 1760000000000 + 5 * 1000);
	const verdict = skillVerdict(loaded, staged);
	ok("P3 同字数改一个字（时间差 ≤ 60 秒）→ differs", verdict.verdict === "differs", verdict.verdict);
}

/* ── P4 同字数不同正文、staging 明显更新 → newer-workspace（保留方向语义） ── */
{
	const loaded = statOf("AAAA-1111", 1760000000000);
	const staged = statOf("BBBB-1111", 1760000000000 + 10 * 60 * 1000);
	const verdict = skillVerdict(loaded, staged);
	ok("P4 同字数不同正文、staging 更新 → newer-workspace", verdict.verdict === "newer-workspace", verdict.verdict);
}

/* ── P5 同字数不同正文、live 明显更新 → newer-loaded（算旧） ── */
{
	const loaded = statOf("AAAA-1111", 1760000000000 + 10 * 60 * 1000);
	const staged = statOf("BBBB-1111", 1760000000000);
	const verdict = skillVerdict(loaded, staged);
	ok("P5 同字数不同正文、live 更新 → newer-loaded", verdict.verdict === "newer-loaded", verdict.verdict);
}

/* ── P6 至少一边没有哈希：退回老口径（size + 时间） ── */
{
	const loaded = { size: 9, mtimeMs: 1000, hash: null };
	const staged = { size: 9, mtimeMs: 2000, hash: null };
	ok("P6 读不到哈希 → 退回 size + mtime（容差内 same）", skillVerdict(loaded, staged).verdict === "same", skillVerdict(loaded, staged).verdict);
}

/* ── P7 老口径下 size 不同仍判 differs ── */
{
	const loaded = { size: 9, mtimeMs: 1000, hash: null };
	const staged = { size: 10, mtimeMs: 2000, hash: "abc" };
	ok("P7 无哈希 + size 不同 → differs", skillVerdict(loaded, staged).verdict === "differs", skillVerdict(loaded, staged).verdict);
}

/* ── P8 三种"缺一半"的情况 ── */
{
	const present = statOf("X");
	ok(
		"P8 absent / missing-loaded / missing-staged 不混",
		skillVerdict(null, null).verdict === "absent" && skillVerdict(present, null).verdict === "missing-staged" && skillVerdict(null, present).verdict === "missing-loaded",
	);
}

/* ── P9 备份名排序：时间戳新的在前；同一秒的 -2 比无后缀新；杂名忽略 ── */
{
	const names = ["SKILL.md.bak-20261023-090000", "SKILL.md.bak-20261024-120000", "SKILL.md.bak-20261024-120000-2", "notes.md", "SKILL.md.bak-abc"];
	const sorted = names.filter((name) => backupStampOf(name)).sort(compareBackupNames);
	ok(
		"P9 备份名排序与 latest 选择",
		pickLatestBackup(names) === "SKILL.md.bak-20261024-120000-2" && sorted[0] === "SKILL.md.bak-20261024-120000-2" && sorted[2] === "SKILL.md.bak-20261023-090000" && backupStampOf(names[4]) === null,
		JSON.stringify(sorted),
	);
}

const root = await mkdtemp(join(tmpdir(), "catalog-probe-staging-"));
try {
	/* ── P10 listSkillBackups：只认备份名、新的在前、可选带哈希 ── */
	const listDir = join(root, "list");
	await mkdir(listDir, { recursive: true });
	await writeFile(join(listDir, "SKILL.md"), "current", "utf8");
	await writeFile(join(listDir, "SKILL.md.bak-20261023-090000"), "old-1", "utf8");
	await writeFile(join(listDir, "SKILL.md.bak-20261024-120000"), "old-2", "utf8");
	await writeFile(join(listDir, "SKILL.md.bak-20261024-120000-2"), "old-3", "utf8");
	await writeFile(join(listDir, "SKILL.md.bak-abc"), "junk", "utf8");
	const listed = await listSkillBackups(listDir, { withHash: true });
	ok(
		"P10 列备份：3 份、新的在前、带正文哈希",
		listed.count === 3 && listed.items[0].name === "SKILL.md.bak-20261024-120000-2" && listed.items[0].hash === hashSkillText("old-3"),
		JSON.stringify(listed.items.map((item) => item.name)),
	);

	/* ── P11 还原：staging 覆盖成备份内容；当前那份另存 pre-restore 备份 ── */
	const restoreDir = join(root, "restore");
	await mkdir(restoreDir, { recursive: true });
	await writeFile(join(restoreDir, "SKILL.md"), "CURRENT", "utf8");
	await writeFile(join(restoreDir, "SKILL.md.bak-20261024-120000"), "OLD", "utf8");
	const restored = await restoreSkillBackup({ stagedDir: restoreDir, backup: "SKILL.md.bak-20261024-120000", stamp: "20261024-130000" });
	const afterRestore = await stat(join(restoreDir, "SKILL.md"));
	const preText = await stat(join(restoreDir, restored.preRestore));
	ok(
		"P11 还原写入备份内容 + 生成 pre-restore 备份",
		restored.skipped === false && restored.preRestore === "SKILL.md.bak-20261024-130000" && afterRestore.size === 3 && preText.size === 7,
		JSON.stringify(restored),
	);

	/* ── P12 无需还原：备份与当前内容一致 → skipped，不制造新备份 ── */
	const sameDir = join(root, "same");
	await mkdir(sameDir, { recursive: true });
	await writeFile(join(sameDir, "SKILL.md"), "SAME", "utf8");
	await writeFile(join(sameDir, "SKILL.md.bak-20261024-120000"), "SAME", "utf8");
	const skipped = await restoreSkillBackup({ stagedDir: sameDir, backup: "SKILL.md.bak-20261024-120000", stamp: "20261024-130000" });
	const sameList = await listSkillBackups(sameDir);
	ok("P12 备份与当前一致 → skipped 且不加备份", skipped.skipped === true && skipped.preRestore === "" && sameList.count === 1, JSON.stringify({ skipped, count: sameList.count }));

	/* ── P13 路径校验：只接受本模块生成的备份名 ── */
	const rejections = [];
	for (const bad of ["../SKILL.md.bak-20261024-120000", join(root, "restore", "SKILL.md.bak-20261024-120000"), "SKILL.md", "SKILL.md.bak-abc", ""]) {
		try {
			await restoreSkillBackup({ stagedDir: restoreDir, backup: bad, stamp: "20261024-140000" });
			rejections.push(false);
		} catch {
			rejections.push(true);
		}
	}
	ok("P13 还原拒绝路径穿越 / 绝对路径 / 非备份名", rejections.every(Boolean), JSON.stringify(rejections));

	/* ── P14 staging 里没有 SKILL.md：还原就是补一份，不做 pre-restore ── */
	const emptyDir = join(root, "empty");
	await mkdir(emptyDir, { recursive: true });
	await writeFile(join(emptyDir, "SKILL.md.bak-20261024-120000"), "ONLY-BACKUP", "utf8");
	const filled = await restoreSkillBackup({ stagedDir: emptyDir, backup: "SKILL.md.bak-20261024-120000", stamp: "20261024-150000" });
	ok("P14 staging 缺 SKILL.md → 还原补一份、不备份空文件", filled.skipped === false && filled.preRestore === "" && filled.bytes === 11, JSON.stringify(filled));

	/* ── P15 ★ 端到端：同字数改一个字，scanSkillStaging 必须报 old（R20 之前报 0） ── */
	const liveRoot = join(root, "live");
	const stageRoot = join(root, "stage");
	await mkdir(join(liveRoot, "alpha"), { recursive: true });
	await mkdir(join(stageRoot, "alpha"), { recursive: true });
	await writeFile(join(liveRoot, "alpha", "SKILL.md"), "AAAA-1111", "utf8");
	await writeFile(join(stageRoot, "alpha", "SKILL.md"), "BBBB-1111", "utf8");
	const fixedTime = new Date(1760000000000);
	await utimes(join(liveRoot, "alpha", "SKILL.md"), fixedTime, fixedTime);
	await utimes(join(stageRoot, "alpha", "SKILL.md"), fixedTime, fixedTime);
	const scan = await scanSkillStaging({ roots: [liveRoot], stageDir: stageRoot });
	ok("P15 端到端：同字数不同正文会被 scanSkillStaging 标旧", scan.stale.length === 1 && scan.stale[0].verdict === "differs", JSON.stringify({ stale: scan.stale.map((item) => item.verdict), same: scan.same }));

	/* ── P16 端到端：内容相同但 mtime 差很远 → 仍然 same（哈希压过时间） ── */
	const liveSame = join(root, "live-same");
	const stageSame = join(root, "stage-same");
	await mkdir(join(liveSame, "beta"), { recursive: true });
	await mkdir(join(stageSame, "beta"), { recursive: true });
	await writeFile(join(liveSame, "beta", "SKILL.md"), "SAME-BODY", "utf8");
	await writeFile(join(stageSame, "beta", "SKILL.md"), "SAME-BODY", "utf8");
	await utimes(join(liveSame, "beta", "SKILL.md"), new Date(1760000000000), new Date(1760000000000));
	await utimes(join(stageSame, "beta", "SKILL.md"), new Date(1760000000000 + 86400000), new Date(1760000000000 + 86400000));
	const scanSame = await scanSkillStaging({ roots: [liveSame], stageDir: stageSame });
	ok("P16 端到端：内容相同 → same（不会因 mtime 误报较新/较旧）", scanSame.stale.length === 0 && scanSame.same === 1, JSON.stringify({ stale: scanSame.stale.length, same: scanSame.same }));
} finally {
	await rm(root, { recursive: true, force: true });
}

const failed = results.filter((item) => !item.pass);
if (process.argv.includes("--json")) {
	console.log(JSON.stringify({ passed: results.length - failed.length, failed: failed.length, results }, null, 1));
} else {
	for (const item of results) console.log(`${item.pass ? "  ok" : "  FAIL"}  ${item.name}${item.pass || !item.detail ? "" : "  [" + item.detail + "]"}`);
	console.log(`\nprobe-staging: passed ${results.length - failed.length} / failed ${failed.length}`);
}
if (failed.length > 0) process.exit(1);
