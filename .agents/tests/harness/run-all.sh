#!/bin/bash
# Harness Engineering Test Suite
# Run from project root: bash .agents/tests/harness/run-all.sh
#
# Tests each hook by simulating Claude Code's stdin JSON protocol.
# Exit 0 = all pass, Exit 1 = failure(s).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
PASS=0
FAIL=0
TOTAL=0

# Windows compatibility: Git Bash uses /tmp but Node.js (Windows native) resolves
# /tmp paths differently. Use cygpath -m to produce C:/... style paths that both
# bash and Windows Node.js can access via the same absolute path.
if command -v cygpath >/dev/null 2>&1; then
    _mktemp_d() { cygpath -m "$(mktemp -d)"; }
else
    _mktemp_d() { mktemp -d; }
fi

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() {
    PASS=$((PASS + 1))
    TOTAL=$((TOTAL + 1))
    echo -e "  ${GREEN}✓${NC} $1"
}

fail() {
    FAIL=$((FAIL + 1))
    TOTAL=$((TOTAL + 1))
    echo -e "  ${RED}✗${NC} $1"
    echo -e "    ${RED}Expected:${NC} $2"
    echo -e "    ${RED}Got:${NC} $3"
}

# ─── Test Helper ───────────────────────────────────────────

run_hook() {
    local hook_script="$1"
    local stdin_json="$2"
    echo "$stdin_json" | node "$PROJECT_ROOT/.claude/hooks/$hook_script" 2>/dev/null || true
}

# run_hook_strict: returns "EXIT:N|OUTPUT" so tests can check exit code
run_hook_strict() {
    local hook_script="$1"
    local stdin_json="$2"
    local exit_code=0
    local output
    output=$(echo "$stdin_json" | node "$PROJECT_ROOT/.claude/hooks/$hook_script" 2>/dev/null) || exit_code=$?
    echo "EXIT:${exit_code}|${output}"
}

# ─── 1. sync-entry-points.js ──────────────────────────────

echo ""
echo -e "${YELLOW}═══ Test: sync-entry-points.js ═══${NC}"

# Setup: create temp dir with entry point files
TMPDIR_SYNC="$(_mktemp_d)"
echo "# Test content AGENTS" > "$TMPDIR_SYNC/AGENTS.md"
echo "# Test content AGENTS" > "$TMPDIR_SYNC/CLAUDE.md"
echo "# Test content AGENTS" > "$TMPDIR_SYNC/GEMINI.md"

# Test 1.1: Edit AGENTS.md → should sync to CLAUDE.md and GEMINI.md
echo "# UPDATED from AGENTS" > "$TMPDIR_SYNC/AGENTS.md"
OUTPUT=$(run_hook "sync-entry-points.js" "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$TMPDIR_SYNC/AGENTS.md\"}}")

if grep -q "UPDATED from AGENTS" "$TMPDIR_SYNC/CLAUDE.md" 2>/dev/null; then
    pass "1.1 AGENTS.md → CLAUDE.md synced"
else
    fail "1.1 AGENTS.md → CLAUDE.md synced" "UPDATED from AGENTS" "$(cat "$TMPDIR_SYNC/CLAUDE.md" 2>/dev/null)"
fi

if grep -q "UPDATED from AGENTS" "$TMPDIR_SYNC/GEMINI.md" 2>/dev/null; then
    pass "1.2 AGENTS.md → GEMINI.md synced"
else
    fail "1.2 AGENTS.md → GEMINI.md synced" "UPDATED from AGENTS" "$(cat "$TMPDIR_SYNC/GEMINI.md" 2>/dev/null)"
fi

# Test 1.3: Output contains additionalContext
if echo "$OUTPUT" | grep -q "additionalContext"; then
    pass "1.3 Returns additionalContext JSON"
else
    fail "1.3 Returns additionalContext JSON" "JSON with additionalContext" "$OUTPUT"
fi

# Test 1.4: Non-entry-point file → no sync
echo "# Original" > "$TMPDIR_SYNC/CLAUDE.md"
OUTPUT=$(run_hook "sync-entry-points.js" "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$TMPDIR_SYNC/README.md\"}}")
if grep -q "Original" "$TMPDIR_SYNC/CLAUDE.md" 2>/dev/null; then
    pass "1.4 Non-entry-point file ignored"
else
    fail "1.4 Non-entry-point file ignored" "Original content preserved" "$(cat "$TMPDIR_SYNC/CLAUDE.md" 2>/dev/null)"
fi

# Test 1.5: GEMINI.md doesn't exist → only sync CLAUDE.md
rm -f "$TMPDIR_SYNC/GEMINI.md"
echo "# FROM AGENTS no gemini" > "$TMPDIR_SYNC/AGENTS.md"
OUTPUT=$(run_hook "sync-entry-points.js" "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$TMPDIR_SYNC/AGENTS.md\"}}")
if grep -q "FROM AGENTS no gemini" "$TMPDIR_SYNC/CLAUDE.md" 2>/dev/null && [ ! -f "$TMPDIR_SYNC/GEMINI.md" ]; then
    pass "1.5 Missing GEMINI.md → not created, CLAUDE.md still synced"
else
    fail "1.5 Missing GEMINI.md handling" "CLAUDE synced, GEMINI not created" "CLAUDE=$(cat "$TMPDIR_SYNC/CLAUDE.md" 2>/dev/null) GEMINI exists=$(test -f "$TMPDIR_SYNC/GEMINI.md" && echo yes || echo no)"
fi

# Test 1.6: Wrong tool_name → no action (exit 0, no file change)
echo "# Should not change" > "$TMPDIR_SYNC/AGENTS.md"
echo "# Original claude" > "$TMPDIR_SYNC/CLAUDE.md"
STRICT=$(run_hook_strict "sync-entry-points.js" "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$TMPDIR_SYNC/AGENTS.md\"}}")
EXIT_CODE="${STRICT%%|*}"; EXIT_CODE="${EXIT_CODE#EXIT:}"
if grep -q "Original claude" "$TMPDIR_SYNC/CLAUDE.md" 2>/dev/null && [ "$EXIT_CODE" = "0" ]; then
    pass "1.6 Read tool ignored (exit 0, no sync)"
else
    fail "1.6 Read tool ignored (exit 0)" "exit=0, CLAUDE unchanged" "exit=$EXIT_CODE, CLAUDE=$(cat "$TMPDIR_SYNC/CLAUDE.md" 2>/dev/null)"
fi

