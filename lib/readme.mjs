/**
 * readme.mjs — README 中英双版的**判定**与落盘。
 *
 * 用户要求里最容易做错的一条：「扫描后若判断没有需要补英文的内容，就不生成英文版，
 * 不无脑造」。所以这里先做**确定性判定**，再决定要不要花一次模型调用：
 *
 *   · README 本来就用英文写（代码块之外几乎没有中日韩字符）→ 不生成；
 *   · 正文可翻译字符太少（只有标题、徽章、占位）→ 不生成；
 *   · 只有「待补充」/TBD 的骨架 → 不生成（造出来的英文版是空话）；
 *   · 已有英文版且比中文版新 → 不生成。
 *
 * 另一条：「中文标『待补充』的，英文照写 TBD」。翻译后这里会**核对** TBD 数量，
 * 少于中文里的「待补充」数就报 `tbdMismatch`（不自动改写 —— 改写会破坏章节对应）。
 *
 * @module dsh-plugin-catalog/readme
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteText } from "./store.mjs";

/** 认得出来的 README 文件名。 */
const ZH_CANDIDATES = ["README.md", "readme.md", "README.zh.md", "README.zh-CN.md"];
const EN_CANDIDATES = ["README.en.md", "README_EN.md", "README-en.md", "README.en-US.md"];

/** 英文版固定写这个（新建时）。 */
export const ENGLISH_NAME = "README.en.md";

