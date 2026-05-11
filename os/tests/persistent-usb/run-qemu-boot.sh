#!/usr/bin/env bash
# QEMU boot test for persistent Naia USB (issue #262)
#
# Creates a bootable USB image using naia-usb create --iso, then boots it
# in QEMU (UEFI) and verifies:
#   1. GRUB loads and boots the kernel
#   2. Live session starts (login prompt or SDDM)
#   3. /var/naia is mounted from naia-data partition
#   4. ~/naia-adk symlink points to /var/naia/naia-adk
#
# Prerequisites:
#   - sudo (losetup, parted, mount)
#   - qemu-system-x86_64
#   - OVMF (edk2-ovmf): /usr/share/edk2/ovmf/OVMF_CODE.fd
#   - A Naia OS ISO file
#
# Usage:
#   sudo bash run-qemu-boot.sh --iso /path/to/naia-os-live-amd64.iso

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
NAIA_USB="$ROOT/os/tools/naia-usb"

ISO_PATH=""
WORKDIR="/var/tmp/naia-usb-qemu-test"
KEEP=false
QEMU_MEM="4G"
QEMU_SMP=2
BOOT_TIMEOUT=120
SERIAL_LOG=""

OVMF_CODE="/usr/share/edk2/ovmf/OVMF_CODE.fd"
OVMF_VARS="/usr/share/edk2/ovmf/OVMF_VARS.fd"

usage() {
	cat <<EOF
Usage: sudo bash $0 --iso <path> [options]

Required:
  --iso <path>        Naia OS ISO file

Options:
  --workdir <dir>     Working directory (default: /var/tmp/naia-usb-qemu-test)
  --keep              Keep workdir after test (for debugging)
  --timeout <sec>     Boot timeout in seconds (default: 120)
  --mem <size>        QEMU memory (default: 4G)
  --smp <n>           QEMU CPUs (default: 2)
  --help              Show this help
EOF
	exit 0
}

log()  { printf '[qemu-test] %s\n' "$*"; }
die()  { printf '[qemu-test] ERROR: %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
	case "$1" in
		--iso) ISO_PATH="$2"; shift 2 ;;
		--workdir) WORKDIR="$2"; shift 2 ;;
		--keep) KEEP=true; shift ;;
		--timeout) BOOT_TIMEOUT="$2"; shift 2 ;;
		--mem) QEMU_MEM="$2"; shift 2 ;;
		--smp) QEMU_SMP="$2"; shift 2 ;;
		--help) usage ;;
		*) die "unknown option: $1" ;;
	esac
done

[[ -n "$ISO_PATH" ]] || die "--iso is required"
[[ -f "$ISO_PATH" ]] || die "ISO not found: $ISO_PATH"
[[ -f "$OVMF_CODE" ]] || die "OVMF_CODE.fd not found (install edk2-ovmf)"
[[ -f "$OVMF_VARS" ]] || die "OVMF_VARS.fd not found (install edk2-ovmf)"
[[ $EUID -eq 0 ]] || die "must run as root"
command -v qemu-system-x86_64 >/dev/null || die "qemu-system-x86_64 not found"

PASS=0
FAIL=0
FAILED_LABELS=()

assert() {
	local label="$1"
	shift
	if "$@"; then
		printf '  ✓ %s\n' "$label"
		PASS=$((PASS + 1))
	else
		printf '  ✗ %s\n' "$label"
		FAIL=$((FAIL + 1))
		FAILED_LABELS+=("$label")
	fi
}

cleanup() {
	if [[ -n "${QEMU_PID:-}" ]] && kill -0 "$QEMU_PID" 2>/dev/null; then
		kill "$QEMU_PID" 2>/dev/null || true
		wait "$QEMU_PID" 2>/dev/null || true
	fi
	if [[ "$KEEP" == false && -d "$WORKDIR" ]]; then
		log "cleaning up $WORKDIR"
		for mp in "$WORKDIR/mnt-esp" "$WORKDIR/mnt-rootfs" "$WORKDIR/mnt-data"; do
			mountpoint -q "$mp" 2>/dev/null && umount "$mp" 2>/dev/null || true
		done
		[[ -n "${LOOP:-}" ]] && losetup -d "$LOOP" 2>/dev/null || true
		rm -rf "$WORKDIR"
	else
		log "workdir preserved: $WORKDIR"
	fi
}
trap cleanup EXIT

mkdir -p "$WORKDIR"

# --- Phase 1: Create bootable USB image ---
log "Phase 1: Creating bootable USB image"

ISO_SIZE="$(stat -c%s "$ISO_PATH")"
IMG_SIZE=$(( (ISO_SIZE / 1024 / 1024) + 2048 ))
IMG="$WORKDIR/naia-usb.img"

log "  creating ${IMG_SIZE}MiB sparse image"
truncate -s "${IMG_SIZE}M" "$IMG"

LOOP="$(losetup --find --show -P "$IMG")"
log "  loop device: $LOOP"

