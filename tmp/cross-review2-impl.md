# Cross-review ROUND 2 — review the ACTUAL implementation diff

You are an independent adversarial reviewer. A previous review agreed a plan;
this round reviews the CODE THAT WAS ACTUALLY WRITTEN. Read the real files in
this repo (paths below) AND the diff at `tmp/impl-diff.patch`. Find bugs,
regressions, missed call sites, races, and anything that won't actually fix the
two reported bugs. Do NOT write code. Be concise. Output:
(1) does each change do what it claims, (2) concrete bugs/regressions with
file:line, (3) anything still broken for the two user bugs, (4) GO / NO-GO.

## The two user bugs being fixed
1. Chat TTS keeps reading the previous turn after a new turn starts (should stop
   and read from the new turn).
2. AI cannot read YouTube BGM favorites; it hallucinates song titles.

## What was implemented (6 edits / 5 files)
1. `shell/src/components/ModeBar.tsx`: pass a real bridge to the always-on BGM
   player — `<BgmPlayer naia={getBridgeForPanel("bgm")} />` (a module-level
   `const bgmBridge`). Root cause was that `<BgmPlayer />` had no `naia` prop, so
   `BgmPlayer.tsx:357 if (!naia) return` made the context push dead code.
2. `shell/src/stores/panel.ts`: split panel context into two buckets —
   `activePanelContext` (cleared on panel switch) + `persistentPanelContexts:
   Record<string,PanelContext>` (keyed; only types in
   `PERSISTENT_CONTEXT_TYPES = {"bgm"}`). `setActivePanelContext` routes by
   `ctx.type`. Added `selectPromptPanelContexts(state)` returning
   `[active, ...persistent (deduped by type)]`.
3. `shell/src/lib/persona.ts`: `MemoryContext.panelContext` (single) →
   `panelContexts[]`; render one `Panel [type] context: {json}` block per entry.
4. `shell/src/components/ChatPanel.tsx`:
   - `buildMemoryContext` now sets `ctx.panelContexts =
     selectPromptPanelContexts(usePanelStore.getState())`.
   - New `interruptTts()` helper: `audioQueue.clear()` +
     `sentenceChunker.clear()` + `activeTtsRequests.clear()` +
     `window.speechSynthesis.cancel()` + `ttsPlayingRef=false` +
     `setTtsPlaying(false)` + `setSpeaking(false)`.
   - `handleSend` new-turn line replaced `audioQueueRef.current?.resetSeq()` with
     `interruptTts()`.
   - `handleNewConversation` calls `interruptTts()` before `newConversation()`.
5. `agent/src/system-prompt.ts`: added `fav_list` to the action list; added a
   line telling the model favorites are in BGM context `favoritesList`/`
   favoritesCount`, and to NOT fabricate titles if absent/empty.
6. `agent/src/skills/built-in/youtube-bgm.ts`: `fav_list` now returns an honest
   "read favoritesList from context, do not invent titles" string.

## Specific things to scrutinize
- Does `interruptTts()` at the new-turn site (after `startStreaming()`) have any
  ordering/stale-closure issue? Is clearing the OLD sentenceChunker before a new
  one is created later in `handleSend` safe?
- `selectPromptPanelContexts` dedupe logic: `ctx.type !== activePanelContext?.type`.
- Does the voice/Live path still work? `ChatPanel:1863`
  `getContext: () => activePanelContext` no longer returns bgm (now persistent).
  Is that an acceptable non-regression (bgm baked at connect via buildSystemPrompt)?
- `BgmPlayer` push effect deps — is `bgmBridge` reference stable across renders so
  the effect doesn't loop? (bridge is cached in `getBridgeForPanel`.)
- Any consumer still reading the old `MemoryContext.panelContext` (singular)?
- Token cost: are only active + bgm injected, not all 5 panels?
- The queued-message path (`ChatPanel` ~635-639 → scheduleNextQueuedMessage →
  handleSend → interruptTts): user CHOSE "always clear on new turn" — confirm
  this is what the code does and there's no path that double-clears or loses the
  first audio incorrectly.
