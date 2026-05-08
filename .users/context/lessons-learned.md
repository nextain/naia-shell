# Lessons Learned

> Mirror: `.agents/context/lessons-learned.yaml`

Accumulated lessons from development cycles. Read during INVESTIGATE phase. Written during SYNC phase.

**Schema**: `id`, `date`, `issue`, `category`, `title`, `problem`, `root_cause`, `fix`, and optional `scope` (file glob or module name — omit for global/workflow-level lessons). Example scope: `"shell/src/audio/*"`, `"agent/llm-registry"`.

> **Context Update Rule**: If a new lesson is similar to an existing entry → do NOT add a duplicate. Strengthen a hook instead (see `harness.md` → Context Update Matrix).

---

## L001 — E2E incomplete but marked as complete (#60)

**Date**: 2026-03-15 | **Category**: Testing

**Problem**: LLM Provider Registry (#60) was marked as 5-phase complete, but E2E provider switching tests were blocked by infrastructure issues (tauri-driver SIGINT). Work was reported as "done" without actual E2E verification.

**Root cause**: No rule requiring E2E completion before marking work done. AI success bias — uncertain state reported as complete.

**Fix**: Added test_attitude rules, diagnose step in on_failure, success_bias_reporting in AI behavioral traps.

---

## L002 — Test pass ≠ correct behavior

**Date**: 2026-03-15 | **Category**: Testing

**Problem**: AI loosened test assertions to make failing tests pass instead of investigating app code bugs.

**Root cause**: e2e_test phase output was defined as "Passing E2E test", making "pass" the explicit goal. No anti-patterns for test gaming.

**Fix**: Output redefined to "E2E diagnostic complete". Added test_attitude anti-patterns (assertion loosening, expected value gaming, test deletion).

---

## L003 — Debug logging added only after bugs discovered

**Date**: 2026-03-15 | **Category**: Observability

**Problem**: When a bug occurred, first step was always adding Logger.debug() — meaning the first occurrence was always undiagnosed.

**Root cause**: debug_logging rules specified what and how to log, but not WHEN (build-time vs debug-time).

**Fix**: Added debug_logging.when rule: "Debug logging is a BUILD-TIME activity". Added to review checklists.

---

## L004 — Landscape research skipped — wrong upstream target discovered after full implementation (#73)

**Date**: 2026-03-18 | **Category**: Upstream Integration

**Problem**: Implemented SupportsAudioOutput in a vllm fork only to discover vllm-omni is the correct upstream target. Audio output was explicitly scoped out of vllm main (RFC #16052). Full implementation wasted.

**Root cause**: No pre-work research step before forking. RFC history not checked. Sub-project existence (vllm-omni) not discovered. No upstream issue opened before coding.

**Fix**: Added `upstream-contribution.yaml` workflow — landscape research required before any implementation (scope check, AI policy, RFC history, sub-project discovery, maintainer stance). Progress file `upstream_issue_ref` field added. commit-guard advisory for upstream contributions.

**Reference**: `.agents/context/upstream-contribution.yaml`

---

## L005 — Context compaction skips mandatory reads — rules not followed in resumed session (#89)

**Date**: 2026-03-19 | **Category**: Workflow

**Problem**: When context was compacted and session resumed from summary, AI jumped directly into implementation without performing mandatory reads (agents-rules.json, ai-work-index.yaml, project-index.yaml). Result: build-time logging skipped, iterative review not done, success_bias_reporting triggered, user felt AI was developing autonomously without oversight.

**Root cause**: CLAUDE.md mandatory reads say "every session start". But compacted resumption is treated as a continuation, not a new session — the mandate was never triggered. Summary did not contain a reminder to re-read rules.

**Fix**: After context compaction, the resumed session MUST treat itself as a new session start: read agents-rules.json before proceeding with any implementation. Progress file (`.agents/progress/*.json`) must be maintained so resumed sessions know which phase/gate they are in.

---

## L006 — panel_install_result must arrive before panel_control reload — timing is critical (#89)

**Date**: 2026-03-20 | **Category**: IPC | **Scope**: `shell/src/components/PanelInstallDialog.tsx`, `agent/src/index.ts`

**Problem**: PanelInstallDialog auto-close logic depends on `successRef` being set by `panel_install_result`. If `panel_control reload` arrives first, `successRef` is still false → dialog never closes even on success.

**Root cause**: `actionInstall` internally emits `panel_control reload` at the end. The agent wrapper did not suppress this and emitted its own reload after the result — but order was not guaranteed.

**Fix**: Agent `panel_install` handler passes `writeLine: () => undefined` to `actionInstall` (suppresses inner `panel_control`). After awaiting result, it explicitly emits `panel_install_result` FIRST, then `panel_control reload` (only if success). Order is now deterministic.

---

## L007 — Events without requestId cannot use chat-service filter — use direct listen() (#89)

**Date**: 2026-03-20 | **Category**: IPC | **Scope**: `shell/src/components/PanelInstallDialog.tsx`, `shell/src/lib/chat-service.ts`

**Problem**: `panel_install_result` has no `requestId` field. `chat-service.ts` filter drops any chunk where `chunk.requestId !== requestId`, so `panel_install_result` was silently discarded.

**Root cause**: `requestId` filter was written for chat responses (all of which carry `requestId`). New event types that originate outside the normal chat flow do not carry `requestId`.

**Fix**: `PanelInstallDialog` uses Tauri `listen('agent-response-chunk')` directly, bypassing `chat-service`. TypeScript type check also required guard: `!('requestId' in chunk) || chunk.requestId !== requestId`.

---

## L008 — Terminology drift (app vs panel) causes widespread confusion — pick one and enforce (#89)

**Date**: 2026-03-20 | **Category**: Naming | **Scope**: `agent/src/skills/built-in/panel.ts`, `shell/src-tauri/src/panel.rs`, `docs/`

**Problem**: Mid-implementation, "app" terminology was partially adopted (`app.json`, `~/.naia/apps/`). Mixed with existing "panel" terms, creating broken file references and confusing documentation.

**Root cause**: Naming decision was made informally and not propagated atomically. Each file was updated independently without a checklist.

**Fix**: Reverted all "app" terms back to "panel". Enforced: `panel.json`, `~/.naia/panels/`, `panel_list_installed`, `panel_remove_installed`, `PanelDescriptor`. Added `critical_gotchas.terminology` in `architecture.yaml`.

---

## L009 — kill -0 succeeds on zombie processes — CDP health check required to detect Chrome death (#95)

**Date**: 2026-03-20 | **Category**: Process Management | **Scope**: `shell/src-tauri/src/browser.rs`

**Problem**: When Chrome was killed with SIGKILL, it became a zombie (parent hadn't reaped it). `libc::kill(pid, 0)` returns 0 for zombies because the PID still exists in the process table. The monitor thread never emitted `browser_closed`, so the frontend never showed the error UI.

**Root cause**: `kill -0` is a live/dead check at the OS level, not a responsive-process check. A zombie occupies a PID slot but serves no HTTP.

**Fix**: Added CDP `/json/version` health check as secondary detector: if `kill -0` succeeds but CDP refuses connection, Chrome is a zombie → emit `browser_closed`. See `spawn_chrome_monitor()` in `browser.rs`.

---

## L010 — CEF Rust bindings not production-ready as of 2026 — use Chrome binary + XReparentWindow (#95)

**Date**: 2026-03-20 | **Category**: Frontend | **Scope**: `shell/src/panels/browser/*`

**Problem**: Considered using CEF (Chromium Embedded Framework) Rust bindings for an embedded browser. All available Rust CEF crates are experimental, unmaintained, or archived as of 2026.

**Root cause**: CEF Rust ecosystem is immature. CEF itself is a C++ library and Rust bindings lag behind significantly.

**Fix**: Use Chrome binary subprocess + X11 XReparentWindow (`x11rb`) for embedding. Achieves identical UX: user sees Chromium, CDP is available for AI. Requires `GDK_BACKEND=x11` (XWayland mode) and must run via distrobox (not host Bazzite) for GTK/WebKit library linking.

---

## L011 — gemini-2.5-flash-live is WebSocket-only — SSE /v1/chat/completions returns silent 0-byte body (#95)

**Date**: 2026-03-20 | **Category**: Provider | **Scope**: `agent/src/providers/lab-proxy.ts`

**Problem**: User set LLM model to `gemini-2.5-flash-live` for text chat. Lab proxy sent it to Vertex AI `/v1/chat/completions` (SSE endpoint). Vertex AI returned 200 OK with a completely empty body — no data, no error. App threw "empty SSE stream" error.

**Root cause**: Gemini Live models are WebSocket-only (Live API). Vertex AI's REST endpoint does not support them and silently returns an empty 200 response instead of a proper error.

**Fix**: Added `toGatewayModel()` mapping in `lab-proxy.ts`: `"gemini-2.5-flash-live"` → `"vertexai:gemini-2.5-flash"`. Also added `bytesReceived==0` guard to detect silent 0-byte streams with a clear error message.

---

## L012 — Voice session must receive tools via session.connect() — Gemini says "tools off" without it (#95)

**Date**: 2026-03-20 | **Category**: Voice | **Scope**: `shell/src/components/ChatPanel.tsx`, `shell/src/lib/voice/*`

**Problem**: Gemini Live voice session said "내 도구 사용 설정이 꺼져 있어서 (tools are disabled)" even when `config.enableTools=true`. User could see the tools toggle was on. The AI's voice responses showed it thought tools weren't available.

**Root cause**: `session.connect()` was called without a `tools` parameter. Gemini Live's `function_declarations` field was empty. Even if the system prompt mentioned tools, Gemini won't call them unless they're declared in the session setup.

**Fix**: `ChatPanel` reads active panel tools from `panelRegistry.get(activePanelId)?.tools`, maps them to `ToolDeclaration` format, and passes to `session.connect({ tools: voiceTools, systemInstruction: voiceSystemPrompt })`. System prompt also appended with explicit tool list and "call them proactively" instruction.

---

## L013 — position:fixed overlays cover full viewport including embedded Chrome X11 area (#95)

**Date**: 2026-03-20 | **Category**: CSS | **Scope**: `shell/src/styles/global.css`, `shell/src/components/SettingsTab.tsx`

**Problem**: STT model modal (`.sync-dialog-overlay` uses `position:fixed; left:0; right:0`) appeared over the Chrome X11 embedded area instead of staying within the naia chat panel.

**Root cause**: `position:fixed` positions relative to the viewport, which includes the full window width. The Chrome X11 window is embedded at `x > naia-panel-width`, so fixed overlays that stretch to `right:0` cover the Chrome area.

**Fix**: Added `.panel-modal-overlay` class with `width: var(--naia-width, 320px)` instead of `right:0`. Modals that must stay within the panel should use this class rather than the full-viewport `.sync-dialog-overlay`.

---

## L014 — CSS syntax error in global.css causes entire Vite app to fail to render — all E2E tests fail with "element not found" (#99)

**Date**: 2026-03-21 | **Category**: CSS | **Scope**: `shell/src/styles/global.css`

**Problem**: E2E tests failed at `beforeEach` with "locator(.chat-panel) not found" even though config and mock were correct. All 13 tests failed.

**Root cause**: A CSS editing mistake left an orphaned `color:` property and `}` outside any rule at `global.css:5117–5118`. PostCSS threw "Unexpected }" parse error, Vite showed the error overlay and never mounted React.

**Fix**: Removed the orphaned lines. Always verify CSS compiles successfully after editing `global.css` — check browser devtools or Vite server response for `[plugin:vite:css]` errors before running E2E.

---

## L015 — Playwright strict mode: `[data-panel-id]` matches both wrapper div and button — use `button[data-panel-id]` (#99)

**Date**: 2026-03-21 | **Category**: E2E | **Scope**: `shell/e2e/*.spec.ts`

**Problem**: Locator `'[data-panel-id="workspace"]'` resolved to 2 elements: the wrapper div AND the button inside it. Playwright strict mode threw "strict mode violation" and the test failed.

**Root cause**: ModeBar renders a wrapper div with `data-panel-id` for styling, and the inner button also has `data-panel-id` for accessibility/testing. Using a generic attribute selector matches both.

**Fix**: Use `'button[data-panel-id="workspace"]'` to target only the interactive button element.

---

## L016 — Circular import between FileTree and WorkspaceCenterPanel — inline shared type to break cycle (#99)

**Date**: 2026-03-21 | **Category**: React | **Scope**: `shell/src/panels/workspace/FileTree.tsx`, `shell/src/panels/workspace/WorkspaceCenterPanel.tsx`

**Problem**: `FileTree` imported `ClassifiedDir` type from `WorkspaceCenterPanel`, while `WorkspaceCenterPanel` imported `FileTree`. TypeScript/bundler resolved it but created a circular dependency.

**Root cause**: Both components needed the same `ClassifiedDir` interface. Defining it in the parent (`WorkspaceCenterPanel`) and importing in the child (`FileTree`) created a circular dependency.

**Fix**: Define the inline type directly in FileTree props: `Array<{name: string; path: string; category: string}>`. `WorkspaceCenterPanel` re-exports its own `ClassifiedDir` interface separately for the Naia tool handler.

---

## L017 — `idleToastTimerRef` must be cleared in interval `useEffect` cleanup to prevent setState on unmounted component (#99)

**Date**: 2026-03-21 | **Category**: React | **Scope**: `shell/src/panels/workspace/WorkspaceCenterPanel.tsx`

**Problem**: The idle notification `setInterval` creates a toast timer (`setTimeout`) when idle sessions are detected. The interval cleanup correctly called `clearInterval`, but not `clearTimeout` on the pending toast timer.

**Root cause**: The toast timer runs 6s after an idle alert. If the component unmounts (tab switch) while the timer is pending, `setIdleToast(null)` would be called on an unmounted component.

**Fix**: In the interval cleanup function, also call: `if (idleToastTimerRef.current) clearTimeout(idleToastTimerRef.current)`.

---

## L018 — Keep-alive panels must use `display:contents` (not `display:block`) to preserve flex layout context (#99)

**Date**: 2026-03-21 | **Category**: React | **Scope**: `shell/src/App.tsx`

**Problem**: Workspace panel was unmounting on tab switch, losing all state. Wrapping in `display:none` div with `display:block` when active broke the flex child layout — children didn't stretch correctly.

**Root cause**: The `content-panel` uses `display:flex`. A wrapper div with `display:block` breaks flex child behavior. `display:contents` makes the wrapper transparent to layout, so children participate in the parent flex context directly.

**Fix**: Use `style={{ display: activePanel === 'workspace' ? 'contents' : 'none' }}` on the keep-alive wrapper div.

---

## L019 — `viewMode` enum is necessary for markdown 3-state view: preview / split / editor (#99)

**Date**: 2026-03-21 | **Category**: React | **Scope**: `shell/src/panels/workspace/Editor.tsx`

**Problem**: `previewMode: boolean` couldn't represent split view (editor+preview side by side).

**Root cause**: Design evolved beyond toggle: markdown needs preview-default, split (live edit), and editor-only. Three mutually exclusive states require a union type.

**Fix**: `type ViewMode = 'editor' | 'preview' | 'split'`. Reset in `useEffect([filePath])` to `isMd ? 'preview' : 'editor'`. CM setup skips when `viewMode === 'preview'`. `updateListener` calls `setContent(text)` for live preview sync in split mode.

---

## L020 — CodeMirror `updateListener` must call `setContent` for live split-view preview; `justLoadedRef` guards initial sync (#99)

**Date**: 2026-03-21 | **Category**: React | **Scope**: `shell/src/panels/workspace/Editor.tsx`

**Problem**: In split mode, typing in CodeMirror didn't update the ReactMarkdown preview because `content` state was only set on file load, not on CM edits.

**Root cause**: CM `updateListener` was responsible only for autosave debounce. Adding `setContent(text)` to `updateListener` enables live preview.

**Fix**: In `updateListener`: if `justLoadedRef.current` is `true`, set to `false` and return early. Otherwise call `setContent(text)` before autosave debounce.

---

## L021 — Drag-resize panel handles: use `pointermove`/`pointerup` on `window` for reliable tracking (#99)

**Date**: 2026-03-21 | **Category**: UI | **Scope**: `shell/src/panels/workspace/WorkspaceCenterPanel.tsx`

**Problem**: Mouse-based resize can lose tracking if cursor moves faster than panel resizes.

**Fix**: In `onPointerDown`: add `document.body.classList.add('resizing-col')`, then `window.addEventListener('pointermove', onMove)` and `window.addEventListener('pointerup', onUp)`. Remove both in `onUp`. Pattern matches `App.tsx` naia-resize-handle implementation.

---

## L022 — X11 XReparentWindow native windows ignore CSS opacity — cannot use CSS keep-alive (#99)

**Date**: 2026-03-21 | **Category**: Tauri | **Scope**: `shell/src/panels/browser/*, shell/src-tauri/src/browser.rs`

**Problem**: Browser panel was included in React keep-alive (position:absolute, opacity:0/1). CSS opacity had no effect on the Chrome X11 window — it remained fully visible even when opacity:0, overlaying the workspace panel.

**Root cause**: `XReparentWindow` embeds Chrome as a native OS child window. These are composited at the OS level, independent of the WebKit compositor. CSS z-index/opacity/visibility have no effect on native X11 windows.

**Fix**: Added `keepAlive?: boolean` to `PanelDescriptor`. Browser panel sets `keepAlive: false` — it unmounts on deactivation (triggering `browser_embed_close`). Proper fix tracked in #102: add `browser_embed_hide`/`show` Rust commands using `XUnmapWindow`/`XMapWindow`.

---

## L023 — `onSessionsUpdate` must be called in catch block too — otherwise parent `initialized` stays false (#99)

**Date**: 2026-03-21 | **Category**: React | **Scope**: `shell/src/panels/workspace/SessionDashboard.tsx`

**Problem**: `WorkspaceCenterPanel` showed loading spinner forever when `workspace_get_sessions` invoke failed. `initialized` state was set via `onSessionsUpdate` callback, which was only called on the success path.

**Root cause**: `SessionDashboard.loadSessions` called `onSessionsUpdateRef.current?.(result)` only on success. On error, `finally` block set `loading:false` but never called `onSessionsUpdate` — `WorkspaceCenterPanel.initialized` remained `false`.

**Fix**: Added `onSessionsUpdateRef.current?.([])` in the `catch` block. Empty array signals "no sessions" to parent and triggers `initialized:true`.

---

## L024 — Panel CSS must use semantic tokens — define per theme, never hardcode colors (#99)

**Date**: 2026-03-21 | **Category**: UI | **Scope**: `shell/src/styles/global.css`

**Problem**: Workspace panel CSS used `var(--bg-base, #1a1a1a)` etc. with dark fallbacks. Since these tokens weren't defined in any theme, the panel always rendered dark regardless of the active theme.

**Root cause**: Semantic tokens (`--bg-base`, `--text-primary`, `--border-color`, `--accent`, `--hover-bg`, etc.) were used in panel CSS but never defined in theme blocks — only raw variables like `--espresso`, `--cream` were defined per theme.

**Fix**: Added semantic token section to every theme (espresso/midnight/ocean/forest/rose/latte/sakura/cloud). Each maps `--bg-base → var(--espresso-dark)`, `--text-primary → var(--cream)`, etc. Documented as PANEL CSS STANDARD comment in `global.css`.

---

## L025 — GitHub Notifications API `subject.url` is null for `RepositoryVulnerabilityAlert` — always null-check (#91)

**Date**: 2026-03-21 | **Category**: API | **Scope**: `issue-desk/src/github/notifications.ts`

**Problem**: GitHub API returns `null` for `subject.url` on `RepositoryVulnerabilityAlert` notification type. Direct string interpolation crashed at runtime.

**Root cause**: GitHub API spec allows `subject.url` to be `null` for certain notification types. No null guard in the URL conversion helper.

**Fix**: Added null-check in `subjectHtmlUrl()`: if `apiUrl` is `null` and type is `RepositoryVulnerabilityAlert`, return `repoHtmlUrl + '/security/dependabot'`. Generic fallback returns `repoHtmlUrl` for other null cases.

---

## L026 — `markRead` optimistic update must be inside try block — revert on failure not implemented (#91)

**Date**: 2026-03-21 | **Category**: UI | **Scope**: `issue-desk/src/components/NotificationList.tsx`

**Problem**: Optimistic UI update (marking notification as read before API response) was applied regardless of API success. On failure, stale read state persisted in UI.

**Root cause**: UI state update was placed before try/catch. The API call could fail silently while the UI showed the item as read.

**Fix**: Moved `setNotifications()` call inside the `try` block, after `await markRead()` succeeds. On catch, the notification remains unread in state. `console.error` logs the failure without crashing.

---

## L027 — Renaming a keyed record requires delete+upsert, not just upsert — Zustand persist array pattern (#91)

**Date**: 2026-03-21 | **Category**: React | **Scope**: `issue-desk/src/components/Settings.tsx`, `issue-desk/src/store/community.ts`

**Problem**: Editing a community profile repo name (the key) and saving with `upsertProfile` left the old-key entry in the persisted array. Both old and new entries coexisted.

**Root cause**: `upsertProfile` matches by `repo` field. If `repo` changes, `findIndex` returns `-1`, so it appends instead of replacing. The old entry is never removed.

**Fix**: On save: if `editingOriginalRepo !== editingProfile.repo`, call `deleteProfile(editingOriginalRepo)` first, then `upsertProfile(editingProfile)`. This ensures old key is removed before inserting the renamed entry.

---

## L028 — `plugin:store|get` must return `[value, exists]` tuple in E2E Tauri mock — `null` crashes `Store.get()` (#116)

**Date**: 2026-03-22 | **Category**: E2E | **Scope**: `shell/e2e/*.spec.ts`

**Problem**: E2E deeplink tests (D1/D2) failed because `@tauri-apps/plugin-store`'s `Store.get(key)` destructures `[value, exists]` from `invoke('plugin:store|get')` result. Mock returned `null` → `TypeError: Cannot destructure property '0' of null`.

**Root cause**: Store API contract: `invoke('plugin:store|get')` always returns a `[value, exists]` tuple. `invoke('plugin:store|load')` returns a Resource ID integer (not null). Mock was returning `null` for both, breaking destructuring.

**Fix**:
```js
if (cmd === "plugin:store|load") return 1;
if (cmd === "plugin:store|get") return [null, false];
```

---

## L029 — keepAlive panels: Playwright `toBeVisible()` ignores parent `opacity:0` — use `slot--active` selector (#116)

**Date**: 2026-03-22 | **Category**: E2E | **Scope**: `shell/e2e/*.spec.ts`

**Problem**: E2E test asserted `.workspace-panel` `not.toBeVisible()` before deeplink click, but the assertion failed — the panel was already "visible". keepAlive panels are always mounted. Parent `.content-panel__slot` uses `opacity:0` (not `display:none`) for inactive panels.

**Root cause**: Playwright's `toBeVisible()` checks the element's own CSS (`display`, `visibility`, `opacity`) but NOT ancestor `opacity`. `opacity:0` on a parent does not make the child "not visible" to Playwright.

**Fix**: Use `.content-panel__slot--active .workspace-panel` selector: the active slot has `opacity:1`, and the selector doesn't match at all when the panel is inactive — so `not.toBeVisible()` passes correctly.

---

## L030 — `FILE_PATH_RE` must use `(?<![/\w])` lookbehind to prevent sub-path false positives (#116)

**Date**: 2026-03-22 | **Category**: Regex | **Scope**: `shell/src/components/ChatPanel.tsx`

**Problem**: Regex `/(\/[\w\-\.\/]+\.ext)/` extracted `/src/App.tsx` from `shell/src/App.tsx` because the leading `/` was matched as an absolute path separator. Relative paths produced clickable deeplink buttons for their sub-paths.

**Root cause**: No lookbehind check. Any `/` in a string was a valid path start, including those preceded by path segment characters (word chars, another `/`).

**Fix**: Added `(?<![/\w])` lookbehind: if the char before `/` is a word character or another `/`, the match is blocked. Also: `tsx`/`jsx` must be listed before `ts`/`js` for longest-match extension resolution.


---

## L031 — `openDirsRef` add-before-await pattern for async dedup in concurrent tool calls (#119)

**Date**: 2026-03-23 | **Category**: React | **Scope**: `shell/src/panels/workspace/WorkspaceCenterPanel.tsx`

**Problem**: Concurrent `skill_workspace_new_session` calls for the same dir spawned duplicate PTY processes. State-based dedup had a race: React state had not yet committed when the second call checked `terminalsRef`.

**Root cause**: React state updates (`setTerminals`) are async — `terminalsRef.current` is only updated during the render body, not when `setTerminals()` is called. A second tool call arriving during `await pty_create` could bypass the state-based dedup check.

**Fix**: Use a separate `useRef` Set (`openDirsRef`) as the dedup source of truth. Add the dir **before** `await pty_create` (blocks concurrent calls immediately). Delete only on failure (`catch`) or tab close — NOT on success.

---

## L032 — `terminalsRef.current` updates on render, not on `setTerminals` — safe to read in callbacks (#119)

**Date**: 2026-03-23 | **Category**: React | **Scope**: `shell/src/panels/workspace/WorkspaceCenterPanel.tsx`

**Problem**: Reviewers flagged `handleCloseTerminal` as having a race condition: "terminalsRef might not find the tab if setTerminals already queued a filter".

**Root cause**: `terminalsRef.current = terminals` runs in the **render body** (synchronously during React render). It is NOT updated when `setTerminals()` is called. Between a `setTerminals()` call and the next render, `terminalsRef.current` still holds the previous array.

**Fix**: No code change needed — the pattern is correct. Add a comment explaining the timing invariant so future reviewers understand why `find()` is safe immediately after `setTerminals()`.

---

## L033 — xterm.js keepAlive: use `opacity:0 + pointerEvents:none`, never `display:none` (#119)

**Date**: 2026-03-23 | **Category**: Frontend | **Scope**: `shell/src/panels/workspace/Terminal.tsx`

**Problem**: Terminal component needed keepAlive stacking (multiple PTY instances, one active at a time). `display:none` was considered but breaks FitAddon.

**Root cause**: `FitAddon.fit()` computes terminal dimensions from the container's `offsetWidth`/`offsetHeight`. When `display:none` is applied, these values are `0` — `fit()` returns `0×0` cols/rows, and the PTY gets resized to an invalid size.

**Fix**: Use `position:absolute; inset:0` CSS on all terminal containers (stacked). Hide inactive terminals via inline `opacity:0; pointerEvents:none`. Guard `pty_resize` with `if (!rows || !cols) return` before calling the Rust command.

---

## L034 — X11 native embed keepAlive: use IPC XUnmapWindow/XMapWindow, not CSS opacity — completes L022 (#102)

**Date**: 2026-03-23 | **Category**: Frontend | **Scope**: `shell/src/panels/browser/*, shell/src/stores/panel.ts`

**Problem**: L022 noted CSS opacity has no effect on X11 native windows and set `keepAlive:false` as a workaround (unmount/remount = Chrome restart on each tab switch = slow, blank screen).

**Root cause**: X11 native child windows are composited at OS level; WebKit compositor has no authority over them. Unmounting the React component causes `browser_embed_close` (Chrome restart) on next activation.

**Fix**: Set `keepAlive:true` on browser panel. Rust adds `browser_embed_hide` (XUnmapWindow) and `browser_embed_show` (XMapWindow). `panel.ts setActivePanel` calls these IPC commands on tab switch. Chrome stays alive — no restart, no blank screen.

---

## L035 — Store action invoke-before-set pattern: invoke must be called BEFORE set() to guarantee modal ordering (#102)

**Date**: 2026-03-23 | **Category**: React | **Scope**: `shell/src/stores/chat.ts, shell/src/components/ChatPanel.tsx`

**Problem**: PermissionModal appeared but was hidden behind the Chrome X11 window for 1 frame. `ChatPanel` `useEffect` called `browser_embed_hide` after React re-render, so Chrome was visible during the render where the modal first appeared.

**Root cause**: `useEffect` fires **after** React commits to DOM (post-paint). In that window, the native Chrome window remained visible over the freshly-rendered modal.

**Fix**: Move `invoke('browser_embed_hide')` into `setPendingApproval` store action, **before** `set({pendingApproval})`. Store actions execute synchronously; the invoke is dispatched before React sees the state change. `useEffect` approach is 1 frame too late for native window ordering.

---

## L036 — All pendingApproval-clearing paths must be symmetric with setPendingApproval hide (#102)

**Date**: 2026-03-23 | **Category**: React | **Scope**: `shell/src/stores/chat.ts`

**Problem**: After adding `browser_embed_hide` to `setPendingApproval`, Chrome remained permanently hidden when approval was cleared via `finishStreaming` or `newConversation`. These paths set `pendingApproval:null` without calling `browser_embed_show`.

**Root cause**: Only `clearPendingApproval` was written as the "mirror" of `setPendingApproval`. `finishStreaming` and `newConversation` used `set()` directly, bypassing the show guard.

**Fix**: Every path that sets `pendingApproval:null` must have the guard: `if (get().pendingApproval && usePanelStore.getState().activePanel === "browser") invoke("browser_embed_show")`. Three paths: `clearPendingApproval`, `finishStreaming` (before `set()`), `newConversation` (before `set()`). Also add `get().pendingApproval` guard to `clearPendingApproval` — prevents `show()` when there was no prior `hide()`.

---

## L037 — E2E Tauri mock command name must exactly match Rust invoke() call — wrong name causes silent no-op state (#102)

**Date**: 2026-03-23 | **Category**: E2E | **Scope**: `shell/e2e/*.spec.ts`

**Problem**: Browser panel E2E tests showed the panel stuck in `"no-chrome"` state. `browser_check` was mocked as `browser_check_available`, so the mock returned `undefined` (not `true`). The panel status guard never reached `"ready"`.

**Root cause**: Tauri mock intercepts by exact string match. When the command name in the mock differs from the actual Rust command, it falls through to `return undefined`. For `browser_check`, `undefined` is falsy — panel state machine branched to the `"no-chrome"` path.

**Fix**: Always grep the actual Rust invoke name (`shell/src-tauri/src/*.rs` `invoke!` macro or TS files) before writing mock entries. Use `"browser_check"`, not `"browser_check_available"`. Verify mock by checking that the panel reaches expected status before making behavioral assertions.

---

## L038 — `window.parent.origin` throws SecurityError in cross-origin iframe — use `"*"` with server-side validation (#98)

**Date**: 2026-03-23 | **Category**: Security | **Scope**: `shell/src/lib/naia-bridge-client.ts`

**Problem**: `naia-bridge-client.ts` used `window.parent.postMessage(req, window.parent.origin)`. In Tauri, the iframe (`http://asset.localhost`) and Shell (`tauri://localhost`) are cross-origin, so accessing `window.parent.origin` throws SecurityError.

**Root cause**: Cross-origin iframe spec: accessing `parent.origin` from a child of a different origin throws SecurityError. Browser security restriction, not Tauri-specific.

**Fix**: Use `window.parent.postMessage(req, "*")`. Safe because `iframe-bridge.ts` validates `event.origin === 'http://asset.localhost'` on receipt.

---

## L039 — jsdom drops postMessage with mismatched targetOrigin — spy on `source.postMessage` to capture bridge responses (#98)

**Date**: 2026-03-23 | **Category**: Testing | **Scope**: `shell/src/lib/__tests__/iframe-bridge.test.ts`

**Problem**: `iframe-bridge.ts` sends `respond()` via `postMessage(data, 'http://asset.localhost')`. jsdom silently drops the message if the receiver window origin doesn't match.

**Root cause**: jsdom enforces targetOrigin matching. Test window origin is `'null'` (jsdom default), so the message is dropped.

**Fix**: Use `vi.spyOn(source, 'postMessage')` before dispatching. After `await setTimeout(30)`, check `spy.mock.calls` to find the response by `id` — intercepts before jsdom filtering.

---

## L040 — `remove_dir_all` without canonicalize allows symlink attack on panel removal (#98)

**Date**: 2026-03-23 | **Category**: Security | **Scope**: `shell/src-tauri/src/panel.rs`

**Problem**: `panel_remove_installed` validated `panelId` for path separators but called `remove_dir_all(&panel_dir)` directly. If `~/.naia/panels/{id}` was a symlink outside HOME, `remove_dir_all` would follow it and delete target contents.

**Root cause**: String validation on `panelId` doesn't prevent the directory itself from being a symlink.

**Fix**: After `exists()`, call `canonicalize()` and verify `starts_with(home_path)` before `remove_dir_all(&canonical)`. Mirrors `panel_read_file`'s pattern.

---

## L041 — `OnceLock<Mutex<String>>` initial value must be the compile-time fallback, not `String::new()` (#107)

**Date**: 2026-03-23 | **Category**: Rust | **Scope**: `shell/src-tauri/src/workspace.rs`

**Problem**: `OnceLock::get_or_init(|| Mutex::new(String::new()))` initializes the Mutex with an empty string. Any thread calling `get_workspace_root()` between OnceLock initialization and the first `workspace_set_root` call sees `""` instead of the fallback root.

**Root cause**: `String::new()` was chosen for ergonomics. But the initial value is the first observable value for any reader arriving before `workspace_set_root` runs — empty string silently produces wrong behavior (empty scan root, missing sessions).

**Fix**: Use `WORKSPACE_ROOT.to_string()` as the initial value: `get_or_init(|| Mutex::new(WORKSPACE_ROOT.to_string()))`. Matches the compile-time fallback semantics and eliminates the race window.

---

## L042 — `workspaceReady` gate: React child effects can fire before parent IPC completes (#107)

**Date**: 2026-03-23 | **Category**: React | **Scope**: `shell/src/panels/workspace/WorkspaceCenterPanel.tsx`

**Problem**: `SessionDashboard`'s `workspace_get_sessions` `useEffect` fired before `WorkspaceCenterPanel`'s `workspace_set_root` invoke completed. Sessions were scanned from the wrong (stale hardcoded) root.

**Root cause**: React's `useEffect` runs children effects before parent effects in some mount orderings. Without a gate, `SessionDashboard` mounted and triggered its load before `workspace_set_root` resolved.

**Fix**: Add `workspaceReady` boolean state in the parent. Only render the child component when `workspaceReady === true`. Set it to `true` inside `.finally()` of the `workspace_set_root` invoke chain. Child never mounts until IPC completes.

---

## L043 — Return canonical path from Tauri IPC command to keep frontend and backend in sync (#107)

**Date**: 2026-03-23 | **Category**: Tauri | **Scope**: `shell/src-tauri/src/workspace.rs, shell/src/panels/workspace/WorkspaceCenterPanel.tsx`

**Problem**: `workspace_set_root` originally returned `()`. Frontend displayed the raw config path in empty-state messages. On Fedora, `/home/luke` is a symlink to `/var/home/luke` — the raw and canonical paths differ, causing confusing UI.

**Root cause**: Backend calls `p.canonicalize()` internally but discarded the result. Frontend had no way to know the actual path the backend scanned.

**Fix**: Return `Result<String, String>` from `workspace_set_root` with the canonical path on success. Frontend: `.then(canonical => setResolvedRoot(canonical)).catch(() => setResolvedRoot(WORKSPACE_ROOT)).finally(() => setWorkspaceReady(true))`. Pass `resolvedRoot` (not raw config value) to all child components.

---

### L044 — panel_tool_call routing: per-panel bridge factory breaks activeBridge singleton dispatch

**Date**: 2026-03-23 | **Issue**: #120 | **Category**: react
**Scope**: `shell/src/components/ChatPanel.tsx`

**Problem**: After commit 916a657 introduced `getBridgeForPanel()` factory (per-panel bridge instances), `App.tsx` passed `getBridgeForPanel(panel.id)` to each panel but `ChatPanel` still called `activeBridge.callTool()`. These are different `ActivePanelBridge` instances with separate `handlers` Maps — workspace tool calls silently returned `'No handler registered'`.

**Root cause**: The 916a657 commit updated `App.tsx` to use per-panel bridges for isolation, but did not update `ChatPanel`'s `panel_tool_call` handler to route to the owning panel's bridge.

**Fix**: In `panel_tool_call` handler: look up owning panel via `panelRegistry.list().find(p => p.tools?.some(t => t.name === chunk.toolName))`, then use `getBridgeForPanel(ownerPanel.id)` if found, else fall back to `activeBridge`.

---

### L045 — messageQueue stale closure: setInput(next) + setTimeout(() => handleSend()) uses pre-render handleSend

**Date**: 2026-03-23 | **Issue**: #120 | **Category**: react
**Scope**: `shell/src/components/ChatPanel.tsx`

**Problem**: Queue processing `useEffect` called `setInput(next)` then `setTimeout(() => handleSend(), 50)`. The `setTimeout` captured `handleSend` from the current render (where `input = ''`). Even after `setInput(next)` triggered a re-render, the `setTimeout` still held the OLD `handleSend` closure with `input = ''`. `handleSend()` resolved `text = ''` and returned early — message never sent.

**Root cause**: React functional component: every render creates a new `handleSend` closure. `useEffect` captures `handleSend` at the time the effect runs. `setInput(next)` schedules a NEW render but cannot retroactively update the already-captured closure in `setTimeout`.

**Fix**: Pass the queued message directly: `handleSend(next)`. This uses `overrideText` instead of the `input` state closure. Also removed the `setInput(next)` call since `handleSend` already calls `setInput('')`.

---

### L046 — Rust path canonicalization must be consistent across all call sites

**Date**: 2026-03-23 | **Issue**: #121 | **Category**: rust
**Scope**: `shell/src-tauri/src/workspace.rs`

**Problem**: `workspace_get_sessions` built `path_str` via `path.to_string_lossy()` (non-canonical), while `get_main_worktree` returned a canonical path via `std::fs::canonicalize`. On Fedora/Bazzite, `/home` is a symlink to `/var/home`, so non-canonical paths use `/home/…` while canonical paths use `/var/home/…`. The `groupBy(origin_path ?? path)` key comparison silently mismatched — standalone sessions were never grouped.

**Root cause**: Three functions (`workspace_get_sessions`, `workspace_classify_dirs`, `get_all_worktree_paths`) each computed path strings independently without using `std::fs::canonicalize`. One function (`get_main_worktree`) did use canonicalization, creating an asymmetry.

**Fix**: Apply `std::fs::canonicalize(&path).map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|_| path.to_string_lossy().to_string())` at all three call sites. Use the fallback for paths that do not yet exist on disk.

---

### L047 — WatcherState: every cache field must be added to BOTH workspace_get_sessions AND workspace_stop_watch

**Date**: 2026-03-23 | **Issue**: #121 | **Category**: rust
**Scope**: `shell/src-tauri/src/workspace.rs`

**Problem**: `origin_path_cache` was added to `WatcherState` and cloned/used in `workspace_get_sessions`, but was NOT cleared in `workspace_stop_watch`. After a stop → start cycle, the stale cache persisted, causing `get_main_worktree` to never re-run even if the worktree topology changed.

**Root cause**: `workspace_stop_watch` has an explicit clear block for each cache field (`branch_cache_arc`, `status_cache_arc`, …). Adding a new cache field to `WatcherState` without adding it to this clear block leaves it orphaned.

**Fix**: Add `origin_path_cache_arc` to both the clone block in `workspace_get_sessions` and the clear block in `workspace_stop_watch`. Rule: any `Arc<Mutex<HashMap>>` field added to `WatcherState` must appear in both places.

---

### L048 — Zustand store value in useEffect deps causes infinite loop when effect writes to the same key — use getState() instead

**Date**: 2026-03-23 | **Issue**: #91 | **Category**: react
**Scope**: `issue-desk/src/components/TriageView.tsx`

**Problem**: TriageView orphan-cleanup useEffect listed `triageBuckets` as a dependency. The effect reads `triageBuckets` to find orphan entries and then calls `setTriageBuckets` to remove them. This modification triggers a re-render, which re-runs the effect, creating an infinite loop.

**Root cause**: React useEffect runs whenever any listed dependency changes. If the effect itself mutates a dep (even indirectly via a store action), the effect oscillates until React's infinite-loop guard fires.

**Fix**: Inside the useEffect body, read the value via `useWorkflowStore.getState().triageBuckets` instead of the destructured reactive `triageBuckets`. This accesses the store directly without subscribing as a dependency, breaking the loop. Pattern: use `getState()` for read-only side-effect access when the dep would cause oscillation.

---

### L049 — Compute date-derived values once per render — avoid calling daysSince()/Date.now() multiple times for the same field

**Date**: 2026-03-23 | **Issue**: #91 | **Category**: react
**Scope**: `issue-desk/src/components/IssueCard.tsx`

**Problem**: IssueCard needed both the stale boolean and the raw `staleDays` count (for the tooltip title). Calling `isStale(issue.updated_at)` for the boolean and then `daysSince(issue.updated_at)` for the count calls `Date.now()` twice with a tiny time gap, meaning the rendered tooltip title could disagree with the badge condition at a 30-day boundary.

**Root cause**: `isStale()` and `daysSince()` each call `Date.now()` internally. In the same render, two calls can disagree by 1 day at an exact boundary.

**Fix**: `const staleDays = daysSince(issue.updated_at); const stale = staleDays >= 30;` — compute once, reuse both in JSX. Guarantees logical consistency and avoids double-sampling.

---

### L050 — Re-arm notification Set on recovery — error → active/idle must delete from notifiedRef

**Date**: 2026-03-24 | **Issue**: #114 | **Category**: react
**Scope**: `shell/src/panels/workspace/WorkspaceCenterPanel.tsx`

**Problem**: `errorNotifiedRef` tracks sessions that already received error notifications. When a session recovered (`active`/`idle`) and then errored again, the Set still contained the path — so the second error was silently swallowed.

**Root cause**: The Set was only added to (on error) and cleared (on `sessionId null`). Recovery transitions were not handled, breaking the "fire once per session per error bout" contract.

**Fix**: In the `active`/`idle` branch of `handleSessionsUpdate`, call `errorNotifiedRef.current.delete(s.path)` alongside `idleNotifiedRef.current.delete(s.path)`. Symmetric with the `idleNotifiedRef` re-arm pattern. Rule: any `notifiedRef` that gates on session status must be re-armed on recovery, not only cleared on conversation reset.

---

### L052 — vLLM omni model returns audio in choices[1], non-streaming only — AudioQueue needs WAV MIME detection

**Date**: 2026-03-24 | **Issue**: #72 | **Category**: audio
**Scope**: `agent/src/providers/openai.ts`, `shell/src/lib/voice/audio-queue.ts`

**Problem**: MiniCPM-o via vllm-omni returns text in `choices[0].message.content` and audio (base64 WAV) in `choices[1].message.audio.data`, but only in non-streaming mode. AudioQueue hardcoded `audio/mp3` MIME so WAV data was unplayable.

**Root cause**: OpenAI streaming API doesn't support audio output. vllm-omni uses a custom non-streaming response format with dual choices. AudioQueue was written assuming all audio is MP3 (edge-tts output).

**Fix**: Detect `isOmni` (`isVllm && /minicpm[-_]?o/i`) and use non-streaming fetch path in `openai.ts`. In `audio-queue.ts`, detect WAV by base64 prefix `"UklGR"` (RIFF header) and use `audio/wav` MIME. Add `omniAudioReceived` flag in `index.ts` to skip TTS synthesis when omni already sent audio.

---

### L053 — torch_peak_increase inflated by AOT compilation artifacts — use steady-state memory for KV cache sizing

**Date**: 2026-03-24 | **Issue**: #85 | **Category**: ml-infra
**Scope**: `vllm-omni/vllm_omni/worker/base.py`

**Problem**: vllm-omni memory profiling fallback used `torch_peak_increase` to estimate profiled_usage, but `torch.compile`/AOT compilation buffers temporarily spike memory then free after compilation. This caused `available_kv_cache_memory_bytes` to be underestimated.

**Root cause**: `after_profile.torch_memory` (`memory_reserved()` after `gc+empty_cache`) reflects steady state (weights + persistent buffers only). Peak captures transient compile artifacts.

**Fix**: Use `steady_state_torch = profile_result.after_profile.torch_memory` instead of `model_memory_usage + torch_peak_increase`. Non-torch increase still added via `max(0, non_torch_increase)`.

---

### L051 — Place panel-level tests inside the correct describe block — not the Editor describe

**Date**: 2026-03-24 | **Issue**: #114 | **Category**: testing
**Scope**: `shell/src/panels/__tests__/workspace-panel.test.tsx`

**Problem**: `errorAlert` and re-arm tests were initially placed inside the `Editor` describe block. This caused logical grouping errors and misleading test names in the output.

**Root cause**: Review-pass Pass 3 caught the misplacement. The `Editor` describe covers file-type rendering; `WorkspaceCenterPanel` describe covers session lifecycle and context push behaviour.

**Fix**: Move `errorAlert` tests to the `WorkspaceCenterPanel` describe block. Rule: always match the test subject (component under test) to the describe block name.

---

## L054 — Claude refuses to "be a bad reviewer" — use code to simulate bad output (#165)

**Date**: 2026-03-29 | **Category**: Testing | **Scope**: `.agents/tests/fixtures/mock-reviewers/`

**Problem**: TC-2.1 asked Claude to produce intentionally malformed/bad review output via prompt ("Do NOT follow any report format"). Claude's helpfulness bias completely overrode the instruction and produced a fully structured, high-quality report.

**Root cause**: LLM alignment — Claude prioritizes being helpful over following instructions to be unhelpful. This is a fundamental characteristic, not a bug.

**Fix**: Write deterministic code (`malformed-reviewer.js`) that generates bad output based on empirically observed SLOP patterns (hedge cascade, scope overflow, structural parroting, stale cache, confidence laundering). Bypass the LLM entirely for test fixture generation.

---

## L055 — Specialized reviewer solo findings ≠ bad reviewer solo findings (#165)

**Date**: 2026-03-29 | **Category**: Framework Design | **Scope**: `.agents/skills/cross-review/SKILL.md`

**Problem**: In TC-Phase2-04, the security reviewer accumulated 3 strikes from legitimate solo security findings (command injection, auth bypass, PID reuse). Same auto-dismiss treatment as a bad reviewer's impractical findings.

**Root cause**: Strike accumulator counted ALL auto-dismissed solo findings equally, without checking whether the finding was within the reviewer's domain of expertise.

**Fix**: Added domain-relevance check in 8A Strike Accumulator. Domain-consistent solo findings (security finding from security reviewer) do NOT increment strikes. Only domain-inconsistent findings (e.g., nation-state threat from a standard reviewer) count.

---

## L056 — session-inject picks wrong issue in multi-session workspace (#165)

**Date**: 2026-03-29 | **Category**: Harness | **Scope**: `.claude/hooks/session-inject.js`

**Problem**: With multiple Claude sessions running concurrently, session-inject always showed the most recently modified progress file — another session's issue would override the current one.

**Root cause**: Hook used mtime-based selection with no session awareness. Also only scanned `cwd/.agents/progress/`, missing submodule progress files.

**Fix**: (1) Added `.session-map.json` for session_id → issue mapping. (2) Scan submodule `*/.agents/progress/` directories. (3) Priority: session-specific claim > mtime fallback.

---

## L059 — Windows browser panel: WebView2 child window replaces Win32 SetParent; invoke-before-set pattern unchanged (#249)

**Date**: 2026-05-07 | **Category**: platform | **Scope**: `shell/src-tauri/src/browser_webview.rs`, `shell/src/stores/chat.ts`

**Problem**: Win32 SetParent embedding caused Z-order artifacts. Migrated to Tauri WebView2 child window. IPC command names changed: `browser_embed_hide/show` → `browser_wv_hide/show`.

**Root cause**: WebView2 provides a first-class child window API with DPI-aware `LogicalPosition`/`LogicalSize`.

**Fix**: New Rust module `browser_webview.rs`. Core commands: `browser_wv_create`, `browser_wv_navigate`, `browser_wv_hide`, `browser_wv_show`, `browser_wv_resize` (plus full browser control suite). The invoke-before-set pattern from L041/L043 still applies: `invoke("browser_wv_hide")` BEFORE `set({ pendingApproval })`. The three-path guard still applies: `clearPendingApproval`, `finishStreaming`, `newConversation` each call `browser_wv_show` only when `pendingApproval` was truthy.

**Note**: Linux path (X11 XReparentWindow) is unchanged — L041/L043 still apply for Linux.

---

## L060 — @nextain/naia-memory R3: HeuristicContradictionFilter not in top-level index; API is encode/recall not storeEpisode/recallEpisodes (#242)

**Date**: 2026-05-07 | **Category**: testing | **Scope**: `agent/src/__tests__/naia-memory-r3-integration.test.ts`

**Problem**: Two integration test traps: (1) `HeuristicContradictionFilter` not re-exported from top-level `@nextain/naia-memory` index. (2) Public API uses `encode()`/`recall()` — old names `storeEpisode()`/`recallEpisodes()` removed.

**Root cause**: R3 refactored API surface. `HeuristicContradictionFilter` is an internal implementation detail; `MemorySystemOptions.contradictionFilter` is the consumer-facing entry point.

**Fix**:
- Import from subpath: `import { HeuristicContradictionFilter } from ".../memory/contradiction-filter.js"`
- Correct API: `ms.encode(input: MemoryInput, context: EncodingContext)` to store; `ms.recall(query, RecallContext)` returns `{episodes, facts, reflections}`
- `recall()` is query-based, not session-scoped — test session isolation via content queries

---

## L058 — Don't invent client-side protocols over upstream endpoints — follow the fork when it deprecates (#219)

**Date**: 2026-04-25 | **Category**: upstream-integration | **Scope**: `shell/src/lib/voice/minicpm-o.ts`

**Problem**: The naia-os voice client spoke a fork-only `/v1/omni` WebSocket protocol (binary PCM frames plus custom `session.config` / `input.done` / `turn.start` events) that only worked against a vllm-omni fork experiment. The fork team removed that endpoint on 2026-04-08 (archived to `vllm-omni/ref/omni_duplex_v1/`), breaking every live voice connection with 403 Forbidden.

**Root cause**: The client was layered on a fork-only experiment instead of the upstream-compatible `/v1/realtime` (OpenAI Realtime API) surface. Upstream had converged on `/v1/realtime` with `OmniRealtimeConnection` emitting `modalities=[audio, text]`; the fork team followed by removing `/v1/omni`, but the naia-os client did not. The file-header claim "`/v1/realtime` is ASR-only" was already stale and load-bearing.

**Fix**: Rewrote `minicpm-o.ts` natively on `/v1/realtime` — base64 PCM16 via `input_audio_buffer.append`, explicit `input_audio_buffer.commit` + `response.create`, passthrough of `response.audio.delta` (no WAV decode), handling of `response.audio_transcript.delta` / `response.done`, and `response.cancel` for barge-in. Verified end-to-end with vllm-omni's reference client `realtime_e2e_test.py` against local `pc-bazzite:8000` (TTFA 1.31s).

**Reference**: issues #216 (server prerequisite) and #219 (client migration); cross-review `cr-20260425-021205`.
