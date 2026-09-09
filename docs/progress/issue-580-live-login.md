# BC250 live login repair — #580

A fresh support4 USB has no `naia-data` partition. Although its persistent-home mount is disabled, logind discovers the native `var-home-liveuser.mount` through the session's home-path dependencies. The missing device times out, the session scope fails, and Plasma starts without the working login environment.

The USB-derived image reproduced `session-1.scope: ... result 'dependency'`, `pam_systemd(...): ... UnitAllocationFailed`, and `Could not create wayland socket` in QEMU. Masking only that mount and restarting Plasma Login Manager produced a valid seat0 Wayland session, KWin, Plasma Shell and the Naia start screen. The Discover/kres missing-file messages are nonfatal livesys warnings.

The fix installs a live-rootfs generator that masks the optional mount and dependent settings service when persistence is unavailable. Existing labeled media retain their original units and ordering. It also restores public readability of `image-info.json` after the hook's temporary-file replacement, and sets unlocked idle/resume defaults for new passwordless live users. Existing persisted homes keep their preferences.

Source and artifact identity:

- OS fix: `nextain/naia-os@2976c5f2d446e90475a63f2668242451d7a1c8b7`.
- Workflow baseline: `56240fc1b5794454e49df99186fd86db3303586d`.
- Embedded signed image remains `ghcr.io/nextain/naia-os-amd:candidate-bc250-0.2.3-13980895-support4` at `sha256:c57179418162829c62e725aad0e2b2d65340d9d44333db14e2300ba856669991`.
- New live ISO revision: `bc250-0.2.3-13980895-support5-livefix`. This identifies live-rootfs repairs; the installed image and AMD update reference are unchanged.

P01/P02: `UC-BC250-LIVE-INSTALL`, `UC-BC250-LIVE-PERSISTENCE`, `UC-BC250-LIVE-DELIVERY`. P03: `FR-BC250-LIVE.1`–`.3`. Source authority is the owner's original report and repair/USB instruction dated 2026-09-09; the issue tracks execution.

Validation:

| Check | Status |
|---|---|
| Original absent-device failure and mount-only causal intervention | Observed in QEMU |
| Actual generator, KDE session/bus/socket, readable metadata and live defaults | Passed on the fresh candidate; installed generator/checker hashes match tested source |
| Naia start screen on the KDE desktop | Captured from the fresh candidate |
| Hook, extracted generator, checker and generated candidate-hook syntax; conflict scan | Passed |
| Fresh candidate ISO boot and installer window | Passed: actual UEFI/default regular entry, Korean installer welcome and enabled Next button |
| Existing labeled home and sentinel across reboot | Passed: file hash and prior lock settings preserved across two distinct boot IDs |
| New ISO checksum and USB readback | Passed: all 8,492,503,040 USB bytes match the published/downloaded ISO SHA256 |
| Physical BC250 boot/install | Not observed; keep the issue open |

Candidate artifact: [support5-livefix ISO](https://pub-affd0538517845d98ce44a5aec11dd98.r2.dev/builds/amd/0.2.3.20260909T042604Z-13980895-support5-livefix/naia-os-bc250-0.2.3-13980895-support5-livefix-amd64.iso), [build receipt](https://pub-affd0538517845d98ce44a5aec11dd98.r2.dev/builds/amd/0.2.3.20260909T042604Z-13980895-support5-livefix/build-receipt.json). [Run 34310750809](https://github.com/nextain/naia-shell/actions/runs/34310750809) succeeded from workflow commit `93070f9afabe0596da77dbda1c40218449559cbe`.

The ISO is 8,492,503,040 bytes, SHA256 `6461112cb12b0bb611ef1f19fdf448595ee3b497b62230b4546fac3dca3d57bd`. The original USB copy differs from its published support4 image only in 12 disk-header bytes at offsets 528–563; normalizing those boundary bytes reproduces the complete published hash. The original copy was retained unchanged.

USB delivery completed at `2026-09-09T06:49:36Z`. The 31,683,870,720-byte USB disk 1 was reidentified as non-system before writing. Initial Windows direct-write attempts failed; clearing its old partition metadata, then using page-aligned unbuffered I/O, completed the write and full readback. The previous relocated backup GPT at the USB tail was cleared and verified zero. `usb-write-receipt.json` records matching ISO/readback hashes and PASS. Disk 0 was not written. The USB is ready for physical BC250 testing; no installed-system or hardware boot PASS is claimed.

Original-session runtime evidence includes: `candidate-none-runtime.json`, `candidate-present-first-runtime.json`, `candidate-present-reboot-runtime.json`, and desktop/installer PNGs. The persistent boot IDs were `6a8b1be9-bc0c-452a-8f84-d573637c00e9` and `970c140f-195e-44fa-84a1-2d281864f21f`; sentinel SHA256 remained `95d0313501f1ffec611d862b07a470b064108fbd10e540302b5c341436bd5cd2`. The runner reported a transport timeout only after all checks passed, while polling the requested VM poweroff; this cleanup warning is recorded separately from successful runtime checks.

Independent review was attempted with the configured Codex adapter in four planning roles; every invocation returned `NOT_RUN` because the CLI was unavailable. It is not counted as cross-validation. Deterministic complexity reports WARN for the existing 715-line hook after 33 added lines, below required-refactor thresholds; the bounded self-contained hook change was reviewed locally.

A separate pre-existing `bazzite-user-setup` syntax error was observed in the original image. It is not the demonstrated login blocker and has not been attributed or patched here. Candidate publication does not promote `latest`. Physical hardware results must remain distinct from VM evidence.


## Continue on another PC

Both repositories use branch `build/bc250-install-20260908`:

```sh
git clone --branch build/bc250-install-20260908 https://github.com/nextain/naia-shell.git
git clone --branch build/bc250-install-20260908 https://github.com/nextain/naia-os.git
```

Read this document and [portable validation receipts](issue-580-delivery-evidence.json) before continuing. The ISO is already published at the link above; downloading it avoids a duplicate build. Verify its byte count and SHA256 before use. The prior Windows USB write/readback is historical evidence for that device, not authority to select a disk on another PC. Reidentify the intended removable device if another USB must be prepared.

Next verify the physical BC250 normal boot, KDE desktop/login, and installer. Record installation outcome separately; installer welcome visibility in QEMU is not proof of a completed installation. Check persistence after a real reboot when applicable. Keep #580 open until the relevant hardware results are observed.

If an identical candidate must be rebuilt, use `.github/workflows/naia-os-iso.yml` on this branch with `image_layer_ref=2976c5f2d446e90475a63f2668242451d7a1c8b7`, `candidate_tag=candidate-bc250-0.2.3-13980895-support4`, and `candidate_digest=sha256:c57179418162829c62e725aad0e2b2d65340d9d44333db14e2300ba856669991`. No workflow dispatch is performed by this handoff.
