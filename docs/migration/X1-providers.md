# Migration X1 — `@nextain/agent-providers` adoption

**Phase**: 2 X1 (Strangler Fig — first provider extraction)
**Status**: integrated behind `NEXTAIN_AGENT_PROVIDERS=1` opt-in flag (default: native)
**Branch**: `migration/x1-anthropic-providers`

## Goal

naia-os agent consumes `@nextain/agent-providers/anthropic`'s
`AnthropicClient` instead of its own `src/providers/anthropic.ts`
implementation. This is the first Strangler Fig extraction.

## Current state

Adapter + factory hook are wired up. Native path remains the default.
The `@nextain` packages are consumed via vendored tgz tarballs in
`agent/vendor/` so that naia-os does not depend on an npm publish step
during the observation window:

- `agent/vendor/nextain-agent-types-0.1.0.tgz` — `pnpm pack` output from
  `naia-agent/packages/types`.
- `agent/vendor/nextain-agent-providers-0.1.0.tgz` — `pnpm pack` output
  from `naia-agent/packages/providers`. Its internal `"workspace:*"`
  reference to `@nextain/agent-types` is resolved via a pnpm override
  in `agent/package.json`:

  ```json
  "pnpm": {
    "overrides": {
      "@nextain/agent-types": "file:./vendor/nextain-agent-types-0.1.0.tgz"
    }
  }
  ```

  Without the override, pnpm would try to fetch `@nextain/agent-types`
  from the npm registry (404 — not published).

When `@nextain/agent-providers@0.1.0` is published to npm, switch the
`file:./vendor/*.tgz` deps back to semver ranges and drop the override.

## Approach

**Adapter pattern**, not replacement.

```
Existing:
  naia-os/agent/src/providers/anthropic.ts
    → native implementation over @anthropic-ai/sdk
    → returns naia-os `LLMProvider` shape (AgentStream / ChatMessage)

Target (X1):
  naia-os/agent/src/providers/adapters/nextain-provider-adapter.ts
    → wraps @nextain/agent-providers/anthropic::AnthropicClient
    → converts @nextain/agent-types shapes ↔ naia-os `LLMProvider` shape
    → pluggable via existing registry
```

When confidence is high, the native `anthropic.ts` is removed. Until
then, both coexist behind the same `LLMProvider` interface.

## Steps

1. ~~**Publish `@nextain/agent-providers@0.1.0`**~~ — deferred; consumed
   via vendored tgz instead (see *Current state*).
2. ✅ **Add dependency** in `agent/package.json`:
   ```json
   "@nextain/agent-providers": "file:./vendor/nextain-agent-providers-0.1.0.tgz",
   "@nextain/agent-types": "file:./vendor/nextain-agent-types-0.1.0.tgz"
   ```
   plus the `pnpm.overrides` block above.
3. ✅ **Implement adapter** in `agent/src/providers/adapters/nextain-provider-adapter.ts`:
   - Takes `AnthropicClient` instance
   - Exposes naia-os `LLMProvider` interface
   - Type-maps `LLMRequest` ↔ `ChatMessage[]`, `LLMStreamChunk` ↔ `AgentStream`
4. ✅ **Register in factory** (`src/providers/factory.ts`) behind opt-in
   env flag `NEXTAIN_AGENT_PROVIDERS=1`. Default stays on native.
5. **Run E2E** via `scripts/flatpak-reinstall-and-run.sh` + a live prompt
   through the adapter path with `NEXTAIN_AGENT_PROVIDERS=1`.
6. **Observe** per plan A.7. Watch for regressions.
7. **Flip default** once stable. Old `anthropic.ts` → `@deprecated` JSDoc.
8. **Remove native impl** in a follow-up migration PR after observation.

## How to toggle

```bash
# Opt in (adapter path)
NEXTAIN_AGENT_PROVIDERS=1 pnpm --filter naia-os-agent test

# Default (native path) — flag unset or ≠ "1"
pnpm --filter naia-os-agent test
```

## Rollback

`migration/*` PRs are single-PR reverts (plan A.9). If the adapter path
fails in Flatpak build or fails E2E, revert this branch's merge and the
native path continues working.

## Contract conformance

The migration's end state relies on these invariants from plan v6:

- **A.3** — `@nextain/agent-providers` depends only on
  `@nextain/agent-types` (peerDep: `@anthropic-ai/sdk`). No runtime
  import of naia-os code. **OK** (verified in naia-agent repo).
- **A.6** — LLM API keys: shell owns, injected via `HostContext.llm`
  construction. **OK** (unchanged from current shell behaviour).
- **A.11** — Providers emit usage via `HostContext.meter.counter`.
  `AnthropicClient` exposes `LLMResponse.usage` with input/output/cache
  tokens — host (adapter) forwards to meter.

## References

- naia-agent CHANGELOG: `@nextain/agent-providers@0.1.0`
- naia-agent ARCHITECTURE: `docs/ARCHITECTURE.md` §"Contract summary"
- Migration plan: `alpha-adk/.agents/progress/naia-4repo-migration-plan.md` §A.9 Strangler Fig, §A.10 MVM transition gate
