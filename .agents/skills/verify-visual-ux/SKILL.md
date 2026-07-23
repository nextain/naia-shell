---
name: verify-visual-ux
description: Shell UI 변경의 정보 위계·상태·오류 복구·반응형·접근성 증거를 P04에서 검토한다. 컴포넌트, CSS, Playwright 또는 native Tauri UI를 변경했을 때 사용한다.
disable-model-invocation: true
---

# Shell 시각·UX 검토

## 목적

기능 계약이 통과했더라도 사용자가 다음 행동을 이해하지 못하거나, 좁은 Shell 패널에서 정보가 무너지거나, 오류를 복구할 수 없으면 완료로 선언하지 않는다.

1. 화면의 목적·주요 행동·위험 행동이 시각적으로 구분되는지 확인한다.
2. 기본·빈 목록·진행·성공·오류·좁은 폭 상태가 같은 사용자 흐름으로 이어지는지 확인한다.
3. 원시 상태값·비밀이 될 수 있는 오류·구현 용어가 사용자 결정을 대신하지 않는지 확인한다.
4. 컴포넌트 검사만으로 끝내지 않고 Playwright와 해당 시 native Tauri WebView에서 증거를 남긴다.

## 실행 시점

- `.tsx`, `.css`, i18n, 화면 배선, Tauri UI/IPC가 바뀐 기능의 P02와 P04.
- 기능 완료 전 적대적 UI/UX 재검토.
- 화면이 좁은 Workspace/Settings/Chat 패널에 새 입력·상태·오류를 추가할 때.

## 관련 파일

| 파일 | 역할 |
|---|---|
| `docs/user-scenarios.md` | P01/P02 사용자 흐름과 상태 매트릭스 |
| `docs/requirements.md` | UX·시각 수용 요구사항 |
| `.agents/context/agents-rules.json` | P04 필수 게이트 |
| `packages/shell/e2e/` | Playwright UI 수용 테스트 |
| `packages/shell/e2e-tauri/` | 실제 Tauri WebView 수용 테스트 |
| `packages/shell/src/styles/global.css` | Shell 반응형·상태 스타일 |

## 워크플로우

### 1. 상태 매트릭스 확인

각 변경 UI마다 아래 상태를 P02 Test Coverage Map에 연결한다.

| 상태 | 확인할 질문 |
|---|---|
| 기본 | 화면 목적과 첫 행동을 한 화면에서 알 수 있는가? |
| 빈 목록 | 데이터가 없다는 사실과 시작 행동을 구분하는가? |
| 진행 | 중복 전송을 막고 진행 중임을 알리는가? |
| 성공 | 결과·다음 행동·적용 시점을 혼동 없이 표시하는가? |
| 오류 | 안전한 원인과 재시도 전에 할 행동이 해당 요청 맥락에 있는가? |
| 좁은 폭 | 1,100px 이하에서 입력·경계·주요 행동의 순서가 유지되는가? |

하나라도 정의되지 않으면 **FAIL**이다.

### 2. 정적 검토

변경한 TSX/CSS에서 다음을 확인한다.

- disabled select처럼 선택할 수 없는 정보를 입력 컨트롤로 위장하지 않는다.
- 상태는 의미 있는 label/badge로 표시하며 raw enum·ISO timestamp만 표시하지 않는다.
- destructive·primary·secondary 행동의 시각적 우선순위가 있다.
- 오류에는 `role=alert`, 비차단 상태에는 `role=status` 또는 동등한 live-region 의미가 있다.
- 장문 안내가 grid의 입력 셀 사이에 섞이지 않으며, 긴 경로는 줄바꿈 가능하다.

### 3. 자동 UI 증거

1. 관련 Vitest를 실행한다.
2. Playwright로 상태 매트릭스와 좁은 폭을 확인한다.
3. Rust·Tauri 배선이 바뀌었거나 실제 Shell과 mock 차이가 가능한 경우 native Tauri spec을 실행한다.
4. 스크린샷을 남길 수 있는 환경에서는 `tmp/`에 저장해 검토한다. 스크린샷이 불가능하면 DOM 구조·bounding box·computed layout을 동등 증거로 기록한다.

### 4. 판정

다음이면 **PASS**다.

- 여섯 상태가 테스트와 실제 UI 경로에서 모두 확인된다.
- 기본 흐름에서 사용자가 구현 세부를 알지 않아도 시작·상태 확인·복구를 수행할 수 있다.
- 좁은 폭에서 주요 행동이 잘리거나 다른 컨트롤과 섞이지 않는다.
- 오류·상태 표현이 보안 경계를 넓히지 않는다.

다음은 **FAIL**이다.

- happy path만 통과하고 빈 목록·오류·진행 중 중복 요청을 검증하지 않은 경우.
- 테스트가 mock만 통과하고 요구된 native Tauri 확인이 없는 경우.
- 시각적 결함을 기능 테스트 통과로 덮는 경우.

## 예외

- 순수 내부 계산만 바뀌고 사용자 UI·문구·상태·배선이 전혀 바뀌지 않으면 이 검토는 필요 없다.
- 외부 provider의 실제 계정/결제가 필요한 시나리오는 격리 fixture로 Shell UI를 검증하고, 실계정 검증은 별도 운영 수용으로 기록한다.
- 색상 자체보다 시스템 접근성 설정을 따르는 경우에도 상태의 텍스트·ARIA 의미는 생략하지 않는다.
