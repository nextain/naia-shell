#!/usr/bin/env bash
# Source from a bash step. STAPLER_NETWORK_EXHAUSTED distinguishes retry exhaustion.
stapler_retry() {
  local attempt=1 status log_file="$RUNNER_TEMP/stapler-retry-$$.log"
  local delays=(20 40 60 90 120)
  STAPLER_NETWORK_EXHAUSTED=0
  while [ "$attempt" -le 6 ]; do
    if xcrun stapler "$@" >"$log_file" 2>&1; then
      cat "$log_file"
      rm -f "$log_file"
      return 0
    else
      status=$?
    fi
    cat "$log_file"
    if ! grep -Eiq 'Error[[:space:]]+68|NSURLErrorDomain|network|CloudKit|timed[[:space:]]+out' "$log_file"; then
      rm -f "$log_file"
      return "$status"
    fi
    if [ "$attempt" -eq 6 ]; then
      STAPLER_NETWORK_EXHAUSTED=1
      rm -f "$log_file"
      return "$status"
    fi
    echo "stapler network failure; retrying in ${delays[$((attempt - 1))]} seconds ($((attempt + 1))/6)."
    sleep "${delays[$((attempt - 1))]}"
    attempt=$((attempt + 1))
  done
}

staple_accepted_app() {
  local app=$1 arch=$2 status
  if stapler_retry staple "$app"; then
    spctl -a -vv -t exec "$app"
    stapler_retry validate "$app"
  else
    status=$?
    if [ "$arch" = x64 ] && [ "$STAPLER_NETWORK_EXHAUSTED" = 1 ]; then
      echo '::warning::Accepted Intel app could not be stapled after six network failures; app spctl and stapler validation are skipped.'
      echo '### Intel macOS app: staple skipped' >> "$GITHUB_STEP_SUMMARY"
      echo 'Apple accepted notarization, but staple failed six times with network errors. The app has no embedded ticket; online Gatekeeper verification depends on Apple availability. App spctl and stapler validation were skipped. The DMG remains subject to notarization and stapling.' >> "$GITHUB_STEP_SUMMARY"
      echo 'MACOS_APP_STAPLE_SKIPPED=true' >> "$GITHUB_ENV"
    else
      return "$status"
    fi
  fi
}
