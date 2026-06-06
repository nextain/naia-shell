# @naia/core — 헥사고날 코어

naia-os를 "흔들림 없이" 재구성하기 위한 코어. AI slop을 **구조로** 차단한다.

## 레이어 & 의존성 방향 (한 방향만)

```
adapters  →  ports  →  domain
(바깥/구현)   (계약)     (안/순수)
```

- `src/domain/` — 순수 값객체·규칙. **아무것도 import 하지 않는다.**
- `src/ports/` — 인터페이스(계약). `domain`만 참조.
- `src/adapters/` — 포트 구현(외부 연결). `ports`+`domain`만 참조.

**코어는 어댑터를 모른다.** TTS/LLM 제공자(나중엔 naia-agent)는 어댑터로 갈아끼운다 — 코어·포트·계약 테스트는 그대로.

## 추적 체인 (2층 계약 SoT)

이슈 → **문서**(`glossary.md` = 용어·의도 SoT) → **코드**(포트 `interface` = 시그니처 SoT) → **테스트**(계약 테스트)

## 게이트 (흔들림 방지 — slop을 RED로)

| 명령 | 막는 것 |
|------|---------|
| `pnpm arch` | 의존성 방향 위반(slop ②) + 고아 파일(slop ③). adapter→port→domain 외 방향이면 **에러** |
| `pnpm test` | 포트 계약 위반. 어떤 어댑터든 계약 테스트를 통과해야 함 |
| `pnpm typecheck` | 시그니처(코드=계약) 불일치 |

## 첫 slice: TTS (driven port)

- 도메인: `src/domain/tts/speech.ts` (SynthesisRequest, SynthesizedSpeech)
- 포트: `src/ports/tts/tts-port.ts` (TtsPort = 계약 SoT)
- 어댑터: `src/adapters/tts/mock-tts-adapter.ts` (목업 — 결정적, 무네트워크)
- 계약: `src/ports/tts/__tests__/tts-port.contract.test.ts` (모든 어댑터 공통 계약)

다음 어댑터(edge/openai)는 기존 `agent/src/tts/`에서 **테스트-퍼스트로 선별 이식** — 계약 테스트 러너에 한 줄 추가하면 같은 계약이 자동으로 지킨다.
