#!/usr/bin/env bash
# Real engine/HTTP checks; never downloads a model or touches existing containers.
set -euo pipefail
: "${TMPDIR:?Set run tmp directory}"
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d "$TMPDIR/container-smoke.XXXXXX")"
export NAIA_ENGINE="${NAIA_ENGINE:-podman}" NAIA_GPU=cpu
export NAIA_WEB_IMAGE="${NAIA_WEB_IMAGE:-localhost/naia-web:smoke-$$}"
export NAIA_PROJECT="naia026-smoke-$$" NAIA_PORT="${NAIA_PORT:-18026}"
export NAIA_DATA_DIR="$work/data" NAIA_WEB_REVISION="${NAIA_WEB_REVISION:-smoke-fixture}"
if [[ -z "${NAIA_WEB_DIR:-}" ]]; then
  mkdir "$work/web"
  printf '<!doctype html><title>Naia packaging fixture</title><p>Container transport test only</p>' > "$work/web/index.html"
  export NAIA_WEB_DIR="$work/web"
fi
export NAIA_BUILD_CONTEXT="$work"
compose=("$NAIA_ENGINE" compose -p "$NAIA_PROJECT" -f "$HERE/compose.yaml")
cleanup() {
  "${compose[@]}" down || true
  echo "smoke evidence/data retained: $work"
}
trap cleanup EXIT
bash "$HERE/start.sh"
url="http://127.0.0.1:$NAIA_PORT"
for ((n=0;n<60;n++)); do
  if curl --max-time 3 --fail --silent "$url/healthz" > "$work/health"; then break; fi
  sleep 1
done
[[ "$(cat "$work/health")" = ok ]]
curl --max-time 3 --fail --silent "$url/" > "$work/index.html"
cmp "$NAIA_WEB_DIR/index.html" "$work/index.html"
curl --max-time 3 --fail --silent "$url/local-llm/v1/models" > "$work/models.json"
python3 - "$work/models.json" <<'PY'
import json,sys
result=json.load(open(sys.argv[1]))
assert result['object'] == 'list' and result['data'] in (None, []), 'Smoke requires a fresh empty model store'
PY
[[ "$(curl -s -o /dev/null -w '%{http_code}' "$url/local-llm/api/pull")" = 404 ]]
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$url/local-llm/v1/models")" = 405 ]]
[[ "$(curl -s -o "$work/no-model.json" -w '%{http_code}' -H 'Content-Type: application/json' -d '{"model":"no-such-model","messages":[{"role":"user","content":"test"}],"stream":true}' "$url/local-llm/v1/chat/completions")" = 404 ]]
"${compose[@]}" exec -T inference sh -c 'echo retained > /root/.ollama/naia-smoke-sentinel'
"${compose[@]}" down
"${compose[@]}" up -d
"${compose[@]}" exec -T inference sh -c 'test "$(cat /root/.ollama/naia-smoke-sentinel)" = retained'
echo 'PASS: real static serving, inference health, empty model list, blocked management, missing-model error, volume retention; no model downloaded'
