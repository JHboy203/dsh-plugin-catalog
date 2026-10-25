# dsh-plugin-catalog · 插件目录面板

[English](README.en.md)


DSH 侧栏「插件目录」：把本机的 **插件与 Skill** 摊成卡片，按来源四分类（官方 / 自写 / 第三方 / 混血），
用**会话事件日志**统计最近 90 天每个工具的调用次数、报错、耗时与涉及会话（子代理单独标出），
支持自定义标签 + AI 分类、每周缺口分析与安全审核、以及自写/混血的一键私有备份到 GitHub。

> **官方插件入口保留不隐藏。** 本插件是**独立的客户端插件**：禁用它即恢复官方界面（见文末「自救」）。
>
> 内嵌的审核/发布 Agent **同时注册为工具**（`catalog_*`，共 9 个），普通会话里一句话就能调起：
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

- **卡片**：名称、简介（中文优先，没有中文就直接拿英文当正文，不再每张顶一行占位提示）、来源徽章、标签、创建/下载时间、调用总次数（含子代理拆分）；有报错的条目多一枚红色「报错 N」chip（悬停看错误率），从未调用过的次数置灰
- **搜索**：名称 / 简介 / 判定依据，**以及工具名** —— 输入 `acp_status`、`catalog_export` 这类工具名能直接定位到提供它的插件（命中时卡片上会显示「工具：xxx」）
- **洞察条**：「全部 / 有调用 / 未使用 / 有报错 / **仅子代理**」五个 chip 直接给条数，点一下就是筛选（计数为 0 的档位**置灰但保留** —— 看得见"这台机器上没有这种人"，点开是空态 + 说明书）。每个 chip 悬停有一句解释，数字只随**来源 / 类型**变，不随关键词跳 —— 否则点开「未使用」后数字自己变成 0，看起来像数据丢了。「仅子代理」= 每一次调用都发生在子代理会话里：**删掉它不会当场报错，只会让某条委派链下次跑的时候悄悄变差**
- **筛选**：来源（全部/官方/自写/第三方/混血/待标记）× 类型（全部/插件/Skill）
- **排序**：调用次数 / **报错次数** / **报错率** / **体积** / 最近使用 / 时间 / 名称
  （报错率比次数更能看出毛病：本机实测 `@liustack/modlens` 6 次调用全报错 = 100%，而 `dsh-vision-router` 报错 23 次却没进前四 —— 252 次调用里只占 9%）
- **视图记忆**：筛选 / 搜索词 / 排序 / 页码 / 每页条数 / **滚动位置**存在 localStorage，改客户端代码触发的热重载、或刷新页面之后，回来还是刚才那一屏；换筛选或换页会自动回顶部（否则第 2 页的第一条会落在屏幕外）。存储被禁用、或数据损坏时安静退回默认视图，不会白屏
- **多选批次**：工具条「选择」进入选择模式，点卡片即选中（再点取消），被选中的卡有蓝框 + 勾徽章。批次条实时显示**已选 N 条 · 约 X MB**（体积一次性批量问，服务端并发 4；没有独立目录的 Skill 会如实标「N 条没有独立目录，按 0 计」），可「导出选中」「**打标**」「选中当前 N 条」「清空」。**选中项跨筛选保留**（未使用里挑几个、有报错里再挑几个，凑成一批），但**不进 localStorage** —— 重载后清空是故意的，免得半个批次被忘在那里
- **批量打标（三态）**：批次条「打标」打开浮层，一次给这批条目加上/去掉 purpose 与 context 标签。每个标签显示**这批里几个已经有它**（`n/N`）：
  **全都有 → 实心，点一下＝全部去掉（`−`）**；部分有 → 虚线；都没有 → 空态，点一下＝给缺的补上（`＋`）；
  还没点之前 `title` 就写明"点一下会发生什么"。只改你点过的标签，**不会清掉条目各自已有的其它标签**（与浮窗里"整条替换"是两种语义，刻意分开）；
  勾选只是本地意图，点「应用」才发**一次**请求 —— 中途失败不会留下半个批次。打过的条目记为手标，AI 自动分类不再覆盖
- **标签筛选**：工具条下有一行标签（只在某个标签真的有条目在用时才出现），每个 chip 带命中条数。
  **同维度多选＝或**（做截图 或 做媒体），**跨维度＝且**（再叠 用在 Web GUI）。点 chip 即筛，右侧「清除标签」只清标签、不动其它筛选条件
- **导出这一屏**：工具条右侧「导出这 N 条」把**当前筛选结果**（顺序就是屏幕顺序，含筛选条件、报错率、安装位置）写成 `reports/catalog-filtered-<时间戳>.md`，路径可一键复制；0 条时按钮禁用。要完整快照（来源分布、调用 Top、归属覆盖率）仍用 `catalog_export`
- **也能导成 CSV（R28）**：同一个按钮旁边还有一个「CSV」—— 同一屏、同一批筛选，只换格式：一条一行、12 列（名称/类型/来源/版本/加载/调用/报错/报错率/最近一次/体积/被依赖/位置），**带 UTF-8 BOM**，Excel 直接双击打开中文不乱码。`catalog_export format=csv` 出的是**全量条目**的那份表；选中批次同样有「CSV」按钮。两种格式共用同一批数字与措辞，差别只在装饰（Markdown 有反引号与加粗，CSV 里那些都是噪音）
- **体积（一等公民）**：卡片上直接有体积 chip，能按「体积」排序，工具条显示**当前筛选结果的合计**
  （点「未使用」就立刻看到"删这批能省多少"）。数据来自后台全量快照（`cache/sizes.json`，约 1.5 秒量完 120+ 个目录；
  面板自己触发一次，头部也有「量体积 / 重量体积」按钮）。三条如实：
  - **量不到就不显示**，绝不写「0 B」—— 官方包在 `app.asar` 里（`realDir` 是虚拟成员路径，递归必然为 0），
    浮窗会说「在官方 asar 里，没有独立目录（体积记在 DSH 安装包内）」；
  - **Skill 也有自己的体积**（用 catalog 里的 `dir`，不是 skills 根目录 —— 拿错就是假警报）；
  - 超过 1.5 秒 / 2 万文件预算的条目**带「+」**，数字是下限，合计里也一样标出来。
  浮窗里仍是懒算的 `/size`（打开哪一个才算哪一个，5 分钟缓存），**绝不在目录构建里递归** ——
  71 个包逐个 du 会把面板打开从秒级拖到十秒级；统计时**不跟随 junction / 符号链接**（跟随会走出 profile 甚至成环）
- **依赖关系（谁把它带进来的 / 删它会弄坏谁）**：卡片上直接有 chip ——
  **「被 N 依赖」**（删了会连带弄坏这些包；悬停列出是谁）与 **「无人依赖」**（候选，琥珀色）。
  数据来自构建目录时扫的**全量依赖图**：profile 里每个 `package.json` 的
  `dependencies` / `optionalDependencies` / `peerDependencies`（**不只 DSH 插件**，还展开一层嵌套 `node_modules`），
  反向索引成「谁声明的它」。工具条还有「无人依赖 N」筛选，勾上只剩候选。
  - 为什么不能只看"在不在 profile 的 dependencies 里"：`@dsh-ops/bash-win32-x64`（354 MB）**两方面都占** ——
    既写在 profile 里，又被 `dsh-ops` 依赖；删了 dsh-ops 立刻坏。本机 850.6 MB 里有 **651.8 MB** 属于这种"被依赖的运行时"，
    合计的 tooltip 会单独点出来，不算可回收空间。
  - 浮窗「依赖关系」块给出三件事：直接声明在哪、被谁依赖（全名）、它自己声明依赖了谁（就是体积 Top 的来源）。
  - **「无人依赖」只是候选**：嵌套只展开一层，更深的声明可能漏读 —— 文案一律带"用 `npm ls` / `pnpm why` 确认"，绝不写成"可以删"。
