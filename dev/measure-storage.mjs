/**
 * dev/measure-storage.mjs — **留存现状取证**（只读）：数据目录里哪份文件在长、长到多少。
 *
 * ★ 为什么要有它（R33 真机）：`history.json` 实测 **1,136,604 B / 20 条快照**（每条 ≈42 KB，
 *   因为每条都存 246 条 decls），而 SKILL 里写的是「~12 KB/条、20 条封顶 ≈240 KB」——
 *   差 4.7 倍。这类"文件悄悄变大"只会在某天打开面板变慢时被发现，所以固化成一条命令。
 *
 * 输出：`<数据目录>` 下 6 份状态文件 + reports 目录的体积/条数，并对两份有预算的给结论：
 *   · `history.json` 预算 **240 KB**（20 条 × ~12 KB，R25 的估计）→ 超了就给"decls 紧凑化"的处置；
 *   · `cache/catalog.json` 预算 **2 MB**（条目快照，超过说明该抬 CATALOG_VERSION 或精简字段）。
 *
 * 用法：`node dev/measure-storage.mjs [--json]`；只读、不写盘、不联网。
 * 退出码：0 = 都在预算内；1 = 有文件超预算（结论行会点出来）。
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { dataDir as dataDirOf } from "../lib/hostinfo.js";

const asJson = process.argv.includes("--json");

/** 预算（字节）。数字来自 R25/R8 的估计，2026-10-26 R33 实测对账。 */
export const BUDGETS = Object.freeze({
	"history.json": 240 * 1024,
	"cache/catalog.json": 2 * 1024 * 1024,
});

async function sizeOf(file) {
	try {
		const info = await stat(file);
		return info.isFile() ? info.size : null;
	} catch {
		return null;
	}
}

async function countJsonArray(file) {
	try {
		const data = JSON.parse(await readFile(file, "utf8"));
		if (Array.isArray(data)) return data.length;
		if (Array.isArray(data.items)) return data.items.length;
		if (Array.isArray(data.snapshots)) return data.snapshots.length;
		return null;
	} catch {
		return null;
	}
}

const dir = dataDirOf();
const targets = [
	{ key: "history.json", label: "目录快照历史", budget: true },
	{ key: "history-ack.json", label: "「已看过」基线" },
	{ key: "removal-journal.json", label: "协作卸载留痕（最多 50 条）" },
	{ key: "cache/catalog.json", label: "目录快照（条目）", budget: true },
	{ key: "cache/sizes.json", label: "体积快照" },
	{ key: "cache/stats.json", label: "90 天统计分片" },
	{ key: "cache/attrib.json", label: "工具归属" },
];

const rows = [];
for (const target of targets) {
	const file = join(dir, target.key);
	const bytes = await sizeOf(file);
	const count = bytes === null ? null : await countJsonArray(file);
	const budget = BUDGETS[target.key] || null;
	rows.push({
		file: target.key,
		label: target.label,
		bytes,
		exists: bytes !== null,
		count,
		perItem: bytes !== null && typeof count === "number" && count > 0 ? Math.round(bytes / count) : null,
		budget,
		overBudget: Boolean(budget) && bytes !== null && bytes > budget,
	});
}

/* reports 目录：产物多不多，顺手给最新一份（换会话的人要知道上一份在哪） */
let reports = { files: 0, bytes: 0, latest: "" };
try {
	const names = (await readdir(join(dir, "reports"))).filter((name) => !name.startsWith("."));
	const stats = await Promise.all(
		names.map(async (name) => ({ name, info: await stat(join(dir, "reports", name)).catch(() => null) })),
	);
	const fresh = stats.filter((item) => item.info && item.info.isFile()).sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);
	reports = { files: fresh.length, bytes: fresh.reduce((sum, item) => sum + item.info.size, 0), latest: fresh[0] ? fresh[0].name : "" };
} catch {
	reports = { files: 0, bytes: 0, latest: "" };
}

const over = rows.filter((row) => row.overBudget);
const verdict = over.length === 0 ? "ok" : "warn";
const fmt = (bytes) => (bytes === null ? "—" : bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(2) + " MB" : Math.round(bytes / 1024) + " KB");

const summary = {
	at: new Date().toISOString(),
	dir,
	verdict,
	rows,
	over: over.map((row) => row.file),
	reports,
	hints: [
		"history.json 超预算：decls 是唯一的体积大头（每条快照都存全量声明身份）→ 可做紧凑编码（id 短码 / 只存 hash 集合），或按字节而不是只按条数裁剪",
		"cache/catalog.json 超预算：多半是条目字段又多了 → 抬 CATALOG_VERSION 前先看哪些字段能裁",
		"体积数字只用于发现「异常增长」：别拿它当磁盘占用权威值（那是 catalog_health 的 sizes 口径）",
	],
};

if (asJson) {
	console.log(JSON.stringify(summary, null, 1));
} else {
	console.log("留存现状（只读）· " + dir);
	console.log("");
	for (const row of rows) {
		const flags = [row.count === null ? "" : (row.perItem === null ? row.count + " 条" : row.count + " 条 / 条均 " + fmt(row.perItem)), row.budget ? "预算 " + fmt(row.budget) + (row.overBudget ? " · **超预算**" : "") : ""]
			.filter(Boolean)
			.join(" · ");
		console.log("  " + (row.exists ? fmt(row.bytes).padEnd(9) : "（无）".padEnd(9)) + row.file.padEnd(26) + (flags ? "  " + flags : ""));
	}
	console.log("");
	console.log("reports：" + reports.files + " 份 / " + fmt(reports.bytes) + (reports.latest ? " · 最新 " + reports.latest : ""));
	console.log("");
	console.log(verdict === "ok" ? "结论：都在预算内（history 预算按 R25 的 240 KB 估；实测口径见下）" : "结论：**" + over.map((row) => row.file).join("、") + " 超预算**");
	for (const hint of summary.hints.slice(0, verdict === "ok" ? 1 : 3)) console.log("  · " + hint);
}

process.exit(verdict === "ok" ? 0 : 1);
