# feat(local): add VRAM-based local inference setup profiles

## Goal

Make Naia OS easy to configure for fully local inference by selecting a hardware
profile based on available GPU VRAM. The first implementation target is the
maintainer's 8GB VRAM laptop profile, then the same structure should extend to
16GB, 24GB, 32GB, and 48GB profiles.

## Background

Naia OS is local-first. Any model that sees user content, memory, embeddings,
fact extraction, or contradiction detection must run locally unless the user
explicitly chooses a cloud provider.

Current maintainer hardware for the first pass:

- GPU: NVIDIA GeForce RTX 4060 Laptop GPU
- VRAM: 8188 MiB, treated as the 8GB profile
- Current local state: Ollama is not installed yet

Initial baseline decision:

- 8GB profile uses Ollama, not vLLM.
- Main model target: Qwen3.5 9B Q4-class quantization.
- Memory embedding: `nomic-embed-text` via Ollama.
- Memory store: naia-memory LocalAdapter/SQLite.
- STT: Whisper base/small or Vosk fallback.
- TTS: local/offline target is Piper, with current app support gap to verify.
- Omni/live voice: disabled on 8GB.

## Hardware Profiles

| Profile | VRAM | Intended local stack |
| --- | ---: | --- |
| `local-8gb` | 8GB | Qwen3.5 9B Q4 + Ollama + nomic-embed-text + naia-memory SQLite, text-first |
| `local-16gb` | 16GB | Qwen3.5 9B higher quant or 14B Q4 + Ollama/llama.cpp + stronger STT options |
| `local-24gb` | 24GB | 14B/27B Q4 experiments + bge-m3/gte embedding candidates + optional vLLM |
| `local-32gb` | 32GB | experimental omni profile, model swapping likely required |
| `local-48gb` | 48GB | full local voice+vision+text target with vLLM/vLLM-omni |

## Requirements

- REQ-001: Document the 8/16/24/32/48GB local inference profiles in `docs/`.
- REQ-002: Provide a user-facing setup guide that explains how to choose a profile and configure Naia OS locally.
- REQ-003: Add an installer/configuration script that can detect VRAM, select a profile, and run in dry-run mode by default.
- REQ-004: Implement the `local-8gb` profile first.
- REQ-005: The 8GB script must check for Ollama, guide or perform installation only when explicitly requested, pull the required models, and write memory configuration.
- REQ-006: The script must avoid destructive changes and must not overwrite existing user config without backup or explicit confirmation.
- REQ-007: Verification must include Ollama availability, model presence, embedding endpoint availability, JSON-mode chat compatibility, and a short generation smoke test.
- REQ-008: Implementation should be phase-gated: Claude Code implements; Gemini and Codex perform post-implementation verification; Codex does final issue summary.
- REQ-009: Dry-run must make zero filesystem, network, package-manager, or model-pull changes.
- REQ-010: Apply mode must not install Ollama unless an additional explicit `--install-ollama` flag is set.
- REQ-011: The script must not configure cloud fallbacks for LLM, embedding, memory extraction, STT, or TTS in a local-only profile.
- REQ-012: The 8GB implementation must not attempt to configure Shell browser `localStorage` directly; it may write `~/.naia/memory-config.json` and print UI settings for the user.
- REQ-013: The script must detect existing `~/.naia/memory-config.json`, preserve unrelated keys, show a planned diff, and create a timestamped backup before writing in apply mode.
- REQ-014: VRAM detection must handle missing `nvidia-smi`, multiple GPUs, WSL/driver failures, and threshold rounding without selecting a higher profile than the best single GPU can support.
- REQ-015: Higher profiles are documented-only in the first implementation. Only `local-8gb` is applied by script in the first pass.

## Proposed Files

- `docs/guides/local-inference-setup.md` - user-facing guide. Use `docs/guides/` to avoid loose root-level docs files.
- `docs/reports/20260516-local-inference-infrastructure.md` - architecture/report note, already started and should be updated to the fixed profile set.
- `scripts/setup-local-inference.ps1` - Windows first, with `--profile`, `--dry-run`, `--apply`, and `--skip-model-pull` options.
- `scripts/setup-local-inference.sh` - Linux/Bazzite follow-up, may be implemented after Windows script.

## Phased Plan

### Phase 0: Planning and Cross Review

- Create this issue.
- Add/update docs plan for the fixed 8/16/24/32/48GB profile set.
- Cross-review the plan with independent AI reviewers.
- Strengthen scope and acceptance criteria before implementation.

### Phase 1: Documentation

- Write `docs/guides/local-inference-setup.md`.
- Update `docs/reports/20260516-local-inference-infrastructure.md` to focus on the agreed 8/16/24/32/48GB set.
- Clearly distinguish bundled code/scripts from bundled model weights.
- State that the first pass uses on-demand model download rather than embedding large model weights into the repo or ISO.
- State that 8GB local-only setup does not configure cloud fallback providers.
- State that STT/TTS are documented recommendations in Phase 1 unless a supported local installer path already exists.

### Phase 2: 8GB Installer Script

