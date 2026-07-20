# Discord 설정 마법사 pre-freeze 정책

설치 URL, 최소 권한, gateway intent, 폐쇄형 preflight를 순수 도메인 정책으로 고정했다.
이 문서는 production 설정 마법사 결선 완료 보고가 아니다. 실제 마법사를 노출하려면
native secret backend와 preflight fact 수집을 먼저 연결하고 이 정책을 call site에서
사용해야 한다.

봇 토큰은 일반 설정값이나 WebView 문자열 IPC로 전달·저장하지 않는다. 후속 결선은
native secret backend의 opaque operation을 먼저 정의하고, `naia-adk`에는 토큰 값이
아닌 secret reference만 노출해야 한다. 따라서 이 변경에는 raw-token IPC, UI 입력,
composition wiring을 의도적으로 포함하지 않는다.
