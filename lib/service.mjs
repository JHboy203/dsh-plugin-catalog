/**
 * service.mjs — 面板与工具共用的**唯一能力层**。
 *
 * 三条原则：
 *   1. 面板（HTTP 路由）与内嵌 Agent（注册的工具）调**同一套方法** ——
 *      用户要求「同一套能力同时注册为工具」，不是两份实现各写一遍。
 *   2. 重活（扫 90 天日志、跑模型、推仓）一律走后台任务，接口立刻返回；
 *      面板先显示缓存，算完自动刷新。
 *   3. 统计口径只在这里定义一次（含「含子代理 N 次」），别让 UI 自己再算一遍。
 *
 * @module dsh-plugin-catalog/service
 */

import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { asarMode, asarPath } from "./asar.mjs";
import { buildCatalog, readCatalogCache, CATALOG_VERSION } from "./catalog.mjs";
import { buildToolIndex, readCachedIndex } from "./attrib.mjs";
import { computeStats, loadAggregate, DEFAULT_WINDOW_DAYS, descendantsOf } from "./stats.mjs";
import { buildStamp, dataDir as dataDirOf, dshHome, hostVersions, profileBundles, profileComposition, profileDir, profileNodeModules, skillRoots, workspaceRoot } from "./hostinfo.js";
import { parseComposition, scanInstalledPackages } from "./loadstate.mjs";
import { describeChange, ACK_VERSION, HISTORY_VERSION, normalizeAck, normalizeHistory, pruneSnapshots, snapshotOf, summarizeChanges, timelineOf } from "./history.mjs";
import { buildUninstallPlan, renderUninstallPlan, simulateRemoval, summarizeUninstallPlan } from "./uninstall.mjs";
import { addCustomTag, applyTagOps, listTags, loadTagsStore, removeCustomTag, saveTagsStore, setEntryTags, tagPrompt, tagsOfEntry } from "./tags.mjs";
import { classifyEntries, generateZhIntros, translateReadme, readService } from "./ai.mjs";
import { applyUpload, makePublic, planUpload, repoNameFor, selectCandidates, skillsRepoName } from "./publish.mjs";
import { isDue, loadWeekly, runGapAnalysis, runSecurityAudit, saveWeekly, summarizeReport } from "./review.mjs";
import { loadSettings, saveSettings, skillsStageDirOf, DEFAULTS } from "./settings.mjs";
import { copySkillToStaging, isStaleVerdict, listSkillBackups, restoreSkillBackup, skillStamp, skillStat, skillVerdict } from "./staging.mjs";
import { drainWarnings, readJson, writeJson } from "./store.mjs";

const OVERRIDES_VERSION = 1;

/* ───────── R18：**运行中**的版本 ─────────
   ★ 本机反复踩的坑：`buildStamp()` 读的是**磁盘**（package.json + 最新文件 mtime），
     所以面板/health 显示 0.17.0 时，宿主里跑的模块可能还是 0.16.0 —— 新工具、新路由根本不存在。
     R16/R17 两轮都因此误判过一次"已经生效了"。这里把模块**加载时**的版本固定下来，
     与磁盘上的版本对比，就能直接回答「我改了代码，宿主里跑的是新的吗」。
   ★ 只有升级之后才会准（旧代码不认识这个字段），但从此每次热改都能看见。 */
const LOADED_VERSION = (() => {
	try {
		const here = dirname(fileURLToPath(import.meta.url));
		return JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).version || "";
	} catch {
		return "";
	}
})();
const LOADED_AT = Date.now();

/** 磁盘版本 vs 运行中版本：不一致 = 还没重载（不是"坏"，是"这次改动还没生效"）。 */
function isStaleBuild(build, loaded) {
	const disk = String(build?.version || "");
	return Boolean(disk) && Boolean(loaded) && disk !== String(loaded);
}

/* ───────── 目录体积（懒算） ─────────
   ★ 只在**打开某一个条目的详情**时算一个目录，绝不在构建目录时扫 71 个包 ——
     逐个 du 会把构建从秒级拖到十秒级（这是面板打开速度的红线）。
   ★ junction / 符号链接一律不跟随：跟随会顺着 link 走到 profile 的另一处，甚至成环。 */
const SIZE_CACHE = new Map(); /* dir → { at, size } */
const SIZE_TTL_MS = 5 * 60 * 1000;
const SIZE_MAX_FILES = 20000;
const SIZE_BUDGET_MS = 1500;

/**
 * 递归统计一个目录的字节数与文件数（跳过链接、限时限量）。
 * @param {string} dir
 * @returns {Promise<{bytes:number, files:number, truncated:boolean}>}
 */
export async function dirSize(dir) {
	const cached = SIZE_CACHE.get(dir);
	if (cached && Date.now() - cached.at < SIZE_TTL_MS) return cached.size;
	const { opendir, lstat } = await import("node:fs/promises");
	const started = Date.now();
	let bytes = 0;
	let files = 0;
	let truncated = false;
	const queue = [dir];
	while (queue.length > 0) {
		if (truncated) break;
		const current = queue.shift();
		let handle = null;
		try {
			handle = await opendir(current);
		} catch (error) {
			continue; /* 权限不足 / 刚被删掉的子目录：跳过，不让整个请求失败 */
		}
		for await (const entry of handle) {
			if (files >= SIZE_MAX_FILES || Date.now() - started > SIZE_BUDGET_MS) {
				truncated = true;
				break;
			}
			/* isDirectory() 对 junction 返回 false（Windows reparse point 走 isSymbolicLink），
			   所以我们只推入真目录，天然不跟随链接 */
			if (entry.isDirectory()) {
				queue.push(join(current, entry.name));
				continue;
			}
			if (!entry.isFile()) continue;
			try {
				const stat = await lstat(join(current, entry.name));
				bytes += stat.size;
				files += 1;
			} catch (error) {
				/* 单个文件 stat 失败就当它不存在 */
			}
		}
	}
	const size = { bytes, files, truncated };
	SIZE_CACHE.set(dir, { at: Date.now(), size });
	return size;
}

/* ───────── 体积缓存：让体积进列表（R8） ─────────
   dirSize 是**懒算**的（进程内 5 分钟缓存，只服务浮窗与批次条）。但「这 137 条各占多少盘、
   我筛出来的这一批一共能省多少」不可能靠逐个点开浮窗问 —— 所以在**后台任务**里量一次全量，
   落到 cache/sizes.json，state 直接带出来：卡片显示、按体积排序、合计、导出都用同一份。
   ★ 仍然不在目录构建里算：71 个包逐个递归会把面板打开从秒级拖到十秒级（坑 19）。
   ★ 官方包在 asar 里，realDir 是个**虚拟成员路径**，opendir 必然失败 —— 那种条目要跳过并
     如实说「在 asar 里」，否则面板会显示「0 B」，看起来像"它不占空间"（R8 抓到的真 bug）。 */
const SIZES_VERSION = 1;
const SIZES_CONCURRENCY = 4;

/** 人类可读体积（与客户端 fmtBytes 同口径：1024 进制、MB 起一位小数）。 */
export function formatBytes(bytes) {
	const value = Number(bytes) || 0;
	if (value >= 1024 * 1024 * 1024) return (value / (1024 * 1024 * 1024)).toFixed(1) + " GB";
	if (value >= 1024 * 1024) return (value / (1024 * 1024)).toFixed(1) + " MB";
	if (value >= 1024) return (value / 1024).toFixed(0) + " KB";
	return value + " B";
}

/* ───────── 副本漂移（profile 装的是副本，工作区还有一份源码） ─────────
   ★ 本机反复踩的坑：改的是工作区那份，加载的是 profile 副本 —— 改半天不生效；
     反过来整理依赖树时副本被清掉，工作区那份又成了唯一真相（dsh-ofm-ops 丢源码就是这么发生的）。
   指纹只比 4 个关键文件的 size + mtime，不读内容：够判"是不是同一份"，71 个包也很快。 */
const DRIFT_FILES = ["package.json", "index.js", "client.js", "cordis.patch.yml"];
const DRIFT_MTIME_TOLERANCE = 60 * 1000;

export async function fingerprintDir(dir, files = DRIFT_FILES) {
	const { stat } = await import("node:fs/promises");
	const out = {};
	for (const name of files) {
		try {
			const info = await stat(join(dir, name));
			out[name] = { size: info.size, mtime: Math.round(info.mtimeMs) };
		} catch (error) {
			/* 没有这个文件就不记（很多插件没有 client.js） */
		}
	}
	return out;
}

/**
 * 比较「加载的那份」与「工作区源码」。
 * 判据顺序：文件只在一边 → 内容长度不同（size）→ 更新的那份（各侧 mtime 的 max，容差 60s）→ 相同。
 * @returns {{verdict:string, differs:string[], newer:string, loadedFiles:number, workspaceFiles:number}}
 */
export function compareFingerprints(loaded, workspace, files = DRIFT_FILES) {
	const differs = [];
	let newer = "same";
	let newestLoaded = 0;
	let newestWorkspace = 0;
	for (const name of files) {
		const left = loaded[name];
		const right = workspace[name];
		if (!left && !right) continue;
		if (!left) {
			differs.push(name + "（工作区有、装的那份没有）");
			continue;
		}
		if (!right) {
			differs.push(name + "（装的那份有、工作区没有）");
			continue;
		}
		if (left.size !== right.size) {
			differs.push(name);
			continue;
		}
		newestLoaded = Math.max(newestLoaded, left.mtime);
		newestWorkspace = Math.max(newestWorkspace, right.mtime);
	}
	if (differs.length > 0) return { verdict: "differs", differs, newer, loadedFiles: Object.keys(loaded).length, workspaceFiles: Object.keys(workspace).length };
	if (newestWorkspace - newestLoaded > DRIFT_MTIME_TOLERANCE) newer = "workspace";
	else if (newestLoaded - newestWorkspace > DRIFT_MTIME_TOLERANCE) newer = "loaded";
	return { verdict: newer === "same" ? "same" : "newer-" + newer, differs, newer, loadedFiles: Object.keys(loaded).length, workspaceFiles: Object.keys(workspace).length };
}


export class CatalogService {
	/**
	 * @param {object} deps
	 * @param {object} deps.ctx 宿主上下文
	 * @param {() => Array<{name:string,description?:string}>} deps.toolSchemas 实时工具 schema
	 */
	constructor(deps) {
		this.ctx = deps.ctx;
		this.toolSchemas = deps.toolSchemas || (() => []);
		this.settings = null;
		this.tags = null;
		this.overrides = { version: OVERRIDES_VERSION, sources: {}, tools: {} };
		this.catalog = null;
		this.aggregate = null;
		this.statsMeta = null;
		this.attrib = { index: {}, stats: {} };
		this.intros = null;
		this.job = null;
		/* 上一次发版体检的结论（R11）。**单独存一份**，不靠 job 槽位：
		   job 只有一格，任何后续后台任务（统计自愈、量体积）都会把它顶掉，
		   于是"自检结论"在面板上活不过 20 秒 —— 这正是本轮真机上抓到的现象。 */
		this.lastPreflight = null;
		/* R14 的处置清单：同样单独存一份（job 一格存不住结论，见上）。 */
		this.lastUninstall = null;
		this.lastUninstallSavedTo = "";
		this.lastPlan = null;
		this.lastReports = { gap: null, security: null };
		this.clientReport = null;
		this.weekly = null;
		this.startedAt = Date.now();
		/* 副本漂移缓存：{ at, map }。重建目录 / 工作区变化时清掉。 */
		this.driftCache = null;
		/* R17：目录历史 {version, snapshots}（**指纹变了才追加**）+ 最近一次变化的摘要。
		   面板、报告、health 都读 this.changes，别各自去 diff 一遍。 */
		this.historyCache = null;
		this.changes = null;
		/* R19：「已看过」基线（history-ack.json）。null = 还没标记过；
		   ackLoaded 单独记，否则"没标记过"与"还没读"分不开（都会是 null）。 */
		this.ackCache = null;
		this.ackLoaded = false;
		/* 体积快照：{ version, at, count, totalBytes, byId }。后台任务算，state 直接带出来。 */
		this.sizes = null;
	}

	/* ───────────── 基础 ───────────── */

	get dir() {
		return dataDirOf(this.settings?.workspace);
	}

	get workspace() {
		return workspaceRoot(this.settings?.workspace);
	}

	overridesFile() {
		return join(this.dir, "overrides.json");
	}

	introsFile() {
		return join(this.dir, "intros.json");
	}

	/** 全量体积快照（后台任务写、state 读） */
	sizesFile() {
		return join(this.dir, "cache", "sizes.json");
	}

	async init() {
		this.settings = await loadSettings(this.dir);
		this.tags = await loadTagsStore(this.dir);
		this.overrides = (await readJson(this.overridesFile(), null)) || this.overrides;
		this.intros = (await readJson(this.introsFile(), null)) || { version: 1, byEntry: {}, model: "", generatedAt: 0 };
		this.weekly = await loadWeekly(this.dir);

		/* ★ 启动路径只读缓存，**绝不重建**。
		   重建要跑 71 个包的 realpath + stat + git（实测 15 秒）—— 放在 apply() 里
		   等于把 DSH 的启动拖慢 15 秒。过期也没关系：界面先显示旧数据，后台任务刷新。 */
		const cachedStats = await loadAggregate(this.dir, this.settings.windowDays);
		this.aggregate = cachedStats.aggregate;
		this.statsMeta = cachedStats.meta;
		this.statsStale = cachedStats.stale;
		this.statsNeedsRefresh = !this.aggregate;

		const cachedCatalog = await readCatalogCache(this.dir);
		if (cachedCatalog.snapshot && cachedCatalog.version === CATALOG_VERSION) {
			this.catalog = cachedCatalog.snapshot;
			this.catalogAgeMs = cachedCatalog.ageMs;
			/* 过期只做标记，不在这里重建 */
			this.catalogStale = cachedCatalog.ageMs > (Number(this.settings.catalogTtlSeconds) || 300) * 1000;
		} else {
			this.catalog = null;
			this.catalogAgeMs = Infinity;
			this.catalogStale = true;
		}

		/* 归属索引同样只读缓存：不读它的话，重启后的头几分钟
		   面板会把所有工具都显示成「宿主核心」（因为 index 是空的）。 */
		const cachedAttrib = await readCachedIndex(this.dir);
		if (cachedAttrib) {
			this.attrib = { index: cachedAttrib.index, stats: cachedAttrib.stats };
			this.attribNeedsRebuild = false;
		} else {
			this.attribNeedsRebuild = true;
		}
		/* 体积快照同样只读缓存：没有它列表就只显示"—"，后台量完再补上（不阻塞启动）。 */
		const cachedSizes = await readJson(this.sizesFile(), null);
		this.sizes = cachedSizes && cachedSizes.version === SIZES_VERSION && cachedSizes.byId ? cachedSizes : null;
		/* R17：启动时记一条快照（指纹没变就是空操作）。放这里而不是 rebuildIfCold ——
		   启动路径**只读缓存、绝不重建**（见上），所以"第一次快照"必须在这里落地。 */
		if (this.catalog) await this.recordSnapshot().catch(() => {});
		return this;
	}

