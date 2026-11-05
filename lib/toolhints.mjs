/**
 * toolhints.mjs — 工具的一句话中文说明（R39）。
 *
 * 为什么要这一层：详情页的「每个工具的调用」原来只有工具名与次数 ——
 * 对不熟悉这台机器的人（以及换会话后的 AI），`shot_probe` / `catalog_uninstall`
 * 这种名字等于没解释。鼠标停上去要能读到「它是干什么的」。
 *
 * 三条纪律：
 *   1. **纯函数、无 IO** —— 静态表 + 前缀规则，可以在探针里直接断言；
 *   2. **静态表只是兜底**：AI 生成的结果（`intros.json` 的 `byEntry[id].tools`）
 *      更贴这个插件自己的说法，优先用它；静态表保证「没生成过也看得懂」；
 *   3. **不确定就直说**：查不到就返回空串，界面显示「（还没有中文说明）」，
 *      绝不编一个听起来对但其实是错的用途。
 *
 * @module dsh-plugin-catalog/toolhints
 */

/** 精确表：宿主核心工具 + 本机高频插件的工具。key 是工具名（不带 mcp__ 前缀）。 */
export const TOOL_HINTS = Object.freeze({
	/* ── 宿主核心：文件与命令 ── */
	pwsh: "在 Windows 上执行 PowerShell 命令（沙箱内，超时 120 秒）",
	bash: "在 Windows 上执行 Bash 命令（沙箱内，超时 60 秒）",
	read: "读一个文本文件（整篇或指定行区间）",
	write: "新建或整体覆盖一个文本文件",
	edit: "对文件做定点替换（只改命中那一段，不重写整篇）",
	apply_patch: "按补丁格式改文件（多文件、带上下文）",
	grep: "按内容在文件里搜索（正则 / 子串）",
	glob: "按通配符找文件路径",
	watch: "盯住一个路径的变化（文件/目录）",
	read_image: "把一张本地图片交给模型看（读图，不是 OCR）",
	ask_user_question: "向用户提问，等一个选择或补充信息",
	present: "把产物作为文件卡片交给用户（打开 / 预览）",
	skill: "加载一个 Skill 的完整操作手册",
	todo_write: "维护任务清单（多步工作时显示进度）",

	/* ── 宿主核心：任务与子代理 ── */
	subagent: "派一个独立的子代理去完成一件自成一体的任务",
	subagent_fork: "派一个继承了当前对话上下文的子代理",
	send_message: "给子代理发一条消息（追问 / 纠偏 / 继续）",
	interrupt_agent: "让子代理停下当前工作",
	list_agents: "列出自己派出的子代理及状态",
	list_subagent_models: "查可用的子模型路由（给子代理指定模型）",
	workflow: "用一段脚本编排大量子代理（扇出 / 分阶段）",
	create_goal: "创建一个跨轮次持续追踪的目标",
	get_goal: "读当前目标（含 id 与 revision）",
	update_goal: "更新目标（完成 / 阻塞 / 暂停 / 改目标）",
	exit_plan_mode: "提交计划等用户批准，然后离开计划模式",

	/* ── 宿主核心：后台任务与终端 ── */
	job_output: "读一个后台任务的输出（可等待完成）",
	job_kill: "停掉一个后台任务",
	job_list: "列出自己起的后台任务",
	terminal_open: "开一个常驻终端会话（跨工具调用保留状态）",
	terminal_send: "往常驻终端里发一段输入",
	terminal_read: "读常驻终端最近的一段输出",
	terminal_close: "关掉常驻终端并等进程退出",
	terminal_signal: "给常驻终端的前台进程发信号",
	terminal_list: "列出自己的终端会话",
	working_directory: "读当前工作目录，或用 cd 切换",

	/* ── 宿主核心：定时 ── */
	schedule_create: "创建一个定时提醒（一次性 / 每天 / 每周 / cron）",
	schedule_list: "列出本会话的定时提醒",
	schedule_update: "改一个定时提醒（时间 / 内容 / 标题）",
	schedule_delete: "删掉一个定时提醒",

	/* ── 宿主核心：联网与媒体 ── */
	web_search: "联网搜索，返回摘要与来源链接",
	web_fetch: "抓一个网页并转成文本",
	screenshot: "无感截屏（整屏 / 指定窗口 / 一块矩形），落到 PNG 并返回路径",
	screenshot_windows: "列出当前可以截的窗口（句柄 / 标题 / 位置）",

	/* ── 宿主核心：会话取证 ── */
	session_search: "跨会话搜历史（返回每个会话最相关的一条）",
	session_list: "列出会话日志（文件名 / 体积 / 时间 / 会话 id）",
	session_grep: "在压缩的会话日志里跨会话搜字符串",
	session_tail: "读一个会话的全部帧，给轮次时间线与错误清单",
	session_origin: "查会话的真 header（父会话 / 是否子代理 / 嵌套深度）",
	session_topology: "全局会话拓扑（主会话 / 子代理 / 工作区分布）",
	session_trace: "看一个会话的祖先与后代关系",
	session_event_search: "在单个会话里按事件搜",
	session_event_read: "读一个完整事件（可带前后事件摘要）",
	session_event_trace: "读一个事件的替代与关联链路",
	session_dump: "把一个会话的全部帧解成 JSONL 文件",

	/* ── 宿主核心：插件管理 ── */
	plugin_manager: "装卸 / 启停插件与 bundle（会真改 profile）",
	install_hub_status: "插件安装面板体检（任务 / 已装 / 可升级）",
	install_hub_search_plugins: "确定性地搜插件与 Skill 候选（不花 token）",
	install_hub_submit_request: "提交一次安装请求给面板的流水线",
	install_hub_review: "对某个安装任务跑一次 AI 语义审查",
	install_hub_doctor: "安装环境 / profile 一次性体检与幂等修复",
	install_hub_probe_repo: "只读探针：这个仓库装上去会怎样",
	pack_check: "打包前的只读体检（csc / 本地插件 / profile）",
	pack_install: "把本地插件装进 profile（会写盘）",
	pack_installer: "把本地插件打成双击即装的 exe",

	/* ── dsh-diag（GUI 诊断）── */
	client_status: "问 DSH 渲染进程在不在线（最后取命令多久前 / 队列 / 报错）",
	client_eval: "在 DSH 渲染进程里执行一段 JS，把结果取回来",
	client_click: "在 DSH 界面里按选择器或文字点一个元素",
	client_snapshot: "给界面做一份开箱即用体检（DOM / 插件挂载 / 本地存储）",

	/* ── dsh-plugin-catalog（本插件）── */
	catalog_list: "列出全部插件 / Skill / MCP（来源四分类 + 调用量 + 加载态）",
	catalog_stats: "查调用统计（不传 id 给全局概览）",
	catalog_health: "目录面板自检（版本 / 路径 / 统计覆盖 / 缓存新鲜度）",
	catalog_handoff: "换会话前的交接单（11 项压成一个结论）",
	catalog_mcp: "列出 MCP 服务器，并指出孤儿调用与配置问题",
	catalog_composition: "读配置层的声明（哪些条目生效 / 关掉 / 条件启用）",
	catalog_runtime: "读运行期真相（Loader 的 fiberPhase 与声明层对账）",
	catalog_uninstall: "生成 / 预演 / 对账「不会被加载」的处置清单",
	catalog_review: "审一个插件（缺口分析 + 安全审核）",
	catalog_publish: "把自写插件备份到 GitHub 私有仓（计划 / 执行 / 公开）",
	catalog_tag: "标签管理（列出 / 打标 / 新增 / 删除自定义标签）",
	catalog_classify: "让模型给插件与 Skill 自动打标签",
	catalog_export: "把目录快照导出成 Markdown / CSV",
	catalog_skill_sync: "检查并同步 Skill 的两份副本（live ↔ staging）",

	/* ── dsh-screenshot（截图 / 录屏 / OCR）── */
	shot_health: "截图插件体检（助手在不在 / 代码是不是最新 / 显示器 DPI）",
	shot_gate: "截图插件验证闸门（一次跑完自检 / 覆盖层 / 长截图）",
	shot_probe: "跑截图插件的 dev 探针并汇总 PASS / FAIL",
	shot_preflight: "重启 DSH 之前，用磁盘上的代码验一遍",
	shot_bridge: "驱动正在运行的 DSH 客户端（状态 / eval / 点击 / 长截图）",
	shot_displays: "显示器 / DPI / 虚拟屏幕体检 + 越界抓屏实测",
	shot_owner: "查一个坐标归哪个窗口（WindowFromPoint）",
	shot_pixels: "像素探针（判黑图 / 找颜色 / 两图差异占比）",
	shot_reap: "录制残留体检 + 清理",
	shot_land: "收尾（自检 → 提交 → 推送）",
	testbed_refwin: "起一个已知内容的参照窗（验截屏 / 滚动拼接）",
	testbed_verify: "按内容校验一张长截图（色带序号是否连续）",

	/* ── dsh-plugin-botwatch（NapCat + AstrBot 监控）── */
	botwatch_status: "一眼结论：两盏灯 / 告警表 / 日志水位 / 运行面",
	botwatch_logs: "读实时日志环形缓冲（AstrBot + NapCat）",
	botwatch_plugins: "插件列表（用途 / 错误次数 / 调用次数 / 错误率）",
	botwatch_trace: "调用时间线（最近 N 轮判定、耗时、卡在哪个阶段）",
	botwatch_vex: "运行面：定时任务 / 模型用量 / 丢消息 / 响应耗时 / 自发消息",
	botwatch_selfcheck: "进程内验收（装配 / 两盏灯 / 日志 / 配置 / 采集）",
	botwatch_config: "读 / 改 BotWatch 的运行期配置",
	botwatch_storage: "`.state/` 留存现状（体积 / 备份 / 恢复计划）",
	botwatch_dev: "插件开发工作台（状态 / 骨架 / 装 / 重载 / 打包 / 验证）",

	/* ── Vex（AstrBot 上的 QQ 机器人）── */
	vex_config: "读 / 改 AstrBot 运行中的配置",
	vex_latency_report: "按天给模型段耗时（中位 / p90 / 最长）",
	vex_ledger_audit: "体检她的工具台账（假失败回填）",
	vex_log_timeline: "扫 AstrBot 日志，给某天某时间窗的时间线",
	vex_plugin_reload: "不重启 AstrBot，热重载指定插件",
	vex_probe: "读 vex_monitor 的低频探针（压缩 / 建请求 / 阻塞）",
	vex_qzone_media_audit: "体检 QQ 空间说说的配图（几张 / 还在不在）",
	vex_stages: "按轮次拆端到端耗时（攒批 / 建请求 / 模型 / 排队）",
	vex_topicgate_report: "汇总话题闸门某天的判定（放行 / 拦截理由）",
	vex_trace: "看 AstrBot 的 trace（一轮的 span 树）",
	vexvoice_status: "语音链路一眼结论（参数 / 耳朵 / 声纹 / 记忆体检）",
	vexvoice_audit: "语音到底是谁发的（主动占比 + 台账对账）",
	vexvoice_probe: "端到端语音体检（真合成 + 真回听，会花钱）",
	vexvoice_selftest: "跑语音插件的离线自检",
	vexvoice_audio: "音频客观指标（时长 / 峰值 / LUFS / 首尾静音）",
	vexvoice_identify: "给音频认人（对全部声纹档案打分）",
	vexvoice_enroll: "把音频录进声纹档案",
	vexvoice_speakers: "声纹档案（样本条数 / 最后更新）",
	vexvoice_chat: "往 webchat 真发一条消息，拿她的回复",
	vexvoice_tune: "音色调参（台账 / 离散度 / 候选链）",

	/* ── lemo-opuscar（用代码做片子）── */
	lemofilm_status: "影视管线体检（库路径 / 浏览器 / 三条已知坑）",
	lemofilm_stills: "渲静帧（宿主内起 Playwright）",
	lemofilm_video: "渲整段视频（逐帧截图 + ffmpeg 编码）",
	lemofilm_join: "把分段渲好的片子无损拼成一条（并证明拼对了）",
	lemofilm_mix: "把几十条台词一次铺到成片上（人声压住配乐）",
	lemofilm_mixdown: "整片混音（不依赖 numpy，画面流拷贝）",
	lemofilm_mux: "把配音时间轴铺到无声成片上",
	lemofilm_voice: "用固定角色音色批量合成台词",
	lemofilm_voicestats: "配音 take 的客观体检（时长 / 字速 / f0 / 响度）",
	lemofilm_bgm: "合成一条原创 BGM 床（版权干净）",
	lemofilm_audiofx: "声音小工序（变形窗 / 短音效）",
	lemofilm_align: "两轨音频对账（lag / corr / RMS 比）",
	lemofilm_rms: "按窗口比 RMS（差在人生还是垫乐）",
	lemofilm_level: "把一组片子拉到同一条响度线（不许削顶）",
	lemofilm_pauses: "量配音的发声区间与内部停顿位置",
	lemofilm_syllable: "数音节 / 查停顿落在第几个音节后",
	lemofilm_takecheck: "配音 take 的收尾体检（截断 / 尾辅音）",
	lemofilm_tighten: "把一条配音的内部停顿收短",
	lemofilm_splice: "按设计间隙把几条 take 拼成一条",
	lemofilm_words: "一句话里的词边界（给「说到某个词时上卡片」用）",
	lemofilm_speechmap: "台词 → 发声分组 SPK（配合台词节奏动嘴）",
	lemofilm_timeline: "从实测配音时长排整片时间轴",
	lemofilm_lintpage: "片页面的静态体检（秒混用 / 气泡 / 资源）",
	lemofilm_build: "在宿主里跑项目自己的 build.py",
	lemofilm_render: "渲一段片子（静帧 / 整段 / 整片 + 混音）",
	lemofilm_edit: "改片子的文案并立刻重拼页面",
	lemofilm_editor_status: "片子编辑器体检（能改什么 / 覆盖过什么）",
	lemofilm_attach: "把手写单文件片子接进编辑器",
	lemofilm_cover: "一份画稿 → B 站两种封面",
	lemofilm_sprite: "AI 字符表 → 像素精灵",
	lemofilm_spritecheck: "姿态图之间差多少（能不能当口型帧）",
	lemofilm_sprite_fix: "清掉精灵里悬空的孤立碎块",
	lemofilm_scan: "扫源素材的暗帧 / 冻结区间",
	lemofilm_redact: "截图脱敏（把私人区域糊掉）",
	lemofilm_blur: "给已录好的视频定点打码",
	lemofilm_maskcheck: "打码到底盖在哪（逐像素差分）",
	lemofilm_region: "先量后裁（量一块矩形的边界）",
	lemofilm_grid: "在截图/帧上叠按视频坐标标号的网格",
	lemofilm_bands: "按行找文字带（定位要打码的行）",
	lemofilm_inkband: "量文本框里的字居中了没有",
	lemofilm_view: "真机录屏里的一块 → 面板 view 的 cover 换算",
	lemofilm_clip: "按时间窗裁录屏并拼成一条",
	lemofilm_grab: "录一段屏幕（gdigrab）",
	lemofilm_fetch: "从 Lemo-Opuscar 仓库补文件到本地库",
	lemofilm_place: "逐句落点核对（台词是不是真落在 TL 上）",

	/* ── 影音 ── */
	ffmpeg_health: "ffmpeg 自检（可执行文件能不能用）",
	ffmpeg_probe: "探测媒体信息（时长 / 流 / 码率）",
	ffmpeg_encode: "转码输出（B 站 / 竖屏 / 网页预设）",
	ffmpeg_cut: "剪辑片段（流拷贝或精确重编码）",
	ffmpeg_concat: "拼接多段视频（可统一画布）",
	ffmpeg_frames: "从视频批量抽帧成图片",
	ffmpeg_extract: "提取音轨 / 单帧 / 字幕流",
	ffmpeg_adjust: "变速 / 音量 / 静音 / 旋转",
	ffmpeg_gif: "视频转高质量 GIF",
	ffmpeg_subtitle: "把字幕烧进画面（硬字幕）",
	video_analyze: "分析一个媒体 URL（是不是媒体 / 哪个站 / 清晰度）",
	video_download: "把一个媒体 URL 下载到磁盘",
	video_quality_parse: "从 URL 里解析清晰度与容器（不联网）",

	/* ── 看图 / 出图 ── */
	vision_describe: "用视觉模型看图并回答一个具体问题",
	vision_ocr: "从图片里逐字转写文字（本地 Tesseract 优先）",
	vision_ground: "在图片里定位一个目标，返回像素框",
	vision_detect: "找出图片里某一类元素（按钮 / 输入框…）",
	vision_crop: "按原图像素裁一块出来放大看",
	vision_pixel_diff: "两张图逐像素比较（差异占比 + 热力图）",
	vision_colors: "提取图片的主色板",
	vision_trace: "把图标 / logo 矢量化成 SVG",
	vision_materialize: "把上传的图片复制成会话工作区里的稳定文件",
	vision_present: "把生成的图片直接展示给用户",
	vision_bootstrap: "结构化预识别（先整体看一眼，再问具体问题）",
	vision_html_screenshot: "用无头 Chrome 渲染本地 HTML 并截图",
	vision_long_screenshot_ocr: "长截图切块 OCR 成有序 Markdown",
	modlens_read_image: "通过 modlens 视觉桥读一张图（含全文转写）",
	imgops_status: "图片流水线自检（Key / 输出目录 / 可用模型）",
	imgops_generate: "文生图并落盘到工作区",
	imgops_edit: "参考图 + 指令改图",
	imgops_finish: "成品后处理（去斑 / 提锐）",

	/* ── 模型路由 / 生图 API ── */
	ofm_status: "Our Free Model 现场快照（车道 / 可用性 / 默认模型）",
	ofm_recommend: "按任务维度给模型选型建议",
	ofm_smoke: "对本地网关打一次真实生成（量延迟 / 用量）",
	liblib_status: "LiblibAI 自检（密钥 / 预算 / 账本）",
	liblib_check: "零成本双探测（签名 / 账户权限）",
	liblib_diagnose: "零成本分层诊断（密钥错还是账户被拒）",
	liblib_generate: "LiblibAI 文生图（受预算闸门约束）",
	liblib_img2img: "LiblibAI 图生图",
	liblib_task: "查一个已提交任务的进度",
	liblib_quota: "刷新额度报告",

	/* ── 盘空间 / 系统 ── */
	diskreclaim_volume: "盘容量体检（各卷总量 / 剩余 / 配额差异）",
	diskreclaim_scan: "按深度分桶统计目录体积",
	diskreclaim_large_files: "定位大文件（可按最近 N 小时过滤）",
	diskreclaim_locks: "占用判定（为什么删不掉）",
	diskreclaim_bloat: "已知膨胀源体检（缓存 / 更新器 / 夸克 backup.db）",
	diskreclaim_relocate: "把目录搬到别的盘并留目录联接",
	diskreclaim_temp_sweep: "清理 %TEMP%（默认只预览）",
	diskcleaner_status: "C 盘一眼结论（剩余 / 可回收清单）",
	diskcleaner_plan: "C 盘清理预演（预计释放多少 + 令牌）",
	diskcleaner_apply: "执行一次 C 盘清理（真删）",
	diskcleaner_relocate: "目录迁移（预演 / 执行）",
	diskcleaner_dirs: "管理「自定义目录」设备",
	winperf_snapshot: "Windows 慢机采样（内存 / CPU / 磁盘 / 池）",
	winperf_startup: "开机自启审计（哪些能关）",
	winperf_shell: "资源管理器与外壳体检",
	winperf_ime: "输入法体检（第一下打不出中文的分诊）",
	winperf_report: "把四项体检合成一份 Markdown 报告",
	win_windows: "枚举可见窗口（句柄 / PID / 进程 / 矩形）",
	win_uia_find: "按 UIA 在窗口里查控件（返回精确矩形）",
	win_click: "在屏幕物理坐标上点击（可双击 / 置顶）",
	win_keys: "向当前焦点窗口发送按键",
	win_primary_button: "在窗口里找「蓝色主按钮」并可选点击",
	quark_ext_list: "列出夸克 profile 里装的扩展（含源目录）",
	quark_ext_load_unpacked: "把本地解压目录作为开发者扩展加载进夸克",
	rdp_status: "远程桌面现状（会话窗口 / 尺寸 / mstsc）",
	rdp_connect: "冷启动远程桌面连接并保持控制通道",
	rdp_shot: "截一张远程桌面会话的图",
	rdp_sh: "在远程桌面里跑一条只读命令并读回输出",

	/* ── dsh-* 体检 / 修复 ── */
	dsh_health: "DSH 健康体检（版本 / profile / pnpm / 保活 / 路径）",
	dsh_boot_guard: "DSH 启动期自愈体检 / 修复",
	dsh_plugin_audit: "插件加载契约体检（bundles 对账 / output / 崩溃日志）",
	dsh_plugin_update: "按 registry 升级第三方插件（默认只预览）",
	dsh_profile_config: "profile 配置快照 / 恢复",
	dsh_remote_status: "远程访问现状 + 四条路径延迟实测",
	dsh_usage_report: "读用量账本（这一轮花了多少 token / 钱）",
	dsop_client_check: "体检一个客户端插件 bundle（真实错误文本）",
	dsop_drift: "体检插件「现在跑的是哪份代码」",
	dsop_sync_installed: "把源码推进 profile 里装好的那份",
	dsop_pack_tgz: "把插件打成 npm 风格 tarball",
	dsop_fake_llm: "起本地假模型端点端到端验 LLM 链路",
	dsop_render_smoke: "在 Node 里真渲染一个客户端插件面板",
	uxkit_client_diag: "读浏览器那半边的体检快照（点了没反应先看它）",
	uxkit_sidebar_layout: "读 / 改侧栏插件排布",
	uxkit_media_probe: "体检影音文件「手机能不能直接播」",
	uxkit_media_to_phone: "转成手机一定能放的副本",

	/* ── 网页调研 / 素材版权 / MC / TKS ── */
	web_research_status: "网页调研插件体检（路由 / 客户端上报）",
	web_research_doctor: "硬结论（客户端 build / 路由 / 回程能力）",
	web_research_selftest: "跑九道闸门（不起窗口、不联网）",
	web_research_export: "把 Markdown 导出成 Word / 文件",
	web_research_relay: "人工接力待办（只准备，永不发送）",
	web_research_session_export: "把任意 DSH 会话导出成 md / docx",
	copyright_register: "登记一条素材的授权（算指纹 + 定风险）",
	copyright_check: "按登记号 / 链接 / 标题查素材能不能用",
	copyright_batch_audit: "批量审计整个素材库（A/B/C/D 分布）",
	copyright_attribution: "生成可直接粘贴的署名行",
	copyright_libraries: "列出低版权风险的素材来源库",
	copyright_export_report: "导出合规 Markdown 报告",
	copyright_scan_license_text: "离线解析一段授权协议文本",
	billfish_inspect: "检查 Billfish 素材库状态（能不能安全写入）",
	billfish_sync: "把版权核实结果同步成 Billfish 标签",
	mc_conn_triage: "「Vex 能进这个服吗」的诊断",
	mc_server_survey: "基岩版服务端只读体检",
	mc_cfsp_capabilities: "CFSP 假人系统能力清单",
	mc_players: "解码世界里每个玩家的记录",
	mc_levi_agg: "汇总 LeviLogger CSV（事件 / 人物 / 物品 / 死亡）",
	mc_maps_render: "用游戏内地图重建世界拼图",
	mc_mdmp: "无符号解析 Windows minidump",
	mc_lse_events: "从 LSE dll 里抽事件名表",
	mc_ldb_catalog: "只读 LevelDB 索引块，定位哪张表装了什么",
	mc_names_join: "把玩家记录与名字用本机所有来源对上",
	mc_skins_fetch: "从 GeyserMC 拉玩家皮肤 PNG",
	mc_skins_merge: "把拉到的皮肤并入角色卡库",
	mc_skins_report: "只读审计角色卡皮肤库",
	mc_vex_health: "Vex ↔ Minecraft 全链路体检",
	mc_vex_say: "以玩家身份打一次桥，拿她真正说的话",
	mc_vex_deploy: "生成主服部署副本并打印上服命令",
	mc_bundle_audit: "Vex 部署包完整性审计",
	tks_status: "TK 服务器总站一屏状态",
	tks_build: "跑完整重建链（生成单文件产物）",
	tks_verify: "跑产物复核脚本并汇总 OK / NG",
	tks_gate: "收官体检（作用域 / 引用 / 产物 / 日志 / 新鲜度）",
	tks_release: "交付前一条命令（重建 + 全套复核）",
	tks_audit: "11 角度回归审计（Playwright）",
	tks_layers: "贴图三层 + 纸边的静态体检",
	tks_styles: "十套风格现状（设计文件 / 是否装进构建）",
	tks_style_lint: "十套设计的「静默失效」体检",
	tks_skin_render: "皮肤 → 三视图 + 证件照",
	tks_perf_switch: "切卡性能 A/B（同页面开/关优化）",
	bili_post_lint: "B 站投稿字段体检（确定性规则）",
	bili_post_pack: "把投稿字段整理成可直接粘贴的包",
	bili_subtitle_build: "从片子工程生成 B 站可上传的 SRT",
	film_editor_status: "片子编辑器体检", 
	film_edit: "改片子文案并立刻重拼页面",
	film_render: "渲一段片子（静帧 / 视频 / 整片）",
	film_attach: "把手写单文件片子接进编辑器",

	/* ── 安全 / AstrBot 实例 ── */
	astrbot_venv_scan: "AstrBot 实例 venv 全景体检（只读）",
	astrbot_venv_holders: "哪个进程占着这个 venv（含删除探针）",
	astrbot_venv_refs: "找还有哪些外部项目把 venv 写死成解释器",
	astrbot_venv_release: "停占用并（可选）删 venv",
});

