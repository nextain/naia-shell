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

Validation at the source checkpoint:

| Check | Status |
|---|---|
| Original absent-device failure and mount-only causal intervention | Observed in QEMU |
| Actual generator, KDE session/bus/socket, readable metadata and live defaults | Runtime checker passed on the repaired original VM |
| Naia start screen on the KDE desktop | Captured |
| Hook, extracted generator, checker and generated candidate-hook syntax; conflict scan | Passed |
| Fresh candidate ISO boot and installer window | Pending |
| Existing labeled home and sentinel across reboot | Pending |
| New ISO checksum and USB readback | Pending |
| Physical BC250 boot/install | Not observed; keep the issue open |

Independent review was attempted with the configured Codex adapter in four planning roles; every invocation returned `NOT_RUN` because the CLI was unavailable. It is not counted as cross-validation. Deterministic complexity reports WARN for the existing 715-line hook after 33 added lines, below required-refactor thresholds; the bounded self-contained hook change was reviewed locally.

A separate pre-existing `bazzite-user-setup` syntax error was observed in the original image. It is not the demonstrated login blocker and has not been attributed or patched here. Candidate publication does not promote `latest`. Physical hardware results must remain distinct from VM evidence.
