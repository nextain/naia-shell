# 네 세션 통합 검증 — 2026-07-21

## 범위

- Discord runtime·UI·정상 shutdown
- Codex provider와 main/sub/memory 역할 분리
- 연속발화·개인 라디오 DJ·전시 profile
- naia-memory gateway 인증과 durable idempotent handoff

전주 강의 자산은 `data-private`가 소유하며 별도 정본 커밋으로 추적한다.

## 현재 결합 기준

- Agent: `ea6afa1d1f9227e754c68e4498364e5dc6405034`
- Shell: 이 문서를 포함하는 `integration/discord-radio-codex`
- Agent proto SHA-256: `02bf7557c9b31c0e749497fdef9ab8c87fd1181f5967c9b6ed7469798fd9f26a`
- Memory main: `a39b30c`

## 실행 증거

- Agent 전체: 108 files pass / 3 skip, 1,284 tests pass / 9 skip
- Agent 통합 집중: 17 files, 204 tests pass; 인증 배선 21/21 pass; build pass
- Memory 전체: 24 files, 390 tests pass; build pass
- Shell core: 24 files, 228 tests pass
- Shell UI: 121 files pass / 2 skip, 1,332 tests pass / 13 skip
- Shell production build: pass
- Playwright: Discord 3 + proactive speech 7 = 10/10 pass
- Rust paired integration: 172/172 pass against Agent `ea6afa1d1f9227e754c68e4498364e5dc6405034`
- 전주 강의: preflight 14/14, publisher 5/5, 장 14개 오류 0, starter 정적 검사 13/13

## 정직한 미완료 경계

- 실제 Discord bot 2채널 송수신·RESUME·403·rotate/revoke와 OS credential prompt/store는
  운영 자격증명이 필요한 인수 항목이다.
- 전주 강의는 실제 Windows/Linux 120분 전체 리허설 전까지 WikiDocs 공개 준비 완료로 선언하지 않는다.
- 최종 통합 소스에서 Tauri WebDriver 설정 E2E를 재시도했으나 세션 생성 단계에서
  `UND_ERR_INVALID_ARG`로 시작하지 못했다. 라디오 기능 단독 스냅샷의 실제 Tauri 설정 E2E는
  1/1 통과했으며, 최종 결합은 위 Rust 172개와 Playwright 10개로 검증했다.
- 최종 통합 적대리뷰 2회 연속 CLEAN은 이 snapshot에서 계속 검증한다.
