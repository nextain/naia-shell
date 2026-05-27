# Issue #334 — SkillsTab Source Grouping (agent / shell / adk)

**Status**: design — ready for follow-up coding session
**Author**: claude (this session)
**Last updated**: 2026-05-27

## 1. Current state (audited)

### 1.1 SkillsTab — flat two-section list

`shell/src/components/SkillsTab.tsx:205-296` splits the list by
`skill.type === "built-in"` vs other. The "built-in" bucket is whatever
`list_skills` (Rust) returns with `skill_type: "built-in"`. There is no
notion of *who supplied* a skill (naia-agent core vs naia-os shell vs
adk extension) — only a binary "built-in" / "custom" axis.

Existing header controls: search input + count + "전체 활성/비활성" buttons
(`handleEnableAll` / `handleDisableAll`). The card itself shows a tier
badge and (only on expand) a `skill.source` raw string (`built-in` or
a manifest path).

### 1.2 list_skills (Rust) hard-codes 20 "built-in" skills

`shell/src-tauri/src/lib.rs:1363-1399` enumerates 20 names ALL labelled
`skill_type: "built-in"`, but they come from THREE different runtimes:

| # | Name | Real origin (this audit) |
|---|------|--------------------------|
| 1 | `skill_time` | naia-agent core (`createTimeSkill`) |
| 2 | `skill_system_status` | naia-agent core (`createSystemStatusSkill`) |
| 3 | `skill_memo` | naia-agent core (`createMemoSkill`) |
| 4 | `skill_weather` | naia-agent core (`createWeatherSkill`) |
| 5 | `skill_diagnostics` | naia-agent core (`createDiagnosticsSkill`) |
| 6 | `skill_sessions` | naia-agent core (`createSessionsSkill`) |
| 7 | `skill_config` | naia-agent core (`createConfigSkill`) |
| 8 | `skill_notify_slack` | shell-injected (Gateway webhook) |
| 9 | `skill_notify_discord` | shell-injected (Gateway webhook) |
| 10 | `skill_notify_google_chat` | shell-injected (Gateway webhook) |
| 11 | `skill_skill_manager` | shell-injected (Gateway, see SkillsTab.tsx:62) |
| 12 | `skill_agents` | shell-injected (Gateway) |
| 13 | `skill_approvals` | shell-injected (Gateway) |
| 14 | `skill_botmadang` | shell-injected (Gateway community) |
| 15 | `skill_channels` | shell-injected (Gateway) |
| 16 | `skill_cron` | shell-injected (Gateway) |
| 17 | `skill_device` | shell-injected (Gateway) |
| 18 | `skill_naia_discord` | shell-injected (Gateway DM/channel) |
| 19 | `skill_tts` | shell-injected (Gateway TTS) |
| 20 | `skill_voicewake` | shell-injected (Gateway wakeword, ChatPanel.tsx:148) |

Note: `skill_bash` (issue body §"naia-agent core 8") is NOT in the
hard-coded list because `--enable-file-ops` style gating: `naia-agent/bin/naia-agent.ts:605`
adds `createBashSkill()` unconditionally but `list_skills` Rust never
mirrored it. **Discrepancy to flag in §7.**

### 1.3 panel_skills IPC — carries name/desc/params/tier only

`shell/src/lib/chat-service.ts:382-399`:

```ts
tools: tools.map((t) => ({
  name: t.name,
  description: t.description,
  parameters: t.parameters ?? { type: "object", properties: {} },
  ...(t.tier != null && { tier: t.tier }),
}))
```

`NaiaTool` (`panel-registry.ts:32`) has no `source` / `origin` field. The
panel skills (browser ×11 + workspace ×8 + sample-note ×2 +
tab-skills ×1 + youtube_bgm + skill_panel + skill_inject) never reach
`list_skills` — they only show up when a panel is active. **SkillsTab
currently doesn't render panel-injected skills at all.**

