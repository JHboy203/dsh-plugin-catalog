/**
 * probe-mcp.mjs — MCP 判据的独立探针（R30）。
 *
 * 为什么单独一个探针：MCP 这一层全是**读文本、判启发式、按名字归属**的判据，
 * 而且错了不会报错 ——
 *   · `config:` 块在 parseComposition 里是刻意不认的（R22 的最小解析器），
 *     所以 serverName/command 得另读一遍；读错一个缩进就得到空 serverName；
 *   · 来源三分类是启发式（本地路径 / @deepseek-ai/ / 其余），判错不会崩，
 *     只会把"自己配置的"说成"第三方"；
 *   · 调用归属靠 `mcp__<server>__<tool>` 的前缀，切错位置就把工具记到别人账上；
 *   · **env / headers 的值绝不能进报告** —— 这条没有"跑挂了"的信号，只有泄漏。
 *
 * 全程**纯函数**：合成文本 + 合成统计表，不读 profile、不读 asar、不碰真实配置。
 *
 * 用法：`node dev/probe-mcp.mjs [--json]`；破任一断言退出码 1。
 */

import { attributeMcpCalls, buildMcpReport, classifyMcpServer, compactMcp, extractMcp, MCP_CLIENT_PACKAGE, MCP_RESOURCES_PACKAGE, MCP_TEMPLATE, mcpTargetText, parseMcpToolName, renderDisablePatch, renderMcpSection, safeUrlText, scanMcpBlock, summarizeMcp } from "../lib/mcp.mjs";

const results = [];
function ok(name, condition, detail = "") {
	results.push({ name, pass: Boolean(condition), detail });
}

const CORDIS = [
	"# 基线组合文件",
	"- id: mcp-filesystem",
	"  name: '@deepseek-ai/dsh-mcp-client'",
	"  config:",
	"    serverName: filesystem",
	"    transport: stdio",
	"    command: npx",
	"    args:",
	"      - '-y'",
	"      - '@modelcontextprotocol/server-filesystem'",
	"      - 'D:/ws'",
	"    env:",
	"      API_TOKEN: 'sk-should-never-leak'",
	"      LOG_LEVEL: debug",
	"- id: mcp-local",
	"  name: '@deepseek-ai/dsh-mcp-client'",
	"  config:",
	"    serverName: local",
	"    command: node",
	"    args: ['D:/ws/mcp-server.mjs']",
	"    cwd: D:/ws",
	"- id: mcp-remote",
	"  name: '@deepseek-ai/dsh-mcp-client'",
	"  config:",
	"    serverName: remote",
	"    transport: streamable-http",
	"    url: 'https://user:pass@example.com/mcp?token=abc'",
	"    headers:",
	"      Authorization: 'Bearer sk-also-secret'",
	"- id: mcp-loop",
	"  name: '@deepseek-ai/dsh-mcp-client'",
	"  config:",
	"    serverName: loop",
	"    transport: streamable-http",
	"    url: 'http://127.0.0.1:8934/mcp'",
	"- id: mcp-official",
	"  name: '@deepseek-ai/dsh-mcp-client'",
	"  config:",
	"    serverName: dsdocs",
	"    transport: stdio",
	"    command: npx",
	"    args: ['-y', '@deepseek-ai/dsh-mcp-docs']",
	"- id: mcp-resources",
	"  name: '@deepseek-ai/dsh-mcp-resources'",
].join("\n");

/* ── M1 — 解析：stdio 的字段都在 ── */
{
	const report = extractMcp({ files: [{ file: "cordis.yml", text: CORDIS }], at: 1 });
	const fs = report.servers.find((server) => server.serverName === "filesystem");
	ok("M1 stdio 条目解析出 serverName/transport/command/args", Boolean(fs) && fs.transport === "stdio" && fs.command === "npx" && fs.args.length === 3, JSON.stringify(fs && { t: fs.transport, c: fs.command, a: fs.args }));
	ok("M1b args 里的引号被剥掉、路径原样保留", Boolean(fs) && fs.args[2] === "D:/ws", fs ? fs.args[2] : "missing");
	ok("M1c env 只留键名（顺序保持）", Boolean(fs) && fs.envKeys.join(",") === "API_TOKEN,LOG_LEVEL", fs ? fs.envKeys.join(",") : "missing");
	ok("M1d 位置是 config 所在的那份文件与行号", Boolean(fs) && fs.file === "cordis.yml" && fs.line === 2, fs ? fs.file + ":" + fs.line : "missing");
}

