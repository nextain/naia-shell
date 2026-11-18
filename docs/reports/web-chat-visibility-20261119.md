# Web chat message visibility (2026-11-19)

## Evidence and scope

The dev revision `ca-naia-web-dev2--workspace-1118195813` was exercised on an RTX 3090 by Naia. The workspace button worked and two turns produced responses, but Naia reported that the messages existed in the DOM without being visibly readable. A 1280 × 720 screenshot on the test machine (`/tmp/naia-rec2-end.jpg`) shows the ready/fallback model status taking several lines below the gesture controls, with no conversation visible. This does not establish the individual element dimensions or prove the cause.

The earlier workspace-setup regression checked that a default-model conversation was present and visible in Playwright's sense; it did not measure the clipped message viewport after a tall GPU/fallback status. This investigation is separate from model response quality or real GPU operation.

## Candidate

Show the ready model and fallback notice in a keyboard-operable disclosure, initially closed; put adapter details and the action to return to the default model inside it. Reserve a minimum message viewport and limit the status height after workspace setup, permitting keyboard and pointer scrolling. Preserve the error/retry controls and intentional mobile collapsed state. Apply layout rules only in web mode.

## Verification status

Not yet run. Record before/after message rectangles, ancestor clipping and pointer hits for 1280 × 720, 800 × 450 and 1920 × 1080; exercise disclosure and return action by pointer and keyboard, and error/fallback/retry/input access. Confirm whether the evidence reproduces the original condition. Existing user cache, actual touch, a screen reader and real kiosk entry are separate verification items. No deployment of this candidate has been performed.

## Current evidence

On the unchanged 0c7c0eeb build, the 1280 × 720 and 800 × 450 message viewport measured 16px while its content needed 75px; the fallback status used 100px. At 1920 × 1080 the message viewport measured 150px. A candidate run measured 68px with details closed and 64px with details open at 1280 × 720, and 64px with details open at 800 × 450. Pointer and Tab checks reached messages, input and error actions at all three sizes. The complete combined browser run exited nonzero because the independently reproduced model-switch persistence defect failed on all three sizes; it is not a passing model-switch test. See `web-model-switch-persistence-20261119.md` in the separate model-switch worktree and `/tmp/alpha-chat-candidate-v4-browser.log` on the test host. The repeatable layout-only test does not claim model-switch persistence works.

The later unscrolled-response test at commit 82a7b30c passed at 1280 × 720 and 1920 × 1080, but failed at 800 × 450 because the new response was outside the visible chat area; its log is `/tmp/alpha-chat-visual-repo.log`. The process wrapper was terminated before an exit-code file was recorded. A separate candidate raises the default chat height for short landscape web windows only, leaving user-resized, hidden, workspace and kiosk layouts untouched. This candidate has not yet passed browser tests or been deployed. Real touch, screen-reader use and actual kiosk entry remain unverified.
