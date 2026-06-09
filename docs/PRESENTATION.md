# 발표 자료 — naia-os 헥사고날 이식 & 개발 방법론

`[발표용 · 진행하며 갱신 · 슬라이드 골자(## = 슬라이드, 1슬라이드 1메시지)]`
> 상세 근거 = `00-PHASES.md`(순서)·`STRUCTURE.md`(사상)·`user-scenarios.md`·`requirements.md` / 진행 SoT = alpha-adk `.agents/progress/new-naia-transplant-workspace-2026-06-08.md`.
> 대상(가정): 개발 방법론 / OSS 기여자. 길이·대상 바뀌면 조정. **상태: 초안, 매 페이즈 갱신.**

---

## 1. 문제 — AI 코딩의 "가짜 성공"

- 같은 AI가 생성·테스트·채점을 다 하면(닫힌 루프) 자기 오해를 자기가 통과시킨다 → 표면 green, 명세와 어긋남.
- 솔로 개발 = 작동 보장 없음, 누적 entropy(silent overwrite·drift).
- **핵심 질문**: "흔들리지 않는(unbreakable) 프로젝트"를 AI 시대에 어떻게 짓나?

## 2. 비전 — naia = 뇌(brain), 데스크톱 → 피지컬 AI

- **agent = 뇌**(모든 인지) / **shell = 육체**(감각기+효과기, 인지 0) / **환경 = 사는 세계**.
- **naia = OS** — agent=커널, gRPC=다중 클라이언트 시스템 인터페이스.
- 각 모듈을 *인간 인지 흐름*에 정렬 → 지금은 데스크톱 AI지만 같은 뇌가 **피지컬 로봇**으로(substrate-agnostic).

## 3. 접근 — 변형이 아니라 "이식"

- 깨진 코드를 in-place 수정 ❌ → **clean 베이스에 이식**(deny-by-default, 통과한 것만).
- **fault isolation**: 다 작동시키는 게 목표가 아님. 구조적 이식으로 고장을 *그 slice에 가둔다*(안 번지게).
- 근거: template 존재목적 · 과거 false-success 교훈 · Caret-Cline 선례.

## 4. 방법론 — 단단함을 만드는 장치

- **cross-review (codex + gemini, 독립 계보)** — 단일 AI 자기축복 차단.
- **완전성 = 추측 아닌 코드 대조** — "2~3연속 무발견까지" 고수.
- **검증 3단** — Old-Baseline golden trace → 계약(port) → 통합(인지흐름 reafference). GREEN이어도 baseline 다르면 FAIL.
- **결정론 게이트** — conform-scan(0토큰)·drift-gate·verify-watch.

## 5. 진행 순서 (00 → 06)

```
00 작업장(5 서브레포+거버넌스) → 01 구조 v5 → 02 용어 → 03 시나리오 P01 → 04 테스트맵 P02 → 05 요구사항 P03 → 06 실행 F0~
```
- 계획(00~05) 먼저, 실행(06) 나중. foundation-first(F0 설정→F1 자기상태→F2 관측→F3 조작).

## 6. 성과 (수치로)

- 구조 v5: **적대 리뷰 ~20라운드** 수렴(codex·gemini).
- 시나리오: **완전성 13라운드, 3연속 무발견** → 초안 46 → **S01~S71**. 코드 대조로 **60+ OpenClaw 스킬** 등 누락 19개 발굴.
- 테스트맵/요구사항: 각 13R/8R, gemini 다수 연속 PASS.
- → "눈으로 통과 못 시킬 양"을 AI 코드대조로 닫음.

## 7. 현재 위치 — 정직하게

- **계획 완료 + F0 실행 착수.** F0 Old-Baseline = **코드레벨 CLOSED**(codex 코드 직독 14R, 2연속 NONE).
- F0 부팅 커맨드 인벤토리 확정 — secret-strip 변환·config 조건부 전송·팬텀 커맨드 제외까지 코드 근거로 정밀화(눈으로 못 잡는 것을 코드대조가 잡음).
- **아직 코드 이식 0**(baseline=계약 문서). 라이브 trace(timing·실 I/O)=루크 머신 구동 시. 다음 두께 = 첫 슬라이스 스캐폴드.

## 8. 다음 / 기여 포인트

- **F0 슬라이스 스캐폴드**: baseline(계약) → new-naia-os `src/main` 헥사고날 골격(domain/ports/adapters/app) → 계약 테스트. 라이브 trace 게이트 후 행동 등가 선언.
- 그 다음 F1(자기상태/진단) → F2(관측) → F3(조작).
- 기여 가능 영역: (실행 시 채움 — vertical별 slice 이식, per-skill 검증 등).

---
> 갱신 로그: 06 실행 착수 시 §6·§7·§8 갱신.