	async saveOverrides() {
		await writeJson(this.overridesFile(), { ...this.overrides, savedAt: Date.now() });
	}

	/* ───────────── 后台任务 ───────────── */

	get busy() {
		return this.job !== null;
	}

	/**
	 * 起一个后台任务（同一时刻只允许一个，避免两个全量扫描互相踩）。
	 * @param {string} kind
	 * @param {(progress:(p:object)=>void) => Promise<object>} runner
	 */
	startJob(kind, runner) {
		if (this.job) return { ok: false, error: "已有任务在跑：" + this.job.kind, job: this.jobSnapshot() };
		const job = { kind, startedAt: Date.now(), progress: { phase: "start", done: 0, total: 1 }, error: "", result: null, finishedAt: 0 };
		this.job = job;
		Promise.resolve()
			.then(() => runner((patch) => Object.assign(job.progress, patch)))
			.then((result) => {
				job.result = result;
				job.finishedAt = Date.now();
			})
			.catch((error) => {
				job.error = String(error?.message ?? error);
				job.finishedAt = Date.now();
			})
			.finally(() => {
				/* 留最后一份快照给面板读，随后释放 */
				this.lastJob = { ...job };
				this.job = null;
			});
		return { ok: true, job: this.jobSnapshot() };
	}

	jobSnapshot() {
		const job = this.job || this.lastJob || null;
		if (!job) return { running: false, kind: "", progress: { phase: "idle", done: 0, total: 0 } };
		return {
			running: this.job !== null,
			kind: job.kind,
			startedAt: job.startedAt,
			finishedAt: job.finishedAt || 0,
			progress: job.progress,
			error: job.error || "",
			result: job.result || null,
		};
	}

	/**
	 * 发版体检（R10）：跑 `dev/ship.mjs`，把结论原样带回面板。
	 *
	 * ★ 为什么是**子进程**而不是 import 进来：三条自检脚本各自会 `process.exit()`、改环境变量、
	 *   在失败时直接退出 —— import 进来跑等于把宿主带死（audit 一旦红，整个 DSH 就没了）。
	 * ★ 解释器要用宿主自己的 exe + `ELECTRON_RUN_AS_NODE=1`：只有这样子进程才有
	 *   `process.resourcesPath`，hosttest 的 asar 断言才跑得起来（否则那条是 SKIP）。
	 * ★ 进度走 stderr（stdout 留给最后那一行 JSON），所以面板能看到"正在跑第 2/3 项"。
	 */
	async runPreflight({ onProgress } = {}) {
		const report = typeof onProgress === "function" ? onProgress : () => {};
		const root = join(dirname(fileURLToPath(import.meta.url)), "..");
		const script = join(root, "dev", "ship.mjs");
		const env = { ...process.env };
		if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";
		delete env.DSH_CATALOG_KEEP;
		const startedAt = Date.now();
		/* ★ total 不写死：ship.mjs 自己会发 `ship:check:total:<n>`（R11 加了第 4 项「副本同步」）。
		   写死在两处就会漂成"进度条 3/3 跑完但第 4 项还在跑"。 */
		report({ phase: "preflight", done: 0, total: 0, current: "启动" });
		return await new Promise((resolvePromise) => {
			let child;
			try {
				child = spawn(process.execPath, [script, "--json"], { cwd: root, env, windowsHide: true });
			} catch (error) {
				resolvePromise({ ok: false, error: "起不来子进程：" + String(error?.message ?? error) });
				return;
			}
			let stdout = "";
			let stderr = "";
			let done = 0;
			let total = 0;
			const finish = (payload) => {
				const finalPayload = Object.assign({ durationMs: Date.now() - startedAt }, payload);
				/* 留一份到 `lastPreflight`：面板的「体检结论卡」要活过后续的后台任务 */
				this.lastPreflight = finalPayload;
				resolvePromise(finalPayload);
			};
			child.stdout.on("data", (chunk) => {
				stdout += String(chunk);
			});
			child.stderr.on("data", (chunk) => {
				stderr += String(chunk);
				/* ship.mjs 在 json 模式下往 stderr 打：
				   `ship:check:total:<n>` / `ship:check:start:<id>` / `ship:check:done:<id>:<ok|fail>` */
				for (const line of String(chunk).split(/\r?\n/)) {
					if (line.startsWith("ship:check:total:")) {
						const parsed = Number(line.slice("ship:check:total:".length));
						if (Number.isFinite(parsed) && parsed > 0) total = parsed;
						report({ phase: "preflight", done, total: total || 0, current: "启动" });
					} else if (line.startsWith("ship:check:start:")) {
						report({ phase: "preflight", done, total: total || 0, current: line.slice("ship:check:start:".length) });
					} else if (line.startsWith("ship:check:done:")) {
						done = total > 0 ? Math.min(total, done + 1) : done + 1;
						report({ phase: "preflight", done, total: total || done, current: line.slice("ship:check:done:".length) });
					}
				}
			});
			child.on("error", (error) => finish({ ok: false, error: "子进程失败：" + String(error?.message ?? error) }));
			child.on("close", () => {
				const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
				const jsonLine = [...lines].reverse().find((line) => line.startsWith("{") && line.endsWith("}"));
				if (!jsonLine) {
					finish({ ok: false, error: "体检脚本没有给出 JSON 结论", stderr: stderr.split(/\r?\n/).filter(Boolean).slice(-6) });
					return;
				}
				try {
					finish(JSON.parse(jsonLine));
				} catch (error) {
					finish({ ok: false, error: "体检结论不是合法 JSON：" + String(error?.message ?? error) });
				}
			});
		});
	}

	/** 重算统计（可被面板的「刷新」按钮或工具触发）。 */
	async refreshStats({ full = false } = {}) {
		const result = await computeStats({
			sessionsRoot: join(dshHome(), "sessions"),
			dataDir: this.dir,
			windowDays: this.settings.windowDays,
			signal: { aborted: false },
			onProgress: (progress) => this.job?.progress && Object.assign(this.job.progress, progress),
		});
		if (result.ok) {
			this.aggregate = result.aggregate;
			this.statsMeta = result.meta;
			this.statsStale = false;
			await this.rebuildAttribution();
		}
		return { ok: result.ok, meta: result.meta, error: result.error || "" };
	}

	async rebuildCatalog({ force = true } = {}) {
		this.catalog = await buildCatalog({ dataDir: this.dir, settings: this.settings, force });
		/* 目录重建 = 安装形态可能变了，漂移结果必须作废 */
		this.driftCache = null;
		await this.rebuildAttribution();
		/* R17：目录刚重建，正好把这一版记进历史（指纹没变就不会追加） */
		await this.recordSnapshot().catch(() => {});
		return { ok: true, counts: this.catalog?.counts || {} };
	}

	/* ───────────── R17：变化追踪（自上次快照以来变了什么） ───────────── */

	historyFile() {
		return join(this.dir, "history.json");
	}

	/** 读历史（内存缓存一份；坏文件按空历史处理）。 */
	async loadHistory() {
		if (this.historyCache) return this.historyCache;
		const raw = await readJson(this.historyFile(), null).catch(() => null);
		this.historyCache = normalizeHistory(raw);
		return this.historyCache;
	}

	/**
	 * 记一条快照。**指纹没变就不追加** —— 否则每次「重新扫描」都写一条，
	 * 基线时间被不断刷新，「自 11:27 以来」永远只剩几分钟，等于看不到真实的变化窗口。
	 */
	async recordSnapshot({ at = Date.now() } = {}) {
		if (!this.catalog) return { recorded: false, changes: this.changes };
		const history = await this.loadHistory();
		const snapshot = snapshotOf(this.catalog, this.overrides, at);
		const last = history.snapshots[history.snapshots.length - 1] || null;
		if (last && last.fingerprint === snapshot.fingerprint) {
			/* 没变：基线保持不动，摘要也保持不动（除非进程刚起、还没有摘要） */
			if (!this.changes) this.changes = summarizeChanges(history.snapshots[history.snapshots.length - 2] || null, last);
			return { recorded: false, changes: this.changes };
		}
		history.snapshots = pruneSnapshots([...history.snapshots, snapshot]);
		await writeJson(this.historyFile(), { version: HISTORY_VERSION, snapshots: history.snapshots });
		const list = history.snapshots;
		this.changes = summarizeChanges(list[list.length - 2] || null, list[list.length - 1]);
		return { recorded: true, changes: this.changes };
	}

	/** 面板 /state 用：最近一次变化的紧凑视图（每类最多 20 条）。 */
	changesSummary() {
		return this.changes;
	}

	/**
	 * R21：回看更早的窗口（相邻快照两两相减，新的在前）。
	 *
	 * ★ 只读内存里的 historyCache：`/state` 每 20 秒轮询一次，不能每轮去读盘；
	 *   第一次读盘后这个对象就一直用（标记已看过不会改 history.json）。
	 * ★ `total` 是**快照条数**（含基线），不是窗口数；窗口数 = total - 1（可能更少，
	 *   指纹相同 / 0 处变化的窗口会被跳过）。
	 */
	async historyTimeline() {
		const history = await this.loadHistory();
		return { items: timelineOf(history.snapshots), total: history.snapshots.length };
	}

	/* ───────────── R19：「已看过」基线（确认之后变化窗口清零） ───────────── */

	ackFile() {
		return join(this.dir, "history-ack.json");
	}

	/** 读「已看过」基线（懒加载；坏文件 / 没文件都当"没标记过"）。 */
	async loadAck() {
		if (this.ackLoaded) return this.ackCache;
		const raw = await readJson(this.ackFile(), null).catch(() => null);
		this.ackCache = normalizeAck(raw);
		this.ackLoaded = true;
		return this.ackCache;
	}

	/** 某一刻的目录快照 —— 基线必须是**快照**，只存时间戳说明不了"我看到的是哪一版"。 */
	ackSnapshotAt(at) {
		return this.catalog ? snapshotOf(this.catalog, this.overrides, at) : null;
	}

	/**
	 * 面板「标记已看过」：把当前目录冻结成基线。
	 * ★ 只写数据目录里的 `history-ack.json`，**不改写 history.json** ——
	 *   确认是"我看过了"，不是"历史变了"；混在一起会让指纹没变的快照又追加一条。
	 */
	async markAcked({ at = Date.now() } = {}) {
		const snapshot = this.ackSnapshotAt(at);
		if (!snapshot) return { ok: false, error: "目录还没建好：先刷新一次面板再标记" };
		const ack = { version: ACK_VERSION, at, snapshot };
		await writeJson(this.ackFile(), ack);
		this.ackCache = normalizeAck(ack);
		this.ackLoaded = true;
		const sinceAck = await this.sinceAckSummary();
		return { ok: true, ackAt: at, entries: snapshot.count, sinceAck };
	}

	/**
	 * 「自上次确认以来」变了什么。没标记过 → null ——
	 * 面板/报告要如实说"还没标记过"，不能拿"自上次快照以来"冒充确认窗口。
	 */
	async sinceAckSummary() {
		const ack = await this.loadAck();
		const current = this.ackSnapshotAt(Date.now());
		if (!ack || !current) return null;
		const summary = summarizeChanges(ack.snapshot, current, 20);
		return { ...summary, acked: true, ackAt: ack.at, ackEntries: Number(ack.snapshot.count) || 0, file: this.ackFile() };
	}


	async rebuildAttribution() {
		const tools = this.toolSchemas();
		const packages = [];
		for (const plugin of this.catalog?.plugins ?? []) {
			if (plugin.inAsar) continue;
			packages.push({ pkg: plugin.name, root: plugin.realDir });
		}
		/* 官方工具包在 asar 里：不读它们，65% 的调用量会落在"未知" */
		try {
			const { readOfficialToolPackages } = await import("./catalog.mjs");
			for (const pack of await readOfficialToolPackages()) packages.push(pack);
		} catch {
			/* 读不到 asar 就退化为只有 profile 包 */
		}
		this.attrib = await buildToolIndex({ dataDir: this.dir, tools, packages, overrides: this.overrides.tools || {}, force: false });
		return this.attrib;
	}

	/* ───────────── 视图组装 ───────────── */

	/** 工具 → 归属包（含官方/宿主判定）。 */
	toolOwner(toolName) {
		const entry = this.attrib.index?.[toolName];
		return entry && entry.owner ? entry.owner : "";
	}

