# dsh-plugin-catalog · Plugin Catalog Panel

[中文](README.md)


[English](README.en.md)


DSH sidebar "Plugin Catalog": lays out the local **plugins and Skills** as cards, classified into four source categories (official / self-written / third-party / hybrid),
uses the **session event log** to tally the last 90 days of each tool's call count, errors, duration and involved sessions (subagents marked separately),
supports custom tags + AI classification, weekly gap analysis and security review, and one-click private backup of self-written/hybrid items to GitHub.

> **The official plugin entry is kept and not hidden.** This plugin is an **independent client-side plugin**: disabling it restores the official interface (see "Self-rescue" at the end).
>
> The embedded review/publish Agent **is also registered as tools** (`catalog_*`), so it can be invoked in an ordinary session with one sentence:
> "review dsh-screenshot", "publish the dsh-catalog repo", "list my self-written plugins".

---

## Applicable profile

- `desktop` (the locally tested environment: DSH `0.2.x`, Windows)
- Any profile with the `tools` and `webServer` services works (the client half is a standard `web` platform bundle)
- Depends on the host's `llm` service (AI classification / translation / review); without it the panel still works, but those buttons report "AI channel unavailable"

## Installation

Install from a local directory (**do not use pnpm**, it will bury a stale `@deepseek-ai/dsh-tools` in the profile,
causing batch plugin loading to fail on the next startup):

```bash
node .tools/dsh-plugin-install.cjs install dsh-plugin-catalog "<插件目录>"
```

After installing you **must fully restart DSH** (`dsh.profile.bundles` and `cordis.patch.yml` are both read at startup).

After installing, check whether any mines were buried:

```bash
node .tools/dsh_doctor.py            # 只体检
node .tools/dsh_doctor.py --fix      # 有 dsh-tools 覆盖就移走
```

## Usage

### Panel

A "Plugin Catalog" icon appears in the sidebar (`sidebar.panellist` id = `catalog`). Clicking it opens:

- **Cards**: name, Chinese introduction (English original appended in small text), source badge, tags, creation/download time, total call count (with subagent breakdown)
- **Search**: filter by name / introduction / classification rationale
- **Filter**: source (all/official/self-written/third-party/hybrid/to-be-tagged) × type (all/plugin/Skill)
- **Sort**: call count / recently used / time / name
- **Popup** (click a card, centered on screen, close by clicking outside or pressing Esc):
  - Each tool's own call count, errors, average duration, most recent call, number of involved sessions
  - Session list: **session nickname** + count + whether a subagent (including parent session name), paginated, with selectable page size (10/20/50/100)
  - Source classification rationale (listing item by item why it was classified this way), tag editing, creation time, repo link
  - Self-written/hybrid items additionally have "Upload / Update to GitHub" and "Gap analysis"
  - A misclassified source can be manually tagged once (stored in `.dsh-plugin-catalog/overrides.json`, not asked again afterwards)

### Tools (the same capabilities, invoked directly in an ordinary session)

| Tool | One-liner |
|---|---|
| `catalog_list` | List all plugins and Skills (filterable by source/type/keyword) |
| `catalog_stats` | Global overview, or a specific entry's per-tool breakdown + session list |
| `catalog_tag` | List tags / apply tags / add a custom tag (explanation required) / delete a tag / **manually change source** (`action=source`) / **manually change tool ownership** (`action=tool-owner`) |
| `catalog_classify` | AI automatic tagging (reads custom tag explanations) |
| `catalog_review` | Review a plugin (gap analysis + security review, suggestions only) |
| `catalog_publish` | Upload backup: `plan` → `apply` (requires `planId` + `confirm`, may include `ackRepos`) → `public` (separate gate) |
| `catalog_export` | **Export a Markdown snapshot** to `<数据目录>/reports/`: inventory, source distribution, call Top, repos and git status, to-be-tagged sources, attribution coverage, weekly findings |
| `catalog_health` | Self-check: which version is running, path resolution, stats coverage, attribution coverage, AI channel, asar mode |

## Data and privacy

Everything lives in the **workspace** `.dsh-plugin-catalog/` (not in the plugin install directory — lost on upgrade/reinstall):