/** 前缀规则：精确表没命中时按名字前缀给一句「这一族是干什么的」。 */
const PREFIX_RULES = Object.freeze([
	[/^catalog_/, "插件目录面板的工具（清单 / 统计 / 判据 / 处置清单）"],
	[/^client_/, "dsh-diag 的 GUI 通道（读状态 / 执行 JS / 点击 / 快照）"],
	[/^shot_/, "dsh-screenshot 的截图 / 长截图 / 录屏工具"],
	[/^botwatch_/, "BotWatch 的监控与诊断工具"],
	[/^vex_/, "Vex（AstrBot 上的 QQ 机器人）的运维工具"],
	[/^vexvoice_/, "Vex 语音链路的工具（合成 / 听 / 声纹）"],
	[/^lemofilm_/, "用代码做片子的工具链"],
	[/^ffmpeg_/, "音视频处理"],
	[/^vision_/, "看图 / OCR / 图片处理"],
	[/^imgops_/, "出图 / 改图流水线"],
	[/^ofm_/, "模型路由（Our Free Model）"],
	[/^liblib_/, "LiblibAI 生图 API"],
	[/^dsh_/, "DSH 本体的体检 / 修复工具"],
	[/^dsop_/, "DSH 插件开发工作台"],
	[/^uxkit_/, "DSH 界面套件（侧栏 / 媒体兼容）"],
	[/^diskreclaim_/, "盘空间回收（只读判定为主）"],
	[/^diskcleaner_/, "C 盘清理面板（预演 / 执行 / 迁移）"],
	[/^win(perf)?_/, "Windows 桌面 / 性能工具"],
	[/^quark_/, "夸克浏览器扩展工具"],
	[/^rdp_/, "远程桌面工具"],
	[/^web_research_/, "网页调研插件"],
	[/^copyright_/, "素材版权合规"],
	[/^billfish_/, "Billfish 素材库"],
	[/^mc_/, "Minecraft 基岩版取证 / 运维"],
	[/^tks_/, "TK 服务器总站（单文件站点）的构建与验收"],
	[/^bili_/, "B 站投稿工具"],
	[/^film_/, "片子编辑器"],
	[/^session_/, "会话取证（读 DSH 的事件日志）"],
	[/^schedule_/, "定时提醒"],
	[/^job_/, "后台任务"],
	[/^terminal_/, "常驻终端会话"],
	[/^apply_patch$/, "按补丁改文件"],
	[/^(grep|glob)$/, "按内容搜 / 按通配找路径"],
]);