# Test 1.7: CLAUDE.md as source → syncs to AGENTS.md and GEMINI.md
TMPDIR_SYNC2="$(_mktemp_d)"
echo "# original" > "$TMPDIR_SYNC2/AGENTS.md"
echo "# original" > "$TMPDIR_SYNC2/CLAUDE.md"
echo "# original" > "$TMPDIR_SYNC2/GEMINI.md"
echo "# FROM CLAUDE" > "$TMPDIR_SYNC2/CLAUDE.md"
OUTPUT=$(run_hook "sync-entry-points.js" "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$TMPDIR_SYNC2/CLAUDE.md\"}}")
if grep -q "FROM CLAUDE" "$TMPDIR_SYNC2/AGENTS.md" 2>/dev/null && grep -q "FROM CLAUDE" "$TMPDIR_SYNC2/GEMINI.md" 2>/dev/null; then
    pass "1.7 CLAUDE.md as source → AGENTS.md + GEMINI.md synced"
else
    fail "1.7 CLAUDE.md as source" "Both synced" "AGENTS=$(cat "$TMPDIR_SYNC2/AGENTS.md" 2>/dev/null) GEMINI=$(cat "$TMPDIR_SYNC2/GEMINI.md" 2>/dev/null)"
fi

# Test 1.8: GEMINI.md as source → syncs to AGENTS.md and CLAUDE.md
echo "# FROM GEMINI" > "$TMPDIR_SYNC2/GEMINI.md"
OUTPUT=$(run_hook "sync-entry-points.js" "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$TMPDIR_SYNC2/GEMINI.md\"}}")
if grep -q "FROM GEMINI" "$TMPDIR_SYNC2/AGENTS.md" 2>/dev/null && grep -q "FROM GEMINI" "$TMPDIR_SYNC2/CLAUDE.md" 2>/dev/null; then
    pass "1.8 GEMINI.md as source → AGENTS.md + CLAUDE.md synced"
else
    fail "1.8 GEMINI.md as source" "Both synced" "AGENTS=$(cat "$TMPDIR_SYNC2/AGENTS.md" 2>/dev/null) CLAUDE=$(cat "$TMPDIR_SYNC2/CLAUDE.md" 2>/dev/null)"
fi

# Test 1.9: Write tool triggers sync (not just Edit)
echo "# VIA WRITE" > "$TMPDIR_SYNC2/AGENTS.md"
OUTPUT=$(run_hook "sync-entry-points.js" "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$TMPDIR_SYNC2/AGENTS.md\"}}")
if grep -q "VIA WRITE" "$TMPDIR_SYNC2/CLAUDE.md" 2>/dev/null; then
    pass "1.9 Write tool triggers sync"
else
    fail "1.9 Write tool triggers sync" "VIA WRITE" "$(cat "$TMPDIR_SYNC2/CLAUDE.md" 2>/dev/null)"
fi

# Test 1.10: Lockfile prevents recursive sync
LOCKFILE="/tmp/.entry-points-sync.lock"
echo "locked" > "$LOCKFILE"
echo "# SHOULD NOT SYNC" > "$TMPDIR_SYNC2/AGENTS.md"
echo "# KEPT" > "$TMPDIR_SYNC2/CLAUDE.md"
OUTPUT=$(run_hook "sync-entry-points.js" "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$TMPDIR_SYNC2/AGENTS.md\"}}")
if grep -q "KEPT" "$TMPDIR_SYNC2/CLAUDE.md" 2>/dev/null; then
    pass "1.10 Lockfile prevents recursive sync"
else
    fail "1.10 Lockfile prevents recursive sync" "KEPT (no sync)" "$(cat "$TMPDIR_SYNC2/CLAUDE.md" 2>/dev/null)"
fi
rm -f "$LOCKFILE"

# Test 1.11: Malformed JSON stdin → no crash
OUTPUT=$(echo "NOT JSON" | node "$PROJECT_ROOT/.claude/hooks/sync-entry-points.js" 2>/dev/null || true)
if [ -z "$OUTPUT" ]; then
    pass "1.11 Malformed JSON → graceful exit (no crash)"
else
    fail "1.11 Malformed JSON → graceful exit" "(empty)" "$OUTPUT"
fi

rm -rf "$TMPDIR_SYNC" "$TMPDIR_SYNC2"

# ─── 2. commit-guard.js ───────────────────────────────────

echo ""
echo -e "${YELLOW}═══ Test: commit-guard.js ═══${NC}"

TMPDIR_CG="$(_mktemp_d)"
mkdir -p "$TMPDIR_CG/.agents/progress"

# Test 2.1: No progress file → no warning (silent pass, exit 0)
STRICT=$(run_hook_strict "commit-guard.js" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git commit -m test\"},\"cwd\":\"$TMPDIR_CG\"}")
EXIT_CODE="${STRICT%%|*}"; EXIT_CODE="${EXIT_CODE#EXIT:}"
OUTPUT="${STRICT#*|}"
if [ -z "$OUTPUT" ] && [ "$EXIT_CODE" = "0" ]; then
    pass "2.1 No progress file → silent pass (exit 0)"
else
    fail "2.1 No progress file → silent pass (exit 0)" "exit=0, output=(empty)" "exit=$EXIT_CODE, output=$OUTPUT"
fi

# Test 2.2: Phase = build → should warn
echo '{"issue":"#99","current_phase":"build"}' > "$TMPDIR_CG/.agents/progress/99.json"
OUTPUT=$(run_hook "commit-guard.js" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git commit -m test\"},\"cwd\":\"$TMPDIR_CG\"}")
if echo "$OUTPUT" | grep -q "Committing at phase"; then
    pass "2.2 Phase 'build' → commit warning"
else
    fail "2.2 Phase 'build' → commit warning" "Warning about premature commit" "$OUTPUT"
fi

# Test 2.3: Phase = build → mentions remaining phases
if echo "$OUTPUT" | grep -q "e2e_test"; then
    pass "2.3 Warning includes remaining phases (e2e_test)"
else
    fail "2.3 Warning includes remaining phases" "mentions e2e_test" "$OUTPUT"
fi

# Test 2.4: Phase = report → no warning (past sync_verify, exit 0)
echo '{"issue":"#99","current_phase":"report"}' > "$TMPDIR_CG/.agents/progress/99.json"
STRICT=$(run_hook_strict "commit-guard.js" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git commit -m test\"},\"cwd\":\"$TMPDIR_CG\"}")
EXIT_CODE="${STRICT%%|*}"; EXIT_CODE="${EXIT_CODE#EXIT:}"
OUTPUT="${STRICT#*|}"
if [ -z "$OUTPUT" ] && [ "$EXIT_CODE" = "0" ]; then
    pass "2.4 Phase 'report' → no warning (exit 0)"
else
    fail "2.4 Phase 'report' → no warning (exit 0)" "exit=0, output=(empty)" "exit=$EXIT_CODE, output=$OUTPUT"
fi

# Test 2.5: Phase = commit → no warning (exit 0)
echo '{"issue":"#99","current_phase":"commit"}' > "$TMPDIR_CG/.agents/progress/99.json"
STRICT=$(run_hook_strict "commit-guard.js" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git commit -m done\"},\"cwd\":\"$TMPDIR_CG\"}")
EXIT_CODE="${STRICT%%|*}"; EXIT_CODE="${EXIT_CODE#EXIT:}"
OUTPUT="${STRICT#*|}"
if [ -z "$OUTPUT" ] && [ "$EXIT_CODE" = "0" ]; then
    pass "2.5 Phase 'commit' → no warning (exit 0)"
