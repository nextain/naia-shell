# 사용 통계 검증 기록 — 2026-11-04

기준: main `702b2c70`, 별도 `feat/usage-events` worktree. 정본 https://ax.nextain.io/d/eae97c . 배포·병합·Azure 자원 생성 없음. 상세 이름표: [event-inventory.md](event-inventory.md).

## 구현 경계

- 앱 프로필 WebView 저장소의 전용 키 두 개에 동의·임의 설치 번호·지속 순번·첫 응답 여부만 저장한다. ADK를 바꿔도 같은 번호, 저장소가 삭제되면 새 번호다. 복제된 프로필은 같은 번호가 되는 한계를 문서화했다. 지문을 추가하지 않는다.
- 첫 렌더의 동의 선택을 통과하기 전에는 App/ADK 설정을 마운트하지 않는다. 동의 전·거절·빌드 연결 문자열 없음에는 통계 번호·메모리 사건·요청이 없다. 설정 끄기는 현재 창을 동기 중단하고 storage/BroadcastChannel로 모든 창을 중단한다. 실패한 저장도 로컬 수집과 살아 있는 동료 창을 중지한다.
- Web Locks로 설치 번호 생성·순번 갱신을 원자화한다. Web Locks/BroadcastChannel 지원이 없거나 저장이 실패하면 수집을 닫는다. 이벤트 큐는 메모리 50, oldest 폐기, 10분 TTL, 한 번 재시도, 오프라인/종료/끄기 폐기다. 재시도는 원래 event_id/순번/시각을 보존한다. 끄기는 inflight AbortController 취소를 시도하나 서버 도착 취소를 보장하지 않는다.
- Azure EventData의 properties는 고정된 문자열 필드이며 sequence도 전송 시 문자열로 변환한다. 원자적 증가 계산은 정수로 한다. 집계는 `tolong(customDimensions.sequence)`를 사용한다. 허용 이름/화면/choice/시도 번호/실패 종류만 통과한다. 추가 필드는 런타임에서도 거절한다. 인증·쿠키·인스턴스 헤더·referrer·계정/대화/경로는 앱 통계에 넣지 않는다. 자동 계측 SDK와 디스크 전송 버퍼는 없다.
- HTTP 실패/부분 수신(206)은 동일 ID로 최대 한 번 재전송한다. 수신/보고의 event_id 중복 제거는 Azure 운영 작업의 필수 항목이다. 새 계정 생성과 셸 자격 저장을 동일 사건으로 표시하지 않는다.
- 432개 상세 제어와 부록 묶음 사건은 별개다. 누름 총량은 상세 제어 사건만, 단계 전환은 해당 의미 이름으로 필터한다. 상세+묶음의 전체 합을 누름 수로 읽지 않는다. 입력란 내용/슬라이더 값/동적 링크/외부 웹뷰 내부는 수집하지 않는다.

## 실행한 검사

모든 실행의 TMPDIR는 실행 폴더 기준 `tmp/`로 지정했다. 이 폴더 밖의 기존 작업 파일은 수정하지 않았다.

| 검사 | 결과 / 재현 명령 |
|---|---|
| 신규 통계·허용 목록·번역 | Vitest 3파일 19건 PASS (`usage-events`, `usage-inventory`, `i18n-user-facing`) |
| 기존 도입/대화/설정 + 신규 통계 | Vitest 6파일 234 PASS / 9 SKIP. 마지막 대화/통계 재검사 3파일 88 PASS |
| 전체 Shell | 249파일 PASS / 1파일 SKIP, 2612 PASS / 21 SKIP (`tmp/shell-tests-final.log`). 마지막 별칭-실제 제어 정합 추가 검사는 별도 15건 PASS |
| 브라우저 신규 | Playwright 4건: 동의 전 0/키보드 거절/재실행, 허용·Steam 묶음·2창·설정 끄기, 저장 오류·통계 없이 계속, 한국어 문구. Azure는 합성 연결 문자열과 `context.route` 수신기로 차단한 모의 요청이다. 실수신 완료 주장이 아니다 |
| 기존 언어 설정 브라우저 | 6건 중 4 PASS, 기존 빈 설정 저장 횟수 실패는 수정 없는 main에서도 재현. 즉시 언어 변경 시험의 한 번 실패는 재실행 PASS이며 main도 PASS. 최종 별도 실행 4건(기존 언어 변경+신규 3) PASS |
| 타입 | root core `tsc -p tsconfig.json`, Shell `tsc --noEmit`, bgm-sidecar `tsc --noEmit` PASS. 별도 Agent 저장소 타입 검사는 이 변경의 검사에 포함하지 않음 |
| 빌드 | Shell `pnpm build`와 번들 예산 PASS. final report는 `packages/shell/dist/bundle-budget-report.json` (생성물, 커밋 제외) |
| 린트 | 전체 Biome는 기존 오류로 RED. 동일 main과 파일·규칙별 비교에서 추가 오류 0. 신규 모듈·시험·설정 파일 Biome PASS. 전체 오류 수는 실행 폴더 result.md |
| 구조 | assembly coverage/file anchors/표준 Logger/git diff --check PASS. root 구조 검사는 기존 `tmp`, `tsconfig.build.json` 2건 RED이며 시작 전과 동일 |
| 코어 전체 | 1696 PASS / 5 FAIL / 13 SKIP, 별도 browser-host suite 수집 오류. 실패는 변경 없는 main에서 같은 5건과 수집 오류 재현. TMPDIR가 홈 아래여서 runtime-isolation 3건, CDP 상한/ADK 전환 2건·브라우저 suite 오류. 이 작업에서 기존 실패를 수정하지 않음 |
| Rust | 새 임시 Rust toolchain, vendored SDK 빌드, 정확한 paired-agent fdc6fcb 체크아웃을 tmp에 준비해 `cargo test --lib deep_link` 3건 PASS. 배포 채널 시험 10건 PASS. 실제 네이티브 로그인 서비스·설치본 관통 시험은 실행하지 않음 |

