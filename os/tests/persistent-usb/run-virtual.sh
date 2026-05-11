#!/usr/bin/env bash
# Persistent USB virtual test (issue #262)
#
# Validates os/tools/naia-usb against a sparse-file + loop-device "USB".
# No physical hardware touched.
#
# Requires: root (sudo) for losetup, parted, mkfs, mount.
#
# What it verifies:
#   1. create produces 3 partitions with the expected labels and fs types
#   2. seed tarball is unpacked into partition 3
#   3. user-written data on partition 3 survives an `update` cycle
#   4. status reports the device as a naia layout
#   5. update refuses on a non-naia device
#   6. create --iso extracts boot files correctly (if ISO provided)
#
# Usage:
#   sudo bash run-virtual.sh [--iso /path/to/naia-os.iso]

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
NAIA_USB="$ROOT/os/tools/naia-usb"

[[ -x "$NAIA_USB" ]] || { echo "naia-usb not executable at $NAIA_USB" >&2; exit 1; }
[[ $EUID -eq 0 ]] || { echo "this test requires root (sudo bash $0)" >&2; exit 1; }

NAIA_ISO=""
if [[ "${1:-}" == "--iso" ]]; then
	NAIA_ISO="$2"
	[[ -f "$NAIA_ISO" ]] || { echo "ISO not found: $NAIA_ISO" >&2; exit 1; }
fi

WORKDIR="$(mktemp -d -t naia-usb-test.XXXXXX)"
IMG="$WORKDIR/usb.img"
LOOP=""
DATA_MP="$WORKDIR/mnt-data"

cleanup() {
	for mp in "$WORKDIR/mnt-data" "$WORKDIR/mnt-rootfs" "$WORKDIR/mnt-esp"; do
		mountpoint -q "$mp" 2>/dev/null && umount "$mp" 2>/dev/null || true
	done
	if [[ -n "$LOOP" ]]; then
		losetup -d "$LOOP" 2>/dev/null || true
	fi
	rm -rf "$WORKDIR"
}
trap cleanup EXIT

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

label_eq()  { [[ "$(blkid -s LABEL -o value "$1" 2>/dev/null || true)" == "$2" ]]; }
fstype_eq() { [[ "$(blkid -s TYPE  -o value "$1" 2>/dev/null || true)" == "$2" ]]; }

echo "=== Phase 2 virtual test (issue #262) ==="
echo "workdir: $WORKDIR"

# --- Setup ---
echo
echo "Setup: sparse file + losetup"
if [[ -n "$NAIA_ISO" ]]; then
	ISO_SIZE="$(stat -c%s "$NAIA_ISO")"
	IMG_SIZE=$(( (ISO_SIZE / 1024 / 1024) + 2048 ))
	echo "  image size: ${IMG_SIZE}MiB (ISO + overhead)"
	truncate -s "${IMG_SIZE}M" "$IMG"
	export ROOTFS_SIZE_MIB=$(( (ISO_SIZE / 1024 / 1024) + 256 ))
else
	truncate -s 256M "$IMG"
	export ESP_SIZE_MIB=32
	export ROOTFS_SIZE_MIB=64
fi
LOOP="$(losetup --find --show -P "$IMG")"
echo "  loop: $LOOP"

# Test rootfs (synthetic, 8 MB)
ROOTFS="$WORKDIR/test-rootfs.img"
dd if=/dev/zero of="$ROOTFS" bs=1M count=8 status=none
echo "rootfs-v1-marker" >> "$ROOTFS"

# Seed tarball with a minimal naia-adk tree
SEED_DIR="$WORKDIR/seed"
mkdir -p "$SEED_DIR/naia-adk/config"
echo "default-config" > "$SEED_DIR/naia-adk/config/agent.yaml"
SEED="$WORKDIR/naia-adk-seed.tar"
tar -cf "$SEED" -C "$SEED_DIR" .

# --- Test 1: create ---
echo
echo "Test 1: naia-usb create — fresh layout + seed"
if [[ -n "$NAIA_ISO" ]]; then
	"$NAIA_USB" create "$LOOP" --iso "$NAIA_ISO" --seed "$SEED"
else
	"$NAIA_USB" create "$LOOP" --rootfs "$ROOTFS" --seed "$SEED"
fi

P1="${LOOP}p1"
P2="${LOOP}p2"
P3="${LOOP}p3"

assert "ESP partition exists"          test -b "$P1"
assert "rootfs partition exists"       test -b "$P2"
assert "naia-data partition exists"    test -b "$P3"
assert "ESP labeled NAIA-ESP"          label_eq  "$P1" NAIA-ESP
assert "rootfs labeled naia-rootfs"    label_eq  "$P2" naia-rootfs
assert "naia-data labeled naia-data"   label_eq  "$P3" naia-data
assert "ESP fstype vfat"               fstype_eq "$P1" vfat
assert "rootfs fstype ext4"            fstype_eq "$P2" ext4
assert "naia-data fstype btrfs"        fstype_eq "$P3" btrfs

