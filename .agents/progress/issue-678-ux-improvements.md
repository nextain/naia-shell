# Issue 678: UX Improvements for Herdr & Naia Shell
- **Current Phase:** BUILD & VERIFICATION COMPLETE
- **Status:** Complete (Ready for Reviewer)

## UNDERSTAND
- **Product Concept (PC)**: Improve the usability (UX) of Naia Shell and Herdr to remove friction points found in QA (e.g., infinite loading on Ctrl+P, missing mouse events, missing shortcuts like Ctrl+W, unclear UI text) and enhance the AI's contextual awareness of the workspace.
- **Goal**: Address 7 specific UI/UX bug fixes and layout improvements within `naia-shell`. Epics 8 and 9 (AI action & control) are deferred to a separate issue as recommended by the issue description.
- **Boundary**: `packages/shell/src/apps/workspace/*`, `packages/shell/src-tauri/*`, and related shell components and styles.

## SCOPE
- Scope Mode: EXPANSION (Completeness-first for the 7 UX/Feature items, omitting Epics 8 & 9).
- L1 (Direct edits): 
  - `Terminal.tsx` (Mouse binary events, Ctrl+Click validation with toast)
  - `packages/shell/src-tauri/src/workspace.rs` & `lib.rs` (`workspace_list_files_recursive`, `fs_exists`)
  - `QuickOpen.tsx` & `file-search.ts` (Fast file listing IPC fallback)
  - `HerdrWorkspaceRail.tsx` (Toggle button "Herdr 화면으로")
  - `Editor.tsx` & `global.css` (Full path filename, tooltip, flexible layout)
  - `useHerdrDocuments.ts` (Ctrl+W shortcut with preventDefault)
  - `packages/shell/src/lib/locales/ko.ts` ("AI 참조 컨텍스트" text)
- Depth: internal

## INVESTIGATE (Findings)
1. **Herdr Mouse Events**: `Terminal.tsx` registered `term.onData` to forward PTY data, but mouse tracking sequences (SGR 1006 or X11) from `crossterm` can use binary encoding which requires `term.onBinary` to be forwarded to `writePty`. 
2. **Ctrl+P Infinite Load**: `collectFilesOnly` in `file-search.ts` sequentially `invoke("workspace_list_dirs")` for every folder recursively. This blocked the UI/backend with hundreds of IPC calls. We implemented a Rust-side `workspace_list_files_recursive` command to resolve this instantly.
3. **Viewer/Herdr Toggle**: Added a toggle button in `HerdrWorkspaceRail.tsx` when `openFilePath` is active to navigate back to Herdr via `onShowHerdr()`.
4. **Viewer Header Layout**: In `Editor.tsx`, updated both normal and load-error headers to use `{filePath}` with `title={filePath}`. In `global.css`, updated `.workspace-editor__filename` to `flex: 1; min-width: 0;` (removing fixed 200px max-width) and added `flex-shrink: 0;` to `.workspace-editor__view-btn`.
5. **Context Text**: `workspace.contextTitle` in `ko.ts` updated to "AI 참조 컨텍스트".
6. **Ctrl+W Shortcut**: In `useHerdrDocuments.ts`, registered window `keydown` listener for `Ctrl+W` / `Cmd+W` when active app is workspace and a document is open, preventing default window close and invoking `closeDoc`.
7. **Ctrl+Click Links**: In `packages/shell/src-tauri/src/workspace.rs`, implemented `fs_exists` resolving relative and home-relative paths. In `Terminal.tsx`, link activation verifies existence via `fs_exists`. If the file does not exist, an in-terminal toast alert (`파일을 찾을 수 없습니다: <path>`) is displayed and navigation is skipped.

## PLAN & IMPLEMENTATION SUMMARY

### Phase 1: Bug Fixes (Mouse Events & Ctrl+P) [REQ-001]
- **FE & BE Changes**: 
  - `Terminal.tsx`: Added `term.onBinary` listener with guard (`typeof term.onBinary === "function"`) forwarding binary data to `writePty(pty_id, data)` and registered cleanup in the unmount disposer.
  - `workspace.rs`: Added `workspace_list_files_recursive(parent: String) -> Result<Vec<String>, String>` with recursion depth limit and ignore-directory filtering. Registered command in `lib.rs`.
  - `file-search.ts`: Updated `collectFilesOnly` to call `workspace_list_files_recursive` first with fallback to `workspace_list_dirs`.
- **Verification Evidence**:
  - `pnpm test src/lib/__tests__/file-search.test.ts`: PASSED (3/3 tests).
  - `terminal-redraw.test.tsx`: Verified `onBinary` mock setup and redraw stability.

### Phase 2: UX Layout & Shortcuts (Header, Toggle, Text, Ctrl+W) [REQ-002]
- **FE Changes**:
  - `Editor.tsx`: Replaced `shortName` with `{filePath}` and added `title={filePath}` in both error and regular headers.
  - `global.css`: Adjusted `.workspace-editor__filename` to `flex: 1; min-width: 0;` with text ellipsis, and buttons to `flex-shrink: 0;`.
  - `HerdrWorkspaceRail.tsx`: Added `<button className="herdr-workspace__toggle-btn" onClick={props.onShowHerdr}>Herdr 화면으로</button>` when `props.openFilePath` is active.
  - `ko.ts`: Changed `workspace.contextTitle` to `"AI 참조 컨텍스트"`.
  - `useHerdrDocuments.ts`: Handled `Ctrl+W` / `Cmd+W` to close `openFilePathRef.current` via `closeDoc` and `e.preventDefault()`.
- **Verification Evidence**:
  - `pnpm test src/apps/workspace/__tests__/herdr-workspace.test.tsx`: PASSED (includes tests for Herdr toggle button and Ctrl+W shortcut).
  - `pnpm test src/apps/workspace/__tests__/editor-header.test.tsx`: PASSED (2/2 tests verifying full path display and tooltip).

### Phase 3: Terminal File Links (Ctrl+Click) [REQ-003]
- **FE & BE Changes**:
  - `workspace.rs`: Implemented `fs_exists(path: String, cwd: Option<String>) -> bool` resolving relative paths against cwd and home directory (`~/`). Registered in `lib.rs`.
  - `Terminal.tsx`: In `linkProvider.activate`, validated target path asynchronously using `fs_exists`. If non-existent, displays toast alert (`파일을 찾을 수 없습니다: <path>`) and skips navigation; if existent, invokes `onFileLocation`.
  - `Terminal.tsx`: Rendered `.workspace-app__idle-toast` container overlay for user feedback.
- **Verification Evidence**:
  - `pnpm test src/apps/workspace/__tests__/terminal-link.test.tsx`: PASSED (2/2 tests: link activation on existing file and toast alert on missing file).
  - `cargo test --lib workspace::open_grant_tests::fs_exists`: PASSED (1/1 test verifying absolute, relative, and missing path handling).

## VERIFICATION MATRIX

| Scope | Check / Command | Result |
|---|---|---|
| Rust compilation | `cargo check --lib` | PASS (0 errors, finished in 0.82s) |
| Rust unit tests | `cargo test --lib workspace` | PASS (11 passed, 0 failed) |
| Workspace unit tests | `pnpm test src/apps/workspace` | PASS (14/14 test files, 71/71 tests) |
| File search tests | `pnpm test src/lib/__tests__/file-search.test.ts` | PASS (3/3 tests) |
| Frontend typecheck & bundle | `pnpm build` (`tsc -b && vite build && node scripts/check-bundle-budget.mjs`) | PASS (All bundles within budgets, 0 type errors) |

(Note: Epics 8 and 9 are separated to a new issue.)
