# Cross-review request — naia-os panel-context / chat-TTS fixes

You are an independent reviewer. Read the ACTUAL source files referenced below
(they exist in this repo) and critically review the diagnosis and the proposed
fix plan. Be adversarial: look for wrong root-cause, missed call sites,
regressions, race conditions, token-cost blowups, and simpler alternatives.
Do NOT write code. Return: (1) confirm/refute each root cause, (2) risks in the
plan, (3) concrete answers to the open questions, (4) a recommended final plan.

## Context
naia-os = Tauri shell (`shell/`) + separate agent process (`agent/`). The agent
runs skills; it cannot read the shell's browser localStorage. The shell pushes
"panel context" to the agent, which is baked into the LLM system prompt.

Two user-reported bugs:
1. Chat TTS: when a NEW conversation turn starts, the previous turn's TTS keeps
   reading to the end instead of stopping and starting from the new turn.
2. The AI cannot read the YouTube BGM favorites list and hallucinates song
   titles (real first favorite is "Fantasy RPG Game"; AI invented lofi titles).

## Diagnosed root causes (verify against the real code)

### A — TTS interrupt missing
`shell/src/components/ChatPanel.tsx:704` — on a new turn it calls
`audioQueueRef.current?.resetSeq()`.
`shell/src/lib/voice/audio-queue.ts`: `resetSeq()` (line 58) only resets the
ordering counters + `pendingOrdered`; it does NOT touch the currently playing
audio (`this.current`) or the waiting `this.queue`. `clear()` (line 76) pauses
current + empties queue + resets counters. The voice barge-in path
(`ChatPanel.tsx:1364`) already uses `clear()`. So old TTS continues and new
chunks append behind it.

### B — single-slot panel context overwrite (structural)
- `shell/src/stores/panel.ts:14,52`: `activePanelContext: PanelContext | null`
  single slot; `setActivePanelContext` replaces it wholesale. Note line 46:
  `setActivePanel` nulls the context on panel switch.
- `shell/src/lib/panel-registry.ts:147`: `pushContext(ctx)` →
  `setActivePanelContext(ctx)`.
- Consumers: `ChatPanel.tsx:237` `buildMemoryContext` reads the single slot →
  `persona.ts:195` renders it as ONE block. Voice path `ChatPanel.tsx:1863`
  also reads the same single slot (fed to `panel-context-bridge.ts`).
- 5 panels push into this one slot: workspace
  (`WorkspaceCenterPanel.tsx` lines 599,645,661,695,735 — 5 sites), bgm
  (`BgmPlayer.tsx:358`), browser (`BrowserCenterPanel.tsx:237`), sample-note
  (`SampleNoteCenterPanel.tsx:37,51`), avatar (`avatar/index.tsx:12`).
- Last writer wins. Background BGM only re-pushes when its state changes, so
  workspace/etc. overwrite the BGM favorites → AI loses `favoritesList` →
  hallucinates. Same failure applies to "what page am I on" (browser) etc.

### C — `fav_list` skill returns no data
`agent/src/skills/built-in/youtube-bgm.ts:186`: `fav_list` returns a static
string "Favorites list is available in BGM context (favoritesList field)..."
with no real data. The skill cannot read localStorage. Also
`agent/src/system-prompt.ts:134` action list omits `fav_list`, and only the BGM
block (line 138) tells the AI to read context fields.
(Storage itself is fine: favorites live in browser localStorage key
`yt-bgm-favorites`, unrelated to ADK.)

## Proposed plan (user approved "option 1" = panel-context map + fix A & C)
1. A: `ChatPanel.tsx:704` `resetSeq()` → `clear()`.
2. B: `stores/panel.ts` single slot → `panelContexts: Record<string, PanelContext>`
   keyed by `ctx.type`; merge on push. Re-evaluate the null-on-switch behavior
   (line 46). Inject active panel + persistent (BGM) contexts MERGED into the
   system prompt (`persona.ts`). Update voice path (`panel-context-bridge`,
   `ChatPanel:1863`) to the map.
3. C: make `fav_list` return the real favorites (via guaranteed context), and
   add `fav_list` + favoritesList read guidance to `system-prompt.ts`.

## Open questions
- Map approach: token-cost blowup from injecting all 5 panel contexts vs only
  active + persistent(BGM). Which is better?
- How to carry the "invalidate stale context on panel switch" policy
  (current line 46) into a map without leaking stale data?
- Interaction of the map merge with the voice Live mid-session inject
  (`panel-context-bridge.ts` debounce + JSON diff) — anything missed?
- When changing A to `clear()`, any conflict with the sequential queued-message
  send (`ChatPanel.tsx:635-639`) where a previous turn's audio should
  legitimately continue?