/** 去掉围栏代码块与行内代码后的正文（判定语言用，避免代码里的中文误判）。 */
export function proseOf(text) {
	return String(text || "")
		.replace(/```[\s\S]*?```/g, "")
		.replace(/`[^`]*`/g, "")
		.replace(/<!--[\s\S]*?-->/g, "");
}

/** 中日韩字符数。 */
export function cjkCount(text) {
	const matches = proseOf(text).match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff]/g);
	return matches ? matches.length : 0;
}

/** 拉丁字母数（判"已经是英文"）。 */
export function latinCount(text) {
	const matches = proseOf(text).match(/[A-Za-z]/g);
	return matches ? matches.length : 0;
}

/** 「待补充」与 TBD 的出现次数。 */
export function tbdCount(text) {
	const matches = String(text || "").match(/待补充|TBD|TODO/gi);
	return matches ? matches.length : 0;
}

async function safeText(file) {
	try {
		return await readFile(file, "utf8");
	} catch {
		return null;
	}
}

async function mtime(file) {
	try {
		return (await stat(file)).mtimeMs;
	} catch {
		return 0;
	}
}

async function firstExisting(dir, names) {
	for (const name of names) {
		const file = join(dir, name);
		const text = await safeText(file);
		if (text !== null) return { name, file, text };
	}
	return null;
}

/**
 * 分析一个目录的 README 现状。
 *
 * @param {string} dir
 * @returns {Promise<object>}
 */
export async function analyzeReadme(dir) {
	const zhEntry = await firstExisting(dir, ZH_CANDIDATES);
	const enEntry = await firstExisting(dir, EN_CANDIDATES);

	if (!zhEntry) {
		return {
			hasReadme: false,
			zhFile: null,
			enFile: enEntry ? enEntry.name : null,
			needsEnglish: false,
			reason: "没有 README.md —— 先写中文版，再谈英文版",
			cjk: 0,
			latin: 0,
			tbd: 0,
			zhText: "",
		};
	}

	const cjk = cjkCount(zhEntry.text);
	const latin = latinCount(zhEntry.text);
	const tbd = tbdCount(zhEntry.text);
	const isChinese = cjk >= 40 && cjk * 3 >= latin;

	if (!isChinese) {
		return {
			hasReadme: true,
			zhFile: zhEntry.name,
			enFile: zhEntry.name,
			needsEnglish: false,
			reason: "README 本身就用英文写（正文几乎没有中文），不需要再生成英文版",
			cjk,
			latin,
			tbd,
			zhText: zhEntry.text,
			alreadyEnglish: true,
		};
	}

	/* 只有骨架：正文去掉标题/分隔/链接后不足一定字符数 */
	const bodyOnly = proseOf(zhEntry.text)
		.replace(/^#{1,6}\s.*$/gm, "")
		.replace(/^\s*[-*|>].*$/gm, (line) => (/[\u4e00-\u9fff]/.test(line) ? line : ""))
		.replace(/https?:\/\/\S+/g, "")
		.trim();
	if (cjk < 80) {
		return {
			hasReadme: true,
			zhFile: zhEntry.name,
			enFile: enEntry ? enEntry.name : null,
			needsEnglish: false,
			reason: `中文正文只有 ${cjk} 个汉字，没有需要补英文的内容`,
			cjk,
			latin,
			tbd,
			zhText: zhEntry.text,
		};
	}
	if (tbd > 0 && cjk - tbd * 4 < 80) {
		return {
			hasReadme: true,
			zhFile: zhEntry.name,
			enFile: enEntry ? enEntry.name : null,
			needsEnglish: false,
			reason: "中文版基本还是「待补充」骨架，翻成英文只会是空话 —— 先补中文",
			cjk,
			latin,
			tbd,
			zhText: zhEntry.text,
		};
	}

	if (enEntry) {
		const fresh = (await mtime(enEntry.file)) >= (await mtime(zhEntry.file));
		if (fresh && enEntry.name !== zhEntry.name) {
			return {
				hasReadme: true,
				zhFile: zhEntry.name,
				enFile: enEntry.name,
				needsEnglish: false,
				reason: "英文版已存在且不比中文版旧",
				cjk,
				latin,
				tbd,
				zhText: zhEntry.text,
				enText: enEntry.text,
			};
		}
	}

	return {
		hasReadme: true,
		zhFile: zhEntry.name,
		enFile: enEntry ? enEntry.name : null,
		needsEnglish: true,
		reason: enEntry ? "中文版比英文版新，需要更新英文版" : "还没有英文版",
		cjk,
		latin,
		tbd,
		zhText: zhEntry.text,
	};
}

/**
 * 写英文版。
 * @param {string} dir
 * @param {string} english
 * @param {string} [existingName] 已有英文文件名（沿用，别生出第二份）
 */
export async function writeEnglish(dir, english, existingName) {
	const name = existingName || ENGLISH_NAME;
	const file = join(dir, name);
	await atomicWriteText(file, english.endsWith("\n") ? english : english + "\n");
	return { file, name };
}

/**
 * 在中英两份 README 顶部各插一行语言互链（已存在就不动）。
 *
 * 只做最小改动：在第一个标题行之后插入一行。找不到标题就插在文件开头。
 */
export async function ensureCrossLink(file, targetName, label) {
	const text = await safeText(file);
	if (text === null) return { ok: false, reason: "文件不存在" };
	if (text.includes("](" + targetName + ")")) return { ok: true, changed: false, reason: "已经有互链" };
	const lines = text.split("\n");
	let insertAt = 0;
	for (let index = 0; index < lines.length; index += 1) {
		if (/^#{1,6}\s/.test(lines[index])) {
			insertAt = index + 1;
			break;
		}
	}
	const link = `\n[${label}](${targetName})\n`;
	lines.splice(insertAt, 0, link);
	await atomicWriteText(file, lines.join("\n"));
	return { ok: true, changed: true, reason: "已插入互链" };
}

/** 翻译后核对：英文里的 TBD 数量不能少于中文里的「待补充」。 */
export function checkTbdParity(zhText, enText) {
	const zh = (String(zhText || "").match(/待补充/g) || []).length;
	const en = (String(enText || "").match(/\bTBD\b/gi) || []).length;
	return { zhPending: zh, enTbd: en, ok: zh === 0 || en >= zh };
}

/** 中英章节结构是否一一对应（标题文本可比性差，所以只比层级序列）。 */
export function headingShape(text) {
	return String(text || "")
		.split("\n")
		.filter((line) => /^#{1,6}\s/.test(line))
		.map((line) => (line.match(/^#+/) || [""])[0].length);
}

export function compareHeadingShape(zhText, enText) {
	const a = headingShape(zhText);
	const b = headingShape(enText);
	const same = a.length === b.length && a.every((level, index) => level === b[index]);
	return { same, zhHeadings: a.length, enHeadings: b.length, zhLevels: a, enLevels: b };
}

/** 列出目录里的文件（给缺口分析用，一层 + 一层子目录，有上界）。 */
export async function listFilesForAudit(dir, max = 300) {
	const out = [];
	const walk = async (current, prefix, depth) => {
		if (out.length >= max || depth > 2) return;
		let entries = [];
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name === ".git" || entry.name === "node_modules") continue;
			const rel = prefix ? prefix + "/" + entry.name : entry.name;
			if (entry.isDirectory()) {
				out.push(rel + "/");
				await walk(join(current, entry.name), rel, depth + 1);
			} else {
				out.push(rel);
			}
			if (out.length >= max) return;
		}
	};
	await walk(dir, "", 0);
	return out;
}