## 시각·UX 검토 (P04)

실 브라우저의 영문 360×740와 한국어 1280×720 스크린샷을 열어 확인했다. 제목→수집 내용→선택권→두 단추 순서가 보이고, 좁은 폭에서 가로 넘침 없이 두 선택이 화면 안에 있다. 거절과 허용을 같은 위계로 배치하고, 키보드 Enter로 거절 뒤 앱에 진입한다. 저장 오류는 role=alert, 재시도 또는 끄고 계속하기가 가능하다. 설정에는 제목·설명·label로 연결한 체크박스·끄기/기존 전송 안내가 있다. 동의 화면에는 빈 목록·진행 목록 상태가 해당하지 않는다.

스크린샷(로컬): `tmp/playwright-verified/usage-events-asks-before-c-68ebd-and-stays-off-after-restart-chromium/consent-narrow-en.png`, `tmp/playwright-verified/usage-events-Korean-consen-162c2-nd-renders-without-overflow-chromium/consent-ko.png`.

## 출시 전 남은 관문

Azure 자원 생성은 별도 승인 대상이다. 승인 후 연결 문자열을 빌드 환경에만 넣고 실제 WebView→수신→저장→집계/보고를 검증한다. 보유·권리 행사·아동·국외 처리와 14개 언어 방침 공지/시행, IP/접근 기록/권한 분리, 비용·일일 상한/공격/중단·복구, 중복/시계 이상/7일 집단 집계는 아직 실환경 검증하지 않았다. 다운로드는 총량만 보고한다. 웹 GA4·게이트웨이 작업과 개인 연결은 하지 않는다. 원본 0.2.4와의 p50/p95·메모리 성능 비교, 세 로그인 분기의 네이티브 실제 서비스/실패 관통 시험도 출시 전에 필요하다. 이 PR의 단위/브라우저 모의 시험으로 이를 대체했다고 주장하지 않는다.

## PR #830 CI 재검증 (2026-11-04)

- OSS-readiness와 같은 `node scripts/oss-readiness.mjs .` 실행: personal-path 및 나머지 하드게이트 모두 0건. 실행 폴더는 상대 경로로 기록한다.
- `node scripts/check-uc-traceability.mjs`: UC-USAGE-EVENTS의 P02 시험 행과 에이전트 능력 에픽 밖 분류를 명시해 새로 끊긴 UC 0건.
- `pnpm exec vitest run src/test/agent-bench-scenario-source.contract.test.ts src/test/agent-bench-execution.contract.test.ts`: 2파일 55건 PASS.
- core tsc, file anchors, assembly coverage, vacuous tests, e2e inventory check PASS. M4는 이 문서를 Evidence로 인용하고 PR 변경 파일과 교차검증한다.
- 재시작 구조 검사에서 기존 미등록 tmp 디렉터리와 tsconfig.build.json이 다시 검출됐다. conform manifest의 regions도 기존 빈 배열이다. 이번 수정은 문서·벤치 소관 분류이며 기능 코드는 추가하지 않았다. 이 기존 헌장/검출기 문제는 별도 정비 대상으로 남긴다.

### CI 브라우저 설치 호환성

