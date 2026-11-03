#!/usr/bin/env bash
set -euo pipefail
: "${TMPDIR:?Set run tmp directory}"
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d "$TMPDIR/start-test.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT
mkdir "$work/web"
printf '<!doctype html><title>test</title>' > "$work/web/index.html"
check_error() {
  local expected="$1"; shift
  if env -u NAIA_WEB_DIR -u NAIA_WEB_REVISION -u NAIA_DATA_DIR "$@" bash "$HERE/start.sh" > "$work/output" 2>&1; then
    echo 'Unexpected success' >&2; exit 1
  fi
  rg -q "$expected" "$work/output"
}
check_error 'NAIA_WEB_DIR'
check_error 'must be absolute and contain index.html' NAIA_WEB_DIR="$work/missing" NAIA_WEB_REVISION=test NAIA_DATA_DIR="$work/data"
check_error 'Data and temporary paths must be absolute' NAIA_WEB_DIR="$work/web" NAIA_WEB_REVISION=test NAIA_DATA_DIR=relative
check_error 'NAIA_PORT must be numeric' NAIA_WEB_DIR="$work/web" NAIA_WEB_REVISION=test NAIA_DATA_DIR="$work/data" NAIA_PORT=no
check_error 'Use cpu' NAIA_WEB_DIR="$work/web" NAIA_WEB_REVISION=test NAIA_DATA_DIR="$work/data" NAIA_ENGINE=podman NAIA_GPU=surprise
check_error 'NAIA_ENGINE must be docker or podman' NAIA_WEB_DIR="$work/web" NAIA_WEB_REVISION=test NAIA_DATA_DIR="$work/data" NAIA_ENGINE=other
echo 'start validation: 6 passed'
