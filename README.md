**English** | [한국어](README.ko.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md)

# naia-shell

**The visual shell codebase of Naia Visual Agent. It is the desktop app that users see and talk to, and the core user-facing surface of the naia-os distribution.** A Tauri/Rust native shell
draws the chat UI, voice, and avatar, and in the background launches the "brain" (naia-agent) and talks to it over gRPC. The app core in this repo has been rebuilt on a hexagonal architecture, and the distribution layer is built on Bazzite/titanoboa.

> **About the names**: This repository is `naia-shell`, and it holds the code for the **visual shell (app)** that users interact with directly. `naia-os` now refers to the Bazzite/titanoboa-based **distribution/ISO** layer that packages this shell into a bootable form. To keep the two names apart, we use `naia-shell` for the code and `naia-os` for the distribution. The product category is **Naia Visual Agent**.

---

## What is naia-shell?

naia-shell is **the desktop shell (app) for Naia Visual Agent**. It is the screen users actually
launch and look at. Internally, it:

- **Launches the brain** — on startup, spawns naia-agent as an external process and connects over gRPC.
- **Only relays messages** — providers, models, keys, and memory all belong to the agent. The shell does not
  need to know "which model it is". It sends user input and renders the streamed response, nothing more.
- **Handles expression** — expresses the agent's responses to people through text, voice, and avatar.

```
User ─input→ naia-shell (visual shell) ─(gRPC)→ naia-agent (brain) ─→ provider / memory / tools
            ◀─expression (text·voice·avatar)── stream ◀────────
```

---

## What it does (capabilities · status)

| Capability | Description | Status |
|------|------|:----:|
| **Text chat** | Shell spawns the agent → chats over the gRPC `Chat` stream. New core path | ✅ |
| **Provider/model settings** | Settings UI → agent `SetWorkspace`/reload swaps the model without restarting the app | ✅ |
| **Environment sidecar** | Independent service separate from the brain (e.g. BGM `bgm-sidecar`). Survives if the brain dies | ✅ |
| **Proactive speech profile** | Opt-in with "start personal radio" or "start event introduction". Connects a long-running activity stream to the existing text·TTS·BGM expression | ✅ technical slice / product validation partial |
| **Voice I/O · avatar · TTS** | Voice input/output and avatar expression | 🔜 old path exists; porting to the new core follows UC2 |
| **Multimodal expression** | One expression intent consumed together by voice/avatar/robot body | 🔜 slot reserved for egress branching |

> ✅ = implemented + tested in the new core (including Playwright e2e). 🔜 = design/old path exists, porting in progress.
> For exact tracking, see `docs/user-scenarios.md` (UC SoT) and `docs/requirements.md` (Korean). For Windows RTX 6GB voice-only, [`docs/windows-6gb-voice.md`](docs/windows-6gb-voice.md) is the operating baseline; for 8GB NVA, [`docs/windows-8gb-nva.md`](docs/windows-8gb-nva.md).
> Real Tauri validation covers profile save·restore, DJ real YouTube BGM·first result·stop, and exhibition greeting·stop.
> Audible TTS, live question barge-in, all controls, and long-running/on-site quality are not yet claimed as natively validated.

---

## Place in the ecosystem

naia-shell is the **expression/shell layer** of the Naia Visual Agent stack.

```
┌───────────────┐   gRPC    ┌───────────────┐  recall/save  ┌────────────────┐
│  naia-shell   │ ────────▶ │  naia-agent   │ ────────────▶ │  naia-memory   │
│  (this repo)  │ ◀──────── │ (brain/logic) │ ◀──────────── │ (cognitive mem)│
│UI·voice·avatar│  stream   │provider·tools │               │long-term·recall│
└───────────────┘           └───────┬───────┘               └────────────────┘
                                    │ settings·skill loading
                                    ▼  naia-adk (workspace — provider/model/skill SoT)
```

- **naia-shell** (the current code role of this repo) — the user shell. Spawns the agent and talks to it over gRPC.
- **naia-os** — a custom distribution/ISO based on Bazzite/titanoboa. The distribution layer that packages the visual agent stack into a bootable workstation.
- **naia-agent** — the brain that calls providers, runs tools, and assembles conversations. → `../naia-agent`
- **naia-memory** — long-term memory. The agent integrates with it via recall/save.
- **naia-adk** — the workspace where settings live. The agent loads it on startup.

**Coupling = interfaces, not runtime dependencies.** shell↔agent mesh only through the gRPC wire contract
(`AgentOutbound`/`AgentMessage` closed unions). Transport is a port, so
swapping stdio↔gRPC does not touch the domain.

---

## Brain · body · environment model (naia's core concept)

What sets naia-shell apart from other desktop apps is this three-layer split (SoT: `docs/brain-body-environment.md`, Korean):

