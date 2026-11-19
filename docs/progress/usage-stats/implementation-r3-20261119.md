# 사용 통계 회차 3 — 개발 수신 대조 설계

기준: US-03·US-08·US-11, 기존 T-02·T-04, 문서 사슬 RQ-01·02·03·08·11·12·14, FE-08, UT-01·IT-01·IT-05·IT-08·E2E-06. 이 기록은 0.3 통합 전 시험이며 공통 수집 모듈의 참조·호출을 입증하지 않는다. 웹 표준 통합 경로는 알파 0.3 통합안에 의존한다. 이 가지는 수집·동의 코드를 추가하지 않는다.

## 개발 자원과 분리

- 구독 `Startup Credit Subscription`, 그룹 `rg-naia-dev-koreacentral`, 지역 `koreacentral`. 셸 개발 Application Insights `appi-naia-shell-dev-r3-20261119`는 전용 Log Analytics 작업 공간 `law-naia-shell-dev-r3-20261119`에 연결돼 있다. 앱 상한과 작업 공간 일일 할당량은 각각 0.1 GB다.
- 2026-11-19 UTC 개발 작업 공간 `AppEvents` 테이블의 보유와 총 보유를 각각 30일로 수정했으며 table show 재조회 결과 `retentionInDays=30`, `totalRetentionInDays=30`이다. 작업 공간 기본 보유는 30일이며 Application Insights 자체 표시 보유는 이전 조회에서 90일이었다. 이 표시는 테이블 재조회 값과 구분한다.
- Application Insights 상한 경고 임계값은 90이고 상한·임계값 알림 끄기 설정은 둘 다 `false`. 그룹 범위 월 예산 `usage-stats-shell-dev-r3-20261119` 금액 10, 실제 비용의 50·80·100% 초과 알림 활성. `az consumption budget show`의 `filter`·`filters`는 null로 반환됐으므로 이 CLI 결과만으로 자원별 필터를 확정하지 않는다.
- 역할 조회에는 구독 범위 User `Owner`, 그룹 범위 ServicePrincipal `Contributor`가 있다. 사용 가능한 자격의 조회 성공을 확인했으나 최소 권한·전체 상속 권한 검토는 남았다. IP 마스킹 필드는 null, 실제 IP·접근 기록과 삭제 검증은 미확인이다. 읽기 가능한 현재 구독의 Application Insights 자원 목록에는 셸 개발 자원만 있다. 따라서 이 구독에는 운영 셸 수신처가 아직 없어 시험 사건이 운영 셸 Application Insights에 들어갈 곳이 없다. 운영 조회는 하지 않았으며 다른 구독이나 GA4 운영 속성의 시험 사건 0건은 입증하지 않는다.
- 웹GPU는 승인된 기존 개발 GA4 속성 `naia.land 개발` (563338454, `G-0KGSHYL9SL`)을 재사용하는 선택이다. 새 속성·권한 관리를 피하면서 사건에 `service=webgpu`를 두어 웹과 논리적으로 구분할 계획이다. 운영 속성 525415688은 대상이 아니다. 웹GPU 실제 수신과 서비스 구분값은 알파 개발판 배포 후 검증할 사항이다.

## 기존 시험 대조와 사용법

2026-11-18 17:12:57.596Z~17:13:12.936Z의 통합 전 로컬 셸 개발 빌드 시험. 체크아웃의 기준 커밋은 `cfbbccb8cb3d3e5ca907e25112d35ba0ef10052c`, 시험 당시 미커밋 변경이 있었고 실제 서버 빌드의 정확한 트리/배포 커밋은 확인 못 함. 고유 설치 번호를 실행 표식으로 삼았다. 동의 전·철회 뒤 브라우저 요청은 각각 0; 저장된 해당 시간 구간 행도 각각 0. 동의 뒤 고유 10건과 동일 ID 재시도 1건이 전송되고 11행 저장, 고유 10건이다. 이 관찰은 여러 창, 새로고침, 다른 서비스 등 전체 동의 계약을 입증하지 않는다.

`scripts/usage-app-insights-r3.kql`은 당시 실행의 고정 표식·시간 구간으로 AppEvents를 조회한 쿼리다. 결과 JSON은 민감할 수 있으므로 저장소에 넣지 않는다. 기존 결과로 재계산:

```sh
node --experimental-strip-types packages/shell/scripts/usage-app-insights-reconcile.mjs \
  /절대경로/shell-live-r3.json /절대경로/shell-app-insights-r3.json \
  /절대경로/shell-daily-r3.json 2026-11-19
node --experimental-strip-types --test packages/shell/scripts/usage-app-insights-reconcile.test.mjs
```

이 대본은 수신 행의 실행 표식, KST 날짜, 사건 ID 집합과 재시도 1개를 대조하고 회차 2의 `deduplicateDailyUsageEvents` 및 `calculateDailyUsageReport`를 호출한다. 원본 회차 2 계산기에는 전체 사건 수 필드가 없어 대본의 `reconciledDailyEventCount`는 중복 제거 후 대조 숫자이며 계산기 자체 보고 필드가 아니다. 대본은 당시 저장된 `shell-daily-r3.json`의 `reportedEventCount`와 `report.shell.eventCount`가 대조 수와 같고 날짜·실행 표식이 일치하는지도 검사하며 실패 시 0이 아닌 종료 코드를 반환한다. 이 보고 필드는 당시 미커밋으로 추가됐던 필드의 결과다. 현재 커밋된 계산기의 실제 셸 지표는 활동 설치 1, 나머지 다섯 지표 0이다. 원천을 조회하지 않은 웹·웹GPU는 미확인이다. 이 숫자는 전체 제품 보고나 일간 스냅샷 저장을 증명하지 않는다.

## 되돌리기 (실행하지 않음)

다음 명령은 개발 자원과 시험 자료를 삭제한다. 종속성을 확인하고 필요할 때만 실행한다.

```sh
az monitor app-insights component delete -g rg-naia-dev-koreacentral -a appi-naia-shell-dev-r3-20261119 --yes
az monitor log-analytics workspace delete -g rg-naia-dev-koreacentral -n law-naia-shell-dev-r3-20261119 --yes
az consumption budget delete-with-rg -g rg-naia-dev-koreacentral -n usage-stats-shell-dev-r3-20261119
```

## 독립 검수 기록

- 1회차(codex luna max): 불통과, 막음 3·고침 2. 고침 회차에서 막음 1·2와 고침 1·2를 닫음.
- 2회차(codex luna max): 불통과. 1회차 지적 1·2·4·5 닫힘, 3(운영 0건)은 운영 접속 금지 범위라 미확인으로 남김.
- 남은 막음: 이 PR 의 대상 가지가 main 이 아니라 회차 2 가지(`naia/usage-stats-r2-20261119`)다. 회차 2 PR #883 이 0.3 웹판 통합과 함께 main 에 들어간 뒤 `gh pr edit 890 -R nextain/naia-shell --base main` 으로 바꾼다. 그전까지 의존으로 막힘이며 병합하지 않는다.
- 남은 참고: 조회문에 실행 표식이 고정돼 있다. 다음 시험 회차에서 매개변수로 바꾼다.
