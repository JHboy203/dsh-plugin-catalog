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
- **Selection batches**: the "Select" button enters selection mode; clicking a card selects it (click again to deselect), and selected cards get a blue outline plus a check badge. The batch bar shows **N selected · ~X MB** (sizes are asked in one batch, the server fans out four at a time; entries without their own directory are called out as "N have no separate directory, counted as 0") and offers "Export selected", "**Tag**", "Select current N" and "Clear". The selection **survives filter changes** (pick a few unused ones, switch to with-errors, pick a few more), but it is **not written to localStorage** — clearing it on reload is deliberate, so half a batch never lingers unnoticed
- **Bulk tagging (tri-state)**: the batch bar's "Tag" button opens a panel that adds/removes purpose and context tags across the whole batch. Each tag shows **how many of the batch already have it** (`n/N`): **all → solid, one click removes it from all (`−`)**; some → dashed; none → empty, one click adds it to the ones missing it (`+`). Before you click, the tooltip already states what the click will do. Only the tags you touched change — an entry's other tags are **never wiped** (this add/remove semantics is deliberately different from the replace-everything editor inside the detail popup); the selections are a local intent and a single request is sent on "Apply", so a mid-way failure cannot leave half a batch applied. Tagged entries are marked as manually tagged and AI classification will not overwrite them
- **Tag filter**: a row of tag chips below the toolbar (shown only for tags that are actually in use), each carrying its hit count. **Multiple tags in one dimension OR** (screenshot or media), **across dimensions AND** (plus "used in Web GUI"). Clicking filters immediately; "Clear tags" clears only the tag filter and leaves the other filters alone
- **Export this view**: the "Export these N" button on the right of the toolbar writes the **current filter result** (screen order, filter conditions, error rate, install location) to `reports/catalog-filtered-<timestamp>.md` and shows the copyable path; it is disabled when the result is empty. For a full snapshot (source breakdown, call top, attribution coverage) use `catalog_export` instead
- **Size (a first-class field)**: every card carries a size chip, the list can be sorted by **size**, and the toolbar shows the **total for the current filter** (click "unused" and you immediately see how much deleting that batch would reclaim). The data comes from a background full snapshot (`cache/sizes.json`; ~1.5 s for 120+ directories, triggered by the panel itself, plus a "Measure sizes / Re-measure" button in the header). Three honest rules:
  - **unmeasurable entries show nothing** — never "0 B". Official packages live inside `app.asar` (`realDir` is a virtual member path, so recursion must return 0); their popup says "inside the official asar, no separate directory (size counted inside the DSH installation)";
  - **Skills have their own size too** (using the catalog's `dir`, never the skills root — using the root is a false alarm);
  - entries exceeding the 1.5 s / 20,000-file budget are marked with **"+"**: the number is a lower bound, and the total says so as well.
  In the popup it still uses the lazy `/size` route (measures only the opened entry, 5-minute cache) and **never runs during catalog builds** —
  recursively sizing 71 packages would push panel opening from seconds to tens of seconds; junctions and symlinks are **never followed** (following them can leave the profile or even loop)
- **Dependencies (who pulled it in / what breaks if you delete it)**: cards carry a chip —
  **"depended on by N"** (deleting it breaks those packages; hover lists them) and **"nobody depends on it"** (a candidate, amber).
  The data comes from a **full dependency graph** built while scanning: every `package.json` in the profile
  (`dependencies` / `optionalDependencies` / `peerDependencies`, **not just DSH plugins**, plus one level of nested `node_modules`),
  reverse-indexed into "who declares it". The toolbar also has a "nobody depends on it N" filter.
  - Why "is it in the profile's dependencies" is not enough: `@dsh-ops/bash-win32-x64` (354 MB) is **both** —
    listed in the profile *and* required by `dsh-ops`; deleting it breaks dsh-ops immediately. On this machine **651.8 MB**
    of the 850.6 MB total belongs to such "runtime dependencies"; the total's tooltip calls that out and does not count it as reclaimable space.
  - The popup's "Dependencies" block gives three facts: where it is declared, who depends on it (full names), and what it declares itself (the source of the size top list).
  - **"Nobody depends on it" is only a candidate**: nesting is expanded one level, so deeper declarations may be missed —
    the wording always says "confirm with `npm ls` / `pnpm why`", never "safe to delete".
- **Copy sync**: a banner plus per-card badges answer **"is the copy I edit the copy that is loaded?"**
  For plugins it compares four key files (`package.json` / `index.js` / `client.js` / `cordis.patch.yml`) by size + mtime; for Skills it compares `SKILL.md` by **size + mtime + body hash** (R20).
  A junction-installed plugin simply says "one copy only — edit the source and it takes effect". When copies disagree the badge reads "副本不同步 / 副本较旧 / 工作区较旧",
  and a Skill's staged copy reads "staging 不同步" — **publishing pushes the staged copy, so a stale stage means you ship an old version**.
  The scan is cached for 60 s and invalidated by a catalog rebuild; each Skill body is hashed once (17 pairs ≈ 680 KB, measured < 10 ms), so
  **a same-length one-character edit is caught too** (before R20 only lengths were compared and that edit was silently reported as identical)
- **Fixing it in place (R11)**: when a Skill's staging copy is stale you never leave the panel — the banner carries **"Sync staging (N)"**.
  Clicking it only fetches a **plan** (which `SKILL.md` files would be overwritten, in which direction, where the backups land); a second click on "Confirm sync" writes:
  one-way `live → staging`, overwriting only after backing the staged file up as `SKILL.md.bak-<timestamp>`,
  and **never touching the copy DSH is loading**. The popup also offers "Sync this one → staging".
  The write gate lives **server-side** (requires `confirm:true`), so a stray click can at most produce a plan.
  When staging is *newer* (`staging 较新`) there is no button at all — that direction would overwrite the live copy with an older one
- **Undo a wrong sync (R20)**: the entry popup shows "N historical backups · latest `<timestamp>`", and "Restore to `<timestamp>`" first asks the server for a
  **restore plan** (direction `backup → staging`, which files, where the safety copy lands); a second click on "Confirm restore" writes. The current staged file is
  backed up again as a fresh `.bak`, so **the restore itself can be undone too**. It only ever touches staging, never the copy DSH loads;
  the tool equivalent is `catalog_skill_sync action=restore`
- **Whether it is loaded at all (R12)**: `enabled` (membership in `dsh.profile.bundles`) is **not** a load criterion —
  top-level entries in `cordis.yml` / `cordis.patch.yml` mount packages by `name:`, and dependency chains pull packages in as well.
  The panel derives four states from the real entry points: bundle / config entry / reached through a dependency chain / **not loaded** (none of the three).
  Cards carry only two chips (`不会被加载` grey, `配置入口` blue); the popup names the actual chain ("loaded via `dsh-ops`"),
  and the toolbar filters "not loaded N" — a harder dead-weight signal than "unused", because such a package never runs at all.
  ⚠️ This is a **declaration-level** criterion: a runtime `require()` by path is invisible to it, which is why the wording is "not loaded" rather than "definitely never runs".
- **The criterion can prove itself (R13)**: `node dev/probe-loadstate.mjs` **recomputes** load paths independently
  (it walks the profile's `node_modules` and both composition files itself) and reconciles the result with the catalog snapshot,
  pinning seven invariants — count conservation / bundle accounting / `via` resolving to a real entry / dormant ∩ entries = ∅ /
  `disabled` never an entry / snapshot == recomputation / dormant closed under loaded declarations. **Any broken invariant exits 1**;
  `--json` is machine-readable.
  It shares the single criterion (it is not a second rule set), so what it catches is "the implementation drifted from the data".
- **Reports carry the criterion (R13)**: `catalog_export` adds a "load paths" line to its overview
  (entry count + the four states) and a dedicated **"not loaded (N)"** section (name/source/version/size/last call,
  the declaration-level caveat, and how much space they account for); the filtered export gains a **"loaded"** column,
  so a hand-off list no longer needs anyone to re-derive it.
- **From "not loaded" to "removed cleanly" (R14)**: next to the "not loaded N" filter there is a **"removal plan"** button.
  It (and `catalog_uninstall action=plan`) groups the candidates by **weakly connected component**, because those 26
  directories are *not* one kind of thing and the correct action is opposite from case to case:

  | Category | Example on this machine | What to do |
  |---|---|---|
  | entity, **pinned** | `dsh-mnemon` (`^0.5.32`), `dsh-chat-import`, `dsh-plugin-video-player` (`github:`) | deleting the directory is not enough: `profile/package.json` still pins it, so **the next `pnpm install` brings it back** — remove that line too |
  | entity | the 18 `dsh-mnemon` sub-packages, `fflate`, `markdown-to-jsx`… | deleting really removes it (but delete the whole group, see below) |
  | **link → workspace** | `dpi-probe-bundle`, `dsh-toolfold` | removing a junction **reclaims nothing**; the bytes live in the workspace source — the default advice is **keep it** |
  | **second copy of one project** | `ghbackup` (package `dsh-github-backup`; the loaded one is the other copy) | removing it only cleans up a duplicate; **do not also drop the `dsh-github-backup` dependency key** — that would delete the copy in use |

  Three hard rules:
  1. **Group by component, never per package** — `dsh-mnemon` declares 18 dormant sub-packages and those declare it back (a cycle).
     Deleting the parent alone leaves orphans; deleting children alone leaves the parent incomplete if you ever enable it.
  2. **Generates only, never deletes**: neither the panel nor the tool offers a "delete" button. The plan contains
     copy-paste `Remove-Item` commands plus verification commands; saving it to `reports/uninstall-*.md|.json` needs a second confirmation.
  3. **The criterion is declaration-level**: a runtime `require()` by path is invisible; and under a hoisted flat
     `node_modules` a plugin may `require('lodash')` **without declaring it** — run `pnpm why <name>` before removing a pure library.
- **Simulate before deleting (R16)**: the plan card gains a **"simulate (memory only)"** button (tool side:
  `catalog_uninstall action=simulate`). It removes the selected directories from the dependency graph **in memory**,
  recomputes the four load states, and answers the question the plan never answered: **will anything point at nothing
  afterwards?** Three possible problems each get one row, empty ones are not printed:

  | Row | What it means | What to do |
  |---|---|---|
  | **loaded right now (should not be deleted)** | the package was already on `bundles` / config / a dependency chain before the removal | don't delete it — the list itself picked wrong |
  | **entries left dangling** | a `bundles` entry or a cordis config entry still names it, so the next start reports missing packages | detach the entry first, or keep it |
  | **still declared by** | a surviving package declares it (optional / peer included) | delete them together, or keep it (under hoisting `require` fails outright) |
  | **drops back to "not loaded"** | downstream only lit up because of this batch | you will need a second cleanup round |

  ★ The simulation is **per directory, not per package name**: the second copy of a project (`ghbackup` and
  `dsh-github-backup` share one package name) means deleting one copy still leaves the name on disk. Working per name
  would also remove the **loaded** copy and report a safe cleanup as "risky" — which is exactly what happened before the fix.
  ★ It is **not** a clearance to delete: the criterion is still declaration-level (a runtime `require()` by path is invisible).
  ★ A self-proof: **simulating the whole plan must come out safe**. The criterion says dormant packages sit on no entry
  and no load chain, so removing them all cannot dangle an entry or hit a loaded declarer. That is asserted in hosttest;
  if it ever goes red, the plan picked a wrong package rather than the simulator being broken.
- **Reconcile after deleting (R27)**: the plan card gains a **"reconcile (no disk changes)"** button (tool side:
  `catalog_uninstall action=verify`). The simulation answers "what happens if I delete"; reconciliation answers
  "after working through this plan, what does the disk actually look like now". Three questions, in priority order:

  | Verdict | What it means | What to do |
  |---|---|---|
  | **wasted deletion** (`fake`) | the directory is gone but `bundles`, an enabled config entry, or a `profile` dependency key still names it | detach the reference first, otherwise `pnpm install` brings it back or startup dangles |
  | **stale plan** (`drift`) | the member is still on disk, but **today** it would be loaded, or a package outside the group now declares it | do not follow the old plan — recompute the list |
  | **not started** (`intact`) | every member is still there | work through the plan, then reconcile again |
  | **clean** (`clean`) | all gone, nothing references them any more | done |

  ★ Reconciliation **stats only the directories the plan named** (26 stats on this machine, no `node_modules` walk); every
  other criterion goes through the same `resolveLoadPaths` used by the simulation, the four load states and `catalog_health`.
  ★ Declarations **inside the group do not count as a violation**: the plan groups by weakly connected component, so a whole
  group leaving together is the expected outcome. Everything else would flag every group.
  ★ The verdict is likewise **never persisted to localStorage**: a stale "already clean" would endorse the next deletion.
  ★ Where the plan comes from: explicit `planPath` (restricted to `reports/`) > the one computed in this session > the newest
  file in `reports/`. You often reconcile after a restart, so the `uninstall-*.json` on disk is the trustworthy source.
- **Is the code the host is running actually new? (R18)**: the panel header and `catalog_health` now report both the
  **disk version** and the **loaded version**; when they differ they say so out loud: "still running 0.17.0 while the
  disk already has 0.18.0 — reload the plugin or restart DSH". Why this matters: the build label reads the **disk**
  (package.json + newest file mtime), so it can show 0.18.0 while the host still runs 0.17.0 — and the new tool or
  route simply does not exist. Two rounds (R16/R17) were misjudged as "already live" because of it. The same round
  also folded the standalone probes into `dev/ship.mjs` (`probes`, now nine probes and 153 invariants), so the one handoff command is
  now **three suites + probes + copy sync**.
- **What changed since last time (R17)**: a **changes bar** appears at the top of the panel (only when something
  actually changed): "since 10-24 11:27 · 3 changes · 1 added · 2 upgraded", click to expand. History lives in `history.json`:

  | Compares | Notes |
  |---|---|
  | plugin `version / source / loadState` | upgrade, source edited by hand, load state flipping between dormant and bundle |
  | skill `source / has a description / body content hash` | skills carry no version; since R19 **body edits are visible too** (see the next bullet) |
  | not compared | tool count (comes from stats), size (lazy snapshot), git dirty files (always moving) — they would make the bar noisy every day |

  Three hard rules:
  1. **No new entry unless the fingerprint changed**: writing one per "rescan" keeps refreshing the baseline,
     so "since 11:27" would never be more than a few minutes old and the real window would be invisible;
  2. keep the latest **20** entries; a corrupt JSON file counts as empty history (the panel must not fail to open);
  3. **the first snapshot is 0 changes**, not "133 additions" — "no history yet" and "nothing changed" are different
     things and neither may render as an empty banner (hosttest caught `first=true` with 133 changes for real).
- **Acknowledged, window cleared (R19)**: the changes bar now carries a **"Mark as seen"** button. Clicking it freezes
  the **current catalog as the baseline** (written to `history-ack.json` in the data dir — the **whole snapshot**, not
  just a timestamp), after which the bar only shows "since you acknowledged at X", and disappears entirely when nothing
  has changed; `history.json` is left alone ("I have seen it" is not "the history changed"). The same round closed the
  R17 gap **"skill body edits are invisible"**: `readSkillDir` already reads the whole `SKILL.md`, so it now hashes it
  (sha1, first 12 chars) on the way through — 58 skills ≈ 1.2 MB of in-memory hashing, under 10 ms — so **a one-character
  edit** shows up in "edited". The upgrade window has an explicit rule: when the old snapshot has no hash, that is **not**
  an edit (otherwise the first rebuild would report all 58 skills as edited). Hence `CATALOG_VERSION` 9 and `HISTORY_VERSION` 2.
- **Look further back (R21)**: `changes` only gives the latest window and `sinceAck` only the window since you acknowledged —
  older snapshots sat in `history.json` with no way to read them. The changes bar now has a
  **"History (N windows / M snapshots)"** row: expanding it shows a timeline built by subtracting adjacent snapshots. Each
  row names the window, how many additions / removals / version bumps / source changes / load-state changes / edits it had,
  and the first few names (body edits are marked). The **baseline never produces a row** (it has no "before", so calling it
  "133 additions" would mislead); identical-fingerprint and zero-change windows are skipped; only the first 4 names per
  category are carried while `counts` stays exact. The exported report lists the latest 8 windows below its change section;
  `catalog_health` also carries a "History: M snapshots / N windows" line.
- **Declaration-only edits become visible (R23)**: the R17/R19/R21 changes bar compared **catalogue entries** only
  (plugin version / source / load state, Skill body hashes). Flipping `disabled` in `cordis.patch.yml` or adding a
  package to `dsh.profile.bundles` left every entry untouched, so the bar kept reporting "0 changes". Snapshots now
  carry a **composition signature** `{fingerprint, counts}`: the fingerprint hashes the sorted `id / name / disabledKind`
  list plus `bundles` (first 12 hex chars), while the counts cover effective entries / enabled / disabled / conditional /
  patched / bundles / composition files. The bar therefore gains a "Composition" chip that expands to
  "disabled 25 -> 24, bundles 50 -> 51"; when only a different entry got disabled (identical counts) it says
  "entries changed (246 effective)". The older-window timeline uses the same sentence.
  The signature **only parses declarations** (no scan of 222 packages, no asar read) — a snapshot is recorded after every
  rebuild, so it cannot afford the full audit; for the same reason `present / asar / missing` **are not part of the
  fingerprint** (they depend on the installation and would make another machine look like a configuration edit).
  The upgrade rule matches R19: when only one of the two snapshots carries a signature, **nothing is reported** —
  otherwise the first rebuild after upgrading would raise a false alarm. `HISTORY_VERSION` is now 3, and the
  acknowledgement baseline (`history-ack.json`) freezes the signature too, so "since you acknowledged" sees the
  composition layer as well.
- **From the composition popup back to the card (R24)**: every declaration row now carries a **resolution badge**
  (`profile` / `asar` / `unresolved` / `unjudged`) plus an **"in bundles / not in bundles"** marker — especially useful on
  disabled and conditional rows: a package listed in `bundles` may still be re-enabled by that bundle's own patch layer.
  **Rows whose resolution is `profile` or `asar` are clickable**: clicking closes the popup, puts the package name into the
  search box and jumps to its card; unresolved / file-mounted / group entries have no card and do not pretend to be clickable.
  The jump **clears source / load-state / usage / tag filters** — otherwise the current filter can hide the target and the
  jump looks broken. The keyboard works too (Tab to a row, Enter or Space). On the data side `/state.composition` gains a
  deduped, sorted `bundleNames` array (50 package names; `bundles.rows` with file/line is not sent, so the 20-second poll
  does not grow).
- **Drill down to the exact declaration (R25)**: R23 could only say "off 25 → 24", never *which* one. `signatureOf` now
  stores the declaration identity table (`id / name / disabledKind`) plus the bundle list in each snapshot; an unchanged
  fingerprint still does not append, but a snapshot that predates this detail gets **one enrichment record** (once, never
  fabricated). `compareComposition` exposes `stateChanged / declsAdded / declsRemoved / bundlesAdded / bundlesRemoved`
  under the same one-sided rule — otherwise the first change after an upgrade would report all 50 bundles as newly added.
  Panel and report share the wording: "off 25 → 24, @deepseek-ai/dsh-hmr off→on, bundles +dsh-extra"; at most four
  details, the rest as "… N more" (the full list lives in the snapshot; `HISTORY_VERSION` unchanged).
- **Handoff card (R26)**: before switching sessions the risk is not missing data but missing a cross-check —
  which build is actually running, whether the latest ship passed, whether the tree is dirty, whether staging is stale.
  `catalog_handoff` condenses nine checks (loaded vs disk with an explicit "restart DSH", tool count, composition gaps,
  changes/ack, history, staging, latest ship, git head/dirty/unpushed, latest catalog snapshot report) into one verdict;
  `write:true` stores `reports/handoff-<stamp>.md`. The judgement lives in `lib/handoff.mjs` (pure, with nine synthetic
  probes in `dev/probe-handoff.mjs`); the default is read-only.
- **The premise of that plan is falsifiable (R14)**: "removing dormant packages cannot break what is loaded" is an invariant, not a feeling —
  **I7: no loaded package declares a dependency on a dormant package**. `node dev/probe-loadstate.mjs` checks it every run, and
  `node dev/probe-uninstall.mjs` checks the plan itself (I8 coverage and no overlap / I9 size accounting / I10 pinned-key safety /
  I11 never hitting a live load path). It caught a real problem: with "last copy read wins" as the dependency rule, `emoji-regex`
  was classified dormant while the top-level `string-width` (loaded via `@anweat/dsh-browser`) declares it — that plan would break loading.
  The fix is to **union the dependencies of same-named copies** (the conservative direction: rather miss one dormant than mislabel a needed library),
  plus bumping `CATALOG_VERSION` to 8.
- **What the composition layer actually mounts (R22)**: the panel header gains a **"Composition"** link (badged
  "unresolved N" / "missing N" when there is a gap). It opens the **declarations** in both composition files:
  how many top-level entries `cordis.yml` and `cordis.patch.yml` have, how many remain after merging by id, and for each
  entry whether it is a package / a subpath / a `file://` mount / a `cordis:group` / an id-only override, whether the package
  lives in the profile or in the official asar, which entries are `disabled: true`, and which use `!!js` **conditional**
  enablement (the expression is shown verbatim and never evaluated). A separate row audits `dsh.profile.bundles`:
  **50 declared -> 43 in the profile + 7 in the official asar + 0 really missing**.
  Three boundaries are printed in the popup footer: **bundles' own patch layers are not expanded** (this machine's
  `tool-bash` is declared `disabled: true` in `cordis.yml` yet the bash tool is clearly running), expressions are never
  evaluated, and a composition entry that is "unresolved statically" is not necessarily broken (runtime-injected virtual
  modules are invisible here — this machine's `dsh-plugin-desktop` is exactly that). Only a name that `bundles` declares
  and that cannot be found anywhere takes the top banner and says "the host will fail to enable them".
  The same data feeds `catalog_health` (one line), the `catalog_composition` tool (and `catalog_handoff`, R26, for the nine-point handoff card), and the exported report's
  "Composition (declared)" section. The rule lives in `lib/composition.mjs` (pure, never touches the disk) and
  `dev/probe-composition.mjs` pins **C1–C14** against synthetic text.
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
| `catalog_tag` | List tags / apply tags (single `id` = replace the whole entry; `ids` = add without removing) / **bulk untag** (`action=untag`) / add a custom tag (explanation required) / delete a tag / **manually change source** (`action=source`) / **manually change tool ownership** (`action=tool-owner`) |
| `catalog_classify` | AI automatic tagging (reads custom tag explanations) |
| `catalog_review` | Review a plugin (gap analysis + security review, suggestions only) |
| `catalog_publish` | Upload backup: `plan` → `apply` (requires `planId` + `confirm`, may include `ackRepos`) → `public` (separate gate) |
| `catalog_export` | **Export a Markdown snapshot** to `<数据目录>/reports/`: inventory, source distribution, call Top, repos and git status, to-be-tagged sources, attribution coverage, weekly findings |
| `catalog_health` | Self-check: which version is running, path resolution, stats coverage, attribution coverage, **skill body-hash coverage**, **the "mark as seen" acknowledgement window**, AI channel, asar mode, **whether copies are in sync** |
| `catalog_skill_sync` | A Skill has **two copies**: `plan` lists those whose staging copy is stale (publishing pushes staging, so a stale stage ships an old version); `apply` + `confirm:true` copies **live → staging only**, backing up each overwritten file as `SKILL.md.bak-<timestamp>` first; `restore` is the reverse undo (restores staging from the newest backup, also plan-first and `confirm:true` to write, staging only) |
| `catalog_uninstall` | **Removal plan for "never loaded" entries**: `plan` groups them by weakly connected component and reports reclaimable bytes, the category (entity / pinned by profile deps / link / second copy of the same project) and the steps; `simulate` removes those directories in memory, recomputes the load states and reports whether anything would be left dangling or still declaring them (pass `packages` to name package or directory names); `verify` **reconciles in reverse**: takes an existing plan and compares it with today's disk and declaration facts — which directories are really gone, which were **deleted for nothing** (would be reinstalled or leave an entry dangling), and which parts of the plan are stale (it would be loaded today, or a package outside the group now declares it); pass `planPath` to pick one file under `reports/`; `write` + `confirm:true` saves it as `reports/uninstall-*.md|.json` (`verify` + `confirm:true` writes `reports/uninstall-verify-*.md`). **None of the four actions deletes anything** (the commands are for a human to copy) |
| `catalog_composition` | **Composition layer (declared)**: the top-level entries of both composition files — which file they come from, whether they mount a package / a subpath / a `file://` path / a group / an id-only override, whether the package is in the profile or the official asar, which are `disabled: true`, which are conditionally enabled via `!!js` (verbatim, never evaluated); plus whether `dsh.profile.bundles` names anything that cannot be found. `view=overview` gives counts and gaps; `entries` / `disabled` / `conditional` give the lists. **Bundles' own patch layers are not expanded**; read-only |

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
9. **"Nobody depends on it" is a heuristic**: only one level of nested `node_modules` is read. Deeper nesting
   (`a/node_modules/b/node_modules/c`) or packages pulled in by a runtime `require` can be missed.
   So it stays a **candidate**, and the UI always says "confirm with `npm ls` / `pnpm why`". On this machine 2 of 220 packages qualify
   (`dpi-probe-bundle`, `dsh-toolfold`).
10. **The dependency graph ignores devDependencies**: packages installed into a profile should not have any, so only runtime declarations are read.
11. **pnpm's `.pnpm` virtual store is not expanded** (this machine uses `nodeLinker: hoisted`, so it does not exist);
    switching to isolated linking would degrade the graph.

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

**Before shipping or handing off, run just this one** (three checks + seven probes + copy sync + version consistency + git, ~45 s):

```bash
node dev/ship.mjs          # writes its verdict to .cache/ship-<stamp>.md; the panel's "Self-check" button runs the same path
```

Five checks:

| Check | What it covers | When it is red |
|---|---|---|
| `audit` | Self-consistency (frozen defaults / tool contracts / style and behaviour contracts) | counts as failure |
| `render` | UI rendering (really renders the component tree, then asserts) | counts as failure |
| `hosttest` | Host behaviour (real `apply()` and routes against a fake ctx) | counts as failure |
| `probes` | **Nine standalone probes** (load paths / removal plan / removal simulation / **removal reconciliation** / bulk tagging / change tracking / copy verdicts / **composition** / **handoff**, 153 invariants, ~3 s) | counts as failure |
| `staging` | **Copy sync**: how many same-named `SKILL.md` files differ between `<ws>/.dsh/skills` and staging | **report only, never blocks** |

Why `staging` only reports: it describes **this machine's state**, not a code defect — mid-edit, a lagging stage is normal
(you may be writing it, or may not have published it yet). Counting it as failure would turn the command into noise exactly
when it is most useful, matching the "dirty git is reported, not blocking" rule. It is still worth a look:
the R6 incident ("12 Skills were publishing old versions") was found only by reading back a conversation; now one command
before handoff shows it, the panel shows it too, and **the panel can fix it in place** ("Sync staging" on the banner); after a bad sync,
"Restore to `<timestamp>`" in the popup undoes it (R20).

It catches three kinds of "shipped but not actually there": a red check, `package.json` version not matching
`client.js`'s `BUILD`, and (reported, not blocking) uncommitted changes or a local HEAD that differs from `origin/main`.

Run the pieces individually:

```bash
node dev/audit.mjs         # self-consistency: frozen defaults / tool contracts / rule coverage / dedupe / naming / gates / bilingual README flow + client style and behaviour contracts + single source of the staging verdict + the four load states + the probe invariants + **the removal plan (categories / grouping / alias keys / generate-only) + the removal simulation (pure function / per directory / revived identity) / the write plan bypasses the 60s drift cache / change tracking (pure functions / 12-char fingerprint / the first snapshot reports no additions / body hashes and the upgrade migration / acknowledgement baseline / the timeline's adjacent subtraction and baseline exclusion) / copy verdicts (body hashes / same-length misses / fallback / backup names and path checks / restore only writes staging) / composition declarations (block scalars / the three `disabled` semantics / merge by id / five entry kinds / five resolutions / only a missing bundle is bad / three count groups conserve) / the live-check script (read-only / never sends confirm:true) / the health timeline summary / the single source of the preflight list + loaded vs disk version** (563 checks, runs in the sandbox; since R22.1 two more: the popup footer carries the cache age and the health summary carries `at`; since R23 fourteen more: the declaration-only signature / the signature folded into the snapshot fingerprint / the composition bucket / the one-sided-missing rule / the same wording in panel and export; since R24 four more: deduped+sorted bundleNames / clickable rows only for profile and asar / the jump clears filters / the cross-reference and badges; since R25 five more: the identity table in the signature / the drill-down naming ids / no invented detail on a one-sided miss / the same wording in panel and report / the history cap; since R27 fourteen more: reconciliation is a pure function / the three sources of a wasted deletion / in-group declarations are not violations / conservative when `presence` is missing / `planPath` limited to `reports/` / the verdict never enters state / single-source wording / probe V1–V15 and its registration)
node dev/render-check.cjs  # UI: card content / search / insight bar / sorting (incl. size) / pagination / popup / size states / dependency chips / load chips and dimming / self-check button / preflight card / **removal-plan card (category chips, two-step confirm, no delete button inside) + the simulation block (safe and risky states, absent until simulated) + **the reconciliation block (verdict and per-row reasons together / plan age / the wasted-deletion and stale-plan lists / still no delete button inside the card / absent until reconciled)** + **the changes bar (only when there are changes / details only when expanded / absent for the first snapshot and for zero changes / the acknowledged window / the "body edited" wording / the older-window timeline)** + **a "not reloaded yet" marker when the loaded version differs from the disk version** / selection batches / copy sync / **the three sync steps and its confirmation** / **the backup row and the restore confirmation** / export / empty states / **the composition link and popup (overview / unresolved / conditionals / disabled / a gap banner only when bad / **R24 clickable rows that jump to the card and the in-bundles cross-reference** / **R25 change details naming the exact ids**)** (221 checks, no DSH needed)
node dev/preview.mjs       # layout: renders a static preview (real component tree + real CSS) for screenshotting in a browser
```

Host side (no DSH restart needed):

```bash
node dev/hosttest.mjs      # real apply() against a fake ctx: routes / tool contracts / stats / tags / AI paths / gates / synchronous effect constraint / async apply return-value check / list item fields / recursive size + cache / size snapshot / batch sizes / dependency graph fields / load states vs the enabled flag / the export's load-paths line and "not loaded" section / **preflight route (dry, five checks) / /skillsync plan and confirm gate / staging verdicts and one-way copy / ship's copy-sync item / the removal plan (tool + /uninstall route + node_modules unchanged afterwards) + the simulation (whole plan must be safe / deleting the parent alone must report orphans / unknown names are not guessed / the route answers directly / the text spells out all three risk rows) + **the reconciliation (the tool reads the plan back and stats every directory / four counts / all four text sections / the route answers directly and writes nothing by default)** + **change tracking (snapshot on disk / no duplicate fingerprints / at most 20 / the exported report carries a change section) + body hashes in the snapshot + the acknowledgement window (no confirm is rejected / baseline written / cleared to zero / health reports it) + the timeline in /state (total + items) + the health timeline summary + copy hash verdicts / the restore plan and confirm gate / a real restore + pre-restore backup + the backup list + the loaded version versus the disk version** / export write / copy-sync verdicts / skill_sync plan and confirm gate (301 checks under the host; in plain node 295 pass and 6 are SKIPs — the sandbox forbids spawning with pipes and app.asar cannot be read)
node dev/live-check.mjs --base http://127.0.0.1:<GUI port>  # read-only check of the **running** panel (~0.2 s):
                            # version match / tools and catalog present / timeline shape / drift carries hashes and backups /
                            # the restore plan is read-only / a restore apply without confirm is rejected. Never writes a file.
node dev/probe-loadstate.mjs  # independent recomputation of load paths: walks the profile and both composition files itself,
                              # derives the four states, then reconciles with cache/catalog.json; seven invariants
                              # (count conservation / bundle accounting / via resolves / dormant ∩ entries = empty /
                              # disabled is never an entry / snapshot == recomputation / dormant closed under loaded declarations);
                              # any violation exits 1; --json
node dev/probe-uninstall.mjs  # self-check of the removal plan: four invariants (I8 coverage and no overlap / I9 size accounting /
                              # I10 pinned-key safety / I11 never hitting a live load path); any violation exits 1; --json
node dev/run-probes.mjs       # **the nine probes in one command** (ship's 5th item, 153 checks, about 3 s):
                              # understands both closing formats (`passed N / failed M` and "N invariants hold");
                              # under the sandbox it says "run this in the host" instead of looking like broken probes
node dev/ship-checks.mjs      # the **single source** of the preflight list: ship runs it, POST /preflight{dry} reports it
                              # (two copies had drifted: after adding probes, dry still reported four items — hosttest caught it)
node dev/probe-verify.mjs     # reconciliation self-check: 15 checks (an empty plan is not "clean" / everything still on disk is intact
                              # and reports nothing reclaimed / gone but pinned by profile deps, still in bundles, named by an enabled
                              # config entry, or declared outside the group => wasted deletion / loaded today or declared outside => stale
                              # plan / in-group declarations are not violations / the byte ledger does not overlap and links stay 0 /
                              # conservative without presence / duplicate directories counted once / plan age / verdict priority /
                              # the four boundaries), any broken invariant exits non-zero
node dev/probe-simulate.mjs   # self-check of the removal simulation: 14 checks (empty removal changes nothing / dormant is safe /
                              # transitive gets flagged / bundle and config entries left dangling / dangling declarers / drop back to dormant /
                              # removing edges never lights anything up / unknown names and dedupe / package count conserved /
                              # deleting one of two same-named directories does not count as deleting the package); any violation exits 1
node dev/probe-history.mjs    # self-check of change tracking: 32 checks (fingerprint stable and order-independent / added-removed
                              # reverses / version and source changes / total deduped across categories / skill description /
                              # body hashes (one-character edit; the upgrade migration is not an edit) / prune keeps the newest N /
                              # corrupt history becomes empty / the first snapshot reports zero changes / acknowledgement baseline /
                              # the timeline (baseline excluded / adjacent subtraction / newest first / cap / identical fingerprints skipped));
                              # any violation exits 1
node dev/probe-staging.mjs    # copy verdicts and restore, 16 checks (body hash stability / same-length one-character edit must differ /
                              # hash wins over mtime / missing hash falls back to size+mtime / backup ordering and latest / restore plus
                              # the pre-restore backup / identical backup is skipped / path traversal and non-backup names are rejected /
                              # the same-length miss end to end); any violation exits 1
node dev/probe-composition.mjs # composition (declared) self-check: 36 checks (top-level entries and block scalars / the three
                              # `disabled` semantics / merge by id / five entry kinds and subpath stripping / five resolutions /
                              # bundle gaps / count conservation / severity / an unreadable asar stays "unjudged" /
                              # the summary and the compact view / the exported wording); pure functions, never reads the profile
node dev/probe-gitops.mjs  # real init/commit/push-failure/ignore runs in a temporary repo (23 checks, never touches a real repo, no network)
node dev/probe-asar.mjs    # whether official plugins can be read out of app.asar (Electron's asar is a "directory")
node dev/measure-attrib.mjs  # measures attribution coverage against the real tool schemas
node dev/probe-publish.mjs   # dry-runs the upload plan (creates no repo, commits nothing, pushes nothing)
node dev/probe-export.mjs    # exports a Markdown snapshot of real data into reports/
node dev/probe-init.mjs      # measures startup cost (milliseconds for init/state/entryDetail)
node dev/warm-cache.mjs      # warms the real data directory so the first open already has data
node dev/rm.mjs              # fire extinguisher: delete files/directories in the workspace (the sandbox denies unlink; runs via host_selfcheck)
node dev/ship.mjs            # the shipping preflight above; --json is what the panel's /preflight route calls
```

★ When `dev/ship.mjs` runs under **plain node**, the hosttest asar assertion is marked `SKIP` (no `process.resourcesPath`),
so the number is one lower than clicking "Self-check" in the panel; both are printed as they are — never silently swallowed.

Why `dev/preview.mjs` exists: headless self-checks can only verify structure/copy, not **layout** (whether the popup is centered,
whether the card grid is squeezed into a single column, whether badges overflow in narrow cards). It serializes the component tree into HTML and injects the same CSS;
open it with any static server and screenshot; locally it caught problems only visible after rendering, such as "markdown asterisks leaking into plain text".

Why `dev/probe-gitops.mjs` exists: upload is the hardest part to verify in a sandbox (subprocess spawn is disabled),
and real repos cannot be used for experiments — so it really runs once in a temporary repo, covering edge cases like "a new repo not yet committed for the first time".

## License

MIT.

README
