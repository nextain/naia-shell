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

- Agent 전체: 108 files pass / 3 skip, 1,282 tests pass / 9 skip
- Agent 통합 집중: 17 files, 204 tests pass; 인증 배선 21/21 pass; build pass
- Memory 전체: 24 files, 390 tests pass; build pass
- Shell 전체: 120 files pass / 2 skip, 1,327 tests pass / 13 skip
- Shell production build: pass
- Playwright: Discord 3 + proactive speech 7 = 10/10 pass
- 전주 강의: preflight 14/14, publisher 5/5, 장 14개 오류 0, starter 정적 검사 13/13

## 정직한 미완료 경계

- 실제 Discord bot 2채널 송수신·RESUME·403·rotate/revoke와 OS credential prompt/store는
  운영 자격증명이 필요한 인수 항목이다.
- 전주 강의는 실제 Windows/Linux 120분 전체 리허설 전까지 WikiDocs 공개 준비 완료로 선언하지 않는다.
- Rust paired 전체 테스트와 최종 통합 적대리뷰 2회 연속 CLEAN은 이 snapshot에서 계속 검증한다.
