# scripts/ — 스크립트 레지스트리 (표준)

> **표준 규칙**: 모든 스크립트는 아래 카테고리 중 하나에 등록한다. 신규 스크립트 추가 시 이 표에 1줄 등록 필수(미등록 = 리뷰 차단). 물리 하위폴더는 *참조 안전이 보장된 것만* 사용(현재 `builds/`, `conform/`, `cron/`). 나머지는 참조(CLAUDE.md·hooks·tests) 파급 때문에 루트 평면 유지 + 본 레지스트리로 분류.
> 카테고리 = 목적별 논리 분류. SoT 연결: `docs/project-structure.md`(구조) · `.agents/context/process-status.json`(refs.scripts_registry).

## A. 구조·게이트 검증 (structure / SDLC gates)
| 스크립트 | 용도 |
|---|---|
| `enforce-root-structure.sh` | F12/F13 루트 구조 화이트리스트 강제(미등록 삭제). `--fix`. |
| `ci-verify-structure.mjs` | 루트 구조(F12/F13) CI 검증. |
| `ci-verify-charter.mjs` | 헌장 불변(charter immutability) CI 검증. |
| `ci-verify-sdlc.mjs` | SDLC P01~P05 게이트 상태 CI 검증. |
| `ci-verify-completion.mjs` | 완료 근거(completion evidence) 게이트 검증. |
| `check-assembly-coverage.mjs` | 조립 매트릭스 전수 검사(미분류 0: user-scenarios의 모든 UC/S가 매트릭스에 분류됐나 + fit 게이트: 상태≥코드 행에 미평가 없나). AI 단축 사고 방지 결정론 강제. |
| `check-file-anchors.mjs` | 파일단위 계약 앵커 검출기 — `src/main/*` 가 `module-manifest.json` 에 {layer,uc,contract} 등록됐나(드리프트 자동차단 1단계). |
| `check-compile-integrity.mjs` | 컴파일 무결성 게이트 — core+shell tsc 무결 검증. |
| `check-build-contract.mjs` | 빌드/dev 툴링 드리프트 검출기(`build-tooling-manifest.json` 대조). |
| `check-traceability.mjs` | V모델 추적성 검사기 (REQ→UC→TEST-S, UC→SPEC→TEST-F). |
| `oss-readiness.mjs` | OSS 공개 품질 게이트(결정론) — 시크릿/개인경로/PII/내부유출 하드게이트 0 + 온보딩 체크리스트. 추적 파일만 스캔. |
| `setup-git-hooks.sh` | 커밋 무결성 게이트 활성화(clone 당 1회 — `core.hooksPath` 로컬설정이라 미커밋). |
| `verify-watch.sh` | 주기 검증 러너 — 구조·문서·미러 이탈 백그라운드 검출(`once` 1회). |

## B. 문서·용어·링크 (docs integrity)
| 스크립트 | 용도 |
|---|---|
| `check-doc-graph.mjs` | 문서 그래프 무결성(orphan 문서 0) 검사. |
| `doc-link.mjs` | 문서 간 링크 무결성 검사. |
| `check-terminology.mjs` | 용어 정책(신조어 금지·평이한 한국어) 검사. |
| `gen-lists.mjs` | 컨텍스트 인덱스/목록 생성. |

## C. 컨텍스트·미러 (context / mirror sync)
| 스크립트 | 용도 |
|---|---|
| `mirror-translate.mjs` | `.agents/`(SoT) ↔ `.users/`(휴먼 미러) 번역 동기화. |
| `sync-harness-mirrors.sh` | `AGENTS.md`(canonical) → `CLAUDE/GEMINI/OPENCODE/CODEX.md` 미러 동기화. |
| `ctx-bucket.mjs` (+ `ctx-bucket-contract.schema.json`) | 작업단위(컨텍스트 버킷) 예산·경계 계약. |

## D. 이식·반증 (transplant / anti-false-success)
| 스크립트 | 용도 |
|---|---|
| `cleanse-scan.mjs` | 이식 cleanse-scan(deny-by-default, 미분류 자산 차단). |
| `mutation-probe.mjs` | 변이 테스트(가짜성공을 RED로 잡는 반증 프로브). |
| `conform/` | 계약↔코드 드리프트 결정론 게이트(0토큰). `conform/README.md` 참조. |

## E. 거버넌스 (governance)
| 스크립트 | 용도 |
|---|---|
| `quarantine.mjs` | 보류 격리(처분 6번째) 관리 — 방치 의심 자산 백업(`quarantine_policy`). |

## F. 빌드·실행 (builds/)
| 스크립트 | 용도 |
|---|---|
| `builds/f0-graft-smoke.sh` | F0 부팅 결정 등가 스모크(P02 1단계 Old-Baseline drift-gate). 빌드+테스트+DevTools 스니펫 emit. |
| `builds/f0-graft-snippet.js` | (생성물, gitignore) 위 스크립트가 만드는 붙여넣기용 콘솔 스니펫. |
| `builds/f0-boot-probe.mjs` | **headless 실디스크 부팅 검증** — Tauri 없이 `~/.naia/adk-path`+ADK config 읽어 컴파일된 새 core 의 부팅 결정 구동·비교(match). `node scripts/builds/f0-boot-probe.mjs`. |
| `builds/launch-naia-os.sh` | 실제 naia-os(projects/naia-os) dev 앱 실행(기존 dev 정리 후). 띄운 뒤 F12 Console 에 graft 스니펫 → match 확인. `[--bg]`. |
| `builds/uc1-graft-observe.sh` | UC1 수평 관측 스모크(Option A). 빌드+테스트+관측 스니펫 emit. 앱 무수정 — 새 core wire variant 분류가 라이브와 등가인지 1차 확인. |
| `builds/uc1-graft-observe.mjs` | 위 스니펫 생성기 — `dist/main/domain/chat.js` 의 variant 세트 파생(드리프트 0). |
| `builds/uc1-variant-probe.mjs` | **헤드리스 등가 게이트**(앱 불요) — frozen shell `AgentResponseChunk`(소비자 권위)을 추출해 새 core 분류가 전부 커버하는지 결정론 비교. drift 시 exit 1. f0-boot-probe 의 UC1 판. |
| `builds/uc1-outbound-probe.mjs` | **송신 헤드리스 등가 게이트** — 새 core toAgentOutbound type 을 frozen agent `parseRequest` 수용 집합과 결정론 비교. drift 시 exit 1. (수신=variant-probe 와 대칭) |
| `builds/uc1-trace-harness.mjs` | **Option C 헤드리스 trace** — 새 core(dist)를 *실 child_process stdio* 로 구동, fake agent(에코)로 1턴 end-to-end(송신→스트리밍→렌더→해제). 실 frozen agent=`AGENT_CMD` 로 spawn 교체. 라이브 admin 무접촉. PASS 시 exit 0. |
| `builds/uc1-graft-snippet.js` | (생성물, gitignore) DevTools 붙여넣기용 `window.uc1` 관측 헬퍼(classify/observeConsole/report). |

> **하위폴더 정책**: `cron/`(주기 배치)·`builds/`(빌드·graft)·`conform/`(전용 게이트)는 물리 폴더 허용(자기완결, 참조 안전). A~E 의 루트 평면 스크립트를 폴더로 옮기려면 — CLAUDE.md·`.agents/hooks/`·`src/test/*.mjs` 참조를 전부 갱신한 뒤에만(별도 작업).
