# macOS Universal Binary and launch readiness

## Goal

Produce one reproducible Naia macOS application containing both `x86_64` and
`arm64` slices, while preserving the existing single-architecture installer
paths and recording the exact boundary between local verification and
Apple-Silicon/App-Store-only validation.

## Verified baseline (2026-08-27)

- The platform matrix declares Node archives for both Darwin `x64` and `arm64`.
- The regular installer workflow builds only on an `arm64` macOS runner and
  explicitly asserts that runner architecture.
- The packaging flow emits architecture-specific `.app` and `.dmg` artifacts;
  it does not currently produce one Universal Binary application.
- The available local machine is macOS 14.6.1 on Intel `x86_64`. It has Apple
  Command Line Tools, but initially has no Rust toolchain, Apple signing
  identity, or complete JavaScript dependency cache.

## Scope

1. Make the existing Intel build pass and launch on the current Mac.
2. Add deterministic `x86_64` and `arm64` build inputs and a Universal Binary
   assembly path.
3. Verify every shipped Mach-O executable: common runtime paths must have both
   slices, while explicitly architecture-scoped runtime payload paths may carry
   only their matching slice.
4. Preserve the existing per-architecture app/DMG build path.
5. Run arm64 and Universal artifact validation in macOS CI.
6. Document signing, Apple-Silicon runtime, sandbox, and App Store Connect work
   that requires hardware or credentials unavailable to CI/local automation.

## Acceptance criteria

- [x] Intel `x86_64` app bundle builds and launches on the current Mac (agent-core and BGM handshake; two bundled-Node observations).
- [x] Both Rust targets are installed locally and CI selects architecture-matched bundled Node runtimes.
- [x] A deterministic Universal `.app` assembly and rejection path is implemented; CI execution is pending.
- [x] The recursive verifier requires common-path Mach-O files to be Universal and permits matching thin slices only in explicitly architecture-scoped payload paths.
- [x] Existing single-architecture build paths remain present; full CI regression is pending.
- [x] CI is configured to archive and verify the Universal artifact; a real workflow run is pending.
- [x] Apple Silicon execution and Mac App Store blockers are reported without
      unsupported completion claims.

## Local evidence

- `pnpm -C packages/shell run tauri:build:bundle`: Intel `.app` built; DMG
  creation alone timed out in Finder AppleScript (`-1712`).
- Installed-bundle smoke: PASS for agent-core gRPC, BGM, and two bundled Node
  observations under the app resource directory.
- Universal assembly and installer matrix tests: 61 PASS on the integrated
  `main` snapshot; root contracts: 231 PASS; CI is configured to
  launch the resulting Universal app on both Intel and Apple Silicon runners.
- Frontend production build and workflow YAML parse: PASS.
- Full Shell suite on the integrated `main` snapshot: 1,689 PASS, 21 skipped,
  and five pre-existing Windows-only VoxCPM2 staging tests failed because they
  invoke `tar.exe` on macOS (`spawnSync` status `null`). The Universal-focused
  tests are unaffected and pass independently.
- Repository structure check reports the pre-existing ignored root
  `tsconfig.build.json`; it was not modified or removed.

## Known external completion boundary

Apple Silicon runtime testing requires Apple Silicon hardware or a trusted
arm64 runner. Mac App Store submission additionally requires an Apple Developer
team, distribution certificate, provisioning profile, App Sandbox-compatible
product behavior, App Store Connect registration, and an explicit upload step.

## AI operator handoff

Mac App Store 샌드박스 작업: [mac-app-store-sandbox.md](mac-app-store-sandbox.md).

Use this section as the entrypoint for later macOS development and release work.

1. Read `README.md`, `.agents/context/process-status.json`, this file,
   `packages/shell/src-tauri/platform-matrix.json`, and
   `.github/workflows/build-installers.yml` before changing packaging.
2. Build one architecture with
   `pnpm -C packages/shell run tauri:build:bundle`. Do not invoke plain
   `tauri build`; the generated configuration owns staged runtime resources.
3. Validate assembly logic with
   `pnpm -C packages/shell exec vitest run scripts/__tests__/assemble-macos-universal.test.ts scripts/__tests__/platform-matrix.test.ts`.
4. Treat `assemble-macos-universal.mjs` as the Universal bundle contract:
   common-path Mach-O files require both slices, and only explicit
   architecture-dispatch payload paths may retain one matching thin slice.
5. Before a release claim, require actual CI execution on Intel and Apple
   Silicon runners plus installed-app smoke evidence. Local Intel evidence does
   not establish Apple Silicon runtime behavior.
6. Keep code signing, notarization, App Sandbox compatibility, App Store
   Connect upload, and updater signing as separate credentialed release gates.
   Never infer their completion from an unsigned CI artifact.
