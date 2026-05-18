# Local Inference Infrastructure Recommendations

Date: 2026-05-16

This note records the recommended local inference stack for Naia OS by hardware
tier. It is based on the current local-first product rule: any model that sees
user content, memory, embeddings, fact extraction, or contradiction detection
must run locally.

## Baseline Decision

For an 8GB VRAM laptop such as an RTX 4060 Laptop GPU, use Qwen3.5 9B as the
main text model and Ollama as the serving backend.

```text
Backend: Ollama
Main LLM: Qwen3.5-9B Q4_K_M or Q4_K_S
Context: start at 4K, raise to 8K only after stability checks
Embedding: nomic-embed-text
Memory: naia-memory LocalAdapter + SQLite
Fact extraction: reuse Qwen3.5-9B, or swap to a smaller 3B/4B model if needed
STT: Whisper base/small, or Vosk KO small when latency matters more than quality
TTS: Piper for fully offline use
Omni/live voice: disabled
```

Rationale:

- Qwen3.5 9B Q4 fits the 8GB tier much better than 27B-class models.
- Ollama has lower operational complexity and is better suited to a single-user
  laptop than vLLM.
- vLLM is reserved for larger GPUs, multi-model routing, batching, or shared
  server use.
- naia-memory must keep a separate embedding path; the chat model should not be
  treated as the embedding model.

## Tier Matrix

The product-facing profiles are fixed to five VRAM tiers: 8GB, 16GB, 24GB,
32GB, and 48GB. Other hardware can still run experiments, but the setup tooling
should not expose additional first-class profiles until the five tiers below are
implemented and verified.

| Tier | Hardware | Main LLM | Serving | Memory Embedding | Voice | Recommendation |
| --- | --- | --- | --- | --- | --- | --- |
| Laptop minimum | 8GB VRAM | Qwen3.5 9B Q4 | Ollama | nomic-embed-text | STT/TTS documented only in first pass | Current maintainer laptop profile. Text-first, no omni. |
| Text-only comfortable | 16GB VRAM | Qwen3.5 9B Q5/Q6 or 14B Q4 | Ollama or llama.cpp | nomic-embed-text or bge-m3 | Whisper small/medium + local TTS | Recommended minimum for polished text-only Naia. |
| Text + memory headroom | 24GB VRAM | 14B/27B Q4, or Qwen3.5 9B high quant | Ollama; vLLM optional | bge-m3 or gte-Qwen2 | Whisper medium + local TTS | Best single-GPU laptop/desktop target for non-omni. |
| Omni experiment | 32GB VRAM | MiniCPM/Qwen omni only if optimized | vLLM-omni or specialized runtime | dedicated embedding model | omni or Whisper/Piper fallback | Experimental; model swapping likely required. |
| Standard local AI | 48GB VRAM | MiniCPM 4.5-omni + memory models | vLLM/vLLM-omni | bge-m3/gte-Qwen2 | omni preferred | Target tier for full local voice+vision+text. |

## Backend Selection

### Ollama

Use Ollama when:

- The machine is a personal laptop or single-user desktop.
- VRAM is 8GB to 24GB.
- The model is GGUF/quantized and the priority is easy local operation.
- Naia OS needs a stable OpenAI-compatible local endpoint without server
  operations overhead.

Default for:

- Qwen3.5 9B on 8GB VRAM.
- Local naia-memory embedding with `nomic-embed-text`.
- First-run and offline-only user setups.

### llama.cpp

Use llama.cpp when:

- Fine control over GPU layer offload, KV cache type, and context sizing is
  required.
- The model barely fits and manual tuning is needed.
- The deployment is embedded or scripted rather than user-facing.

### vLLM

Use vLLM when:

- VRAM is 24GB+ and the model has enough headroom.
- There are multiple users, batch requests, or server-style workloads.
- Naia needs task routing across chat, memory extraction, contradiction checks,
  and embeddings through OpenAI-compatible endpoints.

Avoid vLLM on 8GB laptops for the default Naia OS profile. Its throughput
advantages do not offset memory pressure and operational complexity at this
scale.

### vLLM-omni

Use vLLM-omni only for omni models where voice/audio is part of the model
capability. This belongs to the 32GB+ experimental tier and the 48GB+ standard
tier, not the 8GB text-only profile.

## naia-memory Layout

The memory system should be split into small always-on work and heavier
on-demand work.

Always-on:

- SQLite LocalAdapter storage.
- Embedding model, preferably `nomic-embed-text` on constrained machines.
- CPU-side decay, importance, scheduling, and graph bookkeeping.

On-demand:

- Fact extraction.
- Contradiction detection.
- Memory compression or reflection.
- Multi-hop retrieval synthesis.

For the 8GB Qwen3.5 9B profile, reuse the main Qwen model for fact extraction
first. Add a separate 3B/4B memory model only if the machine has enough headroom
or if swapping overhead is acceptable.

The current agent requires slightly different URL shapes for embeddings and
fact extraction:

```json
{
  "adapter": "local",
  "embeddingProvider": "ollama",
  "embeddingBaseUrl": "http://localhost:11434",
  "embeddingApiKey": "ollama",
  "embeddingModel": "nomic-embed-text",
  "llmProvider": "ollama",
  "llmBaseUrl": "http://localhost:11434/v1/",
  "llmApiKey": "ollama",
  "llmModel": "qwen3.5:9b"
}
```

`embeddingBaseUrl` omits `/v1` because the embedding provider appends the
embeddings path. `llmBaseUrl` includes trailing `/v1/` because the fact
extractor appends `chat/completions`. `llmApiKey` is present because the current
agent only enables local Ollama fact extraction when a key string exists, even
though Ollama does not require a real secret.

## Recommended 8GB Config

Conceptual Naia settings:

```json
{
  "provider": "ollama",
  "model": "qwen3.5:9b",
  "ollamaHost": "http://localhost:11434",
  "memory": {
    "embeddingProvider": "ollama",
    "embeddingBaseUrl": "http://localhost:11434",
    "embeddingModel": "nomic-embed-text",
    "llmProvider": "ollama"
  },
  "sttProvider": "whisper",
  "sttModel": "whisper-base",
  "ttsProvider": "local-offline"
}
```

Operational constraints:

- Start with 4K context.
- Keep omni/live voice disabled.
- Prefer `nomic-embed-text` before trying larger multilingual embeddings.
- Treat STT/TTS installation as documented-only until the app's supported local
  TTS path is confirmed.
- Do not run a 27B-class model as the default local Naia model on 8GB VRAM.
- Do not use vLLM, vLLM-omni, MiniCPM-o, or any cloud fallback in the first 8GB
  local-only setup pass.

## Open Follow-ups

- Benchmark Qwen3.5 9B Q4_K_M against Qwen3-8B abliterated on Korean chat,
  coding tasks, tool calling, and memory extraction.
- Validate the exact Ollama model identifier and GGUF quant that should ship in
  onboarding examples.
- Add a first-run hardware detector that maps detected VRAM to this tier matrix.
- Add a memory settings preset for the 8GB profile.