	/**
	 * 一个条目在统计上的汇总。
	 *
	 * 口径（写在这里一次，UI 直接显示）：
	 *   · calls：该插件的**全部工具**调用次数之和（含子代理会话里发生的）；
	 *   · subagentCalls：其中发生在**子代理会话**里的次数 —— 用户要的「含子代理 N 次」；
	 *   · sessions：去重后的会话数（同一会话多次调用算 1）。
	 */
	entryUsage(entry) {
		const aggregate = this.aggregate;
		const empty = { calls: 0, errors: 0, lastUsed: 0, sessions: 0, subagentCalls: 0, rootCalls: 0, tools: [] };
		if (!aggregate) return empty;

		if (entry.kind === "skill") {
			/* Skill 只有「次数 + 最近一次」—— 机制限制，不假装精确 */
			const skill = aggregate.skills.get(entry.skillName || entry.name);
			if (!skill) return { ...empty, limited: true };
			return { calls: skill.calls, errors: 0, lastUsed: skill.lastUsed, sessions: 0, subagentCalls: 0, rootCalls: skill.calls, tools: [], limited: true };
		}

		const tools = [];
		let calls = 0;
		let errors = 0;
		let lastUsed = 0;
		let subagentCalls = 0;
		const sessionIds = new Set();

		for (const [toolName, tool] of aggregate.tools) {
			if (this.toolOwner(toolName) !== entry.name) continue;
			tools.push({
				name: toolName,
				calls: tool.calls,
				errors: tool.errors,
				incomplete: tool.incomplete,
				avgMs: tool.msCount > 0 ? Math.round(tool.ms / tool.msCount) : 0,
				lastUsed: tool.lastUsed,
				sessions: tool.sessions,
			});
			calls += tool.calls;
			errors += tool.errors;
			if (tool.lastUsed > lastUsed) lastUsed = tool.lastUsed;
			for (const sessionId of tool.sessionCounts.keys()) {
				sessionIds.add(sessionId);
				const session = aggregate.sessions.get(sessionId);
				if (session && (session.parent || session.depth > 0)) subagentCalls += tool.sessionCounts.get(sessionId) || 0;
			}
		}

		tools.sort((a, b) => b.calls - a.calls);
		return { calls, errors, lastUsed, sessions: sessionIds.size, subagentCalls, rootCalls: calls - subagentCalls, tools };
	}

	/** 宿主核心工具（无法归属到任何 profile 插件/官方工具包的那些）。 */
	hostCoreUsage() {
		const aggregate = this.aggregate;
		if (!aggregate) return { id: "host-core", name: "宿主核心工具", calls: 0, tools: [] };
		const knownOfficial = new Set((this.catalog?.plugins ?? []).map((plugin) => plugin.name));
		const tools = [];
		let calls = 0;
		for (const [name, tool] of aggregate.tools) {
			const owner = this.toolOwner(name);
			const entry = this.attrib.index?.[name];
			const isProfilePlugin = (this.catalog?.plugins ?? []).some((plugin) => plugin.name === owner && !plugin.inAsar);
			const isOfficialCard = knownOfficial.has(owner) && (this.catalog.plugins || []).find((plugin) => plugin.name === owner)?.inAsar;
			if (isProfilePlugin || isOfficialCard) continue;
			tools.push({
				name,
				calls: tool.calls,
				errors: tool.errors,
				avgMs: tool.msCount > 0 ? Math.round(tool.ms / tool.msCount) : 0,
				lastUsed: tool.lastUsed,
				sessions: tool.sessions,
				owner: owner || "",
				how: entry?.how || "unknown",
			});
			calls += tool.calls;
		}
		tools.sort((a, b) => b.calls - a.calls);
		return { id: "host-core", kind: "host", name: "宿主核心工具", calls, tools, sessions: 0, subagentCalls: 0 };
	}

	/** 面板列表项（卡片）。 */
	listEntries() {
		const aggregate = this.aggregate;
		const plugins = (this.catalog?.plugins ?? []).map((plugin) => {
			const source = this.overrides.sources?.[plugin.id] || plugin.source;
			const usage = this.entryUsage({ ...plugin, source });
			return {
				id: plugin.id,
				kind: "plugin",
				name: plugin.name,
				title: plugin.title,
				version: plugin.version,
				descriptionEn: plugin.description,
				descriptionZh: this.intros?.byEntry?.[plugin.id]?.zh || "",
				source,
				sourceWhy: plugin.sourceWhy,
				askUser: Boolean(plugin.askUser) && !this.overrides.sources?.[plugin.id],
				enabled: plugin.enabled,
				/* R12：会不会被加载。客户端旧版没有这两个字段也照常渲染（`loadState` 缺失时按"未知"处理），
				   所以宿主/客户端可以各自升级，不会一半白屏。 */
				loadState: plugin.loadState || "",
				loadVia: plugin.loadVia || "",
				/* R14：别名目录（`ghbackup` 里装的是 `dsh-github-backup`）。条目名是**目录名**，
				   而 bundles / 依赖声明用的是包名 —— 两者不一致时界面必须说清，否则
				   同一个项目会以两个名字出现在列表里，一个"已启用"一个"不会被加载"。 */
				aliasOf: plugin.aliasOf || "",
				packageName: plugin.packageName || plugin.name,
				inAsar: Boolean(plugin.inAsar),
				repoUrl: plugin.repoUrl,
				createdAt: plugin.createdAt,
				author: plugin.author,
				license: plugin.license,
				keywords: plugin.keywords,
				calls: usage.calls,
				errors: usage.errors,
				lastUsed: usage.lastUsed,
				sessions: usage.sessions,
				subagentCalls: usage.subagentCalls,
				toolCount: usage.tools.length,
				/* 工具名必须带出来：面板搜索要能回答「这个工具是谁给的」，
				   卡片也要标出命中的是哪个工具。127 条 × 平均 2~3 个名字，代价可忽略。 */
				toolNames: usage.tools.map((tool) => tool.name),
				/* 位置信息：装上了却不工作时，第一件事是看它到底在哪个目录、是不是 junction。 */
				realDir: plugin.realDir || "",
				isLink: Boolean(plugin.isLink),
				dependency: plugin.dependency || "",
				/* R9：依赖关系。「被谁依赖」比"是不是直接依赖"更能回答"能不能删"：
				   @dsh-ops/bash-win32-x64 既写在 profile 的 dependencies 里，**又**被 dsh-ops 依赖 —— 删它必坏。 */
				dependents: Array.isArray(plugin.dependents) ? plugin.dependents : [],
				dependentCount: Number(plugin.dependentCount) || 0,
				dependsOn: Array.isArray(plugin.dependsOn) ? plugin.dependsOn : [],
				dependsOnCount: Number(plugin.dependsOnCount) || 0,
				/* 候选而非结论：profile 里所有 package.json 都没提到它。界面文案必须带"需确认"。 */
				orphanHint: !plugin.dependency && !plugin.inAsar && (Number(plugin.dependentCount) || 0) === 0,
				tags: tagsOfEntry(this.tags, { id: plugin.id, source }),
				git: plugin.git,
			};
		});

		const skills = (this.catalog?.skills ?? [])
			.filter((skill) => !(this.settings.hideBackupSkills && skill.backup))
			.map((skill) => {
				const source = this.overrides.sources?.[skill.id] || skill.source;
				const usage = this.entryUsage({ ...skill, source, kind: "skill" });
				return {
					id: skill.id,
					kind: "skill",
					name: skill.name,
					title: skill.name,
					descriptionEn: skill.description,
					descriptionZh: this.intros?.byEntry?.[skill.id]?.zh || "",
					whenToUse: skill.whenToUse,
					hasDescription: Boolean(skill.hasDescription),
					source,
					sourceWhy: skill.sourceWhy,
					askUser: Boolean(skill.askUser) && !this.overrides.sources?.[skill.id],
					repoUrl: skill.repoUrl,
					createdAt: skill.createdAt,
					hostPlugin: skill.hostPlugin,
					backup: skill.backup,
					calls: usage.calls,
					errors: 0,
					lastUsed: usage.lastUsed,
					sessions: 0,
					subagentCalls: 0,
					toolCount: 0,
					/* Skill 也有自己的目录（catalog 里的 dir，R6 加的）：浮窗要显示位置，也要能算体积。
					   没有 dir 的是旧快照 —— 退回空串，界面会如实说"没有独立目录"而不是瞎猜。 */
					realDir: skill.dir || "",
					isLink: false,
					inAsar: false,
					/* Skill 之间没有 npm 依赖，也不存在"删掉别人就坏"的关系 */
					dependents: [],
					dependentCount: 0,
					dependsOn: [],
					dependsOnCount: 0,
					orphanHint: false,
					tags: tagsOfEntry(this.tags, { id: skill.id, source }),
					statsLimited: true,
				};
			});

		const hostCore = this.hostCoreUsage();
		const items = [...plugins, ...skills];
		return { items, hostCore, totals: this.totalsOf(plugins, skills) };
	}

	totalsOf(plugins, skills) {
		return {
			plugins: plugins.length,
			skills: skills.length,
			calls: plugins.reduce((sum, item) => sum + item.calls, 0),
			errors: plugins.reduce((sum, item) => sum + item.errors, 0),
			subagentCalls: plugins.reduce((sum, item) => sum + item.subagentCalls, 0),
			hostCoreCalls: this.hostCoreUsage().calls,
			bySource: {
				official: [...plugins, ...skills].filter((item) => item.source === "official").length,
				self: [...plugins, ...skills].filter((item) => item.source === "self").length,
				third: [...plugins, ...skills].filter((item) => item.source === "third").length,
				hybrid: [...plugins, ...skills].filter((item) => item.source === "hybrid").length,
				pending: [...plugins, ...skills].filter((item) => item.source === "pending").length,
			},
			askUser: [...plugins, ...skills].filter((item) => item.askUser).length,
		};
	}

	/**
	 * 一个条目的详情（浮窗）。会话列表分页。
	 * @param {string} id
	 * @param {{page?:number, pageSize?:number}} [options]
	 */
	entryDetail(id, options = {}) {
		const { items, hostCore } = this.listEntries();
		if (id === "host-core") return this.hostCoreDetail(options, hostCore);
		const item = items.find((entry) => entry.id === id);
		if (!item) return { ok: false, error: "找不到条目：" + id };
		const aggregate = this.aggregate;
		const pageSize = Math.min(500, Math.max(5, Number(options.pageSize) || this.settings.sessionsPageSize));
		const page = Math.max(1, Number(options.page) || 1);

		const raw = aggregate ? (this.catalog.plugins.find((plugin) => plugin.id === id) ?? this.catalog.skills.find((skill) => skill.id === id)) : null;
		const usage = item.kind === "plugin" ? this.entryUsage({ ...raw, source: item.source }) : null;

		/* 会话列表：按「该工具的调用次数」聚合，标注是不是子代理 */
		let sessions = [];
		let totalSessions = 0;
		if (item.kind === "plugin" && aggregate) {
			const counts = new Map();
			for (const tool of usage.tools) {
				const full = aggregate.tools.get(tool.name);
				if (!full) continue;
				for (const [sessionId, count] of full.sessionCounts) counts.set(sessionId, (counts.get(sessionId) || 0) + count);
			}
			const rows = [...counts.entries()].map(([sessionId, count]) => {
				const session = aggregate.sessions.get(sessionId) || { id: sessionId, title: sessionId.slice(0, 8) };
				const isSubagent = Boolean(session.parent) || session.depth > 0;
				return {
					id: sessionId,
					title: session.title,
					titleSource: session.titleSource,
					workspace: session.workspace,
					calls: count,
					lastAt: session.lastAt,
					isSubagent,
					parentId: session.parent || "",
					parentTitle: session.parent ? aggregate.sessions.get(session.parent)?.title || session.parent.slice(0, 8) : "",
					depth: session.depth || 0,
				};
			});
			rows.sort((a, b) => b.calls - a.calls);
			totalSessions = rows.length;
			sessions = rows.slice((page - 1) * pageSize, page * pageSize);
		}

		const descendants = item.kind === "plugin" && aggregate && aggregate.sessions.has(id) ? descendantsOf(aggregate.sessions, id) : [];

		return {
			ok: true,
			item,
			tools: usage?.tools || [],
			sessions: {
				items: sessions,
				page,
				pageSize,
				total: totalSessions,
				pages: Math.max(1, Math.ceil(totalSessions / pageSize)),
				pageSizes: this.settings.pageSizes,
			},
			descendants: descendants.length,
			statsMeta: this.statsMeta,
			statsLimited: item.kind === "skill",
			readme: null,
		};
	}

	/**
	 * 单个条目的磁盘体积（浮窗打开时问一次）。
	 * 三种如实回答：
	 *   · 有落盘目录（插件在 profile 里 / Skill 有独立目录）→ 真去递归量；
	 *   · 官方包在 asar 里 → **不能量**，也不能报 0 B（那看起来像"它不占空间"）；
	 *   · 没有目录 → 说清为什么没有。
	 */
	async entrySize(id) {
		const { items } = this.listEntries();
		const item = items.find((entry) => entry.id === id);
		if (!item) return { ok: false, error: "找不到条目：" + id };
		if (item.inAsar) return { ok: true, size: null, reason: "在官方 asar 里，没有独立目录（体积记在 DSH 安装包内）" };
		if (!item.realDir) return { ok: true, size: null, reason: item.kind === "skill" ? "Skill 没有独立目录" : "没有落盘目录" };
		try {
			const size = await dirSize(item.realDir);
			return { ok: true, dir: item.realDir, size, cached: Boolean(this.sizes?.byId?.[id]) };
		} catch (error) {
			return { ok: false, error: String(error?.message ?? error) };
		}
	}

