# progress — V모델 추적 산출물 + 작업 기록

이 디렉터리는 두 역할을 한다:

## 1. V모델 추적 registry (`01`~`05`)

각 단계는 **INDEX.md 한 파일 registry**(항목당 별도 문서 ❌ — 문서 폭발 방지).

| 단계 | 디렉터리 | 산출물 | ID |
|------|----------|--------|-----|
| 01 | `01.requirements/INDEX.md` | 요구사항 | REQ-### |
| 02 | `02.user-scenarios/INDEX.md` | 사용자 시나리오 | UC-### |
| 03 | `03.uc-tests/INDEX.md` | 시나리오 테스트 | TEST-S-### |
| 04 | `04.features/INDEX.md` | 기능 설계 | SPEC-### |
| 05 | `05.features-tests/INDEX.md` | 기능 테스트 | TEST-F-### |

추적 사슬: **REQ → UC → TEST-S**, **UC → SPEC → TEST-F** (orphan 0).
검사기 = `scripts/check-traceability.mjs` (기본 advisory, `--enforce`로 차단).
SDLC 게이트(P01/P03)가 이 INDEX 파일들을 deliverable로 본다 — 빈 seed 상태면 bootstrap(경고·허용), 실제 항목을 채우면 enforce.
마크다운은 SPEC(기능 의도)까지만 — 그 아래 unit/함수는 코드(`src/main`), 유닛테스트는 `src/test`.

## 2. 개발자 의사소통·작업 기록 (`99.dev-comm`)

날짜별 진행·검토·설계·이슈 메모(`<주제>-YYYY-MM-DD.md`, `issue-{N}-{slug}.md`). **append-only 연대기**라
상호 링크 의무가 없고, 문서 고립 검사에서 면제된다(`check-doc-graph docs README.md --exempt progress`).
