# 사용 통계 구현 회차 2 설계 (2026-11-19)

범위: 요구서 US-06·US-07·US-08의 로컬 합성 범위·US-09·US-10, 시나리오 T-05·T-06·T-07. 이 문서는 로컬 수집 경계와 일간 계산을 고정한다. 실제 Application Insights 자원 연결·생성·변경과 수신 검증은 회차 3 범위다.

## 이름표·값 허용 경계 (US-06·US-07)

- 세부 UI 이름표의 정본 허용 목록은 `packages/shell/src/lib/usage-inventory.ts`의 `usageControls`다. `data-usage-event` 선언은 `packages/shell/src/components/`·`packages/shell/src/apps/` 및 셸 루트의 JSX에서 정적으로 이 목록과 대조한다. `docs/progress/usage-events/event-inventory.md`는 사람이 읽는 이름표 대조표다.
- 의미 사건의 정본은 `packages/shell/src/lib/usage-events.ts`의 고정 `semantic` 화면표다. 요구서 US-06의 의미 사건 이름 30개와 한 글자도 다르지 않은지 시험한다. 상세 누름 이름표와 의미 사건은 한 제어에서 함께 날 수 있지만, 일간 보고에서 두 층을 합산하지 않는다.
- `UsageEvents.record()`는 동의·빌드 설정을 확인한 뒤 이름과 화면 조합, 선택값, 로그인 시도 UUID, 실패 분류, 허용 속성만 통과시킨다. 미등록 이름, 잘못된 화면·값, 추가 속성은 큐에 넣기 전에 버린다. 본문·주소·경로·오류 문자열은 이벤트 스키마에 없다. 실패 분류는 `cancel`, `browser_open`, `timeout`, `validation`, `storage`만 허용한다.
- 통계 프로필·이벤트 식별자는 무작위 UUID이고 계정·ADK·음성 식별자와 연결하지 않는다. 순번은 설치 프로필별 원자 잠금 아래 증가한다. 상세 제어에서 선택한 원래 값은 보내지 않는다.

| 요구서 대조 | 코드의 허용 집합 | 표·시험의 확인 |
|---|---|---|
| 의미 사건 30개 | `usage-events.ts`의 `semantic` | `usage-events.test.ts`가 요구서 이름 30개와 같고 `event-inventory.md`에 각각 있는지 확인 |
| 상세 `data-usage-event` 이름·화면·트리거 | JSX 선언과 `usage-inventory.ts`의 `usageControls` | `usage-inventory.test.ts`가 화면 코드의 집합과 allowlist가 같고, 전부 대조표에 있는지 확인 |

## 중복, 재시도, 동의 종료 (US-06·US-08 로컬 범위, T-06)

- 전송 재시도는 큐에 저장된 같은 불변 이벤트 객체를 한 번만 다시 보내므로 `event_id`·설치 번호·순번·시각을 바꾸지 않는다. 모의 보고 계산은 서비스별로 `event_id`를 먼저, 그다음 `(installation_id, sequence)`를 중복 키로 삼아 먼저 본 유효 행 하나만 센다. 두 키가 없는 웹 행은 근거 없는 중복 추정을 하지 않고 그대로 센다.
- 동의 끄기·다른 창의 끄기·저장/잠금 실패는 메모리 큐와 예약 타이머를 비우고 진행 중 요청을 중단 시도한다. 이미 수신된 자료 취소는 보장하지 않는다. 종료(`pagehide`/`stop`)는 큐를 폐기하며 디스크 큐를 만들지 않는다. 오프라인에서 flush하면 그 시점 대기 사건을 폐기하고 유실 수만 로컬 메모리에 더한다. 재동의·복귀 후에는 폐기 사건을 되살리지 않는다.
- 보고의 dedupe는 수신기/집계 계층의 멱등 처리 모형이다. 이 로컬 계산기는 합성 행에서 같은 규칙과 결과를 확인하며 실제 Azure 수신은 하지 않는다.

## 일간 보고 계산 (US-09·US-10, T-07)

- 날짜 인자는 `YYYY-MM-DD`의 KST 날짜다. UTC 저장 시각은 고정 UTC+09:00으로 변환한다. 범위는 `[KST 날짜 00:00, 다음 날짜 00:00)`이며 시작 시각은 포함하고 다음 날 자정은 제외한다.
- 서비스별 원천 상태는 `known` 또는 `unknown`이다. `known`의 행 0건은 실제 숫자 0이고, `unknown`은 모든 지표를 `null`과 상태 `미확인`으로 내보낸다. 미확인을 0으로 바꾸지 않는다. 보고서에는 KST 범위, 생성 시각, 원천, 동의 표본임, 이벤트 중복 제거 키를 기록한다.
- 웹: `login_view`, `login_click`, `login_oauth_done`의 고유 수와 `login_oauth_done ÷ login_click`. 분모가 0이면 비율은 수치가 아니라 `분모 없음`이다.
- 웹GPU: `webgpu_model_download_start`, `webgpu_model_download_complete`, `webgpu_model_download_fail`, `webgpu_unsupported`, `webgpu_first_reply` 수. 중앙값은 유효한 `elapsed_seconds`가 있는 성공한 `webgpu_first_reply`만 대상으로 초 단위로 계산한다. 값이 없으면 `null`·`미확인`; 성공 행은 있지만 시간 필드가 하나도 없으면 중앙값은 `null`·`미확인`이다.
- 셸: `shell.launch.start`가 하루에 하나 이상 있는 고유 `installation_id` 수(하루 활동), `intro.screen.view`의 `welcome` 화면에 도달한 고유 설치 수(첫 소개 진입), `login.credentials.saved` 사건 수(로그인 저장 성공), `chat.reply.first`의 고유 설치 수(설치별 첫 답변), `app-bar.open-app-store-5.click` 수(상세 누름), `login.attempt.fail` 수(허용 실패 분류만). 앱스토어 상세 누름은 의미 사건 수와 더하지 않는다.
- 결과에는 셸·웹·웹GPU가 동의한 통계 표본만 포함되고 세 서비스의 사람 경로는 연결되지 않는다고 표시한다. 다운로드 총량·파일 수신·설치·실행은 별도 지표이며 다운로드와 설치 식별자는 연결하지 않는다.

## 모의 검증 자료

T-05는 합성 개인정보 표식을 잘못된 이름·화면·선택·시도 ID·오류값에 넣어 거절되는지 확인하고, 허용 이벤트 본문·고정 헤더에 표식이 없는지 검사한다. T-06은 두 인스턴스의 원자 순번, 실패 후 재시도 ID 보존, 두 전송의 보고상 1건 처리, 끄기·종료·오프라인 뒤 재전송 없음으로 확인한다. T-07은 KST 자정 양쪽 사건, 중복 event ID·순번, 상세/의미 층 분리, 비율 분모 0, 중앙값, 미확인 원천을 합성 기대값과 대조한다.