/* ── M2 — 解析：streamable-http + 行内列表 + url 脱敏 ── */
{
	const report = extractMcp({ files: [{ file: "cordis.yml", text: CORDIS }], at: 1 });
	const remote = report.servers.find((server) => server.serverName === "remote");
	ok("M2 http 条目解析出 url 与 header 键", Boolean(remote) && remote.url.includes("example.com") && remote.headerKeys.join(",") === "Authorization", remote ? remote.url + " / " + remote.headerKeys.join(",") : "missing");
	ok("M2b 展示用的 url 去掉了 userinfo 与 query", Boolean(remote) && !remote.target.includes("pass") && !remote.target.includes("token") && remote.target.includes("example.com/mcp"), remote ? remote.target : "missing");
	ok("M2c 行内列表 args（[ 'a', 'b' ]）能读", report.servers.find((server) => server.serverName === "local").args.length === 1, JSON.stringify(report.servers.find((server) => server.serverName === "local").args));
	ok("M2d 没写 transport 时按 command/url 推断", report.servers.find((server) => server.serverName === "local").transport === "stdio", report.servers.find((server) => server.serverName === "local").transport);
}

/* ── M3 — 环境里绝不出现密钥值 ── */
{
	const report = extractMcp({ files: [{ file: "cordis.yml", text: CORDIS }], at: 1 });
	const json = JSON.stringify(report);
	ok("M3 报告里没有 env 的值（sk-should-never-leak）", !json.includes("sk-should-never-leak"), "泄漏了！");
	ok("M3b 报告里没有 header 的值（Bearer sk-also-secret）", !json.includes("sk-also-secret"), "泄漏了！");
	ok("M3c 报告里没有 url 的密码与 query token", !json.includes("token=abc") && !json.includes("user:pass"), "泄漏了！");
}

/* ── M4 — 来源三分类 ── */
{
	const report = extractMcp({ files: [{ file: "cordis.yml", text: CORDIS }], at: 1 });
	const byName = Object.fromEntries(report.servers.map((server) => [server.serverName, server]));
	ok("M4 自己配置：node 跑本地脚本 + cwd", byName.local.source === "self", byName.local.source + " / " + byName.local.sourceWhy.join("；"));
	ok("M4b 自己配置：环回 url", byName.loop.source === "self", byName.loop.source);
	ok("M4c 官方：引用了 @deepseek-ai/ 包", byName.dsdocs.source === "official", byName.dsdocs.source + " / " + byName.dsdocs.sourceWhy.join("；"));
	ok("M4d 第三方：npx 拉外部包 / 公网 url", byName.filesystem.source === "third" && byName.remote.source === "third", byName.filesystem.source + " / " + byName.remote.source);
	ok("M4e 分类理由不是空话（每条至少一句）", report.servers.every((server) => (server.sourceWhy || []).length > 0), JSON.stringify(report.servers.map((server) => server.sourceWhy)));
	ok("M4f counts.bySource 与逐台一致", report.counts.bySource.self === 2 && report.counts.bySource.official === 1 && report.counts.bySource.third === 2, JSON.stringify(report.counts.bySource));
}

/* ── M5 — 资源包单独抽（不是服务器） ── */
{
	const report = extractMcp({ files: [{ file: "cordis.yml", text: CORDIS }], at: 1 });
	ok("M5 资源包不进服务器列表", report.servers.every((server) => server.entryId !== "mcp-resources"), report.servers.map((server) => server.entryId).join(","));
	ok("M5b 资源包单独成行", report.resources.rows.length === 1 && report.resources.rows[0].id === "mcp-resources", JSON.stringify(report.resources.rows));
}

