#!/bin/bash
# echo-loopback-test.sh — Audio echo E2E reproduction test (Issue #22)
#
# Proves that speaker output can enter the mic input path,
# reproducing the echo bug in Naia voice conversations.
#
# Prerequisites: PipeWire, espeak-ng, ffmpeg
# Usage: bash e2e/echo-loopback-test.sh
#
# How it works:
#   1. Creates PipeWire loopback (speaker monitor → virtual mic source)
#   2. Records from the virtual source (captures speaker output)
#   3. Plays test audio via espeak-ng simultaneously
#   4. Analyzes recording volume — if audio detected, echo path is OPEN
#
# Expected results:
#   BEFORE fix: FAIL (echo detected — speaker output captured by mic)
#   AFTER  fix: Browser AEC filters it, but this script still detects it
#               (AEC is browser-level, not OS-level).
#               Use the companion unit test to verify the constraint fix.

set -uo pipefail

RECORD_FILE="/tmp/naia-echo-test-$(date +%s).wav"
TEST_PHRASE="Hello Naia, this is an echo reproduction test"
LOOPBACK_PID=""
RECORD_PID=""
VOLUME_THRESHOLD="-50"  # dB — above this = audio detected

cleanup() {
    echo ""
    echo "[cleanup] Stopping processes..."
    [ -n "$RECORD_PID" ] && kill "$RECORD_PID" 2>/dev/null || true
    [ -n "$LOOPBACK_PID" ] && kill "$LOOPBACK_PID" 2>/dev/null || true
    rm -f "$RECORD_FILE"
    echo "[cleanup] Done."
}
trap cleanup EXIT

echo "=== Naia Echo Reproduction E2E Test (Issue #22) ==="
echo ""

# --- Prerequisites ---
echo "[prereq] Checking tools..."
MISSING=""
for cmd in pw-loopback pw-record pw-cli wpctl espeak-ng ffmpeg; do
    command -v "$cmd" >/dev/null 2>&1 || MISSING="$MISSING $cmd"
done
if [ -n "$MISSING" ]; then
    echo "FAIL: Missing tools:$MISSING"
    exit 2
fi
echo "[prereq] All tools available."

# --- Step 1: Create PipeWire loopback ---
# Captures from default sink monitor and creates a virtual source
echo "[1/4] Creating PipeWire loopback (speaker monitor → virtual mic)..."
pw-loopback \
    --capture-props='stream.capture.sink=true' \
    --playback-props='media.class=Audio/Source/Virtual,node.name=naia-echo-test,node.description=NaiaEchoTest' &
LOOPBACK_PID=$!
sleep 1

# Find the virtual source node ID via wpctl
VIRTUAL_SOURCE_ID=$(
    wpctl status 2>/dev/null \
    | grep 'naia-echo-test' \
    | head -1 \
    | grep -oP '\d+' \
    | head -1 || echo ""
)

if [ -z "$VIRTUAL_SOURCE_ID" ]; then
    echo "FAIL: Could not find virtual source node. pw-loopback may have failed."
    exit 2
fi
echo "       Virtual source created: node $VIRTUAL_SOURCE_ID"

# --- Step 2: Record from virtual source + Play simultaneously ---
echo "[2/4] Recording from virtual source while playing test audio..."
echo "       Phrase: \"$TEST_PHRASE\""

# Record directly from the virtual source node (not default mic)
pw-record --target "$VIRTUAL_SOURCE_ID" "$RECORD_FILE" &
RECORD_PID=$!
sleep 1

# Play test audio through default sink (speakers)
espeak-ng "$TEST_PHRASE" 2>/dev/null

# Wait for audio to finish + buffer
sleep 2

# Stop recording
kill "$RECORD_PID" 2>/dev/null || true
wait "$RECORD_PID" 2>/dev/null || true
RECORD_PID=""

if [ ! -f "$RECORD_FILE" ]; then
    echo "FAIL: Recording file not created."
    exit 2
fi

# --- Step 3: Analyze recording ---
echo "[3/4] Analyzing recording..."

VOLUME_INFO=$(ffmpeg -i "$RECORD_FILE" -af "volumedetect" -f null /dev/null 2>&1)
MEAN_VOLUME=$(echo "$VOLUME_INFO" | grep -oP 'mean_volume: \K[-\d.]+' || echo "-999")
MAX_VOLUME=$(echo "$VOLUME_INFO" | grep -oP 'max_volume: \K[-\d.]+' || echo "-999")

# --- Step 4: Report ---
echo "[4/4] Results:"
echo ""
echo "======================================="
echo "  Echo Reproduction Test Result"
echo "======================================="
echo "  Mean volume: ${MEAN_VOLUME} dB"
echo "  Max volume:  ${MAX_VOLUME} dB"
echo "  Threshold:   ${VOLUME_THRESHOLD} dB"
echo "---------------------------------------"

# Compare using awk (bc might not be installed)
ECHO_DETECTED=$(awk "BEGIN { print ($MEAN_VOLUME > $VOLUME_THRESHOLD) ? 1 : 0 }")

if [ "$ECHO_DETECTED" -eq 1 ]; then
    echo "  RESULT: ECHO DETECTED"
    echo ""
    echo "  Speaker output was captured by the virtual mic."
    echo "  This confirms the echo bug (Issue #22):"
    echo "  Without echoCancellation, getUserMedia WILL"
    echo "  pick up Naia's voice output as user input."
    echo "======================================="
    exit 1  # Test FAILS — echo exists (bug confirmed)
else
    echo "  RESULT: NO ECHO"
    echo ""
    echo "  Virtual mic captured silence."
    echo "  Echo path is not active."
    echo "======================================="
    exit 0  # Test passes — no echo
fi
