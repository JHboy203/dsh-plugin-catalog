/**
 * dev/inspect.mjs — **装完核对的人工入口**（只读，真机）：这个包在「插件目录」眼里会不会被加载。
 *
 * ★ 为什么要有它（R33）：`pluginCatalog.inspect` 是给「插件安装」装完回头核对的（契约 api 2）。
 *   但排查时人也会想问同一个问题 —— "我装的这个，是不是只是文件进去了、其实没人加载？"
 *   面板要开、工具要会话；这条命令直接打 `GET /plugin-catalog/inspect?name=`，一条就出结论。
 *
 * ★ 用 `node:http` 而不是全局 `fetch`（项目教训）：
 *   ① undici 的 keep-alive 在 `process.exit()` 时会撞 libuv 断言（退出码 0 变 1，假失败）；
 *   ② 本机有 undici 流断开打死宿主的先例。
 *
 * 用法：
 *   node dev/inspect.mjs --name dsh-diag                 # 端口取 DSH_WEB_URL，或 --base
 *   node dev/inspect.mjs --base http://127.0.0.1:29634 --name dsh-diag,dsh-ops --json
 *   node dev/inspect.mjs --name dsh-diag --expect loaded  # 断言（不等就退出码 1）
 * 退出码：0 = 全部 inspect 成功且（若给了 --expect）结论码相符；1 = 有包被判「不会被加载」或请求失败。
 */

import http from "node:http";
import { URL } from "node:url";

function arg(name, fallback = "") {
	const prefix = "--" + name + "=";
	const index = process.argv.indexOf("--" + name);
	if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) return process.argv[index + 1];
	const inline = process.argv.find((item) => item.startsWith(prefix));
	return inline ? inline.slice(prefix.length) : fallback;
}

const asJson = process.argv.includes("--json");
const base = String(arg("base", process.env.DSH_WEB_URL || "")).replace(/\/+$/, "");
const names = String(arg("name", ""))
	.split(",")
	.map((item) => item.trim())
	.filter(Boolean);
const expect = String(arg("expect", "")).trim();

if (!base) {
	console.error("缺 --base（或在环境里给 DSH_WEB_URL）。每次重启 GUI 端口都会变，所以不写死。");
	process.exit(2);
}
if (names.length === 0) {
	console.error("缺 --name（逗号分隔，可多个）");
	process.exit(2);
}

function getJson(url) {
	return new Promise((resolve) => {
		const request = http.get(url, { headers: { accept: "application/json" } }, (response) => {
			let body = "";
			response.setEncoding("utf8");
			response.on("data", (chunk) => (body += chunk));
			response.on("end", () => {
				try {
					resolve({ ok: response.statusCode === 200, status: response.statusCode, json: JSON.parse(body || "{}") });
				} catch {
					resolve({ ok: false, status: response.statusCode, json: null, body: body.slice(0, 200) });
				}
			});
		});
		request.on("error", (error) => resolve({ ok: false, status: 0, json: null, body: String((error && error.message) || error) }));
		request.setTimeout(8000, () => request.destroy(new Error("timeout 8s")));
	});
}

const results = [];
for (const name of names) {
	const url = new URL(base + "/plugin-catalog/inspect");
	url.searchParams.set("name", name);
	const reply = await getJson(url);
	const verdict = reply.json && typeof reply.json === "object" ? reply.json : {};
	results.push({
		name,
		status: reply.status,
		api: Number(verdict.api) || 0,
		code: String(verdict.code || ""),
		ok: verdict.ok === true,
		text: String(verdict.text || reply.body || ""),
		warnings: Array.isArray(verdict.warnings) ? verdict.warnings.map((item) => item.code + "：" + item.text) : [],
	});
}

const failed = results.filter((item) => item.api < 2 || item.code === "" || (expect && item.code !== expect) || (!expect && !item.ok && item.code !== "self"));

if (asJson) {
	console.log(JSON.stringify({ ok: failed.length === 0, base, expect: expect || null, results }, null, 1));
} else {
	console.log("装完核对（只读）· " + base + (expect ? " · 期望 " + expect : ""));
	for (const item of results) {
		console.log("");
		console.log("· " + item.name + "　[" + (item.code || "HTTP " + item.status) + "]　" + item.text);
		if (item.api < 2) console.log("  ⚠️ api " + item.api + "：对端「插件目录」没有 inspect（需要 0.33.0+）");
		for (const warning of item.warnings) console.log("  - " + warning);
	}
	console.log("");
	console.log(failed.length === 0 ? "结论：全部符合预期" : "结论：**" + failed.length + " 个不符合预期**（" + failed.map((item) => item.name + "=" + (item.code || "?" )).join("、") + "）");
}

process.exit(failed.length === 0 ? 0 : 1);