/* ── M6 — patch 合并：config 来自基线、disabled 来自 patch ── */
{
	const base = ["- id: mcp-x", "  name: '@deepseek-ai/dsh-mcp-client'", "  config:", "    serverName: x", "    transport: stdio", "    command: node", "    args: ['a.mjs']"].join("\n");
	const patch = ["- id: mcp-x", "  disabled: true"].join("\n");
	const report = extractMcp({ files: [{ file: "cordis.yml", text: base }, { file: "cordis.patch.yml", text: patch }], at: 1 });
	const x = report.servers.find((server) => server.serverName === "x");
	ok("M6 patch 只写 disabled 时 config 仍来自基线", Boolean(x) && x.command === "node" && x.args.length === 1, x ? x.command + " " + JSON.stringify(x.args) : "missing");
	ok("M6b disabled 以 patch 为准（state=off、enabled=false）", Boolean(x) && x.state === "off" && x.enabled === false, x ? x.state + "/" + x.enabled : "missing");
}

/* ── M7 — 配置问题：缺 serverName / 名字不合规 / 重名 / transport 不认 / 缺 command|url ── */
{
	const text = [
		"- id: a",
		"  name: '@deepseek-ai/dsh-mcp-client'",
		"  config:",
		"    transport: stdio",
		"    command: node",
		"- id: b",
		"  name: '@deepseek-ai/dsh-mcp-client'",
		"  config:",
		"    serverName: 'has space'",
		"    transport: stdio",
		"    command: node",
		"- id: c",
		"  name: '@deepseek-ai/dsh-mcp-client'",
		"  config:",
		"    serverName: dup",
		"    transport: weird",
		"    command: node",
		"- id: d",
		"  name: '@deepseek-ai/dsh-mcp-client'",
		"  config:",
		"    serverName: dup",
		"    transport: streamable-http",
	].join("\n");
	const report = extractMcp({ files: [{ file: "cordis.yml", text }], at: 1 });
	const codes = report.problems.map((problem) => problem.code);
	ok("M7 缺 serverName 被点名", codes.includes("no-server-name"));
	ok("M7b serverName 不合规范被点名", codes.includes("bad-server-name"));
	ok("M7c 重名被点名（两条都指出来）", codes.filter((code) => code === "duplicate").length === 2, JSON.stringify(codes));
	ok("M7d transport 不认被点名", codes.includes("bad-transport"));
	ok("M7e streamable-http 缺 url 被点名", codes.includes("no-url"));
	ok("M7f 有问题的服务器计数对得上", report.counts.withProblems === 4, String(report.counts.withProblems));
}

/* ── M8 — 工具名解析与归属 ── */
{
	ok("M8 工具名切成 server + tool", JSON.stringify(parseMcpToolName("mcp__filesystem__read_file")) === JSON.stringify({ server: "filesystem", tool: "read_file" }), JSON.stringify(parseMcpToolName("mcp__filesystem__read_file")));
	ok("M8b 不是 mcp__ 前缀的一律 null", parseMcpToolName("pwsh") === null && parseMcpToolName("mcp__") === null && parseMcpToolName("mcp__onlyserver") === null, "判据松了");
	const tools = new Map([
		["mcp__filesystem__read_file", { calls: 5, errors: 1, ms: 100, msCount: 2, lastUsed: 10, sessions: 2, sessionCounts: new Map([["s1", 2], ["s2", 3]]) }],
		["mcp__filesystem__list_dir", { calls: 3, errors: 0, msCount: 0, ms: 0, lastUsed: 20, sessions: 1, sessionCounts: new Map([["s2", 3]]) }],
		["mcp__gone__x", { calls: 2, errors: 0, msCount: 0, ms: 0, lastUsed: 5, sessions: 1, sessionCounts: new Map([["s3", 2]]) }],
		["pwsh", { calls: 99, errors: 0, msCount: 1, ms: 1, lastUsed: 99, sessions: 1, sessionCounts: new Map([["s9", 99]]) }],
	]);
	const digest = attributeMcpCalls(tools, { serverNames: ["filesystem"] });
	const fs = digest.byServer.filesystem;
	ok("M8c 同一服务器的多个工具合并计数（5+3）", fs.calls === 8, String(fs.calls));
	ok("M8d 会话按并集去重（s1 + s2）", fs.sessions === 2, String(fs.sessions));
	ok("M8e 工具按调用量倒序", fs.tools.map((tool) => tool.shortName).join(",") === "read_file,list_dir", fs.tools.map((tool) => tool.name).join(","));
	ok("M8f 非 mcp 工具完全不参与", digest.totalCalls === 10, String(digest.totalCalls));
	ok("M8g 孤儿调用只点没配置的服务器", digest.orphans.calls === 2 && digest.orphans.servers.join(",") === "gone", JSON.stringify(digest.orphans));
}