### 1.4 naia-adk extensions — loaded via `--skills-dir`

`naia-agent/bin/naia-agent.ts:616-637` walks `{NAIA_ADK_PATH}/.agents/skills/`
via `FileSkillLoader`. These never round-trip back to the Tauri shell;
SkillsTab cannot list them today.

### 1.5 Summary of the gap

| Source | Discoverable in SkillsTab? | Source label? |
|---|---|---|
| naia-agent core (8) | yes (mis-labelled "built-in") | no |
| shell-injected hard-coded gateway proxies (12) | yes (mis-labelled "built-in") | no |
| shell-injected panel tools (browser/workspace/...) | **no** | n/a |
| naia-adk skills-dir extensions | **no** | n/a |

## 2. Source classification (per skill, with Tier)

Tier follows the naia-agent permission model — T0=auto, T1=notify,
T2=confirm, T3=block. Inferred from current code (panel `tier:` field;
agent skills default tier inspection; gateway skills tier from manifest
defaults).

### 2.1 `agent` group — naia-agent core (8)

| Name | Tier | Notes |
|---|:---:|---|
| `skill_time` | T0 | pure read |
| `skill_weather` | T0 | network read |
| `skill_memo` | T1 | writes naia-agent memo store |
| `skill_system_status` | T0 | read |
| `skill_diagnostics` | T0 | read |
| `skill_sessions` | T1 | session mgmt |
| `skill_config` | T2 | mutates config |
| `skill_bash` | T2 | command exec (see §7 Q1) |

### 2.2 `shell` group — naia-os shell-injected (current hard-coded + panel)

Gateway-backed (today wrongly classified as "built-in"):

| Name | Tier | Notes |
|---|:---:|---|
| `skill_notify_slack` | T1 | webhook |
| `skill_notify_discord` | T1 | webhook |
| `skill_notify_google_chat` | T1 | webhook |
| `skill_skill_manager` | T1 | install/disable |
| `skill_agents` | T2 | Gateway mgmt |
| `skill_approvals` | T2 | policy mgmt |
| `skill_botmadang` | T1 | community |
| `skill_channels` | T1 | messaging |
| `skill_cron` | T2 | schedule |
| `skill_device` | T2 | device pairing |
| `skill_naia_discord` | T1 | DM/channel |
| `skill_tts` | T1 | TTS playback |
| `skill_voicewake` | T2 | wakeword/mic |

Panel-injected (currently invisible in SkillsTab — must be surfaced):

| Name | Tier | Panel | Notes |
|---|:---:|---|---|
| `skill_browser_navigate` … `skill_browser_eval` (×11) | T0 | browser | tier=0 in panel src |
| `skill_workspace_get_sessions` … `skill_workspace_classify_dirs` (×8) | T0–T2 | workspace | classify per src |
| `skill_note_read` / `skill_note_write` | T1 | sample-note | |
| `skill_tab_screenshot` | T0 | common (`tab-skills.ts`) | |
| `skill_panel` | T2 | App.tsx | panel mgmt |
| `skill_youtube_bgm` | T1 | App.tsx | BGM control |
| `skill_inject` | T2 | runtime IPC primitive | internal |

### 2.3 `adk:<name>` group — naia-adk skills-dir (currently 0 surfaced)

For each prompt under `{NAIA_ADK_PATH}/.agents/skills/*.prompt.md`,
label = `adk:<basename without .prompt.md>`. Tier read from skill
manifest if present, else default T2.

## 3. UI mock — 3 collapsible groups + badges + bulk + search

