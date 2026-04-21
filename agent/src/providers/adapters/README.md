# Providers / adapters

Adapter shims that bridge external provider libraries to naia-os' internal
`LLMProvider` interface.

## Current

_None yet — X1 scaffolded on branch `migration/x1-anthropic-providers` but
not yet landed. See `docs/migration/X1-providers.md`._

## Planned

- `nextain-provider-adapter.ts` — wraps `@nextain/agent-providers`'
  `LLMClient` implementations (`AnthropicClient`, future OpenAI/Google)
  behind naia-os' `LLMProvider` interface. Allows Strangler Fig
  replacement of native `providers/anthropic.ts` without breaking the
  registry contract.
