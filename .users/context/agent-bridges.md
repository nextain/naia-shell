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

## Authentication flow (v2 — issue #337, 2026-05-28)

> Older `auth_update` IPC flow described below under "Legacy auth_update" for
> historical reference. The standalone naia-agent runtime (dev/prod default)
> uses the v2 flow exclusively.

**Runtime selection** — shell `spawn_agent_core` (`shell/src-tauri/src/lib.rs`)
resolves the agent binary in this order:

1. `NAIA_AGENT_STANDALONE_PATH` env override
2. `resources/agent-standalone/dist/index.js` (bundled standalone)
3. `../../naia-agent/bin/naia-agent.ts` (dev TypeScript, auto-activated)
4. `../agent/src/index.ts` (embedded, legacy)
5. `agent/dist/index.js` (bundled embedded, legacy)

In dev mode condition 3 fires and the standalone `naia-agent` repo carries
the auth code, so the embedded `naia-os/agent/dist` is irrelevant for login.

**Credential ownership** — `naia-agent` owns the naiaKey end-to-end. The shell
never reads or writes the key after Phase 6c (commit `c44fdd6c`); it only
forwards the raw `naia://` deep-link URL to the agent for parsing.

**Encrypted persistence** — `<NAIA_ADK_PATH>/naia-settings/auth/{dev,prod}.json.enc`
- Cipher: AES-256-GCM via `crypto-envelope` (magic `NAIA`, salt 16 / nonce 12 / authTag 16)
- Master key: OS keyring (service `io.nextain.naia`, account `auth-master-v1`)
  via the keyring abstraction (Windows DPAPI / macOS Keychain / Linux secret-tool
  + headless degraded mode)
- Atomic write: `.tmp` + rename. Per-mode RW lock keeps dev/prod independent.

**IPC surface** (all dispatched in `naia-agent/bin/naia-agent.ts:1603-1700`):

| Type | Direction | Purpose |
|---|---|---|
| `auth_start` | shell → agent | Returns `{ authUrl, state }`. Agent generates 64-hex state token, stores in 5-min TTL in-memory `stateMap`. authUrl includes `state`, `app=naia-os`, `redirect=desktop`, `source=desktop`, `platform`, `scope?`. |
| `auth_received` | shell → agent | Raw `deepLinkUrl` forwarded. Agent parses, validates state in map, saves encrypted file, emits `auth_changed loggedIn:true`. Response **never** includes naiaKey. |
| `auth_query` | shell → agent | Returns `{ loggedIn, expiresAt?, userId?, scope? }`. Powers the tri-state badge. |
| `auth_logout` | shell → agent | Deletes encrypted file, emits `auth_changed loggedIn:false`. |
| `auth_legacy_migrate` | shell → agent | Phase 8 one-shot. Seeds encrypted file from legacy `secure-keys.dat:naiaKey`. Hard-fail on ack failure. |
| `lab_proxy_request` | shell → agent | Shell **never** holds the naiaKey. Agent reads from encrypted file, injects `X-AnyLLM-Key: Bearer …`, returns upstream body. 401 triggers single-flight refresh + retry. **Path-prefix routing** (2026-05-28): `/v1/*` → mode-mapped Lab Gateway origin, everything else → portal issuer. Absolute URLs accepted only when origin matches issuer OR mode-mapped gateway; anything else → `disallowed_host`. |
| `auth_changed` | agent → shell push | `{ mode, loggedIn }` on save/delete. |
| `auth_expired` | agent → shell push | `{ mode, reason: "refresh_failed" \| "revoked" }`. |

**OAuth URL composition** (`naia-agent/packages/runtime/src/utils/oauth-flow.ts:118`):

```
{issuer}/{locale}/login
  ?state={64-hex-csrf}
  &app=naia-os
  &platform={win32|darwin|linux}
  &redirect=desktop
  &source=desktop
  &scope={csv}?
```

`issuer` is `http://localhost:3001` in dev (local naia.nextain.io dev server)
and `https://naia.nextain.io` in prod.

**Cross-repo coupling — portal middleware**
(`projects/naia.nextain.io/src/proxy.ts`):

- Requires **BOTH** `redirect=desktop` **AND** `app=naia-os` to enter the
  desktop-auth branch. Earlier OR semantics allowed crafted phishing links to
  silently trigger the desktop flow on any authenticated user.
- On match: redirects to `/{lang}/callback` **forwarding all original query
  params** so `state` survives. Skip list: `source` (normalized), `callbackUrl`
  (already handled by SSO open-redirect guard), `redirect`, `app`.
- `state` is format-validated against `/^[0-9a-f]{64}$/` before forwarding,
  blocking attacker pre-population of arbitrary state values.

Without this contract the callback page receives a `null` `state`,
`buildNaiaAuthDeepLink` omits the state param, and the agent's
`receiveOAuthDeepLink` rejects with `missing_state` — exactly the "login
appears to hang" symptom diagnosed on 2026-05-28.

