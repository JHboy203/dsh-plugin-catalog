/**
 * dev/probe-asar.mjs — 只读：asar 解析是否通（官方插件能不能被读出来）。
 *
 * 这个探针专门验证一件容易静默失败的事：**Electron 把 app.asar 当目录**，
 * 所以要读成员路径而不是打开归档本身。两种模式都要能读出官方插件。
 */
import { asarMode, asarPath, listScopedPackages, readPackageJson, readPackageText, readText } from "../lib/asar.mjs";
import { listOfficialPlugins, readOfficialToolPackages } from "../lib/catalog.mjs";
import { profileBundles, resourcesPath } from "../lib/hostinfo.js";

const archive = asarPath();
const mode = asarMode(archive);

console.log("DSH_RESOURCES_DIR:", process.env.DSH_RESOURCES_DIR || "(未设置)");
console.log("resourcesPath():", resourcesPath());
console.log("asarPath():", archive);
console.log("mode:", mode);

let failures = 0;
function check(name, condition, detail = "") {
	if (condition) {
		console.log("  OK   " + name);
	} else {
		failures += 1;
		console.log("  FAIL " + name + (detail ? " — " + detail : ""));
	}
}

check("asar 可读（模式不是 none）", mode !== "none", mode);

if (mode !== "none") {
	const packages = listScopedPackages(archive);
	console.log("  @deepseek-ai 包数:", packages.length, " 其中 dsh-tool-*:", packages.filter((n) => n.startsWith("dsh-tool-")).length);
	check("能列出 @deepseek-ai 包", packages.length > 50, String(packages.length));

	const basePkg = readPackageJson(archive, "@deepseek-ai/dsh-base");
	check("能读 dsh-base 的 package.json", Boolean(basePkg && basePkg.version), JSON.stringify(basePkg && { name: basePkg.name, version: basePkg.version }));

	const text = readPackageText(archive, "@deepseek-ai/dsh-tool-fs", 200000);
	check("能读工具包源码", text.length > 1000, text.length + " chars");
	check("源码里能找到工具定义痕迹", /name\s*:\s*['"]|tool\(/.test(text));

	const bundles = await profileBundles();
	const officialBundles = bundles.filter((name) => name.startsWith("@deepseek-ai/"));
	console.log("  bundles 里官方条目:", officialBundles.length, officialBundles.join(" "));

	const official = await listOfficialPlugins({});
	console.log("  识别出官方插件:", official.plugins.length, " 缺失:", official.missing.length);
	check("官方插件数量等于 bundles 里的官方条目", official.plugins.length === officialBundles.length, official.plugins.map((p) => p.name).join(","));
	check("官方插件带版本号", official.plugins.every((plugin) => plugin.version !== ""));
	check("官方插件被标成 official", official.plugins.every((plugin) => plugin.source === "official"));

	const toolPackages = await readOfficialToolPackages();
	console.log("  读到的官方工具包:", toolPackages.length);
	check("读到了官方工具包源码", toolPackages.length >= 20, String(toolPackages.length));
	check("工具包里有 read 的工具定义", toolPackages.some((pack) => /['"]read['"]/.test(pack.text)));
	check("归属能认出 read 属于哪个官方包", (() => {
		/* read 的描述指纹应当只在某一个官方工具包里出现 */
		const needle = "Read a UTF-8 text file and return line-numbered content";
		const hits = toolPackages.filter((pack) => pack.text.includes(needle.replace(/\s+/g, " ")));
		return hits.length <= 1;
	})());
}

console.log("");
console.log(failures === 0 ? "asar 探针全部通过" : "asar 探针有 " + failures + " 项失败");
if (failures > 0) process.exit(1);
