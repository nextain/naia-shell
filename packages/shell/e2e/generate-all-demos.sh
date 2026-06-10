#!/usr/bin/env bash
#
# Naia OS Demo — Full pipeline for all 14 languages
#
# For each language:
#   1. Record screen with Playwright (DEMO_LANG env)
#   2. Generate TTS narration
#   3. Merge video + audio into final MP4
#
# Usage:
#   cd shell && bash e2e/generate-all-demos.sh           # All 14 languages
#   cd shell && bash e2e/generate-all-demos.sh ko en ja   # Specific languages only
#
# Output:
#   shell/e2e/demo-output/{lang}/naia-demo.mp4

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

ALL_LANGS=(ko en ja zh fr de ru es ar hi bn pt id vi)

# Use args if provided, otherwise all languages
if [ $# -gt 0 ]; then
    LANGS=("$@")
else
    LANGS=("${ALL_LANGS[@]}")
fi

FAILED=()

for lang in "${LANGS[@]}"; do
  echo ""
  echo "══════════════════════════════════════════"
  echo "  [$lang] Step 1/3: Recording screen"
  echo "══════════════════════════════════════════"
  if ! DEMO_LANG="$lang" pnpm test:e2e -- demo-video.spec.ts; then
    echo "[ERROR] Recording failed for $lang — skipping"
    FAILED+=("$lang")
    continue
  fi

  echo ""
  echo "══════════════════════════════════════════"
  echo "  [$lang] Step 2/3: Generating TTS"
  echo "══════════════════════════════════════════"
  if ! npx tsx e2e/demo-tts.ts --lang "$lang"; then
    echo "[ERROR] TTS failed for $lang — skipping merge"
    FAILED+=("$lang")
    continue
  fi

  echo ""
  echo "══════════════════════════════════════════"
  echo "  [$lang] Step 3/3: Merging MP4"
  echo "══════════════════════════════════════════"
  if ! bash e2e/demo-merge.sh "$lang"; then
    echo "[ERROR] Merge failed for $lang"
    FAILED+=("$lang")
    continue
  fi
done

echo ""
echo "══════════════════════════════════════════"
echo "  Results"
echo "══════════════════════════════════════════"
for lang in "${LANGS[@]}"; do
  mp4="e2e/demo-output/$lang/naia-demo.mp4"
  if [ -f "$mp4" ]; then
    size=$(du -h "$mp4" | cut -f1)
    echo "  $lang: $mp4 ($size)"
  else
    echo "  $lang: MISSING"
  fi
done

if [ ${#FAILED[@]} -gt 0 ]; then
  echo ""
  echo "  Failed: ${FAILED[*]}"
  exit 1
fi
