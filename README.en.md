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

- **Cards**: name, introduction (Chinese preferred; when there is no Chinese text the English is used as the body, instead of stamping a placeholder line on every card), source badge, tags, creation/download time, total call count (with subagent breakdown)
- **Search**: name / introduction / classification rationale, **and tool names** — typing `acp_status` or `catalog_export` jumps straight to the plugin that provides it (the card then shows "Tools: xxx")
- **Insight bar**: five chips — all / used / unused / with-errors / **subagent-only** — carry the counts, and one click filters by them (a chip whose count is 0 is **dimmed but kept**, so you can see "nobody on this machine is like that"; clicking it shows the empty state plus the explanation). Each chip has a one-line explanation on hover. The numbers only follow the **source / type** filters, never the keyword, so opening "unused" cannot make the counts collapse to 0 and look like data loss. "Subagent-only" means every call happened inside a subagent session: deleting such an entry **fails silently rather than loudly** — the next delegated run just gets worse
- **Filter**: source (all/official/self-written/third-party/hybrid/to-be-tagged) × type (all/plugin/Skill)
- **Sort**: call count / **error count** / **error rate** / **size** / recently used / time / name
  (The rate exposes what counts hide: on this machine `@liustack/modlens` failed 6 out of 6 calls = 100%, while `dsh-vision-router` had the most raw errors, 23, yet sits at a healthy 9% of 252 calls.)
