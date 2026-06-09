# 요구사항 (P03 — FR/NFR) — 2단계 산출물

> 추적: P01 `user-scenarios.md` + P02 Test Coverage Map → P03. **범위 = foundation tranche(F0~F3)** 우선(나머지 tranche 는 착수 시 확장). **상태: 초안 — 2회 클린 리뷰 대기.**
> 원칙: FR=foundation 시나리오에서 도출, NFR=1단계 구조 불변식 + fault-isolation. 각 요구사항 = P04 통합 테스트 대상.

## 기능 요구사항 (FR) — foundation tranche

| ID | 요구사항 | 출처 시나리오 | 검증(P02) |
|---|---|---|---|
| **FR-F0** | 외부 키 없이 naia-adk workspace **최소 부팅**(control-plane init) — 손상·부분 설정은 정직 보고(차단/비차단은 손상 유형별 계약) | UC12-min·S01·S02 | 부팅 trace + negative(손상 설정) |
| **FR-F1.1** | naia 가 **자기 상태 read-only 관측·정직 보고**(system-status·diagnostics·device·설정/연결 degradation) — 오보 금지 | UC11·S09·S10·S11·S44·S12a | InteroceptivePort 계약 + 정직성 |
| **FR-F1.2** | **ApprovalPort 최소계약 선잠금**(승인부재·거부·만료·중복·승인후 컨텍스트변경) — F3 전 확정 | UC13·S12 | ApprovalPort 계약 + 상태전이 trace |
| **FR-F1.3** | 자기상태/승인 실패가 **planning·route·skill 선택을 오염시키지 않음**(downstream contamination 차단) | (횡단) | 통합 contamination 테스트 |
| **FR-F1.4** | **승인-세션 최소 결속**(request/session/context/correlation binding) — ClientSessionPort lease 전체는 DEFER 이나 *최소 binding subset 은 지금*(승인↔실행 묶음 전제) | UC13·UC10a(min) | binding 계약 |
| **FR-F2** | host-system **read-only 관측**(파일·프로세스 상태 조회, 변경 X) — 권한 밖 경로 거부·미지원 환경 정직 보고. **외부 간섭 drift 감지**(observed vs expected state) | UC7a·S33/S34(read) | EnvironmentPort observe + negative + drift |
| **FR-F3.1** | **승인 → host-system mutating**(파일 편집·명령 실행) — 승인 경로 *먼저*, 그 위에 변경 | UC13→UC7·S07·S12 | ApprovalPort+EnvironmentPort mutate |
| **FR-F3.2** | mutating 결과 **reafference**(`commanded→acknowledged→observed→mismatch`) — 의도/실행/실제 분리 | UC7(reafference) | 통합 reafference 테스트 |
| **FR-F3.3** | negative(exit-block): 승인거부·권한부족→차단; **mutation 불확정 상태 전체 처리** — timeout·interrupt/cancel·partial(side-effect unknown)·post-approval context drift·acknowledged-but-not-observed → 각 결과 미확정 정직 보고 + disposition(↓) | UC7 negative | negative + uncertain-state |

## 비기능 요구사항 (NFR) — 횡단(전 tranche)

