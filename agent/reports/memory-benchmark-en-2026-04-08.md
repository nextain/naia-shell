# EN Memory Benchmark Report (2026-04-08)

**Judge**: Gemini 2.5 Pro API (batch, 10 items/call)
**LLM**: Gemini 2.5 Flash (askWithMemory)
**Lang**: EN
**Runs**: 1
**Total questions**: 240 (12 categories)

## Summary

| Adapter | Score | Rate | Grade |
|---------|-------|------|-------|
| naia | 99/240 | 44% | D |
| mem0 | 84/240 | 38% | E |
| sap | 69/240 | 29% | F |
| airi (baseline) | 66/240 | 28% | F |

**Cached adapters only** (naia, mem0, sap). 7 adapters without cache require embedding phase (skipped).

## Category Breakdown

| Category | naia | mem0 | sap | airi |
|----------|------|------|-----|------|
| direct_recall (25) | 1 | 2 | 1 | 2 |
| semantic_search (25) | 17 | 15 | 9 | 12 |
| proactive_recall (20) | 2 | 3 | 3 | 2 |
| abstention (20) | 20 | 19 | 19 | 17 |
| irrelevant_isolation (15) | 8 | 4 | 11 | 9 |
| multi_fact_synthesis (20) | 11 | 8 | 13 | 12 |
| entity_disambiguation (20) | 2 | 1 | 1 | 0 |
| contradiction_direct (20) | 12 | 9 | 1 | 3 |
| contradiction_indirect (15) | 2 | 2 | 7 | 6 |
| noise_resilience (20) | 18 | 17 | 1 | 1 |
| unchanged_persistence (15) | 3 | 2 | 1 | 0 |
| temporal (25) | 3 | 2 | 2 | 2 |

## Key Findings

### 1. naia leads overall (44% vs mem0 38%)
- Strong in: abstention (100%), noise_resilience (90%), semantic_search (68%)
- Weak in: direct_recall (4%), temporal (12%), entity_disambiguation (10%)

### 2. All adapters struggle with direct_recall
- Best: mem0 2/25 (8%), worst: naia/sap 1/25 (4%)
- Memory search returns [10 mem] consistently, but LLM fails to extract facts
- Root cause: askWithMemory LLM (Gemini 2.5 Flash) doesn't reliably use recalled memories

### 3. airi baseline scores 28% — surprisingly high for no-memory
- Gets points from abstention (85%), irrelevant_isolation (60%), contradiction_indirect (40%)
- These categories test "not answering unknown questions" — a model that refuses scores well

### 4. Gemini 2.5 Pro batch judge works correctly
- Different scores across adapters (44% vs 28%) — not flattened like GLM batch
- Category distributions vary naturally — judge is discriminating properly
- Token cost: ~249 tokens/question (vs 569 for single-call CLI)

### 5. noise_resilience: naia (90%) vs sap/airi (5%)
- Massive gap: naia/mem0 recall noisy memories and answer correctly
- sap/airi fail because they can't extract signal from noise

## Pending Work

### Adapters without EN cache (need embedding phase):
- sillytavern (local transformers.js embeddings)
- openclaw (Gemini embeddings, separate vec DB)
- graphiti (Neo4j)
- letta (own server)
- starnion (PostgreSQL)
- open-llm-vtuber (unknown)

### Token consumption estimates
- Per adapter: ~240 questions × 10 batch × 249 tokens ≈ 60K tokens
- Total for 6 remaining adapters: ~360K tokens
- Gemini 2.5 Pro quota: ~86% remaining — sufficient

## Technical Notes

- `--adapters` parsing bug fixed (space-separated args now supported)
- GLM-5.1 `reasoning_content` fallback added (thinking mode returns empty `content`)
- `gemini-api` batch judge implemented (10 items/call, queue-based flush)
- Judge uses Gemini 2.5 Pro API directly (not CLI) for efficiency

## Files Modified
- `src/memory/benchmark/comparison/run-comparison.ts`:
  - Fixed `--adapters` arg parsing (lines 55-82)
  - Fixed GLM reasoning_content fallback (line 383-385)
  - Added `gemini-api` batch judge (callGeminiApiBatch, enqueueGeminiApiJudge)
  - Added GEMINI_BATCH_SIZE=10, GEMINI_API_BASE constants