	/**
	 * 把**当前面板的筛选结果**导出成 Markdown。
	 * 与 exportReport 的区别：只导出这一屏、顺序就是屏幕顺序，带筛选条件说明 ——
	 * 「我刚筛出来的这批要发给谁」不用再解释一遍筛了什么。
	 * @param {{ids?: string[], filters?: object}} [options]
	 */
	async exportFiltered(options = {}) {
		const { mkdir, writeFile } = await import("node:fs/promises");
		const { items } = this.listEntries();
		const wanted = Array.isArray(options.ids) ? options.ids.map(String) : [];
		const byId = new Map(items.map((item) => [item.id, item]));
		const picked = wanted.length > 0 ? wanted.map((id) => byId.get(id)).filter(Boolean) : items;
		const filters = options.filters && typeof options.filters === "object" ? options.filters : {};
		const pad = (n) => String(n).padStart(2, "0");
		const now = new Date();
		const stamp = now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + "-" + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
		const fmtT = (ms) => {
			if (!ms) return "—";
			const date = new Date(Number(ms));
			return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
		};
		const cond = [];
		if (filters.query) cond.push("搜索 `" + String(filters.query) + "`");
		if (filters.source && filters.source !== "any") cond.push("来源 " + String(filters.source));
		if (filters.kind && filters.kind !== "all") cond.push("类型 " + String(filters.kind));
		if (filters.usage && filters.usage !== "any") cond.push("用法 " + String(filters.usage));
		if (filters.sort) cond.push("排序 " + String(filters.sort));
		const lines = [];
		lines.push("# DSH 插件目录 · 当前筛选");
		lines.push("");
		/* 体积直接取全量快照（不现量）：导出是"我现在就要拿走"的动作，不能让它等几十次递归 */
		const knownSizes = this.sizes?.byId || {};
		const sizeOf = (item) => {
			const known = knownSizes[item.id];
			return known && Number.isFinite(known.bytes) ? known.bytes : null;
		};
		const pickTotal = picked.reduce((sum, item) => sum + (sizeOf(item) || 0), 0);
		const pickNoDir = picked.filter((item) => sizeOf(item) === null).length;
		lines.push(
			"> 生成于 `" +
				fmtT(now.getTime()) +
				"`（本地时间）　｜　共 **" +
				picked.length +
				"** 条" +
				(this.sizes ? "　｜　合计 **" + formatBytes(pickTotal) + "**" + (pickNoDir > 0 ? "（" + pickNoDir + " 条没有可量的目录，按 0 计）" : "") : "　｜　体积还没量（面板上点「量体积」即可，等价于 POST /refresh what=sizes）") +
				(cond.length > 0 ? "　｜　条件：" + cond.join(" · ") : "　｜　无筛选（全部）"),
		);
		lines.push(">");
		lines.push("> 这份清单只覆盖**当前面板这一屏**，要完整快照（含来源分布、调用 Top、归属覆盖率）请用 `catalog_export`。");
		lines.push("");
		lines.push("| 名称 | 类型 | 来源 | 调用 | 报错 | 报错率 | 最近一次 | 体积 | 被依赖 | 加载 | 位置 |");
		lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
		/* R13：加载态也进清单 —— 拿出去的清单里，一行「不会被加载」比一百行调用数更能支撑"删不删" */
		const loadCellOf = (item) => {
			if (item.kind === "skill") return "—";
			if (item.loadState === "dormant") return "**不会被加载**";
			if (item.loadState === "config") return "配置挂载（" + (item.loadVia || "条目") + "）";
			if (item.loadState === "transitive") return "随 " + (item.loadVia || "依赖") + " 加载";
			if (item.loadState === "bundle") return "是";
			return "未知";
		};
		for (const item of picked) {
			const calls = item.kind === "skill" ? item.calls : item.calls;
			const rate = calls > 0 ? Math.round(((item.errors || 0) / calls) * 100) + "%" : "—";
			const name = "`" + String(item.name || item.id).replace(/\|/g, "\\|") + "`";
			const bytes = sizeOf(item);
			/* 被依赖：删这个之前先看这一列 —— 有名字就说明"删了它，这些包会坏" */
			const dependents = Array.isArray(item.dependents) ? item.dependents : [];
			const depCell =
				item.kind === "skill"
					? "—"
					: dependents.length > 0
						? dependents.slice(0, 3).join("、") + (Number(item.dependentCount) > 3 ? " 等 " + item.dependentCount + " 个" : "")
						: item.dependency
							? "直接依赖"
							: "**无人依赖**";
			lines.push(
				"| " +
					name +
					" | " +
					(item.kind === "skill" ? "Skill" : "插件") +
					" | " +
					(item.source || "") +
					" | " +
					(calls || 0) +
					" | " +
					(item.errors || 0) +
					" | " +
					rate +
					" | " +
					fmtT(item.lastUsed) +
					" | " +
					(bytes === null ? (item.inAsar ? "asar 内" : "—") : formatBytes(bytes)) +
					" | " +
					depCell +
					" | " +
					loadCellOf(item) +
					" | " +
					(item.realDir && !item.inAsar ? "`" + String(item.realDir).replace(/\|/g, "\\|") + "`" : "—") +
					" |",
			);
		}
		lines.push("");
		const markdown = lines.join("\n");
		const outPath = join(this.dir, "reports", "catalog-filtered-" + stamp + ".md");
		try {
			await mkdir(join(this.dir, "reports"), { recursive: true });
			await writeFile(outPath, markdown, "utf8");
		} catch (error) {
			return { ok: false, error: "写清单失败：" + String(error?.message ?? error) };
		}
		return { ok: true, path: outPath, count: picked.length, bytes: Buffer.byteLength(markdown, "utf8") };
	}

	/**
	 * 批量体积（多选时只问一次）：**先查全量快照，缺的才现量**。
	 * 快照存在时整个批次是纯内存查表 —— 圈 20 条不用等 20 次递归。
	 * 上限 200 条；没有独立目录 / 在 asar 里的记 null，不当成 0 字节混进总量。
	 */
	async entrySizes(ids) {
		const { items } = this.listEntries();
		const byId = new Map(items.map((item) => [item.id, item]));
		const known = this.sizes?.byId || {};
		const wanted = (Array.isArray(ids) ? ids : []).map(String).filter(Boolean).slice(0, 200);
		const sizes = {};
		let totalBytes = 0;
		let measured = 0;
		const queue = [];
		for (const id of wanted) {
			const cached = known[id];
			if (cached && Number.isFinite(cached.bytes)) {
				sizes[id] = cached.bytes;
				totalBytes += cached.bytes;
				continue;
			}
			queue.push(id);
		}
		const worker = async () => {
			while (queue.length > 0) {
				const id = queue.shift();
				const item = byId.get(id);
				if (!item || !item.realDir || item.inAsar) {
					sizes[id] = null;
					continue;
				}
				try {
					const size = await dirSize(item.realDir);
					sizes[id] = size.bytes;
					totalBytes += size.bytes;
					measured += 1;
				} catch (error) {
					sizes[id] = null;
				}
			}
		};
		await Promise.all(Array.from({ length: Math.min(4, Math.max(1, queue.length)) }, worker));
		return { ok: true, count: wanted.length, totalBytes, sizes, measured };
	}

	/**
	 * 量全量条目体积（后台任务；也可 `POST /refresh {what:"sizes"}` 手动触发）。
	 * 缓存键是 **id → 目录**：目录没变就直接复用，已卸载的条目顺手从快照里消失。
	 * @param {{force?: boolean}} [options] force 时连 dirSize 的进程内缓存一起作废
	 */
	async computeSizes(options = {}) {
		const started = Date.now();
		const { items } = this.listEntries();
		/* 官方包在 asar 里（realDir 是虚拟成员路径），量不出来也**不该显示 0 B** */
		const targets = items.filter((item) => item.realDir && !item.inAsar);
		const keep = options.force === true ? {} : { ...(this.sizes?.byId || {}) };
		const queue = targets.filter((item) => {
			const known = keep[item.id];
			return !(known && known.dir === item.realDir && Number.isFinite(known.bytes));
		});
		if (options.force === true) for (const item of targets) SIZE_CACHE.delete(item.realDir);
		const total = queue.length;
		const report = typeof options.onProgress === "function" ? options.onProgress : null;
		let done = 0;
		const worker = async () => {
			while (queue.length > 0) {
				const item = queue.shift();
				try {
					const size = await dirSize(item.realDir);
					keep[item.id] = { dir: item.realDir, bytes: size.bytes, files: size.files, truncated: Boolean(size.truncated), at: Date.now() };
				} catch (error) {
					keep[item.id] = { dir: item.realDir, bytes: null, files: 0, truncated: false, at: Date.now() };
				}
				done += 1;
				/* 面板的任务横幅要看得见进度（「sizes 37/123」），否则像卡住了 */
				if (report && (done % 4 === 0 || done === total)) report({ phase: "sizes", done, total });
			}
		};
		await Promise.all(Array.from({ length: Math.min(SIZES_CONCURRENCY, Math.max(1, queue.length)) }, worker));
		const totalBytes = Object.values(keep).reduce((sum, size) => sum + (Number.isFinite(size?.bytes) ? size.bytes : 0), 0);
		const snapshot = { version: SIZES_VERSION, at: Date.now(), count: Object.keys(keep).length, totalBytes, byId: keep };
		this.sizes = snapshot;
		const result = {
			ok: true,
			count: snapshot.count,
			measured: done,
			totalBytes,
			elapsedMs: Date.now() - started,
			truncated: Object.values(keep).filter((size) => size && size.truncated).length,
		};
		try {
			await writeJson(this.sizesFile(), snapshot);
		} catch (error) {
			result.ok = false;
			result.saveError = "体积快照写盘失败（本次结果只在内存里）：" + String(error?.message ?? error);
		}
		return result;
	}

	/** 面板用的紧凑视图：byId 只留字节数（137 条约 3 KB，20 秒轮询也吃得消）。 */
	sizesSnapshot() {
		if (!this.sizes) return null;
		const byId = {};
		const truncated = [];
		for (const [id, size] of Object.entries(this.sizes.byId || {})) {
			const bytes = size && Number.isFinite(size.bytes) ? size.bytes : null;
			byId[id] = bytes;
			/* 超过 1.5 秒 / 2 万文件预算的条目：数字是"至少这么大"，界面得说出来 */
			if (bytes !== null && size.truncated) truncated.push(id);
		}
		return { at: Number(this.sizes.at) || 0, count: Number(this.sizes.count) || 0, totalBytes: Number(this.sizes.totalBytes) || 0, byId, truncated };
	}


	/**
	 * 全量扫一遍副本漂移：只对**实体副本**的插件（junction 天然同步、asar 没有源码可比）。
	 * 工作区候选只有两个位置：`<workspace>/DSH-Plugin/<name>` 与 `<workspace>/<name>`。
	 */
	async scanDrift() {
		const { stat } = await import("node:fs/promises");
		const plugins = (this.catalog?.plugins ?? []).filter((plugin) => plugin.realDir);
		const workspace = this.workspace;
		const map = {};
		await Promise.all(
			plugins.map(async (plugin) => {
				/* junction / symlink：只有一份，目标就是工作区源码 —— 记成 linked，浮窗里能直接说清 */
				if (plugin.isLink) {
					map[plugin.id] = { verdict: "linked", workspaceDir: plugin.realDir, loadedDir: plugin.realDir };
					return;
				}
				let workspaceDir = "";
				for (const candidate of [join(workspace, "DSH-Plugin", plugin.name), join(workspace, plugin.name)]) {
					try {
						const info = await stat(candidate);
						if (info.isDirectory()) {
							workspaceDir = candidate;
							break;
						}
					} catch (error) {
						/* 没有就试下一个 */
					}
				}
				if (!workspaceDir) {
					map[plugin.id] = { verdict: "no-copy", workspaceDir: "" };
					return;
				}
				/* 同一目录（工作区里的 node_modules 之类）不比：那本来就只有一份 */
				if (workspaceDir.toLowerCase() === String(plugin.realDir).toLowerCase()) {
					map[plugin.id] = { verdict: "linked", workspaceDir };
					return;
				}
				const loaded = await fingerprintDir(plugin.realDir);
				const source = await fingerprintDir(workspaceDir);
				map[plugin.id] = { ...compareFingerprints(loaded, source), workspaceDir, loadedDir: plugin.realDir };
			}),
		);
		/* Skill 也有两份：`.dsh/skills/<name>`（DSH 实际加载的）与 staging 里的 `<stage>/<name>`（上传到 GitHub 的那份）。
		   本机实测 17 对里有 12 对 SKILL.md 长度不同 —— 发布出去的其实是旧版，这里必须标出来。
		   ★ 判据统一由 `lib/staging.mjs` 提供：`dev/ship.mjs` 的体检第 4 项用同一套规则，
		     两处各写一份的话迟早会漂成「面板说一致、体检说旧了」。
		   ★ verdict 只对本文件认识的三种值（same / newer-* / differs）对外 —— 其余（missing-*）
		     一律归成 differs，因为客户端 `driftLabel()` 的契约就是这几种，多一种会让卡片静默不标。 */
		const stageDir = skillsStageDirOf(this.settings, this.workspace);
		const skills = (this.catalog?.skills ?? []).filter((skill) => (skill.dir || skill.root) && skill.name);
		await Promise.all(
			skills.map(async (skill) => {
				const liveDir = skill.dir || skill.root;
				const staged = join(stageDir, skill.name);
				try {
					const info = await stat(staged);
					if (!info.isDirectory()) return;
				} catch (error) {
					return; /* staging 里没有这份：不感兴趣，也不标 */
				}
				const loadedStat = await skillStat(liveDir);
				const stagedStat = await skillStat(staged);
				const comparison = skillVerdict(loadedStat, stagedStat);
				if (comparison.verdict === "absent") return;
				const verdict = comparison.verdict === "same" || comparison.verdict.startsWith("newer-") ? comparison.verdict : "differs";
				/* R20：每对副本顺手列一下 staging 里的历史备份（只 stat，不读正文）。
				   ★ 这是「同步可撤销」的入口：面板在条目浮窗里显示份数与最近时间，
				     还原计划再带 withHash 读一次正文，判断"这份备份是不是和现在一样"。 */
				const backups = await listSkillBackups(staged);
				map[skill.id] = {
					verdict,
					differs: comparison.differs,
					staged: true,
					workspaceDir: staged,
					loadedDir: liveDir,
					loadedBytes: loadedStat ? loadedStat.size : null,
					stagedBytes: stagedStat ? stagedStat.size : null,
					loadedHash: loadedStat ? loadedStat.hash : null,
					stagedHash: stagedStat ? stagedStat.hash : null,
					backups: { count: backups.count, latest: backups.items[0] ? { name: backups.items[0].name, stamp: backups.items[0].stamp, size: backups.items[0].size, mtimeMs: backups.items[0].mtimeMs } : null },
				};
			}),
		);
		return map;
	}

	/** 漂移缓存 60 秒：state() 每 20 秒被轮询一次，不能每轮都扫 71 个目录。 */
	/**
	 * @param {{fresh?:boolean}} [options] `fresh:true` 跳过 60 秒缓存，直接重扫磁盘
	 *        ★ R16：**写盘计划必须 fresh**。这份缓存是给面板轮询用的；可它同时喂着
	 *        「同步 staging」的写盘闸 —— 刚改完 SKILL.md 就点同步，会拿到"两份一致"而**什么都不做**。
	 *        （R16 实测：改完 Skill 后 live 调 `catalog_skill_sync action=plan` 报 0 个旧，
	 *          而同一时刻独立进程跑 `dev/ship.mjs` 报 1 个旧。）
	 */
	async driftOf({ fresh = false } = {}) {
		const now = Date.now();
		if (!fresh && this.driftCache && now - this.driftCache.at < 60 * 1000) return this.driftCache.map;
		const map = await this.scanDrift();
		this.driftCache = { at: now, map };
		return map;
	}