/* ── M9 — buildMcpReport：客户端包缺失、模板、notes ── */
{
	const report = buildMcpReport({ files: [{ file: "cordis.yml", text: CORDIS }], installed: new Map(), asarNames: new Set([MCP_CLIENT_PACKAGE, MCP_RESOURCES_PACKAGE]), at: 1 });
	ok("M9 客户端包在 asar 里时 present=true / inAsar=true", report.client.present === true && report.client.inAsar === true, JSON.stringify(report.client));
	ok("M9b 资源包状态也算出来", report.resources.present === true && report.resources.inAsar === true, JSON.stringify({ p: report.resources.present, a: report.resources.inAsar }));
	const missing = buildMcpReport({ files: [{ file: "cordis.yml", text: CORDIS }], installed: new Map(), asarNames: new Set(), at: 1 });
	ok("M9c 客户端包缺失时进 problems（否则「写了条目也不加载」没人知道）", missing.problems.some((problem) => problem.code === "no-client"), JSON.stringify(missing.problems.map((problem) => problem.code)));
	ok("M9d 模板三段都在、都指向客户端包", ["self", "third", "http"].every((key) => String(MCP_TEMPLATE[key]).includes(MCP_CLIENT_PACKAGE)), Object.keys(MCP_TEMPLATE).join(","));
	ok("M9e 0 台时也有一份 notes 解释「这不是插件」", (missing.notes || []).length >= 3, String((missing.notes || []).length));
}

/* ── M10 — compact / summarize / render ── */
{
	const report = buildMcpReport({ files: [{ file: "cordis.yml", text: CORDIS }], installed: new Map(), asarNames: new Set([MCP_CLIENT_PACKAGE]), at: 1 });
	const digest = attributeMcpCalls(new Map([["mcp__filesystem__read_file", { calls: 4, errors: 1, msCount: 1, ms: 40, lastUsed: 7, sessions: 1, sessionCounts: new Map([["s1", 4]]) }]]), { serverNames: report.servers.map((server) => server.serverName) });
	const compact = compactMcp(report, digest);
	const fs = compact.servers.find((server) => server.serverName === "filesystem");
	ok("M10 compact 把调用/工具数带到每台服务器", fs.calls === 4 && fs.toolCount === 1 && fs.errors === 1, JSON.stringify({ c: fs.calls, t: fs.toolCount, e: fs.errors }));
	ok("M10b compact 的 counts.withCalls 只数有调用的", compact.counts.withCalls === 1, String(compact.counts.withCalls));
	ok("M10c compact 带 template 与 notes（空态要能直接抄）", Boolean(compact.template && compact.template.self) && (compact.notes || []).length > 0);
	const empty = compactMcp(buildMcpReport({ files: [{ file: "cordis.yml", text: "# 空" }], installed: new Map(), asarNames: new Set(), at: 1 }), null);
	ok("M10d 0 台时 summarize 说的是「还没有配置」而不是「读失败」", /还没有配置/.test(summarizeMcp(buildMcpReport({ files: [{ file: "cordis.yml", text: "" }], installed: new Map(), asarNames: new Set(), at: 1 }))), summarizeMcp(buildMcpReport({ files: [{ file: "cordis.yml", text: "" }], installed: new Map(), asarNames: new Set(), at: 1 })));
	ok("M10e 0 台时 renderMcpSection 也给模板指引", renderMcpSection(buildMcpReport({ files: [{ file: "cordis.yml", text: "" }], installed: new Map(), asarNames: new Set(), at: 1 }), null).join("\n").includes("还没有配置"));
	ok("M10f 有调用时 renderMcpSection 的表格行数对得上", renderMcpSection(report, digest).filter((line) => line.startsWith("| `")).length === report.servers.length, String(report.servers.length));
}