| File | Content |
|---|---|
| `cache/stats.json` | 90-day call statistics (sharded by session for incremental refresh) |
| `cache/catalog.json` | Plugin/Skill snapshot (source classification, time, repo) |
| `cache/attrib.json` | Tool→plugin attribution index |
| `tags.json` | Custom tags (with explanations) and each entry's tags |
| `overrides.json` | Sources and tool ownership you manually tagged |
| `intros.json` | Chinese introduction cache (manually editable) |
| `weekly.json` | Last execution time and result of the weekly task |
| `settings.json` | Settings |

**Red line: the statistics contain only session ID, session nickname, timestamp, tool name, count. No conversation text whatsoever.**
Tool arguments are read only once, when parsing `skill` calls to get the skill name, then discarded.

Statistics methodology:

- Only reads `.dsh/sessions/**/session*.zstd`, and **never scans** million-file-scale snapshot directories like `.dsh/dsh-checkpoint-rewind/`.
- A session may have both v3 and v4 logs (36 of the 772 local sessions do); they are **deduplicated by callId**, so calls are not counted twice.
- First open does not block the frontend: the cache is shown first, computation happens in the background (811 local logs / 455 MB / 59,813 calls, full run about **40~60 seconds**);
  afterwards the cache is used, **incremental refresh takes about 0.5 seconds**.
- If the cache is older than 24 hours, the UI shows "refresh recommended"; it is not recomputed automatically (so you don't think it's stuck).

## How the four source categories are determined

| Source | Criteria (filesystem facts, not persona) |
|---|---|
| Official | `@deepseek-ai/*` scope; or declared in `dsh.profile.bundles` with code inside the host `app.asar` |
| Self-written | ① the entry in the profile is a **junction/symlink** and the real path is in the workspace (22 measured) ② or the `author` in `package.json` matches your own account ③ or the real path is under the workspace's `DSH-Plugin/`, `.gh-upload/` |
| Third-party | The rest |
| Hybrid | On any of the above, **has `.git` + origin points to a non-your repo + a diff can be computed** (workspace dirty, or local ahead of upstream commits) |

The "self-written" criterion for Skills is: a directory with the same name exists in `.gh-upload/my-dsh-skills/` (the self-written collection repo).

**Honest boundary**: packages installed from npm and then **modified in place** **cannot be determined automatically** by this tool — node_modules has no `.git`,
and there is no published-package hash to compare against. These are marked "to be confirmed" or require you to tag once manually; once tagged they are stored in `overrides.json` and not asked again.

## Where it is used (relationship with other local plugins)

- Tool ownership is **inferred**: `ctx.tools.schemas()` only gives name/description/parameters; the host has **no** tool→plugin registry
  (`ToolService` splits layers by agent scope, unrelated to plugins). So two evidence chains are used:
  ① description fingerprint (that description is verbatim from the source code of the plugin that registered it; a unique hit attributes it to that plugin);
  ② when there is no description, fall back to the `name: '<tool>'` literal (weak evidence).
  If a description exists but nothing anywhere matches ⇒ classified as **host core/official**, listed **separately** in the panel, not counted in any plugin card.
- **Measured coverage (196 local tools / 53,759 calls)**: description fingerprint 193 (**85.2% of calls**),
  name literal 1, classified as host 2 (`plugin_manager` / `exit_plan_mode`), **0 ambiguous, 0 unattributed**.
  So the "total call count" on cards is accumulated by real attribution, not guessed by name.
  ⚠️ Key detail: descriptions in plugin source code are often split by **multi-line string concatenation**; searching the source with the assembled sentence
  will never find it (that is how a bunch of self-written plugins was initially misclassified as "host"). So both sides are **flattened** (whitespace/quotes/plus signs/escapes removed)
  before comparison; `dev/audit.mjs` has regression cases for concatenation and escaped `\n`.
- The official tool package is inside `app.asar` (77 `dsh-tool-*`), read via the asar index to participate in attribution — otherwise
  65% of calls would hang on an "unknown source".
  ⚠️ Electron treats `app.asar` **as a directory**; `openSync` on the archive itself fails; `lib/asar.mjs` automatically distinguishes
  "virtual mode (in the host, via member paths)" and "header mode (pure node)"; `/health` reports the current mode.

## Publishing to GitHub (self-written / hybrid)

One overall button: "Upload backup to GitHub" → **a plan is produced first** (nothing is touched) → pushed only after you confirm.

