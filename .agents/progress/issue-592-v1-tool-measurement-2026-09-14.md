# #592 V1 Tool-Call Measurement

- Status: in progress
- Device: `naia3090`
- Queue item: `naia-shell-592-v1-tool-measurement-0.2.3`, attempt 1
- Product branch: `issue/592-v1-tool-measurement`
- Product baseline: `2941e3b4ac644cffb5be93d72991bb8e9e81f0d0`, `packages/shell` version `0.2.3`
- Paired Agent: `1c2561db486c24c31d10ddbef5ca5f0ff766c7ad`
- P01/P02/P03: recorded in `docs/user-scenarios.md` and `docs/requirements.md`
- Implementation: `scripts/measure-agent-tool-calling.mjs` and its Node test
- Deterministic validation: 8 tests passed; dry-run plan passed; no live gateway request was made
- Known baseline validation limits: root structure reports pre-existing `tmp/` and `tsconfig.build.json`; Shell baseline has existing full-test failures and a pre-existing WebGPU type error in the production build
- Live boundary: `NAIA_API_KEY` is accepted only from the owner-provided process environment and is never written to evidence

The live receipt and independent review remain pending.