	/**
	 * Skill 的 staging 同步计划：哪些 Skill 的「DSH 加载的那份」与「上传用的 staging 那份」不一致。
	 * 只出计划、不写盘；apply 时只做**单向 live → staging**（反向会把线上文件覆盖回旧版）。
	 */
	async stagedSkillPlan(ids = []) {
		const drift = await this.driftOf({ fresh: true });
		const wanted = Array.isArray(ids) ? ids.map(String) : [];
		const items = [];
		const skipped = [];
		for (const [id, entry] of Object.entries(drift)) {
			if (!entry || !entry.staged) continue;
			if (wanted.length > 0 && !wanted.includes(id)) continue;
			const name = id.replace(/^skill:/, "");
			if (isStaleVerdict(entry.verdict)) {
				items.push({ id, name, verdict: entry.verdict, loadedDir: entry.loadedDir, stagedDir: entry.workspaceDir, differs: entry.differs || [] });
				continue;
			}
			/* staging 反而更新：不同步，只提示人看一眼（自动挑"新的那份"容易把线上覆盖回旧版） */
			skipped.push({ id, name, verdict: entry.verdict, reason: entry.verdict === "newer-workspace" ? "staging 比加载的那份更新，先确认哪份才是你要的" : "两份一致" });
		}
		return { ok: true, count: items.length, items, skipped, direction: "live → staging" };
	}

	/**
	 * 把 Skill 的 SKILL.md 从 live 复制到 staging（单向）。
	 * @param {{ids?: string[], apply?: boolean, confirm?: boolean}} [options]
	 */
	async syncStagedSkills(options = {}) {
		const plan = await this.stagedSkillPlan(options.ids || []);
		if (options.apply !== true) return { ...plan, applied: false, hint: "这是计划（未写盘）。确认后带 apply:true 且 confirm:true 再调一次。" };
		if (options.confirm !== true) return { ok: false, applied: false, error: "写盘必须带 confirm:true（这条会改 staging 里的文件）", plan };
		const stamp = skillStamp();
		const synced = [];
		const backups = [];
		const failed = [];
		for (const item of plan.items) {
			try {
				/* ★ 复制与备份都收在 lib/staging.mjs：单向 live → staging，备份 `.bak-<stamp>`。
				   面板按钮、工具、脚本走的是同一条路，不存在"工具会备份、按钮不备份"这种差异。 */
				const copied = await copySkillToStaging({ loadedDir: item.loadedDir, stagedDir: item.stagedDir, stamp });
				if (copied.backup) backups.push(copied.backup);
				synced.push(item.name);
			} catch (error) {
				failed.push({ name: item.name, error: String(error?.message ?? error) });
			}
		}
		/* 写盘后漂移结果必须作废，否则面板还会显示旧结论 */
		this.driftCache = null;
		return { ok: failed.length === 0, applied: true, stamp, synced, backups, failed, count: synced.length };
	}

	/**
	 * staging 备份的**还原计划**（R20）。只出计划、不写盘。
	 *
	 * 为什么需要它：同步是单向 live → staging，覆盖前会留 `.bak-<时间戳>`，
	 * 但此前没有任何入口能把它拿回来 —— 写错了只能手工翻目录复制。这一块把
	 * 「撤销」做成和同步对称的三步（计划 → 二次确认 → 写盘），方向是 backup → staging。
	 *
	 * ★ 只列**与 staging 当前内容不同**的备份：最新那份如果和现在一致，还原等于什么都没做，
	 *   直接进 skipped 并说明原因（不制造无意义的备份）。
	 * ★ 只读 staging；`restoreStagedSkills` 也只调 `restoreSkillBackup`，永远不碰 live。
	 *
	 * @param {string[]} [ids]
	 */
	async restoreStagedSkillPlan(ids = []) {
		const drift = await this.driftOf({ fresh: true });
		const wanted = Array.isArray(ids) ? ids.map(String) : [];
		const items = [];
		const skipped = [];
		for (const [id, entry] of Object.entries(drift)) {
			if (!entry || !entry.staged) continue;
			if (wanted.length > 0 && !wanted.includes(id)) continue;
			const name = id.replace(/^skill:/, "");
			/* 还原计划必须读正文：只比 size 判断不了「这份备份是不是和现在一样」 */
			const backups = await listSkillBackups(entry.workspaceDir, { withHash: true });
			if (backups.count === 0) {
				if (wanted.length > 0) skipped.push({ id, name, reason: "没有历史备份（还没同步过，或备份被清掉了）" });
				continue;
			}
			const latest = backups.items[0];
			if (latest.hash && entry.stagedHash && latest.hash === entry.stagedHash) {
				skipped.push({ id, name, reason: "最新备份与 staging 当前内容一致（无需还原）" });
				continue;
			}
			items.push({
				id,
				name,
				stagedDir: entry.workspaceDir,
				backup: latest.name,
				backupStamp: latest.stamp,
				backupBytes: latest.size,
				backupAt: latest.mtimeMs,
				currentBytes: entry.stagedBytes ?? null,
				verdict: entry.verdict,
			});
		}
		return { ok: true, count: items.length, items, skipped, direction: "backup → staging" };
	}

	/**
	 * 把 staging 的 SKILL.md 还原到最近一份历史备份（R20）。
	 * @param {{ids?:string[], apply?:boolean, confirm?:boolean}} [options]
	 */
	async restoreStagedSkills(options = {}) {
		const plan = await this.restoreStagedSkillPlan(options.ids || []);
		if (options.apply !== true) return { ...plan, applied: false, hint: "这是还原计划（未写盘）。确认后带 apply:true 且 confirm:true 再调一次。" };
		if (options.confirm !== true) return { ok: false, applied: false, error: "还原必须带 confirm:true（这条会把 staging 的 SKILL.md 覆盖回备份版本）", plan };
		const stamp = skillStamp();
		const restored = [];
		const unchanged = [];
		const backups = [];
		const failed = [];
		for (const item of plan.items) {
			try {
				const result = await restoreSkillBackup({ stagedDir: item.stagedDir, backup: item.backup, stamp });
				if (result.skipped) unchanged.push(item.name);
				else {
					restored.push(item.name);
					if (result.preRestore) backups.push(result.preRestore);
				}
			} catch (error) {
				failed.push({ name: item.name, error: String(error?.message ?? error) });
			}
		}
		this.driftCache = null;
		return { ok: failed.length === 0, applied: true, stamp, restored, unchanged, backups, failed, count: restored.length };
	}

	/**
	 * 「不会被加载 → 怎么处置」清单（R14）。**只生成、不执行**：删不删由人决定。
	 *
	 * ★ 为什么单独一个方法而不是塞进 exportReport：处置清单要按**目录**说话（junction 删了不省
	 *   空间、被 profile 钉住的删了会回来），而导出报告是按**条目**说话。两者口径不同，
	 *   混在一份里迟早会互相污染。
	 * ★ 体积走 `dirSize`（5 分钟缓存 / 2 万文件 / 1.5 秒预算）：只有人主动点「处置清单」才付这个代价，
	 *   列表与目录构建一律不碰体积（那是打开速度的红线）。
	 */
	async runUninstall({ onProgress } = {}) {
		const report = typeof onProgress === "function" ? onProgress : null;
		if (report) report({ phase: "uninstall", done: 0, total: 3, current: "扫依赖图" });
		const profilePackage = (await readJson(join(profileDir(), "package.json"), null)) || {};
		const composition = await profileComposition();
		if (report) report({ phase: "uninstall", done: 1, total: 3, current: "算加载态" });
		const plan = await buildUninstallPlan({
			nodeModules: profileNodeModules(),
			profileDeps: profilePackage.dependencies && typeof profilePackage.dependencies === "object" ? profilePackage.dependencies : {},
			bundles: await profileBundles(),
			compositions: composition.files.flatMap((file) => parseComposition(file.text)),
			workspace: this.workspace,
			sizeOf: (dir) => dirSize(dir),
		});
		if (report) report({ phase: "uninstall", done: 3, total: 3, current: "完成" });
		/* ★ 单独存一份（不是塞进 job）：job 只有一格，后面的量体积/统计会把它顶掉 —— R11 踩过。 */
		this.lastUninstall = plan;
		return { ok: plan.ok, ...summarizeUninstallPlan(plan) };
	}

	/**
	 * R16：**删除预演** —— 按上次的清单（或点名几个包）在内存里把包摘掉，重算加载态。
	 *
	 * ★ 为什么要有它：R14 的清单只说"这些现在不会被加载、删了能省多少"，没有回答
	 *   "删完以后会不会有东西指空"（入口悬空 / 保留的包声明了它）。这两件事能在内存里先算出来。
	 * ★ 每次都**重新扫一遍依赖图**：预演要反映磁盘现在的样子。扫 200 个目录是百毫秒级，
	 *   拿上次清单的缓存去算反而会在"刚删完赶紧再预演一次"这种场景下给出假结论。
	 * ★ 字节数只能来自清单（量体积是懒算的闸门，预演不该为它多扫一遍盘）：没清单就只出结构结论。
	 */
	async simulateUninstall({ packages } = {}) {
		const listed = Array.isArray(packages) ? packages.map((name) => String(name ?? "").trim()).filter(Boolean) : [];
		const plan = this.lastUninstall;
		/* ★ 默认名单取**目录名**而不是包名：同项目第二份 / 别名目录下，一个包名对应两个目录
		   （本机 ghbackup 与 dsh-github-backup），按包名删会把正在加载的那一份也算进去。 */
		const fromPlan = plan?.ok === true ? (plan.groups || []).flatMap((group) => group.members.map((member) => member.dirName)) : [];
		const wanted = listed.length > 0 ? listed : fromPlan;
		if (wanted.length === 0) {
			return { ok: false, error: "还没有可预演的名单：先算一次处置清单（catalog_uninstall action=plan / 面板「处置清单」），或用 packages 点名要删的包/目录" };
		}
		const scanned = await scanInstalledPackages(profileNodeModules());
		const composition = await profileComposition();
		const sim = simulateRemoval({
			installed: scanned.installed,
			dirs: scanned.dirs,
			bundles: await profileBundles(),
			compositions: composition.files.flatMap((file) => parseComposition(file.text)),
			remove: wanted,
		});
		/* 体积按**目录**对上：同一个包名有两份时，只有被摘掉的那些目录才算数 */
		const members = new Map();
		for (const group of plan?.groups || []) {
			for (const member of group.members) if (!members.has(member.dirName)) members.set(member.dirName, { ...member, groupLabel: group.label });
		}
		let reclaimBytes = 0;
		const whyZero = [];
		const unlisted = [];
		for (const dirName of sim.removedDirs) {
			const member = members.get(dirName);
			if (!member) {
				unlisted.push(dirName);
				continue;
			}
			reclaimBytes += Number(member.reclaimBytes) || 0;
			if (!(Number(member.reclaimBytes) > 0) && whyZero.length < 8) whyZero.push({ dirName: member.dirName, provenance: member.provenance });
		}
		return { ...sim, bytes: { reclaimBytes, whyZero, unlisted }, listed: listed.length > 0, planAt: Number(plan?.at) || 0 };
	}

	/** 面板 /state 用的紧凑视图（不带每组命令文本）。 */
	uninstallSummary() {
		const summary = summarizeUninstallPlan(this.lastUninstall);
		if (!summary) return null;
		return { ...summary, savedTo: this.lastUninstallSavedTo || "" };
	}

	/**
	 * 把上次算好的清单写成 `reports/uninstall-<stamp>.md` + `.json`。
	 * 写盘必须 `confirm:true` —— 闸放在服务端，按钮误点不该产生文件。
	 */
	async writeUninstallReport({ confirm } = {}) {
		if (confirm !== true) return { ok: false, error: "写盘必须带 confirm:true（会写 reports/ 下两个文件）" };
		const plan = this.lastUninstall;
		if (!plan || plan.ok !== true) return { ok: false, error: "还没有清单：先调一次 runUninstall（面板上点「处置清单」/ 工具 catalog_uninstall action=plan）" };
		const { mkdir, writeFile } = await import("node:fs/promises");
		const pad = (value) => String(value).padStart(2, "0");
		const now = new Date(Number(plan.at) || Date.now());
		const stamp = now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + "-" + pad(now.getHours()) + pad(now.getMinutes());
		const dir = join(this.dir, "reports");
		const mdPath = join(dir, "uninstall-" + stamp + ".md");
		const jsonPath = join(dir, "uninstall-" + stamp + ".json");
		const markdown = renderUninstallPlan(plan);
		try {
			await mkdir(dir, { recursive: true });
			await writeFile(mdPath, markdown, "utf8");
			await writeFile(jsonPath, JSON.stringify(plan, null, 1), "utf8");
		} catch (error) {
			return { ok: false, error: "写清单失败：" + String(error?.message ?? error) };
		}
		this.lastUninstallSavedTo = mdPath;
		return { ok: true, mdPath, jsonPath, bytes: Buffer.byteLength(markdown, "utf8"), preview: markdown.slice(0, 700) };
	}

