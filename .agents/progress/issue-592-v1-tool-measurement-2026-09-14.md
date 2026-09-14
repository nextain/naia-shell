# #592 V1 Tool-Call Measurement

- Status: in progress
- Device: `naia3090`
- Queue item: `naia-shell-592-v1-tool-measurement-0.2.3`, attempt 4; live attempt blocked before start
- Product branch: `issue/592-v1-tool-measurement`
- Product baseline: `2941e3b4ac644cffb5be93d72991bb8e9e81f0d0`, `packages/shell` version `0.2.3`
- Paired Agent: `1c2561db486c24c31d10ddbef5ca5f0ff766c7ad`
- P01/P02/P03: recorded in `docs/user-scenarios.md` and `docs/requirements.md`
- Implementation: `scripts/measure-agent-tool-calling.mjs` and its Node test
- Deterministic validation: rerun 2026-09-14T06:20:27Z; assembly coverage passed (S 69 / UC 20), measurement harness passed (12/12), syntax and dry-run passed, workspace typecheck passed, and `git diff --check` passed. Root structure remains blocked by pre-existing `tmp/`, `.local/`, and `tsconfig.build.json`. Full Shell tests were not rerun because the approved credential remained absent.
- Harness hardening: strict child environment allowlist; exact paired Agent build plus compiled/source digests; full Shell app catalog with `listSkills` verification; correlated successful tool-result gate; setup/gateway/tool-execution/follow-up classification; complete redaction; atomic `docs/regression-runs/` output
- Known baseline validation limits: root structure reports pre-existing `tmp/` and `tsconfig.build.json`; Shell baseline has existing full-test failures and a pre-existing WebGPU type error in the production build
- Live boundary: `NAIA_API_KEY` is accepted only from the owner-provided process environment and is never written to evidence; the variable was absent, so the runner failed closed before starting Agent or sending a gateway request. The adjacent Agent checkouts were also not pinned and clean; no build was attempted.
- Redacted blocker receipts: `docs/regression-runs/naia3090-2026-09-14T04-53-57Z-592-tool-calling-blocked.json`, `docs/regression-runs/naia3090-2026-09-14T06-07-12Z-592-tool-calling-blocked.json`, `docs/regression-runs/naia3090-2026-09-14T06-15-20Z-592-tool-calling-blocked.json`, `docs/regression-runs/naia3090-2026-09-14T06-20-27Z-592-tool-calling-blocked.json`

The owner-keyed live receipt and independent review remain blocked by the absent approved process credential. P05 remains pending. No alternate local credential source was inspected or used. The exact current blocker is: approved owner-provided `NAIA_API_KEY` is absent from the process environment, and no adjacent Agent checkout is both pinned to `1c2561db486c24c31d10ddbef5ca5f0ff766c7ad` and clean.
