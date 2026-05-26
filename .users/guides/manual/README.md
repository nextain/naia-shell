<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# Naia OS — User Manual

A topic-based, scenario-driven user manual mirrored after the format
used on naia.nextain.io (`src/content/manual/*.md`). Each topic page is
also the textual specification of the matching e2e scenario in
`.agents/context/e2e-scenarios.yaml` — so the manual and the test suite
share a single source of truth.

## Layout

```
.users/guides/manual/
├── README.md              ← this file (index)
├── getting-started.md     ← first-run ADK setup + login
├── chat.md                ← single-turn + multi-turn chat (S101)
├── skills/
│   ├── time.md            ← skill_time (S004 → S104 fix)
│   ├── weather.md         ← skill_weather (S016)
│   ├── memo.md            ← skill_memo (S006, S105 persistence)
│   ├── system-status.md   ← skill_system_status (S005)
│   ├── notify.md          ← skill_notify_slack/discord (S017, S108)
│   └── browser.md         ← skill_browser_* (S110)
├── settings/
│   ├── provider-switch.md ← provider change hygiene (#329, S102)
│   └── secrets.md         ← Tauri secure store + keychain
├── memory.md              ← record/recall + decay (S008, S106)
├── channels.md            ← Discord/Slack config (S022, S023)
├── cron.md                ← one-shot + recurring (S020, S021, S029)
├── voice.md               ← TTS + wake-word (S024b, S025)
├── sessions.md            ← history + switching (S010, S026)
├── multi-agent.md         ← orchestration (S027)
└── diagnostics.md         ← cost dashboard + logs (S011, S107)
```

## Conventions

Each topic page follows naia.nextain.io's manual format:

1. **Overview** — one-line description of the capability.
2. **Prerequisites** — what must be true before using this.
3. **Usage** — UI screenshots + step-by-step, OR CLI/IPC payload.
4. **Examples** — realistic conversation snippets or tool call traces.
5. **Troubleshooting** — known failure modes + fixes (cross-ref open issues).
6. **Related** — links to other topics + e2e spec ID.

## Status

Initial scaffold landed 2026-05-27 alongside `.agents/context/e2e-scenarios.yaml`.

Filled topics:
- `getting-started.md` (this session)

Remaining: scheduled as separate PRs to keep diff sizes reviewable.

🤖 Written with AI assistance. If anything looks off, please open a discussion.
