#!/usr/bin/env bash
# Run all persistent USB tests — execute from the naia-os worktree
#
# Usage: sudo bash os/tests/persistent-usb/run-all-tests.sh [/path/to/naia-os.iso]

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
NAIA_USB="$ROOT/os/tools/naia-usb"
ISO="${1:-}"

echo "============================================"
echo " Naia USB Persistent Boot — Test Runner"
echo "============================================"
echo ""

[[ -x "$NAIA_USB" ]] || { echo "ERROR: naia-usb not found at $NAIA_USB" >&2; exit 1; }
[[ $EUID -eq 0 ]] || { echo "ERROR: run with sudo" >&2; exit 1; }

echo "=== Test 1: Virtual test (basic mode, no ISO) ==="
bash "$ROOT/os/tests/persistent-usb/run-virtual.sh"
echo ""

if [[ -n "$ISO" && -f "$ISO" ]]; then
	echo "=== Test 2: Virtual test (ISO mode) ==="
	bash "$ROOT/os/tests/persistent-usb/run-virtual.sh" --iso "$ISO"
	echo ""

	if command -v qemu-system-x86_64 >/dev/null 2>&1 && [[ -f /usr/share/edk2/ovmf/OVMF_CODE.fd ]]; then
		echo "=== Test 3: QEMU boot test ==="
		bash "$ROOT/os/tests/persistent-usb/run-qemu-boot.sh" --iso "$ISO"
		echo ""
	else
		echo "=== Test 3: SKIPPED (qemu-system-x86_64 or OVMF not found) ==="
		echo "  Install: dnf install qemu-system-x86-core edk2-ovmf"
	fi
else
	echo "=== Test 2: SKIPPED (no ISO provided) ==="
	echo "  Usage: sudo bash $0 /path/to/naia-os.iso"
	echo "  ISO available at: /var/home/luke/naia-iso/naia-os-live-amd64.iso"
fi

echo ""
echo "============================================"
echo " All tests complete"
echo "============================================"
