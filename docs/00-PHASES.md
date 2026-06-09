# 00 — 페이즈 인덱스 (진행 순서 SoT, 발표용)

> naia-os 헥사고날 이식을 **이 순서로 이렇게 구성**했다. 각 페이즈 = 무엇을·어떻게·검증·산출물.
> 상세 진행/날짜/커밋 = alpha-adk `.agents/progress/new-naia-transplant-workspace-2026-06-08.md`.

## 큰 줄기

**계획(P0~P3) → 실행(F0~) → 검증(P4~P5).** 핵심 원칙: 변형❌ 이식✅(deny-by-default) · brain/body/OS · 인지흐름 정렬 · fault isolation(솔로개발=작동보장X → 구조적 격리) · 검증은 cross-review(codex+gemini)로 단단히.

| # | 페이즈 | 무엇을 / 어떻게 | 검증(리뷰) | 산출물 | 상태 |
|---|---|---|---|---|---|
| **00** | 작업장 구축 | `projects/new-naia/` 5 서브레포(old×2 frozen·template·new×2) + verify-watch·mirror-sync(gemini-3.1-flash-lite) hook | — | 작업장·거버넌스 | ✅ |
| **01** | 구조 v5 | 변형→이식 전환 · brain(agent)/body(shell)/OS · 포트 canon · 12 슬라이스 · 인지흐름 재그룹핑 | v4 R1-4 + v5 R1-7 (codex·gemini PASS) | [STRUCTURE.md](./STRUCTURE.md) | ✅ |
| **02** | 용어사전 | 뇌/육체/환경·faculty·포트·이식 용어 통일 | (01과 동반) | [glossary.md](./glossary.md) | ✅ |
| **03** | 시나리오 P01 | 개발 기능 전수 enumerate(검증여부 무관) → S01~S71 + 그룹. **코드 대조로 60+ OpenClaw 스킬 등 누락 19개 발견** | 완전성 13R, **3연속 NONE** | [user-scenarios.md](./user-scenarios.md) | ✅ |
| **04** | 테스트맵 P02 | 검증 3단(Old-Baseline golden trace→계약→통합 reafference) · fault disposition · 오류 2직교축 | 13R, gemini 7×PASS·codex 바운드 | [user-scenarios.md](./user-scenarios.md) (P02 섹션) | ✅ |
| **05** | 요구사항 P03 | foundation tranche FR(F0~F3) + 횡단 NFR + 승인-행위 결속·provenance 인과체인 | 8R, gemini 6×PASS·codex 바운드 | [requirements.md](./requirements.md) | ✅ |
| **06** | 실행 F0~ | Old-Baseline 측정(로컬·외부키X) → 슬라이스 이식(F0→F1→F2→F3) → P04 통합테스트 → P05 완료 | F0 baseline codex 14R·R13/R14 2연속 NONE | F0 baseline·contract·**code(src/main)** + F1·F2·F3 계약 | ⏳ 진행(F0 코드 ✅ tsc+16/16 test, F1-F3 계약 2클린+GLM) |

## 왜 이 순서

1. **계획 먼저, 실행 나중** — 깨진 토대 위 누적 방지. 단 06 전까진 **코드 0 이식**(아직 계획 단계).
2. **foundation-first** — F0(설정)→F1(자기상태/진단)→F2(관측)→F3(조작) 로컬·견고부터, 외부키 의존(음성·채널)은 후순위.
3. **완전성은 추측 아닌 코드 대조** — "2~3연속 NONE까지" 고수가 60+ 스킬 누락을 잡음.
4. **검증≠작동만** — Old-Baseline golden trace 대비 행동 등가까지(가짜성공 차단).

## 결정/잠정 / 다음
- foundation tranche 순서(F0→…) = **아이디어 수준 잠정**(우선 적어둔 것, 실행 시 재검토 — 못 박지 않음). G1 = 게이트 아님.
- botmadang(S65) = **rejected**(이식 제외, 명확 결정).
- **F0 Old-Baseline = 코드레벨 CLOSED**(2026-06-09, codex 14R 2연속 NONE). 부팅 커맨드 인벤토리 확정. 라이브 trace(timing·실 I/O)=루크 머신 구동 시.
- **F0 포트 계약 = CLOSED**(2026-06-09, codex 14R 2연속 NONE). baseline→헥사고날 레이어 매핑 동결.
- **루크 결정(2026-06-09)**: 툴체인/스캐폴드보다 **F1~F3 포트 계약 먼저**(설계 두텁게, 런타임 커밋 보류).
- **F1·F2·F3 = gemini 2연속 클린 ✅** (codex 한도 → gemini 대체 리뷰어, 코드표면 ground-truth 인라인). F1(자기상태/진단+승인 결속) gemini R3·R4 / F2(관측+drift) R3·R4 / F3(승인먼저 mutate+reafference+불확정) R4·R5.
- ⚠️ **codex 풀 재독 최종 게이트 = 리셋(~22:47) 후 대기**. gemini=경량(ground-truth 인라인)이라 codex 코드 직독 재검증은 유지.
- **툴체인 결정 = TS**(루크 'b 진행'; F13이 package.json/tsconfig 이미 허용 = 헌장수정 불요).
- **F0 코드 스캐폴드 완료**: `src/main/{domain,ports,adapters,app,composition}` 헥사고날 — tsc clean + **계약 테스트 16/16 통과**(vitest). 어댑터=Tauri stub(라이브 trace 대기). **첫 이식 코드 = 측정→계약→코드 관통.**
- **F0·F1·F2 코드 스캐폴드 완료**(tsc clean + 계약테스트 **50/50**). **codex 코드리뷰 6 HIGH+4 MED 정정**(classify 신뢰X·binding 게이트author·auto-bypass 인자조건·digest 충돌방지·load base·clone/delete·mount/activate 분리·always grant·status contain). F2=resolveExpected 권위우선·DriftDetector.
- **다음**: F3 코드 스캐폴드(같은 패턴) · F2/F3 codex 코드리뷰 · 라이브 trace(루크 머신).
