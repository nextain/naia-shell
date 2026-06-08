# LLM 역할 분담 표준 (작은 모델 ↔ 큰 모델)

> 프로젝트의 스크립트·동기화·검증 작업에 어떤 모델을 쓰고, 무엇을 시키고 안 시키는지의 표준.
> 동기: 작은 모델에 판단·수정을 맡기면 **맥락 소실**로 정합성이 깨진다 (큰 위험). 역할을 명확히 가른다.

## 역할 분담 (불변 원칙) — 3 레벨

> **naia-agent 의 원조 2계층(`naia-settings/llm.json` main/sub)을 하네스 표준으로 정규화.**
> "머리쓰기·설계·실질 검증 = 상위(플래그십) / 형식 검증 = 하위(라이트) / 구조는 코드(LLM 무)."

| 레벨 | 하는 일 | 모델 | naia-agent 역할 |
|------|---------|------|------------------|
| **0. 결정론 (LLM 무)** | 구조·스키마·기계검증 합격기준 (F12/F13, doc-graph, mirror 해시, `brightness==popcount`) | 없음 (스크립트) | — |
| **1. 라이트 (하위)** | **형식 검증** + 번역(.agents→.users 미러) + 생성(초안) + **문제점 지적**(검출·리포트) + 자동동기화 | haiku / gemini-flash-lite / glm-flash | `sub` (형식·보조) |
| **2-a. 플래그십 — main (상위)** | **머리쓰기·설계·판단·수정** (대화하는 주 모델) | Opus / GPT-5.x / GLM-5.x | `main` (대화 Agent) |
| **2-b. 플래그십 — 리뷰어 패널 (상위)** | **실질 적대 검증** (placeholder인가·미묘한 버그·설계 타당성) — main 과 *독립*(안티앵커링) | **claude · codex · glm-5.1** (다중 독립) | `sub` 의 reviewer 변형, but 플래그십 tier |

**핵심**:
- **형식 검증(레벨 0·1)과 실질 검증(레벨 2-b)을 가른다.** 기계로 판정 가능한 건 결정론/라이트로 싸게, 판단이 필요한 건 플래그십 적대 리뷰로. (→ `acceptance-criteria.md` 두 층.)
- **리뷰어 = 플래그십, 독립 다중.** 검증은 고위험이라 강한 모델. main 과 분리해 앵커링 차단(`review-pass` §9, `acceptance-criteria.md` §2.1). 구현 = **`review-pass` 스킬(adk 레벨)**.
- **라이트는 "지적"까지, 수정은 플래그십 + cross-check.** 작은 모델에 수정 위임 = 맥락 소실로 정합성 붕괴(큰 위험).
- **크로스리뷰 로스터(2026-05-30)**: claude · codex · **glm-5.1**(opencode `openrouter/z-ai/glm-5.1`). gemini-CLI 제외(응답 5분+ 불안정 — 검증층은 timeout+graceful degradation 필요, `review-pass` §6.3/§7). Vertex 등 유료 API 는 속도·신뢰 필요 시 옵션.

### Config SoT — `naia-settings/review.json`

리뷰어 패널 + tier 정책의 **정본 config** = `naia-adk/naia-settings/review.json` (cross-repo SoT, `llm.json`(main/sub/embedded)의 형제). `tier_policy` + `reviewers[]`(플래그십 패널) + `stages`. `review-pass` 스킬과 naia-agent 가 소비. naia-settings 가 naia-agent·naia-os 설정 파일을 담는 구조 정합 — 프로젝트는 project-local `review-pass.yaml` 대신 이 정본을 가리킨다(또는 override). secret 은 `apiKeyRef`(이름)만.

## 실행 환경 가정 (단계별)

| 단계 | 가정 | sub(작은 모델) 호출 |
|------|------|---------------------|
| **지금 — 프로젝트 레벨** | **단일 CLI** (claude / codex / gemini 중 하나) | 그 CLI 의 headless + 라이트 모델 |
| **나중 — naia-agent** | **다중 CLI + 다중 API key** | naia-agent 가 main/sub 라우팅 (이 어댑터를 라우터로 교체) |

### 단일 CLI 호출 방식 (검증됨 2026-05-30)

| CLI | headless | 라이트 모델 지정 | 동기화 스크립트 env |
|-----|----------|------------------|---------------------|
| **claude** | `claude -p` (prompt via stdin) | `--model haiku` | `MIRROR_LLM_CLI=claude MIRROR_SUB_MODEL=haiku` |
| **gemini** | `gemini -p "<prompt>"` | `-m gemini-3.1-flash-lite` (작은 모델 — flash 아닌 flash-lite) | `MIRROR_LLM_CLI=gemini` |
| **codex** | `codex exec "<prompt>"` | `-c model=<계정 가능 모델>` | `MIRROR_LLM_CLI=codex` (ChatGPT 계정 모델 제약 주의) |

> 기본값: claude 코드 환경이면 `claude -p --model haiku`. `scripts/mirror-translate.mjs` 가 위 env 로 분기.

## 디텍트 계층 (명백한 오류는 LLM 없이 즉시 잡힘)

오류 규모에 따라 **싼 것부터** 잡는다. 큰/명백한 오류는 결정론 스크립트가 즉시 디텍트하므로 모델이 불필요.

| 계층 | 무엇을 잡나 | 수단 | 비용 |
|------|------------|------|------|
| **1. 결정론 검사** (LLM 무) | **구조 틀림**(F12/F13 위반·미등록 dir), 미러 stale(해시 불일치), doc 고립, CI 증거/SDLC 위반 | `enforce-root-structure.sh`, `mirror-translate --check`, `check-doc-graph.mjs`, `ci-verify-*.mjs`, `src/test/*.test.mjs` | 0 (즉시) |
| **2. 작은 모델** | 1계층이 못 잡는 미묘한 것 — 용어 위반, 어색한 번역, 의미 불일치 **지적** | check-terminology + 작은 모델 | 낮음 |
| **3. 큰 모델 + cross-check** | 1·2 가 지적한 것 **수정·판단** | 메인 모델 (적대 검토 동반) | 높음 (필요할 때만) |

> 원리: **어느 정도 큰 오류는 1계층(결정론)에서 디텍트**된다 — 구조가 틀리면 즉시 안다.
> 모델(특히 큰 모델)은 결정론으로 못 잡는 미묘한 영역에만 투입. 싼 검사를 먼저, 비싼 판단을 마지막에.

## 작업별 모델 배정

| 작업 | 모델 | 도구 |
|------|------|------|
| `.agents`→`.users` 미러 번역 | 작은 모델 | `scripts/mirror-translate.mjs` |
| doc 고립 검출 (지적) | 스크립트(LLM 무) / 필요시 작은 모델 | `scripts/check-doc-graph.mjs` |
| 용어 위반 지적 | 작은 모델 | `scripts/check-terminology.mjs` |
| 구조/CI 검증 (지적) | 스크립트(LLM 무) | `ci-verify-*.mjs`, `enforce-root-structure.sh` |
| 지적된 문제 **수정** | **큰 모델 + cross-check** | (사람/메인 모델) |

## 검증
- `src/test/llm-roles.test.mjs` — mirror-translate 어댑터가 env 로 CLI/모델 분기하는지, 하드코딩(특정 모델 직타) 없는지.