- **View memory**: filter / query / sort / page / page size / **scroll position** are kept in localStorage, so the panel comes back exactly where you were after a hot reload (client code change) or a page refresh; changing a filter or page scrolls back to the top, because otherwise the first card of page 2 lands off-screen. A disabled or corrupt storage falls back to the default view instead of breaking the panel
- **Selection batches**: the "Select" button enters selection mode; clicking a card selects it (click again to deselect), and selected cards get a blue outline plus a check badge. The batch bar shows **N selected · ~X MB** (sizes are asked in one batch, the server fans out four at a time; entries without their own directory are called out as "N have no separate directory, counted as 0") and offers "Export selected", "Select current N" and "Clear". The selection **survives filter changes** (pick a few unused ones, switch to with-errors, pick a few more), but it is **not written to localStorage** — clearing it on reload is deliberate, so half a batch never lingers unnoticed
- **Export this view**: the "Export these N" button on the right of the toolbar writes the **current filter result** (screen order, filter conditions, error rate, install location) to `reports/catalog-filtered-<timestamp>.md` and shows the copyable path; it is disabled when the result is empty. For a full snapshot (source breakdown, call top, attribution coverage) use `catalog_export` instead
- **Size (a first-class field)**: every card carries a size chip, the list can be sorted by **size**, and the toolbar shows the **total for the current filter** (click "unused" and you immediately see how much deleting that batch would reclaim). The data comes from a background full snapshot (`cache/sizes.json`; ~1.5 s for 120+ directories, triggered by the panel itself, plus a "Measure sizes / Re-measure" button in the header). Three honest rules:
  - **unmeasurable entries show nothing** — never "0 B". Official packages live inside `app.asar` (`realDir` is a virtual member path, so recursion must return 0); their popup says "inside the official asar, no separate directory (size counted inside the DSH installation)";
  - **Skills have their own size too** (using the catalog's `dir`, never the skills root — using the root is a false alarm);
  - entries exceeding the 1.5 s / 20,000-file budget are marked with **"+"**: the number is a lower bound, and the total says so as well.
  In the popup it still uses the lazy `/size` route (measures only the opened entry, 5-minute cache) and **never runs during catalog builds** —
  recursively sizing 71 packages would push panel opening from seconds to tens of seconds; junctions and symlinks are **never followed** (following them can leave the profile or even loop)
- **Copy sync**: a banner plus per-card badges answer **"is the copy I edit the copy that is loaded?"**
  For plugins it compares four key files (`package.json` / `index.js` / `client.js` / `cordis.patch.yml`) by size + mtime; for Skills it compares `SKILL.md`.
  A junction-installed plugin simply says "one copy only — edit the source and it takes effect". When copies disagree the badge reads "副本不同步 / 副本较旧 / 工作区较旧",
  and a Skill's staged copy reads "staging 不同步" — **publishing pushes the staged copy, so a stale stage means you ship an old version**.
  The scan is cached for 60 s and invalidated by a catalog rebuild; it compares lengths and timestamps only, never file contents, so 71 packages cost well under 100 ms
- **Shortcuts**: `/` focuses the search box, `Esc` clears it (inside the popup `Esc` closes the popup)
- **Cache self-healing**: when the statistics cache is older than 10 minutes and no job is running, the panel starts one **incremental** refresh by itself (only changed session logs are re-read; measured 0.4–0.7 s). It never stacks with the 20-second polling, and a mount that already refreshed once does not trigger again
- **Pagination**: a bar under the list shows "N items · page X / Y" with previous/next/first/last, and **12 / 24 / 48 / 96 / all** per page; changing search, filter, or sort jumps back to page 1
- **Appearance**: dark and light themes share one local palette mixed from `label-primary`, so dark mode no longer shows harsh white outlines; hovering a card emits a soft **Klein Blue `#002FA7`** glow around its edge, and keyboard `:focus-visible` gets the same blue ring
- **Popup** (click a card, centered on screen, close by clicking outside or pressing Esc):
  - Each tool's own call count, errors, average duration, most recent call, number of involved sessions
  - Session list: **session nickname** + count + whether a subagent (including parent session name), paginated, with selectable page size (10/20/50/100)
  - Source classification rationale (listing item by item why it was classified this way), tag editing, creation time, repo link
  - "Location and install form" (plugins) and "Location and size" (Skills): the source directory (one-click copy), whether it is a junction or a real copy inside the profile, and its **disk size and file count** — the first thing to look at when a plugin is installed but does not work, and also when deciding whether to delete it
  - Self-written/hybrid items additionally have "Upload / Update to GitHub" and "Gap analysis"
  - A misclassified source can be manually tagged once (stored in `.dsh-plugin-catalog/overrides.json`, not asked again afterwards)

> ⚠️ **The panel must scroll itself**: DSH's official center column (`div._centerCol`) is
> `overflow:hidden`. If the panel does not set `height:100% + overflow-y:auto`, everything past
> the first screen is **silently clipped** — which looks like "no scrollbar and no way to reach
> the bottom". This is now pinned by assertions in `dev/audit.mjs`; regressing it fails the audit.

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
| `catalog_health` | Self-check: which version is running, path resolution, stats coverage, attribution coverage, AI channel, asar mode, **whether copies are in sync** |
| `catalog_skill_sync` | A Skill has **two copies**: `plan` lists those whose staging copy is stale (publishing pushes staging, so a stale stage ships an old version); `apply` + `confirm:true` copies **live → staging only**, backing up each overwritten file as `SKILL.md.bak-<timestamp>` first |

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
6. **Official packages (inside the asar) have no measurable disk size**: they live inside the host installation, have no separate directory,
   and are therefore excluded from the list and the totals. To know how much they occupy, look at the size of the DSH installation itself.
7. **The size snapshot is "as of the last measurement"**: installing, deleting or upgrading a plugin is not reflected immediately —
   it is re-measured automatically after 24 hours, or on demand via "Re-measure" (which overwrites the snapshot).
8. **Size measurement has a budget**: at most 20,000 files / 1.5 s per directory. Entries beyond that report a lower bound
   (marked with "+" in the UI; one entry on this machine). This keeps a single huge directory from stalling the whole run.

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
node dev/audit.mjs         # self-consistency: frozen defaults / tool contracts / rule coverage / dedupe / naming / gates / bilingual README flow + client style and behaviour contracts (262 checks, runs in the sandbox)
node dev/render-check.cjs  # UI: card content / search (incl. tool names) / insight bar / sorting (incl. size) / pagination / popup / size states / selection batches / copy sync / export / empty states (127 checks, no DSH needed)
node dev/preview.mjs       # layout: renders a static preview (real component tree + real CSS) for screenshotting in a browser
```

Host side (no DSH restart needed):

```bash
node dev/hosttest.mjs      # real apply() against a fake ctx: routes / tool contracts / stats / tags / AI paths / gates / synchronous effect constraint / async apply return-value check / list item fields / recursive size + cache / size snapshot (incl. asar and Skill rules) / batch sizes / export write / copy-sync verdicts / skill_sync plan and confirm gate (135 checks)
node dev/probe-gitops.mjs  # real init/commit/push-failure/ignore runs in a temporary repo (23 checks, never touches a real repo, no network)
node dev/probe-asar.mjs    # whether official plugins can be read out of app.asar (Electron's asar is a "directory")
node dev/measure-attrib.mjs  # measures attribution coverage against the real tool schemas
node dev/probe-publish.mjs   # dry-runs the upload plan (creates no repo, commits nothing, pushes nothing)
node dev/probe-export.mjs    # exports a Markdown snapshot of real data into reports/
node dev/probe-init.mjs      # measures startup cost (milliseconds for init/state/entryDetail)
node dev/warm-cache.mjs      # warms the real data directory so the first open already has data
```

Why `dev/preview.mjs` exists: headless self-checks can only verify structure/copy, not **layout** (whether the popup is centered,
whether the card grid is squeezed into a single column, whether badges overflow in narrow cards). It serializes the component tree into HTML and injects the same CSS;
open it with any static server and screenshot; locally it caught problems only visible after rendering, such as "markdown asterisks leaking into plain text".

Why `dev/probe-gitops.mjs` exists: upload is the hardest part to verify in a sandbox (subprocess spawn is disabled),
and real repos cannot be used for experiments — so it really runs once in a temporary repo, covering edge cases like "a new repo not yet committed for the first time".

## License

MIT.

README
