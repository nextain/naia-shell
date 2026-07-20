# Changelog

All notable changes to Naia OS are documented here.
Source data: [`releases/v*.yaml`](releases/)

> This repository was restarted with the post-OpenClaw architecture rewrite in 2026-06. The full pre-rewrite source and detailed commit history are preserved on the [`backup/main-2026-06-22`](https://github.com/nextain/naia-shell/tree/backup/main-2026-06-22) branch.

[한국어 (Korean)](CHANGELOG.ko.md)

---

## v0.1.5 (2026-06-05)

Naia-0.9-Omni-24g is here — a smart AI that clones your voice, talks in real time, and runs skills, all on a single RTX 3090 PC. Voice tool execution, a redesigned voice-cloning UI with record & preview, natural barge-in, 30-language support, native Ollama local AI, and MS Store & Steam distribution.

Voice (naia-omni):

- **feat(voice)**: naia-0.9-omni-24g runs tools during voice conversation — ask by voice and it actually creates files, searches, and runs skills, not just talks ([#352](https://github.com/nextain/naia-shell/issues/352))
- **feat(voice)**: Redesigned reference-audio (voice cloning) settings — card UI with in-app recording and instant preview ([#349](https://github.com/nextain/naia-shell/issues/349))
- **feat(voice)**: Prosody tags from voice replies map to avatar expressions and chat emoji — the avatar reacts as Naia speaks ([#350](https://github.com/nextain/naia-shell/issues/350))
- **feat(voice)**: Gemini Live voice UX — context bridge, barge-in (interrupt mid-speech), text/voice parity, and voice panel tools ([#313](https://github.com/nextain/naia-shell/issues/313))
- **feat(voice)**: Reference voice for Naia Local — direct ref-audio, default voice selection, and mid-session voice switching
- **fix(voice)**: Real-time voice stability — server-VAD passthrough, transcript handling, cold-start socket races, and reference-audio auth fixes ([#219](https://github.com/nextain/naia-shell/issues/219))

Local AI:

- **feat(agent)**: Native Ollama provider — reasoning, tool calls, and num_ctx handling for fully local LLMs ([#357](https://github.com/nextain/naia-shell/issues/357))

Distribution:

- **feat(dist)**: MS Store (Win32 listing) and Steam portable distribution with conditional code signing ([#314](https://github.com/nextain/naia-shell/issues/314))

Shell & UX:

- **feat(shell)**: Panel spec, docs, and examples for the extensible panel system, plus a zip-tab gate ([#358](https://github.com/nextain/naia-shell/issues/358))
- **feat(launch)**: YouTube BGM background fallback on launch — music keeps playing even before AI connects

Auth:

- **feat(auth)**: Rust localhost HTTP callback server — more reliable desktop OAuth/deep-link sign-in ([#341](https://github.com/nextain/naia-shell/issues/341))

Adversarial-review batch — 5 P0-critical security fixes + 1 P0-UX + 1 P1 gateway routing, plus follow-up architectural docs.

Security hardening (2026-05-12):

- **fix(agent)**: gate `handleToolRequest` through `needsApproval` before `executeTool` — panels/shell direct tool-call path no longer bypasses the tier check the LLM-loop path enforces ([#256](https://github.com/nextain/naia-shell/issues/256))
- **fix(agent)**: `panel_install` rejects non-HTTPS sources — `file://` / `http://` / `git@` / `data:` / `javascript:` / bare local paths return a clear error before any spawn ([#257](https://github.com/nextain/naia-shell/issues/257))
- **fix(shell)**: `assetProtocol.scope` rewritten as `FsScope` object — bare `**`, drive-root patterns, bare `/tmp/**` removed; `requireLiteralLeadingDot: true` blocks `~/.ssh` / `~/.gnupg` / `~/.aws` ([#258](https://github.com/nextain/naia-shell/issues/258))
- **fix(shell)**: `https://discord.com` removed from CSP `connect-src` — all Discord API via Rust `invoke('discord_api', ...)` ([#259](https://github.com/nextain/naia-shell/issues/259))
- **fix(agent/shell)**: webhook URLs moved off per-request stdio via new `notify_config` one-shot message ([#260](https://github.com/nextain/naia-shell/issues/260))
- **fix(shell)**: runtime `asset_protocol_scope.allow_directory` extension at `copy_bundled_assets` — ADK workspaces outside `$HOME` / `/var/home/*/naia-adk/**` (e.g. `/mnt/external`, `/opt/custom`, `D:\custom\naia`) now serve VRM / BGM / background via `asset://` URLs. Required `protocol-asset` Cargo feature + `assetProtocol.enable: true` ([#277](https://github.com/nextain/naia-shell/issues/277))
- **fix(agent/shell)**: `provider.apiKey` moved to one-shot `creds_update` message — same pattern as `auth_update` + `notify_config`. Agent caches per-provider; `buildProvider` resolution: cache → per-request fallback → envVar. `ChatRequest.provider.apiKey` stays declared for backwards compat during the migration window. (#260 follow-up)
- **fix(agent/shell)**: `creds_update` extended to carry `ttsKeys` (per-TTS-provider) + `gatewayToken`. `SendChatOptions` no longer accepts `ttsApiKey` / `gatewayToken`; `directToolCall` opts no longer accept `gatewayToken` — compile-time enforcement that credentials never appear on per-request frames. All shell callsites cleaned (ChatPanel / SettingsTab / AgentsTab / SkillsTab / DiagnosticsTab / discord-relay). (#260 follow-up)

Bugs:

- **fix(shell)**: 0.1.5 launch bugfixes — startup, config, and provider routing corrections ([#342](https://github.com/nextain/naia-shell/issues/342))
- **fix(env)**: Separate dev/prod gateway environments — `tauri:dev` and `tauri:prod` target the right gateway ([#333](https://github.com/nextain/naia-shell/issues/333))
- **fix(agent/shell)**: Naia gateway lacks Vertex AI access to gemini-3.x — drop from picker, fix `gemini-3.1-flash-live-preview` fallback, accurate 0-byte SSE error, auto-migrate saved configs ([#248](https://github.com/nextain/naia-shell/issues/248))
- **fix(shell)**: startup white flash + onboarding splash deadlock ([#254](https://github.com/nextain/naia-shell/issues/254))

Docs:

- **docs(context)**: `#271` Phase 2 — architecture docs rewrite post-OpenClaw; live docs gain `current_runtime` section, pre-#201 hybrid plans archived ([#271](https://github.com/nextain/naia-shell/issues/271))
- **docs(bridges)**: `agent-bridges.yaml/md` add `notify_flow` + `security_hardening` sections documenting the new message contract + seven hardening fixes
- **test(e2e)**: integration validation spec — Playwright with Tauri IPC mock validates shell↔agent↔skill registration wire (5/5 pass)

## v0.1.4 (2026-04-04)

Alpha Memory System v1, Knowledge Graph, and memory benchmarks

- **feat(agent)**: Alpha Memory System v1 — 4-store architecture (episodic/semantic/procedural/working) with Ebbinghaus decay, Hebbian association, and consolidation pipeline ([#145](https://github.com/nextain/naia-shell/issues/145))
- **feat(agent)**: Knowledge Graph integration — entity-relationship graph with TF-IDF indexing, Louvain community detection, and centrality scoring ([#173](https://github.com/nextain/naia-shell/issues/173))
- **feat(agent)**: Memory system wiring — encode/recall/sessionRecall integrated into agent conversation loop ([#150](https://github.com/nextain/naia-shell/issues/150))
- **feat(shell)**: Memory management UI — fact list, delete, clear-all in Settings tab ([#174](https://github.com/nextain/naia-shell/issues/174))
- **feat(agent)**: mem0 adapter — optional cloud backend (mem0.ai) as alternative to local JSON ([#148](https://github.com/nextain/naia-shell/issues/148))
- **feat(agent)**: Embedding support — local or API-based vector similarity for memory recall ([#149](https://github.com/nextain/naia-shell/issues/149))
- **fix(agent)**: sessionRecall now always surfaces episodes alongside facts (episode fallback) ([#151](https://github.com/nextain/naia-shell/issues/151))
- **fix(agent)**: Consolidation threshold reduced from 1 hour to 5 minutes for responsive fact extraction ([#151](https://github.com/nextain/naia-shell/issues/151))

## v0.1.3 (2026-03-23)

Workspace panel, browser panel, PTY terminal, provider registries, and installer improvements

- **feat(shell)**: Workspace panel — session dashboard, file explorer, and code editor ([#99](https://github.com/nextain/naia-shell/issues/99))
- **feat(workspace)**: PTY terminal tabs with xterm.js ([#119](https://github.com/nextain/naia-shell/issues/119))
- **feat(workspace)**: Image, CSV, and log file viewer with chat deeplinks ([#116](https://github.com/nextain/naia-shell/issues/116))
- **feat(workspace)**: Git worktree grouping in session dashboard ([#121](https://github.com/nextain/naia-shell/issues/121))
- **feat(shell)**: Browser panel — Chrome X11 embed, CDP tools, voice tools, theme support ([#95](https://github.com/nextain/naia-shell/issues/95))
- **feat(panels)**: Iframe bridge + NaiaContextBridge expansion for panel communication ([#122](https://github.com/nextain/naia-shell/issues/122))
- **feat(shell)**: Panel API — programmatic interface via panelRegistry ([#118](https://github.com/nextain/naia-shell/issues/118))
- **feat(shell)**: Dynamic iframe rendering for installed panels ([#89](https://github.com/nextain/naia-shell/issues/89))
- **feat(shell)**: STT/TTS provider registry with Web Speech API and Browser TTS ([#51](https://github.com/nextain/naia-shell/issues/51))
- **feat(shell)**: vLLM STT/TTS providers + STT model selector + audio device settings ([#79](https://github.com/nextain/naia-shell/issues/79))
- **feat(shell)**: Audio input/output device selection with mic test ([#81](https://github.com/nextain/naia-shell/issues/81))
- **fix(installer)**: GRUB USB boot fix — insmod iso9660 added to prevent boot menu failure
- **fix(browser)**: Browser panel keepAlive, modal timing, toolbar overflow ([#102](https://github.com/nextain/naia-shell/issues/102))

## v0.1.2 (2026-03-10)

In-app auto-update, voice provider refactoring, skill/voice bug fixes, CI quality gates, and OS improvements

- **feat(shell)**: In-app update checker with banner notification and Settings version footer ([#30](https://github.com/nextain/naia-shell/issues/30))
- **feat(ci)**: Tauri updater signing, latest.json generation, and itch.io butler push ([#30](https://github.com/nextain/naia-shell/issues/30))
- **feat(web)**: Changelog section on naia.nextain.io download page from releases/*.yaml ([#30](https://github.com/nextain/naia-shell/issues/30))
- **feat(voice)**: Abstract live conversation into provider pattern (Gemini Live, OpenAI Realtime) ([#25](https://github.com/nextain/naia-shell/issues/25))
- **fix(shell)**: Suppress echo in voice conversation and add VRM gender-based voice defaults ([#22](https://github.com/nextain/naia-shell/issues/22))
- **refactor(shell)**: Remove dead STT code and legacy SettingsModal ([#25](https://github.com/nextain/naia-shell/issues/25))
- **fix(agent)**: Fix AI failing to discover custom skills in non-English locales ([#28](https://github.com/nextain/naia-shell/issues/28))
- **fix(skills)**: Fix skill install feedback, event leak, i18n, and sync 20 built-in skills ([#28](https://github.com/nextain/naia-shell/issues/28))
- **refactor(agent)**: Deduplicate system prompt pipeline
- **feat(agent)**: Configurable Ollama host
- **feat(shell)**: Dual-origin memory sync between Shell and OpenClaw
- **fix(shell)**: Make AI response language follow locale setting
- **feat(ci)**: CI quality gates (lint, typecheck, build-test) with Biome enforcement ([#12](https://github.com/nextain/naia-shell/issues/12))
- **feat(ci)**: Chain pipeline: Release → Build OS → Generate ISO, weekly auto-rebuild ([#12](https://github.com/nextain/naia-shell/issues/12))
- **fix(installer)**: Restore DNS triple fallback, CJK font fix, Plymouth two-step module
- **fix(branding)**: Add taskbar pins, wallpaper, lock screen for installed system

## v0.1.1 (2026-03-05)

First public release with Flatpak support and OpenClaw integration

- **feat(shell)**: Flatpak packaging with OpenClaw bundled
- **feat(shell)**: VRM 3D avatar with emotion expressions
- **feat(agent)**: Multi-provider LLM support (Gemini, Claude, OpenAI, xAI, Ollama)
- **feat(shell)**: TTS voice chat with Edge, Google, OpenAI, ElevenLabs
- **feat(shell)**: 14-language UI localization ([#1](https://github.com/nextain/naia-shell/issues/1))
