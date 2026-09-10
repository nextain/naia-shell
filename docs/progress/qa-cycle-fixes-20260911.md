# QA cycle fixes — 2026-09-11

- Branch: `issue/qa-cycle-fixes-20260911`
- Session: `naia3090/grok`
- Dispatch: QA-DISPATCH-20260911-A MAP-LINUX (catalog mapping already receipted)
- This document is the product/harness follow-up: previous-cycle failures, then e2e on the fixed binary.

## Previous-cycle problems

| Problem | Kind | Fix on this branch |
|---|---|---|
| Connections tab disabled in native | product (win250 Discord 0/1) | `isConnectionsTabEnabled`: Tauri always on |
| ego-host lease left after window close | product (`env-tool-browser-host-lifecycle`) | `WindowEvent::CloseRequested` cleanup |
| Herdr first-frame timeout | harness/product | wait 20s → 45s |
| Backup export hard-disabled | product on older candidate | already enabled here; added testids |
| `agent_lease_live_blocked` / premise invalid | harness leftover | reclaim e2e children before retest |
| `credentialed_live` | missing `NAIA_API_KEY` / `GEMINI_API_KEY` | not a code fix; remains BLOCKED |
| Frozen r5 202 rows | candidate clone gone | linux_r6_prepare, not this session |
| 75 QC with no runner spec | catalog mapping | MAP-LINUX receipt `60d5f1ee` |

## Code

- `packages/shell/src/lib/settings-connections.ts`
- `packages/shell/src/components/SettingsTab.tsx`
- `packages/shell/src-tauri/src/lib.rs`
- `packages/shell/e2e-tauri/specs/100-herdr-first-frame.spec.ts`

## E2E on this branch

Two isolated retests of the previous-cycle failures (`--only-failed` against `naia-os-3090-2026-09-10T09-27-15-527Z.json`):

| Spec | Result |
|---|---|
| `env-tool-browser-host-lifecycle` | PASS both times (Reset / foreign marker / close / restart lease cases) |
| `100-herdr-first-frame` | FAIL both times: "Herdr PTY never delivered its first frame to xterm" (45s) |

Premise stayed `invalid` (`leaseBlocked` 1 on the first of the two sessions). Herdr therefore is **not** recorded as a product FAIL. Native_local `99-stt-mic-test` was not re-run on this binary. `credentialed_live` still needs keys.

Unit: `settings-connections.test.ts` 3/3 PASS.

## Out of scope

- Duplicate `linux_r6_prepare` build of Shell `6ded8b07`
- Windows native_local 6GB voice on MX250
- Pulling alpha-adk main / swapping live ADK