```
┌─ Skills ─────────────────────────────────────────────────────────────────┐
│  [search: type to filter………………] 24 / 38   [enable all] [disable all]    │
│                                                                          │
│  ▼ naia-agent core   (8/8 enabled)             [enable all] [disable]    │
│   ┌──────────────────────────────────────────────────────────────────┐   │
│   │ skill_time              [agent] [T0]                       ON ●  │   │
│   │ Get current date and time                                        │   │
│   ├──────────────────────────────────────────────────────────────────┤   │
│   │ skill_bash              [agent] [T2]                       ON ●  │   │
│   │ Run a shell command                                              │   │
│   ├──────────────────────────────────────────────────────────────────┤   │
│   │ … (6 more)                                                       │   │
│   └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  ▼ naia-os shell     (14/22 enabled)           [enable all] [disable]    │
│   ┌──────────────────────────────────────────────────────────────────┐   │
│   │ skill_voicewake         [shell] [T2]                       OFF ○ │   │
│   │ Manage voice wake triggers                                       │   │
│   ├──────────────────────────────────────────────────────────────────┤   │
│   │ skill_browser_navigate  [shell:panel:browser] [T0]         ON ●  │   │
│   │ Navigate the browser to a URL …                                  │   │
│   └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  ▼ naia-adk extensions (2/4 enabled)           [enable all] [disable]    │
│   ┌──────────────────────────────────────────────────────────────────┐   │
│   │ skill_onmam_deploy      [adk:onmam] [T2]                   ON ●  │   │
│   │ Deploy OnMam services …                                          │   │
│   └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  (empty groups render single-line: "naia-adk 확장 스킬 없음")            │
└──────────────────────────────────────────────────────────────────────────┘
```

Notes:
- group caret toggles `expanded` per group (localStorage-persisted)
- per-group bulk buttons act ONLY on that group's skills
- header bulk buttons preserve existing behaviour (all non-agent skills)
- source badge values: `agent` | `shell` | `shell:panel:<panelId>` | `adk:<name>`
- tier badge unchanged (`T0`..`T3`)
- search box matches name + description across all 3 groups; empty
  groups under active search collapse to "(검색 결과 없음)" line

## 4. IPC contract changes

### 4.1 `panel_skills` — needs `origin` field

Today (`chat-service.ts:382-399`) sends `{ name, description, parameters, tier? }`.
Add an optional `origin` field carried end-to-end so the agent can
echo it back when it surfaces panel-skills to SkillsTab via a new
discovery channel:

```ts
// shell/src/lib/chat-service.ts (sendPanelSkills)
tools: tools.map((t) => ({
  name: t.name,
  description: t.description,
  parameters: t.parameters ?? { type: "object", properties: {} },
  origin: t.origin ?? `shell:panel:${panelId}`,  // NEW
  ...(t.tier != null && { tier: t.tier }),
}))
```

Receiver (`naia-agent/bin/naia-agent.ts:1780` `case "panel_skills"`):
preserve `origin` on the registered `ToolDefinitionWithTier`. No
behaviour change for tool calls; only the discovery metadata grows.

### 4.2 New IPC: `skill_inventory` (agent → shell)

`list_skills` today walks only Rust-hardcoded built-ins + the user
skills dir under HOME. Two new sources must be added:

1. **Agent-side core skills**: ask naia-agent for its core skill list at
   startup (new IPC: agent → shell `core_skill_list_response`), cache
   in memory.
2. **Panel-injected skills**: subscribe to the existing panel registry
   (`panelRegistry`) in the renderer and merge into the displayed
   inventory client-side (no IPC needed — already in-process).
3. **ADK skills-dir skills**: agent on startup sends one
   `adk_skill_list_response` after `FileSkillLoader` resolves dirs, so
   shell knows them by name + manifest path.

Equivalent option (simpler): **stop trusting Rust's hard-coded list**.
Replace it with a single IPC `request_skill_inventory` to the agent
that returns the union, each tagged with `origin`. SkillsTab then
renders purely from agent's authoritative answer. (See §7 Q2.)

### 4.3 Backwards compatibility

`SkillManifestInfo.source: string` already exists (`types.ts:201`).
Repurpose as `origin` (rename in shell) but keep the wire field
`source` to avoid Rust changes if §4.2 option-A is taken. Whichever
field name wins, semantics = the new tag.