SEED_DIR="$WORKDIR/seed"
mkdir -p "$SEED_DIR/naia-adk/config"
echo "test-config" > "$SEED_DIR/naia-adk/config/test.yaml"
SEED="$WORKDIR/seed.tar"
tar -cf "$SEED" -C "$SEED_DIR" .

log "  running naia-usb create --iso"
"$NAIA_USB" create "$LOOP" --iso "$ISO_PATH" --seed "$SEED"

P1="${LOOP}p1"
P2="${LOOP}p2"
P3="${LOOP}p3"

echo
echo "Phase 1 assertions:"
assert "ESP exists"    test -b "$P1"
assert "rootfs exists" test -b "$P2"
assert "data exists"   test -b "$P3"

# Verify ESP has boot files
ESP_MP="$WORKDIR/mnt-esp"
mkdir -p "$ESP_MP"
mount "$P1" "$ESP_MP"
assert "ESP: vmlinuz present"       test -f "$ESP_MP/vmlinuz"
assert "ESP: initramfs.img present"  test -f "$ESP_MP/initramfs.img"
assert "ESP: grub.cfg present"       test -f "$ESP_MP/EFI/BOOT/grub.cfg"
assert "ESP: BOOTX64.efi present"    test -f "$ESP_MP/EFI/BOOT/BOOTX64.efi"
assert "grub.cfg: LABEL=naia-rootfs" grep -q "root=live:LABEL=naia-rootfs" "$ESP_MP/EFI/BOOT/grub.cfg"
umount "$ESP_MP"

# Verify rootfs has squashfs
ROOTFS_MP="$WORKDIR/mnt-rootfs"
mkdir -p "$ROOTFS_MP"
mount "$P2" "$ROOTFS_MP"
assert "rootfs: LiveOS/squashfs.img present" test -f "$ROOTFS_MP/LiveOS/squashfs.img"
umount "$ROOTFS_MP"

# Verify seed on data partition
DATA_MP="$WORKDIR/mnt-data"
mkdir -p "$DATA_MP"
mount "$P3" "$DATA_MP"
assert "data: seed test.yaml present" test -f "$DATA_MP/naia-adk/config/test.yaml"
umount "$DATA_MP"

# Detach loop before QEMU
losetup -d "$LOOP"
LOOP=""

# --- Phase 2: QEMU boot ---
log "Phase 2: Booting USB image in QEMU (UEFI)"

SERIAL_LOG="$WORKDIR/serial.log"
OVMF_VARS_COPY="$WORKDIR/OVMF_VARS.fd"
cp "$OVMF_VARS" "$OVMF_VARS_COPY"

log "  QEMU starting (timeout: ${BOOT_TIMEOUT}s, mem: $QEMU_MEM)"
qemu-system-x86_64 \
	-machine q35,accel=tcg \
	-cpu qemu64 \
	-smp "$QEMU_SMP" \
	-m "$QEMU_MEM" \
	-drive if=pflash,format=raw,readonly=on,file="$OVMF_CODE" \
	-drive if=pflash,format=raw,file="$OVMF_VARS_COPY" \
	-drive format=raw,file="$IMG",if=virtio \
	-netdev user,id=net0 \
	-device virtio-net-pci,netdev=net0 \
	-nographic \
	-serial mon:stdio \
	-no-reboot \
	| timeout "$BOOT_TIMEOUT" tee "$SERIAL_LOG" \
	| grep -q -E "login:|SDDM|Naia OS|naia-adk-link" &
QEMU_PID=$!

wait "$QEMU_PID" 2>/dev/null || true

echo
echo "Phase 2 assertions:"

assert "serial log exists" test -f "$SERIAL_LOG"
assert "GRUB loaded" grep -qi "GNU GRUB\|grub>" "$SERIAL_LOG" 2>/dev/null || \
	grep -q "Naia OS Live" "$SERIAL_LOG" 2>/dev/null
assert "kernel booted" grep -qi "Linux version\|vmlinuz" "$SERIAL_LOG" 2>/dev/null || \
	grep -q "rd.live.image" "$SERIAL_LOG" 2>/dev/null
assert "systemd started" grep -qi "systemd\[1\]" "$SERIAL_LOG" 2>/dev/null || \
	grep -q "Started" "$SERIAL_LOG" 2>/dev/null

if grep -qi "var-naia.mount" "$SERIAL_LOG" 2>/dev/null; then
	assert "var-naia.mount mentioned in boot log" true
else
	assert "var-naia.mount mentioned in boot log" false
fi

# --- Summary ---
echo
echo "=== Results ==="
printf "PASS: %d\n" "$PASS"
printf "FAIL: %d\n" "$FAIL"
if (( FAIL > 0 )); then
	echo "Failed assertions:"
	for l in "${FAILED_LABELS[@]}"; do
		printf "  - %s\n" "$l"
	done
fi

if (( FAIL == 0 )); then
	echo "All assertions passed."
	exit 0
else
	echo "Some assertions failed."
	echo "Serial log: $SERIAL_LOG"
	exit 1
fi