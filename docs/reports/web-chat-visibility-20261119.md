# Web chat message visibility (2026-11-19)

## Evidence and scope

The dev revision `ca-naia-web-dev2--workspace-1118195813` was exercised on an RTX 3090 by Naia. The workspace button worked and two turns produced responses, but Naia reported that the messages existed in the DOM without being visibly readable. A 1280 × 720 screenshot on the test machine (`/tmp/naia-rec2-end.jpg`) shows the ready/fallback model status taking several lines below the gesture controls, with no conversation visible. This does not establish the individual element dimensions or prove the cause.

The earlier workspace-setup regression checked that a default-model conversation was present and visible in Playwright's sense; it did not measure the clipped message viewport after a tall GPU/fallback status. This investigation is separate from model response quality or real GPU operation.

## Candidate

Show the ready model and fallback notice in a keyboard-operable disclosure, initially closed; put adapter details and the action to return to the default model inside it. Reserve a minimum message viewport and limit the status height after workspace setup, permitting keyboard and pointer scrolling. Preserve the error/retry controls and intentional mobile collapsed state. Apply layout rules only in web mode.

## Verification status

At commit `1e1b55b99a367ffa9a92ece144eb4eaa8efac9ae`, fake-engine source Playwright UI regression completed 3/3 with exit 0 for 1280 × 720, 800 × 450 and 1920 × 1080 (`/tmp/alpha-chat-smallfix-v2.log`, `/tmp/alpha-chat-smallfix-v2.exit`). It checks the newly added response without prior manual scrolling, ready details and drag and hide/show at 800 × 450. Error controls were checked for keyboard focus and center-point hit, not click or recovery. The run uses a fake engine and a reduced workspace bundle; its Vite server is not the deployment artifact.

The separate built-artifact isolated browser run was 3/3 with exit 0 (`/tmp/alpha-chat-smallfix-isolated.log`, `/tmp/alpha-chat-smallfix-isolated.exit`): one network-blocking probe, then 1280 × 720 and 800 × 450 using a simulated GPU and mock agent worker with service workers blocked. The workspace bundle returned HTTP 200, workspace status reached ready, and a synthetic reply was visible with no page errors. One artifact tree digest record is `07924895b3ad134a15fc8179a2ec4545bd54f7a61e1bb7d5fc8128b630b31ca5`; it is not independent before/after evidence. This does not validate actual GPU behavior or answer quality.

The common non-pending chat CSS and shared status component can also affect the workspace rail and investor demo; only the short-landscape default-height rule excludes those contexts. Actual investor-demo entry and workspace rail on this candidate, real touch and screen-reader operation, 601px boundaries, long translations, deployed service-worker update and existing profiles remain unverified. No deployment of this candidate has been performed.

## Current evidence

On the unchanged 0c7c0eeb build, the 1280 × 720 and 800 × 450 message viewport measured 16px while its content needed 75px; the fallback status used 100px. At 1920 × 1080 the message viewport measured 150px. A candidate run measured 68px with details closed and 64px with details open at 1280 × 720, and 64px with details open at 800 × 450. Pointer and Tab checks reached messages, input and error actions at all three sizes. The complete combined browser run exited nonzero because the independently reproduced model-switch persistence defect failed on all three sizes; it is not a passing model-switch test. See `web-model-switch-persistence-20261119.md` in the separate model-switch worktree and `/tmp/alpha-chat-candidate-v4-browser.log` on the test host. The repeatable layout-only test does not claim model-switch persistence works.

The later unscrolled-response test at commit 82a7b30c passed at 1280 × 720 and 1920 × 1080, but failed at 800 × 450 because the new response was outside the visible chat area; its log is `/tmp/alpha-chat-visual-repo.log`. The process wrapper was terminated before an exit-code file was recorded. Commit `1e1b55b9` raises the default chat height in short landscape web windows, excluding explicitly resized or hidden chat, workspace rail and investor-demo wrappers from that height rule. The separate shared chat CSS and status component still apply beyond that rule; see verification status above. The subsequent fake-engine source UI and isolated built-artifact tests at 800 × 450 pass, as described above; the original real-device scenario has not been retested on this candidate.
