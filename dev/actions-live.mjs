/**
 * dev/actions-live.mjs — **卡片动作的真机闸门核验**（只读：只出计划，绝不执行，R36）。
 *
 * 为什么要有它：R35 给面板加了四个"会真改东西"的动作。真机上验证它们时，最怕的是
 * "为了验一下就真删了一个 Skill"。这条命令只做四件事，全部**不产生写盘动作**：
 *   ① `/action/plan` 未知 id → 必须 `unknown-entry`（不静默成功）；
 *   ② `/action/apply` 不带 `confirm` → 必须 400（写盘闸在服务端，不是只靠按钮）；
 *   ③ `/action/trash` → 能读出回收站位置与条目（Skill 删除的后悔药是可见的）；
 *   ④ 对一个 Skill 出「删除计划」→ 计划里必须有回收站、目标目录与一次性 token；
 *      然后拿这个 token **再发一次不带 confirm 的 apply**（仍然 400）—— **绝不发 confirm:true**。
 *
 * ★ 计划只存在服务端内存里，5 分钟后自动过期；本脚本不会执行它。
 * ★ 用 `node:http`（不是 fetch）：undici keep-alive 在 `process.exit()` 会撞 libuv 断言。
 *
 * 用法：
 *   node dev/actions-live.mjs --base http://127.0.0.1:<GUI端口>
 *   node dev/actions-live.mjs --base ... --json
 * 退出码：0 = 四件事都符合预期；1 = 有不符合（或请求失败）。
 */

import http from "node:http";

function arg(name, fallback = "") {
	const index = process.argv.indexOf("--" + name);
	if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) return process.argv[index + 1];
	const prefix = "--" + name + "=";
	const inline = process.argv.find((item) => item.startsWith(prefix));
	return inline ? inline.slice(prefix.length) : fallback;
}

const asJson = process.argv.includes("--json");
const base = String(arg("base", process.env.DSH_WEB_URL || "")).replace(/\/+$/, "");
if (!base) {
	console.error("缺 --base（或在环境里给 DSH_WEB_URL）。每次重启 GUI 端口都会变，所以不写死。");
	process.exit(2);
}

function call(method, path, payload) {
	return new Promise((resolve) => {
		const body = payload === undefined ? "" : JSON.stringify(payload);
		const url = new URL(base + "/plugin-catalog" + path);
		const request = http.request(
			{
				hostname: url.hostname,
				port: url.port,
				path: url.pathname + url.search,
				method,
				headers: { accept: "application/json", "content-type": "application/json", ...(body ? { "content-length": Buffer.byteLength(body) } : {}) },
			},
			(response) => {
				let text = "";
				response.setEncoding("utf8");
				response.on("data", (chunk) => (text += chunk));
				response.on("end", () => {
					let json = null;
					try {
						json = JSON.parse(text || "{}");
					} catch {
						json = null;
					}
					resolve({ status: response.statusCode, json, text: text.slice(0, 200) });
				});
			},
		);
		request.on("error", (error) => resolve({ status: 0, json: null, error: String(error?.message ?? error) }));
		request.setTimeout(8000, () => request.destroy(new Error("timeout")));
		if (body) request.write(body);
		request.end();
	});
}

const checks = [];
function ok(name, condition, detail = "") {
	checks.push({ name, pass: Boolean(condition), detail });
}

const unknown = await call("POST", "/action/plan", { id: "plugin:live-check-does-not-exist", op: "uninstall" });
ok("A1 未知条目 → unknown-entry（不静默成功）", unknown.status === 200 && unknown.json?.ok === false && unknown.json?.code === "unknown-entry", JSON.stringify(unknown.json && { ok: unknown.json.ok, code: unknown.json.code }));

const gate = await call("POST", "/action/apply", {});
ok("A2 apply 不带 confirm → 400（写盘闸在服务端）", gate.status === 400 && gate.json?.ok === false && /confirm/.test(String(gate.json?.error || "")), JSON.stringify({ status: gate.status, error: gate.json?.error }));

const trash = await call("GET", "/action/trash");
ok("A3 回收站可读（root / items；Skill 删除的后悔药是可见的）", trash.status === 200 && trash.json?.ok === true && typeof trash.json?.root === "string" && Array.isArray(trash.json?.items), JSON.stringify({ status: trash.status, total: trash.json?.total }));

const state = await call("GET", "/state");
const entries = Array.isArray(state.json?.entries) ? state.json.entries : [];
const skill = entries.find((entry) => entry.kind === "skill" && entry.realDir);
const plugin = entries.find((entry) => entry.kind === "plugin" && entry.kind === "plugin");
const target = skill || plugin;
let plan = null;
if (!target) {
	ok("A4 从 /state 里找到一个可出计划的条目（Skill 优先）", false, "state 里没有 skill/plugin 条目");
} else {
	const op = target.kind === "skill" ? "delete" : "disable";
	plan = await call("POST", "/action/plan", { id: target.id, op });
	const shapeOk = plan.status === 200 && plan.json?.ok === true && typeof plan.json?.token === "string" && plan.json?.plan && typeof plan.json.plan.summary === "string";
	ok("A4 出计划成功并带一次性 token（" + target.kind + " / " + op + "）", shapeOk, JSON.stringify(plan.json && { ok: plan.json.ok, code: plan.json.code, error: plan.json.error }).slice(0, 220));
	if (shapeOk) {
		const summary = String(plan.json.plan.summary || "");
		if (target.kind === "skill") {
			ok("A5 Skill 删除计划写明「回收站」与目标目录", summary.includes("回收站") && summary.includes(target.realDir), summary.slice(0, 160));
			ok("A6 Skill 删除计划带「可还原」警告", (plan.json.plan.warnings || []).some((warning) => warning.code === "reversible"));
		} else {
			ok("A5 插件停用计划写明会保留文件与依赖", summary.includes("保留文件与依赖"), summary.slice(0, 160));
			ok("A6 插件停用计划的目标点名宿主 API", String(plan.json.plan.target || "").includes("setBundleEnabled") || String(plan.json.plan.target || "").includes("setPluginEnabled"), String(plan.json.plan.target || ""));
		}
		/* 拿真 token 再发一次**不带 confirm** 的 apply：仍然必须被拒，绝不发 confirm:true */
		const tokenGate = await call("POST", "/action/apply", { token: plan.json.token });
		ok("A7 真 token + 不带 confirm → 仍然 400（token 不是通行证）", tokenGate.status === 400 && tokenGate.json?.ok === false, JSON.stringify({ status: tokenGate.status, error: tokenGate.json?.error }));
	}
}

const failed = checks.filter((item) => !item.pass);
if (asJson) {
	console.log(JSON.stringify({ passed: checks.length - failed.length, failed: failed.length, target: target ? { id: target.id, kind: target.kind, name: target.name } : null, checks }, null, 1));
} else {
	console.log("");
	console.log("actions-live (R36)");
	console.log("  target: " + (target ? target.kind + " / " + target.name : "(none)"));
	console.log("  passed: " + (checks.length - failed.length));
	console.log("  failed: " + failed.length);
	if (failed.length > 0) {
		console.log("");
		for (const item of failed) console.log("  x " + item.name + (item.detail ? " -- " + item.detail : ""));
	}
	console.log("");
	console.log("  ★ 只出计划、未执行：计划 token 会在 5 分钟后自动过期。");
	console.log("actions-live: passed " + (checks.length - failed.length) + " / failed " + failed.length);
}
process.exit(failed.length > 0 ? 1 : 0);
