<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->
<!-- Mirror of .agents/context/e2e-scenarios.yaml — keep in sync. -->

# E2E Test Scenarios

Source of truth for naia-os e2e coverage: what specs we have, what they
actually assert, and what's missing. Mapped one-to-one with the YAML
manifest at `.agents/context/e2e-scenarios.yaml`.

Categories: setup · llm · skills · ui · channels · voice · memory · infra · e2e-meta

## Existing specs

Located under `shell/e2e-tauri/specs/`. 30 specs as of 2026-05-27 (29 + 24-adk-setup added in #328).

| ID | Spec | Feature | Status |
|----|------|---------|:---:|
| S001 | `01-app-launch` | App launch + Tauri webview baseline | ✓ |
| S002 | `02-configure` | Initial config via Settings UI | ✓ |
| S003 | `03-basic-chat` | Single-turn chat | ✓ |
| S004 | `04-skill-time` | Skill: time | ✗ (LLM picks wrong tool; see #332 proposal) |
| S005 | `05-skill-system` | Skill: system status | ✓ |
| S006 | `06-skill-memo` | Skill: memo | ✓ |
| S007 | `07-cleanup` | Factory reset / session cleanup | ✓ |
| S008 | `08-memory` | Memory: record/recall (SQLite v6) | ✓ |
| S009 | `09-onboarding` | Onboarding wizard | ✓ |
| S010 | `10-history-tab` | History tab | ✗ (#320 OPEN) |
| S011 | `11-cost-dashboard` | Cost dashboard | ✓ |
| S012 | `12-skills-gateway` | Gateway skills | ✓ |
| S013 | `13-lab-login` | Lab login (OAuth deep-link) | ✓ |
| S014 | `14-skills-tab` | Skills tab UI | ✓ |
| S015 | `15-skill-manager-ai` | AI-driven skill_manager | ✓ |
| S016 | `16-skill-weather` | Skill: weather | ✓ |
| S017 | `17-skill-notify` | Skill: notify (Slack/Discord) | ✓ |
| S018 | `18-provider-tool-calling` | Provider tool-calling matrix | ✓ (nextain branch blocked by #329) |
| S019 | `19-skills-bulk` | Bulk skill ops | ✓ |
| S020 | `20-cron-basic` | Cron: one-shot | ✓ |
| S021 | `21-cron-recurring` | Cron: recurring | ✓ |
| S022 | `22-channels-config` | Channels config | ✓ |
| S023 | `23-channels-status` | Channels status | ✓ |
| S024a | `24-adk-setup-flow` | ADK setup flow (#324/#325/#327) | ✗ (#328 webview cycle) |
| S024b | `24-tts-providers` | TTS providers | ✓ |
| S025 | `25-voice-wake` | Voice wake (porcupine) | ✓ |
| S026 | `26-sessions-management` | Sessions CRUD | ✓ |
| S027 | `27-multi-agent` | Multi-agent orchestration | ✓ |
| S028 | `28-skills-install` | Skills install from marketplace | ✓ |
| S029 | `29-cron-gateway` | Cron gateway (cloud) | ✓ |

## Proposed new scenarios (from 2026-05-27 audit + #329 findings)

| ID | Feature | Rationale |
|----|---------|-----------|
| S101 | Multi-turn chat (N consecutive turns share context) | S003 covers only single-turn |
| S102 | Secure-store hygiene on provider switch | Direct fix surface for #329 root cause |
| S103 | OAuth callback path coverage (deep-link → secure store) | e2e bypasses prod OAuth path |
| S104 | skill_time end-to-end with deterministic LLM prompt | Fix S004 by restricting tool list / strengthening prompt |
| S105 | Memo persistence across app restarts | S006 covers only same-session |
| S106 | Ebbinghaus decay verifies older memories down-rank | v6.0 has decay but no assertion |
| S107 | Cost dashboard graceful UX on fetch failure | S011 happy path only |
| S108 | Notify skill retries on transient webhook 429 | S017 single-shot only |
| S109 | Voice clone (ElevenLabs voice ID) | S024b switches provider, not voice |
| S110 | Browser panel — naia.nextain.io tab embed | skill_browser_* exists but no panel-UI coverage |
| S111 | Memory backup export/import round-trip (AES-256-GCM) | spec 96 implemented; drives memory_export_backup/memory_import_backup IPC directly. UI re-enable deferred to #327 follow-up. |
| S113 | Memory encoder fallback to offline ONNX on gateway 5xx | spec 95 implemented; runtime fallback wiring deferred to Phase 4 |

## Cross-references

- Lessons: `.agents/context/lessons-learned.yaml` (L059 covers #329 root cause)
- Open issues: #320, #328, #329, #330, #331
- User-facing manual: `.users/guides/manual/` (in progress)

🤖 Written with AI assistance. If anything looks off, please open a discussion.