## 5. File-by-file change list

```
shell/src/lib/types.ts
  - SkillManifestInfo: add `origin: "agent" | "shell" | "shell:panel:<id>" | "adk:<name>"`
  - keep legacy `source: string` for filesystem path (manifest provenance only)

shell/src/lib/panel-registry.ts
  - NaiaTool: add optional `origin?: string`
  - panelRegistry: expose `getAllPanelTools()` returning NaiaTool[] with origin auto-filled

shell/src/lib/chat-service.ts:382-399 (sendPanelSkills)
  - propagate `origin` into the IPC payload (default `shell:panel:${panelId}`)

shell/src/components/SkillsTab.tsx (major refactor)
  - replace 2-section render with 3-section grouped render (agent/shell/adk)
  - new `SkillsGroup` sub-component: title row + count + per-group bulk + collapsible
  - merge sources at render-time:
      • `list_skills` invoke (existing) — provides agent + shell:gateway
      • `panelRegistry.getAllPanelTools()` — provides shell:panel:*
      • `adk_skill_list` IPC subscription (new) — provides adk:*
  - search filter unchanged; applies before grouping
  - bulk toggle per group: enable/disable all in group at once

shell/src-tauri/src/lib.rs:1363-1399 (list_skills)
  - split hard-coded list into two arrays with `origin`:
      AGENT_CORE_BUILTINS (8) — origin="agent"
      SHELL_GATEWAY_BUILTINS (12) — origin="shell"
  - emit `origin` field on SkillManifestInfo (Serialize rename to camelCase)
  - keep `source` as filesystem path for user-installed skills (HOME-relative)

naia-agent/bin/naia-agent.ts:605-613 (builtinSkills array)
  - tag each created skill descriptor with `origin: "agent"` (already implicit; ensure it is exported)

naia-agent/bin/naia-agent.ts: panel_skills IPC handler (~line 1780)
  - accept incoming `origin`; store on hostInjectedDefs entry for later re-emit

naia-agent/bin/naia-agent.ts: new response `core_skill_list_response`
  - shell can request `core_skill_list` at startup; agent replies with
    [{name, description, tier, origin:"agent"}, …]

naia-agent/bin/naia-agent.ts: new response `adk_skill_list_response`
  - after `--skills-dir` loader resolves, agent emits one snapshot of
    [{name, description, tier, origin:`adk:${basename(dir)}`}, …]

shell/src/lib/i18n.ts (en + ko)
  - skills.group.agent  / skills.group.shell / skills.group.adk
  - skills.group.empty (`<group> 스킬 없음`)
  - skills.badge.source (badge tooltip text)
```

Estimated touched files: 6 TS, 1 Rust, 1 e2e spec (see §6), 1 i18n. No
schema migration; legacy `source` semantics preserved as a separate field.

## 6. E2E spec extension — `14-skills-tab.spec.ts`

Add new `it` blocks; preserve the existing 5 (`navigate`, `>=20 cards`,
`count format`, `search filter`, `no toggle on built-in`,
`back to chat`).

