<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# Memory

Naia remembers facts across sessions, recalls them when relevant, and
gracefully decays older ones — so the agent stays personal without
turning into a stale dump.

Related e2e: S008 (`08-memory.spec.ts`), S101
(`35-multi-turn-with-memory.spec.ts`), S105
(`30-memory-persistence.spec.ts`), S106 (`31-memory-decay.spec.ts`),
S111 (`32-memory-backup.spec.ts`), S112 (`33-memory-latency.spec.ts`),
S113 (`34-memory-encoder-fallback.spec.ts`).

## Overview

- **Engine** — Hardened SQLite v6.0 (`@nextain/naia-memory`).
- **Architecture** — Worker-thread isolation, FTS5 BM25 + sqlite-vec
  + R-Tree, AES-256-GCM encrypted backup.
- **Recall tiers** — Tier1 Hot 10k (Surface, target <25 ms; measured
  **9.74 ms**) + Tier2 Full scan fallback (target <100 ms; measured
  **80 ms**). 100k-fact corpus benchmarked.
- **Lifecycle** — Encode on every assistant turn that surfaces a
  fact-worthy claim; recall on user turn before LLM call; Ebbinghaus
  decay re-ranks at recall time so older facts gradually slide down
  unless reinforced.

## Prerequisites

- **Local mode** (default, recommended) — no external dependencies.
  Bundled ONNX `all-MiniLM-L6-v2` (384 dims) handles embedding offline,
  SQLite file lives under `naia-settings/.memory/cli.sqlite`.