/* ── M11 — 边界：空输入、怪输入都不抛 ── */
{
	let threw = "";
	try {
		const report = extractMcp({});
		ok("M11 空输入给出合法空报告", report.servers.length === 0 && report.counts.total === 0, JSON.stringify(report.counts));
		extractMcp({ files: [{ file: "", text: null }] });
		scanMcpBlock([], 0);
	} catch (error) {
		threw = String(error?.message ?? error);
	}
	ok("M11b 空/怪输入不抛异常", threw === "", threw);
	ok("M11c scanMcpBlock 对没有 config 的条目给空块", scanMcpBlock(["- id: a", "  name: x"], 0).hasConfig === false, "hasConfig 判据松了");
	ok("M11d safeUrlText 对非 URL 不抛、并截断", safeUrlText("not a url but long enough to be truncated " + "x".repeat(100)).length <= 81, String(safeUrlText("not a url").length));
	ok("M11e mcpTargetText 对空配置给一句人话", mcpTargetText({}) === "（没写 command / url）", mcpTargetText({}));
	ok("M11f classifyMcpServer 对空对象也不抛", classifyMcpServer({}).source === "third", JSON.stringify(classifyMcpServer({})));
}

/* ── M12 — 停用片段（R31）：只出文本、按 id、幂等 ── */
{
	const report = buildMcpReport({ files: [{ file: "cordis.yml", text: CORDIS }], installed: new Map(), asarNames: new Set([MCP_CLIENT_PACKAGE]), at: 1 });
	const server = report.servers[0];
	const snippet = renderDisablePatch(server);
	ok("M12 片段按条目 id 覆盖（不带 name/config，免得把旧 config 钉死）", snippet.ok === true && snippet.text.includes("- id: " + server.entryId) && !snippet.text.includes("name:") && !snippet.text.includes("config:"), snippet.text.replace(/\n/g, " ⏎ "));
	ok("M12b 片段里有 disabled: true 且说了要重启（Desktop 不 watch patch 层）", snippet.text.includes("disabled: true") && /重启 DSH/.test(snippet.text));
	ok("M12c 位置 file:line 带回来（人去哪改是明确的）", snippet.at === String(server.file) + ":" + String(server.line), snippet.at);
	ok("M12d 没有条目 id 时明确拒绝（不瞎给一段无效 YAML）", renderDisablePatch({ serverName: "x" }).ok === false && renderDisablePatch(null).ok === false);
	ok("M12e 声明在 patch 文件里的条目：片段改成「在原文里加一行」而不是再追加一条", (() => {
		const patched = renderDisablePatch({ entryId: "mcp-x", serverName: "x", file: "C:/p/cordis.patch.yml", line: 12, state: "on" });
		return patched.ok === true && patched.inPatch === true && /patch 文件里/.test(patched.text);
	})());
	ok("M12f 已经关掉的那台：片段前会先说一句「现在就是关的」（幂等，不吓人）", renderDisablePatch({ entryId: "mcp-x", serverName: "x", file: "cordis.yml", line: 3, state: "off", disabledRaw: "true" }).text.includes("现在已经是关掉的"));
}

const failed = results.filter((result) => !result.pass);
if (process.argv.includes("--json")) {
	console.log(JSON.stringify({ version: 1, results }, null, 2));
} else {
	for (const result of results) if (!result.pass) console.log("FAIL " + result.name + (result.detail ? " —— " + result.detail : ""));
	console.log("probe-mcp: passed " + (results.length - failed.length) + " / failed " + failed.length);
}
if (failed.length > 0) process.exit(1);
