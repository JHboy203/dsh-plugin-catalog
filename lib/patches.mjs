/**
 * patches.mjs — **rc.3 之后的组合层**：入口表 + 每个 bundle 自带的 patch 层。
 *
 * ★ 为什么要有它（2026-10-26 真机实测）：
 *   DSH 0.2.1-rc.3 把 `profile\cordis.yml` 改成**空入口表** —— 文件头原话：
 *   *"an empty entry list. The tree is composed as patches: each bundle in
 *   package.json's dsh.profile.bundles, then cordis.patch.yml, then any --patch overlays."*
 *   于是 243 条基线条目一夜之间"消失"，而它们并没丢：一部分进了宿主自己的
 *   `@deepseek-ai/dsh-base`（asar 内 `dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml`，
 *   实测 **96 条**，注释写着 "applied as ONE insert over the empty profile root"），
 *   一部分进各 bundle 自带的 `cordis.patch.yml`（本机已装 41 份，共 63 条内层条目）。
 *
 *   只读 profile 的两份文件 → 配置层从 246 条掉到 24 条，**面板会像是"配置丢了 90%"**。
 *   所以这一层负责把「按 bundles 顺序 × 各自 patch + profile patch」读回来。
 *
 * ★ 两个纪律（与 R22/R8 同源）：
 *   ① **只读声明**，不展开 bundle 的 `config:` 内部、不求值 `!!js`；
 *   ② 读不到的层**不算空层**：记进 `missing`，由上层说「这份没有」，绝不静默成 0 条。
 *
 * ★ 独立性：本模块只读 profile 与 asar，不 import 任何安装侧 / 消费方代码。
 *
 * @module dsh-plugin-catalog/patches
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ASAR_PKG_ROOT, asarPath, readText } from "./asar.mjs";
import { LAYER_ROLES } from "./composition.mjs";
import { profileBundles, profileDir } from "./hostinfo.js";

/** 层角色沿用 composition.mjs 的单一来源（顺序即应用顺序：root → bundle 层 → profile patch）。 */
export { LAYER_ROLES };

/** 组合层的文件名（宿主只认这一个）。 */
export const PATCH_FILE = "cordis.patch.yml";

/** 入口表文件名（rc.3 起应为空表）。 */
export const ROOT_FILE = "cordis.yml";

/**
 * 按 rc.3 的语义把**全部**组合层读出来。
 *
 * 返回的 `files` 已经排好应用顺序，直接交给 `auditComposition({files})` 即可：
 * 它内部按出现顺序做 `mergeCompositionEntries`（同 id 后写胜出）。
 *
 * @param {{bundles?: string[]}} [input] 省略时现读 `dsh.profile.bundles`
 * @returns {Promise<{files:Array<{file:string,text:string,role:string,source:string,bundle:string}>,
 *   missing:string[], bundles:string[], asar:string}>}
 */
export async function collectCompositionLayers(input = {}) {
	const dir = profileDir();
	const out = { files: [], missing: [], bundles: [], asar: "" };
	if (!dir) {
		out.missing.push("profile");
		return out;
	}
	const list = Array.isArray(input.bundles)
		? input.bundles.filter((name) => typeof name === "string" && name !== "")
		: await profileBundles().catch(() => []);
	out.bundles = list;
	const archive = asarPath();
	out.asar = archive || "";

	/* ① 入口表（rc.3 起是空表 `[]`；读不到不算空层，记 missing） */
	const rootPath = join(dir, ROOT_FILE);
	try {
		out.files.push({ file: rootPath, text: await readFile(rootPath, "utf8"), role: "root", source: "profile", bundle: "" });
	} catch {
		out.missing.push(ROOT_FILE);
	}

	/* ② 每个 bundle 自带的 patch 层（顺序就是 bundles 的顺序 = 宿主应用顺序） */
	for (const name of list) {
		const file = join(dir, "node_modules", name, PATCH_FILE);
		let text = null;
		try {
			text = await readFile(file, "utf8");
		} catch {
			text = null;
		}
		if (text !== null) {
			out.files.push({ file, text, role: "bundle-patch", source: "profile", bundle: name });
			continue;
		}
		/* 官方 bundle 在 asar 里：成员路径 `dsh/node_modules/<pkg>/cordis.patch.yml` */
		const member = ASAR_PKG_ROOT + "/" + name + "/" + PATCH_FILE;
		const fromAsar = archive ? readText(archive, member) : null;
		if (fromAsar !== null) {
			out.files.push({ file: archive + "::" + member, text: fromAsar, role: "bundle-patch", source: "asar", bundle: name });
			continue;
		}
		out.missing.push(name);
	}

	/* ③ profile 自己的 patch（最后应用 = 用户改动优先于任何 bundle） */
	const patchPath = join(dir, PATCH_FILE);
	try {
		out.files.push({ file: patchPath, text: await readFile(patchPath, "utf8"), role: "profile-patch", source: "profile", bundle: "" });
	} catch {
		out.missing.push(PATCH_FILE);
	}
	return out;
}
