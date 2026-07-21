# 네 세션 통합 검증 — 2026-07-21

## 범위

- Discord runtime·UI·정상 shutdown
- Codex provider와 main/sub/memory 역할 분리
- 연속발화·개인 라디오 DJ·전시 profile
- naia-memory gateway 인증과 durable idempotent handoff

전주 강의 자산은 `data-private`가 소유하며 별도 정본 커밋으로 추적한다.

## 현재 결합 기준

- Agent: `4838c906d221558f8d3424870158b01022de9972`
- Shell: 이 문서를 포함하는 `integration/discord-radio-codex`
- Agent proto SHA-256: `02bf7557c9b31c0e749497fdef9ab8c87fd1181f5967c9b6ed7469798fd9f26a`
- Memory: `1d6d93871192bf61f6b2be476d35e84e30fdba99`
- Workshop: `bb1d140f9334eba04c6bc73a2cf04cf8f0ce494d`

## 실행 증거

- Agent 전체: 108 files pass / 3 skip, 1,294 tests pass / 9 skip; build pass
- Agent Codex/Discord 집중: 4 files, 85 tests pass
- Memory 전체: 24 files, 393 tests pass; typecheck/build pass
- Shell core: 25 files, 229 tests pass
- Shell UI: 121 files pass / 2 skip, 1,332 tests pass / 13 skip
- Shell production build: pass
- Playwright: Discord 3 + proactive speech 7 = 10/10 pass
- Rust paired integration: 172/172 pass against the exact Agent pin
- Native Tauri WDIO: 3/3 pass against Shell `2c1f1a15c69e389ab7dba8e033d9ff98f5a438f1` and the exact Agent pin (`.agents/reviews/four-session-native-e2e-2026-07-21.json`)
- 실제 Codex app-server dynamic-tool smoke: `get_time` 1회 toolUse/toolResult, success, final text, completed, exit 0 (`naia-agent:docs/progress/99.dev-comm/codex-dynamic-tool-smoke-2026-07-21.md`)
- 전주 강의: preflight 23/23, publisher 5/5, 장 14개 오류 0, starter 정적 검사 13/13

## 정직한 미완료 경계

- 실제 Discord bot 2채널 송수신·RESUME·403·rotate/revoke와 OS credential prompt/store는
  운영 자격증명이 필요한 인수 항목이다.
- 전주 강의는 실제 Windows/Linux 120분 전체 리허설 전까지 WikiDocs 공개 준비 완료로 선언하지 않는다.
- Node 26 + webdriverio 9의 세션 `Content-Length` 호환 문제는 `transformRequest`와 회귀 계약으로 해결했고, 최종 Tauri WDIO는 Agent·BGM 실 프로세스로 3/3 통과했다.
- release 바이너리 빌드는 통과했지만 AppImage 패키징은 현재 Linux host의 `librsvg-2.0.pc` 부재로 번들러 단계에서 실패했다.
- 연속발화의 실시간 audible TTS·live barge-in은 TEST-F-011 운영 인수 항목으로 Partial을 유지한다.
- 최종 통합 적대리뷰 2회 연속 CLEAN은 이 snapshot에서 계속 검증한다.
