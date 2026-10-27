/**
 * dsh-plugin-catalog / mcp —— MCP 服务器（R30）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么 MCP 不能只当成"又一个插件"
 * ══════════════════════════════════════════════════════════════════════════
 *
 * DSH 的 MCP 由官方包 `@deepseek-ai/dsh-mcp-client` 实现，**每台服务器就是
 * cordis 组合文件里的一条条目**：
 *
 *   - id: mcp-filesystem
 *     name: '@deepseek-ai/dsh-mcp-client'
 *     config:
 *       serverName: filesystem        # 工具名里的那一段：mcp__<serverName>__<tool>
 *       transport: stdio              # stdio | streamable-http
 *       command: npx
 *       args: ['-y', '@modelcontextprotocol/server-filesystem', 'D:/docs']
 *
 * 于是：
 *   · 它不是"装进来的包"，`dsh.profile.bundles` 里永远没有它 → 四态加载判据看不见；
 *   · `enabled` 也没有意义 —— 加载与否由 `disabled` 与 transport 是否可用决定；
 *   · 它的工具名是 `mcp__<serverName>__<rawName>`，**归属靠名字前缀**，
 *     不能靠描述指纹（attrib 里根本没有这些工具）。
 *
 * ★ 本条模块只做**纯函数**：解析声明文本、分类来源、按名字归属调用、出报告。
 *   IO（读 profile / 读 asar / 读统计缓存）全在 lib/service.mjs，探针可以
 *   对着合成文本直接断言，不碰真实配置。
 *
 * ★ 安全：`env` / `headers` 的**值永不进报告**，只留键名；url 去掉 userinfo 与 query。
 *   这台机器的面板会被截图、导出、发给人看 —— 一处漏值等于把 token 贴出去。
 *
 * @module dsh-plugin-catalog/mcp
 */

import { mergeCompositionEntries, packageNameOf, parseComposition } from "./composition.mjs";

/** 报告结构版本：改字段形状要 +1（面板客户端与宿主可以各自升级）。 */
export const MCP_VERSION = 1;

/** 官方 MCP 客户端包：每台服务器都是它的一条配置条目。 */
export const MCP_CLIENT_PACKAGE = "@deepseek-ai/dsh-mcp-client";

/** 官方 MCP 资源共享包：不是"服务器"，是共享能力（资源发现）。 */
export const MCP_RESOURCES_PACKAGE = "@deepseek-ai/dsh-mcp-resources";

/** 来源三分类（与插件那套 official/self/third 同名，才能共用来源筛选）。 */
export const MCP_SOURCES = Object.freeze(["official", "third", "self"]);

/** 来源人话（UI/报告单源）。 */
export const MCP_SOURCE_LABEL = Object.freeze({ official: "官方", third: "第三方", self: "自己配置" });

/** 支持的传输方式（README 的字段表：stdio / streamable-http；streamable-http 的旧名 http 也认）。 */
export const MCP_TRANSPORTS = Object.freeze(["stdio", "streamable-http"]);

/** serverName 的合法形状（README：`[A-Za-z0-9_-]{1,32}`，作用域内唯一）。 */
const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** 状态人话。 */
export const MCP_STATE_LABEL = Object.freeze({ on: "启用", off: "关掉", expression: "条件启用" });

/**
 * 空态模板：本机还没配置任何 MCP 服务器时，面板要能直接抄一段去改。
 * 三段正好对应来源三分类 —— 抄哪段决定它落在哪一类。
 */
export const MCP_TEMPLATE = Object.freeze({
	/** 自己配置：本地脚本 + 本地目录 */
	self: [
		"# cordis.yml（或 cordis.patch.yml）里追加。改完要重启 DSH（patch 层不热更）。",
		"- id: mcp-my-tool",
		"  name: '@deepseek-ai/dsh-mcp-client'",
		"  config:",
		"    serverName: my-tool            # 工具名会是 mcp__my-tool__<tool>",
		"    transport: stdio",
		"    command: node",
		"    args:",
		"      - 'D:/your-workspace/.tools/my-mcp-server.mjs'",
		"    env:",
		"      TOKEN: '...'                 # 值不会显示在面板/报告里，只显示键名",
	].join("\n"),
	/** 第三方：npx 拉一个外部 MCP 包 */
	third: [
		"- id: mcp-filesystem",
		"  name: '@deepseek-ai/dsh-mcp-client'",
		"  config:",
		"    serverName: filesystem",
		"    transport: stdio",
		"    command: npx",
		"    args:",
		"      - '-y'",
		"      - '@modelcontextprotocol/server-filesystem'",
		"      - 'D:/your-workspace'",
	].join("\n"),
	/** 远程：streamable-http */
	http: [
		"- id: mcp-remote",
		"  name: '@deepseek-ai/dsh-mcp-client'",
		"  config:",
		"    serverName: remote",
		"    transport: streamable-http",
		"    url: 'https://example.com/mcp'",
		"    headers:",
		"      Authorization: 'Bearer ...'   # 同样只显示键名",
	].join("\n"),
});

