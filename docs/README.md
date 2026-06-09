# 문서 색인 (docs)

이 디렉터리의 진입점(허브). 모든 큐레이트 문서는 여기서 도달 가능해야 한다
(문서 고립 방지 — `scripts/check-doc-graph.mjs` 가 강제). 루트 `AGENTS.md`(=CLAUDE/GEMINI/OPENCODE/CODEX)
가 프로젝트 진입점이고, 이 파일은 `docs/` 내부 색인이다.

## 표준·구조

- [00 — 페이즈 인덱스 (진행 순서 SoT, 발표용)](./00-PHASES.md) — 이 순서로 이렇게 구성했다(00 작업장→05 요구사항→06 실행)

- [이식 구조 (1단계 뼈대) v5](./STRUCTURE.md) — 뇌/육체/OS·인지흐름 재그룹핑·포트 canon·이식 메커니즘 (naia-os 이식 SoT)
- [사용자 시나리오 (2단계 P01)](./user-scenarios.md) — UC 카탈로그·인지흐름 관통·vertical 후보 (G1 대기)
- [워드사전 (2단계)](./glossary.md) — 도메인 용어 통일 (뇌/육체/환경·faculty·포트·이식)
- [요구사항 (2단계 P03)](./requirements.md) — foundation tranche FR/NFR (P04 통합테스트 대상)
- [프로젝트 구조 표준](./project-structure.md) — F12/F13 루트 화이트리스트, 디렉터리 규약
- [위협 모델](./threat-model.md) — 보안 경계, 시크릿 격리(T3), 추적 금지 경로
- [LLM 역할 분담](./llm-roles.md) — 작은(라이트) 모델 ↔ 큰 모델 분담, 단일 CLI 어댑터, 검출 계층
- [합격 기준](./acceptance-criteria.md) — 계약 구체화 + 검증이 게이트를 대체(게이트키퍼 제거). 완료증거 등급(강/약/없음)

## 작업 기록 (progress/)

`docs/progress/` 는 **append-only 작업 기록(ledger)** — 날짜별 진행·검토 메모.
연대기라 상호 링크 의무가 없다(`check-doc-graph --exempt progress` 로 고립 검사 면제).

## 주기 검증

구조·문서·미러 이탈은 결정론 스크립트가 검출한다. 마이그레이션 완료 후
`scripts/verify-watch.sh start`(또는 `cron`)로 백그라운드 주기 검증 — 검출·보고만 자동, 수정은 사람/큰 모델 게이트.
자세히: [LLM 역할 분담](./llm-roles.md) 의 "디텍트 계층".