UC 추적 통과 뒤 원격 code-gates가 Ubuntu 26.04에서 Playwright 1.60.0의 Chromium 미지원으로 멈췄다(run 41831251386). Ubuntu 26.04 의존성·다운로드 정의가 있는 Playwright 1.64.1로 개발 의존성 3개 묶음(test/playwright/core)만 올리고 잠금 파일을 갱신했다. workflow·게이트 규칙은 변경하지 않았다.

pnpm 10 frozen-lockfile 검증 PASS, 새 Chromium 설치 PASS, 새 버전의 `playwright test e2e/usage-events.spec.ts` 4건 PASS. 합성 연결 문자열·모의 수신기를 사용했다. 첫 재검사는 수신기와 맞지 않는 합성 endpoint를 지정해 수신 단정 1건이 실패했으며, 올바른 합성 endpoint로 4건 모두 재확인했다. 전체 셸 Vitest 재실행도 249파일 PASS/1 SKIP, 2612 PASS/21 SKIP이다.

### 통계 E2E 테스트 서버 설정

원격 run 41832056375는 브라우저 시험 235 PASS/49 SKIP 뒤 통계 수신 시험 1건이 실패했다. CI에 연결 문자열이 없으므로 의도대로 수집이 꺼져 있었지만, 신규 E2E가 수동 환경 변수에 의존하고 있었다. Playwright dev webServer의 env에 고정 합성 연결 문자열을 지정했다. 이 endpoint는 통계 spec의 route가 모의 응답하며 생산 빌드/설치본에는 설정되지 않는다. 부모 환경의 VITE_APPLICATIONINSIGHTS_CONNECTION_STRING을 unset한 상태에서 통계 E2E 4건 PASS를 확인했다. 제품의 연결 문자열 누락 시 수집 0 동작은 유지한다.


## PR #830 리뷰 회귀 요구사항

- 연결 설정과 BroadcastChannel, Web Locks가 모두 있어야 동의 화면과 설정 선택을 제공한다. 지원이 없을 때 기존 동의는 보존하고 수집은 닫는다. `e2e/usage-events.spec.ts`에서 두 API의 부재를 실제 브라우저로 검사한다.
- 설정 로그인 시작 후 자격 저장과 잔액 확인이 성공하면 같은 시도의 `login.credentials.saved`를 남기고 `browser_open` 실패를 남기지 않는다. `SettingsTab.test.tsx`에서 콜백과 잔액 조회를 모의해 검사한다.
- 셸과 독립 Slides는 동일한 `packages/shell/package.json` 버전을 주입한다. `e2e/slides-standalone-build.spec.ts`는 Slides 산출물을 빌드해 브라우저에서 실제로 실행하고 초기화 오류를 확인한다.

2026-11-09 재현 및 검증: 수정 전 설정 로그인 시험에서 `browser_open` 실패가 성공 사건을 대체했고, 독립 Slides 빌드는 빈 화면, Web Locks/BroadcastChannel 각각 제거한 브라우저는 동의 화면에 머물렀다. 수정 후 SettingsTab·usage 단위 3파일 142 PASS / 8 SKIP, 실제 Chromium 9 PASS(독립 빌드·설정 판정·기존 선택 보존 포함), 셸 및 코어 타입 검사와 UC 추적·assembly 검사가 통과했다. 실행 로그와 브라우저 출력은 실행 폴더의 `tmp/r3-*.log`, `tmp/r3-playwright-final/`에 두었다. 이미 설치된 다른 작업 사본의 의존성을 사용했으므로 로컬 Playwright는 1.60.0이며 PR 잠금 파일은 1.64.1이다. CI의 잠금 의존성 실행 결과는 별도로 확인한다. Azure 실수신이나 실제 네이티브 로그인 증거는 아니다.

### 최신 main 병합 검증 (2026-11-09)

main `349c69c3`의 방송·설치 앱·접근성·카메라 제어를 유지하며 기존 통계 이름을 보존하고, 새 고정 JSX 제어 20개를 대조표에 추가했다. 입력값·방송 키·앱 내용은 이름표에 넣지 않는다. 선택·통계 및 설치 앱·방송 집중 Vitest 163 PASS / 8 SKIP, Chromium 9 PASS, Shell·core 타입, OSS 하드게이트, UC 추적·assembly·E2E 목록·vacuous 및 통계 변경 파일 Biome을 확인했다. 다른 작업 사본의 기존 의존성을 임시 연결해 로컬 Playwright 1.60.0으로 실행했으며 잠금 파일의 1.64.1 원격 실행은 별도 확인한다. 설치 앱 iframe 내부 클릭은 기존 수집 범위 밖이다.