	hostCoreDetail(options, hostCore) {
		const pageSize = Math.min(500, Math.max(5, Number(options.pageSize) || this.settings.sessionsPageSize));
		const page = Math.max(1, Number(options.page) || 1);
		const aggregate = this.aggregate;
		const counts = new Map();
		if (aggregate) {
			for (const tool of hostCore.tools) {
				const full = aggregate.tools.get(tool.name);
				if (!full) continue;
				for (const [sessionId, count] of full.sessionCounts) counts.set(sessionId, (counts.get(sessionId) || 0) + count);
			}
		}
		const rows = [...counts.entries()]
			.map(([sessionId, count]) => {
				const session = aggregate?.sessions.get(sessionId) || { id: sessionId, title: sessionId.slice(0, 8) };
				return { id: sessionId, title: session.title, calls: count, lastAt: session.lastAt, isSubagent: Boolean(session.parent) || session.depth > 0, parentTitle: session.parent ? aggregate?.sessions.get(session.parent)?.title || "" : "", depth: session.depth || 0 };
			})
			.sort((a, b) => b.calls - a.calls);

		return {
			ok: true,
			item: {
				id: "host-core",
				kind: "host",
				name: "宿主核心工具",
				title: "宿主核心工具",
				descriptionZh: "由 DSH 宿主自带（在 app.asar 里）或来源无法判定的工具。它们不属于任何可上传的插件，单列在这里。",
				descriptionEn: "Tools provided by the DSH host itself (inside app.asar), or whose owner could not be determined.",
				source: "official",
				sourceWhy: ["宿主自带 / 归属不明"],
				calls: hostCore.calls,
				tags: { purpose: [], context: [], origin: ["src-official"] },
			},
			tools: hostCore.tools,
			sessions: { items: rows.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total: rows.length, pages: Math.max(1, Math.ceil(rows.length / pageSize)), pageSizes: this.settings.pageSizes },
			statsMeta: this.statsMeta,
			statsLimited: false,
		};
	}

	/** 完整面板状态（一次请求给全，前端不再拼多次）。 */
	async state() {
		const list = this.listEntries();
		const diskBuild = await buildStamp();
		return {
			ok: true,
			build: { ...diskBuild, loaded: LOADED_VERSION, stale: isStaleBuild(diskBuild, LOADED_VERSION) },
			host: await hostVersions(),
			profileDir: profileDir(),
			workspace: this.workspace,
			dataDir: this.dir,
			skillRoots: skillRoots(this.settings.workspace),
			settings: this.settings,
			defaults: loadSettingsDefaults(),
			tags: {
				all: listTags(this.tags),
				assignments: this.tags.assignments,
				prompt: tagPrompt(this.tags),
			},
			catalogMeta: {
				builtAt: this.catalog?.builtAt || 0,
				counts: this.catalog?.counts || {},
				errors: this.catalog?.errors || [],
				fromCache: Boolean(this.catalog?.fromCache),
				stale: Boolean(this.catalogStale),
				ageMs: Number.isFinite(this.catalogAgeMs) ? this.catalogAgeMs : null,
			},
			stats: {
				ready: Boolean(this.aggregate),
				stale: Boolean(this.statsStale),
				meta: this.statsMeta,
				cacheAgeMs: this.statsMeta ? Date.now() - Number(this.statsMeta.builtAt || 0) : null,
			},
			attribution: this.attrib.stats || {},
			job: this.jobSnapshot(),
			/* R11：上一次体检结论单独带出来（job 那一格会被后面的后台任务顶掉） */
			preflight: this.lastPreflight,
			weekly: this.weekly,
			weeklyDue: { gap: isDue(this.weekly?.lastGapAt), security: isDue(this.weekly?.lastSecurityAt) },
			reports: { gap: summarizeReport(this.weekly?.gap), security: summarizeReport(this.weekly?.security) },
			intros: { model: this.intros?.model || "", generatedAt: this.intros?.generatedAt || 0, count: Object.keys(this.intros?.byEntry || {}).length },
			clientReport: this.clientReport,
			/* 副本漂移：工作区源码与加载的那份是否同一版（卡片上会标「副本不同步」） */
			drift: await this.driftOf(),
			/* 体积快照：卡片上的体积、按体积排序、当前筛选合计、导出都读这一份 */
			sizes: this.sizesSnapshot(),
			/* 依赖图自述：扫了多少个包 / 多少直接依赖 / 几个"无人依赖"的候选（R9） */
			dependency: this.catalog?.dependencyMeta || null,
			/* R14：处置清单（不会被加载 → 怎么卸干净）。单独存一份，不靠 job 那一格。 */
			uninstall: this.uninstallSummary(),
			/* R17：自上次快照以来变了什么（目录重建时记录；指纹没变就不会有新的） */
			changes: this.changesSummary(),
			/* R19：自**上次确认**以来变了什么（没标记过就是 null，别冒充 0 处） */
			sinceAck: await this.sinceAckSummary(),
			/* R21：更早的窗口（相邻快照两两相减，新的在前；基线不产出行） */
			timeline: await this.historyTimeline(),
			entries: list.items,
			hostCore: this.hostCoreUsage(),
			totals: list.totals,
			warnings: drainWarnings(),
			publishing: {
				publishable: selectCandidates(this.catalog || {}, this.settings),
				skillsRepo: skillsRepoName(this.settings),
				skillsStageDir: skillsStageDirOf(this.settings, this.workspace),
				lastPlan: this.lastPlan ? { planId: this.lastPlan.planId, summary: this.lastPlan.summary, generatedAt: this.lastPlan.generatedAt } : null,
			},
		};
	}

	/* ───────────── 标签 / 覆盖 ───────────── */

	async setTags(entryId, tags, by = "user") {
		const saved = setEntryTags(this.tags, entryId, tags, by);
		await saveTagsStore(this.dir, this.tags);
		return { ok: true, entryId, tags: saved };
	}

	/**
	 * 批量打标（幂等）。语义是「给这批条目加上 / 去掉这几个标签」，与 setTags 的替换语义分开。
	 *
	 * ★ ids 必须先在**当前目录**里存在：否则 tags.json 会长出幽灵分配 ——
	 *   条目卸载后分配留着，将来同名条目装回来会莫名其妙已经有标签，而界面上没有任何线索。
	 */
	async applyTags(entryIds, ops, by = "user") {
		const known = new Set(this.listEntries().items.map((entry) => entry.id));
		const ids = [...new Set((Array.isArray(entryIds) ? entryIds : []).map(String).filter((id) => id !== ""))];
		const unknownIds = ids.filter((id) => !known.has(id));
		const targets = ids.filter((id) => known.has(id));
		if (targets.length === 0) return { ok: false, error: "没有可打标的条目（id 不在当前目录里）", unknownIds };
		const result = applyTagOps(this.tags, targets, ops, by);
		if (result.changed > 0) await saveTagsStore(this.dir, this.tags);
		return { ok: true, ids: targets.length, unknownIds, ...result };
	}

	async addTag(input) {
		const result = addCustomTag(this.tags, input);
		if (!result.ok) return result;
		await saveTagsStore(this.dir, this.tags);
		return { ok: true, tag: result.tag, all: listTags(this.tags) };
	}

	async removeTag(id) {
		const result = removeCustomTag(this.tags, id);
		if (result.ok) await saveTagsStore(this.dir, this.tags);
		return { ...result, all: listTags(this.tags) };
	}

	/** 手工指定来源（混血/自写拿不准时用一次，之后不再问）。 */
	async setSource(entryId, source, note = "") {
		if (!["official", "self", "third", "hybrid", "pending"].includes(source)) return { ok: false, error: "来源只能是 official/self/third/hybrid/pending" };
		this.overrides.sources = { ...(this.overrides.sources || {}), [entryId]: source };
		await this.saveOverrides();
		for (const collection of [this.catalog?.plugins, this.catalog?.skills]) {
			for (const entry of collection || []) {
				if (entry.id === entryId) {
					entry.sourceWhy = [...(entry.sourceWhy || []), `用户手工标记为 ${source}${note ? "：" + note : ""}`];
					entry.askUser = false;
				}
			}
		}
		return { ok: true, entryId, source };
	}

	/** 手工指定工具归属。 */
	async setToolOwner(toolName, pkg) {
		this.overrides.tools = { ...(this.overrides.tools || {}), [toolName]: pkg };
		await this.saveOverrides();
		this.attrib = await buildToolIndex({
			dataDir: this.dir,
			tools: this.toolSchemas(),
			packages: [],
			overrides: this.overrides.tools || {},
			force: false,
		});
		return { ok: true, toolName, owner: pkg };
	}

	/* ───────────── AI 任务 ───────────── */

	async runClassify(ids) {
		const { items } = this.listEntries();
		const targets = ids && ids.length > 0 ? items.filter((item) => ids.includes(item.id)) : items.filter((item) => item.tags.purpose.length === 0 && item.tags.context.length === 0);
		const model = this.settings.aiModel;
		const result = await classifyEntries(this.ctx, targets, tagPrompt(this.tags), { model });
		if (!result.ok) return { ok: false, error: result.error, model: result.model };
		let applied = 0;
		const skipped = [];
		for (const [id, tags] of Object.entries(result.assignments)) {
			const entry = items.find((item) => item.id === id);
			if (!entry) continue;
			if (this.tags.assignments?.[id]?.by === "user") {
				skipped.push(id); // 用户手标过的不覆盖
				continue;
			}
			setEntryTags(this.tags, id, { purpose: tags?.purpose, context: tags?.context }, "ai");
			applied += 1;
		}
		await saveTagsStore(this.dir, this.tags);
		return { ok: true, model: result.model, applied, skipped, requested: targets.length };
	}

	async runIntros(force = false) {
		const { items } = this.listEntries();
		const pending = items.filter((item) => (force || !this.intros.byEntry?.[item.id]) && item.descriptionEn);
		if (pending.length === 0) return { ok: true, generated: 0, model: this.intros.model || "", reason: "没有需要生成中文简介的条目" };
		const result = await generateZhIntros(this.ctx, pending, { model: this.settings.aiModel });
		if (!result.ok) return { ok: false, error: result.error, model: result.model };
		const byEntry = { ...(this.intros.byEntry || {}) };
		for (const [id, zh] of Object.entries(result.intros)) byEntry[id] = { zh, model: result.model, at: Date.now(), manual: false };
		this.intros = { version: 1, byEntry, model: result.model, generatedAt: Date.now() };
		await writeJson(this.introsFile(), this.intros);
		return { ok: true, generated: Object.keys(result.intros).length, model: result.model };
	}

	/** 用户在面板上手改中文简介。 */
	async setIntro(entryId, zh) {
		const byEntry = { ...(this.intros.byEntry || {}) };
		byEntry[entryId] = { zh: String(zh || "").slice(0, 200), model: "manual", at: Date.now(), manual: true };
		this.intros = { ...this.intros, byEntry, generatedAt: Date.now() };
		await writeJson(this.introsFile(), this.intros);
		return { ok: true };
	}

	/* ───────────── 上传 / 公开 ───────────── */

	async planUpload() {
		if (!this.catalog) return { ok: false, error: "目录还没就绪" };
		const plan = await planUpload({
			catalog: this.catalog,
			settings: { ...this.settings, skillsStageDir: skillsStageDirOf(this.settings, this.workspace) },
		});
		const planId = "plan-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
		this.lastPlan = { ...plan, planId };
		return { ok: true, plan: { planId, generatedAt: plan.generatedAt, login: plan.login, items: plan.items.map(publicPlanItem), summary: plan.summary } };
	}

	/**
	 * 执行上传。**必须**传 planId + confirm:true（= 用户看过计划并点确认）。
	 */
	async applyUpload({ planId, confirm, translate = true, ackRepos = [] }) {
		if (confirm !== true) return { ok: false, error: "需要 confirm:true —— 先看计划再推" };
		if (!this.lastPlan || this.lastPlan.planId !== planId) return { ok: false, error: "计划已失效，请重新生成计划（planUpload）" };
		if (this.busy) return { ok: false, error: "有任务在跑，稍后再试" };

		const plan = this.lastPlan;
		const translator = translate
			? async (item, zh) => translateReadme(this.ctx, { name: item.name, zh }, { model: this.settings.aiModel })
			: null;
		const result = await applyUpload(plan, {
			translate: translator,
			commit: true,
			confirm: true,
			ackRepos: Array.isArray(ackRepos) ? ackRepos.map(String) : [],
			onProgress: (progress) => this.job?.progress && Object.assign(this.job.progress, progress),
		});
		this.lastPlan = null;
		/* 推完刷新一次目录（远端状态变了） */
		await this.rebuildCatalog({ force: true }).catch(() => {});
		return { ok: result.ok, result };
	}

	/**
	 * 把某个仓改为公开。独立操作：必须 confirm:true，且**先重扫**。
	 */
	async publishPublic({ repo, dir, confirm }) {
		/* ★ 门禁先于一切：连"找不找得到本地目录"都不该在没 confirm 时先算 ——
		   否则报错信息会把人引到"路径不对"这条岔路上去。 */
		if (confirm !== true) return { ok: false, error: "公开操作必须显式确认（confirm:true）—— 默认所有仓都是私有的" };
		if (!repo) return { ok: false, error: "需要 repo 名" };
		const targetDir = dir || this.findDirForRepo(repo);
		if (!targetDir) return { ok: false, error: "找不到该仓的本地目录，请显式给 dir" };
		const result = await makePublic({ repo, dir: targetDir, confirm, ghBin: this.settings.ghBin });
		return result;
	}

	findDirForRepo(repo) {
		for (const plugin of this.catalog?.plugins ?? []) {
			if (repoNameFor(plugin) === repo) return plugin.realDir;
		}
		const stage = skillsStageDirOf(this.settings, this.workspace);
		if (stage && repo === skillsRepoName(this.settings)) return stage;
		return "";
	}

	/* ───────────── 每周任务 ───────────── */

