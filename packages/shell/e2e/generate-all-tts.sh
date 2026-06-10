#!/usr/bin/env bash
# Generate TTS + MP4 for all 13 non-Korean languages
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

LANGS=(en ja zh fr de ru es ar hi bn pt id vi)

for lang in "${LANGS[@]}"; do
  echo ""
  echo "=========================================="
  echo "  Generating TTS for: $lang"
  echo "=========================================="
  npx tsx e2e/demo-tts.ts --lang "$lang"

  echo ""
  echo "=========================================="
  echo "  Merging MP4 for: $lang"
  echo "=========================================="
  bash e2e/demo-merge.sh "$lang"
done

echo ""
echo "All done! Generated MP4s:"
for lang in "${LANGS[@]}"; do
  mp4="e2e/demo-output/$lang/naia-demo.mp4"
  if [ -f "$mp4" ]; then
    size=$(du -h "$mp4" | cut -f1)
    echo "  $lang: $mp4 ($size)"
  else
    echo "  $lang: MISSING"
  fi
done
