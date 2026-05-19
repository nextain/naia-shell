# Naia Hybrid Architecture

## Core Design Philosophy

> **Don't build from scratch. Combine 3 proven ecosystems.**

Naia takes the strengths from 3 parent projects and combines them in a **hybrid** approach:

| Parent | Role | What we take |
|--------|------|-------------|
| **OpenClaw** | Runtime backend | Gateway daemon, command execution, channels, skills, memory |
| **project-careti** | Agent intelligence | Multi-LLM, tool definitions, Alpha persona, cost tracking |
| **OpenCode** | Architecture patterns | Client/server separation, provider abstraction |

---

## Why Hybrid?

### Why not just one?

**OpenClaw only?** → CLI-only, no avatar, no visual feedback, no emotion
**Careti only?** → VS Code extension, no always-on, no channels/skills
**OpenCode only?** → TUI-only, no VRM avatar, no desktop app

### Hybrid Solution

```
OpenClaw's daemon + execution + channels + skills ecosystem (runtime backend)
+ Careti's multi-LLM + tools + persona (agent intelligence)
+ OpenCode's client/server separation pattern (architecture)
= Wrap it in a Tauri desktop shell with VRM avatar for accessible UX
```

---

## Runtime Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Naia Shell (Tauri 2 + React + Three.js VRM Avatar) │
│  Role: Desktop UI, avatar rendering, chat panel        │
│  Source: Naia + AIRI (VRM) + shadcn/ui              │
└──────────────────────┬──────────────────────────────────┘
                       │ stdio JSON lines