	/** 只保留 `name` 对应的那一个插件（`name` 为空 = 全部自写/混血）。 */
	filteredCatalog(name) {
		const catalog = this.catalog || { plugins: [], skills: [] };
		if (!name) return catalog;
		const wanted = String(name).replace(/^plugin:/, "").trim().toLowerCase();
		const plugins = (catalog.plugins || []).filter((plugin) => {
			if (plugin.name.toLowerCase() === wanted) return true;
			const short = plugin.name.replace(/^@[^/]+\//, "").toLowerCase();
			return short === wanted || short === wanted.replace(/^dsh-/, "");
		});
		return { ...catalog, plugins, skills: (catalog.skills || []).filter((skill) => skill.name.toLowerCase() === wanted) };
	}

	async runGap(catalog = null) {
		const target = catalog || this.catalog || {};
		const report = await runGapAnalysis(this.ctx, target, { model: this.settings.aiModel });
		/* 只跑全量时才更新"上次执行时间"：单仓抽查不该把每周提醒推后 */
		if (!catalog) {
			this.weekly = { ...this.weekly, lastGapAt: report.ranAt, gap: report };
			await saveWeekly(this.dir, this.weekly);
		}
		return { ok: true, summary: summarizeReport(report), report };
	}

	async runSecurity(catalog = null) {
		const target = catalog || this.catalog || {};
		const report = await runSecurityAudit(this.ctx, target, { model: this.settings.aiModel });
		if (!catalog) {
			this.weekly = { ...this.weekly, lastSecurityAt: report.ranAt, security: report };
			await saveWeekly(this.dir, this.weekly);
		}
		return { ok: true, summary: summarizeReport(report), report };
	}

	/**
	 * 打开面板时调一次：到期就在**后台**跑（不阻塞），默认只跑缺口分析。
	 *
	 * ★ 必须记「尝试时间」（`lastGapAttemptAt`），不能只看「成功时间」：
	 *   面板每 2.5~20 秒轮询一次 `/state`，如果这次失败（AI 不可用 / 没默认模型），
	 *   `lastGapAt` 不会被写上 —— 于是**每一次轮询都会再试一次**，变成一个无限重试的
	 *   模型调用循环。这里加 1 小时退避。
	 */
	weeklyTick() {
		if (!this.weekly) return { started: false };
		const backoffMs = 60 * 60 * 1000;
		const attempted = Number(this.weekly.lastGapAttemptAt) || 0;
		if (Date.now() - attempted < backoffMs) return { started: false, reason: "recent-attempt" };
		if (!this.settings.weeklyGapAuto) return { started: false, reason: "disabled" };
		if (!isDue(this.weekly.lastGapAt)) return { started: false, reason: "not-due" };
		if (this.busy) return { started: false, reason: "busy" };

		this.weekly = { ...this.weekly, lastGapAttemptAt: Date.now() };
		saveWeekly(this.dir, this.weekly).catch(() => {});
		this.startJob("weekly-gap", async (progress) => await this.runGapWithProgress(progress));
		return { started: true, kind: "weekly-gap" };
	}

	async runGapWithProgress(progress) {
		const report = await runGapAnalysis(this.ctx, this.catalog || {}, {
			model: this.settings.aiModel,
			onProgress: (patch) => progress(patch),
		});
		this.weekly = { ...this.weekly, lastGapAt: report.ranAt, gap: report };
		await saveWeekly(this.dir, this.weekly);
		return { summary: summarizeReport(report) };
	}

	/* ───────────── 导出报告（换会话 / 交接 / 留证据） ───────────── */

	/**
	 * 把当前快照导出成 Markdown 报告。
	 *
	 * 为什么要固定成能力：这份内容每次交接都要手搓一遍（清点插件、来源分布、调用 Top、
	 * 待标记清单、归属覆盖率）。写进插件后一句话就能出，而且**数字与面板同源**
	 * （都走 listEntries/entryUsage），不会出现"报告与界面不一致"。
	 *
	 * @param {{path?:string, top?:number}} [options]
	 */
	async exportReport(options = {}) {
		const { mkdir, writeFile } = await import("node:fs/promises");
		const { join } = await import("node:path");
		const top = Math.min(60, Math.max(5, Number(options.top) || 20));
		const { items, hostCore, totals } = this.listEntries();
		const plugins = items.filter((item) => item.kind === "plugin");
		const skills = items.filter((item) => item.kind === "skill");
		const meta = this.statsMeta || {};
		const stats = this.attrib.stats || {};
		const pad = (n) => String(n).padStart(2, "0");
		const now = new Date();
		const stamp = now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + "-" + pad(now.getHours()) + pad(now.getMinutes());
		const at = now.toISOString();
		const fmtN = (value) => (Number(value) || 0).toLocaleString("en-US");
		/* ★ 用**本地时间**：toISOString 是 UTC，报告里写 17:54 而面板写 01:54 会对不上 */
		const fmtT = (ms) => {
			if (!ms) return "—";
			const date = new Date(Number(ms));
			const p = (n) => String(n).padStart(2, "0");
			return date.getFullYear() + "-" + p(date.getMonth() + 1) + "-" + p(date.getDate()) + " " + p(date.getHours()) + ":" + p(date.getMinutes());
		};
		/* ★ 子代理会话数在 aggregate.totals 里，不在 meta 里（曾在这里读错、报成 0%） */
		const subagentSessions = Number(this.aggregate?.totals?.subagentSessions) || 0;
		const subagentRatio = meta.sessions ? Math.round((subagentSessions / meta.sessions) * 100) : 0;

		/* 来源分布要**分开算**：totals.bySource 是「插件 + Skill」的合计，
		   直接写进"插件 71：官方7/自写40…"会出现 40 = 23 插件 + 17 Skill 的口径错乱（真踩过）。 */
		const pluginBySource = { official: 0, self: 0, third: 0, hybrid: 0, pending: 0 };
		for (const item of plugins) pluginBySource[item.source] = (pluginBySource[item.source] || 0) + 1;
		const skillSelf = skills.filter((item) => item.source === "self").length;

		const lines = [];
		lines.push("# DSH 插件/Skill 目录快照");
		lines.push("");
		lines.push("> 生成于 `" + fmtT(now.getTime()) + "`（本地时间）　｜　数据目录 `" + this.dir + "`");
		lines.push("> 本报告由 `dsh-plugin-catalog` 生成，数字与面板同源。");
		lines.push("");
		lines.push("## 概览");
		lines.push("");
		lines.push(
			"- 插件 **" + plugins.length + "**：官方 " + (pluginBySource.official || 0) + " / 自写 " + (pluginBySource.self || 0) + " / 第三方 " + (pluginBySource.third || 0) + " / 混血 " + (pluginBySource.hybrid || 0) + " / 待标记 " + (pluginBySource.pending || 0),
		);
		lines.push("- Skill **" + skills.length + "**（其中自写 " + skillSelf + "）");
		lines.push("- 最近 " + (meta.windowDays || 90) + " 天：**" + fmtN(meta.calls) + "** 次调用 / " + (meta.sessions || 0) + " 个会话 / 其中子代理 " + fmtN(subagentSessions) + " 个（" + subagentRatio + "%）");
		lines.push("- 归属：**" + (stats.total || 0) + "** 个工具（描述指纹 " + (stats.byDescription || 0) + "、名字 " + (stats.byName || 0) + "、判为宿主 " + (stats.host || 0) + "、歧义 " + (stats.unknown || 0) + "）");
		lines.push("- 统计缓存：生成于 " + fmtT(meta.builtAt) + "，耗时 " + (meta.durationMs || 0) + " ms，去重 " + (meta.duplicateCalls || 0) + " 条重复日志");
		lines.push("- 宿主核心工具：" + fmtN(hostCore.calls) + " 次（" + hostCore.tools.length + " 个工具，**不计入任何插件**）");
		/* 体积：概览里只给一行总量；明细在「磁盘占用」一节。全读快照，不现量 —— 导出不该等几十次递归。 */
		const sizeOfItem = (item) => {
			const known = this.sizes?.byId?.[item.id];
			return known && Number.isFinite(known.bytes) ? known : null;
		};
		const sized = items.filter((item) => sizeOfItem(item) !== null);
		const sizeTotal = sized.reduce((sum, item) => sum + sizeOfItem(item).bytes, 0);
		const sizeTruncated = sized.filter((item) => sizeOfItem(item).truncated).length;
		lines.push(
			this.sizes
				? "- 磁盘占用：已量 **" + sized.length + "** 条 / 合计 **" + formatBytes(sizeTotal) + "**（" + fmtT(this.sizes.at) + "）" + (items.length - sized.length > 0 ? "；" + (items.length - sized.length) + " 条没有可量目录（官方 asar 内），不计入" : "") + (sizeTruncated > 0 ? "；" + sizeTruncated + " 条超过预算只算了一部分（标 +）" : "")
				: "- 磁盘占用：还没量（面板点「量体积」，或 POST /refresh what=sizes）",
		);
		/* R13：加载路径也进快照 —— `enabled`（在不在 bundles）不是加载判据，报告里必须给对口径 */
		const loadMeta = this.catalog?.dependencyMeta || null;
		if (loadMeta && loadMeta.loadCounts) {
			const loadCounts = loadMeta.loadCounts;
			lines.push(
				"- 加载路径：入口 **" +
					(loadMeta.loadRoots || 0) +
					"** 个（bundles + " +
					(loadMeta.compositionFiles || 0) +
					" 份组合文件）；直接 **" +
					(loadCounts.bundle || 0) +
					"** / 配置挂载 **" +
					(loadCounts.config || 0) +
					"** / 随依赖 **" +
					(loadCounts.transitive || 0) +
					"** / **不在任何入口上 " +
					(loadCounts.dormant || 0) +
					"**（按包计；插件条目里的 dormant 见下一节）",
			);
		}
		lines.push("");

		/* R17：变化一节紧跟概览 —— 接手时第一句往往是「这两天变了什么」 */
		const changes = this.changes;
		const sinceAck = await this.sinceAckSummary();
		if (changes) {
			lines.push("## 变化" + (changes.first ? "（第一条快照）" : "（基线 " + fmtT(changes.baselineAt) + "）"));
			lines.push("");
			if (changes.first) {
				lines.push("- 这是**第一条**快照（" + fmtT(changes.at) + "，共 " + changes.total + " 条）—— 从下一次目录重建开始，这里会出现「自上次以来变了什么」");
			} else {
				const counts = changes.counts;
				lines.push("- 期间：" + fmtT(changes.baselineAt) + " → " + fmtT(changes.at) + "；**" + counts.total + "** 条变化，其余 " + changes.unchanged + " 条没动");
				lines.push("- 新增 **" + counts.added + "** / 消失 **" + counts.removed + "** / 升版 **" + counts.version + "** / 来源变 **" + counts.source + "** / 加载态变 **" + counts.loadState + "** / 被编辑 **" + counts.edited + "**");
				const groups = [
					["新增", changes.added, "added"],
					["消失", changes.removed, "removed"],
					["升版", changes.versionChanged, "version"],
					["来源变", changes.sourceChanged, "source"],
					["加载态变", changes.loadStateChanged, "loadState"],
					["被编辑", changes.edited, "edited"],
				].filter(([, list]) => Array.isArray(list) && list.length > 0);
				if (groups.length > 0) {
					lines.push("");
					for (const [label, list, kind] of groups) {
						const shown = list.map((item) => "`" + describeChange(item, kind) + "`").join("、");
						lines.push("- **" + label + "**：" + shown + (list.length < (Number(counts[kind]) || 0) ? "（只列前 " + list.length + " 条）" : ""));
					}
				}
				lines.push("- 判据：插件比 `version / source / loadState`，Skill 比 `source / 有描述 / 正文内容哈希`（改一个字也算被编辑）；工具数、体积、git 脏文件不进变化");
			}
			/* R19：确认窗口 —— 与「自上次快照以来」并列，不能混为一谈 */
			if (sinceAck) {
				const c = sinceAck.counts;
				lines.push("- 自上次确认（" + fmtT(sinceAck.ackAt) + "）以来：**" + c.total + "** 条（新增 " + c.added + " / 消失 " + c.removed + " / 升版 " + c.version + " / 来源变 " + c.source + " / 加载态变 " + c.loadState + " / 被编辑 " + c.edited + "）");
			} else {
				lines.push("- 还没标记过「已看过」—— 面板变化条上点「标记已看过」后，这里会单独给出「自那以来」的窗口");
			}
			lines.push("");
		}

		/* R21：更早的窗口 —— 数据早就在 history.json 里（最多 20 条），此前只有最近一个窗口能看见 */
		const timeline = await this.historyTimeline();
		if (timeline.items.length > 0) {
			lines.push("### 历史（最近 " + Math.min(timeline.items.length, 8) + " 个窗口 / 共 " + timeline.total + " 条快照）");
			lines.push("");
			for (const row of timeline.items.slice(0, 8)) {
				const buckets = [
					["新增", row.added, "added"],
					["消失", row.removed, "removed"],
					["升版", row.versionChanged, "version"],
					["来源变", row.sourceChanged, "source"],
					["加载态变", row.loadStateChanged, "loadState"],
					["被编辑", row.edited, "edited"],
				];
				const bits = [];
				for (const [label, list, kind] of buckets) {
					const count = Number(row.counts[kind]) || 0;
					if (count === 0) continue;
					const names = list.map((item) => "`" + describeChange(item, kind) + "`").join("、");
					bits.push(label + " " + count + (names ? "（" + names + (list.length < count ? "…" : "") + "）" : ""));
				}
				lines.push("- " + fmtT(row.at) + "：" + bits.join("；"));
			}
			lines.push("");
		}

		lines.push("## 调用 Top " + top + "（插件）");
		lines.push("");
		lines.push("| 插件 | 来源 | 总调用 | 父会话直呼 | 含子代理 | 最近使用 | 工具数 |");
		lines.push("|---|---|---:|---:|---:|---|---:|");
		for (const item of plugins.slice().sort((a, b) => (b.calls || 0) - (a.calls || 0)).slice(0, top)) {
			lines.push(
				"| `" + item.name + "` | " + item.source + " | " + fmtN(item.calls) + " | " + fmtN((item.calls || 0) - (item.subagentCalls || 0)) + " | " + fmtN(item.subagentCalls) + " | " + fmtT(item.lastUsed) + " | " + (item.toolCount || 0) + " |",
			);
		}
		lines.push("");

		/* R13：「装了但不会被加载」单独一节 —— 这是比「从未调用」更硬的死重量判据，
		   交接清单里必须能一眼看到（本机 23 条，含整个 mnemon 子系统）。 */
		const dormantPlugins = plugins.filter((item) => item.loadState === "dormant");
		if (dormantPlugins.length > 0) {
			let dormantBytes = 0;
			let dormantSized = 0;
			for (const item of dormantPlugins) {
				const size = sizeOfItem(item);
				if (size) {
					dormantBytes += size.bytes;
					dormantSized += 1;
				}
			}
			lines.push("## 不会被加载（" + dormantPlugins.length + " 条）");
			lines.push("");
			lines.push("> 不在 `dsh.profile.bundles`、没有 cordis 配置条目、也不在任何入口的依赖链上 —— 宿主根本不会加载它们。");
			lines.push("> 判据是**声明层面**的：运行时按路径 `require()` 的动态加载看不见，所以写「不会被加载」而不是「绝对没跑」。");
			lines.push("> 其中 " + dormantSized + " 条有体积记录，合计 **" + formatBytes(dormantBytes) + "**；删掉不影响当前加载（但别删你打算以后挂进 `cordis.patch.yml` 的）。");
			lines.push("");
			lines.push("| 名称 | 来源 | 版本 | 体积 | 最近调用 |");
			lines.push("|---|---|---|---:|---|");
			for (const item of dormantPlugins.slice().sort((a, b) => (sizeOfItem(b)?.bytes || 0) - (sizeOfItem(a)?.bytes || 0))) {
				const size = sizeOfItem(item);
				lines.push("| `" + item.name + "` | " + item.source + " | " + (item.version || "—") + " | " + (size ? formatBytes(size.bytes) : "—") + " | " + fmtT(item.lastUsed) + " |");
			}
			lines.push("");
		}

		/* 磁盘占用 Top 10 + 「从未被调用那批一共多大」—— 清理决策要的两个数，导出里直接给 */
		if (this.sizes && sized.length > 0) {
			lines.push("## 磁盘占用 Top 10（按体积）");
			lines.push("");
			lines.push("| 名称 | 类型 | 来源 | 体积 | 文件数 | 被依赖 | 调用 | 最近 |");
			lines.push("|---|---|---|---:|---:|---|---:|---|");
			for (const item of sized.slice().sort((a, b) => sizeOfItem(b).bytes - sizeOfItem(a).bytes).slice(0, 10)) {
				const size = sizeOfItem(item);
				const dependents = Array.isArray(item.dependents) ? item.dependents : [];
				const depCell =
					item.kind === "skill"
						? "—"
						: dependents.length > 0
							? dependents.slice(0, 2).join("、") + (Number(item.dependentCount) > 2 ? " 等 " + item.dependentCount + " 个" : "")
							: item.dependency
								? "直接依赖"
								: "**无人依赖**";
				lines.push(
					"| `" +
						item.name +
						"` | " +
						(item.kind === "skill" ? "Skill" : "插件") +
						" | " +
						item.source +
						" | " +
						formatBytes(size.bytes) +
						(size.truncated ? "+" : "") +
						" | " +
						fmtN(size.files) +
						" | " +
						depCell +
						" | " +
						fmtN(item.calls) +
						" | " +
						fmtT(item.lastUsed) +
						" |",
				);
			}
			lines.push("");
			const unusedSized = sized.filter((item) => !(item.calls > 0));
			if (unusedSized.length > 0) {
				lines.push("> 其中**从未被调用**的 " + unusedSized.length + " 条合计 **" + formatBytes(unusedSized.reduce((sum, item) => sum + sizeOfItem(item).bytes, 0)) + "** —— 这是清理决策的起点，但别只看调用 0（有的插件只在特定任务里用；另有「仅子代理」与「报错率」两档可交叉看）。");
				lines.push("");
			}
			/* R9：体积最大的那批里常混着"别人依赖的运行时"（本机 @dsh-ops/*-win32-x64 约 600 MB），
			   它们删了会连带弄坏别的插件 —— 这一行就是给清理决策踩刹车的。 */
			const depMeta = this.catalog?.dependencyMeta || null;
			const orphanSized = sized.filter((item) => item.orphanHint);
			if (orphanSized.length > 0) {
				lines.push(
					"> **无人依赖的候选 " +
						orphanSized.length +
						" 条 / " +
						formatBytes(orphanSized.reduce((sum, item) => sum + sizeOfItem(item).bytes, 0)) +
						"**：profile 里 " +
						(depMeta?.scanned || 0) +
						" 个 package.json 都没有声明依赖它们（嵌套目录只展开了一层）。**这是候选不是结论** —— 动之前用 `npm ls` / `pnpm why` 确认，别直接删。",
				);
				lines.push("");
			}
		}

		const uploadable = plugins.filter((item) => item.source === "self" || item.source === "hybrid");
		if (uploadable.length > 0) {
			lines.push("## 自写 / 混血（可上传）");
			lines.push("");
			lines.push("| 名称 | 版本 | 仓库 | git |");
			lines.push("|---|---|---|---|");
			for (const item of uploadable) {
				const git = item.git && item.git.hasGit ? "dirty " + (item.git.dirty ?? 0) + " / ahead " + (item.git.ahead ?? 0) : "（无 .git）";
				lines.push("| `" + item.name + "` | " + (item.version || "—") + " | " + (item.repoUrl || "—") + " | " + git + " |");
			}
			lines.push("");
		}

		const askUser = items.filter((item) => item.askUser);
		if (askUser.length > 0) {
			lines.push("## 待你标一次来源");
			lines.push("");
			for (const item of askUser) lines.push("- `" + item.name + "`（" + item.kind + "）：" + (item.sourceWhy || []).join("；").slice(0, 160));
			lines.push("");
		}

		if (skills.length > 0) {
			lines.push("## Skill");
			lines.push("");
			lines.push("| 名称 | 来源 | 调用 | 最近 | description |");
			lines.push("|---|---|---:|---|---|");
			for (const skill of skills.slice().sort((a, b) => (b.calls || 0) - (a.calls || 0))) {
				lines.push("| `" + skill.name + "` | " + skill.source + " | " + fmtN(skill.calls) + " | " + fmtT(skill.lastUsed) + " | " + (skill.hasDescription ? "有" : "**缺**") + " |");
			}
			lines.push("");
		}

		const weekly = this.weekly || {};
		if (weekly.gap || weekly.security) {
			const summarize = (report) => {
				if (!report || !report.results) return "";
				let high = 0;
				let medium = 0;
				let low = 0;
				for (const repo of report.results) {
					for (const finding of repo.findings || []) {
						if (finding.severity === "high") high += 1;
						else if (finding.severity === "medium") medium += 1;
						else low += 1;
					}
				}
				return "high " + high + " / medium " + medium + " / low " + low;
			};
			lines.push("## 每周任务最近结果");
			lines.push("");
			lines.push("- 缺口分析：" + (weekly.lastGapAt ? fmtT(weekly.lastGapAt) : "从未") + (summarize(weekly.gap) ? "（" + summarize(weekly.gap) + "）" : ""));
			lines.push("- 安全审核：" + (weekly.lastSecurityAt ? fmtT(weekly.lastSecurityAt) : "从未") + (summarize(weekly.security) ? "（" + summarize(weekly.security) + "）" : ""));
			lines.push("");
		}

		lines.push("## 口径与红线");
		lines.push("");
		lines.push("- 统计只读 `.dsh/sessions/**/session*.zstd` 的**全部帧**；同一会话的 v3+v4 双份日志按 `callId` 去重。");
		lines.push("- 落盘内容**只有**会话 ID / 昵称 / 时间戳 / 工具名 / 计数，**没有任何对话文本**。");
		lines.push("- Skill 只能统计「被加载的次数 + 最近一次时间」——机制限制。");
		lines.push("- 工具归属是推断（描述指纹 → 名字字面量 → 判宿主），可在面板手工覆盖。");
		lines.push("");

		const markdown = lines.join("\n");
		const outPath = options.path && typeof options.path === "string" ? options.path : join(this.dir, "reports", "catalog-" + stamp + ".md");
		try {
			await mkdir(join(outPath, ".."), { recursive: true });
			await writeFile(outPath, markdown, "utf8");
		} catch (error) {
			return { ok: false, error: "写报告失败：" + String(error?.message ?? error), markdown };
		}
		return {
			ok: true,
			path: outPath,
			bytes: Buffer.byteLength(markdown, "utf8"),
			summary: { plugins: plugins.length, skills: skills.length, calls: meta.calls || 0, bySource: totals.bySource, askUser: askUser.length },
			preview: markdown.slice(0, 900),
		};
	}

	/* ───────────── 设置 / 自检 ───────────── */

	/** 列全部标签（内置 + 自定义）。 */
	listTags() {
		return listTags(this.tags);
	}

	/**
	 * 冷启动兜底：目录或统计缓存还没有时，在**后台**补上，接口立刻返回。
	 * 面板首次打开走的就是这条路 —— 用户看到的是"正在算"，而不是转圈等到超时。
	 */
	async rebuildIfCold() {
		if (!this.catalog) {
			try {
				this.catalog = await buildCatalog({ dataDir: this.dir, settings: this.settings, force: false });
			} catch (error) {
				this.catalogError = String(error?.message ?? error);
			}
		}
		/* R17：冷启动也记一次（指纹没变就是空操作）—— 否则「第一条快照」要等到有人点「重新扫描」 */
		if (this.catalog) await this.recordSnapshot().catch(() => {});
		if (!this.aggregate) this.refreshStatsInBackground();
		return this;
	}

	/** 后台起一次统计重算（已有一个在跑就复用）。 */
	refreshStatsInBackground() {
		if (this.job && (this.job.kind === "stats" || this.job.kind === "weekly-gap")) return { started: false, reason: "已有任务在跑：" + this.job.kind };
		const started = this.startJob("stats", async () => await this.refreshStats({}));
		return started;
	}

	async updateSettings(patch) {
		this.settings = await saveSettings(this.dir, patch, this.settings);
		return this.settings;
	}

	/**
	 * 自检：**回答"现在是什么状态、卡在哪"**，而不是只报 ok。
	 */
	async health() {
		const build = await buildStamp(true);
		const versions = await hostVersions(true);
		const tools = this.toolSchemas().map((schema) => schema.name);
		const own = tools.filter((name) => String(name).startsWith("catalog_"));
		/* R19：确认窗口与正文哈希覆盖率 —— health 要能回答「变化追踪现在到底还看不看得见东西」 */
		const ack = await this.loadAck();
		const sinceAck = await this.sinceAckSummary();
		const skills = this.catalog?.skills || [];
		return {
			ok: true,
			build,
			/* R18：**运行中**的版本（模块加载时定格）。与 build（磁盘）不一致 = 改了代码还没重载 ——
			   新工具、新路由这时根本不存在，可面板上的 build 标签读的是磁盘，看不出来。 */
			loaded: { version: LOADED_VERSION, at: LOADED_AT, stale: isStaleBuild(build, LOADED_VERSION), disk: String(build?.version || "") },
			host: versions,
			profileDir: profileDir(),
			workspace: this.workspace,
			dataDir: this.dir,
			/* ★ asar 读不到时「官方」会静默变成 0 个 —— 那看起来像"本机没有官方插件"，
			   其实是宿主安装路径没解析出来。所以把这件事显式报出来。 */
			asar: { path: asarPath(), mode: asarMode(asarPath()), reachable: asarMode(asarPath()) !== "none" },
			toolSchemas: tools.length,
			ownTools: own,
			toolsRegistered: own.length,
			catalog: this.catalog?.counts || null,
			/* R19：Skill 正文哈希覆盖率。0/N 意味着变化追踪看不见任何正文改动（旧缓存 / 读不到文件） */
			skillHashes: { total: skills.length, hashed: skills.filter((skill) => skill.contentHash).length },
			stats: this.statsMeta ? { sessions: this.statsMeta.sessions, calls: this.statsMeta.calls, builtAt: this.statsMeta.builtAt, windowDays: this.statsMeta.windowDays, durationMs: this.statsMeta.durationMs, duplicateCalls: this.statsMeta.duplicateCalls, truncatedSessions: this.statsMeta.truncatedSessions || 0 } : null,
			attribution: this.attrib.stats || null,
			/* 体积：量过没有、多少条、合计多大（面板「量体积」与 /refresh sizes 都写这份） */
			sizes: this.sizes
				? {
						count: Number(this.sizes.count) || 0,
						totalBytes: Number(this.sizes.totalBytes) || 0,
						at: Number(this.sizes.at) || 0,
						version: Number(this.sizes.version) || 0,
						truncated: Object.values(this.sizes.byId || {}).filter((size) => size && size.truncated).length,
					}
				: null,
			/* 依赖图：谁被谁带进来（R9；「删这个会不会弄坏别人」的唯一依据） */
			dependency: this.catalog?.dependencyMeta || null,
			job: this.jobSnapshot(),
			preflight: this.lastPreflight,
			/* R14：处置清单有没有算过 / 结论多少组多少体积（health 只给摘要） */
			uninstall: this.lastUninstall
				? {
						at: this.lastUninstall.at,
						dirCandidates: this.lastUninstall.dormant?.dirCandidates || 0,
						groups: this.lastUninstall.dormant?.groups || 0,
						reclaimBytes: this.lastUninstall.dormant?.reclaimBytes || 0,
						savedTo: this.lastUninstallSavedTo || "",
					}
				: null,
			weekly: { lastGapAt: this.weekly?.lastGapAt || 0, lastSecurityAt: this.weekly?.lastSecurityAt || 0 },
			/* R17：变化追踪。没有第二条快照时 counts 全 0 + first:true —— 别把"还没有历史"说成"没变化"。 */
			changes: this.changes
				? {
						at: this.changes.at,
						baselineAt: this.changes.baselineAt,
						first: Boolean(this.changes.first),
						counts: this.changes.counts,
						snapshots: (this.historyCache?.snapshots || []).length,
						file: this.historyFile(),
					}
				: null,
			/* R19：「已看过」基线。没有就 null —— "没标记过"与"0 处变化"是两件事。 */
			ack: ack
				? {
						at: Number(ack.at) || 0,
						entries: Number(ack.snapshot.count) || 0,
						since: sinceAck ? sinceAck.counts : null,
						file: this.ackFile(),
					}
				: null,
			ai: { model: this.settings.aiModel, available: Boolean(readService(this.ctx, "llm")?.stream) },
			warnings: drainWarnings(),
		};
	}
}

/** 计划项的公开视图（去掉内部字段；扫描只给掩码片段）。 */
function publicPlanItem(item) {
	return {
		kind: item.kind,
		id: item.id,
		name: item.name,
		displayName: item.displayName,
		source: item.source,
		repo: item.repo,
		visibility: item.visibility,
		action: item.action,
		reasons: item.reasons,
		localHead: item.localHead,
		remoteExists: item.remoteExists,
		readme: item.readme,
		skills: item.skills || null,
		scan: item.scan ? { files: item.scan.files, worst: item.scan.worst, hits: item.scan.hits.slice(0, 60) } : null,
		error: item.error || "",
	};
}

function loadSettingsDefaults() {
	return JSON.parse(JSON.stringify(DEFAULTS));
}
