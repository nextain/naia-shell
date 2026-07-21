# 네 세션 통합 검증 — 2026-07-21

## 범위

- Discord runtime·UI·정상 shutdown
- Codex provider와 main/sub/memory 역할 분리
- 연속발화·개인 라디오 DJ·전시 profile
- naia-memory gateway 인증과 durable idempotent handoff

전주 강의 자산은 `data-private`가 소유하며 별도 정본 커밋으로 추적한다.

## 현재 결합 기준

- Agent: `1e0acab83622fe446f301811d0fe35bb10285b86`
- Shell: 이 문서를 포함하는 `integration/discord-radio-codex`
- Agent proto SHA-256: `02bf7557c9b31c0e749497fdef9ab8c87fd1181f5967c9b6ed7469798fd9f26a`
- Memory: `1d6d93871192bf61f6b2be476d35e84e30fdba99`
- Workshop: `bb1d140f9334eba04c6bc73a2cf04cf8f0ce494d`

## 실행 증거

- Agent 전체: 108 files pass / 3 skip, 1,294 tests pass / 9 skip; build pass
- Agent Codex/Discord 집중: 4 files, 86 tests pass
- Memory 전체: 24 files, 393 tests pass; typecheck/build pass
- Shell core: 25 files, 229 tests pass
- Shell UI: 121 files pass / 2 skip, 1,332 tests pass / 13 skip
- Shell production build: pass
- Playwright: Discord 3 + proactive speech 7 = 10/10 pass
- Rust paired integration: 172/172 pass against the exact Agent pin
- Native Tauri WDIO: 3/3 pass against Shell `dc110b190304aa0741752800a8a4b1eeffc108f0` and Agent `1e0acab83622fe446f301811d0fe35bb10285b86` (`.agents/reviews/four-session-native-e2e-2026-07-21.json`)
- 실제 Codex app-server dynamic-tool smoke: `get_time` 1회 toolUse/toolResult, success, final text, completed, exit 0 (`naia-agent:docs/progress/99.dev-comm/codex-dynamic-tool-smoke-2026-07-21.md`)
- 전주 강의: preflight 23/23, publisher 5/5, 장 14개 오류 0, starter 정적 검사 13/13

## 정직한 미완료 경계

- 실제 Discord bot 2채널 송수신·RESUME·403·rotate/revoke와 OS credential prompt/store는
  운영 자격증명이 필요한 인수 항목이다.
- 전주 강의는 실제 Windows/Linux 120분 전체 리허설 전까지 WikiDocs 공개 준비 완료로 선언하지 않는다.
- Node 26 + webdriverio 9의 세션 `Content-Length` 호환 문제는 `transformRequest`와 회귀 계약으로 해결했고, 최종 Tauri WDIO는 Agent·BGM 실 프로세스로 3/3 통과했다.
- release 바이너리 빌드는 통과했지만 AppImage 패키징은 현재 Linux host의 `librsvg-2.0.pc` 부재로 번들러 단계에서 실패했다.
- 연속발화의 실시간 audible TTS·live barge-in은 TEST-F-011 운영 인수 항목으로 Partial을 유지한다.
- 아래 운영 종단간 보강까지 포함한 고정 snapshot을 최종 통합 적대리뷰 대상으로 사용한다.

## 운영 종단간 보강 — 실제 Codex via Naia Shell

- 테스트 소스: Shell `fb40e0c4`
- 실제 운영 로그인 상태의 Codex를 사용해
  `Tauri Shell → gRPC Agent → codex app-server → usage/finish → Shell 화면`을 실행했다.
- 테스트 시작 이후의 런타임 로그 구간에서 Agent reload
  `loaded=true codex/gpt-5.4`를 확인하고, 전송 직전부터 하나의 `requestId`가
  `chat_request provider=codex` → `usage` → `finish`를 관통하는지 자동 단언했다.
- Shell 화면 응답: `NAIA_SHELL_CODEX_E2E_OK_20260721`
- marker를 포함한 바로 그 assistant DOM의 usage 토큰 양수, 오류 마커 없음, 테스트 종료 후 파일과
  격리 localStorage의 정확한 원본 및 `gemini/gemini-2.5-flash` 활성 상태 복구를 확인했다.
- WebView 상태는 전용 XDG 디렉터리로 격리하고 종료 시 제거한다. Codex 설정 변경 직후
  worker를 강제 종료하는 복구 시험에서도 launcher의 durable backup이 원본을 복원했다.
- 종료 중 permission poller hot loop를 제거해 정상 teardown까지 포함했다.
- crash 복구 재실행: worker exit 86 유도, launcher exit 1(예상 실패), 설정 SHA-256
  `31458de1...c0274` 전후 동일, Gemini 복구, backup/XDG 잔여물 없음.
- 고정 커밋 재실행: 1/1 pass, 13.3초; spec 1/1 pass; 전체 20초; exit 0.
- V-model 정본 `TEST-S-017/UC-018`, `TEST-F-012/SPEC-012`에도 native E2E와 증거를 연결했다.
- 회귀: Shell UI 1,332 pass / 13 skip, core 229/229, production build pass.
- 상세 증거: `.agents/reviews/codex-shell-live-e2e-2026-07-21.json`
