/**
 * dev/probe-export.mjs — 用**真实数据目录**跑一次 catalog_export，产物落 `reports/`。
 *
 * 用途：换会话前生成一份"现在是什么状态"的 Markdown 快照，交给下一次会话或直接存档。
 * 只读缓存 + 写一份报告文件，不改任何插件、不联网、不调模型。
 */

import { CatalogService } from "../lib/service.mjs";
import { dataDir as dataDirOf } from "../lib/hostinfo.js";

const service = new CatalogService({ ctx: { get: () => null }, toolSchemas: () => [] });
await service.init();

const result = await service.exportReport({ top: 25 });
if (!result.ok) {
	console.log("导出失败：", result.error);
	process.exit(1);
}
console.log("报告路径:", result.path);
console.log("体积:", (result.bytes / 1024).toFixed(1), "KB");
console.log("摘要:", JSON.stringify(result.summary));
console.log("");
console.log("── 前 40 行 ──");
console.log(result.preview.split("\n").slice(0, 40).join("\n"));
