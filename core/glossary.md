# Naia Core — Glossary (단어사전)

> **용어 SoT.** 코드(인터페이스·타입)는 이 용어를 그대로 쓴다. 새 용어는 **여기 먼저** 등록한 뒤 코드에 등장한다.
> 추적 체인: 이슈 → **문서(이 파일)** → 코드(포트 `interface`) → 테스트(계약 테스트).
>
> 2층 계약 SoT:
> - **용어·의도·불변식** = 이 문서가 SoT.
> - **시그니처·타입** = 코드의 포트 `interface`가 SoT (여기 중복하지 않는다).
> - 코드 주석은 계약 본문을 적지 않고 `@see glossary.md#용어` 로 이 문서를 가리킨다.

## TTS (Text-to-Speech) slice

### TtsPort
코어가 "텍스트를 말소리 오디오로 바꿔달라"고 요청하는 **driven port**(코어에서 바깥으로 나가는 경계).
어댑터(mock·edge·openai…)가 구현한다. **불변식: 코어는 어댑터를 절대 import 하지 않는다** — 오직 이 포트를 통해서만 호출한다. 제공자 교체(나중엔 naia-agent)는 어댑터만 갈아끼우면 된다.

### SynthesisRequest
합성 요청 값. `text`(필수), `voiceId`(선택).

### SynthesizedSpeech
합성 결과 값. `audioBase64`(base64 MP3), `costUsd`(선택 — 제공자가 비용을 알릴 때만).

### AudioEncoding
오디오는 **base64로 인코딩된 MP3 바이트**로 주고받는다. (전송·직렬화 단순화, 경계 통과 시 바이너리 의존 제거)

### Adapter
포트를 구현하는 바깥 세계 연결체. `mock`(테스트·데모용 결정적 가짜) / `edge` / `openai` 등.
불변식: 어댑터는 `ports`와 `domain`만 의존하고, 다른 어댑터를 의존하지 않는다.