else
    fail "2.5 Phase 'commit' → no warning (exit 0)" "exit=0, output=(empty)" "exit=$EXIT_CODE, output=$OUTPUT"
fi

# Test 2.6: Non-commit bash command → ignored (exit 0)
echo '{"issue":"#99","current_phase":"build"}' > "$TMPDIR_CG/.agents/progress/99.json"
STRICT=$(run_hook_strict "commit-guard.js" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"npm test\"},\"cwd\":\"$TMPDIR_CG\"}")
EXIT_CODE="${STRICT%%|*}"; EXIT_CODE="${EXIT_CODE#EXIT:}"
OUTPUT="${STRICT#*|}"
if [ -z "$OUTPUT" ] && [ "$EXIT_CODE" = "0" ]; then
    pass "2.6 Non-commit command (npm test) → ignored (exit 0)"
else
    fail "2.6 Non-commit command ignored (exit 0)" "exit=0, output=(empty)" "exit=$EXIT_CODE, output=$OUTPUT"
fi

# Test 2.7: Invalid JSON in progress file → silent pass
echo 'NOT JSON' > "$TMPDIR_CG/.agents/progress/99.json"
OUTPUT=$(run_hook "commit-guard.js" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git commit -m test\"},\"cwd\":\"$TMPDIR_CG\"}")
if [ -z "$OUTPUT" ]; then
    pass "2.7 Corrupt progress file → silent pass (no crash)"
else
    fail "2.7 Corrupt progress file → silent pass" "(empty)" "$OUTPUT"
fi

# Test 2.8: Phase = e2e_test → should still warn (before sync_verify)
echo '{"issue":"#99","current_phase":"e2e_test"}' > "$TMPDIR_CG/.agents/progress/99.json"
OUTPUT=$(run_hook "commit-guard.js" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git commit -m test\"},\"cwd\":\"$TMPDIR_CG\"}")
if echo "$OUTPUT" | grep -q "Committing at phase"; then
    pass "2.8 Phase 'e2e_test' → still warns (sync not done)"
else
    fail "2.8 Phase 'e2e_test' → warning" "Warning about premature commit" "$OUTPUT"
fi

# Test 2.9: git commit --amend → should still trigger guard
echo '{"issue":"#99","current_phase":"build"}' > "$TMPDIR_CG/.agents/progress/99.json"
OUTPUT=$(run_hook "commit-guard.js" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git commit --amend\"},\"cwd\":\"$TMPDIR_CG\"}")
if echo "$OUTPUT" | grep -q "Committing at phase"; then
    pass "2.9 git commit --amend → triggers guard"
else
    fail "2.9 git commit --amend" "Warning" "$OUTPUT"
fi

# Test 2.10: git commit -a -m → should still trigger guard
OUTPUT=$(run_hook "commit-guard.js" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git commit -a -m 'test'\"},\"cwd\":\"$TMPDIR_CG\"}")
if echo "$OUTPUT" | grep -q "Committing at phase"; then
    pass "2.10 git commit -a -m → triggers guard"
else
    fail "2.10 git commit -a -m" "Warning" "$OUTPUT"
fi

# Test 2.11: Multiple progress files → picks most recent by mtime
# Clean up prior files first to isolate this test
rm -f "$TMPDIR_CG/.agents/progress/"*.json
echo '{"issue":"#10","current_phase":"report"}' > "$TMPDIR_CG/.agents/progress/10.json"
sleep 0.2
echo '{"issue":"#20","current_phase":"build"}' > "$TMPDIR_CG/.agents/progress/20.json"
OUTPUT=$(run_hook "commit-guard.js" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git commit -m x\"},\"cwd\":\"$TMPDIR_CG\"}")
# Must warn (build < sync_verify) AND reference issue #20 (most recent), NOT #10
if echo "$OUTPUT" | grep -q "Committing at phase" && echo "$OUTPUT" | grep -q "#20"; then
    pass "2.11 Multiple progress files → picks most recent (issue #20, build warns)"
else
    fail "2.11 Multiple progress files → picks #20" "Warning with issue #20" "$OUTPUT"
fi

# Test 2.12: Unknown phase name → silent pass (not in PHASE_ORDER)
echo '{"issue":"#99","current_phase":"unknown_phase"}' > "$TMPDIR_CG/.agents/progress/99.json"
OUTPUT=$(run_hook "commit-guard.js" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git commit -m test\"},\"cwd\":\"$TMPDIR_CG\"}")
if [ -z "$OUTPUT" ]; then
    pass "2.12 Unknown phase → silent pass (graceful)"
else
    fail "2.12 Unknown phase → silent pass" "(empty)" "$OUTPUT"
fi

# Test 2.13: Empty progress dir (no .json files) → silent pass
rm -f "$TMPDIR_CG/.agents/progress/"*.json
OUTPUT=$(run_hook "commit-guard.js" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git commit -m test\"},\"cwd\":\"$TMPDIR_CG\"}")
if [ -z "$OUTPUT" ]; then
    pass "2.13 Empty progress dir → silent pass"
else
    fail "2.13 Empty progress dir → silent pass" "(empty)" "$OUTPUT"
fi

# Test 2.14: Edit tool (not Bash) → ignored even with git commit in input
echo '{"issue":"#99","current_phase":"build"}' > "$TMPDIR_CG/.agents/progress/99.json"
OUTPUT=$(run_hook "commit-guard.js" "{\"tool_name\":\"Edit\",\"tool_input\":{\"command\":\"git commit -m test\"},\"cwd\":\"$TMPDIR_CG\"}")
if [ -z "$OUTPUT" ]; then
    pass "2.14 Edit tool with git commit text → ignored (Bash-only)"
else
    fail "2.14 Edit tool ignored" "(empty)" "$OUTPUT"
fi

# Test 2.15: Malformed JSON stdin → no crash
OUTPUT=$(echo "NOT JSON" | node "$PROJECT_ROOT/.claude/hooks/commit-guard.js" 2>/dev/null || true)
if [ -z "$OUTPUT" ]; then
    pass "2.15 Malformed JSON stdin → graceful exit (no crash)"
else
    fail "2.15 Malformed JSON → graceful exit" "(empty)" "$OUTPUT"
fi

# ── T2 Decision Shadow advisory tests ──