- Naming: self-written `dsh-<name>`; hybrid `dsh-<name>-local` (does not overwrite the original repo)
- **All repos are private by default**; the entire plugin has one repo-creation site with `--private` hardcoded
- **No force push** (there is no `--force` path in `lib/gitops.mjs`)
- **Stop on secret hits**: scans `.env`, `.env.*`, `secrets/`, `*.key`, `*.pem`, `configs/*-secret.json`,
  `configs/*-config.json` and common token/private-key/connection-string patterns; repos with critical/high hits are **skipped**, the rest are pushed as usual,
  and a "not pushed list" is given at the end. The list gives only "file:line + rule + mask + one-line judgment", **never echoes plaintext**.
- English and Chinese README versions: the English version is translated by AI per the spec (one-to-one sections, proper nouns kept in original,
  code blocks and placeholders verbatim, "待补充" → `TBD`); **if there is nothing needing English, none is generated** (English README, too little body text, or only a "待补充" skeleton are all not generated).
- Making public is **a separate operation** (`catalog_publish action=public`): requires `confirm:true`, and **rescans first**,
  rejecting outright on any hit.

## Weekly task

When the panel is opened, if more than 7 days have passed since the last run, a gap analysis runs **in the background** (does not block the UI).
Security review **does not run automatically** — the panel shows a "Security review (due)" button for you to click (it reads source code snippets, is more expensive, and needs you present).

- Gap analysis dimensions: which key sections the README lacks, whether build artifacts should be committed, whether `package.json` has a self-contained install command,
  whether **host core packages** are mistakenly written into `dependencies` (would shadow the host and cause batch plugin loading to fail), whether the Skill's `description` is sufficient
- Security review dimensions: whether `pull_request_target` / `workflow_run` checkout and execute fork code, whether `GITHUB_TOKEN` has least privilege,
  suspicious `eval` / concatenated `spawn`, dependency clues. Findings are given by "file + line number", sorted by confidence, each with "adoptable / rejectable"

## Known limitations (stated honestly, not exaggerated)

1. **Private repos do not get platform-level security scanning**: GitHub's Secret Scanning / Dependabot / Push Protection require paid GHAS.
   So "known vulnerable dependency" relies only on local rules and model common sense, **less accurate than platform-level scanning**.
2. **Skill call statistics only go as far as "count + last call time"**, and cannot be broken down by session — this is a mechanism limitation, noted in the UI.
3. **Private repos on free personal accounts have no "read-only sharing" tier**: either private (only you/invited collaborators) or public (readable by everyone).
   Fine-grained permissions require an Organization.
4. **Tool ownership is inferred**, but measured coverage is very high (193 of 196 tools uniquely matched by description fingerprint, covering 85.2% of calls;
   0 ambiguous, 0 unattributed). The remaining 2 are classified as host core (`plugin_manager` / `exit_plan_mode`),
   and tool ownership can still be overridden manually in the panel.
5. **Ecosystem data such as stars/downloads is not collected** (this plugin does not go online, it only reads local facts).

## Troubleshooting: plugin installed and panel appears, but no tools/routes

This is a failure mode this plugin actually hit once; **check in this order first**:

