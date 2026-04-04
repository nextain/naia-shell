# Changelog

All notable changes to Naia OS are documented here.
Source data: [`releases/v*.yaml`](releases/)

[한국어 (Korean)](CHANGELOG.ko.md)

---

## v0.1.4 (2026-04-04)

Alpha Memory System v1, Knowledge Graph, and memory benchmarks

- **feat(agent)**: Alpha Memory System v1 — 4-store architecture (episodic/semantic/procedural/working) with Ebbinghaus decay, Hebbian association, and consolidation pipeline ([#145](https://github.com/nextain/naia-os/issues/145))
- **feat(agent)**: Knowledge Graph integration — entity-relationship graph with TF-IDF indexing, Louvain community detection, and centrality scoring ([#173](https://github.com/nextain/naia-os/issues/173))
- **feat(agent)**: Memory system wiring — encode/recall/sessionRecall integrated into agent conversation loop ([#150](https://github.com/nextain/naia-os/issues/150))
- **feat(shell)**: Memory management UI — fact list, delete, clear-all in Settings tab ([#174](https://github.com/nextain/naia-os/issues/174))
- **feat(agent)**: mem0 adapter — optional cloud backend (mem0.ai) as alternative to local JSON ([#148](https://github.com/nextain/naia-os/issues/148))
- **feat(agent)**: Embedding support — local or API-based vector similarity for memory recall ([#149](https://github.com/nextain/naia-os/issues/149))
- **fix(agent)**: sessionRecall now always surfaces episodes alongside facts (episode fallback) ([#151](https://github.com/nextain/naia-os/issues/151))
- **fix(agent)**: Consolidation threshold reduced from 1 hour to 5 minutes for responsive fact extraction ([#151](https://github.com/nextain/naia-os/issues/151))

## v0.1.3 (2026-03-23)

Workspace panel, browser panel, PTY terminal, provider registries, and installer improvements

- **feat(shell)**: Workspace panel — session dashboard, file explorer, and code editor ([#99](https://github.com/nextain/naia-os/issues/99))
- **feat(workspace)**: PTY terminal tabs with xterm.js ([#119](https://github.com/nextain/naia-os/issues/119))
- **feat(workspace)**: Image, CSV, and log file viewer with chat deeplinks ([#116](https://github.com/nextain/naia-os/issues/116))
- **feat(workspace)**: Git worktree grouping in session dashboard ([#121](https://github.com/nextain/naia-os/issues/121))
- **feat(shell)**: Browser panel — Chrome X11 embed, CDP tools, voice tools, theme support ([#95](https://github.com/nextain/naia-os/issues/95))
- **feat(panels)**: Iframe bridge + NaiaContextBridge expansion for panel communication ([#122](https://github.com/nextain/naia-os/issues/122))
- **feat(shell)**: Panel API — programmatic interface via panelRegistry ([#118](https://github.com/nextain/naia-os/issues/118))
- **feat(shell)**: Dynamic iframe rendering for installed panels ([#89](https://github.com/nextain/naia-os/issues/89))
- **feat(shell)**: STT/TTS provider registry with Web Speech API and Browser TTS ([#51](https://github.com/nextain/naia-os/issues/51))
- **feat(shell)**: vLLM STT/TTS providers + STT model selector + audio device settings ([#79](https://github.com/nextain/naia-os/issues/79))
- **feat(shell)**: Audio input/output device selection with mic test ([#81](https://github.com/nextain/naia-os/issues/81))
- **fix(installer)**: GRUB USB boot fix — insmod iso9660 added to prevent boot menu failure
- **fix(browser)**: Browser panel keepAlive, modal timing, toolbar overflow ([#102](https://github.com/nextain/naia-os/issues/102))

## v0.1.2 (2026-03-10)

In-app auto-update, voice provider refactoring, skill/voice bug fixes, CI quality gates, and OS improvements

- **feat(shell)**: In-app update checker with banner notification and Settings version footer ([#30](https://github.com/nextain/naia-os/issues/30))
- **feat(ci)**: Tauri updater signing, latest.json generation, and itch.io butler push ([#30](https://github.com/nextain/naia-os/issues/30))
- **feat(web)**: Changelog section on naia.nextain.io download page from releases/*.yaml ([#30](https://github.com/nextain/naia-os/issues/30))
- **feat(voice)**: Abstract live conversation into provider pattern (Gemini Live, OpenAI Realtime) ([#25](https://github.com/nextain/naia-os/issues/25))
- **fix(shell)**: Suppress echo in voice conversation and add VRM gender-based voice defaults ([#22](https://github.com/nextain/naia-os/issues/22))
- **refactor(shell)**: Remove dead STT code and legacy SettingsModal ([#25](https://github.com/nextain/naia-os/issues/25))
- **fix(agent)**: Fix AI failing to discover custom skills in non-English locales ([#28](https://github.com/nextain/naia-os/issues/28))
- **fix(skills)**: Fix skill install feedback, event leak, i18n, and sync 20 built-in skills ([#28](https://github.com/nextain/naia-os/issues/28))
- **refactor(agent)**: Deduplicate system prompt pipeline
- **feat(agent)**: Configurable Ollama host
- **feat(shell)**: Dual-origin memory sync between Shell and OpenClaw
- **fix(shell)**: Make AI response language follow locale setting
- **feat(ci)**: CI quality gates (lint, typecheck, build-test) with Biome enforcement ([#12](https://github.com/nextain/naia-os/issues/12))
- **feat(ci)**: Chain pipeline: Release → Build OS → Generate ISO, weekly auto-rebuild ([#12](https://github.com/nextain/naia-os/issues/12))
- **fix(installer)**: Restore DNS triple fallback, CJK font fix, Plymouth two-step module
- **fix(branding)**: Add taskbar pins, wallpaper, lock screen for installed system

## v0.1.1 (2026-03-05)

First public release with Flatpak support and OpenClaw integration

- **feat(shell)**: Flatpak packaging with OpenClaw bundled
- **feat(shell)**: VRM 3D avatar with emotion expressions
- **feat(agent)**: Multi-provider LLM support (Gemini, Claude, OpenAI, xAI, Ollama)
- **feat(shell)**: TTS voice chat with Edge, Google, OpenAI, ElevenLabs
- **feat(shell)**: 14-language UI localization ([#1](https://github.com/nextain/naia-os/issues/1))
