# conform gate — contract↔code drift detection (deterministic, 0 tokens)

Catches the **false-success class**: code that passes surface gates while
diverging from its declared contract (signature-drift / contract-only /
code-only). Judge = pure-Python oracle (no LLM, no tokens). Mirrors
`verify-contract-conformance` in naia-adk.

## Configure (per project)
Edit `manifest.json` → add your contract(header)/code(source) regions. **Empty =
inert** (safe for a fresh project). `expect` = known symbols the extractor MUST
recover (sanity gate, so an empty parse can't masquerade as drift 0). The bundled
`extract()` parses C; for another language, replace it — oracle/loop/sanity are
language-agnostic.

## How it breaks the agent loop
`.agents/hooks/conform-gate.js` (PostToolUse Edit|Write) runs the check on the
edited region:
- **clean** → silent · **drift** (1..2) → `systemMessage` nudge · **halt** (≥3
  unresolved edits) → `block`. The signal comes from OUTSIDE the agent's loop so
  a drifted agent can't keep flailing. Reconciling resets the region counter.

## Use
```
python3 scripts/conform/check.py --all              # sweep
python3 scripts/conform/check.py --file <path>      # one region (hook mode)
```
Register the hook: add to `.claude/settings.json` PostToolUse Edit|Write:
`node .agents/hooks/conform-gate.js`. Loop state: `.tmp/conform-state.json` (gitignored).
