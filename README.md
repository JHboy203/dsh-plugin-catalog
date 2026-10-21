# dsh-plugin-catalog · 插件目录面板

DSH 侧栏「插件目录」：把本机的 **插件与 Skill** 摊成卡片，按来源四分类（官方 / 自写 / 第三方 / 混血），
用**会话事件日志**统计最近 90 天每个工具的调用次数、报错、耗时与涉及会话（子代理单独标出），
支持自定义标签 + AI 分类、每周缺口分析与安全审核、以及自写/混血的一键私有备份到 GitHub。

> **官方插件入口保留不隐藏。** 本插件是**独立的客户端插件**：禁用它即恢复官方界面（见文末「自救」）。
>
> 内嵌的审核/发布 Agent **同时注册为工具**（`catalog_*`），普通会话里一句话就能调起：
> 「审一遍 dsh-screenshot」「开放 dsh-catalog 仓」「列出我的自写插件」。

---

## 适用 profile

- `desktop`（本机实测环境：DSH `0.2.x`，Windows）
- 任何带 `tools` 与 `webServer` 服务的 profile 都可用（客户端半边是标准 `web` 平台 bundle）
- 依赖宿主的 `llm` 服务（AI 分类 / 翻译 / 审核）；没有它时面板仍可用，只是这些按钮会报「AI 通道不可用」

## 安装

从本地目录安装（**不要用 pnpm**，它会给 profile 埋一份陈旧的 `@deepseek-ai/dsh-tools`，
导致下次启动插件批量加载失败）：

```bash
node .tools/dsh-plugin-install.cjs install dsh-plugin-catalog "<插件目录>"
```

装完**必须完全重启 DSH**（`dsh.profile.bundles` 与 `cordis.patch.yml` 都是启动期读的）。

装完检查一下有没有埋雷：

```bash
node .tools/dsh_doctor.py            # 只体检
node .tools/dsh_doctor.py --fix      # 有 dsh-tools 覆盖就移走
```

## 用法

### 面板

侧栏出现「插件目录」图标（`sidebar.panellist` id = `catalog`）。点开是：

- **卡片**：名称、中文简介（英文原文小字附后）、来源徽章、标签、创建/下载时间、调用总次数（含子代理拆分）
- **搜索**：按名称 / 简介 / 判定依据过滤
- **筛选**：来源（全部/官方/自写/第三方/混血/待标记）× 类型（全部/插件/Skill）
- **排序**：调用次数 / 最近使用 / 时间 / 名称
- **浮窗**（点卡片，屏幕居中，点外部或 Esc 关闭）：
  - 每个工具各自的调用次数、报错、平均耗时、最近一次、涉及会话数
  - 会话列表：**会话昵称** + 次数 + 是否子代理（含父会话名），可分页、每页条数可选（10/20/50/100）
  - 来源判定依据（逐条列出为什么这么判）、标签编辑、创建时间、仓库链接
  - 自写/混血额外有「上传 / 更新到 GitHub」「缺口分析」
  - 判错来源可以手工标一次（存进 `.dsh-plugin-catalog/overrides.json`，之后不再问）

### 工具（同一套能力，普通会话里直接调）

| 工具 | 一句话 |
|---|---|
| `catalog_list` | 列出所有插件与 Skill（可按来源/类型/关键字过滤） |
| `catalog_stats` | 全局概览，或某个条目的分工具明细 + 会话列表 |
| `catalog_tag` | 列标签 / 打标签 / 新增自定义标签（必须给解释）/ 删标签 / **手工改来源**（`action=source`）/ **手工改工具归属**（`action=tool-owner`） |
| `catalog_classify` | AI 自动打标签（会读自定义标签的解释） |
| `catalog_review` | 审一遍某个插件（缺口分析 + 安全审核，只出建议） |
| `catalog_publish` | 上传备份：`plan` → `apply`（需 `planId` + `confirm`，可带 `ackRepos`）→ `public`（独立门禁） |
| `catalog_export` | **导出 Markdown 快照**到 `<数据目录>/reports/`：清单、来源分布、调用 Top、仓库与 git 状态、待标记来源、归属覆盖率、每周发现 |
| `catalog_health` | 自检：跑的是哪一版、路径解析、统计覆盖、归属覆盖率、AI 通道、asar 模式 |

## 数据与隐私

全部落在**工作区** `.dsh-plugin-catalog/`（不写插件安装目录 —— 升级/重装即丢）：