1. `plugin_manager action=list_plugins` (or the `plugin_diagnose` tool) to see the **`fiberPhase`** of `include:plugin-catalog`:
   - `active` = normal;
   - `failed` = `apply()` threw (in this case **the client half usually still renders normally**, because the client bundle and host half
     are two separate loading paths — don't be fooled by "the icon is there");
   - `null` = not enabled.
2. Get the raw error: `plugin_manager action=set_plugin target=include:plugin-catalog enabled=true`
   — the response's `diagnostic` writes `TypeError: ...` directly.
3. Look at `<数据目录>/logs/apply-trace.log` (**step-by-step trace of each apply**: which step it reached is obvious at a glance)
   and `apply-error.json` (written only on initialization failure).
4. Confirm end-to-end whether the route is alive: in the GUI console or `client_eval`,
   `fetch('/plugin-catalog/health').then(r=>r.json())` — normal should return 200 and a build marker;
   404 with empty body means the route was not registered (for comparison: `/plugin-installer/health` should always be 200).

**Two known forms that cause `failed`** (both hit on real machines, ordered by "most expensive"):

1. **`apply` is async but `return`s a value** ← the real culprit, the most hidden.
   cordis's `Fiber._execute()` collects apply's return value as an **effect disposer** —
   `safeCollect`: if it is not a function and not null/undefined, it `throw TypeError("Invalid effect")`,
   and an async apply goes through `effect.then(safeCollect)`. So **the entire apply succeeds**
   (tools registered, routes mounted, background tasks started) and then the promise resolving throws,
   and `_reload`'s catch marks the fiber INACTIVE → **the registered tools and routes are rolled back entirely**.
   Symptom: every step in `apply-trace.log` is OK, yet "did not activate", all tools gone, routes 404,
   and the host only writes to console, not to a log file.
   → **always `return;` in async apply**; to expose a service, go through ctx, not the return value.
2. It is recommended to register `ctx.effect(...)` in the **synchronous phase** of `apply()` (this plugin puts cleanup on the first line,
   using mutable variables to collect route/tool disposers). This is a **defensive convention** — the empirical cause of `Invalid effect`
   on real machines is the previous item; don't fixate only on effect timing.

Another equally silent pitfall: **reading `ctx.xxx` directly without declaring it in `inject`**. cordis's context is a Proxy,
which throws `cannot get property "llm" without inject` (optional chaining `ctx?.llm` cannot save you; the throw happens in the get trap).
Always use `ctx.get(name)` to read optional services (cordis's original comment: *Read a service from the store without the
inject requirement*), which is exactly what this plugin's `lib/ai.mjs::readService()` does.

### Model calls: reasoning effort and `maxTokens` share one budget

`deepseek-flash` defaults to `reasoningEffort: high`, and reasoning tokens **share the same `maxTokens`** as the body text.
Long-text tasks (translating a whole README into English) will spend the budget on reasoning → the body is either **an empty stream** or
truncated by `max-tokens` (the text looks like it has content but is incomplete; that is how English sections end up mismatched). `askLlm` only accumulates
`text-delta`; the reasoning segments are discarded anyway, so **it is completely invisible from the text side**.

This plugin's approach: pass `reasoningEffort: "off"` for translation tasks, and record `finish.kind` and
`usage.reasoningTokens` in the failure reason. `FinishReasonMap` only has
`stop / tool-calls / max-tokens / aborted / error` — **truncation is `max-tokens`, don't guess `length`**.
(Measured: 11 of 24 repos silently lacked English READMEs because of this; after dropping to `off`, all remaining 5 succeeded on the first try.)

Another self-reinforcing loop: the freshness criterion for the English README is `mtime(en) >= mtime(zh)`, and the flow is "write English first,
then add cross-links to Chinese" — Chinese becomes newer immediately, and the next plan asks for translation again. See `lib/publish.mjs` for the fix
(after adding cross-links, `utimes` refreshes the English timestamp).

## Self-rescue (when the interface goes wrong)

This plugin is an **independent client-side plugin**; disabling it restores the official interface:

- Remove `"dsh-plugin-catalog"` from `dsh.profile.bundles` in the profile's `package.json`, restart DSH;
- Or use the plugin install panel to disable it.

It **does not hide or modify the official plugin entry**: the official "Plugins" page is still in its original position in `sidebar.panellist`; this site only **adds** an item.

## Self-check

```bash
node dev/audit.mjs         # 自洽：默认值冻结/工具契约/规则覆盖/去重/命名/门禁/双语 README 流程（172 项，沙箱可跑）
node dev/render-check.cjs  # 界面：卡片内容/搜索排序/浮窗/分页/计划浮窗/空态（65 项，无需 DSH）
node dev/preview.mjs       # 版式：生成静态预览（真实组件树 + 真实 CSS），供浏览器截图看
```

Host side (no need to restart DSH):

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

Why `dev/preview.mjs` exists: headless self-checks can only verify structure/copy, not **layout** (whether the popup is centered,
whether the card grid is squeezed into a single column, whether badges overflow in narrow cards). It serializes the component tree into HTML and injects the same CSS;
open it with any static server and screenshot; locally it caught problems only visible after rendering, such as "markdown asterisks leaking into plain text".

Why `dev/probe-gitops.mjs` exists: upload is the hardest part to verify in a sandbox (subprocess spawn is disabled),
and real repos cannot be used for experiments — so it really runs once in a temporary repo, covering edge cases like "a new repo not yet committed for the first time".

## License

MIT.

README