/**
 * 查静态说明。
 * @param {string} name 工具名（`mcp__<server>__<tool>` 请先剥掉前缀）
 * @returns {string} 中文一句；查不到返回空串（界面如实显示「还没有中文说明」）
 */
export function staticToolHint(name) {
	const key = String(name || "").trim();
	if (!key) return "";
	if (Object.prototype.hasOwnProperty.call(TOOL_HINTS, key)) return TOOL_HINTS[key];
	for (const [pattern, hint] of PREFIX_RULES) {
		if (pattern.test(key)) return hint;
	}
	return "";
}

/**
 * 合并：AI 生成（更贴这个条目自己）> 静态表 > 空串。
 * @param {string} name
 * @param {object<string,string>} aiHints 该条目的 AI 生成结果
 */
export function toolHintOf(name, aiHints) {
	const ai = aiHints && typeof aiHints === "object" ? aiHints[String(name || "")] : "";
	if (typeof ai === "string" && ai.trim() !== "") return ai.trim().slice(0, 80);
	return staticToolHint(name);
}

/**
 * 给一个条目的工具名列表生成 {name: hint}（只收有说明的）。
 * @param {string[]} names
 * @param {object<string,string>} aiHints
 */
export function hintsForTools(names, aiHints) {
	const out = {};
	for (const name of names || []) {
		const hint = toolHintOf(name, aiHints);
		if (hint) out[name] = hint;
	}
	return out;
}

/** 静态表覆盖了多少个工具（health / 文档用；不参与任何判断）。 */
export function toolHintCoverage() {
	return Object.keys(TOOL_HINTS).length;
}
