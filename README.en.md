# dsh-plugin-catalog · Plugin Catalog panel

[中文](README.md)


The DSH sidebar "Plugin Catalog": lays out this machine's **plugins and Skills** as cards, split into four source categories (official / self-written / third-party / hybrid), uses the **session event log** to tally each tool's call count, errors, duration and sessions involved over the last 90 days (subagents marked separately), supports custom tags + AI classification, weekly gap analysis and security review, plus one-click private backups of self-written / hybrid items to GitHub.

> **The official plugin entry stays visible and is not hidden.** This plugin is an **independent client plugin**: disabling it restores the official UI (see "Self-rescue" at the end).
>
> The embedded review/publish Agent is **also registered as tools** (`catalog_*`), so one sentence in a normal session brings it up:
> "review dsh-screenshot", "publish the dsh-catalog repo", "list my self-written plugins".

---

## Applicable profiles

- `desktop` (the locally tested environment: DSH `0.2.x`, Windows)
- Any profile with `tools` and `webServer` services works (the client half is a standard `web` platform bundle)
- Depends on the host's `llm` service (AI classification / translation / review); without it the panel still works, only those buttons report "AI channel unavailable"

## Installation

Install from a local directory (**do not use pnpm** — it buries a stale `@deepseek-ai/dsh-tools` in the profile, which makes bulk plugin loading fail on the next start):

```bash
node .tools/dsh-plugin-install.cjs install dsh-plugin-catalog "<插件目录>"
```

After installing you **must fully restart DSH** (`dsh.profile.bundles` and `cordis.patch.yml` are both read at startup).

After installing, check whether anything got buried:

```bash
node .tools/dsh_doctor.py            # health check only
node .tools/dsh_doctor.py --fix      # move any dsh-tools override out of the way
```

## Usage

### Panel

A "Plugin Catalog" icon appears in the sidebar (`sidebar.panellist` id = `catalog`). Clicking it opens:

- **Cards**: name, Chinese intro (the English original follows in small text), source badge, tags, creation/download time, total call count (with the subagent split)
- **Search**: filter by name / intro / rationale
- **Filter**: source (all / official / self-written / third-party / hybrid / unmarked) × type (all / plugin / Skill)
- **Sort**: call count / recently used / time / name
- **Popup** (click a card; centered on screen; closes on an outside click or Esc):
  - Each tool's own call count, errors, average duration, most recent call, number of sessions involved
  - Session list: **session nickname** + count + whether it is a subagent (including the parent session name), paginated, with selectable page size (10/20/50/100)
  - Source rationale (item by item, why it was judged this way), tag editing, creation time, repo link
  - Self-written / hybrid items additionally have "Upload / update to GitHub" and "Gap analysis"
  - A misjudged source can be marked manually once (stored in `.dsh-plugin-catalog/overrides.json`, not asked again afterwards)

### Tools (the same capabilities, called directly from a normal session)

| Tool | In one sentence |
|---|---|
| `catalog_list` | List all plugins and Skills (filterable by source / type / keyword) |
| `catalog_stats` | Global overview, or the per-tool breakdown + session list for one entry |
| `catalog_tag` | List tags / apply tags / add a custom tag (must give an explanation) / delete a tag / **manually change the source** (`action=source`) / **manually change tool ownership** (`action=tool-owner`) |
| `catalog_classify` | AI auto-tagging (reads the custom tag explanations) |
| `catalog_review` | Review a plugin (gap analysis + security review, suggestions only) |
| `catalog_publish` | Upload backup: `plan` → `apply` (needs `planId` + `confirm`, may carry `ackRepos`) → `public` (separate gate) |
| `catalog_export` | **Export a Markdown snapshot** to `<数据目录>/reports/`: inventory, source distribution, top calls, repos and git status, unmarked sources, ownership coverage, weekly findings |
| `catalog_health` | Self-check: which version is running, path resolution, stats coverage, ownership coverage, AI channel, asar mode |

## Data and privacy

Everything lands in the **workspace** under `.dsh-plugin-catalog/` (never in the plugin install directory — that is lost on upgrade/reinstall):