/** 纯文本标签（报告/工具输出用同一个措辞，别各写各的）。 */
export function mcpSourceText(source) {
	return MCP_SOURCE_LABEL[source] || String(source || "未知");
}

/** 状态人话。 */
export function mcpStateText(state) {
	return MCP_STATE_LABEL[state] || String(state || "未知");
}

/** 去引号（YAML 的单引号/双引号都见得到）。 */
function unquote(value) {
	const text = String(value ?? "").trim();
	if (text.length >= 2) {
		const first = text[0];
		const last = text[text.length - 1];
		if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
			const inner = text.slice(1, -1);
			return first === "'" ? inner.replace(/''/g, "'") : inner.replace(/\\"/g, '"');
		}
	}
	return text;
}

/** 行内流式列表 `['a', 'b']`（少见但合法）。 */
function parseInlineList(raw) {
	const text = String(raw || "").trim();
	if (!text.startsWith("[") || !text.endsWith("]")) return null;
	const inner = text.slice(1, -1).trim();
	if (inner === "") return [];
	return inner
		.split(",")
		.map((part) => unquote(part.trim()))
		.filter((part) => part !== "");
}

/**
 * 把 URL 变成可展示的形状：去掉 userinfo 与 query（那里最常放 token），
 * 只留 `https://host/path`。解析失败就原样返回（截断），不要吞掉线索。
 */
export function safeUrlText(url) {
	const text = String(url || "").trim();
	if (text === "") return "";
	try {
		const parsed = new URL(text);
		const path = parsed.pathname === "/" ? "" : parsed.pathname;
		const hidden = parsed.username !== "" || parsed.password !== "" || parsed.search !== "";
		return parsed.protocol + "//" + parsed.host + path + (hidden ? "（凭据/query 已隐藏）" : "");
	} catch {
		return text.length > 80 ? text.slice(0, 80) + "…" : text;
	}
}

/**
 * 从条目起始行往后读 `config:` 块（最小 YAML 子集）。
 *
 * ★ 为什么不用 parseComposition：它刻意只认 `id / name / disabled`（R22 的最小解析器），
 *   `config:` 里的嵌套条目一律不认 —— 而 serverName/command 恰好全在 config 里。
 *   这里读的是**同一份文本**，只是换一个范围，不改 parseComposition 的契约。
 *
 * @param {string[]} lines 整份文件按行拆开
 * @param {number} startIndex 条目起始行的下标（0 基）
 * @returns {{serverName:string,transport:string,command:string,args:string[],url:string,cwd:string,env:string[],headers:string[],failOnStartupError:boolean|null,toolCallTimeoutMs:number|null,hasConfig:boolean}}
 */
export function scanMcpBlock(lines, startIndex) {
	const out = {
		serverName: "",
		transport: "",
		command: "",
		args: [],
		url: "",
		cwd: "",
		env: [],
		headers: [],
		failOnStartupError: null,
		toolCallTimeoutMs: null,
		hasConfig: false,
	};
	const list = Array.isArray(lines) ? lines : [];
	let configIndent = -1;
	let section = "";
	for (let index = startIndex + 1; index < list.length; index += 1) {
		const line = String(list[index] ?? "");
		if (line.trim() === "") continue;
		/* 下一个顶层条目 / 顶层文档段 —— 块结束 */
		if (/^-\s/.test(line) || /^\S/.test(line)) break;
		const indent = /^\s*/.exec(line)[0].length;
		const body = line.trim();
		if (configIndent < 0) {
			if (/^config:\s*$/.test(body)) {
				configIndent = indent;
				out.hasConfig = true;
				continue;
			}
			continue;
		}
		/* config 块结束（回到同级或更浅） */
		if (indent <= configIndent) {
			configIndent = -1;
			section = "";
			continue;
		}
		if (body.startsWith("- ")) {
			const value = unquote(body.slice(2).trim());
			if (section === "args") out.args.push(value);
			continue;
		}
		const match = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(body);
		if (!match) continue;
		const key = match[1];
		const rawValue = match[2];
		/* `env:` / `headers:` / `args:` 后面是缩进子项 */
		if (rawValue === "") {
			section = key;
			if (key === "args") out.args = [];
			continue;
		}
		if (key === "args") {
			const inline = parseInlineList(rawValue);
			if (inline) out.args = inline;
			section = "";
			continue;
		}
		/* env / headers 的子键：**只记键名**，值一律不进报告 */
		if (section === "env" || section === "headers") {
			const bucket = section === "env" ? out.env : out.headers;
			if (!bucket.includes(key)) bucket.push(key);
			continue;
		}
		section = "";
		const value = unquote(rawValue);
		if (key === "serverName") out.serverName = value;
		else if (key === "transport") out.transport = value;
		else if (key === "command") out.command = value;
		else if (key === "url") out.url = value;
		else if (key === "cwd") out.cwd = value;
		else if (key === "failOnStartupError") out.failOnStartupError = value === "true";
		else if (key === "toolCallTimeoutMs") out.toolCallTimeoutMs = Number(value) || null;
	}
	/* transport 没写时的推断：有 url 就是 http，有 command 就是 stdio */
	if (out.transport === "") out.transport = out.url !== "" ? "streamable-http" : out.command !== "" ? "stdio" : "";
	return out;
}

