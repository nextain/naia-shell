# Issue #332 — Memory Settings Refactor + Pipeline Verification + E2E

**Status**: design — Phase 1 of Ralph loop  
**Author**: claude (this session) + codex/gemini cross-review pending  
**Last updated**: 2026-05-27

## 1. Current state (audited)

### 1.1 naia-agent — backend integration is solid

`bin/naia-agent.ts` (lines 522-563, `buildCliMemory`):

```ts
function buildCliMemory(args: Args): MemoryProvider {
  if (!args.memory) return new InMemoryMemory();              // ephemeral default
  const d = decideCliMemory(process.env);
  if (d.kind === "ephemeral") return new InMemoryMemory();   // gate failed → graceful
  const embedder = new OpenAICompatEmbeddingProvider(
    d.base, embedKey, d.model, d.dims
  );
  const dbPath = process.env.NAIA_AGENT_MEMORY_DB
    ?? path.join(homedir(), ".naia-agent", "memory", "cli.sqlite");
  return new LiteMemoryProvider({ dbPath, embedder, writesEnabled: true });
}
```

Imports (line 83): `LiteMemoryProvider`, `OpenAICompatEmbeddingProvider`, `SqliteAdapter`, `MemorySystem` from `@nextain/naia-memory`.

Env contract used:
- `NAIA_EMBED_PROVIDER` / `NAIA_EMBED_BASE_URL` / `NAIA_EMBED_MODEL` / `NAIA_EMBED_DIMS` / `NAIA_EMBED_API_KEY`
- `NAIA_AGENT_MEMORY_DB` (override db path)
- `NAIA_ADK_PATH` / `NAIA_SETTINGS_DIR` (resolve embedded role from naia-settings/llm.json)

CLAUDE.md "🧠 Memory Integration (Hardened v6.0)" — Surface 9.74ms, Deep 80ms, 100k facts. **Production-ready**.

### 1.2 naia-os shell — settings surface is a mess

`SettingsTab.tsx:729-770` (state) + `:1983-2018` (writeNaiaConfig payload):

```
12 memory-related useState:
  memoryAdapter:                 local | qdrant
  memoryEmbeddingProvider:       none | offline | ollama | vllm | naia
  memoryOfflineModel:            'all-MiniLM-L6-v2' (only when provider=offline)
  memoryEmbeddingBaseUrl:        ollama/vllm only
  memoryEmbeddingApiKey:         ollama/vllm only
  memoryEmbeddingModel:          ollama/vllm only
  qdrantUrl:                     qdrant adapter only
  qdrantApiKey:                  qdrant adapter only
  memoryLlmProvider:             none | ollama | vllm | naia
  memoryLlmBaseUrl/ApiKey/Model: ollama/vllm only
  backupPassword:                disabled in #327
```

Problems:
1. **Two adapter modes** (`local` / `qdrant`) but the agent only knows `LiteMemoryProvider` (SQLite) — `qdrant` path appears half-wired (no agent-side consumer found).
2. **Two LLM-ish provider rows** (`memoryEmbeddingProvider`, `memoryLlmProvider`) with different valid combos — user has no UI signal on which combos work.
3. **#327 disabled** the backup flow without removing the password input — looks broken even though intentional.
4. **No stats display** — total facts, last decay, surface size are all invisible to the user even though the SQLite stores them.
5. **adk-store.ts mapping**: `buildNaiaConfigEnv` maps `memoryEmbeddingProvider` → `NAIA_EMBED_PROVIDER` only if `ep !== "none" && ep !== "offline"`. So **offline mode never reaches the agent** — confused state.

### 1.3 naia-memory — library is well-spec'd

`naia-memory/GEMINI.md` v6.0:
- Engine: SQLite3 (better-sqlite3) + FTS5 BM25 + sqlite-vec + R-Tree
- Worker thread isolation
- Tier1 (Hot 10k, <25ms target) + Tier2 (Full scan)
- AES-256-GCM encrypted backup
- 100k facts benchmark passed

→ No library work needed. Only host-side wiring.

## 2. Proposed Settings UI redesign

### 2.1 Single source: 3-section layout