- **Cloud mode** (Qdrant) — **not yet available** (`disabled` in the
  current UI, see nextain/naia-os#332 Phase 3 for wiring).
- Optional — if you flip Embedding to **via gateway**, you need a
  working LLM gateway with an `embedded` role configured in
  `naia-settings/llm.json`.

## Usage

### Settings → 메모리 (Memory)

The redesigned three-section panel (per `#332` Phase 3) is:

1. **모드 (Mode)** — `Off` / `Local` / `Cloud (coming soon — disabled)`.
   Default: `Local`.
2. **임베딩 (Embedding)** — `Offline (no key)` / `via gateway`.
   Default: `Offline`. When you pick `via gateway`, a
   "local storage · remote embeddings" badge appears so it's obvious
   that data still stays local but query vectors traverse the gateway.
3. **백업 (Backup)** — password field (AES-256-GCM, in-memory only
   until you click export) + `내보내기` / `가져오기` buttons.

> **UI mid-refactor (`#332`).** As of 2026-05-27 the live Settings tab
> still shows the legacy 12-field memory layout (`memoryAdapter`,
> `memoryEmbeddingProvider`, `memoryLlmProvider`, six `*BaseUrl/ApiKey/Model`
> rows, etc.). The 4-state redesign described above lands in Phase 3
> of `#332`. Phases 1-2 (config migration, persistence/recall/backup
> specs) have been merged; Phase 3 UI cut, Phase 4 Rust IPC
> (`fetch_memory_stats`, `advance_clock`), Phase 5 (this doc), and
> Phase 6 (final verify) are tracked under the same issue.

### Env contract (what the shell actually emits)

The shell's `buildNaiaConfigEnv` translates the Settings UI into env
vars for `naia-agent`. With memory on:

| Setting | Env emitted |
|---|---|
| `memoryMode = local` + `memoryEmbedding = offline` | `NAIA_EMBED_PROVIDER=offline`, `NAIA_EMBED_MODEL=all-MiniLM-L6-v2`, `NAIA_EMBED_DIMS=384` |
| `memoryMode = local` + `memoryEmbedding = gateway` | `NAIA_EMBED_PROVIDER=gateway` (agent reads `embedded` role from `naia-settings/llm.json`) |
| `memoryMode = off` | no `NAIA_EMBED_*` emitted; agent falls back to `InMemoryMemory` |

DB path defaults to `naia-settings/.memory/cli.sqlite` and can be
overridden with `NAIA_AGENT_MEMORY_DB`.

### Agent CLI

For headless / scripted use:

```
pnpm naia-agent --memory "내 이름은 Tester야"
pnpm naia-agent --memory "내 이름이 뭐였지?"
```

Same `NAIA_EMBED_*` env contract as the shell; same SQLite file unless
overridden.

## Examples

### Multi-turn naming recall (S101)

Turn 1:

```
User:  내 이름은 Tester야. 잘 기억해 둬.
Naia:  네, Tester님. 기억해 둘게요.
```

Turn 2 (later — same or a new session):

```
User:  내 이름이 뭐였지?
Naia:  Tester님이라고 알려주셨어요.
```

Behind the scenes turn 1 produced a memory write
(`encode_fact("user.name = Tester")`); turn 2's pre-LLM recall
returned that fact in the top-3, and the LLM was prompted with it.
This matches `35-multi-turn-with-memory.spec.ts` (S101).

### Backup round-trip (S111 — Phase 2f)

```
1. Settings → 메모리 → 백업
2. 비밀번호: hunter2-CASE-sensitive
3. [내보내기] → naia-memory-backup-2026-05-27.aes.bin
4. (move to another machine, or wipe local DB)
5. [가져오기] → 같은 비밀번호 입력
6. 총 facts / surface size 가 export 시점과 일치하는지 확인
```

Spec `32-memory-backup.spec.ts` asserts encode → export → wipe →
import → recall returns the original fact byte-for-byte.

## Troubleshooting

### `memory init failed` on stderr → falling back to ephemeral

The agent's `buildCliMemory` catches `LiteMemoryProvider` init errors
and silently falls back to `InMemoryMemory` so the agent still
answers. Symptoms: no recall across turns, no facts in any tab.
Check `naia.log` for a line like `memory=lite db=...` — if it's
absent and you see `memory=ephemeral` instead, the SQLite path is the
prime suspect (permission, missing dir, locked file, sqlite-vec
extension load).

### Backup decryption failed

Password is case-sensitive and not stored anywhere — re-enter
exactly. If you've lost it, the backup is unrecoverable by design
(AES-256-GCM). The in-memory storage choice (codex side of the Phase 1
cross-review, see `#332` §8.2) is deliberate: re-entry on each
export/import is the ceremony.

### `no facts shown in DiagnosticsTab` (or similar empty state)

1. Confirm `NAIA_EMBED_*` is actually reaching the agent — `naia.log`
   prints the resolved provider on startup.
2. If you switched provider in Settings recently, you may be hitting
   the secure-store collision in `#329`. The fix landed but stale
   `apiKey` JSON in the Tauri secure-keys vault can still shadow
   `naiaKey` and starve the embed role; see `lessons-learned.yaml`
   **L059** for the trace.
3. As a one-off, run `pnpm naia-agent --memory "test"` from the
   agent directory — if that records and recalls fine, the issue is
   in the shell's env emission, not the memory engine.

### `sqlite-vec` load failure

Means `@nextain/naia-memory` v6.0 native bits didn't install cleanly.
On Linux/macOS: re-run `pnpm install` from the workspace root; the
package ships prebuilt binaries for common Node ABIs. On Windows or
exotic Node versions you may need to rebuild — see
`projects/naia-memory/GEMINI.md` for the supported matrix.

### Recall returns nothing despite encoded facts (S113 fallback)

If you've set Embedding to **via gateway** and the gateway's embed
endpoint started 5xx-ing, the encoder transparently falls back to
the bundled offline ONNX. Symptoms: encode still succeeds, but recall
quality drops because vectors written under the gateway model are
now compared against ONNX vectors. Spec
`34-memory-encoder-fallback.spec.ts` (S113) asserts a known
high-similarity fact still ranks top-3 even after fallback; if your
recall is empty, check `naia.log` for `embedder fallback triggered`.
Quickest fix: flip Embedding back to **Offline** for a clean
single-model corpus, then re-encode the affected facts.

## Related

- E2E specs (per `#332` phase status): **S008** (baseline encode/recall),
  **S101** (multi-turn), **S105** (persistence across restart), **S106**
  (decay/ranking — pending Phase 2e), **S111** (backup round-trip —
  pending Phase 2f), **S112** (latency budget — pending Phase 2g),
  **S113** (encoder fallback — landed Phase 2c).
- Library spec — `projects/naia-memory/GEMINI.md` (v6.0).
- CLI — `pnpm naia-agent --memory "..."`.
- Provider-switch hygiene — `.agents/context/lessons-learned.yaml`
  **L059** (secure-store collision shadowing the embed role).
- Issue tracker — nextain/naia-os#332 (this redesign), nextain/naia-os#329
  (provider switch / secure-store).

🤖 Written with AI assistance. If anything looks off, please open a discussion.
