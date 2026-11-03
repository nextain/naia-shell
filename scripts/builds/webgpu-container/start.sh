#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
fail() { echo "[naia-container] $*" >&2; exit 2; }
: "${NAIA_WEB_DIR:?Set NAIA_WEB_DIR to a built web dist directory (main has no build:web)}"
: "${NAIA_WEB_REVISION:?Set NAIA_WEB_REVISION to the web artifact source commit}"
: "${NAIA_DATA_DIR:?Set NAIA_DATA_DIR to an absolute user-owned data directory}"
: "${TMPDIR:?Set TMPDIR to a directory for disposable build context}"
[[ "$NAIA_WEB_DIR" = /* && -f "$NAIA_WEB_DIR/index.html" ]] || fail 'NAIA_WEB_DIR must be absolute and contain index.html'
[[ "$NAIA_DATA_DIR" = /* && "$TMPDIR" = /* ]] || fail 'Data and temporary paths must be absolute'
[[ "${NAIA_PORT:-18026}" =~ ^[0-9]+$ ]] || fail 'NAIA_PORT must be numeric'
(( ${NAIA_PORT:-18026} > 0 && ${NAIA_PORT:-18026} < 65536 )) || fail 'NAIA_PORT out of range'
engine="${NAIA_ENGINE:-}"
if [[ -z "$engine" ]]; then
  if command -v podman >/dev/null; then engine=podman; else engine=docker; fi
fi
[[ "$engine" = docker || "$engine" = podman ]] || fail 'NAIA_ENGINE must be docker or podman'
command -v "$engine" >/dev/null || fail "$engine is not installed"
command -v curl >/dev/null || fail "curl is required for readiness verification"
mode="${NAIA_GPU:-cpu}"
case "$engine:$mode" in docker:cpu|podman:cpu|docker:nvidia|podman:cdi) ;; *) fail 'Use cpu, docker+nvidia or podman+cdi' ;; esac
"$engine" compose version >/dev/null 2>&1 || fail "$engine compose provider is missing; install docker compose or podman-compose"
mkdir -p "$TMPDIR" "$NAIA_DATA_DIR/models"
export NAIA_BUILD_CONTEXT
NAIA_BUILD_CONTEXT="$(mktemp -d "$TMPDIR/naia-container.XXXXXX")"
trap 'rm -rf -- "$NAIA_BUILD_CONTEXT"' EXIT
# Copy only intended public assets, never the repository, .env, ADK, or keys.
cp "$HERE/Dockerfile" "$HERE/nginx.conf" "$HERE/entrypoint.sh" "$NAIA_BUILD_CONTEXT/"
cp -R "$NAIA_WEB_DIR" "$NAIA_BUILD_CONTEXT/web"
export NAIA_SOURCE_REVISION="$(git -C "$HERE" rev-parse HEAD)"
args=(-p "${NAIA_PROJECT:-naia-026}" -f "$HERE/compose.yaml")
[[ "$mode" != nvidia ]] || args+=(-f "$HERE/compose.nvidia.yaml")
[[ "$mode" != cdi ]] || args+=(-f "$HERE/compose.cdi.yaml")
echo "[naia-container] source=$NAIA_SOURCE_REVISION web=$NAIA_WEB_REVISION engine=$engine gpu=$mode"
echo "[naia-container] data=$NAIA_DATA_DIR/models; browser ADK/memory=OPFS (not this volume)"
echo "[naia-container] web image=${NAIA_WEB_IMAGE:-localhost/naia-web:026-container} inference=${NAIA_INFERENCE_IMAGE:-docker.io/ollama/ollama:0.13.5} network=${NAIA_NETWORK_IMAGE:-docker.io/library/nginx:1.28.0-alpine}"
"$engine" compose "${args[@]}" up -d --build
"$engine" compose "${args[@]}" ps
ready=false
for ((attempt=0;attempt<60;attempt++)); do
  if curl --max-time 3 --fail --silent "http://127.0.0.1:${NAIA_PORT:-18026}/healthz" >/dev/null; then ready=true; break; fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  "$engine" compose "${args[@]}" logs --tail 30 web >&2 || true
  fail 'Web readiness failed; inspect project logs and stop with the documented compose down command'
fi
echo "[naia-container] http://localhost:${NAIA_PORT:-18026}; startup script did not download a model (browser WebGPU may download separately)"
printf '[naia-container] stop (keeps data): NAIA_BUILD_CONTEXT=. NAIA_WEB_REVISION=%q NAIA_DATA_DIR=%q %q compose ' "$NAIA_WEB_REVISION" "$NAIA_DATA_DIR" "$engine"
printf '%q ' "${args[@]}"
printf 'down\n'