- **副本同步**：面板顶部公告 + 卡片标签告诉你**「你改的那份，真的是加载的那份吗」**。
  插件比 4 个关键文件（`package.json` / `index.js` / `client.js` / `cordis.patch.yml`）的 size + mtime，Skill 比 `SKILL.md` 的 **size + mtime + 正文哈希**（R20）；
  junction 安装直接说「只有一份，改源码立即生效」；发现不同步则标「副本不同步 / 副本较旧 / 工作区较旧」，
  Skill 的 staging 副本标「staging 不同步」——**发布推的是 staging 那份，它旧了就等于发了个旧版**。
  扫描 60 秒缓存一次，重建目录会作废；Skill 正文各读一遍算 sha1（17 对 ≈ 680 KB，实测 < 10 ms）——
  **同字数改一个字也认得出**（R20 之前只比长度，这种改动会被静默判成"一致"）
- **就地处置（R11）**：Skill 的 staging 旧了**不用离开面板**——公告条上就有「同步 staging（N）」。
  点它先拿到一份**计划**（会覆盖哪几个 `SKILL.md`、方向、备份落在哪），再点「确认同步」才写盘：
  单向 `live → staging`，覆盖前把 staging 那份备份成 `SKILL.md.bak-<时间戳>`，**不会动 DSH 正在加载的那份**。
  浮窗里也有「同步这一份 → staging」。写盘闸在**服务端**（必须 `confirm:true`），所以误点一下最多出一份计划、不会改文件；
  staging 反而更新（`staging 较新`）时**不给**这个按钮 —— 那会把线上正在用的那份覆盖回旧版
- **写错了能撤销（R20）**：条目浮窗里显示「历史备份 N 份 · 最近 `<时间戳>`」，点「还原到 `<时间戳>`」先出一份
  **还原计划**（方向 `backup → staging`、覆盖谁、备份落在哪），再点「确认还原」才写盘；覆盖前把 staging 当前那份
  另存成新 `.bak`，**还原本身也能再撤销**。只动 staging，永远不碰 DSH 加载的那份；工具侧是 `catalog_skill_sync action=restore`
  - **R28：不只能还原"最近一份"** —— 确认条下面会把**更早的几份**也列出来（最近 8 份里除当前目标之外的最多 4 个），点哪一个就换成还原它、重新出计划，仍然要按「确认还原」才写盘。工具侧对应 `restore` + `backup=<时间戳 或全名>`；点名的那份不存在时**明说**「没有这份备份（现有 N 份：…）」，不会静默退回最近一份
- **会不会被加载（R12）**：`enabled`（在不在 `dsh.profile.bundles`）**不是**加载判据 ——
  `cordis.yml` / `cordis.patch.yml` 的顶层条目按 `name:` 能直接挂包，依赖链也会把包带起来。
  面板按入口算四态：`bundles` 直接启用 / 配置条目挂载 / 随某个入口（依赖链）加载 /
  **不会被加载**（三条都不沾）。卡片只给两枚 chip（`不会被加载` 灰、`配置入口` 蓝），
  浮窗写出「随 `dsh-ops` 加载」这类具体链路，工具条有「不会被加载 N」筛选 ——
  这是比「未使用」更硬的死重量判据（装了根本不会跑）。
  ⚠️ 这是**声明层面**的判据：运行时按路径 `require()` 的动态加载看不见，所以文案是「不会被加载」而不是「绝对没跑」。
- **判据能自己下结论（R13）**：`node dev/probe-loadstate.mjs` **独立重算**加载路径
  （自己扫 profile 的 `node_modules` 与两份组合文件），再和目录快照对账，钉七条不变式 ——
  计数守恒 / bundle 口径 / `via` 指得回入口 / dormant 与入口无交集 / `disabled` 不算入口 / 快照与重算一致 /
  **dormant 对加载中的声明封闭（I7）**，**破一条退出码 1**；`--json` 可机读。
  它用的是同一份判据（不是第二套规则），所以抓的是"实现与数据脱节"。
- **报告自带加载口径（R13）**：`catalog_export` 的概览多一行「**加载路径**」（入口数 + 四态），
  并单开一节「**不会被加载（N 条）**」（名称/来源/版本/体积/最近调用 + 边界说明 + 可省体积）；
  当前筛选清单（`exportFiltered`）多一列「**加载**」。清单拿出去不用再自己算。
- **不会被加载 → 怎么卸干净（R14）**：工具条上「不会被加载 N」的旁边有**「处置清单」**。
  点它（或调 `catalog_uninstall action=plan`）会按**弱连通分量**分组给出可执行清单，
  因为那 26 个目录**不是同一种东西**，处置方式完全相反：

  | 分类 | 本机实例 | 处置 |
  |---|---|---|
  | 实体目录·**被钉住** | `dsh-mnemon`（`^0.5.32`）、`dsh-chat-import`、`dsh-plugin-video-player`（`github:`） | 只删目录没用：`profile/package.json` 里还钉着，**下次 `pnpm install` 会装回来** —— 必须连那行一起摘 |
  | 实体目录 | `dsh-mnemon` 的 18 个子包、`fflate`、`markdown-to-jsx`… | 删了就没了（但同一组要一起删，见下） |
  | **链接→工作区** | `dpi-probe-bundle`、`dsh-toolfold` | 删 junction **一字节都不省**，空间在工作区源码 —— 默认建议**留着** |
  | **同项目第二份** | `ghbackup`（包名 `dsh-github-backup`，`bundles` 里加载的是另一份） | 删这份只是清理重复；**别把 `dsh-github-backup` 那个依赖键一起摘掉** —— 那会删掉正在用的那份 |

  三条硬规矩：
  1. **按分量分组**，不是一个包一条 —— `dsh-mnemon` 自己声明 18 个 dormant 子包，子包又反向声明它（有环）。
     单删父留子 = 留一堆孤儿；单删子 = 父（将来若启用）缺件。
  2. **只生成、永不执行删除**：面板与工具都不提供"删"按钮，清单里给的是可复制的
     `Remove-Item` 命令 + 复核命令，删不删由人决定；写入 `reports/uninstall-*.md|.json` 还要二次确认。
  3. **判据是声明层面**：运行时按路径 `require()` 看不见；hoisted 扁平 `node_modules` 下，
     一个插件可以**不声明**却 `require('lodash')` 命中 —— 删纯库前先 `pnpm why <name>`。