| 文件 | 内容 |
|---|---|
| `cache/stats.json` | 90 天调用统计（按会话分片，便于增量刷新） |
| `cache/catalog.json` | 插件/Skill 快照（来源判定、时间、仓库） |
| `cache/attrib.json` | 工具→插件归属索引 |
| `tags.json` | 自定义标签（含解释）与每个条目的标签 |
| `overrides.json` | 你手工标过的来源与工具归属 |
| `intros.json` | 中文简介缓存（可手改） |
| `weekly.json` | 每周任务上次执行时间与结果 |
| `settings.json` | 设置 |

**红线：统计里只有会话 ID、会话昵称、时间戳、工具名、计数。没有任何对话文本。**
工具参数只在解析 `skill` 调用取技能名时被读一次，随后丢弃。

统计口径：

- 只读 `.dsh/sessions/**/session*.zstd`，**绝不扫** `.dsh/dsh-checkpoint-rewind/` 那类百万文件级快照目录。
- 一个会话可能同时有 v3 与 v4 两份日志（本机 772 个会话里 36 个如此），按 **callId 去重**，不会把调用算两遍。
- 首次打开前台不等：先显示缓存，后台算（本机 811 个日志 / 455 MB / 59,813 次调用，全量约 **40~60 秒**）；
  之后走缓存，**增量刷新约 0.5 秒**。
- 缓存超过 24 小时会在界面上提示「建议刷新」，不会自动重算（避免你以为卡了）。

## 来源四分类怎么判

| 来源 | 判据（文件系统事实，不看人设） |
|---|---|
| 官方 | `@deepseek-ai/*` 作用域；或 `dsh.profile.bundles` 里声明、代码在宿主 `app.asar` 内 |
| 自写 | ① profile 里那个条目是 **junction/symlink** 且真实路径在工作区（实测 22 个）② 或 `package.json` 的 `author` 命中本人账号 ③ 或真实路径在工作区 `DSH-Plugin/`、`.gh-upload/` 下 |
| 第三方 | 其余 |
| 混血 | 上面任一基础上，**有 `.git` + origin 指向非本人仓 + 能比出差异**（工作区脏，或本地领先上游 commit） |

Skill 的「自写」判据是：`.gh-upload/my-dsh-skills/`（自写集合仓）里有同名目录。

**诚实的边界**：npm 装进来后被**就地改过**的包，本工具**无法自动判定** —— node_modules 里没有 `.git`，
也没有发布包的哈希可比。这类会标「待确认」或需要你手工标一次；标完存在 `overrides.json`，不再问。

## 用在哪里（与本机其它插件的关系）

- 工具归属是**推断**的：`ctx.tools.schemas()` 只给 name/description/parameters，宿主**没有**工具→插件的登记表
  （`ToolService` 按 agent scope 分 layers，与插件无关）。所以用两条证据链：
  ① description 指纹（那段描述逐字来自注册它的插件源码，唯一命中即归它）；
  ② 无 description 时退到 `name: '<tool>'` 字面量（弱证据）。
  有描述却哪儿都找不到 ⇒ 判为**宿主核心/官方**，面板**单列**，不算进任何插件卡片。
- **实测覆盖率（本机 196 个工具 / 53,759 次调用）**：描述指纹 193 个（**85.2% 的调用量**）、
  名字字面量 1 个、判为宿主 2 个（`plugin_manager` / `exit_plan_mode`）、**歧义 0、未归属 0**。
  所以卡片上的「调用总次数」是按真实归属累加的，不是按名字猜的。
  ⚠️ 关键细节：插件源码里的 description 常被**多行字符串拼接**切开，直接拿拼好的句子去源码里找
  会永远找不到（一开始就是这么把一堆自写插件误判成"宿主"的）。所以两边都**压平**（去空白/引号/加号/转义）
  再比，`dev/audit.mjs` 里有针对拼接与转义 `\n` 的回归用例。
- 官方工具包在 `app.asar` 内（77 个 `dsh-tool-*`），会按 asar 索引读出来参与归属判定 —— 否则
  65% 的调用量会挂在一句「未知来源」上。
  ⚠️ Electron 把 `app.asar` **当目录**，`openSync` 打开归档本身会失败；`lib/asar.mjs` 自动区分
  「virtual 模式（宿主里，走成员路径）」与「header 模式（纯 node）」，`/health` 会报当前模式。