# Test 2.16: rejected_alternatives non-empty → advisory shown
TMPDIR_CG2="$(_mktemp_d)"
mkdir -p "$TMPDIR_CG2/.agents/progress"
echo '{"issue":"#99","current_phase":"report","rejected_alternatives":[{"approach":"approach-A","reason":"too slow","date":"2026-03-18"}]}' > "$TMPDIR_CG2/.agents/progress/99.json"
OUTPUT=$(run_hook "commit-guard.js" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git commit -m test\"},\"cwd\":\"$TMPDIR_CG2\"}")
if echo "$OUTPUT" | grep -q "rejected alternative"; then
    pass "2.16 rejected_alternatives non-empty → Rejected: trailer advisory shown"
else
    fail "2.16 rejected_alternatives advisory" "mention of 'rejected alternative'" "$OUTPUT"
fi

# Test 2.17: rejected_alternatives empty array → no advisory
echo '{"issue":"#99","current_phase":"report","rejected_alternatives":[]}' > "$TMPDIR_CG2/.agents/progress/99.json"
STRICT=$(run_hook_strict "commit-guard.js" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git commit -m test\"},\"cwd\":\"$TMPDIR_CG2\"}")
OUTPUT="${STRICT#*|}"
if [ -z "$OUTPUT" ]; then
    pass "2.17 rejected_alternatives empty array → no advisory"
else
    fail "2.17 rejected_alternatives empty → no advisory" "(empty)" "$OUTPUT"
fi

# Test 2.18: no rejected_alternatives field → no advisory (backward compat)
echo '{"issue":"#99","current_phase":"report"}' > "$TMPDIR_CG2/.agents/progress/99.json"
STRICT=$(run_hook_strict "commit-guard.js" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git commit -m test\"},\"cwd\":\"$TMPDIR_CG2\"}")
OUTPUT="${STRICT#*|}"
if [ -z "$OUTPUT" ]; then
    pass "2.18 No rejected_alternatives field → no advisory (backward compat)"
else
    fail "2.18 No field → no advisory" "(empty)" "$OUTPUT"
fi

# Test 2.19: early phase + rejected_alternatives → both phase warning AND trailer advisory
echo '{"issue":"#99","current_phase":"build","rejected_alternatives":[{"approach":"X","reason":"Y","date":"2026-03-18"}]}' > "$TMPDIR_CG2/.agents/progress/99.json"
OUTPUT=$(run_hook "commit-guard.js" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git commit -m test\"},\"cwd\":\"$TMPDIR_CG2\"}")
PHASE_WARN=$(echo "$OUTPUT" | grep -c "Committing at phase" || true)
TRAILER_WARN=$(echo "$OUTPUT" | grep -c "rejected alternative" || true)
if [ "$PHASE_WARN" -gt 0 ] && [ "$TRAILER_WARN" -gt 0 ]; then
    pass "2.19 Early phase + rejected_alternatives → both warnings shown"
else
    fail "2.19 Both warnings" "phase warn + trailer advisory" "phase=$PHASE_WARN trailer=$TRAILER_WARN"
fi

# Test 2.20: constraints_discovered non-empty → Constraint: trailer advisory shown
echo '{"issue":"#99","current_phase":"report","constraints_discovered":[{"constraint":"WebKitGTK sampleRate","scope":"shell/src/audio/*","date":"2026-03-18"}]}' > "$TMPDIR_CG2/.agents/progress/99.json"
OUTPUT=$(run_hook "commit-guard.js" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git commit -m test\"},\"cwd\":\"$TMPDIR_CG2\"}")
if echo "$OUTPUT" | grep -q "constraint"; then
    pass "2.20 constraints_discovered non-empty → Constraint: trailer advisory shown"
else
    fail "2.20 constraints_discovered advisory" "mention of 'constraint'" "$OUTPUT"
fi

rm -rf "$TMPDIR_CG2"

# ── Gate approval checks ──

TMPDIR_CG3="$(_mktemp_d)"
mkdir -p "$TMPDIR_CG3/.agents/progress"

# Test 2.21: phase=sync_verify + gate_approvals missing understand → warning
echo '{"issue":"#99","current_phase":"sync_verify","gate_approvals":{"scope":"2026-01-01T00:00Z","plan":"2026-01-01T00:00Z","sync":"2026-01-01T00:00Z"}}' > "$TMPDIR_CG3/.agents/progress/99.json"
OUTPUT=$(run_hook "commit-guard.js" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git commit -m test\"},\"cwd\":\"$TMPDIR_CG3\"}")
if echo "$OUTPUT" | grep -q "understand"; then
    pass "2.21 sync_verify + missing 'understand' gate → gate warning"
else
    fail "2.21 gate missing 'understand'" "warning with 'understand'" "$OUTPUT"
fi

# Test 2.22: phase=sync_verify + all 4 gates present → no warning
echo '{"issue":"#99","current_phase":"sync_verify","gate_approvals":{"understand":"2026-01-01T00:00Z","scope":"2026-01-01T00:00Z","plan":"2026-01-01T00:00Z","sync":"2026-01-01T00:00Z"}}' > "$TMPDIR_CG3/.agents/progress/99.json"
STRICT=$(run_hook_strict "commit-guard.js" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git commit -m test\"},\"cwd\":\"$TMPDIR_CG3\"}")
OUTPUT="${STRICT#*|}"
if [ -z "$OUTPUT" ]; then
    pass "2.22 sync_verify + all 4 gates present → no warning"
else
    fail "2.22 all gates present → no warning" "(empty)" "$OUTPUT"
fi

# Test 2.23: phase=sync_verify + missing sync gate → warning
echo '{"issue":"#99","current_phase":"sync_verify","gate_approvals":{"understand":"2026-01-01T00:00Z","scope":"2026-01-01T00:00Z","plan":"2026-01-01T00:00Z"}}' > "$TMPDIR_CG3/.agents/progress/99.json"
OUTPUT=$(run_hook "commit-guard.js" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git commit -m test\"},\"cwd\":\"$TMPDIR_CG3\"}")
if echo "$OUTPUT" | grep -q "sync"; then
    pass "2.23 sync_verify + missing 'sync' gate → warning"
else
    fail "2.23 gate missing 'sync'" "warning with 'sync'" "$OUTPUT"
fi

# Test 2.24: phase=build + missing gates → NO gate warning (phase warning covers early commits)
echo '{"issue":"#99","current_phase":"build","gate_approvals":{}}' > "$TMPDIR_CG3/.agents/progress/99.json"
OUTPUT=$(run_hook "commit-guard.js" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git commit -m test\"},\"cwd\":\"$TMPDIR_CG3\"}")
GATE_WARN=$(echo "$OUTPUT" | grep -c "Gate approval" || true)
PHASE_WARN=$(echo "$OUTPUT" | grep -c "Committing at phase" || true)
if [ "$GATE_WARN" -eq 0 ] && [ "$PHASE_WARN" -gt 0 ]; then
    pass "2.24 build phase + missing gates → phase warning only (no duplicate gate warning)"
else
    fail "2.24 build phase → no gate warn" "gate_warn=0, phase_warn>0" "gate=$GATE_WARN phase=$PHASE_WARN"
fi

