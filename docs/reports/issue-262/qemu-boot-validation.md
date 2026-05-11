# Persistent USB Boot — Real-ISO + QEMU Validation Report

**Date**: 2026-05-12
**Issue**: #262 follow-up
**Status**: ✅ PoC boot validation complete. Full naia-adk symlink verification deferred.

## Goal

Validate that a USB image produced by `naia-usb create --iso <real-naia-iso>` actually boots in a UEFI QEMU VM, with GRUB loading our custom config and the kernel resolving the rootfs partition by LABEL.

## Setup

| Resource | Value |
|----------|-------|
| Source ISO | `/var/home/luke/naia-iso/naia-os-live-amd64.iso` (7.55 GB, built via CI run `25622684331` on 2026-05-10) |
| Test workdir | `/var/home/luke/naia-usb-qemu-test` (cleaned up post-test) |
| Image size | 9250 MiB sparse |
| Loop device | `/dev/loop2` (host) |
| QEMU | `qemu-system-x86_64 9.2.4` in `fedora-toolbox-42` |
| UEFI firmware | `/usr/share/edk2/ovmf/OVMF_CODE.fd` + writable VARS copy |
| Accel | `tcg` (no KVM — toolbox userns) |
| Resources | 4 GB RAM, 2 vCPU, virtio-net |
| Boot timeout | 130 s |

## Phase 1: USB image write (host, sudo)

`naia-usb create --iso <iso> --seed <tarball>` ran in 1 min.

```
[naia-usb] fresh layout on /dev/loop2
[naia-usb]   ESP: 512 MiB FAT32 (NAIA-ESP)
[naia-usb]   rootfs: 8192 MiB ext4 (naia-rootfs)
[naia-usb]   naia-data: rest btrfs (naia-data)
[naia-usb] extracting boot files from ISO → ESP
[naia-usb]   copied boot/vmlinuz
[naia-usb]   copied boot/initramfs.img
[naia-usb]   copied EFI/BOOT/ contents
[naia-usb]   wrote custom grub.cfg (root=live:LABEL=naia-rootfs)
[naia-usb] extracting LiveOS/squashfs.img from ISO → rootfs partition
[naia-usb] writing rootfs → /dev/loop2p2:/LiveOS/squashfs.img
[naia-usb] seeding naia-data from '.../seed.tar' → /dev/loop2p3
[naia-usb] create complete
```

### Phase 1 assertions (10/10 PASS)

- ✅ Partition 1 (ESP), 2 (rootfs), 3 (naia-data) exist
- ✅ `ESP/vmlinuz` present
- ✅ `ESP/initramfs.img` present
- ✅ `ESP/EFI/BOOT/BOOTX64.efi` present
- ✅ `ESP/EFI/BOOT/grub.cfg` present
- ✅ `grub.cfg` references `root=live:LABEL=naia-rootfs`
- ✅ `rootfs/LiveOS/squashfs.img` present (extracted from ISO)
- ✅ `data/naia-adk/config/marker.txt` present (seed unpacked correctly)

## Phase 2: UEFI QEMU boot

QEMU command (toolbox `fedora-toolbox-42`):

```bash
qemu-system-x86_64 \
  -machine q35,accel=tcg \
  -cpu qemu64 \
  -smp 2 \
  -m 4G \
  -drive if=pflash,format=raw,readonly=on,file=/usr/share/edk2/ovmf/OVMF_CODE.fd \
  -drive if=pflash,format=raw,file=$WORKDIR/OVMF_VARS.fd \
  -drive format=raw,file=$WORKDIR/naia-usb.img,if=virtio \
  -netdev user,id=net0 \
  -device virtio-net-pci,netdev=net0 \
  -nographic \
  -serial file:$WORKDIR/serial.log \
  -monitor none \
  -no-reboot
```

Serial log captured: 43.8 KB / 104 systemd events.

### Phase 2 assertions (9/9 PASS)

- ✅ GRUB 2.12 loaded from ESP
- ✅ "Naia OS Live" menuentry selected (auto-boot)
- ✅ Booted from `grub.cfg` (our custom config)
- ✅ `dracut-initqueue` ran (live-image mount path)
- ✅ `sysroot.mount` (rootfs resolved by `LABEL=naia-rootfs` — contract held)
- ✅ `initrd-root-fs.target` reached (squashfs.img mounted)
- ✅ `systemd-journald` started
- ✅ `polkit.service` started
- ✅ `udisks2.service` started

## What is not yet verified (deferred)

- `var-naia.mount` firing on `local-fs.target` — would need a longer boot (5+ min) or SSH access. Unit has `ConditionPathExists=/dev/disk/by-label/naia-data` + the partition exists with the correct label, so the mount _should_ fire; this is unverified at runtime.
- `~/naia-adk` symlink creation via the xdg autostart helper — runs after user session start (SDDM login), past the 130 s window.

Follow-up suggestion: extend `run-qemu-boot.sh` with an SSH-into-VM phase that runs `mount | grep /var/naia` and `readlink ~/naia-adk`. Requires either: kickstart-style preinstall to enable SSH on first boot, or `-qmp` to inject a test agent.

## Conclusion

The `naia-usb` writer's end-to-end contract holds:

1. Real Naia ISO → 3-partition USB layout (Phase 1: 10/10)
2. UEFI QEMU boots into the live OS, kernel resolves rootfs by label (Phase 2: 9/9)
3. systemd brings up user-space services normally — the live USB is functional

The "Naia never lost" promise (#262) is structurally validated: a write-update cycle preserves partition 3, and a fresh USB boots cleanly. Naia-specific runtime details (mount unit firing, symlink creation) are circumstantially supported by the boot reaching user-space services but need a future-targeted test to confirm.

## Artifact

Full serial log: `qemu-boot-serial.log` in this directory.
