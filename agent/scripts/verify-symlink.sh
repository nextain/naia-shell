#!/usr/bin/env bash
# verify-symlink.sh — naia-memory dist integrity check.
#
# Post-#272 reconcile: the legacy `projects/alpha-memory` symlink is gone —
# naia-memory is the real package. This script verifies the file:path dep
# resolved correctly and the build artifact is present.
#
# Exit code:
#   0 = naia-memory wired correctly (production wire OK)
#   1 = dep unresolved or dist missing (immediate fix needed)
set -u

NAIA_REAL="/var/home/luke/alpha-adk/projects/naia-memory"
DIST_CHECK="${NAIA_REAL}/dist/memory/index.js"

echo "[verify-memory] checking naia-memory dist integrity..."

if [ ! -d "${NAIA_REAL}" ]; then
  echo "[verify-memory] FAIL: ${NAIA_REAL} 부재"
  echo "  fix: alpha-adk root에서 git submodule update --init projects/naia-memory"
  exit 1
fi

if [ ! -f "${DIST_CHECK}" ]; then
  echo "[verify-memory] FAIL: dist 손상 — ${DIST_CHECK} 부재"
  echo "  fix: cd ${NAIA_REAL} && pnpm build"
  exit 1
fi

echo "[verify-memory] OK — naia-memory dist 정상"
echo "  path: ${NAIA_REAL}"
echo "  dist sample: ${DIST_CHECK} 존재"
exit 0