# Test 2.25: phase=sync_verify + gate_approvals is empty object {} → warning for all 4 gates
echo '{"issue":"#99","current_phase":"sync_verify","gate_approvals":{}}' > "$TMPDIR_CG3/.agents/progress/99.json"
OUTPUT=$(run_hook "commit-guard.js" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git commit -m test\"},\"cwd\":\"$TMPDIR_CG3\"}")
if echo "$OUTPUT" | grep -q "Gate approval"; then
    pass "2.25 sync_verify + empty gate_approvals {} → gate warning"
else
    fail "2.25 empty gate_approvals" "Gate approval warning" "$OUTPUT"
fi

# Test 2.26: phase=report + all 4 gates → no warning
echo '{"issue":"#99","current_phase":"report","gate_approvals":{"understand":"2026-01-01T00:00Z","scope":"2026-01-01T00:00Z","plan":"2026-01-01T00:00Z","sync":"2026-01-01T00:00Z"}}' > "$TMPDIR_CG3/.agents/progress/99.json"
STRICT=$(run_hook_strict "commit-guard.js" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git commit -m test\"},\"cwd\":\"$TMPDIR_CG3\"}")
OUTPUT="${STRICT#*|}"
if [ -z "$OUTPUT" ]; then
    pass "2.26 report phase + all gates → no warning"
else
    fail "2.26 report + all gates → no warning" "(empty)" "$OUTPUT"
fi

rm -rf "$TMPDIR_CG3"

# Test 2.27: upstream_issue_ref present → advisory shown
TMPDIR_CG4="$(_mktemp_d)"
mkdir -p "$TMPDIR_CG4/.agents/progress"
echo '{"issue":"#73","current_phase":"report","gate_approvals":{"understand":"2026-03-18T10:00Z","scope":"2026-03-18T10:15Z","plan":"2026-03-18T11:00Z","sync":"2026-03-18T12:00Z"},"upstream_issue_ref":"vllm-project/vllm#16052"}' > "$TMPDIR_CG4/.agents/progress/73.json"
OUTPUT=$(run_hook "commit-guard.js" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git commit -m x\"},\"cwd\":\"$TMPDIR_CG4\"}")
if echo "$OUTPUT" | grep -qi "upstream"; then
    pass "2.27 upstream_issue_ref present → upstream contribution advisory shown"
else
    fail "2.27 upstream_issue_ref advisory" "mention of 'upstream'" "$OUTPUT"
fi

# ── New phases (4.5 / 4.7) tests ──

# Test 2.29: Phase 'research_artifact' → should warn (phase 4.5, before plan)
echo '{"issue":"#87","current_phase":"research_artifact"}' > "$TMPDIR_CG/.agents/progress/87.json"
OUTPUT=$(run_hook "commit-guard.js" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git commit -m test\"},\"cwd\":\"$TMPDIR_CG\"}")
if echo "$OUTPUT" | grep -q "Committing at phase"; then
    pass "2.29 Phase 'research_artifact' → warns (before plan)"
else
    fail "2.29 Phase 'research_artifact' → warning" "Warning about premature commit" "$OUTPUT"
fi

# Test 2.30: Phase 'annotation_cycle' → should warn (phase 4.7, before plan)
echo '{"issue":"#87","current_phase":"annotation_cycle"}' > "$TMPDIR_CG/.agents/progress/87.json"
OUTPUT=$(run_hook "commit-guard.js" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git commit -m test\"},\"cwd\":\"$TMPDIR_CG\"}")
if echo "$OUTPUT" | grep -q "Committing at phase"; then
    pass "2.30 Phase 'annotation_cycle' → warns (before plan)"
else
    fail "2.30 Phase 'annotation_cycle' → warning" "Warning about premature commit" "$OUTPUT"
fi

# Test 2.31: research_artifact warning includes annotation_cycle in remaining phases
echo '{"issue":"#87","current_phase":"research_artifact"}' > "$TMPDIR_CG/.agents/progress/87.json"
OUTPUT=$(run_hook "commit-guard.js" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git commit -m test\"},\"cwd\":\"$TMPDIR_CG\"}")
if echo "$OUTPUT" | grep -q "annotation_cycle"; then
    pass "2.31 research_artifact warning includes annotation_cycle in remaining phases"
else
    fail "2.31 research_artifact remaining phases" "annotation_cycle mentioned" "$OUTPUT"
fi

# Test 2.28: upstream_issue_ref absent → no advisory
echo '{"issue":"#42","current_phase":"report","gate_approvals":{"understand":"2026-03-18T10:00Z","scope":"2026-03-18T10:15Z","plan":"2026-03-18T11:00Z","sync":"2026-03-18T12:00Z"}}' > "$TMPDIR_CG4/.agents/progress/42.json"
rm "$TMPDIR_CG4/.agents/progress/73.json"
OUTPUT=$(run_hook "commit-guard.js" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git commit -m x\"},\"cwd\":\"$TMPDIR_CG4\"}")
if echo "$OUTPUT" | grep -qi "upstream"; then
    fail "2.28 No upstream_issue_ref → no upstream advisory" "(empty)" "$OUTPUT"
else
    pass "2.28 No upstream_issue_ref → no upstream advisory"
fi
rm -rf "$TMPDIR_CG4"

rm -rf "$TMPDIR_CG"

# ─── 3. cascade-check.js ──────────────────────────────────

echo ""
echo -e "${YELLOW}═══ Test: cascade-check.js ═══${NC}"

# Test 3.1: Edit .agents/context/vision.yaml → remind about .users/ mirrors
OUTPUT=$(run_hook "cascade-check.js" "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"/project/.agents/context/vision.yaml\"}}")
if echo "$OUTPUT" | grep -q "Triple-mirror rule"; then
    pass "3.1 .agents/context/*.yaml → triple-mirror reminder"
else
    fail "3.1 .agents/context/*.yaml → reminder" "Triple-mirror rule mention" "$OUTPUT"
fi

# Test 3.2: Reminder includes both .users/context/ and .users/context/ko/
if echo "$OUTPUT" | grep -q "users/context/ko/"; then
    pass "3.2 Reminder includes ko/ mirror path"
else
    fail "3.2 Reminder includes ko/ path" ".users/context/ko/" "$OUTPUT"
fi

# Test 3.3: Edit agents-rules.json → SoT reminder
OUTPUT=$(run_hook "cascade-check.js" "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"/project/.agents/context/agents-rules.json\"}}")
if echo "$OUTPUT" | grep -q "SoT"; then
    pass "3.3 agents-rules.json → SoT reminder"
else
    fail "3.3 agents-rules.json → SoT reminder" "SoT mention" "$OUTPUT"
fi

# Test 3.4: Edit .users/context/vision.md → remind about .agents/ and ko/
OUTPUT=$(run_hook "cascade-check.js" "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"/project/.users/context/vision.md\"}}")
if echo "$OUTPUT" | grep -q ".agents/context/vision.yaml"; then
    pass "3.4 .users/context/*.md → reminds .agents/ mirror"
