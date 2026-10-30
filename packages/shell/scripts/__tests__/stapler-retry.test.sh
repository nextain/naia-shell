#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
: "${TMPDIR:?Set TMPDIR to the approved temporary directory}"
work=$(mktemp -d "$TMPDIR/stapler-test.XXXXXX")
trap 'rm -rf "$work"' EXIT
export RUNNER_TEMP="$work" GITHUB_ENV="$work/env" GITHUB_STEP_SUMMARY="$work/summary"
source "$ROOT/packages/shell/scripts/stapler-retry.sh"
sleep() { echo "$1" >> "$work/delays"; }
xcrun() {
  local count=0
  [ ! -f "$work/count" ] || count=$(cat "$work/count")
  count=$((count + 1)); echo "$count" > "$work/count"
  case "$scenario" in
    twice) if [ "$count" -le 2 ]; then echo 'CloudKit network error'; return 68; fi ;;
    fatal) echo 'invalid signature'; return 3 ;;
    network) echo 'NSURLErrorDomain Error 68'; return 68 ;;
  esac
}
spctl() { echo called >> "$work/spctl"; }
reset_case() { rm -f "$work/count" "$work/delays" "$work/env" "$work/summary" "$work/spctl"; }
scenario=twice
stapler_retry staple app
[ "$(cat "$work/count")" = 3 ] && [ "$(cat "$work/delays")" = "$(printf '20\n40')" ]
reset_case
scenario=fatal
if stapler_retry staple app; then exit 1; else [ "$?" = 3 ]; fi
[ "$(cat "$work/count")" = 1 ] && [ ! -f "$work/delays" ]
reset_case
scenario=network
staple_accepted_app app x64 > "$work/output"
[ "$(cat "$work/count")" = 6 ] && [ "$(cat "$work/delays")" = "$(printf '20\n40\n60\n90\n120')" ]
grep -q '::warning::' "$work/output" && grep -q 'staple skipped' "$work/summary" && grep -q 'MACOS_APP_STAPLE_SKIPPED=true' "$work/env" && [ ! -f "$work/spctl" ]
reset_case
if staple_accepted_app app arm64; then exit 1; else [ "$?" = 68 ]; fi
[ "$(cat "$work/count")" = 6 ] && [ ! -f "$work/summary" ]
reset_case
scenario=fatal
if staple_accepted_app app x64; then exit 1; else [ "$?" = 3 ]; fi
[ ! -f "$work/summary" ]
for action in staple validate; do
  reset_case
  scenario=network
  stapler_accepted "$action" image.dmg x64 DMG > "$work/output"
  [ "$STAPLER_SKIPPED" = 1 ] && [ "$(cat "$work/count")" = 6 ]
  grep -q '::warning::' "$work/output" && grep -q "DMG: $action skipped" "$work/summary"
  reset_case
  if stapler_accepted "$action" image.dmg arm64 DMG; then exit 1; else [ "$?" = 68 ]; fi
  [ "$(cat "$work/count")" = 6 ] && [ ! -f "$work/summary" ]
  reset_case
  scenario=fatal
  if stapler_accepted "$action" image.dmg x64 DMG; then exit 1; else [ "$?" = 3 ]; fi
  [ "$(cat "$work/count")" = 1 ] && [ ! -f "$work/summary" ]
done
echo 'stapler retry tests passed'
