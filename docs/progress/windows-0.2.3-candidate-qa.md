# Windows 0.2.3 candidate — 4060 QA pack

Branch: `release/0.2.3-windows-candidate`  
Current tip (pull before QA): **`92531b60`**

## What this branch is

Integration of current `origin/main` plus shrink PRs for the character-core Windows cut:

| Included | Issue / PR |
|---|---|
| Isolated ADK hydration | #590 / #619 |
| Single Naia LLM | #598 / #620 |
| Remove 3rd-party LLM | #602 / #624 |
| Warming-hold silence fix | #621 / #625 |
| Remove 3rd-party voice | #603 / #626 |
| Remove Discord shell UI | #610 / #627 |
| Remove direct work tools | #611 / #628 |
| Skills tab → CLI checkboxes | #605 / #629 |
| Web Speech empty-final surfaced | #615 / #632 |
| BGM resume latch clear | #614 (cherry-pick of PR #631) |

Agent-side Discord/cron tool removal is in **naia-agent** PR [#130](https://github.com/nextain/naia-agent/pull/130) (`refactor/610-agent-remove-discord-cron`). Pair that commit when building the Windows agent bundle.

## Version files

Already on `0.2.3`:

- `packages/shell/package.json`
- `packages/shell/src-tauri/Cargo.toml`
- `releases/v0.2.3.yaml` (updated for this candidate)

## Build on Windows (4060)

From the shell package, use the staging entrypoint (not raw `tauri build`):

```powershell
git fetch origin
git checkout release/0.2.3-windows-candidate
git pull --ff-only
pnpm install
pnpm -C packages/shell run tauri:installer
```

Release process detail: `docs/progress/windows-release-process.md`.

Signing keys stay outside the repo (`D:/alpha-adk/data-private/key/...`). Do not print or commit them.

## QA checklist (product, not harness)

1. **Login / Naia LLM** — account login, one DeepSeek (or current Naia default) chat reply.
2. **Logged-out local** — Ollama/local path still reachable; no third-party cloud LLM in settings.
3. **Local voice (#621)** — VoxCPM2 on 4060 must speak after stream (no infinite 「음성 처리중」).
4. **Voice providers (#603)** — no Google/OpenAI/ElevenLabs/Gemini Live/OpenAI Realtime; Azure / local / Edge only.
5. **Skills (#605)** — CLI checkboxes, not a skill store list; Claude/Codex/Grok detection.
6. **No Discord channels tab (#610)** — Channels/Connections Discord UI gone.
7. **Model tools (#611)** — model cannot shell/write/github; time/weather/memo/youtube/browser still work.
8. **BGM / browser (#614)** — play → stop/pause → resume; button and audio must stay in sync (fix is on this tip; 2070 could not live-verify because WDAC blocks cargo).
9. **Web Speech STT (#615)** — empty finals must show a voice error instead of silent listening; full transcription may still fail if WebView2 has no speech backend.

## Not claimed by this candidate

- CI green on GitHub (ego-browser dist / shared CI plumbing still red on main-class builds).
- Full Discord gateway runtime deletion inside the agent process (tool surface removed; inbound gateway cleanup is follow-up).
- Store/public publish until QA + signed NSIS/MSI + `latest.json` gates pass.

## Device queue note

While Luke QAs on 4060, prefer not to enqueue attended 4060 jobs. 2070/3090 can keep headless/judge work that does not need a fresh Tauri binary.

**2070 build limit:** Smart App Control / WDAC on win-rtx2070 blocks rustup `cargo.exe` (os error 4551). Do not expect installer or live Tauri builds from that device until the toolchain is allowlisted. Installer offload goes to win250 or local 4060.
