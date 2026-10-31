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

stapler_accepted() {
  local action=$1 target=$2 arch=$3 kind=$4 status
  STAPLER_SKIPPED=0
  if stapler_retry "$action" "$target"; then
    return 0
  else
    status=$?
  fi
  if [ "$arch" = x64 ] && [ "$STAPLER_NETWORK_EXHAUSTED" = 1 ]; then
    STAPLER_SKIPPED=1
    echo "::warning::Accepted Intel $kind $action failed after six network errors."
    echo "### Intel macOS $kind: $action skipped" >> "$GITHUB_STEP_SUMMARY"
    echo "Apple accepted notarization, but $action failed six times with network errors. Ticket availability and online Gatekeeper verification depend on Apple availability." >> "$GITHUB_STEP_SUMMARY"
    return 0
  fi
  return "$status"
}

staple_accepted_app() {
  local app=$1 arch=$2
  stapler_accepted staple "$app" "$arch" app || return $?
  if [ "$STAPLER_SKIPPED" = 0 ]; then
    spctl -a -vv -t exec "$app"
    stapler_accepted validate "$app" "$arch" app
  else
    echo 'App spctl and stapler validation were skipped because the ticket was not embedded.' >> "$GITHUB_STEP_SUMMARY"
    echo 'MACOS_APP_STAPLE_SKIPPED=true' >> "$GITHUB_ENV"
  fi
}
