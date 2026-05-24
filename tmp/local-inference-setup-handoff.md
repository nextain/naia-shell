# Local Inference Setup Handoff

## Issue Status

GitHub issue creation is blocked until repository write auth is repaired.

- GitHub App create issue failed: `403 Resource not accessible by integration`.
- Local `gh auth status` reports an invalid keyring token for `luke-n-alpha`.
- Draft issue body: `tmp/local-inference-setup-issue.md`.

After auth is fixed, create the issue in `nextain/naia-os` using that file.

## Phase Ownership

### Phase 0 - Planning and Cross Review

Owner: Codex

Status: complete locally.

Artifacts:

- `tmp/local-inference-setup-issue.md`
- `docs/reports/20260516-local-inference-infrastructure.md`

Cross-review findings incorporated:

- Dry-run must be side-effect free.
- `--apply` must not imply Ollama install; use `--apply --install-ollama`.
- Shell browser localStorage should not be modified directly by an external script.
- `~/.naia/memory-config.json` can be safely written with backup/merge behavior.
- Ollama memory config needs:
  - `embeddingBaseUrl: "http://localhost:11434"`
  - `llmBaseUrl: "http://localhost:11434/v1/"`
  - dummy `embeddingApiKey` and `llmApiKey` values for current code paths
- STT/TTS auto-install is deferred from the 8GB first pass.
- vLLM, vLLM-omni, MiniCPM-o, 27B default, UI changes, and benchmarks are out of scope.

### Phase 1 - Claude Code Implementation

Owner: Claude Code

Prompt:

```text
Read AGENTS.md, .agents/context/agents-rules.json, .agents/context/project-index.yaml,
docs/reports/20260516-local-inference-infrastructure.md, and tmp/local-inference-setup-issue.md.

Implement the first pass of "VRAM-based local inference setup profiles" for Naia OS.

Scope:
- Create docs/guides/local-inference-setup.md.
- Add scripts/setup-local-inference.ps1 for Windows first.
- Keep Linux/Bazzite script documented as follow-up unless trivial and safe.
- Implement only local-8gb as an apply-capable profile.
- Document 16GB, 24GB, 32GB, 48GB profiles as planned profiles.

Safety requirements:
- Dry-run is default and performs no filesystem, network, package-manager, or model-pull changes.
- Apply mode is explicit.
- Ollama installation requires both --apply and --install-ollama.
- Do not overwrite existing ~/.naia/memory-config.json without a timestamped backup.
- Preserve unrelated existing memory-config keys where possible.
- Fail closed if existing JSON is invalid.
- Do not modify Shell browser localStorage.
- Do not configure cloud fallback providers.

8GB defaults:
- Provider: Ollama.
- Main model candidate: qwen3.5:9b unless exact tag validation requires a documented fallback.
- Embedding model: nomic-embed-text.
- Memory config:
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

Verification hooks in script:
- nvidia-smi VRAM detection when available.
- Multiple GPUs: select best single GPU, do not sum VRAM.
- Missing nvidia-smi: print manual profile guidance.
- GET http://localhost:11434/api/tags.
- POST /v1/embeddings with nomic-embed-text.
- POST /v1/chat/completions with selected Qwen model.
- JSON response mode compatibility check for fact extraction.

Do not implement:
- vLLM setup.
- vLLM-omni or MiniCPM-o.
- 27B model default.
- UI settings page changes.
- direct localStorage edits.
- STT/TTS automatic install.
- benchmark suite.

After implementation, run a dry-run on this machine and report exact output.
```

### Phase 2 - Gemini Verification

Owner: Gemini

Prompt:

```text
Review the implemented local inference setup docs and script for Naia OS.
Focus on user clarity, missing safety checks, hardware-tier correctness,
and whether an 8GB RTX 4060 Laptop user can understand and safely run it.

Files:
- docs/guides/local-inference-setup.md
- docs/reports/20260516-local-inference-infrastructure.md
- scripts/setup-local-inference.ps1

Check:
- Dry-run is side-effect free.
- Apply/install flags are clear.
- The 8/16/24/32/48GB tier distinction is understandable.
- No cloud fallback is silently configured.
- Existing config protection is clear.
- Troubleshooting and expected success output are sufficient.
```

### Phase 3 - Codex Verification

Owner: Codex

Checks:

- Review script logic against issue requirements.
- Verify config path and schema against `agent/src/index.ts`.
- Run PowerShell dry-run.
- If user approves, run apply steps.
- Verify Ollama service/model/embedding/chat checks.
- Check git diff and confirm no unrelated changes.
- Write final issue comment summary.

## Current Local Changes

- Added `docs/reports/20260516-local-inference-infrastructure.md`.
- Added `tmp/local-inference-setup-issue.md`.
- Added this handoff file.

No installation, model download, or user config write has been performed.