| Layer | What | Where |
|----|------|------|
| **Brain** | Cognition·intent — what to say and which tools to use | naia-agent (separate process) |
| **Body** | Sensing·expression organs — avatar·voice I/O | Shell native |
| **Environment** | The world the agent works in — browser·terminal·workspace·BGM | Independent sidecars owned by the shell |

Key point: **tools and BGM are "environment", not "body"**, and are independent services separated from the brain (the
environment survives if the brain dies; the brain only sends intents). Thanks to this split, the brain can be swapped
for Android/embedded while body, environment, and domain stay unchanged.

---

## Architecture at a glance

- **Shell** = Tauri (Rust) + frontend (`packages/shell`). Native window·IPC·expression.
- **Core** = hexagonal TypeScript (`src/main`: domain/app/ports/adapters/composition). Same philosophy as the agent.
- **Sidecar** = independent environment service (`packages/bgm-sidecar`).
- The **onboarding SoT** for the overall philosophy (two orthogonal axes·cognitive layers·new UC recipe) = [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (Korean).

---

## Quick start

> ⚠️ When running or building, naia-shell automatically builds and spawns **naia-agent (the brain)** inside `projects/`.
> The release build also first builds the agent's local production dependencies, `naia-kb-compiler` and `naia-memory`, from the workspace
> root. `naia-memory` is accepted only as a clean checkout of the exact
> commit·package version recorded in `packages/shell/agent-pairing.json`. Keep the canonical layout and names below.

```bash
# 1) Clone into the canonical workspace layout (do not rename directories)
mkdir projects
cd projects
git clone https://github.com/nextain/naia-shell.git
git clone https://github.com/nextain/naia-agent.git
git clone https://github.com/nextain/naia-kb-compiler.git
git clone https://github.com/nextain/naia-memory.git
# agent-pairing.json pins the exact source revisions used by the shell.
git -C naia-agent fetch --depth 1 origin cb4c8d71ae24bb7ff042e275026fae3905a91a00
git -C naia-agent checkout --detach cb4c8d71ae24bb7ff042e275026fae3905a91a00
git -C naia-kb-compiler fetch --depth 1 origin 24f52c14ea906c250304f39d48866c7a47e1b596
git -C naia-kb-compiler checkout --detach 24f52c14ea906c250304f39d48866c7a47e1b596
git -C naia-memory fetch --depth 1 origin 630a0d2f19b559e3f0101bb141048485167fb959
git -C naia-memory checkout --detach 630a0d2f19b559e3f0101bb141048485167fb959
#  workspace/
#  ├── projects/
#  │   ├── naia-shell/  ← run the commands below from here
#  │   └── naia-agent/  ← built and spawned automatically
#  │   ├── naia-kb-compiler/
#  │   └── naia-memory/

cd naia-shell
pnpm install --frozen-lockfile    # install dependencies (root)
# naia-agent is a sibling outside the shell workspace and is not included in the root install.
pnpm -C ../naia-kb-compiler install --frozen-lockfile
pnpm -C ../naia-kb-compiler run build
pnpm -C ../naia-memory install --frozen-lockfile
pnpm -C ../naia-memory run build
pnpm -C ../naia-agent install --frozen-lockfile

# 2) Core unit·contract tests (root)
pnpm test                          # vitest run (src/test — pure logic·UC contracts)

# 3) Run the desktop shell (Tauri) — builds and spawns the agent automatically
pnpm -C packages/shell run tauri:dev

# 4) Build the release (installer) — one entry point shared by all 3 OSes (#377)
#    Auto-detects the OS from platform-matrix.json (SoT): downloads the node runtime + SHA256, (win) MSVC redistributable,
#    stages the agent, generates the conf, then runs tauri build. Output = packages/shell/src-tauri/target/release/bundle/
#    (win → NSIS+MSI · linux → deb/rpm/appimage · mac → app/dmg)
#    ⚠️ Do not build with plain `tauri build` (default conf) — the base conf is neutralized, so
#    you get an installer missing the agent/node resources.
pnpm -C packages/shell run tauri:build:bundle

# Verify the minimum artifact size + SHA256 (result in bundle/artifacts.sha256)
node packages/shell/scripts/verify-artifacts.mjs

# 5) Verification (P04 — GUI/Rust headless too). test:e2e / test:e2e:tauri exist only in packages/shell:
cd packages/shell
pnpm test                          # vitest (shell unit)
pnpm test:e2e                      # Playwright e2e (real UI, Tauri IPC mock)
xvfb-run pnpm test:e2e:tauri       # real Tauri binary full stack (wdio+tauri-driver, Linux)
```

Even though `tauri:dev` builds and spawns the paired Agent automatically, it does not install the sibling dependencies
or build the KB·memory `dist/` for you. On a fresh clone, first do the exact-commit
checkouts and the sibling install/build above. If any of them is missing or not a clean checkout,
the `agent-pairing.json` check fails closed. The Agent's proto pin is
`71e4cb6b3d19f9df08c88e6225babc11e30fe445723badd440decdb2a33e6f42`, and the memory package
version is `0.1.4`.

For installer CI, [build-installers.yml](.github/workflows/build-installers.yml) runs the same matrix entry point on Windows·Ubuntu·macOS.
On Ubuntu, it installs the deb, then checks the agent handshake and that the bundled Node is actually used,
and also verifies that a negative run with the bundled Node removed fails.

> Authenticode code signing for the Windows installer and macOS notarization are still out of scope. Windows auto-update
> artifacts are signed with the Tauri updater key, and every release must ship with both `.sig` and `latest.json`.
> macOS CI verifies per-architecture apps for Intel·Apple Silicon and a Universal app containing both
> architectures. Unnotarized macOS artifacts must be explicitly approved via "Open" in Finder. For the Windows procedure, follow
> [docs/progress/windows-release-process.md](docs/progress/windows-release-process.md).

> **Prerequisites**: Node 22+ · pnpm · Rust (rustup) · WebView2 (Windows)/webkit2gtk (Linux) · C++ build tools.
> For per-OS setup, see [`.github/CONTRIBUTING.md`](.github/CONTRIBUTING.md) (Korean).

---

## Development process (for contributors)

**Contract-first + V-model** — scenarios, requirements, and tests come before a single line of code.

| Gate | Artifact |
|--------|--------|
| P01 User scenarios | `docs/user-scenarios.md` UC |
| P02 Test scenarios | Test Coverage Map mapping |
| P03 Requirements | `docs/requirements.md` FR/NFR |
| P04 Integration tests | vitest + Playwright e2e (UI/Rust changes include real validation) |
| P05 Done | Requirement status → Done |

The recipe for adding a new UC (fill the slots, no guessing) is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §6 (Korean).
The entry point and rules for every AI tool are in **[`AGENTS.md`](AGENTS.md)** (Korean) — if you are new, read it after this README.
For a quick first-contribution guide, see [`.github/CONTRIBUTING.md`](.github/CONTRIBUTING.md) (Korean, includes a 15-minute fast path).

---

## Project structure

```
naia-shell/
├── AGENTS.md / CLAUDE.md / GEMINI.md / OPENCODE.md / CODEX.md   # AI entry points (charter) — AGENTS.md is the SoT, the rest are auto mirrors
├── .agents/        # AI context (rules·status·hooks) — edited by humans
│   └── context/    #   agents-rules.json (rules SoT) · process-status.json (progress)
├── .users/         # human-readable markdown mirror of .agents/
├── src/
│   ├── main/       # core — domain / app / ports / adapters / composition
│   └── test/       # core tests
├── packages/
│   ├── shell/      # Tauri desktop shell (UI·avatar·voice I/O·e2e)
│   └── bgm-sidecar/# environment sidecar (BGM)
├── scripts/        # enforce-root-structure.sh (structure enforcement) · sync-harness-mirrors.sh, etc.
└── docs/           # ARCHITECTURE · brain-body-environment · user-scenarios · requirements · glossary · progress
```

Structure rule: a new root file/folder must first be registered in `agents-rules.json` (F12/F13).
If it is not registered, `scripts/enforce-root-structure.sh --fix` **deletes** it.

---

## License

- **Source code**: Apache License 2.0 — [`LICENSE`](LICENSE).
- **AI context** (`.agents/`·`.users/`·`AGENTS.md`): CC-BY-SA 4.0 — [`CONTEXT-LICENSE`](CONTEXT-LICENSE).

**Why a dual license?** The source code is Apache 2.0, so you can freely modify it and use it commercially, but the AI context files (project philosophy·contribution structure·AI agent collaboration principles) are CC-BY-SA 4.0. When you fork, you must **share your context changes under the same license (ShareAlike)** and credit the original author (Nextain) — this protects the upstream ecosystem (open source contribution structure + AI collaboration principles) so that it propagates to every fork. Details = [`CONTEXT-LICENSE`](CONTEXT-LICENSE).

For the contribution guide, code of conduct, and security policy, see [`.github/`](.github/).

## Links

- **naia-agent** (brain) — `../naia-agent`
- **naia-memory** (long-term memory) — [github.com/nextain/naia-memory](https://github.com/nextain/naia-memory)
- **naia-adk** (workspace) — [github.com/nextain/naia-adk](https://github.com/nextain/naia-adk)
- **Nextain** — [nextain.io](https://nextain.io)