else
    fail "3.4 .users/context/*.md → reminder" ".agents/context/vision.yaml" "$OUTPUT"
fi

# Test 3.5: Edit .users/context/ko/vision.md → remind about .agents/ and .users/context/
OUTPUT=$(run_hook "cascade-check.js" "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"/project/.users/context/ko/vision.md\"}}")
if echo "$OUTPUT" | grep -q ".agents/context/vision.yaml"; then
    pass "3.5 .users/context/ko/*.md → reminds .agents/ mirror"
else
    fail "3.5 .users/context/ko/*.md → reminder" ".agents/context/vision.yaml" "$OUTPUT"
fi

# Test 3.6: Edit unrelated file → no output (exit 0)
STRICT=$(run_hook_strict "cascade-check.js" "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"/project/shell/src/App.tsx\"}}")
EXIT_CODE="${STRICT%%|*}"; EXIT_CODE="${EXIT_CODE#EXIT:}"
OUTPUT="${STRICT#*|}"
if [ -z "$OUTPUT" ] && [ "$EXIT_CODE" = "0" ]; then
    pass "3.6 Unrelated file → no reminder (exit 0)"
else
    fail "3.6 Unrelated file → no reminder (exit 0)" "exit=0, output=(empty)" "exit=$EXIT_CODE, output=$OUTPUT"
fi

# Test 3.7: Read tool → ignored (exit 0)
STRICT=$(run_hook_strict "cascade-check.js" "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"/project/.agents/context/vision.yaml\"}}")
EXIT_CODE="${STRICT%%|*}"; EXIT_CODE="${EXIT_CODE#EXIT:}"
OUTPUT="${STRICT#*|}"
if [ -z "$OUTPUT" ] && [ "$EXIT_CODE" = "0" ]; then
    pass "3.7 Read tool → ignored (exit 0)"
else
    fail "3.7 Read tool → ignored (exit 0)" "exit=0, output=(empty)" "exit=$EXIT_CODE, output=$OUTPUT"
fi

# Test 3.8: Malformed JSON stdin → no crash
OUTPUT=$(echo "NOT JSON" | node "$PROJECT_ROOT/.claude/hooks/cascade-check.js" 2>/dev/null || true)
if [ -z "$OUTPUT" ]; then
    pass "3.8 Malformed JSON → graceful exit (no crash)"
else
    fail "3.8 Malformed JSON → graceful exit" "(empty)" "$OUTPUT"
fi

# Test 3.9: .agents/context/*.json (non agents-rules) → triple-mirror reminder
OUTPUT=$(run_hook "cascade-check.js" "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"/project/.agents/context/custom-config.json\"}}")
if echo "$OUTPUT" | grep -q "Triple-mirror rule"; then
    pass "3.9 .agents/context/*.json → triple-mirror reminder"
else
    fail "3.9 .agents/context/*.json → reminder" "Triple-mirror rule" "$OUTPUT"
fi

# Test 3.10: Write tool triggers cascade check (not just Edit)
OUTPUT=$(run_hook "cascade-check.js" "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"/project/.agents/context/testing.yaml\"}}")
if echo "$OUTPUT" | grep -q "Triple-mirror rule"; then
    pass "3.10 Write tool triggers cascade check"
else
    fail "3.10 Write tool triggers cascade" "Triple-mirror rule" "$OUTPUT"
fi

# Test 3.11: .users/context/ko/ edit → reminds both .agents/ AND .users/context/
OUTPUT=$(run_hook "cascade-check.js" "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"/project/.users/context/ko/architecture.md\"}}")
if echo "$OUTPUT" | grep -q ".users/context/architecture.md"; then
    pass "3.11 ko/ edit → also reminds English .users/ mirror"
else
    fail "3.11 ko/ → .users/ reminder" ".users/context/architecture.md" "$OUTPUT"
fi

# Test 3.12: agents-rules.json → gets BOTH triple-mirror AND SoT reminders
OUTPUT=$(run_hook "cascade-check.js" "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"/project/.agents/context/agents-rules.json\"}}")
TRIPLE=$(echo "$OUTPUT" | grep -c "Triple-mirror rule" || true)
SOT=$(echo "$OUTPUT" | grep -c "SoT" || true)
if [ "$TRIPLE" -gt 0 ] && [ "$SOT" -gt 0 ]; then
    pass "3.12 agents-rules.json → both triple-mirror AND SoT reminders"
else
    fail "3.12 agents-rules.json dual reminder" "Both Triple-mirror and SoT" "triple=$TRIPLE sot=$SOT"
fi

# ─── 4. Progress File Schema Validation ───────────────────

echo ""
echo -e "${YELLOW}═══ Test: Progress File Schema ═══${NC}"

TMPDIR_PF="$(_mktemp_d)"

# Test 4.1: Valid progress file
VALID_PROGRESS='{"issue":"#42","title":"Test feature","project":"naia-os","current_phase":"build","gate_approvals":{"understand":"2026-03-14T10:00Z","scope":"2026-03-14T10:15Z","plan":"2026-03-14T11:00Z"},"decisions":[{"decision":"Use pattern A","rationale":"Simpler","date":"2026-03-14"}],"surprises":[],"blockers":[],"updated_at":"2026-03-14T14:30Z"}'
echo "$VALID_PROGRESS" > "$TMPDIR_PF/42.json"

# Check it's valid JSON
if node -e "JSON.parse(require('fs').readFileSync('$TMPDIR_PF/42.json','utf8')); console.log('valid')" 2>/dev/null | grep -q "valid"; then
    pass "4.1 Progress file is valid JSON"
else
    fail "4.1 Progress file is valid JSON" "valid" "parse error"
fi

# Test 4.2: Required fields present
FIELDS=("issue" "current_phase" "gate_approvals" "decisions" "updated_at")
ALL_PRESENT=true
for field in "${FIELDS[@]}"; do
    if ! node -e "const d=JSON.parse(require('fs').readFileSync('$TMPDIR_PF/42.json','utf8')); if(!d['$field'] && d['$field']!==false) process.exit(1)" 2>/dev/null; then
        ALL_PRESENT=false
        break
    fi
done
if [ "$ALL_PRESENT" = true ]; then
    pass "4.2 All required fields present (issue, current_phase, gate_approvals, decisions, updated_at)"
else
    fail "4.2 Required fields" "All present" "Missing: $field"
fi

# Test 4.3: current_phase is a valid phase name
PHASE=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$TMPDIR_PF/42.json','utf8')).current_phase)" 2>/dev/null)
VALID_PHASES="issue understand scope investigate research_artifact annotation_cycle plan build review e2e_test post_test_review sync sync_verify report commit"
if echo "$VALID_PHASES" | grep -qw "$PHASE"; then
    pass "4.3 current_phase '$PHASE' is valid"