| ID | 요구사항 | 근거(1단계 구조) |
|---|---|---|
| **NFR-isolation** | 각 기능이 자기 slice/port 경계에 들어가 **고장이 격리**(깨진 기능이 타 영역 비전파) | fault isolation(루크) |
| **NFR-deny-default** | 권한/승인 명시 없으면 **거부**; 민감-도메인(security/policy/approval/safety) old-bug = 자동 FAIL+exit 차단 | deny-by-default·거버넌스 |
| **NFR-determinism** | 계약 드리프트 = **0토큰 결정론 게이트**(conform-gate) + drift-gate. **trivial 정의(정규화 제외)** = timestamp·PID·랜덤·임시경로·실행순서 비결정성; 그 외 의미 상태/출력 차 = FAIL | conform-scan |
| **NFR-substrate-agnostic** | 포트는 **embodiment/dimension/host-neutral**(뇌는 substrate 모름) — 의도/관측만 | brain/body/OS |
| **NFR-efferent-async** | 출력 3축(Express/Action/Environment) = **async + interruption + reafference**, 동기 가정 하드코딩 금지 | efferent 계약 원칙 |
| **NFR-provenance** | 모든 event 에 actor/client id + 귀속 body·env + execution correlation id(+ reafferent backlink). **인과 연속성**: 승인↔실행↔결과↔보고 원자 체인 + `commanded→ack→observed` causal continuity(이벤트는 찍혔는데 체인 끊김 = FAIL) | provenance 불변식 |
| **NFR-error-model** | **canonical error model**: 2직교축(오류-유형×민감-도메인) + blocking/non-blocking + uncertainty(확정/미확정) + retryability + contamination projection — 포트 공통 | 오류 분류 |
| **NFR-port-canon** | 포트별 **canonical shape + versioning + backward-compat + error-surface stability**(P04 계약검증 가능하게) | port canon |
| **NFR-transparency** | 상태 보고에 **timestamp + latency(신선도)** — async efferent 와 맞물려 데이터 신선도 확인 | observability |
| **NFR-baseline** | golden trace 행동 등가; **측정불가/깨짐 ≠ baseline → 격리/면제 목록**(자격: old 본래 부재 시만; 작동상실=regression) | P02 검증 |
| **NFR-coverage** | capability-class 대표+변이축 예외 **샘플 manifest 고정**(coverage drift 방지) | P02 샘플링 |
| **NFR-env-norm** | 측정 시 외부 키/엔드포인트 stub 강제(루크 env 부작용 분리); 측정 간 workspace/pty/cache/session 리셋 | P02 환경 정규화 |

## 제품 NFR vs 검증 NFR 분리 (R1 codex)

- **제품(런타임) NFR**: isolation · deny-default · substrate-agnostic · efferent-async · provenance · error-model · port-canon · transparency.
- **검증 NFR = P04 measurement contract**(구현 요구 아님, 측정 규약): determinism(0토큰 게이트) · baseline(golden trace·격리목록) · coverage(샘플 manifest) · env-norm(stub·리셋).

## Fault disposition matrix (R1 — failsafe 결정 규칙)

실패 감지 시 "정직 보고"만으론 부족 → fault class 별 **disposition 결정**:

| fault class | disposition | 비고 |
|---|---|---|
| 민감-도메인 ∩ (거부·권한·정책 위반) | **block / abort** | deny-by-default, exit 차단 |
| mutation 불확정(timeout·partial·post-approval drift·ack-not-observed) | **abort + 결과 미확정 정직 보고**(rollback 가능 시만) | 항상 rollback 가정 금지 |
| 자기상태/관측 실패(F1/F2) | **contain + 정직 보고**(상위 오염 차단), 부팅 차단 X | downstream contamination 방지 |
| 손상 설정(F0) | 손상 유형별 **contain(정직보고) 또는 block(fail-closed)** | 유형별 계약 |
| 외부 의존 degradation(후속) | **degrade**(최소 기능) — *full fallback impl=DEFER, disposition 규칙만 지금* | |

> `contain / degrade / block / abort` 중 하나로 매핑 안 된 실패 = 미정의 = FAIL.

## Foundation 추적 완결 (R1 codex — completeness)

모든 foundation 시나리오/검증항목은 **FR / NFR / DEFER / out-of-scope 중 하나로 폐쇄 매핑**(미매핑 0):
- F0=FR-F0 / F1=FR-F1.1~1.4 / F2=FR-F2 / F3=FR-F3.1~3.3 + 횡단 NFR 전체.
- 격리 항목(미배선 memory/cron·깨짐 Discord)=DEFER/격리목록. 분포(ISO/USB)=out-of-scope.
- (추적표 갱신 = tranche 착수 시.)

## DEFER (후속 tranche / step-3+)
- V1/V2(텍스트·음성)·도구·환경-앱·채널 FR = 해당 tranche 착수 시 도출(외부 의존 Old-Baseline 후).
- OS-core(SafetyPort e-stop·ClientSessionPort lease) FR = F3 후.
- 기억(naia-memory) FR = 미배선 → 통합 트랙.
- botmadang(S65) = keep/reject 결정 후.

> 각 FR/NFR = P04(통합 테스트) 검증 대상. FR-F0~F3 착수 = Old-Baseline 측정(로컬·외부키X) 후 계약·테스트 구체화.
