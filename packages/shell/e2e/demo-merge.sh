#!/usr/bin/env bash
#
# Naia OS Demo — Merge video + TTS narration into final MP4 (multilingual)
#
# Reads timeline.json (actual scene timestamps from Playwright recording)
# and positions each TTS MP3 at the correct time.
#
# Prerequisites:
#   1. Run Playwright demo recording:
#      cd shell && pnpm test:e2e -- demo-video.spec.ts
#   2. Run TTS generation:
#      cd shell && npx tsx e2e/demo-tts.ts --lang <lang>
#   3. ffmpeg installed
#
# Usage:
#   cd shell && bash e2e/demo-merge.sh          # Korean (default)
#   cd shell && bash e2e/demo-merge.sh en        # English
#   cd shell && bash e2e/demo-merge.sh ja        # Japanese
#
# Output:
#   shell/e2e/demo-output/ko/naia-demo.mp4  (default)
#   shell/e2e/demo-output/en/naia-demo.mp4  (lang=en)

set -euo pipefail

LANG_CODE="${1:-ko}"
echo "[demo-merge] Language: $LANG_CODE"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="$SCRIPT_DIR/demo-output"
TTS_DIR="$OUTPUT_DIR/tts/$LANG_CODE"
FINAL_DIR="$OUTPUT_DIR/$LANG_CODE"
# Check per-language timeline first, then fallback to root
if [ -f "$FINAL_DIR/timeline.json" ]; then
    TIMELINE_FILE="$FINAL_DIR/timeline.json"
else
    TIMELINE_FILE="$OUTPUT_DIR/timeline.json"
fi

mkdir -p "$FINAL_DIR"