```
┌─ 메모리 (Memory) ──────────────────────────────────────────┐
│                                                            │
│  모드 (Mode)                                               │
│  ⦿ Off      — ephemeral, this session only                 │
│  ⦿ Local    — Hardened SQLite v6.0 (recommended)  [default]│
│  ⦾ Cloud    — Qdrant (coming soon — disabled)              │
│                                                            │
│  ── (Local mode 일 때만 표시) ───────────────────────────  │
│  임베딩 (Embedding)                                        │
│  ⦿ Offline (no key) — bundled ONNX `all-MiniLM-L6-v2`      │
│  ⦾ via gateway       — uses your LLM gateway's embed model │
│                        (configured under "LLM" section)    │
│                                                            │
│  통계 (Stats, read-only)                                   │
│    총 facts: 1,234                                         │
│    표면 캐시: 1.2 MB / 25 ms 평균                          │
│    마지막 decay: 2026-05-27 03:14                          │
│                                                            │
│  백업 (Backup)                                             │
│  비밀번호: [_________________]  (AES-256-GCM)              │
│  [내보내기]  [가져오기]                                    │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

### 2.2 State reduction (12 → 4)

```ts
const [memoryMode, setMemoryMode] = useState<"off" | "local" | "cloud">("local");
const [memoryEmbedding, setMemoryEmbedding] = useState<"offline" | "gateway">("offline");
const [backupPassword, setBackupPassword] = useState("");
const [backupStatus, setBackupStatus] = useState<"idle" | "exporting" | "importing" | "done" | "error">("idle");
```

Stats are fetched lazily via IPC (`fetch_memory_stats` new command) — not state, render-time read.

Removed (handled implicitly by the simpler mode):
- `memoryAdapter` — `memoryMode === "cloud"` instead
- `memoryOfflineModel` — fixed to `all-MiniLM-L6-v2` (no UI choice; future advanced panel can override)
- `memoryEmbeddingBaseUrl/ApiKey/Model` — derives from LLM section's "embedded" role
- `memoryLlmProvider/BaseUrl/ApiKey/Model` — same; `embedded` role is the single source
- `qdrantUrl/qdrantApiKey` — deferred until cloud mode actually wires up

### 2.3 adk-store.ts mapping

`buildNaiaConfigEnv` updates:

```ts
// Old: only when provider != none && != offline
if (ep && ep !== "none" && ep !== "offline") {
  out.NAIA_EMBED_PROVIDER = ep; ...
}

// New: always emit if memory is on
if (cfg.memoryMode === "local") {
  if (cfg.memoryEmbedding === "offline") {
    out.NAIA_EMBED_PROVIDER = "offline";
    out.NAIA_EMBED_MODEL = "all-MiniLM-L6-v2";
    out.NAIA_EMBED_DIMS = "384";
  } else {
    out.NAIA_EMBED_PROVIDER = "gateway";   // agent reads embedded role from naia-settings/llm.json
  }
}
```

**Precedence rule (codex cross-review correction)**:

`memoryEmbedding` wins for embeddings. LLM-section settings win only for
chat. The memory choice must be a privacy/cost decision that doesn't
silently inherit from unrelated LLM config.

When `memoryMode=local && memoryEmbedding=gateway`, surface a clear UI
badge "local storage · remote embeddings" so the user sees that data
stays local but query vectors traverse the gateway. Without this badge,
"local mode" becomes a privacy lie.

Agent supports both — `decideCliMemory` reads `NAIA_EMBED_*` first; if
the user chose `gateway`, falls back to `naia-settings/llm.json` embedded
role. If the user chose `offline`, agent uses the bundled ONNX model and
never touches the embedded role, regardless of what LLM section has.

## 3. E2E test plan (TDD-first)

Order matters — each spec gated by the previous:

| ID | Spec file | What it asserts |
|----|-----------|-----------------|
| **S008** (existing) | `08-memory.spec.ts` | encode → recall round-trip same session (regression baseline) |
| **S105** | `30-memory-persistence.spec.ts` | encode → app restart → recall (NEW) |
| **S106** | `31-memory-decay.spec.ts` | facts encoded at t-7d, t-1d, t-0 → recall ranks them in that order (NEW, depends on `applyDecay` running) |
| **S111** | `32-memory-backup.spec.ts` | export + password → wipe → import + same password → fact count and hash match (NEW) |
| **S112** | `33-memory-latency.spec.ts` | Tier1 <25ms, Tier2 <100ms for a fixed corpus (NEW, fixture-replay friendly) |
| **S113** | `34-memory-encoder-fallback.spec.ts` | gateway embed returns 5xx → offline ONNX still encodes (NEW) |
| **S101** | `35-multi-turn-with-memory.spec.ts` | turn 1: "내 이름은 Tester" → turn 2: "내 이름이 뭐였지?" → response mentions "Tester" (NEW) |

All specs use `NAIA_E2E_MOCK_CLONE=1` (from `#328` work) so ADK setup is O(ms), and inject the dev gw key via the secure-store cleanup pattern from L059.

## 4. Manual page

`.users/guides/manual/memory.md`:

```
# Memory

Overview
  - One-line: Naia remembers facts across sessions, recalls them when
    relevant, and gracefully decays old ones.
  - Tech: Hardened SQLite v6.0 with Tier1 (Hot 10k) + Tier2 fallback.

Prerequisites
  - Local mode: no external deps.
  - Cloud mode (Qdrant): not yet available.

Usage
  Settings → 메모리:
    1. Mode 선택 (default Local)
    2. Embedding 선택 (default Offline — works without any API key)
    3. (Optional) Backup password 설정 후 내보내기

Examples
  - 멀티턴: "내 이름은 X" → 다음 턴에 "X" 회상
  - 백업/복원: 새 PC로 옮길 때 backup 사용

Troubleshooting
  - "memory init failed" stderr → ephemeral fallback, log path 보기
  - Backup decryption failed → 비밀번호 재확인 (대소문자 구분)
  - "no facts shown in DiagnosticsTab" → embedder check (gateway 5xx?)
  - sqlite-vec load fail → naia-memory v6.0 installation issue

Related
  - e2e: S008, S105, S106, S111, S112, S113, S101
  - Spec: `projects/naia-memory/GEMINI.md`
  - Agent CLI: `pnpm naia-agent --memory "..."`
```

## 5. Files affected (precise list)

```
shell/src/components/SettingsTab.tsx
  - lines 729-770 (state)           → reduce to 4 useState
  - lines 1983-2018 (writeNaiaConfig) → emit new fields
  - lines 1405/1899/2022 (writeNaiaConfig callers) → unchanged signature
  - lines 1313/3485-3550 (backup UI) → re-enable with new design

shell/src/lib/adk-store.ts
  - buildNaiaConfigEnv (line 156-244) → emit NAIA_EMBED_PROVIDER even for offline

shell/src/lib/config.ts
  - AppConfig type: add memoryMode, memoryEmbedding; deprecate the 12 old fields (keep readers for backwards compat)

shell/src-tauri/src/lib.rs
  - new IPC: fetch_memory_stats → reads naia-settings/.memory/cli.sqlite metadata

shell/e2e-tauri/specs/
  - 30-memory-persistence.spec.ts   (NEW)
  - 31-memory-decay.spec.ts          (NEW)
  - 32-memory-backup.spec.ts         (NEW)
  - 33-memory-latency.spec.ts        (NEW)
  - 34-memory-encoder-fallback.spec.ts (NEW)
  - 35-multi-turn-with-memory.spec.ts  (NEW)
  - 08-memory.spec.ts                (touch — assert new env mapping)

.users/guides/manual/memory.md       (NEW)
.agents/context/e2e-scenarios.yaml   (update — S105/S106/S111/S112/S113/S101 → "implemented")
```

## 6. Migration / backwards compat

- AppConfig: 기존 12 fields는 deprecated 표시. saveConfig는 새 4 fields만 emit. loadConfig는 둘 다 read해서 새 fields로 자동 변환.
- Users with existing local SQLite at `naia-settings/.memory/*.sqlite` 유지.
- Users with qdrantUrl 설정해 둔 경우 — 이번 PR 에서는 "cloud mode coming soon, your old qdrant settings are preserved in legacy fields" 안내.

## 7. Ralph loop phases (TDD order — codex + gemini cross-review integrated)

| Phase | Output | Cross-review |
|-------|--------|--------------|
| 1 — design (this doc) | `issue-332-memory-redesign.md` | codex + gemini ✓ (this commit integrates both) |
| 2a — config migration + env emission unit tests | vitest specs for `buildNaiaConfigEnv` new branches + adk-store.ts:219 bug fix | codex |
| 2a.5 — S114 migration spec (NEW) | 12-field legacy → 4-field round-trip preserves user intent | gemini |
| 2b — S105 persistence | `30-memory-persistence.spec.ts` | codex |
| 2c — S113 encoder fallback + recall quality | `34-memory-encoder-fallback.spec.ts` — fallback happens + top-3 quality maintained | gemini |
| 2d — S101 multi-turn with memory | `35-multi-turn-with-memory.spec.ts` | codex |
| 2e — S106 decay/ranking (deterministic time) | `31-memory-decay.spec.ts` — uses new agent IPC `advance_clock` | gemini |
| 2f — S111 backup round-trip | `32-memory-backup.spec.ts` | codex |
| 2g — S112 latency budget | `33-memory-latency.spec.ts` (LAST — noisy, tests stabilized path) | gemini |
| 3 — UI refactor | SettingsTab + adk-store + config types + lock-badge UI | gemini |
| 4 — Rust IPC + agent diagnostic IPC | `fetch_memory_stats` + `advance_clock` (e2e-only, gated by NAIA_E2E_MOCK_CLONE) | codex |
| 5 — Manual | `memory.md` topic page | gemini |
| 6 — Verify + commit | full spec run + cross-review summary | codex+gemini consensus |

