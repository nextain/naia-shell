# Distribution Troubleshooting

Build and runtime issues encountered during Naia OS development.

## pnpm Store Corruption

**Symptom**: `Invalid package config ... Unexpected end of JSON input` or `ERR_INVALID_PACKAGE_CONFIG` when running `pnpm dev` / `cargo tauri dev`. Multiple `package.json` files in `node_modules` are 0 bytes.

**Cause**: pnpm content-addressable store (`~/.local/share/pnpm/store/v10`) gets corrupted. pnpm uses hardlinks from store to `node_modules`, so corrupted store files produce 0-byte hardlinks on every subsequent `pnpm install`. Even `pnpm store prune` + `pnpm install --force` does NOT fix it — prune only removes orphans, not corrupted content files.

**Diagnosis**:
```bash
# Check for empty package.json in node_modules (should be 0)
find node_modules -name 'package.json' -empty | wc -l

# Check store corruption (should be ~0)
find ~/.local/share/pnpm/store/v10 -empty -type f | wc -l
```

**Fix**:
```bash
rm -rf ~/.local/share/pnpm/store/v10
rm -rf shell/node_modules agent/node_modules shell/src-tauri/target/debug/agent/node_modules
cd shell && pnpm install
cd agent && pnpm install
cd shell/src-tauri/target/debug/agent && CI=true pnpm install --shamefully-hoist
```

**Prevention**: If corruption recurs, use `node-linker=hoisted` to avoid hardlinks:
```bash
pnpm install --config.node-linker=hoisted
```
This copies files instead of hardlinking — immune to store corruption. Caution: hoisted layout allows phantom dependency access.

**Incident**: 2026-03-03 — 2300 empty files in store, affected shell + agent node_modules.

---

## Agent node_modules Missing ws

**Symptom**: agent-core crashes with `Cannot find package 'ws'` at startup. Path: `shell/src-tauri/target/debug/agent/node_modules/ws`

**Cause**: Bundled agent at `target/debug/agent/` uses pnpm default isolated node_modules. `ws` is an indirect dependency not hoisted to top level.

**Fix**:
```bash
cd shell/src-tauri/target/debug/agent
CI=true pnpm install --shamefully-hoist
```

> `--shamefully-hoist` is REQUIRED for bundled agent (indirect deps like ws, p-retry).

---

## Vite White Screen After cargo build

**Symptom**: App launches but shows white/blank screen.

**Cause**: Used `cargo build --release` instead of `npx tauri build --no-bundle`.

**Fix**: ALWAYS use `npx tauri build --no-bundle` (WebKitGTK asset protocol requires Tauri's build pipeline).

---

## Linux Release: `.deb` Builds But Fails At Runtime

**Symptom**: GitHub Actions Linux release job succeeds, but extracted `.deb` fails to launch with:
```text
error while loading shared libraries: libvosk.so: cannot open shared object file
```

**Cause**:
- Linux release workflow built with base Tauri config instead of `src-tauri/tauri.conf.linux.json`
- `libvosk.so` was not included in the packaged `.deb`
- CI only checked build completion, not packaged runtime linkage

**Fix**:
```bash
pnpm run tauri build --config src-tauri/tauri.conf.linux.json --bundles deb,rpm
```

Also ensure:
- `shell/src-tauri/tauri.conf.linux.json` includes `resources/libvosk.so`
- Linux rpath includes packaged library path (`$ORIGIN:$ORIGIN/../lib/Naia`)
- Release workflow smoke-tests the packaged `.deb` with `dpkg-deb -x` + `ldd`

**CI guard**:
```bash
dpkg-deb -x Naia-Shell-x86_64.deb linux-smoke
test -f linux-smoke/usr/lib/Naia/libvosk.so
ldd linux-smoke/usr/bin/naia-shell
```

**Incident**: 2026-05-22 — run `26265448860` failed at Linux smoke step with `libvosk.so missing from deb`.

---

## Windows: Gateway Mode Not Set

**Symptom**: `Gateway start blocked: set gateway.mode=local (current: unset)` after fresh WSL provisioning.

**Cause**: OpenClaw provisioning did not set `gateway.mode=local` in `/root/.openclaw/openclaw.json`.

**Fix**: Step 5 added to `provision_distro()` in `wsl.rs` — sets `gateway.mode=local` via node script during provisioning.

**Incident**: 2026-03-11

---

## Windows: restart_gateway Race Condition

**Symptom**: Gateway connection fails after Naia login — Gateway process killed mid-spawn.

**Cause**: Deep link auth triggers multiple `restartGateway()` calls without re-entrancy guard on the Rust side.

**Fix**: `compare_exchange` atomic guard on `restarting_gateway` AtomicBool (SeqCst). Guard released AFTER agent restart completes.

**Incident**: 2026-03-11

---

## Windows: Git Bash Path Conversion

**Symptom**: MSYS translates `/opt/naia/...` to `C:/Program Files/Git/opt/naia/...`.

**Fix**: Prefix commands with `MSYS_NO_PATHCONV=1`.

---

## Windows: pnpm Non-TTY Error

**Symptom**: `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` when running `pnpm install` in WSL.

**Fix**: `CI=true pnpm install`.

---

## Windows: .wslconfig localhostForwarding Deprecated

**Symptom**: Warning about `localhostForwarding` not applicable with `networkingMode=mirrored`.

**Fix**: Removed `localhostForwarding=true` from `config/defaults/wslconfig-template`.