# ── Find video ──
VIDEO_FILE=""
for f in "$FINAL_DIR/demo-raw.webm" "$OUTPUT_DIR/demo-raw.webm" "$SCRIPT_DIR/../test-results/"*demo*/*.webm; do
    if [ -f "$f" ]; then
        VIDEO_FILE="$f"
        break
    fi
done

if [ -z "$VIDEO_FILE" ]; then
    echo "[demo-merge] ERROR: No video file found."
    echo "  Run: pnpm test:e2e -- demo-video.spec.ts"
    exit 1
fi

echo "[demo-merge] Video: $VIDEO_FILE"
echo "[demo-merge] TTS dir: $TTS_DIR"

# ── Check prerequisites ──
TTS_COUNT=$(find "$TTS_DIR" -name "*.mp3" 2>/dev/null | wc -l)
if [ "$TTS_COUNT" -eq 0 ]; then
    echo "[demo-merge] ERROR: No TTS MP3 files in $TTS_DIR"
    echo "  Run: npx tsx e2e/demo-tts.ts --lang $LANG_CODE"
    exit 1
fi
echo "[demo-merge] Found $TTS_COUNT TTS files"

# ── Scene ID → TTS filename mapping ──
# (index matches demo-script.ts DEMO_SCENES order)
declare -A SCENE_TTS=(
    [intro]="01-intro.mp3"
    [provider]="02-provider.mp3"
    [apikey]="03-apikey.mp3"
    [agent-name]="04-agent-name.mp3"
    [user-name]="05-user-name.mp3"
    [character]="06-character.mp3"
    [personality]="07-personality.mp3"
    [messenger]="08-messenger.mp3"
    [complete]="09-complete.mp3"
    [chat-hello]="10-chat-hello.mp3"
    [chat-response]="11-chat-response.mp3"
    [chat-weather]="12-chat-weather.mp3"
    [chat-tool-result]="13-chat-tool-result.mp3"
    [chat-time]="14-chat-time.mp3"
    [history-tab]="15-history-tab.mp3"
    [skills-list]="16-skills-list.mp3"
    [skills-detail]="17-skills-detail.mp3"
    [channels-tab]="18-channels-tab.mp3"
    [agents-tab]="19-agents-tab.mp3"
    [diagnostics-tab]="20-diagnostics-tab.mp3"
    [settings-ai]="21-settings-ai.mp3"
    [settings-voice]="22-settings-voice.mp3"
    [settings-memory]="23-settings-memory.mp3"
    [progress-tab]="24-progress-tab.mp3"
    [outro]="25-outro.mp3"
)

# ── Read actual scene timings from timeline.json ──
if [ -f "$TIMELINE_FILE" ]; then
    echo "[demo-merge] Using ACTUAL timings from timeline.json"
    MODE="timeline"
else
    echo "[demo-merge] WARNING: timeline.json not found — falling back to estimated timings"
    MODE="fallback"
fi

VIDEO_DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$VIDEO_FILE" | cut -d. -f1)
echo "[demo-merge] Video duration: ${VIDEO_DURATION}s"

# ── Build ffmpeg inputs and filter ──
INPUTS="-i \"$VIDEO_FILE\""
FILTER_PARTS=""
OVERLAY_PARTS=""
INPUT_IDX=1
MATCHED=0

if [ "$MODE" = "timeline" ]; then
    # Parse timeline.json with python3 (no jq dependency)
    TIMELINE_TSV=$(python3 -c "
import json, sys
with open('$TIMELINE_FILE') as f:
    data = json.load(f)
for s in data['scenes']:
    print(f\"{s['id']}\t{s['startMs']}\t{s['endMs']}\")
")

    SCENE_COUNT=$(echo "$TIMELINE_TSV" | wc -l)
    echo "[demo-merge] Timeline has $SCENE_COUNT scenes"
    echo ""
    echo "  Scene                 Start     Duration  TTS File"
    echo "  ────────────────────  ────────  ────────  ────────────────────────"

    while IFS=$'\t' read -r SCENE_ID START_MS END_MS; do
        DURATION_MS=$((END_MS - START_MS))

        TTS_FILE="${SCENE_TTS[$SCENE_ID]:-}"
        if [ -z "$TTS_FILE" ]; then
            printf "  %-22s %6dms  %6dms  (no TTS mapping, skip)\n" "$SCENE_ID" "$START_MS" "$DURATION_MS"
            continue
        fi

        TTS_PATH="$TTS_DIR/$TTS_FILE"
        if [ ! -f "$TTS_PATH" ]; then
            printf "  %-22s %6dms  %6dms  MISSING: %s\n" "$SCENE_ID" "$START_MS" "$DURATION_MS" "$TTS_FILE"
            continue
        fi

        printf "  %-22s %6dms  %6dms  %s\n" "$SCENE_ID" "$START_MS" "$DURATION_MS" "$TTS_FILE"

        INPUTS="$INPUTS -i \"$TTS_PATH\""
        FILTER_PARTS="${FILTER_PARTS}[${INPUT_IDX}:a]adelay=${START_MS}|${START_MS}[a${INPUT_IDX}];"
        OVERLAY_PARTS="${OVERLAY_PARTS}[a${INPUT_IDX}]"
        INPUT_IDX=$((INPUT_IDX + 1))
        MATCHED=$((MATCHED + 1))
    done <<< "$TIMELINE_TSV"
else
    # Fallback: use estimated cumulative timings from demo-script.ts
    FALLBACK_SCENES=(
        "0 01-intro.mp3" "5 02-provider.mp3" "13 03-apikey.mp3"
        "20 04-agent-name.mp3" "26 05-user-name.mp3" "32 06-character.mp3"
        "40 07-personality.mp3" "47 08-messenger.mp3" "52 09-complete.mp3"
        "57 10-chat-hello.mp3" "65 11-chat-response.mp3" "72 12-chat-weather.mp3"
        "82 13-chat-tool-result.mp3" "90 14-chat-time.mp3" "100 15-history-tab.mp3"
        "110 16-skills-list.mp3" "118 17-skills-detail.mp3" "125 18-channels-tab.mp3"
        "135 19-agents-tab.mp3" "145 20-diagnostics-tab.mp3" "155 21-settings-ai.mp3"
        "160 22-settings-voice.mp3" "165 23-settings-memory.mp3" "170 24-progress-tab.mp3"
        "178 25-outro.mp3"
    )
    for scene in "${FALLBACK_SCENES[@]}"; do
        START_SEC=$(echo "$scene" | cut -d' ' -f1)
        FILENAME=$(echo "$scene" | cut -d' ' -f2)
        TTS_PATH="$TTS_DIR/$FILENAME"
        if [ ! -f "$TTS_PATH" ]; then continue; fi
        DELAY_MS=$((START_SEC * 1000))
        INPUTS="$INPUTS -i \"$TTS_PATH\""
        FILTER_PARTS="${FILTER_PARTS}[${INPUT_IDX}:a]adelay=${DELAY_MS}|${DELAY_MS}[a${INPUT_IDX}];"
        OVERLAY_PARTS="${OVERLAY_PARTS}[a${INPUT_IDX}]"
        INPUT_IDX=$((INPUT_IDX + 1))
        MATCHED=$((MATCHED + 1))
    done
fi

echo ""
echo "[demo-merge] Merging $MATCHED narration tracks..."

FINAL_OUTPUT="$FINAL_DIR/naia-demo.mp4"

FILTER="${FILTER_PARTS}${OVERLAY_PARTS}amix=inputs=${MATCHED}:duration=longest:dropout_transition=0:normalize=0[narration]"

eval ffmpeg -y $INPUTS \
    -filter_complex "\"$FILTER\"" \
    -map 0:v -map "\"[narration]\"" \
    -c:v libx264 -preset fast -crf 23 \
    -c:a aac -b:a 128k \
    -movflags +faststart \
    "\"$FINAL_OUTPUT\""

# ── Result ──
if [ -f "$FINAL_OUTPUT" ]; then
    SIZE=$(du -h "$FINAL_OUTPUT" | cut -f1)
    DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$FINAL_OUTPUT")
    echo ""
    echo "[demo-merge] SUCCESS!"
    echo "  Output: $FINAL_OUTPUT"
    echo "  Size:   $SIZE"
    echo "  Duration: ${DURATION}s"
    echo "  Language: $LANG_CODE"
    echo "  Mode:   $MODE"
else
    echo "[demo-merge] ERROR: Output file not created"
    exit 1
fi
