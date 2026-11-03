#!/bin/sh
set -eu
# Compose shares a stable network-holder namespace; inference binds loopback.
# The holder survives web/inference stop/start or replacement. Replacing the
# holder requires recreating the complete compose project.
echo "[naia-container] $(date -u +%FT%TZ) upstream=127.0.0.1:11434 (shared service network)" >&2
cp /etc/nginx/nginx.conf /tmp/nginx.conf
exec nginx -c /tmp/nginx.conf -g 'daemon off;'
