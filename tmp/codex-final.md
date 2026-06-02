**Review Result**

1. **Root Causes**
- **A confirmed, with one missed edge.** `resetSeq()` only resets sequencing; `clear()` stops current HTML audio and clears queued MP3 chunks. So [ChatPanel.tsx](D:/alpha-adk/projects/naia-os/shell/src/components/ChatPanel.tsx:704) should not use `resetSeq()` for a new turn. Missed: browser/client-side `speechSynthesis.speak()` in `sendSentenceToTts()` is not controlled by `AudioQueue.clear()`, so browser TTS needs `window.speechSynthesis.cancel()` too. Also consider `handleNewConversation()` clearing TTS.
- **B confirmed.** Store is single-slot: [panel.ts](D:/alpha-adk/projects/naia-os/shell/src/stores/panel.ts:14), switch clears it at [panel.ts](D:/alpha-adk/projects/naia-os/shell/src/stores/panel.ts:46), and every `pushContext()` overwrites it through [panel-registry.ts](D:/alpha-adk/projects/naia-os/shell/src/lib/panel-registry.ts:147). BGM favorites can be overwritten by workspace/browser/etc.
- **C confirmed, but proposed fix is partly wrong.** `fav_list` returns only a pointer string in [youtube-bgm.ts](D:/alpha-adk/projects/naia-os/agent/src/skills/built-in/youtube-bgm.ts:182). The agent skill execution context does not include panel context: [types.ts](D:/alpha-adk/projects/naia-os/agent/src/skills/types.ts:11). So `fav_list` cannot “return real favorites via guaranteed context” unless you add a new data path into skill execution or make Shell handle a read request.

2. **Plan Risks**
- Injecting all panel contexts is unnecessary token spend and stale-data risk. Some contexts, especially workspace/sample-note, can grow.
- `panel-context-bridge.ts` currently skips `null` context and sends exactly one context object. With a map/composite model, it must send removals too; otherwise Live sessions retain stale panel data.
- Keying only by `ctx.type` is acceptable for current types, but `panelId` is safer if future panels share a context type.
- `fav_list` in `system-prompt.ts` guidance may encourage a tool call that still returns no data. Either make it real or tell the model to read BGM context directly and avoid `fav_list`.

3. **Open Questions**
- **All 5 contexts vs active + persistent BGM:** use active panel context plus persistent whitelist, starting with `bgm`. Do not inject all.
- **Stale invalidation on switch:** keep the map, but select for prompt as `{ bgm if present, activePanel context if present }`. On switch, do not delete BGM; exclude old non-persistent contexts by selector. For Live, dispatch the new composite immediately/debounced, including absence of the old active context.
- **Voice Live bridge interaction:** update bridge type from single `PanelContextUpdate | null` to composite context. Do not skip empty/null updates. Diff the selected composite, not the whole store. Consider replay-on-attach or initial composite consistency.
- **`clear()` vs queued sends:** queued sends auto-start after streaming ends, not after TTS ends. If a queued user message starts a new turn, stopping old TTS is consistent with the bug report. If product wants “finish reading before queued follow-up,” queue scheduling must wait for audio idle instead. Current behavior points to `clear()`.

4. **Recommended Final Plan**
- Replace new-turn `resetSeq()` with an interrupt helper: `audioQueue.clear()`, `speechSynthesis.cancel()`, clear chunker/pending TTS state where needed. Use it in `handleSend()` and `handleNewConversation()`.
- Change panel store to hold a context map plus `activePanel`. Render only selected contexts: persistent `bgm` plus current active panel.
- Update `buildMemoryContext()`, `persona.ts`, and Live panel-context bridge to accept/send a composite selected context, including stale removals.
- For `fav_list`, either remove/avoid it and strengthen prompt guidance to read `BGM context.favoritesList`, or add an explicit Shell-backed read path. Agent-only implementation cannot read favorites with the current `SkillExecutionContext`.