# --- Test 1b: ISO-specific boot file checks ---
if [[ -n "$NAIA_ISO" ]]; then
	echo
	echo "Test 1b: boot files on ESP"
	ESP_MP="$WORKDIR/mnt-esp"
	mkdir -p "$ESP_MP"
	mount "$P1" "$ESP_MP"
	assert "ESP has vmlinuz"          test -f "$ESP_MP/vmlinuz"
	assert "ESP has initramfs.img"    test -f "$ESP_MP/initramfs.img"
	assert "ESP has EFI/BOOT/grub.cfg" test -f "$ESP_MP/EFI/BOOT/grub.cfg"
	assert "ESP has EFI/BOOT/BOOTX64.efi" test -f "$ESP_MP/EFI/BOOT/BOOTX64.efi"
	assert "grub.cfg uses LABEL=naia-rootfs" \
		grep -q "root=live:LABEL=naia-rootfs" "$ESP_MP/EFI/BOOT/grub.cfg"
	umount "$ESP_MP"

	echo
	echo "Test 1c: rootfs partition has LiveOS/squashfs.img"
	ROOTFS_MP="$WORKDIR/mnt-rootfs"
	mkdir -p "$ROOTFS_MP"
	mount "$P2" "$ROOTFS_MP"
	assert "rootfs has LiveOS/squashfs.img" test -f "$ROOTFS_MP/LiveOS/squashfs.img"
	SQUASH_SIZE="$(stat -c%s "$ROOTFS_MP/LiveOS/squashfs.img" 2>/dev/null || echo 0)"
	assert "squashfs.img is non-trivial (>1MB)" bash -c "[[ $SQUASH_SIZE -gt 1048576 ]]"
	umount "$ROOTFS_MP"
fi

# --- Test 2: seed unpacked + user writes ---
echo
echo "Test 2: seed visible + user data writable on partition 3"
mkdir -p "$DATA_MP"
mount "$P3" "$DATA_MP"
assert "seed config/agent.yaml present" test -f "$DATA_MP/naia-adk/config/agent.yaml"
echo "user changes" > "$DATA_MP/naia-adk/user-data.txt"
sync
umount "$DATA_MP"

# --- Test 3: update preserves partition 3 ---
echo
echo "Test 3: naia-usb update — preserves partition 3"
NEW_ROOTFS="$WORKDIR/test-rootfs-v2.img"
dd if=/dev/zero of="$NEW_ROOTFS" bs=1M count=8 status=none
echo "rootfs-v2-marker" >> "$NEW_ROOTFS"

if [[ -n "$NAIA_ISO" ]]; then
	"$NAIA_USB" update "$LOOP" --iso "$NAIA_ISO"
else
	"$NAIA_USB" update "$LOOP" --rootfs "$NEW_ROOTFS"
fi

mount "$P3" "$DATA_MP"
assert "user-data.txt still present" test -f "$DATA_MP/naia-adk/user-data.txt"
assert "user-data.txt content intact" \
	bash -c "[[ \$(cat '$DATA_MP/naia-adk/user-data.txt') == 'user changes' ]]"
assert "seed agent.yaml still present" test -f "$DATA_MP/naia-adk/config/agent.yaml"
umount "$DATA_MP"

# --- Test 4: rootfs got new content (parts 1+2 actually re-written) ---
echo
echo "Test 4: rootfs partition re-written"
ROOTFS_MP="$WORKDIR/mnt-rootfs"
mkdir -p "$ROOTFS_MP"
mount "$P2" "$ROOTFS_MP"
assert "rootfs has LiveOS/squashfs.img" test -f "$ROOTFS_MP/LiveOS/squashfs.img"
if [[ -z "$NAIA_ISO" ]]; then
	assert "rootfs is v2 (marker matches)" \
		bash -c "tail -c 17 '$ROOTFS_MP/LiveOS/squashfs.img' | grep -q 'rootfs-v2-marker'"
fi
umount "$ROOTFS_MP"

# --- Test 4b: ESP re-written with new boot files after update ---
if [[ -n "$NAIA_ISO" ]]; then
	echo
	echo "Test 4b: ESP re-written after update"
	ESP_MP="$WORKDIR/mnt-esp"
	mkdir -p "$ESP_MP"
	mount "$P1" "$ESP_MP"
	assert "ESP still has vmlinuz after update" test -f "$ESP_MP/vmlinuz"
	assert "ESP still has grub.cfg after update" test -f "$ESP_MP/EFI/BOOT/grub.cfg"
	umount "$ESP_MP"
fi

# --- Test 5: status reports naia layout ---
echo
echo "Test 5: naia-usb status"
STATUS_OUT="$WORKDIR/status.out"
"$NAIA_USB" status "$LOOP" | tee "$STATUS_OUT"
assert "status reports 'naia layout: YES'" grep -q 'naia layout: YES' "$STATUS_OUT"

# --- Test 6: update refuses on a non-naia device ---
echo
echo "Test 6: update refuses on non-naia layout"
BLANK_IMG="$WORKDIR/blank.img"
truncate -s 64M "$BLANK_IMG"
BLANK_LOOP="$(losetup --find --show -P "$BLANK_IMG")"

if "$NAIA_USB" update "$BLANK_LOOP" --rootfs "$ROOTFS" 2>/dev/null; then
	assert "update refused on blank device" false
else
	assert "update refused on blank device" true
fi
losetup -d "$BLANK_LOOP" 2>/dev/null || true

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
	exit 1
fi
echo "All assertions passed."
