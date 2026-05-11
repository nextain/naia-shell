# Agent Bridges

Source-of-truth for the shell ↔ naia-agent ↔ naia-memory wire after the
[issue #272](https://github.com/nextain/naia-os/issues/272) reconcile.

> Korean mirror: [`ko/agent-bridges.md`](./ko/agent-bridges.md)
> AI-optimized contract: [`.agents/context/agent-bridges.yaml`](../../.agents/context/agent-bridges.yaml)

## Why this exists

After `#201` removed the OpenClaw gateway daemon, the Tauri shell, the
embedded naia-agent process, and naia-memory R4 all coordinate through stdio
JSON. Three bridges + five strangler-fig provider adapters carry the load.

## The three bridges

### 1. Protocol bridge — `agent/src/protocol-bridge.ts`

StdioFrame v1 envelope codec. Wraps legacy flat JSON into a typed envelope so
a single stdio reader can multiplex many request types.

| Function | Purpose |
|----------|---------|
| `looksLikeFrame(line)` | Cheap pre-check before JSON parse |
| `unwrapFrame(line)` | Decode envelope → `{ type, payload }` or `null` |

**Activation**: off by default. `NAIA_PROTOCOL_ENVELOPE_ONLY=1` rejects all
legacy flat frames — opt-in only (shell must be sending envelope first).
Phase 5 wires the shell side.

### 2. Memory bridge — `agent/src/memory-bridge.ts`

Adapter that wraps a naia-memory `MemorySystem` and exposes the
`@nextain/agent-types` `MemoryProvider` interface.

```ts
const memorySystem = buildMemorySystem();              // naia-memory native
const memoryProvider = createNaiaMemoryProvider(       // bridge-wrapped
  memorySystem,
  { defaultProject: "naia-os" }
);
```

| Op | Bridge behavior |
|----|-----------------|
| `encode` | `MemoryInput.context` (`Record<string,string>`) ↔ naia-memory `MemoryInput.context` (single string). `scoring` key maps to the string; `project/sessionId/activeFile` become `EncodingContext`. |
| `recall` | Returns `MemoryHit[]` (facts + episodes merged, sorted by normalized score, capped at `topK`). |
| `sessionRecall` | Pass-through to naia-memory `MemorySystem.sessionRecall`. |

**Paired lifecycle.** Both `memorySystem` and `memoryProvider` are module-scope
`let` bindings. `handleAuthUpdate` rebuilds both atomically so naia embedding +
fact extractor pick up the new key:

```ts
const old = memorySystem;
memorySystem = buildMemorySystem();
memorySystem.startConsolidation();
memoryProvider = createNaiaMemoryProvider(memorySystem, { defaultProject: "naia-os" });
void old.close().catch((err) => console.error(`[agent:memory] ...`));
```

**Race caveat**: in-flight fire-and-forget `memoryProvider.encode(...)` during
`auth_update` may land on the OLD `MemorySystem`. Errors are now logged
(was silent — #272 adversarial F4 fix). A full drain barrier is a follow-up.

### 3. Approval bridge — `agent/src/approval-bridge.ts`

IPC approval broker. Currently declared inert (`void approvalBridge;`) at
`agent/src/index.ts`. Phase 5 Day 6.3 will replace the `pendingApprovals` Map +
`waitForApproval` pattern with `approvalBridge.decide()`. Compile-time presence
keeps the import surface stable for downstream tests.

## The five strangler-fig provider adapters

Native LLM providers are preserved. A parallel `@nextain/agent-providers`
adapter is added per family. Routing decision is per-call:

- `NEXTAIN_AGENT_PROVIDERS=1` → all families external
- `NEXTAIN_<FAMILY>=1` → only that family external
- unset → native (zero-risk default)
- Truthy values: `1` / `true` / `yes` / `on` (case-insensitive)

| File | Coverage |
|------|----------|
| `nextain-openai-adapter.ts` | OpenAI / Ollama / vLLM / xAI / zai (OpenAI-compat family) |
| `nextain-gemini-adapter.ts` | Google Gemini full SDK (`thoughtSignature` parity) |
| `nextain-claude-cli-adapter.ts` | Claude Code CLI subprocess |
| `nextain-lab-proxy-adapter.ts` | Naia Lab Proxy SSE (chat completions) |
| `nextain-lab-proxy-live-adapter.ts` | Naia Lab Proxy WebSocket (Live API, `-live` model suffix) |

### Detection helpers

Exported from `agent/src/providers/factory.ts` — tests must import these
directly, never duplicate the regex:

- `isOmni(model)` — vllm-omni audio-inline detector
- `isLive(model)` — Lab-proxy `-live` suffix detector

**Omni intent**: audio-bearing models (`gpt-4o`, `minicpm-o`, `qwen-vl-omni` …)
stay on the native path even with `NEXTAIN_VLLM=1`. #272 dropped a broad
`/[-_]o\b/i` fallback that misclassified `claude-opus-4-o`, `gemma-4-o`.

## Authentication flow

The agent owns the credential. Shell sends `auth_update` once; per-request
configs never carry `naiaKey`.

```ts
// shell side
agent.write({ type: "auth_update", naiaKey: "gw-..." });

// agent side (factory.ts)
let _agentNaiaKey: string | undefined;
export function setAgentNaiaKey(key: string): void { _agentNaiaKey = key; }

// per-request
export function buildProvider(config: ProviderConfig): LLMProvider {
  const naiaKey = _agentNaiaKey;
  if (naiaKey) return /* lab-proxy route */;
  return /* native or env-gated strangler-fig */;
}
```

Test discipline: seed with `setAgentNaiaKey("gw-...")` in `beforeEach` and
clear in `afterEach`. The removed `config.naiaKey` field is a footgun — tests
that still pass it silently take the fall-through path.

## Notify config flow (#260)

Webhook URLs + Discord defaults travel via `notify_config`, not per-request.

```ts
// shell side — once at startup + once per settings save
sendNotifyConfig({
  slackWebhookUrl,
  discordWebhookUrl,
  googleChatWebhookUrl,
  discordDefaultUserId,
  discordDefaultTarget,
  discordDmChannelId,
});

// agent side (index.ts)
handleNotifyConfig(req) → applyNotifyWebhookEnv(...) // writes process.env
```

`applyNotifyWebhookEnv` semantics:
- `undefined` field → preserve existing env (partial update / first startup)
- empty string → delete env (user erased the textbox = explicit unset)
- non-empty → write

Per-request `chat_request` / `tool_request` frames MUST NOT carry these
fields. For backwards-compat they stay declared optional on the request
types, but the shell never populates them.

Closes the credential leak in #260: webhook URLs no longer appear in every
LLM turn's stdio frame (logs, crash dumps, malicious npm wrappers).

## Security hardening (post-#256-#260 + follow-ups)

Five P0-critical fixes landed 2026-05-12 from the adversarial review:

| Issue | Where | What |
|---|---|---|
| #256 | `agent/src/index.ts` `handleToolRequest` | `needsApproval(toolName)` gate before `executeTool` (unmapped tools default to Tier 2). Mirrors LLM-loop gate at L759/L834. |
| #257 | `agent/src/skills/built-in/panel.ts` `actionInstall` | `source` must start with `https://` — `file://` / `http://` / `git@` / `data:` / `javascript:` / bare paths rejected. Local-zip unzip fallback removed. |
| #258 | `shell/src-tauri/tauri.conf.json` `assetProtocol.scope` | Full FsScope object with explicit allow list + `requireLiteralLeadingDot: true`. Bare `**` / drive-roots / bare `/tmp/**` removed. Follow-up: #277 (runtime scope extension). |
| #259 | `shell/src-tauri/tauri.conf.json` `csp.connect-src` | `discord.com` removed. All Discord API via Rust `invoke('discord_api', ...)`. |
| #260 | New `notify_config` msg type | Webhook URLs off per-request stdio (see "Notify config flow" above). |
| #248 | `shell/src/lib/llm/registry.ts` + `agent/src/providers/lab-proxy.ts` | Gateway GCP project lacks Vertex access to gemini-3.x — drop from Naia provider picker, fix `gemini-3.1-flash-live-preview` fallback, accurate 0-byte SSE error. Saved-config migration via `shouldMigrateNextainModel`. |
| #254 | `shell/src-tauri/tauri.conf.json` + `App.tsx` `useAppReady` | `windows[0].backgroundColor: [6, 13, 20, 255]` for cold-start flash; `useAppReady` treats `showOnboarding` symmetrically to `showAdkSetup` to avoid 5 s splash deadlock. |

Pending: `provider.apiKey` is STILL per-`chat_request`. Same pattern as
`notify_config` can move it to a one-shot `creds_update` message + drop
from `ChatRequest` schema.

## Vendored packages

| File | Purpose |
|------|---------|
| `agent/vendor/nextain-agent-protocol-0.1.0.tgz` | Envelope protocol contract |
| `agent/vendor/nextain-agent-providers-0.1.0.tgz` | Strangler-fig adapters |
| `agent/vendor/nextain-agent-types-0.1.0.tgz` | `MemoryProvider` / `ApprovalRequest` / etc. |

Vendored because these private Nextain packages aren't on npm. Update flow:
replace the tgz + bump the version pin in `agent/package.json`.

## Cross-repo dependencies

| Repo | Required exports | Pin |
|------|------------------|-----|
| `naia-memory` | `MemorySystem`, `LocalAdapter`, embedding providers, `buildLLMFactExtractor`, **`HeuristicContradictionFilter`** (added #272) | alpha-adk submodule |
| `naia-adk/packages/skills-builtin` | Full 23-skill catalog (Phase 4.0 Day 3-7 via #273 + OpenClaw port via #274) + `ALL_DESCRIPTORS` enumeration. Tier distribution: 8 T0 / 13 T1 / 2 T2. | file:path |
| `naia-adk/packages/openclaw-compat` | OpenClaw → naia migration tool (CLI `naia-openclaw-migrate`). Parses OpenClaw `SKILL.md` frontmatter into `SkillDescriptor`. Landed via #275. | file:path (standalone, not imported by naia-os agent) |
| `@nextain/agent-types` (vendored) | Bridge contract types | tgz in `agent/vendor/` |

## What's deferred

- Phase 4.3 Day 6.2-6.4: 18-skill envelope wire, IpcApprovalBroker direct wire, `handleChatRequest` decomposition (1276 → ~300 LOC)
- Phase 4.4 Day 7.3: Claude-CLI Flatpak/Windows subprocess + partial-JSON
- `auth_update` drain barrier (currently errors logged; full barrier needs ref-counted ops)
- `approvalBridge` wire-in (currently inert)
- Remaining 9 skill descriptors in `naia-adk/skills-builtin`
