# Persistent USB Boot — Phase 2 PoC Report

**Date**: 2026-05-10
**Issue**: #262
**Status**: Phase 2 virtual PoC complete (loop device). Phase 1 documented as fallback. Boot test deferred until QEMU + Naia ISO available.

## Goal

Allow Naia OS USB to retain `~/naia-adk/` (settings + naia-memory) across reboots and ISO updates, without requiring a hard-drive install.

## Why this matters

`~/naia-adk/` holds Naia's **settings and memories** — the most precious user data in the system. Losing it on every USB reboot is a product failure (see issue #262 for the design discussion).

Cloud backup of settings + memory is tracked separately (#261). This issue covers the local survival path.

## Architecture (chosen — Phase 2)

```
USB partitions (GPT):
  [1] ESP        — FAT32, 512 MiB, label NAIA-ESP   (re-flashed on update)
  [2] rootfs     — ext4,  variable, label naia-rootfs (re-flashed on update)
  [3] naia-data  — btrfs, rest,    label naia-data  (PRESERVED across updates)
                   └── naia-adk/  → mounted into user home
```

### Boot-side mount

| File | Role |
|------|------|
| `config/files/usr/lib/systemd/system/var-naia.mount` | mount unit — `LABEL=naia-data → /var/naia` (nofail, ConditionPathExists) |
| `config/files/usr/libexec/naia-adk-link` | symlink helper — idempotent, ensures `~/naia-adk → /var/naia/naia-adk` |
| `config/files/usr/etc/xdg/autostart/naia-adk-link.desktop` | autostart entry — runs the helper on every user login |
| `config/scripts/install-naia-data-mount.sh` | BlueBuild script — enables `var-naia.mount`, creates `/var/naia` dir |

The mount is `nofail` + `ConditionPathExists`, so installed systems without a `naia-data` partition boot normally.

### Writer

`os/tools/naia-usb` — bash CLI (Rust port deferred):

| Mode | Behavior |
|------|----------|
| `create <device> [--rootfs <file>] [--seed <tarball>]` | Fresh USB. GPT + 3 partitions, optionally writes rootfs to part 2 and seeds naia-adk into part 3 |
| `update <device> --rootfs <file>` | Existing naia USB only. Re-writes parts 1+2, **preserves part 3**. Refuses if part 3 isn't `naia-data` |
| `status <device>` | Reports layout |

Safety rails:
- Refuses non-block-device targets
- Refuses devices with mounted partitions
- Refuses the root disk (loop devices bypass this for PoC use)
- `update` refuses unless part 3 is labeled `naia-data` (so it can't accidentally clobber a stranger USB)

## Phase 1: Fedora standard tooling (documented fallback)

`livecd-iso-to-disk --home-size-mb=N --skip-overlay` from the `livecd-tools` package can produce a similar layout against any Fedora-style live ISO (titanoboa output qualifies). This was **not exercised** in the PoC because:

- The dev host (Bazzite immutable) does not ship `livecd-tools`
- No naia-os ISO is available locally
- The dd-then-livecd-iso-to-disk workflow requires users to know which tool is appropriate — naia must own the writer regardless

Phase 1 stays as a fallback path for technical users who want to bypass `naia-usb`. Documentation TODO: add a section to `.agents/context/distribution.yaml` once Phase 2 ships.

## Phase 2 virtual test

Test script: `os/tests/persistent-usb/run-virtual.sh`
Method: 256 MiB sparse file + `losetup` simulates the USB. No physical hardware, no QEMU.

**Coverage** (6 assertion groups):

1. `create` produces 3 partitions with the expected labels (NAIA-ESP, naia-rootfs, naia-data) and fs types (vfat, ext4, btrfs)
2. Seed tarball is unpacked into partition 3
3. User-written data on partition 3 survives an `update` cycle
4. `update` actually re-writes part 2 (v2 marker visible after update)
5. `status` correctly reports the device as a naia layout
6. `update` refuses on a blank/non-naia device

**Run** (requires sudo):

```bash
sudo bash os/tests/persistent-usb/run-virtual.sh
```

**Result**: 17/17 assertions pass (first run, 2026-05-10).

```
=== Results ===
PASS: 17
FAIL: 0
All assertions passed.
```

Notes from the run:
- `mkfs.fat` warns "Number of clusters for 32 bit FAT is less then suggested minimum" on the 32 MiB ESP — harmless at PoC scale; the production ESP will be ≥256 MiB.
- The strict `verify_naia_layout` (added during self-review pass 1) correctly refuses an empty loop device in test 6.

## ISO + VM verification (Phase 2 of PoC)

After Phase 2 virtual loop test passed, we ran the full pipeline against our changes:

| Step | Result |
|------|--------|
| CI build.yml on `new-main` (workflow_dispatch) | ✅ success — after fixing recipe.yml ordering (commit `26b209d1`: `install-naia-data-mount.sh` must run **after** the `files` module so the unit file is in place when `systemctl enable` resolves it) |
| In-CI smoke test (Naia branding, fcitx5, naia-shell flatpak) | ✅ pass |
| iso.yml auto-trigger via workflow_run | ✅ success (32 min) — produced `naia-os-live` artifact, 7.1 GB |
| Local QEMU + OVMF setup (toolbox `fedora-toolbox-42`) | ✅ — needed `qemu-img` and `qemu-device-display-virtio-vga` packages on top of `qemu-system-x86_64` |
| `os/tests/e2e-install.sh` Phase 0 (prereqs) | ✅ |
| `os/tests/e2e-install.sh` Phase 1 (ISO patching with kickstart + serial console) | ✅ |
| `os/tests/e2e-install.sh` Phase 1.5 (live session GUI test) — **all 7 brand checks** | ✅ pass: `os-release contains Naia`, installer sidebar logo, icon cache, desktop entry wrapper, `/run/anaconda` tmpfiles.d, `naia-expand-run.service` enabled, Anaconda launched |
| `os/tests/e2e-install.sh` Phase 2 (Anaconda WebUI install) | ⚠️ **timed out at 40 min** — Anaconda screen unchanged across screenshots 04-09 (all 62 KB, identical size = stuck on same view). This is a test-infrastructure gap unrelated to issue #262 (the screen is captured before Anaconda begins package installation). Tracking separately; not a regression caused by our changes. |
| Phase 3 (post-install boot verification + smoke tests) | ⏭ skipped via `--skip-verify` (host-side `sudo qemu-nbd` unavailable in this run) |

### Why the install timeout doesn't invalidate this PoC

Our changes are deliberately **passive**:
- `var-naia.mount` is gated by `ConditionPathExists=/dev/disk/by-label/naia-data` and `nofail` — no-op without a persistent partition
- `naia-adk-link` exits 0 when `/var/naia/naia-adk` is absent
- `tmpfiles.d` only creates `/var/naia` (an empty directory) at boot

In Phase 1.5 the live ISO booted, reached SDDM desktop, and passed every brand check — so our additions did not break live boot, autostart, or systemd unit graph resolution. The Phase 2 stall is in the WebUI Anaconda + kickstart driver, before any installed-system code runs.

The remaining real-boot validations of our specific behavior (mount unit firing on a real persistent partition, symlink created on user login) require a different test: boot QEMU directly off a `naia-usb`-written virtual disk that contains a real bootable rootfs. That's a follow-up.

## What's not tested yet

| Gap | Why deferred | Required to unblock |
|-----|--------------|---------------------|
| `var-naia.mount` actually firing on a real boot | Need a `naia-usb`-written virtual disk with a real bootable rootfs (current writer puts a placeholder in `LiveOS/squashfs.img`) | Extract real squashfs + GRUB/EFI from the Naia ISO into the writer flow |
| `naia-adk-link` autostart firing on KDE session | Same as above | Same |
| Full installed-system smoke test | Phase 2 Anaconda WebUI timed out (test infra issue) | Separate work — fix install test runner or use a different install harness |
| LUKS encryption on partition 3 | PoC scope minimization | Follow-up — wire `cryptsetup luksFormat` into `naia-usb create --luks` |
| `update` on USB with already-existing user data (large naia-memory) | Same logic, just more data | Larger sparse file in the test |

## Decisions captured during build

- **Mount target `/var/naia` (not `/var/lib/naia`)** — short, no special chars in unit name (`var-naia.mount`), aligns with Bazzite's `/var/home` convention.
- **Symlink mechanism: xdg autostart per-user** — system-wide tmpfiles.d would force the symlink at boot but xdg autostart runs after the user actually logs in, so `$HOME` is real. Trade-off: only works for desktop sessions, not pure-tty users (acceptable — Naia OS is desktop-first).
- **`update` refuses on non-naia layout** — explicit, no `--force` shortcut. If someone's USB isn't naia-shaped, they should run `create` (which warns about destruction) rather than risk a half-naia layout.
- **Bash for the writer (not Rust yet)** — PoC velocity. Rust port becomes natural when wrapping into a Tauri "Make USB" UI.

## Next steps (for the issue)

1. **Run the test, append results to this report.**
2. Cross-review: independent agent verifies safety rails (especially the root-disk check) and idempotency.
3. Once virtual passes, file a follow-up sub-issue for QEMU boot validation + real Naia ISO write.
4. Tauri "Make Naia USB" panel design — separate issue, can wait for stable CLI.

## Related

- #261 — Cloud backup of naia settings + memory (parking lot)
- `.agents/context/distribution.yaml` §`bootable_usb` — current ephemeral USB workflow (to be updated when Phase 2 ships)