## 发布到 GitHub（自写 / 混血）

一个总按钮：「上传备份到 GitHub」→ **先出计划**（不动任何东西）→ 你确认后才推。

- 命名：自写 `dsh-<name>`；混血 `dsh-<name>-local`（不覆盖原仓）
- **所有仓默认私有**，全插件只有一处建仓且写死 `--private`
- **不 force push**（`lib/gitops.mjs` 里没有 `--force` 这条路径）
- **密钥命中即停**：扫 `.env`、`.env.*`、`secrets/`、`*.key`、`*.pem`、`configs/*-secret.json`、
  `configs/*-config.json` 与常见 token/私钥/连接串模式；命中 critical/high 的仓**跳过**、其余照推，
  最后给「未推清单」。清单只给「文件:行 + 规则 + 掩码 + 一句判断」，**不回显明文**。
- README 中英两版：英文版由 AI 按规范翻译（章节一一对应、专有名词保留原文、代码块与占位符原样、
  「待补充」→ `TBD`）；**没有需要补英文的内容就不生成**（英文 README、正文过少、只有「待补充」骨架都不生成）。
- 公开是**独立的一次操作**（`catalog_publish action=public`）：必须 `confirm:true`，且**先重扫一遍**，
  有命中直接拒绝。

## 每周任务

打开面板时若距上次超过 7 天，**后台**跑一次缺口分析（不阻塞界面）。
安全审核 **不自动跑** —— 面板上会显示「安全审核（已到期）」按钮，由你点（它要读源码片段，更贵也更需要你在场）。

- 缺口分析维度：README 缺哪些关键章节、构建产物该不该入库、`package.json` 有无自包含安装命令、
  有没有把**宿主核心包**误写进 `dependencies`（会遮蔽宿主、导致插件批量加载失败）、Skill 的 `description` 够不够用
- 安全审核维度：`pull_request_target` / `workflow_run` 是否检出并执行 fork 代码、`GITHUB_TOKEN` 是否最小权限、
  可疑 `eval` / 拼接执行的 `spawn`、依赖线索。按「文件 + 行号」给发现，按置信度排序，每条附「可采纳 / 可拒绝」

## 已知限制（如实说明，不夸大）

1. **私有仓拿不到平台级安全扫描**：GitHub 的 Secret Scanning / Dependabot / Push Protection 需要付费 GHAS。
   所以「依赖已知高危」只能靠本地规则与模型常识，**准确度低于平台级扫描**。
2. **Skill 的调用统计只能到「次数 + 最近一次时间」**，无法细分到会话 —— 这是机制限制，界面上有标注。
3. **个人免费账户的私有仓没有「只读分享」档位**：要么私有（仅本人/受邀协作者），要么公开（所有人可读）。
   需要精细权限得建 Organization。
4. **工具归属是推断**，但实测覆盖率很高（196 个工具里 193 个靠描述指纹唯一命中，覆盖 85.2% 的调用量；
   歧义 0、未归属 0）。剩下 2 个判为宿主核心（`plugin_manager` / `exit_plan_mode`），
   仍可在面板手工指定工具归属覆盖。
5. **星标/下载量等生态数据不采集**（本插件不联网，只读本机事实）。

## 排错：插件装了、面板也出来了，但没有工具/路由

这是本插件真实踩过一次的故障形态，**先按这个顺序查**：

1. `plugin_manager action=list_plugins`（或工具 `plugin_diagnose`）看 `include:plugin-catalog` 的
   **`fiberPhase`**：
   - `active` = 正常；
   - `failed` = `apply()` 抛了（这时**客户端半边通常照常渲染**，因为 client bundle 与 host 半边
     是两条加载路径 —— 别被"图标在"骗了）；
   - `null` = 没被启用。
2. 拿错误原文：`plugin_manager action=set_plugin target=include:plugin-catalog enabled=true`
   —— 回包的 `diagnostic` 里直接写 `TypeError: ...`。
3. 看 `<数据目录>/logs/apply-trace.log`（**每次 apply 的分步留痕**：走到哪一步一目了然）
   与 `apply-error.json`（只有初始化失败才会写）。
4. 端到端确认路由活没活：在 GUI 控制台或 `client_eval` 里
   `fetch('/plugin-catalog/health').then(r=>r.json())` —— 正常应返回 200 与构建标记；
   404 空体说明路由没注册（对比：`/plugin-installer/health` 应恒为 200）。