```ts
it("should render exactly three source groups", async () => {
  const groups = await $$(S.skillsGroup);
  // Render rule: always-shown groups, but empty ones collapse to placeholder
  expect(groups.length).toBe(3);
  const texts = await Promise.all(groups.map((g) => g.getText()));
  expect(texts[0]).toMatch(/agent|Agent core/i);
  expect(texts[1]).toMatch(/shell|naia-os/i);
  expect(texts[2]).toMatch(/adk|확장/i);
});

it("agent group has at least 8 cards", async () => {
  const cards = await $$(S.skillsGroupAgentCard);
  expect(cards.length).toBeGreaterThanOrEqual(8);
});

it("each card shows a source badge", async () => {
  const cards = await $$(S.skillsCard);
  for (const c of cards) {
    const badge = await c.$(S.skillsSourceBadge);
    expect(await badge.isExisting()).toBe(true);
    const txt = (await badge.getText()).toLowerCase();
    expect(txt).toMatch(/^(agent|shell|shell:panel:|adk:)/);
  }
});

it("per-group bulk disable affects only its group", async () => {
  // 1) Note enabled count of agent group
  // 2) Click "disable all" in shell group only
  // 3) Assert: shell group count → 0 enabled, agent group count unchanged
});

it("search filter respects group structure", async () => {
  await setNativeValue(S.skillsSearch, "browser");
  await browser.pause(300);
  // browser_* lives under shell:panel:browser
  const shellCards = await $$(S.skillsGroupShellCard);
  expect(shellCards.length).toBeGreaterThanOrEqual(1);
  const agentCards = await $$(S.skillsGroupAgentCard);
  expect(agentCards.length).toBe(0);  // no match in agent group → collapsed/empty
});
```

New selectors in `e2e-tauri/helpers/selectors.ts`:
`skillsGroup`, `skillsGroupAgent`, `skillsGroupShell`, `skillsGroupAdk`,
`skillsGroupAgentCard`, `skillsGroupShellCard`, `skillsGroupAdkCard`,
`skillsSourceBadge`, `skillsGroupBulkDisable`.

## 7. Open questions

**Q1. `skill_bash` discrepancy.** Rust `list_skills` does NOT include
`skill_bash`, but `naia-agent/bin/naia-agent.ts:605` registers it
unconditionally. Two interpretations:

- (a) `skill_bash` is agent-internal and should be hidden from
  SkillsTab (then the agent group has 7, not 8).
- (b) `skill_bash` was simply forgotten when the Rust list was
  hand-curated and should be added (agent group = 8).

The issue body says 8. Recommend (b) — surface it under agent group.
Needs user/designer confirmation.

**Q2. Authoritative skill inventory — Rust or agent?** Two paths:

- (A) Keep Rust hard-coded list, add `origin` field, and add IPC for
  agent core + adk dirs to extend it. Simpler diff; risk of further
  drift between Rust list and what the agent actually serves.
- (B) Strip Rust to ONLY scan the user-installed skills dir; ask the
  agent for authoritative skill inventory via one round-trip IPC;
  render that union. Eliminates drift; +1 IPC round at SkillsTab
  mount.

Recommend (B) for correctness. User decision needed before coding.

**Q3. Panel-injected skills visibility — always show vs only when panel
active.** Today, panel skills only register with the agent when the
panel is open. SkillsTab listing them "always" would mislead the user
into thinking they are callable when the browser panel is closed.

Options:
- (i) Show all known panel skills with a `[disabled — panel inactive]`
  state.
- (ii) Show only currently-active panel skills (refresh on panel switch).
- (iii) Hide panel skills from SkillsTab entirely (treat as panel-internal).

Recommend (ii) — matches actual capability. User decision needed.

**Q4. `adk:<name>` granularity.** When multiple `--skills-dir` paths
are loaded (e.g. naia-adk + onmam-adk overlay), do we group as one
`adk` bucket with sub-badges, or one bucket per source dir?

Recommend single `adk` group with per-row `adk:<basename>` badge. User
confirms.

**Q5. Tier mismatch handling.** If a panel skill declares `tier=0` but
the gateway-backed equivalent declares `tier=2`, do we surface the
panel-source tier or the gateway-source tier in the UI?

Recommend: source-of-truth = the runtime that will actually execute
the call. For panel skills that's the shell; for gateway-backed that's
the gateway. Both are "shell" group; show the runtime's tier.

**Q6. Persistence of per-group collapsed state.** Use localStorage
(`skillsGroupCollapsed: { agent: bool, shell: bool, adk: bool }`)?
Or session-only? Recommend localStorage.

