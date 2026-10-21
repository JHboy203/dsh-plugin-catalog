/**
 * settings.mjs — 设置层（默认值冻结 + 白名单夹取）。
 *
 * 三条纪律（照 `dsh-plugin-installer/lib/settings.js` 的四条硬规则取前三条）：
 *   1. **默认值 = 现状**，而且冻结成快照：`FROZEN_DEFAULTS` 深比较，
 *      有人改了默认值，dev/audit.mjs 会当场红；
 *   2. 只认**白名单**：未知键丢弃、非法值回退默认、数值落回合法区间；
 *   3. 写盘失败不抛 —— 设置写不进去不该让面板挂掉。
 *
 * @module dsh-plugin-catalog/settings
 */

import { join } from "node:path";
import { readJson, writeJson } from "./store.mjs";

export const SETTINGS_VERSION = 1;

export const DEFAULTS = Object.freeze({
	/* 统计窗口：至少 90 天（用户要求），允许调大 */
	windowDays: 90,
	/* 目录/插件清单缓存时长（秒） */
	catalogTtlSeconds: 300,
	/* 统计缓存超过多少小时提示"建议刷新" */
	statsStaleHours: 24,
	/* 审核与翻译统一用的模型 */
	aiModel: Object.freeze({ provider: "deepseek-official", model: "deepseek-flash" }),
	/* 认为"本人"的 GitHub 账号（判自写与混血都要它） */
	selfOwners: Object.freeze(["JHboy203"]),
	/* 工作区（空 = 自动推断） */
	workspace: "",
	/* gh 可执行文件（空 = 自动定位） */
	ghBin: "",
	/* 自写 Skill 集合仓 */
	skillsRepo: "my-dsh-skills",
	/* 集合仓暂存目录（空 = <workspace>/.gh-upload/my-dsh-skills） */
	skillsStageDir: "",
	/* 提交身份（空 = 用 git 全局配置） */
	gitIdentity: Object.freeze({ name: "", email: "" }),
	/* 每周任务：缺口分析自动跑，安全审核手动点（用户选定） */
	weeklyGapAuto: true,
	weeklySecurityAuto: false,
	/* 会话列表分页 */
	sessionsPageSize: 20,
	pageSizes: Object.freeze([10, 20, 50, 100]),
	/* 隐藏 .bak-* 迁移残留 skill */
	hideBackupSkills: true,
	/* 公开仓：**这个开关永远不默认 true**，且单独一次操作才用 */
	allowPublic: false,
});

/** 冻结快照（audit 用；改动 DEFAULTS 会被抓出来）。 */
export const FROZEN_DEFAULTS = JSON.stringify(DEFAULTS);

export function settingsFile(dataDir) {
	return join(dataDir, "settings.json");
}

const clampInt = (value, min, max, fallback) => {
	const number = Number(value);
	if (!Number.isFinite(number)) return fallback;
	return Math.min(max, Math.max(min, Math.round(number)));
};

const str = (value, fallback = "") => (typeof value === "string" ? value : fallback);

const bool = (value, fallback) => (typeof value === "boolean" ? value : fallback);

const strArray = (value, fallback) => {
	if (!Array.isArray(value)) return [...fallback];
	const list = value.map((item) => String(item).trim()).filter((item) => item !== "");
	return list.length > 0 ? [...new Set(list)] : [...fallback];
};

/**
 * 归一化：白名单 + 夹取。**不认识的一律丢掉**。
 * @param {object} input
 * @returns {object}
 */
export function normalizeSettings(input) {
	const raw = input && typeof input === "object" ? input : {};
	const model = raw.aiModel && typeof raw.aiModel === "object" ? raw.aiModel : {};
	const identity = raw.gitIdentity && typeof raw.gitIdentity === "object" ? raw.gitIdentity : {};
	return {
		/* ★ 非正数视为非法而不是"夹到 1 天"：夹到 1 天会让面板看起来"一个调用都没有"，
		   那种静默降级比直接报错更难查。 */
		windowDays: Number(raw.windowDays) > 0 ? clampInt(raw.windowDays, 1, 3650, DEFAULTS.windowDays) : DEFAULTS.windowDays,
		catalogTtlSeconds: clampInt(raw.catalogTtlSeconds, 0, 86400, DEFAULTS.catalogTtlSeconds),
		statsStaleHours: clampInt(raw.statsStaleHours, 1, 24 * 30, DEFAULTS.statsStaleHours),
		aiModel: {
			provider: str(model.provider, DEFAULTS.aiModel.provider).trim() || DEFAULTS.aiModel.provider,
			model: str(model.model, DEFAULTS.aiModel.model).trim() || DEFAULTS.aiModel.model,
		},
		selfOwners: strArray(raw.selfOwners, DEFAULTS.selfOwners),
		workspace: str(raw.workspace, "").trim(),
		ghBin: str(raw.ghBin, "").trim(),
		skillsRepo: str(raw.skillsRepo, DEFAULTS.skillsRepo).trim() || DEFAULTS.skillsRepo,
		skillsStageDir: str(raw.skillsStageDir, "").trim(),
		gitIdentity: { name: str(identity.name, "").trim(), email: str(identity.email, "").trim() },
		weeklyGapAuto: bool(raw.weeklyGapAuto, DEFAULTS.weeklyGapAuto),
		weeklySecurityAuto: bool(raw.weeklySecurityAuto, DEFAULTS.weeklySecurityAuto),
		sessionsPageSize: clampInt(raw.sessionsPageSize, 5, 200, DEFAULTS.sessionsPageSize),
		pageSizes: Array.isArray(raw.pageSizes) && raw.pageSizes.length > 0
			? [...new Set(raw.pageSizes.map((n) => clampInt(n, 5, 500, 20)))].sort((a, b) => a - b)
			: [...DEFAULTS.pageSizes],
		hideBackupSkills: bool(raw.hideBackupSkills, DEFAULTS.hideBackupSkills),
		allowPublic: false,
	};
}

/** 读设置（文件不存在/坏掉都用默认值）。 */
export async function loadSettings(dataDir) {
	const raw = await readJson(settingsFile(dataDir), null);
	if (!raw || raw.version !== SETTINGS_VERSION) return normalizeSettings({});
	return normalizeSettings(raw.settings);
}

/** 写设置（先归一化；失败只返回当前值，不抛）。 */
export async function saveSettings(dataDir, patch, current) {
	const merged = { ...current, ...(patch && typeof patch === "object" ? patch : {}) };
	if (patch && patch.gitIdentity && typeof patch.gitIdentity === "object") merged.gitIdentity = { ...current.gitIdentity, ...patch.gitIdentity };
	if (patch && patch.aiModel && typeof patch.aiModel === "object") merged.aiModel = { ...current.aiModel, ...patch.aiModel };
	const normalized = normalizeSettings(merged);
	try {
		await writeJson(settingsFile(dataDir), { version: SETTINGS_VERSION, settings: normalized, savedAt: Date.now() });
	} catch {
		/* 写不进去不该让面板挂掉 */
	}
	return normalized;
}

/** 技能集合仓暂存目录：设置优先，否则工作区约定位置。 */
export function skillsStageDirOf(settings, workspace) {
	if (settings.skillsStageDir) return settings.skillsStageDir;
	if (!workspace) return "";
	return join(workspace, ".gh-upload", settings.skillsRepo);
}