**State token (CSRF)** — in-memory only (`oauth-flow.ts:92 stateMap`):
- 32 random bytes → 64-char hex
- 5-minute TTL
- Single-use: deleted on receive **before** TTL check
- Bound to `mode`, `issuer`, `scope`
- Agent crash forces re-login (state lost)

**Shell UI** — tri-state badge `checking / logged_in / logged_out` driven by
`useAuthStatus` consuming `onAgentAuthChanged`. No optimistic render — boot SLA
target <200 ms p95 from agent process spawn. Error surfacing on
`auth_received ok:false` is currently warn-log only (`App.tsx:559`); UI banner
is a deferred hygiene follow-up.

**Known risks** (documented for future hardening):

- `NAIA_ADK_PATH` poisoning (attacker-controlled env var → wrong storage dir)
- OS keyring as single point of failure (macOS unlocked Keychain, Linux DBUS
  exposure, Windows DPAPI per-user only)
- No TPM / Secure Enclave hardware binding (deferred follow-up, #337 §6)
- Forensic log buffer (`oauth-flow.ts:96-112`) records full 64-hex state on
  start events. Subscribers via `onOAuthLog` see plaintext — defense-in-depth
  truncation pending

### Legacy auth_update (pre-#337, embedded agent only)

The pre-#337 flow used a single `auth_update` IPC; the shell read the key from
`secure-keys.dat` on startup and pushed it to the agent's module-scope
`_agentNaiaKey` cache:

```ts
agent.write({ type: "auth_update", naiaKey: "gw-..." });
```

This path lives on in `naia-os/agent/src/index.ts` for backward compatibility
but is bypassed in dev mode (the standalone runtime takes priority — see the
spawn resolution order above). Cold clones of `naia-os` without the
`naia-agent` sibling repo still hit this path; treat the legacy code as
maintenance-only.

## Creds update flow (#260 follow-up, 2026-05-12)

ALL per-session credentials travel via the single `creds_update` message —
LLM API keys, TTS API keys, gateway WS token. Same one-shot pattern as
`auth_update` (naiaKey) and `notify_config` (webhooks). Per-request frames
no longer carry credentials at all.

```ts
// shell side — once at startup + once per settings save
sendCredsUpdate({
  keys: {
    anthropic: "sk-ant-...",
    openai:    "sk-...",
    gemini:    "AIza...",
  },
  ttsKeys: {           // optional
    google:     "AIza...",
    openai:     "sk-...",
    elevenlabs: "el-...",
  },
  gatewayToken: "gw-token-...",  // optional
  // empty string for any entry clears the agent-side cached value
});

// agent side
handleCredsUpdate(req) {
  // keys[provider]     → setProviderApiKey → _providerApiKeys Map
  // ttsKeys[provider]  → setTtsApiKey      → _ttsApiKeys Map
  // gatewayToken       → setGatewayToken   → _gatewayToken
}
```

Schema-level enforcement:

- `SendChatOptions` no longer accepts `ttsApiKey` or `gatewayToken` (compile-time block).
- `directToolCall` opts no longer accept `gatewayToken` (compile-time block).
- shell builders strip `provider.apiKey` + `provider.naiaKey` from the chat_request payload before invoking `send_to_agent_command`.
- `ProviderConfig.apiKey` on the agent is `@deprecated` optional — buildProvider still has it as a backwards-compat fallback, but the official shell no longer populates it.

Agent resolution priority (per credential):

| Type | Lookup |
|---|---|
| LLM api key | `_providerApiKeys.get(provider)` → `config.apiKey` (deprecated) → envVar |
| TTS api key | `_ttsApiKeys.get(provider)` (req.ttsApiKey is deprecated, kept for legacy) |
| Gateway token | `_gatewayToken` (req.gatewayToken kept as `??` fallback for backwards compat) |

## Observability — log SoT + AI self-diagnosis

> **For AI agents working in this project**: when investigating runtime
> symptoms, **read the log files directly**. Do not ask the user to paste
> them. The user takes actions in the app; the AI observes state in logs.

### Log files (Single Source of Truth)

All Tauri-side and agent-side logs live under `$HOME/.naia/logs/`
(`%USERPROFILE%\.naia\logs\` on Windows — e.g. `C:\Users\<user>\.naia\logs\`).

| File | Owner | Read this when |
|---|---|---|
| `naia.log` | Rust shell | Session lifecycle, deep-link receive, agent spawn, gateway sync |
| `agent-stderr.log` | naia-agent stderr | **Any IPC timeout** — agent may have crashed during import |
| `node-host.log` | Legacy openclaw (inert post-#201) | Rarely useful now |
| `gateway.log` | Legacy Naia Gateway (removed #201) | Inert |
| `bgm-server-stderr.log` | BGM tsx subprocess | Audio loop errors |
| `llm-debug.log` | LLM client (`NAIA_LLM_DEBUG=1` only) | Detailed request/response when opted in |

### Decision tree — common symptoms

**Symptom: `agent-ipc timeout: <responseType>` in DevTools or `naia.log`**

1. Read tail of `agent-stderr.log`. `SyntaxError` or unhandled error means
   the agent crashed during module import. Most common cause: the runtime
   `dist/` is out of sync with `src/`. Fix:
   ```bash
   cd projects/naia-agent && pnpm exec tsc --build packages/runtime
   ```
2. Read tail of `naia.log`. Confirm `agent-core started` AND no immediate
   `Session ended` follow-up.
3. If the agent is alive but every IPC times out: keyring bootstrap on
   Windows. Verify `await prewarmKeyring()` is called BEFORE the `ready`
   signal in `bin/naia-agent.ts:runStdio()`.
4. Probe stdio directly. Don't wait for the user. See **probe recipe** below.

**Symptom: Lab login hangs — system browser opens but app never reaches `logged_in`**

1. `naia.log` — look for `Deep link received`. If absent, the portal
   redirect didn't fire OR the `naia://` scheme isn't registered.
2. Verify portal middleware (`projects/naia.nextain.io/src/proxy.ts`)
   forwards the `state` query param. After the 2026-05-28 fix this is
   mandatory; older deploys silently drop it.
3. `agent-stderr.log` — look for `receiveOAuthDeepLink` reject reasons
   (`missing_state` / `unknown_state` / `expired_state`).
4. Inspect `<NAIA_ADK_PATH>/naia-settings/auth/{mode}.json.enc` to verify
   `saveAuth` actually completed.

**Symptom: chat returns `no LLM provider configured`**

1. `naia.log` — confirm `sendCredsUpdate` emit fired on mount.
2. `agent-stderr.log` — look for credential parse failures.
3. Inspect `AppConfig.provider` / `AppConfig.model` (shell `config.ts`).

### Probe recipe — direct stdio without the Tauri shell

```bash
cd projects/naia-agent
node -e "
const { spawn } = require('child_process');
const child = spawn('node',
  ['node_modules/tsx/dist/cli.mjs', 'bin/naia-agent.ts', '--stdio'],
  { env: { ...process.env, NAIA_ADK_PATH: '<your-adk-path>',
           NAIA_AGENT_MODE: 'dev' },
    stdio: ['pipe','pipe','pipe'] });
let buf = '';
child.stdout.on('data', d => {
  buf += d.toString();
  for (const line of buf.split(/\r?\n/).slice(0,-1)) {
    try {
      const j = JSON.parse(line);
      if (j.type === 'ready') {
        child.stdin.write(JSON.stringify({type:'auth_query',id:'p1',mode:'dev'})+'\n');
      } else if (j.type === 'auth_query_response') {
        console.log(JSON.stringify(j));
        child.kill(); process.exit(0);
      }
    } catch {}
  }
  buf = buf.split(/\r?\n/).slice(-1)[0];
});
setTimeout(() => process.exit(1), 60000);
"
```

Expected on Windows: `ready` within ~10s (keyring pre-warm) followed by
`auth_query_response` in <5ms. Anything slower is a machine-specific issue.

### Anti-patterns

- **Don't ask the user to paste a log** — read `agent-stderr.log` directly.
- **Don't assume IPC wiring is broken from a single timeout** — verify the
  agent is alive in `agent-stderr.log` first.
- **Don't increase shell timeouts past 60s** without investigating WHY the
  agent is slow. There is always a real cause (build artifact, keyring,
  filesystem). The current `KEYRING_IPC_TIMEOUT_MS = 45_000` exists only
  to cover the worst-case Windows first-boot keyring bootstrap.

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

Done since this table was first written (2026-05-12):

- **#277** — runtime asset scope extension. `protocol-asset` Cargo feature enabled, `assetProtocol.enable: true` in config, `copy_bundled_assets` calls `app_handle.asset_protocol_scope().allow_directory(adk_path, true)`. Non-standard ADK paths (`/mnt/external`, `/opt/custom`, `D:\custom\naia`) now serve assets correctly.
- **`creds_update` LLM keys** — `provider.apiKey` flows once via `creds_update.keys`.
- **`creds_update` ttsKeys + gatewayToken** — same message extended to carry TTS provider keys and Naia Gateway WS token. `SendChatOptions` / `directToolCall` opts no longer accept these fields (compile-time block). All shell callsites cleaned (ChatPanel / SettingsTab / AgentsTab / SkillsTab / DiagnosticsTab / discord-relay).

Still pending:

- Drop `ProviderConfig.apiKey` from agent types entirely (currently `@deprecated` optional). Coordinate with any out-of-tree forks first.

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