- **删之前先预演（R16）**：清单卡片上多一个**「预演（不动盘）」**按钮（工具侧 `catalog_uninstall action=simulate`）。
  它在**内存里**把选中的目录从依赖图上摘掉、重算四态，然后回答这份清单没回答的问题：
  删完以后**会不会有东西指空**。三个可能的坑各占一行，空的不出现：

  | 预演里的一行 | 说明什么 | 怎么办 |
  |---|---|---|
  | **现在会被加载（本来就不该删）** | 这个包在删之前就在 `bundles` / 配置 / 依赖链上 | 别删 —— 名单本身就选错了 |
  | **删完会指空的入口** | `bundles` 或 cordis 配置条目还写着它，删完下次启动就是一串缺包 | 先摘入口，或留着 |
  | **仍声明它们的包** | 留下的包在 `package.json` 里声明了它（含 optional / peer） | 要么一起删，要么留着（hoisted 下 `require` 会直接失败） |
  | **删完会掉回「不加载」** | 只因这批包才被点亮的下游 | 删完还得再清一轮 |

  ★ 预演**按目录**算，不按包名：同项目第二份（`ghbackup` 与 `dsh-github-backup` 是同一个包名）
  只删一份时，包名还有一份在盘上 —— 按包名整体算会把**正在被加载**的那一份也算进去，
  于是把一次安全的清理报成"有风险"。这条是真踩到的：按包名预演，整份清单被判 risky。
  ★ 它**不是**删吧没问题的背书：判据仍是声明层面（运行时按路径 `require()` 看不见）。
  ★ 一个自证：**按整份清单预演必须判安全**。判据说 dormant 不在任何入口、也不在任何加载链上，
  那么把这批目录全摘掉就不该有入口指空、不该有加载中的包声明它们 —— 这条写进了 hosttest，
  它一旦变红，说明清单选错了包，而不是模拟器坏了。
- **删完以后再对一次账（R27）**：清单卡片上多一个**「对账（不动盘）」**按钮（工具侧 `catalog_uninstall action=verify`）。
  预演回答"删了会怎样"，对账回答"照这份计划动完手，盘上到底成了什么样"。三个问题，按优先级：

  | 对账的结论 | 什么意思 | 怎么办 |
  |---|---|---|
  | **白删**（`fake`） | 目录没了，但 `bundles` / 未关掉的配置条目 / `profile` 依赖键还写着它 | 先摘引用，否则 `pnpm install` 装回来、或启动时入口指空 |
  | **计划过期**（`drift`） | 成员还在盘上，但**今天**它已经会被加载了，或组外已经有包声明它 | 别照旧计划删，重算一次清单 |
  | **还没动**（`intact`） | 一个都还在盘上 | 按清单动手，回来再对一次 |
  | **已删干净**（`clean`） | 都删了，且没有任何东西还引用它们 | 没了 |

  ★ 对账**只 stat 计划里点名的那些目录**（本机 26 次 stat，不遍历 `node_modules`），
  其余判据走同一个 `resolveLoadPaths`（与预演、加载四态、`catalog_health` 同源，不另写一份）。
  ★ 组内互相声明**不算失守**：计划按弱连通分量分组，整组一起走才是预期 ——
  这里按包名反查「谁声明了它」再把同组成员剔除，否则每一组都会误报。
  ★ 结论同样**不进 localStorage**：一份过期的「已删干净」会替人背书下一次动手。
  ★ 计划从哪来：显式 `planPath`（只许 `reports/` 下）> 本次会话算过的那份 > `reports/` 里最新一份。
  删完常常隔一次重启才回来对账，落盘的 `uninstall-*.json` 才是可信来源。
  ★ `enabled` 与「白删」是两件事：`enabled` 说的是在不在 `dsh.profile.bundles`，而白删看的是
  **今天仍在引用它**的三处入口（bundles / 未关掉的配置条目 / `profile` 的 `dependencies`）。
- **改了代码，宿主里跑的是新的吗（R18）**：面板头部与 `catalog_health` 现在同时给**磁盘版本**与
  **运行中版本**；不一致就明说「运行中仍是 0.17.0，磁盘已是 0.18.0 —— 重载插件或重启 DSH 之后
  新代码才生效」。为什么不加就不行：`build` 标签读的是**磁盘**（package.json + 最新文件 mtime），
  所以显示 0.18.0 时宿主里跑的可能是 0.17.0，新工具、新路由**根本不存在** ——
  R16/R17 两轮都因此误判过一次「已经生效了」。同一轮里还把独立探针收进了 `dev/ship.mjs`
  （`probes` 项，现在十一个、231 条不变式），交接前那条命令从「三层自检」变成**三层 + 探针 + 副本同步**。
- **这两天变了什么（R17）**：面板顶部多一条**变化条**（只在真有变化时出现）：
  「自 10-24 11:27 以来 · 3 处变化 · 新增 1 · 升版 2」，点开列明细。历史落在 `history.json`：

  | 比什么 | 说明 |
  |---|---|
  | 插件 `version / source / loadState` | 升版、来源被改过、加载态从 dormant 变 bundle（或反过来） |
  | Skill `source / 描述有无 / 正文内容哈希` | Skill 没有版本号；R19 起**正文改动也看得见**（见下一条） |
  | 配置层声明 `disabled / bundles / 条目增删` | R23 起：只改 `cordis.patch.yml` 或 `dsh.profile.bundles` 时目录条目一个都没变，靠**签名**看得见 |
  | 不比 | 工具数（来自统计）、体积（来自懒算快照）、git 脏文件（随时在变）—— 放进来只会让变化条天天有噪声 |

  三条硬规矩：
  1. **指纹没变就不记**：每次「重新扫描」都写一条的话，基线时间会被不断刷新，
     「自 11:27 以来」永远只剩几分钟，等于看不到真实的变化窗口；
  2. 只留最近 **20** 条；坏 JSON 当空历史（面板不该因为一行脏数据打不开）；
  3. **第一条快照是 0 处变化**，不是「133 条新增」——「还没有历史」和「没变化」是两件事，
     界面上都不能画成空横幅（hosttest 真机抓到过这个：`first=true` 却报 133 处）。
- **确认之后，窗口清零（R19）**：变化条右边多一个「标记已看过」按钮 —— 点一下把**当前目录冻结成基线**
  （写数据目录里的 `history-ack.json`，存的是**整份快照**而不是一个时间戳），之后变化条只显示
  「自你 X 确认以来」的变化，没变化就整条消失；`history.json` 不动（「我看过了」不等于「历史变了」）。
  同一轮把 R17 那条「Skill 正文改动看不见」补上了：`readSkillDir` 本来就要读整份 `SKILL.md`，
  顺手算一个 sha1 前 12 位（58 个技能 ≈ 1.2 MB 内存哈希，实测 < 10 ms），所以**改一个字**也会进「被编辑」。
  升级窗口有明确判据：旧快照里没有哈希时**不算编辑**，否则第一次重建会报 58 处「被编辑」。
  这也是 `CATALOG_VERSION` 抬到 9 与 `HISTORY_VERSION` 抬到 2 的原因。
- **回看更早的窗口（R21）**：`changes` 只给最近一个窗口、`sinceAck` 只给确认之后的窗口 ——
  再往前的快照一直躺在 `history.json` 里却没有任何界面能读到。现在变化条下方多一行
  「历史（N 个窗口 / 共 M 条快照）」：点开就是**相邻快照相减**的时间线，每行写清哪个窗口、
  新增/消失/升版/来源变/加载态变/被编辑各几处、以及前几个名字（Skill 正文改过会标「正文已改」）。
  基线本身**不产出一行**（它没有「之前」，写成「新增 133 条」会误导）；指纹相同 / 0 处变化的窗口跳过；
  只带每类前 4 个名字，`counts` 永远是真实数字。导出报告的「变化」一节下面也会列出最近 8 个窗口；
  `catalog_health` 多一行「历史：共 N 条快照 / M 个窗口可回看」。