/** 目标一句话（卡片/报告共用）：stdio 给命令，http 给脱敏后的 url。 */
export function mcpTargetText(server, max = 120) {
	const command = String(server?.command || "");
	const args = Array.isArray(server?.args) ? server.args : [];
	const url = safeUrlText(server?.url || "");
	const text = url !== "" ? url : [command, ...args].filter(Boolean).join(" ");
	if (text === "") return "（没写 command / url）";
	return text.length > max ? text.slice(0, max) + "…" : text;
}

/** 本地路径判定（绝对路径 / 盘符 / UNC / 显式相对）。 */
function looksLikeLocalPath(value) {
	const text = String(value || "").trim();
	if (text === "") return false;
	if (/^(file:\/\/|\/|[A-Za-z]:[\\/]|\\\\|\.{1,2}[\\/])/.test(text)) return true;
	if (/\.(mjs|cjs|js|ts|py|ps1|cmd|bat|exe|sh)$/i.test(text)) return true;
	return false;
}

/** 解释器名（`node x.js` 这种：脚本是不是本地的要看 args）。 */
const INTERPRETERS = new Set(["node", "nodejs", "deno", "bun", "python", "python3", "py", "pwsh", "powershell", "cmd", "bash", "sh", "uv"]);

/**
 * 来源三分类：**官方 / 第三方 / 自己配置**。
 *
 * 判据（顺序即优先级，理由写进 `why` 让面板显示 —— 用户要能看到"凭什么"）：
 *   1. 自己配置：命令指向本地文件、或 cwd 设了本地目录、或 url 是环回地址；
 *   2. 官方：命令/参数/url 里出现 `@deepseek-ai/`（DSH 官方提供的 MCP 包）；
 *   3. 第三方：其余（npx/uvx/docker 拉外部包、公网 url）。
 *
 * ★ 这是**启发式**，不是结论：面板会带「来源可手工改」的提示（catalog_tag source）。
 */
