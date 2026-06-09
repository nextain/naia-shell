# F3 — 승인→host-system mutating + reafference (baseline + 포트 계약, 2026-06-09)

> 06 실행 5단계 = F3 슬라이스. **상태: gemini 2연속 클린 (codex 풀 재독 최종게이트 리셋후 대기)**(codex 리뷰 = 사용량 한도 리셋 후 일괄 — clean 미선언). **범위(FR-F3.1~3.3)**: ① 승인 *먼저* → host-system mutating(파일 편집·명령 실행) ② mutating 결과 **reafference**(commanded→ack→observed→mismatch) ③ negative/불확정(거부·권한부족→차단; timeout·partial·실행후 drift·ack-not-observed → abort + 미확정 정직 보고 + disposition). UC7·UC13→UC7 / S07·S12. ApprovalPort(F1)+EnvironmentMutatePort+reafference.
> 구성/규칙 = F1/F2 문서와 동일(§A baseline + §B 계약; STRUCTURE.md 171~297; 언어/툴체인 미정; control-plane). **F1 ApprovalPort·F2 EnvironmentObservePort 재사용**.

---

# §A. Old-Baseline (코드 도출)

## A.1 파일 write/edit
| 기능 | 소스 | 거동 |
|---|---|---|
| write_file | `tool-bridge.ts:703` | path 검증(null/traversal/sensitive) → mkdir -p + printf > path |
| apply_diff | `tool-bridge.ts:742` | read → search 존재확인 → replace → write |
| workspace write | `workspace.rs:939 workspace_write_file` | `validate_write_path`(첫 존재 조상 canonicalize, in-workspace) → fs::write |

## A.2 명령 실행
| 기능 | 소스 | 거동 |
|---|---|---|
| execute_command | `tool-bridge.ts:681` | **isBlockedCommand 먼저**(T3 패턴) → `exec.bash` RPC → `node.invoke` fallback |
| executor | `command-executor.ts:55`(RPC, idempotency UUID) · `native-executor.ts:27`(child_process.spawn; Flatpak→`flatpak-spawn --host`) | 라우팅 |
| pty exec | `pty.rs:33 pty_create`(shell allowlist·절대경로 검증) · `250 pty_execute_sync`(timeout 폴링) | 터미널 실행 |

## A.3 pty write 측
- `pty.rs:170 pty_write`(stdin 입력·flush) · `196 pty_resize`(SIGWINCH) · `224 pty_kill`(master close → exit emit).

## A.4 reafference (commanded vs observed)
- 결과 흐름(`agent/index.ts:701-730`): `executeToolWithRecovery` → result{success,output,error} → jobTracker.complete/fail → `tool_result` emit → chatMessages push → 다음 LLM 입력.
- ⚠️ **부분(NOT 순수 fire-and-forget이나 mismatch 단언 없음)**: ack/observed(결과 보고)는 존재하나 — **자율 검증 없음**(exitCode=0 면 stdout 신뢰, 후속 read/git-status 확인 없음), **commanded-vs-observed mismatch 단언 없음**(LLM 이 후속 tool 호출할 *수* 있으나 자동 아님). = **FR-F3.2 reafference 의 mismatch/검증 = F3 신설**.

## A.5 안전/차단 + 불확정
| 항목 | 소스 | 거동 |
|---|---|---|
| 차단 명령 | `tool-bridge.ts:357 isBlockedCommand`(rm -rf /·sudo·chmod777·\|bash·curl\|sh·mkfs·dd + sensitive 경로) | 미실행 error 반환(T3) |
| 경로 권한 | `workspace.rs:116·125 validate_in/​write_path` · `tool-bridge.ts:189 validatePath`(/etc·/proc·~/.ssh…) | workspace 밖·민감경로 거부 |
| timeout/cancel | `pty_execute_sync` timeout 폴링 · `pty_kill` 취소 | 존재 |
| ⚠️ 불확정 정직보고 | — | **GAP: partial(side-effect unknown)·실행후 drift·ack-not-observed 의 "미확정 정직 보고 + disposition" = baseline 없음 = F3 신설(FR-F3.3)** |