- **只改配置也要看得见（R23）**：R17/R19/R21 的变化条只比**目录条目**（插件版本 / 来源 / 加载态、
  Skill 正文哈希）—— 改 `cordis.patch.yml` 里的 `disabled`、往 `dsh.profile.bundles` 加一个包时，
  条目一个都不变，变化条照样报「0 处变化」。现在快照里多一段**配置层签名** `{fingerprint, counts}`：
  指纹取排序后的 `id / name / disabledKind` + `bundles`（sha1 前 12 位），计数是声明层的
  生效条目 / 启用 / 关掉 / 条件启用 / 被 patch 覆盖 / bundles / 组合文件数。
  变化条因此多一个「配置层」chip，点开写「关掉 25 → 24，bundles 50 → 51」；只换了哪个条目被关掉
  （计数没变）时写「条目变了（生效 246）」；更早窗口的时间线里同样一句话。
  签名**只解析声明**（不扫 222 个包、不读 asar）—— 历史每次重建都要记一条，付不起完整审计那份代价；
  同一原因，`present / asar / missing` **不进指纹**（依赖安装态，换台机器就会变，会误报成「配置被改」）。
  升级规则与 R19 同型：两条快照里只有一条有签名时**不判变化**，否则升级后第一次重建就报警。
  `HISTORY_VERSION` 抬到 3；确认基线 `history-ack.json` 也冻结签名，「自上次确认以来」同样看得见配置层。
- **从配置层点回卡片（R24）**：浮层里每条声明后面多了两样东西 —— **解析徽标**（`profile` / `asar` / `查不到` /
  `无法判定`）和 **「在 bundles / 不在 bundles」**（关掉与条件启用的条目尤其需要：`bundles` 里的包即使这里写着
  `disabled: true`，bundle 自带的 patch 层也可能把它重新打开）。**profile 与 asar 的行可以点**：点一下关掉浮层、
  把搜索框换成包名并跳到对应卡片；`查不到` / 按路径 / 分组条目没有卡片，不冒充可点。
  跳转时会**清掉来源 / 加载态 / 用法 / 标签筛选**——否则当前筛选正好把目标卡藏起来，看起来就像"跳转坏了"。
  键盘同样可用（Tab 到行、Enter / 空格触发）。数据侧只给 `/state.composition` 多一份去重排序的 `bundleNames`
  （50 个包名，不传 `bundles.rows`，20 秒轮询里不多塞 file/line）。
- **配置层变化下钻到具体条目（R25）**：R23 只能说「关掉 25 → 24」，说不清**是哪一条**。现在
  `signatureOf` 把声明身份表（`id / name / disabledKind`）与 bundles 名单一起压进快照；指纹没变就不追加，
  但老快照缺这份明细时会**补记一条**（只补一次，不伪造）。`compareComposition` 新增
  `stateChanged / declsAdded / declsRemoved / bundlesAdded / bundlesRemoved`，规则仍是**单边缺就不判**——
  否则升级后第一次改动会把 50 个 bundle 全报成"新加的"。面板变化条与报告共用同一套措辞：
  「关掉 25 → 24，@deepseek-ai/dsh-hmr 关掉→启用，bundles +dsh-extra」；明细最多 4 条，多的写「…等 N 条」
  （完整名单在快照里，`HISTORY_VERSION` 不变）。
- **交接单（R26）**：换会话前最容易漏看的不是数据，而是**几份既有结论的交叉核对** —— 运行中到底是哪一版、
  最新 ship 有没有失败、工作区脏不脏、staging 旧不旧。`catalog_handoff` 把 10 项压成一张单子：
  版本（磁盘 vs 运行中，含「重启 DSH」而不是含糊的 stale）、工具数、配置层缺口、变化与确认、历史快照、
  staging、最新 ship、git 头部/脏文件/未推送、最新目录快照；`write:true` 才落 `reports/handoff-<时间戳>.md`。
  判断在 `lib/handoff.mjs`（纯函数，`dev/probe-handoff.mjs` 9 条合成数据探针），默认只读。
- **卸载清单的前提能被证伪（R14）**：「删 dormant 不会弄坏正在加载的东西」不是感觉，是一条不变式 ——
  **I7：没有任何「会被加载」的包声明依赖一个 dormant 包**。`node dev/probe-loadstate.mjs` 每次都会验它，
  而 `node dev/probe-uninstall.mjs` 再验清单本身四条（I8 覆盖与不重叠 / I9 体积口径 / I10 钉住键安全 / I11 不误伤加载路径）。
  这条抓到过真问题：按「同名副本取最后读到那份」算依赖图，`emoji-regex` 被算成 dormant，
  而顶层 `string-width`（随 `@anweat/dsh-browser` 加载）正声明着它 —— 照那份清单删就会弄坏加载。
  修法是**同名副本取依赖并集**（保守方向：宁可少判一个 dormant），并把 `CATALOG_VERSION` 抬到 8。
- **配置层到底挂了什么（R22）**：面板头部多一个**「配置层」**入口（有缺口时角标写「查不到 N」/「缺 N」），
  点开是把两份组合文件的**声明**摊开：`cordis.yml` + `cordis.patch.yml` 各多少条顶层条目、按 id 合并后生效多少条、
  每条是包 / 子路径 / `file://` 路径 / `cordis:group` 分组 / 只按 id 覆盖，那个包在 profile 还是官方 asar 里，
  哪些被 `disabled: true` 关掉、哪些是 `!!js` **条件启用**（给原文，不求值）。
  另有一行专门核对 `dsh.profile.bundles`：**声明 50 → profile 里 43 + 官方 asar 7 + 真的缺 0**。
  三条边界直接印在浮层脚注里：**不展开 bundle 自带的 patch 层**（本机 `tool-bash` 在 `cordis.yml` 里写着
  `disabled: true`，但 bash 工具确实在跑）、表达式不求值、组合条目「静态查不到」≠ 一定坏
  （运行期注入的虚拟模块看不见 —— 本机 `dsh-plugin-desktop` 就是这种）。
  只有 `bundles` 里点名却找不到才会占顶部公告位并说「宿主启用它们时会失败」。
  同一份数据还进 `catalog_health`（一行）、`catalog_composition` 工具、导出报告的「配置层（声明）」一节。
另有一个 `catalog_handoff`（R26）：把「换会话之前」要对的 10 项压成一张交接单。
  判据在 `lib/composition.mjs`（纯函数、不碰磁盘），`dev/probe-composition.mjs` 用合成文本钉 **C1–C14**。
- **快捷键**：`/` 聚焦搜索、`Esc` 清空搜索（浮窗里 `Esc` 关闭浮窗）
- **缓存自愈**：统计缓存超过 10 分钟且没有任务在跑时，面板自己起一次**增量**刷新（只重读变化的会话，实测 0.4~0.7 秒），不用记着点「刷新统计」；有任务在跑、或本挂载已经刷过，就不再触发 —— 否则会和 20 秒轮询叠成「一直在刷新」
- **传输压缩（R31）**：`/state` 实测 **359 KB**（139 条条目）、面板每 20 秒拉一次，所以路由按需 gzip ——
  请求头带 `accept-encoding: gzip` 且正文 ≥ 1 KB 才压，否则原样（浏览器/Electron 的 `fetch` 自动解压，
  **零客户端改动**）。刻意读 `res.req` 而不是改 20 个调用点的签名：压缩是传输层的事，不漏进业务代码。
  **R31c：这件事现在能自己报** —— `json()` 把 `{raw, packed}` 回给 `/state`，`/state` 再 `noteTransport`
  记到 service 上，于是 `catalog_health` 多一行「传输：上次 /state 359361 字节 → gzip 85631 字节（23.8%，4.20×）」，
  `/health.transport` 是同一个数。要现量仍可用 `dev/measure-state.mjs --base http://127.0.0.1:<端口>`。