- Add `scripts/setup-local-inference.ps1`.
- Detect NVIDIA VRAM via `nvidia-smi` when available.
- Select `local-8gb` automatically for 8GB VRAM, with manual override.
- For multiple GPUs, choose the best single GPU; do not sum VRAM.
- Check Ollama installation.
- In dry-run mode, print actions only.
- In apply mode, write config and pull models only after explicit flags.
- Install Ollama only when both `--apply` and `--install-ollama` are present.
- Pull models only when `--apply` is present and `--skip-model-pull` is absent.
- Before any write, create `~/.naia` if needed and back up existing `memory-config.json`.
- Fail closed if existing JSON cannot be parsed.

### Phase 3: Naia Config Integration

- Verify the exact app-side config paths and fields.
- Write or document `~/.naia/memory-config.json` values for Ollama embeddings and fact extraction.
- Avoid overwriting existing `naia-config` browser localStorage directly unless a supported app command exists.
- Prefer script output that tells the user which settings to choose in the UI when direct safe config is not available.
- Use the following 8GB memory config shape unless implementation proves a better code-level fix:

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

Implementation notes:

- `embeddingBaseUrl` intentionally omits `/v1`; `OpenAICompatEmbeddingProvider` appends the embeddings path.
- `llmBaseUrl` intentionally includes trailing `/v1/`; `buildLLMFactExtractor` appends `chat/completions`.
- `llmApiKey` is required by current agent code even for Ollama; use a dummy local value such as `ollama` unless the agent is changed to allow keyless local providers.
- The UI settings still need to be selected in the Shell because browser `localStorage` cannot be safely modified by this external script.

Suggested UI settings for 8GB:

- LLM provider: Ollama.
- Model: exact pulled Qwen3.5 9B model tag.
- Ollama host: `http://localhost:11434`.
- Voice/live/omni: off.
- STT/TTS: use documented local options only after support is confirmed.

### Phase 4: Verification

- Claude Code runs implementation checks.
- Gemini reviews the final docs and script for user clarity, missing safety checks, and hardware-tier correctness.
- Codex reviews the final docs and script for repository consistency, config correctness, and test coverage.
- Codex writes the final issue summary and follow-up list.

Verification must include:

- `ollama` command or HTTP service availability.
- `GET http://localhost:11434/api/tags`.
- Required model tags are present after apply mode.
- `POST http://localhost:11434/v1/embeddings` with `nomic-embed-text` returns a vector.
- `POST http://localhost:11434/v1/chat/completions` with the selected Qwen model returns non-empty text.
- JSON response mode compatibility for the memory fact extractor request.
- Actionable diagnostics when a check fails.

## Open Decisions

- Confirm the exact Ollama model tag for Qwen3.5 9B. If no stable `qwen3.5:9b` tag exists, use a documented fallback tag or a Modelfile/GGUF path.
- Confirm whether Piper is currently supported in the app. If not, 8GB TTS remains documented-only or uses the current supported local/zero-key fallback.
- Decide whether Linux/Bazzite script ships in the first implementation or follows after Windows is verified.
- Decide whether product context files (`.agents/context/hardware-tiers.yaml` and mirrors) should be updated in the same issue or a follow-up, since the fixed 8/16/24/32/48GB tier set changes product policy.
- Decide whether to create a Naia-specific Ollama alias/Modelfile with `num_ctx` fixed to 4096 for the 8GB profile.

## Explicitly Out of Scope for First Implementation

- vLLM and vLLM-omni setup.
- MiniCPM-o or any omni model setup.
- 27B-class model as default on 8GB.
- UI settings page changes.
- Direct browser `localStorage` modification.
- STT/TTS automatic installation unless a known supported local package path already exists.
- Benchmark suite.
- Bundling large model weights into git, Flatpak, or ISO images.

## Acceptance Criteria

- A user with an 8GB NVIDIA laptop can run a single documented command and understand exactly what will be installed/configured before anything changes.
- Dry-run is the default path and is safe.
- Apply mode can configure the local inference prerequisites for the 8GB profile.
- Existing user configuration is backed up or left untouched.
- The guide covers all five target VRAM profiles at a decision level.
- Verification results are posted back to this issue before final closure.
- The guide includes prerequisites, supported OS/GPU matrix, dry-run/apply examples, rollback steps, troubleshooting, expected success output, and how to verify that Naia is using local inference.
- The script reports approximate model sizes, checks available disk space where practical, and handles model pull failures with retry instructions.
- The first implementation cannot silently configure any network/cloud provider for user-content AI paths.

## Delegation Model

- Implementation owner: Claude Code.
- Planning/cross-review owner: Codex.
- Post-implementation verification: Gemini + Codex.
- Final summary and issue closure recommendation: Codex.

## Cross-Review Findings Incorporated

Planning cross-review found and this draft now incorporates:

- Exact model/tag resolution must be a gate, not an assumption.
- Ollama install requires a separate explicit flag beyond `--apply`.
- Dry-run must be side-effect free.
- Existing memory config needs diff, backup, merge, and parse-failure behavior.
- `embeddingBaseUrl` and `llmBaseUrl` require different URL shapes.
- Ollama fact extraction currently requires dummy `llmApiKey`.
- Shell app settings cannot be fully configured by an external PowerShell script today.
- STT/TTS auto-install should be deferred from the 8GB first pass unless support is confirmed.
- vLLM, omni, 27B default, UI changes, and benchmarks are out of scope.

## Issue Creation Status

Blocked at planning time:

- GitHub App issue creation returned `403 Resource not accessible by integration`.
- Local `gh auth status` reports an invalid keyring token for `luke-n-alpha`.
- Once GitHub auth is repaired, create the issue from this file.
