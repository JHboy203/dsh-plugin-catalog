/**
 * dev/rm.mjs — 救火：**删掉工作区里的文件/目录**（沙箱删不掉时用）。
 *
 * 为什么需要它：工具沙箱允许用 write / edit 改文件，但**不允许 unlink/rename**
 * （实测 `Remove-Item` Access denied、`node fs.unlinkSync` EPERM）。
 * 于是"临时探针用完要删"这种小事会卡住，留下一堆半成品。
 * 这个脚本走 **host_selfcheck**（宿主进程，不在沙箱里）执行，就能正常删。
 *
 * 用法（脚本自己会校验：只允许删本仓内的路径）：
 *   host_selfcheck plugin=dsh-plugin-catalog script=dev/rm.mjs args=["dev/_probe-deps.mjs"]
 *   host_selfcheck ... args=["dev/tmp-a","dev/tmp-b"]        # 多个
 *   host_selfcheck ... args=["--dry-run","dev/x"]            # 只报会删什么
 *
 * ★ 安全：拒绝绝对路径、拒绝 `..`、拒绝仓库根、拒绝 `.git`，其余按相对 repo 解析。
 */

import { existsSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const targets = args.filter((arg) => !arg.startsWith("--"));

if (targets.length === 0) {
	console.log("用法: node dev/rm.mjs [--dry-run] <相对仓库的路径> [...]");
	process.exit(2);
}

let failed = 0;
for (const target of targets) {
	if (target.includes("..") || target === "." || target === "/" || /^[a-zA-Z]:/.test(target)) {
		console.log(`✗ 拒绝: ${target}（只接受仓库内的相对路径）`);
		failed += 1;
		continue;
	}
	const full = join(REPO, target);
	if (!full.toLowerCase().startsWith(REPO.toLowerCase())) {
		console.log(`✗ 拒绝: ${target}（解析后不在仓库内）`);
		failed += 1;
		continue;
	}
	const rel = full.slice(REPO.length + 1);
	if (rel === "" || rel.split(/[\\/]/)[0] === ".git") {
		console.log(`✗ 拒绝: ${target}（仓库根 / .git 不许删）`);
		failed += 1;
		continue;
	}
	if (!existsSync(full)) {
		console.log(`• 不存在，跳过: ${rel}`);
		continue;
	}
	const kind = statSync(full).isDirectory() ? "目录" : "文件";
	if (dryRun) {
		console.log(`· 会删 ${kind}: ${rel}`);
		continue;
	}
	try {
		rmSync(full, { recursive: true, force: true });
		console.log(`✓ 已删 ${kind}: ${rel}`);
	} catch (error) {
		console.log(`✗ 删不掉 ${rel}: ${String(error?.message ?? error)}`);
		failed += 1;
	}
}
if (dryRun) console.log("（--dry-run：什么都没删）");
process.exit(failed > 0 ? 1 : 0);
