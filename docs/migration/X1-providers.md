# Migration X1 — `@nextain/agent-providers` adoption

**Phase**: 2 X1 (Strangler Fig — first provider extraction)
**Status**: scaffolded, awaiting `@nextain/agent-providers@0.1.0` publish
**Branch**: `migration/x1-anthropic-providers`

## Goal

naia-os agent consumes `@nextain/agent-providers/anthropic`'s
`AnthropicClient` instead of its own `src/providers/anthropic.ts`
implementation. This is the first Strangler Fig extraction.

## Blocker

`@nextain/agent-providers@0.1.0` is shape-ready and CI-green (in
`nextain/naia-agent`) but not yet published to npm. See migration plan
A.10 MVM #2 / Phase 1 T1–T8 completion (commit `69507d8`).

Until publish:
- Local dev via `npm install file:../../naia-agent/packages/providers`
  is possible but breaks naia-os CI (workspace path assumption).
- Not used on this branch.

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

1. **Publish `@nextain/agent-providers@0.1.0`** — blocker.
2. **Add dependency** in `agent/package.json`:
   ```json
   "@nextain/agent-providers": "^0.1.0",
   "@nextain/agent-types": "^0.1.0"
   ```
3. **Implement adapter** in `agent/src/providers/adapters/nextain-provider-adapter.ts`:
   - Takes `AnthropicClient` instance
   - Exposes naia-os `LLMProvider` interface
   - Type-maps `LLMRequest` ↔ `ChatMessage[]`, `LLMStreamChunk` ↔ `AgentStream`
4. **Register in factory** (`src/providers/factory.ts`) behind an opt-in
   flag (env var or config key) initially.
5. **Run E2E** via `scripts/flatpak-reinstall-and-run.sh` + a live prompt
   through the adapter path.
6. **Observe 24h** per plan A.7 (solo dev self-discipline). Watch for
   regressions.
7. **Flip default** once stable. Old `anthropic.ts` → `@deprecated` JSDoc.
8. **Remove native impl** in a follow-up migration PR after 2 week
   observation.

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