Rationale for the reordered TDD (codex correction):

- **Config migration first** (2a) — every subsequent spec depends on
  legacy fields being correctly converted to the new 4-field shape; if
  this regresses, all of 2b-2g fail noisily.
- **Persistence before fallback** (2b → 2c) — fallback is a graceful
  degradation path; persistence is the canonical happy path. Persistence
  must work before "what if it doesn't" makes sense.
- **Multi-turn before decay** (2d → 2e) — multi-turn exercises the
  end-to-end recall pipeline; decay is a refinement of ranking on top
  of a working pipeline.
- **Latency last** (2g) — latency tests are inherently noisy (worker
  thread scheduling, OS file cache). Running them against a stabilized
  path catches real regressions; running them during design pollutes
  signal with implementation noise.

Each phase commits separately; assignee picks up where the loop stopped.

## 8. Cross-review consensus (codex + gemini, 2026-05-27)

### 8.1 Agreed

1. **`adk-store.ts:219` bug** — `if (ep !== "none" && ep !== "offline")`
   silently drops offline mode. **Fix mandatory** in Phase 2a.
2. **Stats refresh cadence** — on-mount + manual refresh. No polling.
3. **Migration spec required** — 12-field legacy → 4-field new mapping
   must be unit-tested with no silent data loss. Added as Phase 2a.5.

### 8.2 Disagreed — Phase 1 defers, Phase 3 picks (user/codex assignee chooses)

| Issue | codex view | gemini view | Default for Phase 2 |
|-------|-----------|-------------|---------------------|
| Backup password storage | **in-memory only** — backup/restore is a ceremony, re-entry acceptable, secure-store sharing burned us in #329 | **secure-store mandatory** — automated background backups need persistence; #329 was naming collision, not storage flaw | **in-memory** (codex) — Phase 1 ships simpler; secure-store is a Phase 3 opt-in via "background backup" toggle |
| Embed precedence | **`memoryEmbedding` wins for embeddings** — memory privacy must not silently inherit from chat config | **LLM-section wins with lock UI** — "one-click" UX, but lock the Memory section visually with back-link so user sees the implication | **memoryEmbedding wins** (codex) — privacy default safer; LLM section can override only via explicit "use my chat embed model" toggle |
| State reduction | 12→4 fine, prune implementation knobs | 12→4 loses **Local OpenAI-compat embed servers** (Ollama/vLLM baseUrl/model) — preserve as "Custom (Advanced)" | **4 + 1 Advanced disclosure** — main 4 + Custom under collapsed "Advanced" for ollama/vllm power users |

### 8.3 New gaps surfaced by gemini

1. **S106 decay determinism** — Ebbinghaus decay is system-time dependent
   and inherently flaky in e2e. Need a new naia-agent diagnostic IPC
   command (`set_fact_timestamp` or `advance_clock`) so the spec can
   warp time deterministically. Added to Phase 4 (Rust IPC).
2. **S113 fallback quality** — current plan asserts "fallback happens"
   but not "recall quality is maintained". Strengthen to "after fallback,
   a known high-similarity fact still ranks top-3".
3. **S114 migration spec** (NEW) — verify legacy 12-field config →
   new 4-field config round-trip preserves user intent (provider,
   ollama/vllm endpoints if any). Added to Phase 2a.5.
4. **UI lock pattern** — if LLM provider is `nextain` (cloud), Memory's
   gateway-embed option should display a lock badge with "Cloud embed
   tied to your LLM provider — click to change in LLM section".

## 9. Preserved legacy fields (codex pruning rule)

Only old fields that map to **durable user intent** are kept (under a
collapsed "Advanced (legacy)" disclosure section), not implementation
knobs:

| Legacy field | Keep? | Rationale |
|--------------|:---:|-----------|
| `memoryAdapter` (local/qdrant) | ✗ | replaced by `memoryMode` |
| `memoryOfflineModel` | ✗ | implementation knob, fixed to `all-MiniLM-L6-v2` for now |
| `memoryEmbeddingBaseUrl/ApiKey/Model` | ✗ | derived from gateway embedded role |
| `qdrantUrl/qdrantApiKey` | **✓** legacy disclosure | explicit provider choice (cloud sync intent) |
| `memoryLlmProvider/BaseUrl/ApiKey/Model` | ✗ | derived from gateway sub role |
| `backupPassword` | ✗ | in-memory only now (not persisted) |

Migration: `loadConfig()` reads legacy `qdrantUrl/qdrantApiKey` →
preserves under new `legacyQdrant` field for future cloud-mode wiring.
All other legacy fields are silently dropped on next save.

🤖 Written with AI assistance. If anything looks off, please open a discussion.