- **分页**：列表底部「共 N 条 · 第 X / Y 页」+ 上一页/下一页/首页/末页，**每页 12 / 24 / 48 / 96 / 全部**；搜索、筛选、排序任一变化自动回第 1 页
- **外观**：深/浅主题共用一套本地色板（由 `label-primary` 混出，深色下不再是刺眼白框）；卡片悬停时边缘发一圈**克莱因蓝 `#002FA7`** 的光，键盘 `:focus-visible` 同样有蓝环
- **浮窗**（点卡片，屏幕居中，点外部或 Esc 关闭）：
  - 每个工具各自的调用次数、报错、平均耗时、最近一次、涉及会话数
  - 会话列表：**会话昵称** + 次数 + 是否子代理（含父会话名），可分页、每页条数可选（10/20/50/100）
  - 来源判定依据（逐条列出为什么这么判）、标签编辑、创建时间、仓库链接
  - 「位置与安装形态」（插件）与「位置与体积」（Skill）：源目录（一键复制）、是 junction 还是 profile 里的实体目录副本、**磁盘体积与文件数** —— 「装上了却不工作」时先看这里，「要不要删」时也看这里
  - 自写/混血额外有「上传 / 更新到 GitHub」「缺口分析」
  - 判错来源可以手工标一次（存进 `.dsh-plugin-catalog/overrides.json`，之后不再问）

> ⚠️ **面板必须自己滚**：DSH 官方中列（`div._centerCol`）是 `overflow:hidden`，
> 面板若不自己 `height:100% + overflow-y:auto`，第二屏之后会被**静默裁掉** ——
> 表现为「没有滚动条、也翻不到下面」。这条已固化成 `dev/audit.mjs` 的断言，改回去会红。

### 工具（同一套能力，普通会话里直接调）

| 工具 | 一句话 |
|---|---|
| `catalog_list` | 列出所有插件与 Skill（可按来源/类型/关键字过滤）；**R30 起 `kind=mcp` 只看 MCP 服务器** |
| `catalog_mcp` | **MCP 服务器**：每台 = 组合文件里一条 `@deepseek-ai/dsh-mcp-client` 条目（serverName / 传输 / 命令或 URL / 开或关 / 文件:行），按**官方 / 第三方 / 自己配置**三分类计数，`mcp__<serverName>__<tool>` 的调用按服务器归属；`view=orphans` 找孤儿调用（指向已删/改名的服务器），`view=problems` 看配置问题，`view=template` 给三段可抄写法。只读，`env`/`headers` 的值从不显示 |
| `catalog_stats` | 全局概览，或某个条目的分工具明细 + 会话列表 |
| `catalog_tag` | 列标签 / 打标签（单个 `id`＝整条替换；批量 `ids`＝只加不减）/ **批量去标签**（`action=untag`）/ 新增自定义标签（必须给解释）/ 删标签 / **手工改来源**（`action=source`）/ **手工改工具归属**（`action=tool-owner`） |
| `catalog_classify` | AI 自动打标签（会读自定义标签的解释） |
| `catalog_review` | 审一遍某个插件（缺口分析 + 安全审核，只出建议） |
| `catalog_publish` | 上传备份：`plan` → `apply`（需 `planId` + `confirm`，可带 `ackRepos`）→ `public`（独立门禁） |
| `catalog_export` | **导出快照**到 `<数据目录>/reports/`：`format=md`（默认）= 完整 Markdown 报告（清单、来源分布、调用 Top、仓库与 git 状态、待标记来源、归属覆盖率、每周发现）；`format=csv` = **全部条目一行一条**的 12 列表格（带 BOM，Excel 直接打开） |
| `catalog_health` | 自检：跑的是哪一版、路径解析、统计覆盖、归属覆盖率、**Skill 正文哈希覆盖率**、**「已看过」确认窗口**、AI 通道、asar 模式、**副本是否同步** |
| `catalog_skill_sync` | Skill 的**两份副本**：`plan` 列出 staging 旧了的那几个（发布推的是 staging，它旧了等于发旧版）；`apply` + `confirm:true` 做**单向 live → staging**，写前把被覆盖文件备份成 `SKILL.md.bak-<时间戳>`；`restore` 是反向撤销（把 staging 还原到备份，同样先出计划、`confirm:true` 才写，只动 staging）；**R28 起 `restore` 可加 `backup=<stamp>` 点名还原到更早的那一份**（计划里会列出最近 8 份可选，省略才是最近一份） |
| `catalog_uninstall` | **「不会被加载」的处置清单**：`plan` 按弱连通分量分组，给可回收体积、分类（实体 / 被 profile 钉住 / 链接 / 同项目第二份）与步骤；`simulate` 在内存里把这些目录摘掉、重算加载态，回答「删完会不会有入口指空 / 还有谁声明着它们」（可传 `packages` 点名包名或目录名）；`verify` **反向对账**：拿一份已存在的计划与今天的磁盘/声明事实比 —— 哪些目录真的没了、哪些**白删**（会被装回来 / 入口指空）、哪些计划已经过期（今天它已经会被加载 / 组外已有包声明它），可传 `planPath` 指定 `reports/` 下某一份；`write` + `confirm:true` 写成 `reports/uninstall-*.md|.json`（`verify` 带 `confirm:true` 则写 `reports/uninstall-verify-*.md`）。**四个动作都不执行删除**（命令给人复制） |
| `catalog_composition` | **配置层（声明）**：两份组合文件的顶层条目 —— 从哪份文件来、挂的是包/子路径/`file://`/分组/只按 id、包在 profile 还是官方 asar、`disabled: true` 关掉的、`!!js` 条件启用的（原文，不求值）；并核对 `dsh.profile.bundles` 里有没有点名却找不到的包。`view=overview` 给计数与缺口，`entries` / `disabled` / `conditional` 给清单。**不展开 bundle 自带的 patch 层**，只读 |

## MCP 分类（R30）

面板工具条上第三颗类型 chip：`全部 / 插件 / Skill / MCP`。MCP 与插件是**两种不同的东西**，所以它有自己的判据：

| 问题 | 答案从哪来 |
|---|---|
| 有哪些 MCP 服务器 | `cordis.yml` / `cordis.patch.yml` 里 `name: '@deepseek-ai/dsh-mcp-client'` 的每条条目（按 `id` 合并，patch 只写 `disabled` 时配置仍取基线） |
| 它是官方 / 第三方 / 自己配置 | 启发式 + **理由**：命令指向本地文件、配了本地 `cwd`、url 是环回地址 → **自己配置**；命令/参数/url 里出现 `@deepseek-ai/` → **官方**；其余（npx/uvx/docker 拉外部包、公网 url）→ **第三方**。判错了可以在浮窗里改（`catalog_tag action=source`） |
| 它在跑吗 | 只有三态：**启用 / 关掉（`disabled: true`）/ 条件启用（`!!js`，不求值）**。它**不在** `dsh.profile.bundles` 里，所以四态加载判据对它没有意义 |
| 它被调用过多少 | 工具名契约 `mcp__<serverName>__<tool>` —— 按前缀归属到服务器，不靠描述指纹。`mcp__` 的调用**不算**宿主核心工具 |
| 为什么一台都没有 | 本机目前确实没配。此时分类页给**空态 + 三段可抄模板**（自己配置 / 第三方 / 远程），不是一张空表 |

数据来源与边界：

- 声明层（与「配置层」浮层读同一份文本、同一时刻），改完组合文件要 **重启 DSH** 才生效（`cordis.patch.yml` 不热更）。
- `env` / `headers` 的**值永不下发**到浏览器或报告，只给键名；url 的 userinfo 与 query 隐藏。
- 「孤儿调用」= 统计里出现过 `mcp__<server>__*`，但组合文件里现在没有这台服务器 —— 删过条目或改了 `serverName`；`catalog_health` / 交接单会把它标成 warn。

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

