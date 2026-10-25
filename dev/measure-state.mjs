/**
 * dev/measure-state.mjs — 量 `/state` 的传输代价（R31）。
 *
 * 为什么要有它：R31 给 `/state` 加了按需 gzip，把 **357,534 B 压到 85,448 B**。
 * 但那次是用几条 `curl` 手量的 —— 换会话以后没人记得怎么量、上次是多少，
 * 于是"省了多少"就只活在一段聊天记录里。这个脚本把那几条 curl 固化下来：
 *
 *   node dev/measure-state.mjs --base http://127.0.0.1:<GUI端口>
 *
 * 判据（退出码即结论）：
 *   ① 两次请求都 200；
 *   ② 带 `accept-encoding: gzip` 的那次**确实**回了 `content-encoding: gzip`；
 *   ③ 压缩后的线上字节 ≤ 原始字节的 **60%**（低于这个就说明压缩没生效或退化）。
 *
 * ★ 必须用 `node:http` 而不是 `fetch`：Node 的 fetch 会自动解压，
 *   拿到的 `arrayBuffer` 长度是解压后的 —— 那样永远测不出线上字节。
 * ★ 这是**只读**脚本：只发 GET，不写盘、不改任何配置。
 *
 * @module dsh-plugin-catalog/dev/measure-state
 */

import { request } from "node:http";

const args = process.argv.slice(2);
const baseArg = (() => {
	const at = args.indexOf("--base");
	if (at >= 0) return args[at + 1] || "";
	return args.find((arg) => arg.startsWith("http")) || "";
})();
const base = String(baseArg || "http://127.0.0.1:" + (process.env.DSH_PORT || "29936")).replace(/\/+$/, "");
const url = base + "/plugin-catalog/state";

/** 取一次原始响应：不解压、不给 UA 假设，返回 { status, bytes, encoding, ms }。 */
function grab(headers) {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const req = request(url, { method: "GET", headers }, (res) => {
			let bytes = 0;
			res.on("data", (chunk) => {
				bytes += chunk.length;
			});
			res.on("end", () => resolve({ status: res.statusCode || 0, bytes, encoding: String(res.headers["content-encoding"] || ""), ms: Date.now() - started }));
			res.on("error", reject);
		});
		req.on("error", reject);
		req.setTimeout(15000, () => req.destroy(new Error("timeout after 15s")));
		req.end();
	});
}

const results = [];
function ok(name, condition, detail = "") {
	results.push({ name, pass: Boolean(condition), detail });
}

let plain = null;
let packed = null;
try {
	plain = await grab({ "accept-encoding": "identity" });
	packed = await grab({ "accept-encoding": "gzip" });
} catch (error) {
	console.log("measure-state: 连不上 " + url + " —— " + String(error?.message ?? error));
	console.log("（端口每次重启都会变，用 --base http://127.0.0.1:<当前 GUI 端口>）");
	process.exit(1);
}

ok("两次请求都 200", plain.status === 200 && packed.status === 200, JSON.stringify({ plain: plain.status, packed: packed.status }));
ok("带 gzip 的请求真的回了 content-encoding: gzip", packed.encoding === "gzip", "encoding=" + (packed.encoding || "(空)"));
const ratio = plain.bytes > 0 ? packed.bytes / plain.bytes : 1;
ok("压缩后的线上字节 ≤ 原始 60%", ratio <= 0.6, "ratio=" + ratio.toFixed(3) + "（" + plain.bytes + " → " + packed.bytes + "）");
ok("两次拿到的原始字节都不为 0（量到了真东西）", plain.bytes > 0 && packed.bytes > 0, JSON.stringify({ plain: plain.bytes, packed: packed.bytes }));

const failed = results.filter((result) => !result.pass);
console.log("state 传输：" + plain.bytes + " B → " + packed.bytes + " B（" + (plain.bytes > 0 ? (plain.bytes / Math.max(packed.bytes, 1)).toFixed(2) : "?") + "×，压缩 " + (ratio * 100).toFixed(1) + "%）");
console.log("  不加 gzip：" + plain.ms + " ms｜加 gzip：" + packed.ms + " ms｜base=" + base);
for (const result of failed) console.log("FAIL " + result.name + (result.detail ? " —— " + result.detail : ""));
console.log("measure-state: passed " + (results.length - failed.length) + " / failed " + failed.length);
if (failed.length > 0) process.exit(1);
