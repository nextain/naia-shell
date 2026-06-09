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
| **06** | 실행 F0~ (다음) | Old-Baseline 측정(로컬·외부키X) → 슬라이스 이식(F0→F1→F2→F3) → P04 통합테스트 → P05 완료 | (실행 시) | (코드·트레이스) | ⏳ 착수 전 |

## 왜 이 순서

1. **계획 먼저, 실행 나중** — 깨진 토대 위 누적 방지. 단 06 전까진 **코드 0 이식**(아직 계획 단계).
2. **foundation-first** — F0(설정)→F1(자기상태/진단)→F2(관측)→F3(조작) 로컬·견고부터, 외부키 의존(음성·채널)은 후순위.
3. **완전성은 추측 아닌 코드 대조** — "2~3연속 NONE까지" 고수가 60+ 스킬 누락을 잡음.
4. **검증≠작동만** — Old-Baseline golden trace 대비 행동 등가까지(가짜성공 차단).

## 결정 완료 / 다음
- foundation tranche 순서 = **채택**, botmadang(S65) = **rejected** (루크 2026-06-09).
- **다음 = 06 실행 착수**(F0 Old-Baseline 측정, old-naia-os 구동 = 루크 머신 필요).