0. **安装 / 升级 / 卸载插件与 Skill 不归本插件管（刻意如此）**：装东西走 `dsh-plugin-installer`
   （`install_hub_search_plugins` / `install_hub_submit_request` / `install_hub_status`）或官方 `plugin_manager`。
   本插件只做**清点、判据、处置清单、对账、导出**。★ 曾计划过一个 `catalog_import`，评估后**主动不做**：
   两套安装路径会各写各的快照与回滚，出问题时谁也没法证明是哪一套写的。两边的关系是"它装、我核"——
   装完回面板看 `loadState` 是否 loaded、进了 `catalog_mcp` / `catalog_list` 没有。
1. **私有仓拿不到平台级安全扫描**：GitHub 的 Secret Scanning / Dependabot / Push Protection 需要付费 GHAS。
   所以「依赖已知高危」只能靠本地规则与模型常识，**准确度低于平台级扫描**。
2. **Skill 的调用统计只能到「次数 + 最近一次时间」**，无法细分到会话 —— 这是机制限制，界面上有标注。
3. **个人免费账户的私有仓没有「只读分享」档位**：要么私有（仅本人/受邀协作者），要么公开（所有人可读）。
   需要精细权限得建 Organization。
4. **工具归属是推断**，但实测覆盖率很高（196 个工具里 193 个靠描述指纹唯一命中，覆盖 85.2% 的调用量；
   歧义 0、未归属 0）。剩下 2 个判为宿主核心（`plugin_manager` / `exit_plan_mode`），
   仍可在面板手工指定工具归属覆盖。
5. **星标/下载量等生态数据不采集**（本插件不联网，只读本机事实）。
6. **官方包（asar 内）的磁盘体积量不到**：它们在宿主安装包里，没有独立目录，所以列表与合计都按"不参与"处理。
   要知道它们占多少，只能看 DSH 安装包本身的大小。
7. **体积快照是"上次量的时候"**：装/删/升级插件后，面板不会立刻知道变化 ——
   超过 24 小时自动重量一次，也可以随时点「重量体积」（量完覆盖快照）。
8. **体积有预算**：单个目录最多 2 万文件 / 1.5 秒。超过的条目报下限（界面上带「+」，本机实测 1 条）。
   这是为了不让一个巨型目录把整次测量拖住。
9. **「无人依赖」是启发式**：只读 profile 里 `node_modules` 下**一层**嵌套的 `package.json`，
   更深的嵌套（`a/node_modules/b/node_modules/c`）或运行时 `require` 出来的包可能漏判成"没人依赖"。
   所以它只做**候选**，界面上永远带"用 `npm ls` / `pnpm why` 确认"。本机实测 220 个包里 2 个候选
   （`dpi-probe-bundle`、`dsh-toolfold`），都被更深的依赖链排除过一轮。
10. **依赖图不区分 devDependencies**：装进 profile 的包本来就不该有 dev 依赖，这里只按运行时声明判断。
11. **pnpm 的 `.pnpm` 虚拟仓库不展开**（本机 `nodeLinker: hoisted`，不存在该目录）；换成 isolated 链接模式时，依赖图会退化。
12. **MCP 的「来源」是启发式**（R30）：本地路径 / 环回 url → 自己配置，`@deepseek-ai/` → 官方，其余 → 第三方。
    它判的是"这条声明长什么样"，不是"这个服务器的作者是谁"；判错可在浮窗里手工改。
13. **MCP 读的是声明层，不是运行态**：条目写了 `command` 也可能启动失败（缺依赖、端口占用、token 过期），
    本面板不连服务器、不握手。真正的连接状态看宿主日志与工具是否出现。
14. **MCP 的 `disabled` 若是 `!!js` 表达式不求值**：面板只显示原文，到底开没开以宿主为准。
15. **MCP 的调用归属按第一个 `__` 切 serverName**：`serverName` 与工具名都允许下划线，
    理论上存在歧义（`mcp__a__b__c`）；本面板与报告用同一个切法，不在别处再猜一次。
16. **MCP 没有体积 / 依赖 / 加载态**：它是组合文件里的一条声明，不在 `node_modules` 里，
    所以「量体积」「无人依赖」「不会被加载」这三档对它一律不适用（卡片上也不会出现）。

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

### 模型调用：推理档位和 `maxTokens` 共用一份预算

`deepseek-flash` 默认 `reasoningEffort: high`，而推理 token 与正文**共享同一个 `maxTokens`**。
长文本任务（把整篇 README 翻成英文）会把预算花在推理上 → 正文要么**空流**、要么被
`max-tokens` 截断（文本看着有内容但残缺，英文版章节对不上就是这么来的）。`askLlm` 只累积
`text-delta`，推理段本来就丢弃，所以**从文本侧完全看不出来**。

本插件的做法：翻译类任务传 `reasoningEffort: "off"`，并把 `finish.kind` 与
`usage.reasoningTokens` 记进失败原因。`FinishReasonMap` 只有
`stop / tool-calls / max-tokens / aborted / error` —— **截断是 `max-tokens`，别猜成 `length`**。
（实测：24 个仓里 11 个英文 README 因此静默缺失；降到 `off` 后剩余 5 个全部一次成功。）

另一个自激：英文 README 的新鲜度判据是 `mtime(en) >= mtime(zh)`，而流程是「先写英文、
再给中文补互链」—— 中文随即变新，下次 plan 又要求翻译。修法见 `lib/publish.mjs`
（补完互链后 `utimes` 刷新英文时间戳）。

## 自救（界面出问题时）

本插件是**独立客户端插件**，禁用即回官方界面：

- 在 profile 的 `package.json` 里从 `dsh.profile.bundles` 去掉 `"dsh-plugin-catalog"`，重启 DSH；
- 或者用插件安装面板把它停用。

它**不隐藏也不改动官方插件入口**：官方「插件」页仍在 `sidebar.panellist` 原位置，本站只是**新加**一项。

## 自检

**发版 / 交接前只跑这一条**（三层自检 + **七个独立探针** + 副本同步 + 版本一致性 + git，约 60 秒）：

```bash
node dev/ship.mjs          # 结论写进 .cache/ship-<时间戳>.md；面板头部「自检」按钮走同一条路
```

五项检查：

| 项 | 内容 | 红了会怎样 |
|---|---|---|
| `audit` | 自洽契约（默认值/工具契约/样式与行为契约） | 算失败 |
| `render` | 界面渲染（真渲染组件树后断言） | 算失败 |
| `hosttest` | 宿主行为（假 ctx 真跑 `apply()` 与路由） | 算失败 |
| `probes` | **11 个独立探针**（加载路径 / 处置清单 / 删除预演 / **处置对账** / 批量打标 / 变化追踪 / 副本判据 / **配置层** / **交接单** / **CSV 导出** / **MCP 判据**，共 237 条，约 3 秒） | 算失败 |
| `staging` | **副本同步**：`<ws>/.dsh/skills` 与 staging 里同名 `SKILL.md` 有几个不一致 | **只报不拦** |

`probes` 这一项是 R18 补的：这几个探针以前只写在交接文件里（「有人记得就跑」），
不变式从来没进过发版体检 —— R16/R17 两轮都是靠人手动补跑才发现回归的。
现在它们由 `dev/run-probes.mjs` 串起来；清单本身在 `dev/ship-checks.mjs`（**单一来源**），
面板的 `POST /preflight {dry:true}` 报的就是它（此前硬编码四项，收进探针后 dry 仍只报四项）。