else
    fail "4.3 current_phase is valid" "one of: $VALID_PHASES" "$PHASE"
fi

# Test 4.4: gate_approvals has ISO timestamp format
TIMESTAMP=$(node -e "const d=JSON.parse(require('fs').readFileSync('$TMPDIR_PF/42.json','utf8')); console.log(d.gate_approvals.understand||'')" 2>/dev/null)
if echo "$TIMESTAMP" | grep -qE "^[0-9]{4}-[0-9]{2}-[0-9]{2}T"; then
    pass "4.4 gate_approvals timestamps are ISO format"
else
    fail "4.4 ISO timestamp format" "YYYY-MM-DDT..." "$TIMESTAMP"
fi

# Test 4.5: Missing required field (no current_phase) → commit-guard handles gracefully
TMPDIR_NEG="$(_mktemp_d)"
mkdir -p "$TMPDIR_NEG/.agents/progress"
echo '{"issue":"#99"}' > "$TMPDIR_NEG/.agents/progress/99.json"
OUTPUT=$(run_hook "commit-guard.js" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git commit -m test\"},\"cwd\":\"$TMPDIR_NEG\"}")
if [ -z "$OUTPUT" ]; then
    pass "4.5 Missing current_phase → commit-guard passes gracefully"
else
    fail "4.5 Missing current_phase" "(empty/graceful)" "$OUTPUT"
fi

# Test 4.6: Invalid phase name → commit-guard passes (unknown index = -1)
echo '{"issue":"#99","current_phase":"nonexistent_phase"}' > "$TMPDIR_NEG/.agents/progress/99.json"
OUTPUT=$(run_hook "commit-guard.js" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git commit -m test\"},\"cwd\":\"$TMPDIR_NEG\"}")
if [ -z "$OUTPUT" ]; then
    pass "4.6 Invalid phase name → commit-guard passes gracefully"
else
    fail "4.6 Invalid phase name" "(empty/graceful)" "$OUTPUT"
fi

# Test 4.7: Empty JSON object → commit-guard passes
echo '{}' > "$TMPDIR_NEG/.agents/progress/99.json"
OUTPUT=$(run_hook "commit-guard.js" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git commit -m test\"},\"cwd\":\"$TMPDIR_NEG\"}")
if [ -z "$OUTPUT" ]; then
    pass "4.7 Empty JSON object → commit-guard passes gracefully"
else
    fail "4.7 Empty JSON" "(empty/graceful)" "$OUTPUT"
fi

rm -rf "$TMPDIR_PF" "$TMPDIR_NEG"

# ─── 5. Integration: commit-guard + progress ──────────────

echo ""
echo -e "${YELLOW}═══ Test: Integration (commit-guard + progress lifecycle) ═══${NC}"

TMPDIR_INT="$(_mktemp_d)"
mkdir -p "$TMPDIR_INT/.agents/progress"

# Test 5.1: Simulate full lifecycle — phase progression should affect guard
PHASES_THAT_WARN=("issue" "understand" "scope" "investigate" "research_artifact" "annotation_cycle" "plan" "build" "review" "e2e_test" "post_test_review" "sync")
PHASES_THAT_PASS=("sync_verify" "report" "commit")

WARN_OK=true
for phase in "${PHASES_THAT_WARN[@]}"; do
    echo "{\"issue\":\"#1\",\"current_phase\":\"$phase\"}" > "$TMPDIR_INT/.agents/progress/1.json"
    OUTPUT=$(run_hook "commit-guard.js" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git commit -m x\"},\"cwd\":\"$TMPDIR_INT\"}")
    if ! echo "$OUTPUT" | grep -q "Committing at phase"; then
        WARN_OK=false
        fail "5.1 Phase '$phase' should warn on commit" "warning" "$OUTPUT"
        break
    fi
done
if [ "$WARN_OK" = true ]; then
    pass "5.1 All pre-sync_verify phases warn on commit (${#PHASES_THAT_WARN[@]} phases)"
fi

PASS_OK=true
for phase in "${PHASES_THAT_PASS[@]}"; do
    echo "{\"issue\":\"#1\",\"current_phase\":\"$phase\"}" > "$TMPDIR_INT/.agents/progress/1.json"
    OUTPUT=$(run_hook "commit-guard.js" "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git commit -m x\"},\"cwd\":\"$TMPDIR_INT\"}")
    if [ -n "$OUTPUT" ]; then
        PASS_OK=false
        fail "5.2 Phase '$phase' should pass silently" "(empty)" "$OUTPUT"
        break
    fi
done
if [ "$PASS_OK" = true ]; then
    pass "5.2 All post-sync_verify phases pass silently (${#PHASES_THAT_PASS[@]} phases)"
fi

rm -rf "$TMPDIR_INT"

# ─── 6. process-guard.js ──────────────────────────────────

echo ""
echo -e "${YELLOW}═══ Test: process-guard.js ═══${NC}"

# Helper: write a minimal JSONL with one assistant message
make_transcript() {
    local tmpfile="$1"
    local text="$2"
    local tools="$3"  # comma-separated tool names, or ""

    # Build content array
    local content_blocks
    content_blocks="[{\"type\":\"text\",\"text\":\"$(echo "$text" | sed 's/"/\\"/g')\"}"
    if [ -n "$tools" ]; then
        local idx=0
        IFS=',' read -ra TOOL_LIST <<< "$tools"
        for tool in "${TOOL_LIST[@]}"; do
            content_blocks+=",{\"type\":\"tool_use\",\"name\":\"$tool\",\"id\":\"t$idx\",\"input\":{}}"
            idx=$((idx + 1))
        done
    fi
    content_blocks+="]"

    printf '{"type":"assistant","uuid":"test","message":{"content":%s}}\n' "$content_blocks" > "$tmpfile"
}

run_process_guard() {
    local transcript_path="${1:-}"
    local stop_hook_active="${2:-false}"
    local cwd="$PROJECT_ROOT"
    local stdin_json
    if [ -z "$transcript_path" ]; then
        stdin_json="{\"session_id\":\"test\",\"cwd\":\"$cwd\",\"stop_hook_active\":$stop_hook_active}"
    else
        stdin_json="{\"session_id\":\"test\",\"transcript_path\":\"$transcript_path\",\"cwd\":\"$cwd\",\"stop_hook_active\":$stop_hook_active}"
    fi
    echo "$stdin_json" | node "$PROJECT_ROOT/.claude/hooks/process-guard.js" 2>/dev/null || true
}

TMPDIR_PG="$(_mktemp_d)"

# Test 6.1: '수정 없음' + no file reads → decision: block
make_transcript "$TMPDIR_PG/t.jsonl" "2차 리뷰: 수정 없음" ""
OUTPUT=$(run_process_guard "$TMPDIR_PG/t.jsonl")
if echo "$OUTPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if d.get('decision')=='block' else 1)" 2>/dev/null; then
    pass "6.1 '수정 없음' + no file reads → decision:block"