┌──────────────────────▼──────────────────────────────────┐
│  Naia Agent (Node.js)                                │
│  Role: LLM connection, tool orchestration, Alpha persona│
│  Source: Careti providers + OpenCode pattern             │
│  Features: multi-LLM, TTS, emotion, cost tracking       │
└──────────────────────┬──────────────────────────────────┘
                       │ WebSocket (ws://127.0.0.1:18789)
┌──────────────────────▼──────────────────────────────────┐
│  Naia Gateway (systemd user service)                │
│  Role: Execution, security, channels, skills, memory    │
│  Source: naia-agent (Node.js, pnpm dev / dist/index.js)  │
│  Auth: device identity + token scopes (protocol v3)     │
│  Methods: dynamic by profile (agent, node.invoke,        │
│  sessions.*, browser.request, skills.*, channels.* ...)  │
└─────────────────────────────────────────────────────────┘
```

## The 3 Pillars in Detail

### Pillar 1: OpenClaw (Runtime Backend)

What OpenClaw provides:
- **Gateway daemon**: systemd user service, always running
- **Command execution**: exec.bash primary + node.invoke(system.run) fallback
- **Security**: Device auth, token scopes, exec approval
- **Channels**: Discord, Telegram, WhatsApp, Slack, IRC, etc.
- **Skills**: 50+ built-in (weather, time, notes, etc.)
- **Memory**: Conversation persistence, context recall
- **Sessions**: Multi-session, sub-agent spawn
- **ACP**: Agent Control Protocol (client↔agent bridge)
- **TTS**: Integrated provider selector (Edge TTS free, Google Cloud, OpenAI, ElevenLabs) — direct API calls

### Pillar 2: project-careti (Agent Intelligence)

What Careti provides:
- **Multi-LLM via registry**: Naia, Claude Code CLI, Gemini, OpenAI, Anthropic, xAI, Zhipu, Ollama, vLLM
- **Tool definitions**: GATEWAY_TOOLS (8 tools)
- **Function calling**: Gemini native (xAI/Claude = tech debt)
- **Alpha persona**: System prompt, emotion mapping
- **Cost tracking**: Per-request cost display
- **stdio protocol**: Shell ↔ Agent JSON lines

### Pillar 3: OpenCode (Architecture Patterns)

What OpenCode provides:
- **Client/server separation**: Shell (client) / Agent (server)
- **Provider registry pattern**: registerLlmProvider → buildProvider (extensible)
- **Module boundaries**: shell / agent / gateway separation

---

## Shell UI Layout

```
App
├── TitleBar (panel toggle button + window controls)
└── .app-layout [data-panel-position="left"|"right"|"bottom"]
    ├── .side-panel (ChatPanel — only rendered when panelVisible=true)
    └── .main-area (AvatarCanvas — always visible)
```

- **panelPosition**: `"left" | "right" | "bottom"` — controls CSS flex-direction on .app-layout
- **panelVisible**: `boolean` — toggles chat panel; avatar always stays visible
- **panelSize**: `number (0-100)` — chat panel percentage of viewport. Default: **70**
- **Avatar sizing**: `ResizeObserver` on container (not window resize)
- **Config sync**: panelPosition + panelVisible + panelSize + liveVoice + liveModel + voiceConversation synced to Lab via `LAB_SYNC_FIELDS`

---

## Data Flow

| Scenario | Flow |
|----------|------|
| **Chat** | User → Shell → Agent → LLM → Agent → Shell → User |
| **Tool exec** | LLM → Agent (tool_use) → Gateway (exec.bash or node.invoke) → OS → result → LLM |
| **Approval** | Gateway → Agent (approval_request) → Shell (modal) → user decision → Agent → Gateway |
| **External** | Discord msg → Gateway → Agent → LLM → Agent → Gateway → Discord reply |

## Credential Storage Architecture

> Last updated: 2026-03-05

### naiaKey Dual-Storage (localStorage + Tauri Secure Store)

`naiaKey` (Naia Lab API key) is stored in **two locations** for reliability:

| Storage | Type | Used by |
|---------|------|---------|
| **localStorage** | Sync, fast | All UI components via `saveConfig`/`loadConfig` |
| **Tauri secure store** | Async, encrypted | Persists across browser storage clears |

**Write points:**
- **Login** (SettingsTab/OnboardingWizard): `saveConfig({naiaKey})` + `saveSecretKey("naiaKey", key)`
- **Save** (SettingsTab): `saveConfig()` + `void saveSecretKey()`
- **Logout** (SettingsTab): `saveConfig({naiaKey: undefined})` + `deleteSecretKey("naiaKey")`

**Read merge** (`loadConfigWithSecrets()`):
1. Read localStorage value (sync)
2. Read secure store value (async)
3. **localStorage takes priority** — syncs to secure store if different
4. If only secure store has value → use it (migration/recovery case)

### naiaKey Independence from LLM Provider

`naiaKey` is passed as a **top-level field** in `ChatRequest`, separate from `provider` config. This allows Naia Cloud TTS to work regardless of which LLM provider is selected.

- ChatPanel sends `naiaKey` in both `provider.naiaKey` (for LLM) and request-level `naiaKey` (for TTS)
- Agent resolves: `effectiveNaiaKey = request.naiaKey || provider.naiaKey`

**Key files:** `config.ts`, `secure-store.ts`, `SettingsTab.tsx`, `OnboardingWizard.tsx`, `agent/src/index.ts`, `agent/src/protocol.ts`

---

## Desktop Avatar Local File Pipeline

Rules for reliably loading VRM/backgrounds from local files:

- `file://` paths are normalized to absolute paths before save/render.
- Paths in `http://localhost/...` form are converted to `http://asset.localhost/...` for Tauri asset protocol compatibility.
- Absolute local VRMs are read as bytes via Rust command `read_local_binary`, then parsed as `ArrayBuffer` directly in frontend.
  This avoids CORS/access control failures with URL fetch.
- Background images use asset URL conversion, with fallback to default gradient on failure.

### E2E Execution Note

- `e2e-tauri` runs a fixed binary at `src-tauri/target/debug/naia-shell` (separate from `pnpm build` output).
- After changes to Rust `#[tauri::command]` or `invoke_handler`, always run `cargo build` in `src-tauri` before E2E.

### Agent Build Pipeline Note

Agent runs from `shell/src-tauri/target/debug/agent/dist/index.js` (pre-built). **Vite HMR does NOT apply to agent code.** After modifying `agent/src/`:
1. `cd agent && pnpm build` (tsc compiles to `agent/dist/`)
2. `cp -r agent/dist/ shell/src-tauri/target/debug/agent/dist/`
3. Or restart `pnpm run tauri dev` which rebuilds automatically.

## Channel/Onboarding Discord Routing Rules

- Discord bot addition flow uses `naia.nextain.io` routing, not direct token/webhook handling in Shell.
- Both the Channels tab Discord login button and the onboarding final step button open:
  `https://naia.nextain.io/ko/discord/connect?source=naia-shell`
- Security principles:
  - `DISCORD_BOT_TOKEN` is never used/exposed in shell frontend.
  - Bot secrets are managed only in `naia.nextain.io` server environment variables.

## Deep-link Persistence Contract (Important)

OAuth deep-link payloads must be persisted regardless of whether specific tabs (Settings/Onboarding) are rendered.

- Required rules:
  - Deep-link events affecting runtime behavior (`discord_auth_complete`, etc.) must be received/saved at **always-mounted layer (App root)**.
  - Settings/Onboarding listeners are for UI state sync only; persistence logic is centralized in common library.
  - Agent default send target must not depend on "whether Settings tab was open".
- Prohibited patterns:
  - Saving auth payloads only inside tab components.
  - Duplicating different fallback rules across components.

## Memory Architecture (Three-Layer)

Memory lives in **three systems** that serve different purposes and connect at session boundaries.

- **Shell** owns "who is the user" (facts)
- **Naia Gateway** owns "what happened" (session transcripts)
- **Agent** owns "semantic recall + contradiction filtering" via `@nextain/naia-memory` (R3)

### Shell Memory (Tauri)

#### Short-Term Memory

| Item | Details |
|------|---------|
| **Storage** | Zustand (in-memory) + SQLite messages table |
| **Scope** | All messages in current session |
| **Lifetime** | Current session ~ last 7 days |
| **Implementation** | Rust `memory.rs` + Frontend `db.ts` + Chat store |

#### Long-Term Memory — Facts

| Item | Details |
|------|---------|
| **Storage** | `~/.config/naia-os/memory.db` (SQLite, facts table) |
| **Scope** | Cross-session user knowledge (name, birthday, preferences, decisions) |
| **Extraction** | `memory-processor.ts` `extractFacts()` — LLM parses conversation → `{key, value}[]` |
| **Injection** | `persona.ts` `buildSystemPrompt()` → `"Known facts about the user: ..."` in system prompt |

### Naia Gateway Memory (Daemon)

#### Session Transcripts

| Item | Details |
|------|---------|
| **Storage** | `~/.naia/sessions/` (`sessions.json` + `*.jsonl` per session) |
| **Scope** | Full conversation history per session key (`agent:main:main`, `discord:dm:*`, etc.) |
| **RPC** | `sessions.list`, `chat.history`, `sessions.transcript`, `sessions.compact` |
| **Hook** | `session-memory` — on `/new` or `/reset`, saves conversation to `workspace/memory/*.md` |

#### Semantic Search Index

| Item | Details |
|------|---------|
| **Storage** | `~/.naia/memory/main.sqlite` (SQLite with embeddings) |
| **Tools** | `memory_search` (semantic search), `memory_get` (retrieve entry) |
| **Scope** | Cross-session searchable index (sessions + `workspace/memory/*.md` files) |

#### Workspace Bootstrap Files

| Item | Details |
|------|---------|
| **Storage** | `~/.naia/workspace/` (`SOUL.md`, `IDENTITY.md`, `USER.md`) |
| **Sync** | Shell writes these via `sync_gateway_config` (`lib.rs`) on settings change |
| **Note** | Regenerable from Shell settings — not primary data |

### Data Flow (How the Two Systems Connect)

```
SESSION START
  Shell: buildMemoryContext() → getAllFacts() from Shell DB
  Shell: buildSystemPrompt(persona, {facts, userName, locale, ...})
  → System prompt with user facts sent to Agent

DURING SESSION
  Agent ↔ Naia Gateway: messages stored in session transcript (*.jsonl)
  Naia Gateway: memory_search tool available for LLM to query past sessions
  Shell: Zustand store holds current messages for UI

SESSION END (user clicks "New Conversation")
  Shell [fire-and-forget]:
    1. summarizeSession(messages) → LLM generates 2-3 sentence summary
    2. patchGatewaySession("agent:main:main", {summary}) → Naia Gateway session metadata
    3. extractFacts(messages, summary) → LLM extracts {key, value}[] user facts
    4. upsertFact() × N → Shell facts DB (memory.db)
  Naia Gateway:
    session-memory hook saves conversation to workspace/memory/YYYY-MM-DD-slug.md
    semantic index updated with new session content

NEXT SESSION
  Shell: loads facts → injects into system prompt ("Known facts about the user")
  Naia Gateway: memory_search finds content from previous sessions
  → User is "remembered" through both system prompt facts AND searchable history
```

### Discord Channel Memory

Discord messages flow through Naia Gateway sessions (key: `agent:main:discord:direct:<userId>`).
These are stored in Naia Gateway session transcripts and indexed by `memory_search`.
However, Shell fact extraction (`summarizePreviousSession`) only runs on Shell chat sessions —
**Discord conversations do NOT trigger fact extraction yet**.

### Device Migration — Backup Required

| Path | Content | Required? |
|------|---------|-----------|
| `~/.config/naia-os/memory.db` | Shell facts (user knowledge) | **Must backup** |
| `~/.naia/memory/main.sqlite` | Semantic search index | **Must backup** (rebuildable but slow) |
| `~/.naia/sessions/` | Conversation transcripts | Recommended |
| `~/.naia/gateway.json` | Gateway config (API keys, model) | Recommended |
| `~/.naia/workspace/` | SOUL/IDENTITY/USER.md | Regenerable from Shell |
| `~/.naia/credentials/` | OAuth tokens | Re-authenticatable |

### Agent Memory — @nextain/naia-memory R3 (added 2026-05-07, #226)

The **agent process** hosts a dedicated semantic memory system using `@nextain/naia-memory`.

| Item | Details |
|------|---------|
| **Package** | `@nextain/naia-memory` (local submodule `file:../../naia-memory`) |
| **Config** | `~/.naia/memory-config.json` (optional) |
| **Adapter** | `LocalAdapter` — `~/.naia/memory/agent-store.json` |
| **Embedding** | vLLM/Ollama → `OpenAICompatEmbeddingProvider`; Naia → `NaiaGatewayEmbeddingProvider`; None → keyword-only |
| **R3 features** | `HeuristicContradictionFilter`, Reconsolidation, HyDE, MMR |

**Config fields** (`~/.naia/memory-config.json`):
```json
{
  "embeddingProvider": "vllm",
  "embeddingBaseUrl": "http://localhost:8000",
  "embeddingApiKey": "...",
  "embeddingModel": "nomic-embed-text"
}
```

**API** (correct R3 methods — NOT storeEpisode/recallEpisodes):
```typescript
ms.encode(input: MemoryInput, context: EncodingContext): Promise<Episode>
ms.recall(query: string, context: RecallContext): Promise<{episodes, facts, reflections}>
ms.sessionRecall(firstMessage, context, tokenBudget?): Promise<string>
ms.close(): Promise<void>
```

> ⚠️ `HeuristicContradictionFilter` is **not** exported from the top-level `@nextain/naia-memory` index.
> Import from subpath: `import { HeuristicContradictionFilter } from ".../contradiction-filter.js"`

Shell Settings UI: **Memory** section in SettingsTab — embedding provider, base URL, model, LLM provider.

### Search Engine Evolution

```
4.4a: SQLite LIKE (keyword matching)
4.4b: SQLite FTS5 BM25 (full-text search)
4.5:  Gemini Embedding API (semantic search)
5+:   Agent @nextain/naia-memory R3 — vLLM/Ollama local embedding + HeuristicContradictionFilter
```

### DB Schema

```sql
-- Shell facts (user knowledge, cross-session)
CREATE TABLE facts (id TEXT PK, key TEXT UNIQUE, value TEXT,
                    source_session TEXT, created_at INT, updated_at INT);

-- Naia Gateway sessions: ~/.naia/sessions/sessions.json (metadata)
--                      + *.jsonl per session (transcripts)
-- Naia Gateway semantic: ~/.naia/memory/main.sqlite (embeddings index)
```

---

## Skill System

Skill management: built-in skills, Gateway skills, and install flow. *(Updated: 2026-03-05)*

### Built-in Skills

- **Count**: 20 skills
- **Sync locations** (all 4 must list the same 20 skills):
  1. `shell/src-tauri/src/lib.rs` — `list_skills` Tauri command
  2. `shell/src/components/ChatPanel.tsx` — `BUILTIN_SKILLS` Set (guards against disable)
  3. `agent/src/skills/built-in/*.ts` — tool-bridge registry
  4. `agent/scripts/generate-skill-manifests.ts` — `SKIP_BUILT_IN` list
- **Rule**: Adding a new built-in requires updating all 4 locations.

### Gateway Skills

- **Source**: Naia Gateway `skills.status` RPC
- **Response fields**: `name`, `description`, `eligible`, `missing[]`, `install[]` (`{ id, kind, label }`)
- **Install kinds**: `brew`, `node`, `go`, `uv`, `download`

### Install Flow

```
1. Shell SkillsTab calls fetchGatewayStatus()
   → directToolCall({ action: "gateway_status" })
   → Agent skill_skill_manager → Gateway skills.status RPC
   → Returns skills[] with install[] arrays

2. User clicks Install button
   → Shell resolves installId from gs.install[0].id
   → directToolCall({ action: "install", skillName, installId })
   → Agent skill_skill_manager → Gateway skills.install RPC
   → Gateway runs installer (brew/npm/go/etc)
   → Returns success/error

3. Shell shows install result feedback
   → Re-fetches gateway status to update UI
```

- **RPC params**: `skills.status: { agentId? }`, `skills.install: { name, installId }` — `installId` is REQUIRED (from `install[].id`)
- **directToolCall flow**: Shell → Tauri stdin → Agent `handleToolRequest()` → `executeTool(skill_skill_manager)` → Gateway RPC → result back to Shell
- **Event cleanup**: `GatewayAdapter.offEvent(handler)` must be called after `delegateStreaming` completes to prevent event handler memory leaks.

---

## Security 4-Layer (Defense in Depth)

| Layer | Role | Config |
|-------|------|--------|
| **OS** | Bazzite immutable rootfs + SELinux | System file protection |
| **Gateway** | Naia Gateway device auth + token scopes + exec approval | protocol v3, Ed25519 |
| **Agent** | Permission tiers 0-3 + per-tool blocking | Tier 3: blocks rm -rf, sudo, etc. |
| **Shell** | User approval modal + tool on/off toggle | User-controlled |

**Principle: Each layer is independent. If one layer is breached, the rest still defend.**

---

## GatewayAdapter Abstraction

> **#64 (2026-03-17)** — Interface layer to decouple agent from gateway-specific code

| Item | Detail |
|------|--------|
| Interface | `GatewayAdapter` (`agent/src/gateway/types.ts`) |
| Current impl | `GatewayClient implements GatewayAdapter` (`client.ts`) |
| Scope | 14 proxy files, tool-bridge, skills/types, skills/loader, index.ts — reference `GatewayAdapter` only |
| Exception | `connectGatewayWithRetry` uses `new GatewayClient()` internally |
| Next issue | `#78` — first-run gateway selection + on-demand version-pinned install |

**Interface methods:** `request`, `onEvent`, `offEvent`, `close`, `isConnected`, `availableMethods`

**Rationale:** Abstraction layer isolates agent code from gateway protocol changes. Without it, any breaking change requires full rewrite.

---

## Gateway Connection Protocol

How Naia Agent connects to Naia Gateway:

```
1. WebSocket connection: ws://127.0.0.1:18789
2. Gateway → connect.challenge event (with nonce)
3. Agent → connect request (token + protocol v3 + client info)
4. Gateway → hello-ok response (88 methods + capability list)
5. Agent → req/res frames for tool execution (exec.bash / node.invoke etc.)
```

### Auth Parameters

| Parameter | Value | Description |
|-----------|-------|-------------|
| auth.token | gateway.auth.token | Shared token from gateway config |
| client.id | "cli" | Paired device ID |
| client.platform | "linux" | Platform |
| client.mode | "cli" | Client mode |
| minProtocol | 3 | Minimum protocol version |
| maxProtocol | 3 | Maximum protocol version |

---

## Shell Tauri Diagnostics Commands

> Added in #296 / #297. File: `shell/src-tauri/src/lib.rs`

### `gateway_health() -> bool`

Checks whether the naia-agent child process is currently alive.

- Returns `true` if alive, `false` otherwise
- Used by SettingsTab agent health check button: `invoke<boolean>("gateway_health")`
- Named "gateway" for historical reasons — actually checks naia-agent process liveness

### `get_gateway_log_path() -> String`

Returns the path to the main agent log file.

- Returns `log_dir().join("gateway.log").to_string_lossy()`
- `log_dir()` resolves to `~/.naia/logs/`
- Used by SettingsTab log viewer button: `invoke<string>("get_gateway_log_path")` → `openPath(path)`

### SettingsTab Two-Tab Layout (added #298)

SettingsTab now has a **Settings / Memory** tab bar:

- **Settings tab** (default): provider, API key, VRM, theme, agent health check, log viewer, danger zone
- **Memory tab**: embedding provider, facts list, memory management

---

## Voice Architecture

> Last updated: 2026-03-14

### Overview

Voice interaction depends on the **LLM model capabilities**:

- **Omni models** (Gemini Live, OpenAI Realtime): Voice I/O is built into the LLM. No separate STT/TTS needed — the model handles speech input and output natively. Detected via `capabilities.includes("omni")`.
- **Standard LLM models**: Voice via independent **STT → LLM → TTS pipeline**. STT and TTS are separate, independently selectable providers.

When an omni model is active, STT/TTS provider settings are disabled. **STT providers, TTS providers, and LLM providers are three independent categories.**

---

### Omni Models (LLM with Built-in Voice)

LLM models with built-in bidirectional voice I/O — voice is an LLM capability, not a separate STT/TTS concern.

**Type:** `LiveProviderId = "naia" | "gemini-live" | "openai-realtime" | "minicpm-o" | "vllm-omni" | "edge-tts"`

**Factory:** `createVoiceSession(provider, options?) → VoiceSession` (`shell/src/lib/voice/index.ts`)

#### Providers

| Provider | Route | Auth | File |
|----------|-------|------|------|
| **naia** | Browser WS → any-llm gateway `/v1/live` → Gemini Live API | naiaKey | `voice/gemini-live.ts` |
| **gemini-live** | Tauri cmd → Rust WS proxy → Gemini Live API | Google API key | `voice/gemini-live-proxy.ts` |
| **openai-realtime** | Browser WS → `wss://api.openai.com/v1/realtime` | OpenAI API key | `voice/openai-realtime.ts` |
| **minicpm-o** | Browser WS → self-hosted vllm-omni `/v1/realtime` | None (LAN/Tailscale) | `voice/minicpm-o.ts` (+ `voice/ref-audio.ts` for voice-clone) |

#### VoiceSession Interface

All providers implement a unified `VoiceSession` interface:
- **Methods:** `connect()`, `sendAudio(base64)`, `sendText(text)`, `sendToolResponse(id, result)`, `disconnect()`
- **Events:** `onAudio`, `onInputTranscript`, `onOutputTranscript`, `onTurnEnd`, `onInterrupted`, `onToolCall`, `onError`, `onDisconnect`

#### Voice Setting

Config field: `liveVoice` (short name e.g., "Kore", "Puck")

Available voices: Kore (female, calm), Puck (male, lively), Charon (male, deep), Aoede (female, bright), Fenrir (male, low), Leda (female, soft), Orus (male, firm), Zephyr (neutral), + more

**Gemini Direct note:** WebKitGTK cannot connect to Gemini WSS directly (hangs silently). Uses Rust tokio-tungstenite proxy via Tauri commands.

---

### STT Providers (Independent, Pipeline Mode)

Independent STT provider registry — used only in pipeline mode for standard LLM models. Omni models have built-in speech recognition and do NOT use these providers.

**Registry files:**
- `shell/src/lib/stt/types.ts` — `SttProviderMeta`, `SttModelMeta`, `SttEngineType`
- `shell/src/lib/stt/registry.ts` — `registerSttProvider()`, `getSttProvider()`, `listSttProviders()`

**`SttEngineType`:** `"tauri"` (offline Rust) | `"api"` (cloud API) | `"web"` (Web Speech) | `"vllm"` (local vLLM server)

`SttProviderMeta` supports `isLocal?`, `requiresEndpointUrl?`, `endpointUrlConfigField?` for local server providers (e.g., vLLM-based ASR).

#### Providers

| Provider | Engine | Type | Description |
|----------|--------|------|-------------|
| **vosk** | vosk | offline, streaming | Lightweight, ~40-80MB models per language |
| **whisper** | whisper | offline, batch | Higher accuracy, GPU-accelerated (whisper-rs) |
| google | — | disabled | Future API support |
| elevenlabs | — | disabled | Future API support |

**Config fields:** `sttProvider` ("vosk"|"whisper"), `sttModel` (model_id string)
**Settings UI:** STT provider dropdown + model list with size/WER, download/delete buttons
**First install:** No `sttProvider` set → voice button shows popup → navigate to settings

**Vosk models:** ko-KR (82MB), en-US (40MB), ja-JP (48MB) — streaming, auto-download
**Whisper models:** tiny (75MB) → large-v3 (3GB) — batch inference every 2s or 1.5s silence

**CUDA:** NVIDIA GPU acceleration via upstream whisper-rs `cuda` feature. Requires CUDA toolkit at build time. Uses upstream whisper-rs directly (codeberg.org/tazz4843/whisper-rs).

---

### TTS Providers (Independent, Pipeline Mode + Chat Auto-TTS)

Independent TTS provider registry — used in pipeline mode and chat auto-TTS. Omni models produce voice output directly and do NOT use these providers.

**Default provider:** `edge` (free, no login required)

**Registry files:**
- Agent: `agent/src/tts/types.ts`, `registry.ts`, `index.ts` — runtime dispatch
- Shell: `shell/src/lib/tts/types.ts`, `registry.ts` — Settings UI metadata

**Adding a new TTS provider:**
1. Create `agent/src/tts/{name}.ts` — implement `TtsProviderDefinition`
2. Call `registerTtsProvider({...})` at module scope
3. Add import in `agent/src/tts/index.ts`
4. Add `TtsProviderMeta` in `shell/src/lib/tts/registry.ts`

#### Providers

| Provider | Route | Auth |
|----------|-------|------|
| **edge** | agent → Naia Gateway → Edge TTS | none (free) |
| **nextain** | agent → any-llm gateway → Google Cloud TTS | naiaKey |
| **google** | agent → Naia Gateway → Google Cloud TTS | Google API key |
| **openai** | agent → Naia Gateway → OpenAI TTS | OpenAI API key |
| **elevenlabs** | agent → Naia Gateway → ElevenLabs | ElevenLabs API key |

**naiaKey routing:** TTS auth is independent of LLM provider selection. `ChatRequest` carries `naiaKey` as top-level field.

**Settings UI:** TTS provider dropdown + API key input + voice picker (auto-discovery from registry).

**Pricing:** Edge (Free) | Naia Cloud (actual cost from gateway `cost_usd`) | Google (voice tier: Neural2/Wavenet $16/1M, Standard $4/1M, Chirp3-HD $16/1M) | OpenAI ($15/1M chars) | ElevenLabs ($0.30/1K chars)

**Cost tracking:** Naia Cloud returns actual `cost_usd` from gateway → Shell uses server cost directly. Direct API providers (Google/OpenAI/ElevenLabs) use client-side estimation via `estimateTtsCost(provider, length, voice)`. Agent `TtsSynthesizeResult` carries `{ audio, costUsd? }` through the pipeline.

**STT cost tracking:** `estimateSttCost()` per API call → stored in `sessionCostEntries[]` via `addSessionCostEntry()`. Shown in CostDashboard breakdown by provider/model (e.g. `stt:nextain`). Not attached to messages (avoids overwriting LLM token data on assistant messages).

**Dynamic voices:** Google and ElevenLabs support runtime voice fetching via API when API key is provided.

---

### Voice E2E Tests (97 tests: 87 Tauri + 10 Playwright)

E2E = actual app UI. Every test launches real Tauri app, types API keys in input fields, clicks buttons, sends chat messages, and verifies results. Never mocks API calls — uses real `.env` keys.

| Spec | Tests | Coverage |
|------|-------|----------|
| `76-tts-provider-switching` | 12 | TTS dropdown, API key, voice, Edge preview |
| `77-stt-provider-switching` | 7 | STT dropdown, order free→Naia→paid, API key |
| `78-voice-pipeline-mode` | 11 | UI labels, voice picker, button states, 🗣️ icon |
| `79-pipeline-voice-activation` | 9 | Voice button lifecycle, CSS 3-state |
| `80-tts-preview-all-providers` | 5 | Real API key preview: Edge/OpenAI/Google/ElevenLabs |
| `81-chat-tts-response` | 9 | Chat → AI response → TTS audio playback |
| `82-chat-tts-multi-model` | 6 | Model switching preserves TTS |
| `83-tts-per-model-verification` | 15 | 5 LLM providers × model: chat + TTS |
| `84-chat-tts-per-provider` | 12 | 4 TTS providers: UI key input → save → chat → verify |
| `pipeline-voice` (Playwright) | 10 | STT mock → LLM → TTS, debounce, interrupt, Whisper |

```bash
cd shell && source ../my-envs/naia-os-shell.env
npx wdio run e2e-tauri/wdio.conf.ts --spec e2e-tauri/specs/80-tts-preview-all-providers.spec.ts
npx wdio run e2e-tauri/wdio.conf.ts --spec e2e-tauri/specs/84-chat-tts-per-provider.spec.ts
npx wdio run e2e-tauri/wdio.conf.ts --spec e2e-tauri/specs/83-tts-per-model-verification.spec.ts
npx playwright test e2e/pipeline-voice.spec.ts
```

---

### Pipeline Voice (STT → LLM → TTS)

Voice conversation for standard (non-omni) LLM models via independent STT → LLM → TTS pipeline.

**Architecture:**
```
User speaks → STT provider (Vosk/Whisper) → recognized text
→ sendChatMessage (normal LLM path, tools disabled)
→ LLM text stream → SentenceChunker (sentence boundary detection)
→ per-sentence tts_request → TTS provider (Edge default)
→ MP3 base64 → AudioQueue (sequential playback)
```

| Component | File | Role |
|-----------|------|------|
| SentenceChunker | `voice/sentence-chunker.ts` | Korean+English sentence splitting (min 10, max 120 chars) |
| AudioQueue | `voice/audio-queue.ts` | Sequential MP3 playback, interrupt, avatar speaking state |
| TTS request | `agent/src/index.ts`, `chat-service.ts` | Per-sentence TTS synthesis |

**State flow:** LISTENING → PROCESSING → SPEAKING → LISTENING
**Interrupt:** User speech during playback clears AudioQueue + cancels LLM stream
**Rules:** Tools disabled, Agent auto-TTS disabled, emotion tags stripped

---

### Voice Gender Defaults

Default voice is automatically set based on VRM avatar gender:
- VRM models 1,3 (female) → liveVoice: "Kore", Edge TTS: "ko-KR-SunHiNeural", Google TTS: "ko-KR-Neural2-A"
- VRM models 2,4 (male) → liveVoice: "Puck", Edge TTS: "ko-KR-InJoonNeural", Google TTS: "ko-KR-Neural2-C"

### Billing

- **Omni models:** Varies by provider (Gemini: $0.10/M input + $0.40/M output, OpenAI: ~$0.10/min)
- **TTS:** Varies by provider (Chirp 3 HD, Neural2, Edge free, OpenAI, ElevenLabs)

#### Voice Tools (from Panel Registry)

> Added: 2026-03-20 (#95)

When starting a voice session, `ChatPanel` reads the active panel's tools from `panelRegistry` and passes them to `session.connect()`. Without this, Gemini Live says "tools are disabled" even when `config.enableTools=true`.

```tsx
const panelTools = panelRegistry.get(activePanelId)?.tools ?? [];
const voiceTools = panelTools.map((t) => ({ name, description, parameters }));
await session.connect({ tools: voiceTools, systemInstruction: voiceSystemPrompt });
```

The system prompt is also augmented with an explicit tool list and "call them proactively" instruction.

---

## Workspace Panel (#119, 2026-03-23)

Built-in panel for Claude Code session monitoring and PTY terminal tabs. Always keepAlive mounted.

### Tools

| Tool | Tier | Description |
|------|------|-------------|
| `skill_workspace_get_sessions` | 0 (auto) | All session statuses |
| `skill_workspace_open_file` | 1 (notify) | Open file in editor |
| `skill_workspace_focus_session` | 1 (notify) | Scroll + highlight session card |
| `skill_workspace_new_session` | 2 (confirm) | Spawn bash PTY, open terminal tab |
| `skill_workspace_classify_dirs` | 0 (auto) | Classify ~/dev subdirs |

### PTY Terminal

- **Rust**: `shell/src-tauri/src/pty.rs` — portable-pty 0.9.0; commands: `pty_create`, `pty_write`, `pty_resize`, `pty_kill`
- **Frontend**: `Terminal.tsx` — `@xterm/xterm` + `@xterm/addon-fit`
- **Events**: `pty:output:{pty_id}` / `pty:exit:{pty_id}` (Tauri events from Rust)
- **Dedup**: `openDirsRef` (`Set<string>`) — add dir **before** `await pty_create`; delete only on failure or tab close
- **keepAlive**: `opacity:0 + pointerEvents:none` (NOT `display:none` — FitAddon breaks on hidden elements)

---

## Browser Panel — WebView2 Embed (#95, #249)

*Updated 2026-05-07: migrated from Win32 SetParent to Tauri WebView2 child window.*

The browser panel is a **keepAlive** panel (always mounted, hidden via `opacity:0 + pointerEvents:none`).

**Embedding per platform:**

| Platform | Method |
|----------|--------|
| **Linux** | X11 `XReparentWindow` via x11rb (`platform/linux.rs` → `X11WindowManager`) |
| **Windows** | Tauri WebView2 child window (`browser_webview.rs`) — `browser_wv_create/navigate/hide/show/resize` + full browser control suite IPC |
| **macOS** | Not yet implemented |

**Windows WebView2 IPC commands** (`browser_webview.rs`):

| Command | Purpose |
|---------|---------|
| `browser_wv_create` | Create WebView2 child at LogicalPosition + LogicalSize |
| `browser_wv_navigate` | Navigate to URL |
| `browser_wv_hide` | Hide overlay (called before modal `set()` to prevent 1-frame overlap) |
| `browser_wv_show` | Show overlay |
| `browser_wv_resize` | Resize to match viewport div |

> ⚠️ **`setPendingApproval` order**: `invoke("browser_wv_hide")` MUST come before `set({ pendingApproval })` — otherwise Chrome overlay stays on top of the approval modal for one React render frame.

Chrome discovery: Linux = `which` + Flatpak, Windows = `where.exe` + Program Files.

AI tools: navigate, back, forward, reload, click, fill, scroll, press, snapshot, get_text, screenshot, eval + **`skill_tab_screenshot`** (via tab-skills — captures native WebView2 content via GDI BitBlt).

---

## Panel System — Iframe Bridge (#98, 2026-03-23)

Installed panels can be iframe-based (have `index.html`). The iframe bridge gives these panels access to Shell services via `postMessage`.

### Files

| File | Role |
|------|------|
| `shell/src/lib/iframe-bridge.ts` | Shell-side postMessage server (`startIframeBridge`) |
| `shell/src/lib/naia-bridge-client.ts` | Panel-side client wrapper (`NaiaBridgeClient` class) |
| `shell/src/lib/behavior-log.ts` | IndexedDB behavior log (`naia_behavior`, 30-day purge) |

### Bridge Messages

| Type | Handler |
|------|---------|
| `naia-bridge:logBehavior` | Shell IndexedDB (panelId-scoped) |
| `naia-bridge:queryBehavior` | Shell IndexedDB read (panelId forced — panel can't query others) |
| `naia-bridge:getSecret` | secure-store.ts key `panel:{panelId}:{key}` |
| `naia-bridge:setSecret` | secure-store.ts key `panel:{panelId}:{key}` |
| `naia-bridge:readFile` | Tauri `panel_read_file` (HOME-restricted, 1 MB) |
| `naia-bridge:runShell` | Tauri `panel_run_shell` (allowlist) |

### Security Model

- **Origin guard**: `event.origin === 'http://asset.localhost'` only
- **`__unknown__` block**: panelId unresolvable → all operations denied
- **panelId source**: regex `/\/([^/]+)\/index\.html(?:[?#].*)?$/` on `iframe.src`
- **Namespacing**: getSecret/setSecret keys `panel:{panelId}:{key}` — cross-panel isolation
- **Respond targetOrigin**: Shell responds to iframe via `postMessage(data, ALLOWED_ORIGIN)` — `ALLOWED_ORIGIN = "http://asset.localhost"` (iframe origin)
- **`"*"` targetOrigin**: Panel sends requests with `window.parent.postMessage(req, "*")` — `window.parent.origin` throws SecurityError cross-origin. Shell validates `event.origin` on receipt.

### Tauri Commands (panel.rs)

| Command | Security |
|---------|---------|
| `panel_read_file` | `canonicalize()` + HOME boundary + 1 MB limit |
| `panel_run_shell` | SHELL_CMD_MAP allowlist (absolute `/usr/bin/` paths) + arg metachar/separator/traversal filter |
| `panel_remove_installed` | panelId validation + `canonicalize()` + HOME boundary before `remove_dir_all` |

### NaiaContextBridge Integration

`NaiaContextBridge` interface in `panel-registry.ts` — 6 methods:
- `ActivePanelBridge` — full implementation; `NoopContextBridge` — stub for panels without bridge support
- `getBridgeForPanel(panelId)` factory in `active-bridge.ts` returns cached `ActivePanelBridge`
- All panels (keepAlive + non-keepAlive) receive per-panel bridge instance via `App.tsx`

---

## BGM Context Architecture

> Verified 2026-05-19 via cross-review (3 reviewers). Issues: [#304](../../issues/304), [#307](../../issues/307), [#308](../../issues/308)

Three distinct paths exist for BGM awareness — only the memory bridge is pending implementation.

### Existing Paths

#### 1. `pushContext` — Real-time LLM Awareness
```
BgmPlayer.tsx:198  naia.pushContext({type:"bgm", data:{videoId, title, channel, playing}})
  → ActivePanelBridge.pushContext() [panel-registry.ts:147]
  → usePanelStore.setActivePanelContext() [panel.ts:52]  ← Zustand, session-only
  → next ChatRequest → buildSystemPrompt() [persona.ts:195]
  → LLM system prompt: "Active panel: bgm\nPanel context: {...}"
```
**Scope**: LLM knows what's playing *right now*. Session-only. Cleared on panel switch. NOT memory.

#### 2. AI Interference — Auto-speech Trigger
```
BgmPlayer.tsx  emitAiInterferenceEvent({source:"bgm", action:"music_changed"})
  → aiInterferenceEnabled gate [panel.ts:71, default=false]
  → 15s cooldown [ai-interference.ts:14]
  → DOM CustomEvent → ChatPanel.onAiInterferenceEvent → handleSend → agent
```
**Scope**: AI auto-speaks on music change. Dropped when gate off or within cooldown. NOT memory.

### Gap → Design Decision (#304)

Neither path reaches `naia-memory`. BGM preference is never long-term stored.

**Chosen: Option C — Stdin Direct Channel**

| Option | Rejected Reason |
|--------|----------------|
| A (File Log) | Shutdown race with `memorySystem.close()` [index.ts:1380] |
| B (localStorage) | Node.js agent process cannot access browser localStorage |
| **C (Stdin)** | ✅ Fits existing stdio protocol, consistent with fire-and-forget pattern |

```
BgmPlayer  →  Tauri IPC  →  agent stdin {type:"bgm_event"}
  →  memoryProvider.encode() [fire-and-forget]   ← NOT memorySystem.encode() directly
                                                   (bypasses MemoryProvider contract)
```

**Key decisions**:
- Memory logging **bypasses** `aiInterferenceEnabled` — memory ≠ AI speech (separate concerns)
- API: `memoryProvider.encode()` via `memory-bridge.ts`, not `memorySystem.encode()` directly
- Timing: real-time fire-and-forget matching existing pattern at `agent/src/index.ts:575`

### Browser AI Interference Gaps (#307, #308)

- **#307**: Browser internal navigation URL not forwarded to Shell — WebView2 `NavigationCompleted` events not emitted as Tauri events from `browser_webview.rs`
- **#308**: AI interference events from browser only report panel activation, not navigated URL. Depends on #307.