`staging` 这一项为什么只报不拦：它报的是**这台机器的状态**，不是代码缺陷 ——
中途改 Skill 时 staging 落后是常态（可能正在写、可能还没发布）。把它算失败会让这条命令
在最该用的时候变成噪音，与「git 脏只报不拦」同一条口径。它仍然值得看一眼：
R6 那次「12 个 Skill 发出去的都是旧版」就是靠人翻对话才发现的，现在交接前一条命令就能看见；
面板上同样能看见，并且**能就地同步**（公告条上的「同步 staging」）；同步后发现不对，
浮窗里的「还原到 `<时间戳>`」可以把它撤销（R20）。

它会拦下三类「发出去了但其实没上」：自检有红、`package.json` 版本与 `client.js` 的 `BUILD` 对不上、
（只报告不拦）工作区有未提交改动 / 本地 HEAD 与 `origin/main` 不一致。

分项跑：

```bash
node dev/deliver.mjs --base http://127.0.0.1:<GUI端口>
                            # ★ R29：**换会话/交付前的最后一条命令**。只消费 ship 与 live-check 的结论（不重算判据）；
                            #   判据三条：ship 全绿 / 运行中与磁盘一致 / 没有悬空项（未提交 / 未推送 / staging 旧了 / 该重启）。
                            #   退出码 0 = 可以换会话；报告 `.cache/deliver-<时间戳>.md`；--skip-ship 省 40 秒。
                            #   ★ 不提交、不推送、不同步 —— 写盘动作一律由人显式发起。
node dev/audit.mjs         # 自洽（607 项）：默认值冻结/工具契约/规则覆盖/去重/命名/门禁/双语 README 流程 + 客户端样式与行为契约 + staging 判据单源 + 加载态四态判据 + 探针不变式 + **处置清单（分类/分组/别名键/只生成不执行）+ 删除预演（纯函数/按目录算/revived 恒等）/ 写盘计划跳过 60 秒漂移缓存 / 变化追踪（纯函数/指纹 12 位/第一条不报新增/正文哈希与升级迁移/确认基线/时间线相邻相减与基线不产出行）/ 副本判据（正文哈希 / 同字数漏判 / 退回口径 / 备份名与路径校验 / 还原只写 staging）/ 配置层声明（块标量 / disabled 三语义 / 按 id 合并 / 条目五类 / 解析五档 / 只有 bundles 缺才算 bad / 三组计数守恒）/ 真机核验脚本（只读 / 不出现 confirm:true）/ health 时间线摘要 / 发版体检清单单源 + 运行中版本与磁盘版本**（沙箱可跑；R31 起多 22 条：探针清单单源、文档数字与真值对账（工具数/探针数/live-check 条数/交接单项数/三处「共 N 条」一致）、`dev/` 顶层探针都在登记表里、MCP 停用片段只出文本、gzip 分支与 `measure-state` 脚本还在、`/state` 字节数经 `noteTransport` 进 health；R29 起多 5 条：deliver 只消费判据不重算 / 不执行写盘动作 / 三条结论判据 / 沙箱 EPERM 与断言红分开报；R28 起多 13 条：CSV 转义是 RFC 4180 那三条 + BOM / 事实只有一份实现（Markdown 只加装饰）/ CSV 与 Markdown 同一批 picked / 工具与路由同一条链路 / pickBackupByName 按全名比对 / 写盘带同一份备份 / 两个 CSV 入口都真挂了按钮；R22.1 起多两条：浮层脚注给出缓存年龄、health 摘要带 at；R23 起多 14 条：配置层签名只解析声明 / 指纹折进快照 / 单列 composition 桶 / 单边缺不判 / 面板与导出同一措辞；R24 起多 4 条：bundleNames 去重排序 / 可点行只限 profile 与 asar / 跳转清筛选 / 交叉引用与徽标；R25 起多 5 条：签名身份表 / 明细点名到 id / 单边缺不伪造 / 面板与报告同一措辞 / 历史截断；R27 起多 14 条：对账是纯函数 / 白删三来源 / 组内声明不算失守 / presence 缺失时保守 / planPath 只限 reports 下 / 对账结论不进 state / 措辞单源 / 探针 V1–V15 与注册）
node dev/render-check.cjs  # 界面：卡片内容/搜索(含工具名)/洞察条/排序(含体积)/列表分页/浮窗/体积四态/依赖 chip/加载态 chip 与置灰/自检按钮/体检结论卡/**处置清单卡（分类 chip 与二次确认、卡内没有删除按钮）+ 预演结果块（安全态与风险态、没预演过就不出现）+ **对账结果块（结论与逐条原因同时出现 / 计划龄 / 白删与计划过期两张名单 / 卡内仍然没有删除按钮 / 没对账过就不出现）**+ **变化条（有变化才出现 / 点开才列明细 / 第一条与 0 处都不占版面 / 标记已看过后的确认窗口 / 正文已改措辞 / 更早窗口的历史时间线）** + **运行中版本与磁盘不一致时标「（未重载）」**/多选批次/副本同步/**同步 staging 三步与二次确认**/**历史备份行与还原确认条（R28：更早的备份可选，点一份就换目标）**/**配置层入口与浮层（概览 / 静态查不到 / 条件启用 / 关掉的 / 缺口公告只在 bad 时出现 / **R24 可点行跳卡片 + 在不在 bundles 的交叉引用** / **R25 变化明细点名到具体 id**）**/导出/空态（223 项，无需 DSH）
node dev/preview.mjs       # 版式：生成静态预览（真实组件树 + 真实 CSS），供浏览器截图看
```

宿主侧（不需要重启 DSH）：

