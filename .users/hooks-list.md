# Hooks 목록

> **SoT**: `.agents/hooks/`. 이 파일은 **사람용 단일 색인**이다.
> ⚠️ per-item 복사(`.users/hooks/...`)는 하지 않는다 — 이 색인 한 장만 둔다.
> 갱신: `node scripts/gen-lists.mjs hooks` (결정론 생성).

| 이름 | 파일 | 설명 |
|------|------|------|
| charter-guard | `.agents/hooks/charter-guard.js` | Charter Guard (PreToolUse on Edit\|Write) — 헌장·hook·설정 파일의 AI 단독 수정 차단. |
| completion-evidence-guard | `.agents/hooks/completion-evidence-guard.js` | M4 — Completion Evidence Guard (PreToolUse on Bash). 판정은 공통 코어(checkCompletion)에 위임. |
| quarantine-notice | `.agents/hooks/quarantine-notice.js` | Quarantine Notice (SessionStart) — 보류 격리 자산 중 **만료·아카이브되어 사용자 처분을 기다리는** |
| sdlc-gate-guard | `.agents/hooks/sdlc-gate-guard.js` | M2 — SDLC Gate Guard (PreToolUse on Edit\|Write). 판정은 공통 코어(checkSdlc)에 위임. |
| structure-guard | `.agents/hooks/structure-guard.js` | M3 — Structure Guard (PreToolUse on Write\|Edit). 판정은 공통 코어(checkStructure)에 위임. |