**Q7. Per-group bulk button effect on agent skills.** Agent core skills
are non-toggleable today (no checkbox in `SkillCard`). Should the
"disable all" in agent group be hidden, disabled, or trigger a warning?
Recommend hidden (matches current "no toggle for built-in" e2e
assertion).

## 8. Cross-review consensus (gemini, 2026-05-27)

### 8.1 Agreed corrections (integrated above where noted)

1. **§4.2 (Important) — IPC race**: `request_skill_inventory` must
   handle `FileSkillLoader` async resolution. Either wait for
   `SKILLS_INITIALIZED` from the agent, or include `partial: boolean`
   in the response, so the `adk` group does not falsely appear empty
   when the shell mounts before agent scans the filesystem.
   **Action**: prefer `SKILLS_INITIALIZED` push (agent → shell) AFTER
   `FileSkillLoader` resolves, then unconditional re-fetch from shell.
2. **§1.2 / §2.2 (Minor) — duplicate skill_bash**: if §7 Q2 picks
   Option B (agent authoritative), remove `skill_bash` from the Rust
   hard-coded list to avoid duplicate cards. **Action**: bundle this
   removal in the same commit as Option B's Rust strip.
3. **§6 (Important) — search filter assertion**: replace search term
   `"browser"` with a unique synthetic string (e.g. `"zz_unique_test"`)
   to avoid false-fail if any agent skill description happens to
   contain "browser". **Action**: switch the e2e spec to a fixture
   skill name unlikely to collide; or use exact-name search.
4. **§6 (Minor) — bulk toggle on agent group**: explicitly verify
   the agent-group "disable all" button is hidden/disabled (not just
   inert), to prevent user confusion. **Action**: add an e2e
   assertion `expect(await $(S.skillsGroupAgentBulkDisable).isExisting()).toBe(false)`.
5. **§4.3 / §5 (Block→reclassified Important) — wire field semantics**:
   gemini flagged this as "Block" citing `source === "built-in"` as a
   non-toggle gate. **Audit correction**: the actual gate is
   `skill.type === "built-in"` (`SkillsTab.tsx:205,407`), not
   `skill.source`. `skill.source` is rendered only as a display badge
   (`SkillsTab.tsx:465-466`). So the "block" severity is overstated,
   but the underlying compat concern is valid:
   - Do NOT change semantics of `skill.type` — keep `"built-in" |
     "gateway" | "command"` as the toggle-visibility gate (or `tier`-based
     gate in a separate refactor PR).
   - Add `origin` as a NEW field; do NOT repurpose `source`.
   - Keep `source` rendered as today (display path); §5 file list
     updated accordingly.
6. **§7 Q6 (Minor) — localStorage key versioning**: add a version
   suffix (`skillsGroupCollapsed.v2`) so the new 3-group map shape
   does not collide with any legacy boolean. **Action**: read
   `v2` key with fallback to default `{agent:false,shell:false,adk:false}`.

### 8.2 Plan deltas after cross-review

- §5 file list: clarify "keep `source` field unchanged as display
  path; add NEW `origin` field; the toggle-visibility gate
  (`skill.type === "built-in"`) is unchanged in this PR — group
  classification uses `origin`, toggle visibility uses `type`."
- §6 e2e search test: search term changed to `"skill_browser_navigate"`
  (exact match against a panel skill name) to avoid description-collision
  false-fails.
- §4.2 IPC: agent emits `skill_inventory_ready` push event after
  `FileSkillLoader` completes; shell re-fetches on receipt. SkillsTab
  shows a discreet "loading adk skills…" line until the push arrives
  (timeout 3 s → fall back to current snapshot).

## 9. Out of scope (defer)

- Reordering / drag-to-reorder within a group
- Per-skill icon (would require manifest schema extension)
- Filtering by tier (search-by-name covers 80%)
- ClawHub banner repositioning (`SkillsTab.tsx:369`) — keep as-is

🤖 Written with AI assistance. If anything looks off, please open a discussion.