```bash
node dev/hosttest.mjs      # 假 ctx 真跑 apply()：路由 / 工具契约 / 统计 / 标签 / AI 路径 / 门禁 / effect 同步约束 / async apply 返回值校验 / 列表项字段 / 体积递归与缓存 / 体积快照（含 asar 与 Skill 口径）/ 批量体积 / 依赖图四字段 / 加载态四态与 enabled 的独立性 / 导出的加载路径与「不会被加载」一节 / **发版体检路由（dry，五项）/ /skillsync 计划与 confirm 门禁 / staging 判据与单向复制 / ship 的副本同步项 / 处置清单（工具 + /uninstall 路由 + 跑完 node_modules 一个没少）+ 删除预演（整份清单必判安全 / 单删父包必报孤儿 / 未知包不瞎猜 / 路由直接回结果 / 文案写清三行风险）+ **处置对账（工具读回计划并逐目录 stat / 四态计数 / 文案四段齐 / 路由直接回结果且默认不写盘）**+ **变化追踪（快照落盘 / 指纹不重复 / 只留 20 条 / 导出报告有「变化」一节）+ 正文哈希进快照 + 确认窗口（无 confirm 被拒 / 写基线 / 清零 / health 报得出）+ 时间线进 /state（total + items）+ /health 只给时间线摘要 / 副本哈希判据 / 还原计划与 confirm 门禁 / 真还原 + pre-restore 备份 / 备份列表 + 运行中版本与磁盘版本 + **配置层（/state.composition 形状 / 三组计数守恒 / 每条带 file+line / bundles 缺口守恒 / 工具 view / health 只给摘要 / 导出「配置层」一节）** / 导出落盘 / 副本漂移判据 / skill_sync 计划与 confirm 门禁（宿主里 308 项；普通 node 里 302 通过 + 6 条 SKIP —— 沙箱禁止带管道 spawn + 读不到 app.asar）
node dev/live-check.mjs --base http://127.0.0.1:<GUI端口>  # 对**运行中的面板**只读核验（≈0.2 秒）：
                            # 版本一致 / 工具与目录在 / 时间线形状 / drift 带哈希与备份 / 还原计划只读 / 不带 confirm 的还原被拒
                            # ★ 端口每次重启都会变；走 host_selfcheck 跑（args 传 --base），不写任何文件
node dev/probe-loadstate.mjs  # 独立重算加载路径：自己扫 profile + 两份组合文件 → 四态 → 与 cache/catalog.json 对账；
                              # 七条不变式（计数守恒 / bundle 口径 / via 指得回入口 / dormant 与入口无交集 /
                              # disabled 不算入口 / 快照与重算一致 / dormant 对加载中的声明封闭），破一条退出码 1；--json 可机读
node dev/probe-uninstall.mjs  # 处置清单自检：四条不变式（I8 覆盖与不重叠 / I9 体积口径 / I10 钉住键安全 /
                              # I11 不误伤加载路径），破一条退出码 1；--json 可机读
node dev/run-probes.mjs       # **11 个探针串成一条**（发版体检的第 5 项，共 237 条，约 2 秒）：
                              # 兼容两种收尾格式（`passed N / failed M` 与「N 条不变式全部成立」）；
                              # 沙箱里 spawn 被拒时会明说「要在宿主里跑」，不会误判成探针坏了
node dev/ship-checks.mjs      # 发版体检的**清单单一来源**：ship 真跑它、面板 POST /preflight{dry} 报它
                              # （此前两处各写一份 → 收进探针后 dry 仍只报四项，hosttest 抓到过）
node dev/probe-simulate.mjs   # 删除预演自检：14 条（空删除不改态 / dormant 判安全 / transitive 会点名 /
                              # bundles 与配置入口指空 / dangling / 掉回 dormant / 摘边不能点亮谁 /
                              # 未知包与去重 / 包数守恒 / 同名两份目录只删一份不算删掉），破一条退出码 1
node dev/probe-csv.mjs        # CSV 导出自检（R28）：20 条（逗号 / 双引号双写 / 换行 / 前后空格都加引号 /
                              # null 与 0 是两件事 / 默认带 BOM / CRLF / 空输入只出表头 / 自定义列里未知 key 变空 /
                              # 事实层不带 Markdown 装饰 / 0 次调用写「—」而 0/40 报错写 0% / asar 内与没量过分开 /
                              # 一行成品的列数与表头一致），破一条退出码 1
node dev/probe-verify.mjs     # 处置对账自检：15 条（空计划不叫干净 / 全在盘上报 intact 且不虚报已回收 /
                              # 已删但被 profile 钉住 / 还在 bundles / 未关掉的配置条目 / 组外仍有包声明它 → 白删 /
                              # 今天才被加载或组外才声明 → 计划过期 / 组内声明不算失守 / 字节账不重叠且链接恒 0 /
                              # presence 缺失时保守 / 重复目录只算一次 / 计划龄 / 结论优先级 / 边界四条），破一条退出码 1
node dev/probe-history.mjs    # 变化追踪自检：32 条（指纹稳定且与顺序无关 / 新增消失能倒过来 / 版本与来源变 /
                              # 同一条多处变化 total 去重 / Skill 描述有无 / 正文哈希（改一字就变 + 升级迁移不算编辑）/
                              # 裁剪留最近 N / 坏历史当空 / 第一条快照 0 处变化 / 确认基线 normalizeAck /
                              # 时间线（基线不产出行 / 相邻相减 / 新的在前 / cap / 同指纹跳过）），破一条退出码 1
node dev/probe-staging.mjs    # 副本判据与还原自检：16 条（正文哈希稳定 / 同字数改一字必须 differs / 哈希优先于 mtime /
                              # 读不到哈希退回 size+mtime / 备份名排序与 latest / 还原 + pre-restore 备份 / 一致时 skipped /
                              # 路径穿越与非备份名被拒 / 端到端同字数漏判），破一条退出码 1
node dev/probe-composition.mjs # 配置层（声明）自检：36 条（顶层条目与块标量 / disabled 三语义 / 按 id 合并 /
                              # 条目五类与包名去子路径 / 解析五档 / bundles 缺口 / 计数守恒 / 严重度 /
                              # asar 读不到只算 unjudged / 摘要与紧凑视图 / 导出文案），纯函数、不读 profile
node dev/probe-gitops.mjs  # 在临时仓真跑 init/commit/push 失败/ignore（23 项，不碰真实仓、不联网）
node dev/probe-asar.mjs    # 官方插件能不能从 app.asar 读出来（Electron 的 asar 是"目录"）
node dev/measure-attrib.mjs  # 用真实工具 schema 量归属覆盖率
node dev/probe-publish.mjs   # 只读预演上传计划（不建仓、不提交、不推送）
node dev/probe-export.mjs    # 用真实数据导出一份 Markdown 快照到 reports/
node dev/probe-init.mjs      # 量启动成本（init/state/entryDetail 的毫秒数）
node dev/measure-state.mjs --base http://127.0.0.1:<端口>  # 量 `/state` 的**线上**字节（R31：357 KB → 85 KB，≈4.2×；
                             # 判据三条：都 200 / 真回了 content-encoding: gzip / ≤ 原始 60%。必须用 node:http，
                             # fetch 会自动解压 —— 那样量到的永远是解压后的长度）
node dev/warm-cache.mjs      # 预热真实数据目录，让第一次打开就有数据
node dev/rm.mjs              # 救火：删工作区里的文件/目录（工具沙箱不让 unlink；经 host_selfcheck 执行）
node dev/ship.mjs            # 发版体检（上面那条）；--json 供面板 /preflight 调用
```

★ `dev/ship.mjs` 在**普通 node** 里跑时，hosttest 的 asar 断言会标 `SKIP`（读不到 `app.asar`），
所以数字比面板点「自检」少一条；两者都如实打出来，不静默。

**「在链」与「旧一代」两类探针（R31 起明确区分）**：上面这一串是**发版体检链上**的 11 个
（清单只有一份：`dev/probe-list.mjs` 的 `PROBES`）；`dev/` 里另有一批 R1–R9 的探索脚本
（`probe-asar` / `probe-export` / `probe-gitops` / `probe-init` / `probe-publish` / `probe-catalog` /
`probe-dupe` / `probe-multifile` / `probe-stats`），它们**不在链上**、多数只是打印而非断言，
其中两条在沙箱里天然是红的（`probe-asar` 读不到 asar → `mode none`；`probe-gitops` 的 git 子进程
→ `spawn EPERM`）。它们登记在 `dev/probe-list.mjs` 的 `LEGACY_PROBES` 里，各自写了"被谁接管"；
audit 会核对 `dev/` 顶层的每个 `probe-*.mjs` 都在这两张表之一 —— 新写的探针忘了挂链，红的是 audit。

`dev/preview.mjs` 为什么存在：无头自检只能验结构/文案，验不了**版式**（浮窗是否居中、
卡片网格会不会被挤成一列、窄卡片里徽章是否溢出）。它把组件树序列化成 HTML 并注入同一份 CSS，
用任意静态服务器打开即可截图；本机实测用它抓到过「纯文本里漏出 markdown 星号」这种只在渲染后可见的问题。

`dev/probe-gitops.mjs` 为什么存在：上传是最难在沙箱里验的一段（子进程 spawn 被禁），
而真实仓不能拿来试 —— 所以在临时仓里真跑一遍，涵盖「还没第一次提交的新仓」这种边界。

## 许可证

MIT。