## A.6 오류 분류 / disposition (F3)
- 승인 거부·권한부족 = **block**(미실행).
- 차단 명령(T3) = block.
- mutation 불확정(timeout·partial·실행후 drift·ack-not-observed) = **abort + 결과 미확정 정직 보고**(rollback 가능 시만; 항상 rollback 가정 금지). = 신설.

## A.7 커버리지 manifest (F3)
- **accepted**(이식): file write/apply_diff · execute_command(blocked check·RPC/native/flatpak 라우팅) · pty write/resize/kill · 경로/명령 안전(blocked·sensitive·in-workspace) · timeout/kill.
- **new-requirement**(baseline 부분/부재 → F3 신설): **reafference mismatch/자율 검증**(commanded→ack→observed→mismatch; baseline=결과 보고만, 단언 없음) · **불확정 상태 정직 보고 + disposition**(partial·실행후 drift·ack-not-observed; FR-F3.3) · **승인-실행 결속 게이트**(F1 ApprovalBinding 을 mutate 직전 검사 — 실행 전 drift=block은 F1, 실행 후=여기).
- **deferred**: rollback 자동화(가능 시만, 항상 가정 금지) · SafetyPort e-stop/lease(UC13a, 후속) · app-surface(browser) mutate facet(별도).
- 미분류 = 0.

---

# §B. 포트 계약 (헥사고날 매핑)

## B.1 domain/ (순수, import 0)
| 값객체 | 규칙 |
|---|---|
| `MutationCommand` | `{op: writeFile \| applyDiff \| execCommand \| ptyWrite, target, body}`. ActionScope(F1) 와 정합. **observed 출처 = op 종류별**(gemini R2 HIGH): writeFile/applyDiff → `target` 파일 재-read(F2 observe); execCommand/ptyWrite → **ack 의 exit code + 캡처 output**(별도 read 아님; `target`=명령 자체). 관측가능 side-effect 없는 명령 = reafference 가 ack(exit)까지만(mismatch 무의미). |
| `Reafference` | `{commanded, acknowledged, observed, outcome}` 상태기계. **분류 규칙(gemini R2)**: ack 받음 + 관측 성공 → `match`(observed=expected) \| `mismatch`(observed≠expected); ack 받음 + **관측 자체 실패/무응답** → `observationFailed`(→ UncertainState{ackNotObserved} 생성; mismatch 와 구분, R3); ack 없음 → terminal(정상 조기종료, NFR-provenance). |
| `UncertainState` | `timeout \| partial(side-effect unknown) \| postExecDrift \| ackNotObserved`. → **abort + 미확정 정직 + disposition**(FR-F3.3). |
| `CommandSafety` | blocked 패턴(T3) + sensitive 경로 + in-workspace 판정(순수 규칙; canonicalize I/O=어댑터). |
| `Disposition` | `contain \| degrade \| block \| abort`(F0 fault matrix 재사용). |

## B.2 ports/ (driven, domain 만 의존)
```
# ports/protocol
MutationRequest = { command: MutationCommand, binding: ApprovalBinding }   # F1 binding 동행
ReafferenceReport = { reafference: Reafference, uncertain?: UncertainState, timestamp, latency }

EnvironmentMutatePort:                       # host-system mutating (FR-F3.1) — async(NFR-efferent-async)
    writeFile(path, body): Result<Ack, Err>
    applyDiff(path, diff): Result<Ack, Err>
    execCommand(cmd, opts): Result<Ack, Err>   # blocked=거부(CommandSafety domain 판정 후)
    ptyWrite(id, data) / ptyKill(id): ...      # 실행/취소
    # 모든 mutate = 승인 게이트(F1 ApprovalPort) *통과 후*에만 호출 (FR-F3.1 "승인 먼저")
# reafference = EnvironmentObservePort(F2) 재사용 — 실행 후 observed 조회해 commanded 와 비교(domain mismatch)
```
> mutate 는 **async + interruption + reafference**(NFR-efferent-async; 동기 가정 하드코딩 금지). 직렬화·RPC/native/flatpak 라우팅 = adapter.