export function classifyMcpServer(server) {
	const command = String(server?.command || "").trim();
	const args = Array.isArray(server?.args) ? server.args.map(String) : [];
	const url = String(server?.url || "").trim();
	const cwd = String(server?.cwd || "").trim();
	const why = [];

	const loopback = /^(https?:\/\/)?(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(url);
	if (loopback) why.push("url 指向本机环回地址");
	if (cwd !== "") why.push("配了本地 cwd");
	if (looksLikeLocalPath(command)) why.push("command 是本地文件路径");
	else if (INTERPRETERS.has(command.toLowerCase())) {
		const firstArg = args.find((arg) => !arg.startsWith("-"));
		if (firstArg && looksLikeLocalPath(firstArg)) why.push("用 " + command + " 跑本地脚本");
	}
	if (why.length > 0) return { source: "self", why };

	const official = [command, ...args, url].some((value) => value.includes("@deepseek-ai/"));
	if (official) return { source: "official", why: ["引用了 @deepseek-ai/ 官方包"] };

	if (url !== "") why.push("公网 url");
	if (["npx", "uvx", "bunx", "pnpm", "docker", "uv"].includes(command.toLowerCase())) why.push("由 " + command + " 拉起外部包");
	if (why.length === 0) why.push("没看出本地路径，也没有 @deepseek-ai/ 前缀");
	return { source: "third", why };
}

/**
 * 从组合文件抽 MCP 服务器与官方资源能力包。
 *
 * @param {{files?: Array<{file?:string, text?:string}>}} input
 * @returns {{version:number, at:number, client:{package:string,declared:number}, resources:{package:string, rows:Array<object>}, servers:Array<object>, problems:Array<object>, counts:object}}
 */
export function extractMcp(input = {}) {
	const files = Array.isArray(input.files) ? input.files.filter((file) => file && typeof file === "object") : [];
	const at = Number(input.at) || Date.now();
	const linesByFile = new Map();
	const parsedByFile = new Map();
	for (const file of files) {
		const text = String(file.text ?? "");
		linesByFile.set(String(file.file || ""), text.split(/\r?\n/));
		parsedByFile.set(String(file.file || ""), parseComposition(text, { file: String(file.file || "") }));
	}

	/* 条目按 id 合并（patch 语义）；同 id 的 config 按文件顺序取"最后写了这个字段的那份" */
	const merged = mergeCompositionEntries(files.flatMap((file) => parsedByFile.get(String(file.file || "")) || []));
	const mergedById = new Map(merged.map((entry) => [String(entry.id || ""), entry]));

	const rawEntries = files.flatMap((file) =>
		(parsedByFile.get(String(file.file || "")) || []).map((entry) => ({ entry, file: String(file.file || "") })),
	);

	const clientGroups = new Map();
	const resources = [];
	const problems = [];

	for (const { entry, file } of rawEntries) {
		const pkg = packageNameOf(entry.name || "");
		if (pkg !== MCP_CLIENT_PACKAGE && pkg !== MCP_RESOURCES_PACKAGE) continue;
		const lines = linesByFile.get(file) || [];
		const block = scanMcpBlock(lines, Math.max(0, (Number(entry.line) || 1) - 1));
		if (pkg === MCP_RESOURCES_PACKAGE) {
			resources.push({ id: entry.id || "", package: MCP_RESOURCES_PACKAGE, state: entry.disabledKind, enabled: entry.disabledKind !== "off", file, line: entry.line });
			continue;
		}
		const key = String(entry.id || "") || "serverName:" + (block.serverName || "");
		const previous = clientGroups.get(key);
		const row = { entry, block, file };
		if (!previous) clientGroups.set(key, [row]);
		else previous.push(row);
	}

	const servers = [];
	for (const rows of clientGroups.values()) {
		/* 逐字段合并：后出现的非空覆盖（patch 只写 disabled 时，config 仍来自基线） */
		const mergedEntry = mergedById.get(String(rows[0].entry.id || "")) || rows[rows.length - 1].entry;
		const cfg = { serverName: "", transport: "", command: "", args: [], url: "", cwd: "", env: [], headers: [], failOnStartupError: null, toolCallTimeoutMs: null, hasConfig: false };
		let file = rows[0].file;
		let line = rows[0].entry.line;
		for (const row of rows) {
			const block = row.block;
			if (block.serverName) cfg.serverName = block.serverName;
			if (block.transport) cfg.transport = block.transport;
			if (block.command) cfg.command = block.command;
			if (block.args.length > 0) cfg.args = block.args.slice();
			if (block.url) cfg.url = block.url;
			if (block.cwd) cfg.cwd = block.cwd;
			if (block.env.length > 0) cfg.env = block.env.slice();
			if (block.headers.length > 0) cfg.headers = block.headers.slice();
			if (block.failOnStartupError !== null) cfg.failOnStartupError = block.failOnStartupError;
			if (block.toolCallTimeoutMs !== null) cfg.toolCallTimeoutMs = block.toolCallTimeoutMs;
			if (block.hasConfig) {
				file = row.file;
				line = row.entry.line;
			}
			cfg.hasConfig = cfg.hasConfig || block.hasConfig;
		}
		const state = mergedEntry?.disabledKind || "on";
		const server = {
			id: "mcp:" + (cfg.serverName || String(rows[0].entry.id || "unnamed")),
			kind: "mcp",
			entryId: String(mergedEntry?.id || rows[0].entry.id || ""),
			serverName: cfg.serverName,
			transport: cfg.transport,
			command: cfg.command,
			args: cfg.args,
			url: cfg.url,
			cwd: cfg.cwd,
			envKeys: cfg.env,
			headerKeys: cfg.headers,
			failOnStartupError: cfg.failOnStartupError,
			toolCallTimeoutMs: cfg.toolCallTimeoutMs,
			state,
			enabled: state !== "off",
			disabledRaw: mergedEntry?.disabledRaw || "",
			file,
			line,
			problems: [],
		};
		const classified = classifyMcpServer(server);
		server.source = classified.source;
		server.sourceWhy = classified.why;
		/* target 用**原始** url 算（它自己会脱敏），然后 url 字段也换成脱敏版 ——
		   `url` 会被下发到浏览器、写进报告，原值里可能带 token/密码，绝不能留。 */
		server.target = mcpTargetText(server);
		const rawUrl = String(server.url || "");
		server.url = rawUrl === "" ? "" : safeUrlText(rawUrl);
		servers.push(server);
	}

	/* 校验：缺 serverName / 名字不合规 / 重名 / transport 不认 / 缺 command|url */
	const nameCounts = new Map();
	for (const server of servers) {
		if (server.serverName === "") continue;
		nameCounts.set(server.serverName, (nameCounts.get(server.serverName) || 0) + 1);
	}
	for (const server of servers) {
		if (server.serverName === "") server.problems.push({ code: "no-server-name", level: "bad", message: "缺 serverName：这条不会成为一台服务器（工具名无从命名）" });
		else if (!SERVER_NAME_RE.test(server.serverName)) server.problems.push({ code: "bad-server-name", level: "bad", message: "serverName 不合规范（只允许 A-Z a-z 0-9 _ -，1~32 字符）" });
		if (server.transport !== "" && !MCP_TRANSPORTS.includes(server.transport)) server.problems.push({ code: "bad-transport", level: "bad", message: "transport 只认 stdio / streamable-http，这里写的是 " + server.transport });
		if (server.transport === "stdio" && server.command === "") server.problems.push({ code: "no-command", level: "bad", message: "stdio 缺 command" });
		if (server.transport === "streamable-http" && server.url === "") server.problems.push({ code: "no-url", level: "bad", message: "streamable-http 缺 url" });
		if (server.transport === "") server.problems.push({ code: "no-transport", level: "warn", message: "没写 transport，也没有 command/url —— 这条什么都不会连" });
		if (server.serverName !== "" && (nameCounts.get(server.serverName) || 0) > 1) {
			/* ★ 重名要**两条都**点名：只标后一条的话，前一条看起来像"好的"，
			   而实际加载时这一对会一起被拒（README 明说同一作用域内 serverName 必须唯一）。 */
			server.problems.push({ code: "duplicate", level: "bad", message: "serverName `" + server.serverName + "` 有 " + nameCounts.get(server.serverName) + " 条重复（加载时会被拒）" });
		}
		for (const problem of server.problems) problems.push({ ...problem, id: server.id, name: server.serverName || server.id });
	}

	servers.sort((a, b) => String(a.serverName).localeCompare(String(b.serverName)));

	const counts = {
		total: servers.length,
		on: servers.filter((server) => server.state === "on").length,
		off: servers.filter((server) => server.state === "off").length,
		conditional: servers.filter((server) => server.state === "expression").length,
		bySource: {
			official: servers.filter((server) => server.source === "official").length,
			third: servers.filter((server) => server.source === "third").length,
			self: servers.filter((server) => server.source === "self").length,
		},
		withProblems: servers.filter((server) => server.problems.length > 0).length,
	};

	return {
		version: MCP_VERSION,
		at,
		client: { package: MCP_CLIENT_PACKAGE, declared: servers.length },
		resources: { package: MCP_RESOURCES_PACKAGE, rows: resources.sort((a, b) => String(a.id).localeCompare(String(b.id))) },
		servers,
		problems,
		counts,
	};
}

/**
 * 工具名 → { server, tool }。
 *
 * 命名契约：`mcp__<serverName>__<rawName>`（见 dsh-mcp-client README）。
 * ★ 两个名字里都可能带 `_`，所以按**第一个** `__` 切 —— serverName 本身就允许
 *   `_`，写成 `a__b` 时两种切法都成立；这种情况按契约取"最长合法 serverName"
 *   也无从判定，面板与报告都用同一个切法（这里），不在别处再猜一次。
 */
export function parseMcpToolName(name) {
	const text = String(name || "");
	if (!text.startsWith("mcp__")) return null;
	const rest = text.slice(5);
	const index = rest.indexOf("__");
	if (index <= 0) return null;
	const server = rest.slice(0, index);
	const tool = rest.slice(index + 2);
	if (server === "" || tool === "") return null;
	return { server, tool };
}

/**
 * 把 `mcp__*` 的调用按服务器聚合。
 *
 * @param {Iterable<[string, object]>} tools 聚合里的 `[toolName, tool]`（lib/stats.mjs 的形状）
 * @param {{serverNames?: string[]}} [options] 已配置的服务器名（用来挑出"孤儿调用"）
 * @returns {{byServer:Object<string,object>, orphans:object, totalCalls:number}}
 */
export function attributeMcpCalls(tools, options = {}) {
	const known = new Set((Array.isArray(options.serverNames) ? options.serverNames : []).map(String));
	const byServer = {};
	const orphans = { servers: [], tools: [], calls: 0, errors: 0 };
	let totalCalls = 0;

	const bucketOf = (server) => {
		if (!byServer[server]) byServer[server] = { server, calls: 0, errors: 0, lastUsed: 0, sessionCounts: new Map(), tools: [] };
		return byServer[server];
	};

	for (const [name, tool] of tools || []) {
		const parsed = parseMcpToolName(name);
		if (!parsed || !tool) continue;
		const bucket = bucketOf(parsed.server);
		const calls = Number(tool.calls) || 0;
		const errors = Number(tool.errors) || 0;
		bucket.calls += calls;
		bucket.errors += errors;
		totalCalls += calls;
		if (Number(tool.lastUsed) > bucket.lastUsed) bucket.lastUsed = Number(tool.lastUsed) || 0;
		/* 会话计数要累加：同一台服务器有多个工具，每个工具各自记着自己那份 */
		for (const [sessionId, count] of tool.sessionCounts?.entries?.() || []) {
			bucket.sessionCounts.set(sessionId, (bucket.sessionCounts.get(sessionId) || 0) + (Number(count) || 0));
		}
		bucket.tools.push({
			name,
			shortName: parsed.tool,
			calls,
			errors,
			incomplete: Number(tool.incomplete) || 0,
			avgMs: Number(tool.msCount) > 0 ? Math.round(Number(tool.ms) / Number(tool.msCount)) : 0,
			lastUsed: Number(tool.lastUsed) || 0,
			sessions: Number(tool.sessions) || 0,
		});
		if (!known.has(parsed.server)) {
			orphans.calls += calls;
			orphans.errors += errors;
			if (!orphans.servers.includes(parsed.server)) orphans.servers.push(parsed.server);
			orphans.tools.push(name);
		}
	}

	for (const bucket of Object.values(byServer)) {
		bucket.tools.sort((a, b) => b.calls - a.calls);
		bucket.sessions = bucket.sessionCounts.size;
	}
	orphans.servers.sort();
	orphans.tools.sort();

	return { byServer, orphans, totalCalls };
}

/**
 * 报告（工具/报告层用的完整形状）。纯函数：调用方给 files，这里不读盘。
 *
 * @param {{files?:Array<object>, installed?:Map<string,object>|object, asarNames?:Set<string>|null, at?:number}} input
 */
export function buildMcpReport(input = {}) {
	const extracted = extractMcp(input);
	const installed = input.installed instanceof Map ? input.installed : new Map(Object.entries(input.installed || {}));
	const asarNames = input.asarNames instanceof Set ? input.asarNames : null;
	const presentOf = (pkg) => {
		if (installed.has(pkg)) return { present: true, inAsar: false };
		if (asarNames && asarNames.has(pkg)) return { present: true, inAsar: true };
		return { present: false, inAsar: false };
	};
	const client = presentOf(MCP_CLIENT_PACKAGE);
	const resourcesPresent = presentOf(MCP_RESOURCES_PACKAGE);

	const problems = extracted.problems.slice();
	if (!client.present) {
		problems.push({ code: "no-client", level: "warn", message: "本机找不到 " + MCP_CLIENT_PACKAGE + "：就算写了条目也不会加载（官方的 MCP 客户端包缺失）", id: "mcp-client", name: "客户端包" });
	}

	return {
		...extracted,
		client: { ...extracted.client, ...client },
		resources: { ...extracted.resources, ...resourcesPresent, rows: extracted.resources.rows },
		problems,
		notes: [
			"每台服务器是 cordis 组合文件里的一条 `" + MCP_CLIENT_PACKAGE + "` 条目；它不出现在 dsh.profile.bundles 里，所以四态加载判据看不见它。",
			"工具名是 `mcp__<serverName>__<tool>`；调用统计按这个名字前缀归到服务器，不靠描述指纹。",
			"`env` / `headers` 的值不会进面板与报告，只显示键名；url 的 userinfo 与 query 也隐藏。",
			"这台机器还没有配置任何 MCP 服务器时，面板给「空态 + 可抄的模板」而不是一张空表。",
		],
		template: MCP_TEMPLATE,
	};
}

/** 面板/`/state` 的紧凑视图（服务器一般 0~20 台，全给；明细在 catalog_mcp）。 */
export function compactMcp(report, attribution = null) {
	if (!report) return null;
	const byServer = attribution?.byServer || {};
	const servers = (report.servers || []).map((server) => {
		const usage = byServer[server.serverName] || null;
		return {
			id: server.id,
			kind: "mcp",
			serverName: server.serverName,
			transport: server.transport,
			target: server.target,
			command: server.command,
			args: server.args,
			url: server.url,
			cwd: server.cwd,
			envKeys: server.envKeys,
			headerKeys: server.headerKeys,
			failOnStartupError: server.failOnStartupError,
			toolCallTimeoutMs: server.toolCallTimeoutMs,
			state: server.state,
			enabled: server.enabled,
			disabledRaw: server.disabledRaw,
			file: server.file,
			line: server.line,
			entryId: server.entryId,
			source: server.source,
			sourceWhy: server.sourceWhy,
			problems: server.problems,
			calls: usage ? usage.calls : 0,
			errors: usage ? usage.errors : 0,
			lastUsed: usage ? usage.lastUsed : 0,
			sessions: usage ? usage.sessions : 0,
			toolCount: usage ? usage.tools.length : 0,
			tools: usage ? usage.tools.slice(0, 20) : [],
		};
	});
	return {
		version: report.version,
		at: report.at,
		client: report.client,
		resources: report.resources,
		counts: { ...report.counts, withCalls: servers.filter((server) => server.calls > 0).length },
		servers,
		problems: report.problems,
		orphans: attribution?.orphans || { servers: [], tools: [], calls: 0, errors: 0 },
		totalCalls: attribution?.totalCalls || 0,
		notes: report.notes,
		template: report.template,
	};
}

/**
 * 给出「停用这台服务器」的 `cordis.patch.yml` 片段（**只出文本，绝不写盘**）。
 *
 * 为什么需要它：加一台 MCP 有模板（`view=template`），但**停一台**没有 ——
 * 用户只能自己猜"改哪份文件、按 id 还是按 name、要不要带 config"。
 * 这里把三件事一次说清：位置（file:line）、幂等（已经关掉了就别再改）、后果（改完要重启 DSH）。
 *
 * ★ 判据只依赖条目 id（cordis 的 patch 按 id 覆盖）：只写 `disabled: true` 就够，
 *   不带 `name` + `config` —— 带了反而会在下一次 DSH 升级时把旧 config 钉死。
 *
 * @param {{entryId?:string,serverName?:string,file?:string,line?:number,state?:string}} server
 * @returns {{ok:boolean,reason?:string,text:string,alreadyOff:boolean,inPatch:boolean,at:string}}
 */
export function renderDisablePatch(server) {
	const empty = { ok: false, reason: "", text: "", alreadyOff: false, inPatch: false, at: "" };
	if (!server) return { ...empty, reason: "no-server" };
	const entryId = String(server.entryId || "");
	if (entryId === "") return { ...empty, reason: "no-id" };
	const file = String(server.file || "");
	const at = file === "" ? "" : file + ":" + (server.line || 0);
	const alreadyOff = String(server.state || "") === "off";
	const inPatch = /cordis\.patch\.ya?ml$/i.test(file);
	const lines = [];
	if (inPatch) {
		lines.push(
			"# 这台服务器**声明在 patch 文件里**（" + at + "），不用追加片段：",
			"# 直接在该条目的 config 同级加一行 `disabled: true`（保持 id 不变），改完重启 DSH。",
			"",
			"- id: " + entryId,
			"  disabled: true",
		);
	} else {
		lines.push(
			"# 停用 MCP 服务器 " + (server.serverName || entryId) + "（位置 " + at + "）",
			"# 追加到 profile 的 cordis.patch.yml 末尾：按 id 覆盖同一条目，只关它、不动别的。",
			"# ★ 改完必须重启 DSH —— Desktop 不 watch patch 层（settings.yaml 才是热生效）。",
			"- id: " + entryId,
			"  disabled: true",
		);
	}
	if (alreadyOff) lines.unshift("# 注意：这台**现在已经是关掉的**（disabled: " + (server.disabledRaw || "?") + "），下面这段是幂等的写法");
	return { ok: true, reason: "", text: lines.join("\n"), alreadyOff, inPatch, at };
}

/** health 一行（`catalog_health` / 交接单共用同一句）。 */
export function summarizeMcp(report) {	if (!report) return "MCP：还没读（没有组合文件或读失败）";
	const counts = report.counts || {};
	const parts = [
		"MCP：" + (counts.total || 0) + " 台服务器（官方 " + (counts.bySource?.official || 0) + " / 第三方 " + (counts.bySource?.third || 0) + " / 自己配置 " + (counts.bySource?.self || 0) + "）",
	];
	if ((counts.off || 0) > 0) parts.push("关掉 " + counts.off);
	if ((counts.conditional || 0) > 0) parts.push("条件启用 " + counts.conditional);
	if ((counts.total || 0) === 0) parts.push("**还没有配置任何服务器**（面板 MCP 分类里有空态模板）");
	if ((counts.withProblems || 0) > 0) parts.push("**" + counts.withProblems + " 台有配置问题**");
	if (!report.client?.present) parts.push("客户端包 " + MCP_CLIENT_PACKAGE + " 缺失");
	if ((report.resources?.rows || []).length > 0) parts.push("资源包 " + report.resources.rows.length + " 条");
	return parts.join("；");
}

/** 导出报告里的一节（Markdown）。 */
export function renderMcpSection(report, attribution = null) {
	if (!report) return [];
	const lines = [];
	const counts = report.counts || {};
	lines.push("## MCP 服务器（" + (counts.total || 0) + " 台）");
	lines.push("");
	lines.push("> 判据：每台服务器 = 组合文件里一条 `" + MCP_CLIENT_PACKAGE + "` 条目；工具名 `mcp__<serverName>__<tool>`。来源三分类：官方 / 第三方 / 自己配置（启发式，可手工改）。");
	lines.push("");
	lines.push("- 客户端包：" + (report.client?.present ? "在（" + (report.client.inAsar ? "官方 asar" : "profile") + "）" : "**缺失**") + "　｜　资源包：" + (report.resources?.present ? "在（" + ((report.resources.rows || []).length) + " 条声明）" : "不在"));
	lines.push("- 来源：官方 " + (counts.bySource?.official || 0) + " / 第三方 " + (counts.bySource?.third || 0) + " / 自己配置 " + (counts.bySource?.self || 0) + "；状态：启用 " + (counts.on || 0) + " / 关掉 " + (counts.off || 0) + " / 条件 " + (counts.conditional || 0));
	if ((counts.total || 0) === 0) {
		lines.push("- **本机还没有配置任何 MCP 服务器**。加一条的写法见 `catalog_mcp` 返回的 `template`（三种来源各一段），改完要重启 DSH。");
		if ((attribution?.orphans?.calls || 0) > 0) lines.push("- ⚠️ 但历史上出现过 **" + attribution.orphans.calls + "** 次 `mcp__*` 调用、指向 " + attribution.orphans.servers.length + " 个**现在没有配置**的服务器：" + attribution.orphans.servers.map((name) => "`" + name + "`").join("、"));
		return lines;
	}
	lines.push("");
	lines.push("| 服务器 | 来源 | 传输 | 目标 | 状态 | 调用 | 报错 | 工具数 | 位置 |");
	lines.push("|---|---|---|---|---|---:|---:|---:|---|");
	for (const server of report.servers) {
		const usage = attribution?.byServer?.[server.serverName] || null;
		lines.push(
			"| `" +
				server.serverName +
				"` | " +
				mcpSourceText(server.source) +
				" | " +
				(server.transport || "?") +
				" | `" +
				String(server.target).replace(/\|/g, "\\|") +
				"` | " +
				mcpStateText(server.state) +
				" | " +
				(usage ? usage.calls : 0) +
				" | " +
				(usage ? usage.errors : 0) +
				" | " +
				(usage ? usage.tools.length : 0) +
				" | `" +
				String(server.file) +
				":" +
				server.line +
				"` |",
		);
	}
	if (report.problems.length > 0) {
		lines.push("");
		for (const problem of report.problems.slice(0, 12)) lines.push("- ⚠️ " + (problem.name || problem.id) + "：" + problem.message);
	}
	if (attribution?.orphans?.calls > 0) {
		lines.push("");
		lines.push("- ⚠️ 孤儿调用：" + attribution.orphans.calls + " 次，指向没有配置的服务器 " + attribution.orphans.servers.map((name) => "`" + name + "`").join("、") + "（删过条目或改了 serverName）");
	}
	return lines;
}