else
    fail "6.1 '수정 없음' + no reads" "decision:block" "$OUTPUT"
fi

# Test 6.2: '수정 없음' + Read → pass (no block)
make_transcript "$TMPDIR_PG/t.jsonl" "2차 리뷰: 수정 없음" "Read"
OUTPUT=$(run_process_guard "$TMPDIR_PG/t.jsonl")
DECISION=$(echo "$OUTPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('decision',''))" 2>/dev/null || echo "")
if [ "$DECISION" != "block" ]; then
    pass "6.2 '수정 없음' + Read tool → no block"
else
    fail "6.2 '수정 없음' + Read → no block" "no block" "decision=$DECISION"
fi

# Test 6.3: '변경 없음' + Grep → pass
make_transcript "$TMPDIR_PG/t.jsonl" "변경 없음" "Grep"
OUTPUT=$(run_process_guard "$TMPDIR_PG/t.jsonl")
DECISION=$(echo "$OUTPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('decision',''))" 2>/dev/null || echo "")
if [ "$DECISION" != "block" ]; then
    pass "6.3 '변경 없음' + Grep tool → no block"
else
    fail "6.3 '변경 없음' + Grep → no block" "no block" "decision=$DECISION"
fi

# Test 6.4: '이상 없음' + Glob → pass
make_transcript "$TMPDIR_PG/t.jsonl" "이상 없음" "Glob"
OUTPUT=$(run_process_guard "$TMPDIR_PG/t.jsonl")
DECISION=$(echo "$OUTPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('decision',''))" 2>/dev/null || echo "")
if [ "$DECISION" != "block" ]; then
    pass "6.4 '이상 없음' + Glob tool → no block"
else
    fail "6.4 '이상 없음' + Glob → no block" "no block" "decision=$DECISION"
fi

# Test 6.5: 일반 응답 (선언 없음) → pass (no output)
make_transcript "$TMPDIR_PG/t.jsonl" "파일을 분석하겠습니다." ""
OUTPUT=$(run_process_guard "$TMPDIR_PG/t.jsonl")
if [ -z "$OUTPUT" ]; then
    pass "6.5 일반 응답 (선언 없음) → pass (empty output)"
else
    fail "6.5 일반 응답 → pass" "(empty)" "$OUTPUT"
fi

# Test 6.6: stop_hook_active=true → pass (infinite loop guard)
make_transcript "$TMPDIR_PG/t.jsonl" "수정 없음" ""
OUTPUT=$(run_process_guard "$TMPDIR_PG/t.jsonl" "true")
if [ -z "$OUTPUT" ]; then
    pass "6.6 stop_hook_active=true → pass (infinite loop prevention)"
else
    fail "6.6 stop_hook_active=true → pass" "(empty)" "$OUTPUT"
fi

# Test 6.7: transcript_path 필드 없음 → graceful pass
OUTPUT=$(run_process_guard "")
if [ -z "$OUTPUT" ]; then
    pass "6.7 Missing transcript_path field → graceful pass"
else
    fail "6.7 Missing transcript_path" "(empty)" "$OUTPUT"
fi

# Test 6.8: 존재하지 않는 transcript → graceful pass
OUTPUT=$(run_process_guard "/nonexistent/path/session.jsonl")
if [ -z "$OUTPUT" ]; then
    pass "6.8 Non-existent transcript → graceful pass"
else
    fail "6.8 Non-existent transcript" "(empty)" "$OUTPUT"
fi

# Test 6.9: '클린 패스' keyword → block
make_transcript "$TMPDIR_PG/t.jsonl" "1차 클린 패스. 2차 클린 패스." ""
OUTPUT=$(run_process_guard "$TMPDIR_PG/t.jsonl")
if echo "$OUTPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if d.get('decision')=='block' else 1)" 2>/dev/null; then
    pass "6.9 '클린 패스' + no reads → block"
else
    fail "6.9 '클린 패스' → block" "decision:block" "$OUTPUT"
fi

# Test 6.10: 'clean pass' (English) → block
make_transcript "$TMPDIR_PG/t.jsonl" "Review complete. Clean pass." ""
OUTPUT=$(run_process_guard "$TMPDIR_PG/t.jsonl")
if echo "$OUTPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if d.get('decision')=='block' else 1)" 2>/dev/null; then
    pass "6.10 'clean pass' (English) → block"
else
    fail "6.10 'clean pass' → block" "decision:block" "$OUTPUT"
fi

# Test 6.11: 'no changes found' (English) → block
make_transcript "$TMPDIR_PG/t.jsonl" "I reviewed all files. No changes found." ""
OUTPUT=$(run_process_guard "$TMPDIR_PG/t.jsonl")
if echo "$OUTPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if d.get('decision')=='block' else 1)" 2>/dev/null; then
    pass "6.11 'no changes found' (English) → block"
else
    fail "6.11 'no changes found' → block" "decision:block" "$OUTPUT"
fi

# Test 6.12: 빈 transcript → graceful pass
echo "" > "$TMPDIR_PG/empty.jsonl"
OUTPUT=$(run_process_guard "$TMPDIR_PG/empty.jsonl")
if [ -z "$OUTPUT" ]; then
    pass "6.12 Empty transcript → graceful pass"
else
    fail "6.12 Empty transcript" "(empty)" "$OUTPUT"
fi

# Test 6.13: Malformed JSON stdin → graceful exit (no crash)
OUTPUT=$(echo "NOT JSON" | node "$PROJECT_ROOT/.claude/hooks/process-guard.js" 2>/dev/null || true)
if [ -z "$OUTPUT" ]; then
    pass "6.13 Malformed JSON stdin → graceful exit"
else
    fail "6.13 Malformed JSON → graceful exit" "(empty)" "$OUTPUT"
fi

# Test 6.14: block reason contains actionable Korean message
make_transcript "$TMPDIR_PG/t.jsonl" "수정 없음" ""
OUTPUT=$(run_process_guard "$TMPDIR_PG/t.jsonl")
if echo "$OUTPUT" | python3 -c "import sys,json; d=json.loads(sys.stdin.buffer.read().decode('utf-8')); exit(0 if '\ud30c\uc77c' in d.get('reason','') else 1)" 2>/dev/null; then
    pass "6.14 Block reason contains actionable message ('파일')"
else
    fail "6.14 Block reason message" "Korean reason with '파일'" "$OUTPUT"
fi

rm -rf "$TMPDIR_PG"

# ─── Summary ──────────────────────────────────────────────

echo ""
echo -e "${YELLOW}═══════════════════════════════════${NC}"
echo -e "Total: $TOTAL  ${GREEN}Pass: $PASS${NC}  ${RED}Fail: $FAIL${NC}"
echo -e "${YELLOW}═══════════════════════════════════${NC}"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