**已知导致 `failed` 的两种形态**（都在真机上踩过，按"最贵"排序）：

1. **`apply` 是 async 却 `return` 了值** ← 真正的元凶，隐蔽度最高。
   cordis 的 `Fiber._execute()` 把 apply 的返回值当成 **effect disposer** 收 ——
   `safeCollect`：不是 function 又不是 null/undefined 就 `throw TypeError("Invalid effect")`，
   而 async apply 走的是 `effect.then(safeCollect)`。于是**整段 apply 全部成功**
   （工具注册了、路由挂了、后台任务也起来了）之后，promise 一 resolve 就抛，
   `_reload` 的 catch 把 fiber 标成 INACTIVE → **已注册的工具与路由被整体回滚**。
   症状：`apply-trace.log` 里每一步都是 OK，却"did not activate"，工具全无、路由 404，
   而且宿主只写 console 不写日志文件。
   → **async apply 一律 `return;`**；要暴露服务请走 ctx，不要走返回值。
2. `ctx.effect(...)` 建议在 `apply()` 的**同步阶段**注册（本插件把 cleanup 放在第一行，
   用可变变量收集路由/工具的 disposer）。这条是**防御性约定** —— 真机上 `Invalid effect`
   的实证原因见上一条，别只盯 effect 时序。

另一类同样静默的坑：**直接读 `ctx.xxx` 但没在 `inject` 里声明**。cordis 的上下文是 Proxy，
会抛 `cannot get property "llm" without inject`（可选链 `ctx?.llm` 救不了，throw 发生在 get 陷阱里）。
读可选服务一律用 `ctx.get(name)`（cordis 注释原文：*Read a service from the store without the
inject requirement*），本插件的 `lib/ai.mjs::readService()` 就是这么做的。

## 自救（界面出问题时）

本插件是**独立客户端插件**，禁用即回官方界面：

- 在 profile 的 `package.json` 里从 `dsh.profile.bundles` 去掉 `"dsh-plugin-catalog"`，重启 DSH；
- 或者用插件安装面板把它停用。

它**不隐藏也不改动官方插件入口**：官方「插件」页仍在 `sidebar.panellist` 原位置，本站只是**新加**一项。

## 自检

```bash
node dev/audit.mjs         # 自洽：默认值冻结/工具契约/规则覆盖/去重/命名/门禁/双语 README 流程（172 项，沙箱可跑）
node dev/render-check.cjs  # 界面：卡片内容/搜索排序/浮窗/分页/计划浮窗/空态（65 项，无需 DSH）
node dev/preview.mjs       # 版式：生成静态预览（真实组件树 + 真实 CSS），供浏览器截图看
```

宿主侧（不需要重启 DSH）：

```bash
node dev/hosttest.mjs      # 假 ctx 真跑 apply()：路由 / 工具契约 / 统计 / 标签 / AI 路径 / 门禁 / effect 同步约束 / async apply 返回值校验（86 项）
node dev/probe-gitops.mjs  # 在临时仓真跑 init/commit/push 失败/ignore（23 项，不碰真实仓、不联网）
node dev/probe-asar.mjs    # 官方插件能不能从 app.asar 读出来（Electron 的 asar 是"目录"）
node dev/measure-attrib.mjs  # 用真实工具 schema 量归属覆盖率
node dev/probe-publish.mjs   # 只读预演上传计划（不建仓、不提交、不推送）
node dev/probe-export.mjs    # 用真实数据导出一份 Markdown 快照到 reports/
node dev/probe-init.mjs      # 量启动成本（init/state/entryDetail 的毫秒数）
node dev/warm-cache.mjs      # 预热真实数据目录，让第一次打开就有数据
```

`dev/preview.mjs` 为什么存在：无头自检只能验结构/文案，验不了**版式**（浮窗是否居中、
卡片网格会不会被挤成一列、窄卡片里徽章是否溢出）。它把组件树序列化成 HTML 并注入同一份 CSS，
用任意静态服务器打开即可截图；本机实测用它抓到过「纯文本里漏出 markdown 星号」这种只在渲染后可见的问题。

`dev/probe-gitops.mjs` 为什么存在：上传是最难在沙箱里验的一段（子进程 spawn 被禁），
而真实仓不能拿来试 —— 所以在临时仓里真跑一遍，涵盖「还没第一次提交的新仓」这种边界。

## 许可证

MIT。