| File | Contents |
|---|---|
| `cache/stats.json` | 90-day call stats (sharded by session, to allow incremental refresh) |
| `cache/catalog.json` | plugin/Skill snapshot (source determination, time, repo) |
| `cache/attrib.json` | tool→plugin ownership index |
| `tags.json` | custom tags (with explanations) and the tags of each entry |
| `overrides.json` | the sources and tool ownership you marked manually |
| `intros.json` | Chinese intro cache (hand-editable) |
| `weekly.json` | last run time and result of the weekly task |
| `settings.json` | settings |

**Red line: the stats contain only session ID, session nickname, timestamp, tool name and count. No conversation text at all.**
Tool arguments are read once only when parsing `skill` calls to get the skill name, then discarded.

Statistics scope:

- Reads only `.dsh/sessions/**/session*.zstd`, and **never scans** million-file-scale snapshot directories such as `.dsh/dsh-checkpoint-rewind/`.
- A single session may have both a v3 and a v4 log (36 of the 772 sessions on this machine); calls are deduplicated by **callId**, so they are not counted twice.
- The first open does not block on the foreground: cached data is shown first and the computation runs in the background (811 logs / 455 MB / 59,813 calls on this machine, about **40–60 seconds** for a full pass); afterwards the cache is used, with **incremental refresh around 0.5 seconds**.
- If the cache is older than 24 hours the UI shows "refresh recommended"; it never recomputes automatically (so you don't think it has hung).

## How the four source categories are determined

| Source | Criteria (filesystem facts, not what it claims to be) |
|---|---|
| Official | `@deepseek-ai/*` scope; or declared in `dsh.profile.bundles` with the code inside the host's `app.asar` |
| Self-written | ① the entry in the profile is a **junction/symlink** and the real path is in the workspace (22 measured) ② or the `author` in `package.json` matches my own account ③ or the real path is under `DSH-Plugin/` or `.gh-upload/` in the workspace |
| Third-party | everything else |
| Hybrid | on any of the above bases, **has `.git` + an origin pointing at a repo that isn't mine + differences can be detected** (dirty workspace, or local commits ahead of upstream) |

A Skill counts as "self-written" when a directory of the same name exists in `.gh-upload/my-dsh-skills/` (the self-written collection repo).

**Honest boundary**: packages installed from npm and then **modified in place** cannot be determined automatically by this tool — there is no `.git` in node_modules, and no published-package hash to compare against. These are marked "to be confirmed" or need one manual mark from you; once marked they are stored in `overrides.json` and not asked again.

## Where it's used (relationship to other plugins on this machine)

- Tool ownership is **inferred**: `ctx.tools.schemas()` gives only name/description/parameters, and the host has **no** tool→plugin registry (`ToolService` layers by agent scope, unrelated to plugins). So two evidence chains are used:
  ① description fingerprint (that description comes verbatim from the source of the plugin that registered it; a unique hit means it belongs to that plugin);
  ② when there is no description, fall back to the `name: '<tool>'` literal (weak evidence).
  If there is a description but it can't be found anywhere ⇒ judged as **host core / official**, listed **separately** in the panel, and not counted into any plugin card.
- **Measured coverage (196 tools / 53,759 calls on this machine)**: 193 by description fingerprint (**85.2% of call volume**),
  1 by name literal, 2 judged as host (`plugin_manager` / `exit_plan_mode`), **0 ambiguous, 0 unattributed**.
  So the "total call count" on a card is accumulated by real ownership, not guessed from names.
  ⚠️ Key detail: descriptions in plugin source are often split apart by **multi-line string concatenation**; taking the assembled sentence and searching the source directly
  will never find it (that is exactly how a bunch of self-written plugins were initially misjudged as "host"). So both sides are **flattened** (whitespace/quotes/plus signs/escapes removed)
  before comparing; `dev/audit.mjs` has regression cases for concatenation and escaped `\n`.
- The official toolkits are inside `app.asar` (77 `dsh-tool-*`) and are read out via the asar index to take part in ownership determination — otherwise
  65% of the call volume would hang on a single "unknown source".
  ⚠️ Electron treats `app.asar` **as a directory**; opening the archive itself with `openSync` fails; `lib/asar.mjs` automatically distinguishes
  "virtual mode (inside the host, uses member paths)" from "header mode (plain node)", and `/health` reports the current mode.

## Publishing to GitHub (self-written / hybrid)

A single overall button: "Upload backup to GitHub" → **a plan comes out first** (nothing is touched) → it only pushes after you confirm.

- Naming: self-written `dsh-<name>`; hybrid `dsh-<name>-local` (does not overwrite the original repo)
- **All repos are private by default**; the whole plugin has exactly one place that creates repos, and it hardcodes `--private`
- **No force push** (there is no `--force` path in `lib/gitops.mjs`)
- **Stop on a secret hit**: scans `.env`, `.env.*`, `secrets/`, `*.key`, `*.pem`, `configs/*-secret.json`,
  `configs/*-config.json` and common token / private-key / connection-string patterns; repos hitting critical/high are **skipped**, the rest are pushed as usual,
  and a "not pushed list" is given at the end. The list only gives "file:line + rule + mask + a one-line judgement", and **never echoes plaintext**.
- README in both Chinese and English: the English version is translated by AI according to the spec (sections one-to-one, proper nouns kept in the original,
  code blocks and placeholders as-is, "待补充" → `TBD`); **nothing is generated when there is nothing that needs English** (no English README, body too short, or only a "待补充" skeleton — none of these are generated).
- Publishing publicly is **a separate operation** (`catalog_publish action=public`): it requires `confirm:true` and **rescans first**;
  any hit is rejected outright.

## Weekly task

When the panel is opened and more than 7 days have passed since the last run, gap analysis runs once **in the background** (it does not block the UI).
Security review is **not run automatically** — the panel shows a "Security review (due)" button for you to click (it reads source snippets, so it is more expensive and more in need of your presence).

- Gap analysis dimensions: which key sections the README is missing, whether build artifacts should be committed, whether `package.json` has a self-contained install command,
  whether **host core packages** were mistakenly written into `dependencies` (that shadows the host and makes bulk plugin loading fail), whether a Skill's `description` is sufficient
- Security review dimensions: whether `pull_request_target` / `workflow_run` check out and execute fork code, whether `GITHUB_TOKEN` has least privilege,
  suspicious `eval` / concatenated-execution `spawn`, dependency clues. Findings are given by "file + line number", sorted by confidence, each with "acceptable / rejectable"

## Known limitations (stated honestly, not exaggerated)

1. **Private repos get no platform-level security scanning**: GitHub's Secret Scanning / Dependabot / Push Protection require paid GHAS.
   So "dependency known to be vulnerable" relies only on local rules and model common sense, and is **less accurate than platform-level scanning**.
2. **Skill call stats only go as far as "count + last time"** and cannot be broken down by session — that is a mechanism limitation, noted in the UI.
3. **Private repos on a free personal account have no "read-only sharing" tier**: either private (only you / invited collaborators) or public (readable by everyone).
   Fine-grained permissions require an Organization.
4. **Tool ownership is inferred**, but measured coverage is very high (193 of 196 tools uniquely matched by description fingerprint, covering 85.2% of call volume;
   0 ambiguous, 0 unattributed). The remaining 2 are judged host core (`plugin_manager` / `exit_plan_mode`),
   and you can still override tool ownership manually in the panel.
5. **Ecosystem data such as stars / downloads is not collected** (this plugin does not go online; it only reads local facts).

## Troubleshooting: plugin installed and the panel shows up, but no tools / routes

This is a failure mode this plugin really hit once; **check in this order first**:

1. `plugin_manager action=list_plugins` (or the `plugin_diagnose` tool) to look at the **`fiberPhase`** of `include:plugin-catalog`:
   - `active` = normal;
   - `failed` = `apply()` threw (in this case the **client half usually still renders normally**, because the client bundle and the host half
     are two separate load paths — don't be fooled by "the icon is there");
   - `null` = not enabled.
2. Get the raw error: `plugin_manager action=set_plugin target=include:plugin-catalog enabled=true`
   — the response's `diagnostic` writes `TypeError: ...` directly.
3. Look at `<数据目录>/logs/apply-trace.log` (**a step-by-step trace of every apply**: one glance shows how far it got)
   and `apply-error.json` (written only when initialization fails).
4. Confirm end-to-end whether the route is alive: in the GUI console or `client_eval`,
   `fetch('/plugin-catalog/health').then(r=>r.json())` — normally it should return 200 and the build marker;
   a 404 with an empty body means the route was not registered (compare: `/plugin-installer/health` should always be 200).

**Two known shapes that cause `failed`** (both hit on real machines, ordered by "cost"):

1. **`apply` is async yet `return`s a value** ← the real culprit, and the best hidden.
   cordis's `Fiber._execute()` collects apply's return value as an **effect disposer** —
   `safeCollect`: if it is not a function and not null/undefined, it does `throw TypeError("Invalid effect")`,
   and async apply goes through `effect.then(safeCollect)`. So after **the whole apply has succeeded**
   (tools registered, routes mounted, background tasks started), the moment the promise resolves it throws,
   and `_reload`'s catch marks the fiber INACTIVE → **the already-registered tools and routes are rolled back wholesale**.
   Symptoms: every step in `apply-trace.log` is OK, yet it "did not activate", all tools gone, routes 404,
   and the host only writes to console, not to the log file.
   → **async apply should always `return;`**; to expose a service, go through ctx, not the return value.
2. `ctx.effect(...)` is best registered in the **synchronous phase** of `apply()` (this plugin puts cleanup on the first line,
   collecting route/tool disposers in mutable variables). This is a **defensive convention** — the empirical cause of `Invalid effect`
   on a real machine is the previous item, so don't stare only at effect timing.

Another equally silent pitfall: **reading `ctx.xxx` directly without declaring it in `inject`**. cordis's context is a Proxy
and throws `cannot get property "llm" without inject` (optional chaining `ctx?.llm` doesn't save you; the throw happens in the get trap).
Always use `ctx.get(name)` for optional services (verbatim from the cordis comment: *Read a service from the store without the
inject requirement*), which is exactly what this plugin's `lib/ai.mjs::readService()` does.

## Self-rescue (when the UI goes wrong)

This plugin is an **independent client plugin**; disabling it returns you to the official UI:

- In the profile's `package.json`, remove `"dsh-plugin-catalog"` from `dsh.profile.bundles`, then restart DSH;
- or disable it from the plugin installation panel.

It **neither hides nor modifies the official plugin entry**: the official "Plugins" page is still in its original `sidebar.panellist` position; this only **adds** an item.

## Self-checks

```bash
node dev/audit.mjs         # Consistency: frozen defaults / tool contracts / rule coverage / dedup / naming / gates / bilingual README flow (172 items, runs in a sandbox)
node dev/render-check.cjs  # UI: card content / search & sort / popup / pagination / plan popup / empty states (65 items, no DSH needed)
node dev/preview.mjs       # Layout: generate a static preview (real component tree + real CSS) for browser screenshots
```

Host side (no DSH restart needed):

```bash
node dev/hosttest.mjs      # Fake ctx really runs apply(): routes / tool contracts / stats / tags / AI paths / gates / effect sync constraints / async apply return-value validation (86 items)
node dev/probe-gitops.mjs  # Really runs init/commit/push failure/ignore in a temp repo (23 items, touches no real repo, no network)
node dev/probe-asar.mjs    # Whether official plugins can be read out of app.asar (Electron's asar is a "directory")
node dev/measure-attrib.mjs  # Measure ownership coverage with real tool schemas
node dev/probe-publish.mjs   # Read-only dry run of the upload plan (no repo creation, no commit, no push)
node dev/probe-export.mjs    # Export a Markdown snapshot into reports/ using real data
node dev/probe-init.mjs      # Measure startup cost (milliseconds for init/state/entryDetail)
node dev/warm-cache.mjs      # Warm the real data directory so the first open already has data
```

Why `dev/preview.mjs` exists: headless self-checks can only validate structure/copy, not **layout** (whether the popup is centered,
whether the card grid gets squeezed into one column, whether badges overflow in narrow cards). It serializes the component tree into HTML and injects the same CSS,
so you can open it with any static server and screenshot it; on this machine it caught problems only visible after rendering, such as "markdown asterisks leaking into plain text".

Why `dev/probe-gitops.mjs` exists: uploading is the hardest part to validate in a sandbox (subprocess spawn is banned),
and real repos can't be used for testing — so it really runs a pass in a temp repo, covering edge cases like "a new repo with no first commit yet".

## License

MIT.