## B.3 app/control/ (포트 사용, 인지 0)
```
MutationGate:                                   # FR-F3.1·3.2·3.3
  execute(command, ctx):
    if CommandSafety.isBlocked(command): return Block   # T3·sensitive (미실행)
    decision = ApprovalGate.gate(command.tool, command.args, ctx)   # F1 — 승인 *먼저*
    if decision != Approved: return Block(decision)
    # ⚠️ 실행 직전 재검사는 F1(pre-exec drift=block). 여기부턴 실행 개시 후.
    ack = EnvironmentMutatePort.<op>(command)         # async
    # observed 출처 = op 종류별(R2): file 계열→F2 재-read, exec/pty→ack.exit/output
    observed = (op∈{writeFile,applyDiff}) ? EnvironmentObservePort.<read>(command.target)
                                          : ack.exitAndOutput
    # 관측 자체가 실패/무응답이면 ackNotObserved (mismatch 와 구분, R2)
    reaf = Reafference(commanded, ack, observed)   # outcome ∈ {match | mismatch | observationFailed} (domain 분류, R3)
    if reaf.outcome ∈ {mismatch, observationFailed} or uncertain(ack):  # observationFailed → UncertainState{ackNotObserved}
        return abort + honest(UncertainState) + Disposition     # FR-F3.3 (rollback 가능 시만)
    return ReafferenceReport(reaf, timestamp, latency)
```
> 실행 개시 *후* post-approval drift·ack-not-observed = 여기(abort+미확정). 실행 *전* drift = F1(block/재승인). FR-F1.3: 실패가 planning 오염 금지.

## B.4 adapters/ (Tauri/agent-wire, 스캐폴드 시 stub)
| 어댑터 | 포트 | 호출 |
|---|---|---|
| `ToolBridgeMutateAdapter` | EnvironmentMutatePort | `write_file`·`apply_diff`·`execute_command`(blocked·RPC/native) |
| `TauriWorkspaceWriteAdapter` | EnvironmentMutatePort.writeFile | `workspace_write_file`(validate_write_path) |
| `TauriPtyWriteAdapter` | EnvironmentMutatePort.pty* | `pty_write`·`pty_resize`·`pty_kill` |
| (reafference 관측) | EnvironmentObservePort(F2) | 실행 후 `workspace_read_file`/`get_sessions` 등으로 observed |

## B.5 composition/ — `src/main/composition/` 1곳 주입(F0/F1/F2 동일).

## B.6 검증 매핑 (P02)
- **계약 테스트**: 승인 먼저(미승인 mutate 차단) · blocked(T3)·sensitive 경로 거부 · **reafference mismatch**(commanded≠observed → 감지) · **불확정 abort+정직**(timeout/partial/drift/ack-not-observed → 미확정 보고, rollback 가정 금지) · contamination 격리.
- **통합 테스트**(P02 reafference): commanded→ack→observed→mismatch 관통 + negative path(거부·권한·timeout·침묵).
- **라이브 trace**(루크): 실제 파일 write·command exec·pty·timeout·취소.
- ⚠️ 신설(reafference mismatch·불확정 정직보고)은 baseline 부분/부재 → 요구사항 기반 신규(baseline=결과 보고만, 단언/미확정처리 없음 기록).

## B.7 다음
F3 초안 → (codex 리셋 후) F1·F2·F3 일괄 2클린 리뷰 → 툴체인 결정(루크) → `src/main` 스캐폴드.
