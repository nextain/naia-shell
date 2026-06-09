# F2 — host-system read-only 관측 (baseline + 포트 계약, 2026-06-09)

> 06 실행 4단계 = F2 슬라이스. **상태: gemini 2클린 + GLM-5.1 교차검증(실코드 직독)** — codex 풀 재독 최종게이트 리셋후 대기(codex 리뷰 = 사용량 한도 리셋 후 일괄 — clean 미선언). **범위(FR-F2)**: host-system **read-only 관측**(파일·프로세스 상태 조회, 변경 X) — 권한 밖 경로 거부·미지원 환경 정직 보고 + **외부 간섭 drift 감지**(observed vs expected; expected 권위 우선 = 선언적 목표상태 > 마지막 승인 의도 > 직전 관측 스냅샷). UC7a / S33·S34(read). EnvironmentPort observe.
> 구성/규칙 = F1 문서와 동일(§A baseline + §B 계약; STRUCTURE.md 171~297 레이어; 언어/툴체인 미정; F2=control-plane 인접 환경 관측, 인지 0).
> ⚠️ **sensory(audio/vision)는 F2 범위 밖**: capture(vision)·voice STT 등 SensoryPort = 외부키/voice 의존 → 후속 sensory tranche. F2 = host-system 환경 관측만.

---

# §A. Old-Baseline (코드 도출)

## A.1 workspace 파일시스템 read
| 기능 | 소스 | 거동 |
|---|---|---|
| 세션/git 조회 | `workspace.rs:308 workspace_get_sessions()` | workspace 내 git repo 목록(dir·path·branch·status·last_change·recent_file) |
| 디렉터리 목록 | `workspace.rs:891 workspace_list_dirs(parent)` | entries(name·path·is_dir, dotfile 제외) |
| 파일 read | `workspace.rs:919 workspace_read_file`·`925 workspace_read_file_bytes`·`931 workspace_file_size` | 내용/바이트/크기 — **경로 workspace 경계 검증** |
| 인덱스/스킬 | `723 workspace_load_project_index`(YAML)·`741 workspace_discover_skills`(SKILL.md)·`753 workspace_read_skill_content` | 메타 read(in-workspace 검증) |
| 디렉터리 분류 | `workspace.rs:524 workspace_classify_dirs` | read-only 분류(project/worktree/reference/docs/other; `get_all_worktree_paths` 호출) |
| 권한 검증 | `116 validate_in_workspace`(canonicalize + starts_with root) | 권한 밖 경로 거부(read) |

## A.2 파일 watch (외부 변경 감지)
- `workspace.rs:400 workspace_start_watch()` + `notify::RecommendedWatcher`: `.git` 재귀 Modify/Create 감지(dotfile·.lock·non-file 필터) → `workspace:file-changed`{session, file(rel), timestamp} emit + 캐시(last_change·recent_files·branch) 갱신. `stop_watch`=캐시 clear.
- ✅ **외부 변경 감지됨**(OS inotify/FSEvents — naia 가 안 만든 변경도 감지).
- ⚠️ **GAP(FR-F2 drift)**: watcher 는 **raw change event** 만 emit — **expected(목표상태/승인의도/직전스냅샷) 대비 비교·권위 우선순위 판정 없음**. = F2 신설(drift 감지).

## A.3 프로세스/시스템 read
| 기능 | 소스 | 거동 |
|---|---|---|
| system-status | `agent/src/skills/built-in/system-status.ts:13`(execute 진입; `os.*` 17~35) | mem/cpu/os/uptime |
| diagnostics proxy | `diagnostics-proxy.ts` getHealth/getUsageStatus/getUsageCost/getGatewayStatus/pollLogsTail(cursor) | RPC 상태/사용량/로그 tail |
| git/worktree | `workspace.rs:213 get_branch`·`845 get_main_worktree`·`866 get_all_worktree_paths` | read-only git 조회 |
| pty 프로세스 | `workspace.rs:612 workspace_get_pty_agents(pids)` | 프로세스 트리(sysinfo)서 AI agent(claude/opencode/codex/gemini) 자손 탐지 |

## A.4 terminal/pty read
- `pty.rs:122 pty_create()` reader thread: PTY master 4096B chunk → `pty:output:{id}` event. child-wait thread → `pty:exit:{id}`. `pty_execute_sync()`(pty.rs:261~344) = **PTY 아님** — `std::process::Command`+`Stdio::piped()`로 `bash -lc` 직접 spawn → stdout/stderr 스레드 read + try_wait 폴링(동기 exec, GLM-5.1 M2 정정).

## A.5 오류 분류 / disposition (F2)
- 관측 실패/권한 밖 경로 = **contain + 정직 보고**(거부; 상위 planning 오염 차단, FR-F1.3 연속), 부팅·다른 관측 차단 X.
- 미지원 환경(예: Linux 전용 device) = 정직 "미지원" 보고.

## A.6 커버리지 manifest (F2)
- **accepted**(이식): workspace fs read(목록/내용/크기/세션/인덱스/스킬/**분류 classify_dirs**) · 권한 검증(in-workspace) · watch(외부변경 감지·event emit) · 프로세스/시스템 read(system-status·diagnostics·git·pty-agents) · pty read(output/exit).
- **new-requirement**(baseline 부분/부재 → F2 신설): **drift 감지**(observed vs expected + 권위 우선순위: 목표상태>승인의도>직전스냅샷; baseline=raw event만) · **미지원 환경 정직 보고 통합**(FR-F2).
- **deferred(범위 밖)**: SensoryPort vision(`capture.rs capture_screen_region` PNG)·audio STT = sensory tranche(외부/voice 의존). browser app-surface(S26/27 ~50)=EnvironmentPort app-surface facet(별도 pass).
- 미분류 = 0.

---

# §B. 포트 계약 (헥사고날 매핑)

## B.1 domain/ (순수, import 0)
| 값객체 | 규칙 |
|---|---|
| `ObservedState` | 관측 스냅샷(파일 존재/메타·프로세스·git·dir entries). 순수 값. |
| `ExpectedState` | 기대 상태 + **권위 출처** `{source: goal \| approvedIntent \| lastSnapshot}`. **우선순위 규칙(결정적, FR-F2)**: goal-state > approvedIntent > lastSnapshot — 상위 존재 시 그것을 expected 로 채택. |
| `DriftSignal` | `observed ≠ expected` → drift. **외부 간섭**(naia 미발 변경) 구분. 순수 비교(I/O 0). |
| `WorkspacePathPermission` | 경로 ∈ canonical workspace root 판정(순수 규칙; canonicalize I/O 는 어댑터). 권한 밖 = 거부. |

## B.2 ports/ (driven, domain 만 의존)
```
# ports/protocol
ObservationPayload = { kind, state: ObservedState, timestamp, latency }   # NFR-transparency: 신선도 동반
FileChangeEvent    = { session, file, timestamp }                          # watch emit (wire-framing 누출 금지)

EnvironmentObservePort:                      # host-system read-only (FR-F2)
    listDir(path): Entry[] | PermissionDenied # 권한 밖=거부
    readFile(path): bytes | PermissionDenied
    fileStatus(path): Meta | NotFound
    sessions(): SessionInfo[]                 # git repos 상태
    processStatus(): ProcessInfo[]            # system-status·pty-agents
    worktrees(): WorktreeInfo[]                   # repo 상태(get_main_worktree/all_worktree_paths) — fs/session 계열(gemini R2: processStatus 아님)
    subscribeChanges(): stream<FileChangeEvent>   # watcher(외부변경 포함)
    # ⚠️ 모두 read-only — mutate 0 (mutate=F3 EnvironmentMutatePort)
ExpectedStateProviderPort:                   # ⚠️ drift 의 expected 입력 출처(gemini R2 MED — hidden dep 해소)
    goal(): DeclaredGoal | null               # 선언적 목표상태(최상위 권위)
    approvedIntent(): ApprovedIntent | null    # 마지막 승인 의도(F1 ApprovalBinding 연계)
    lastSnapshot(target): ObservedState | null # 직전 관측 스냅샷(저장/조회 — adapter 영속)
PtyReadPort:
    output(): stream<chunk> / exit(): stream<code>    # pty read 측
```
> drift **판정**(observed vs expected, 우선순위)은 domain/app; canonicalize·notify·sysinfo I/O 는 adapter.

## B.3 app/control/ (포트 사용, 인지 0)
```
ObservationService:
  observe(target):
    state = EnvironmentObservePort.<read>(target)   # 권한 밖=PermissionDenied 정직 반환
    return ObservationPayload(state, timestamp, latency)   # 신선도(NFR-transparency)
DriftDetector:                                   # FR-F2 신설
  onChange(evt):                                  # subscribeChanges 구독
    observed = EnvironmentObservePort.fileStatus(evt.file)
    expected = ExpectedState.resolve(ExpectedStateProviderPort.goal(), .approvedIntent(), .lastSnapshot(evt.file))   # 권위 우선순위(포트로 조회, R2)
    if DriftSignal(observed, expected): report(drift)   # contain + 정직(상위 오염 X, FR-F1.3)
```
> 관측/​drift 실패는 contain — planning/route/skill 입력 오염 금지(FR-F1.3 연속). NFR-substrate-agnostic: 포트는 host-neutral(headless 값 부재 허용).

## B.4 adapters/ (Tauri, 스캐폴드 시 stub)
| 어댑터 | 포트 | 호출 |
|---|---|---|
| `TauriWorkspaceReadAdapter` | EnvironmentObservePort | `workspace_list_dirs`·`_read_file`·`_file_size`·`_get_sessions`·`_load_project_index`·`_discover_skills` + `validate_in_workspace` |
| `TauriProcessAdapter` | EnvironmentObservePort.processStatus | `system-status`·`diagnostics-proxy`·`workspace_get_pty_agents` |
| `TauriWorktreeAdapter` | EnvironmentObservePort.worktrees/sessions | `get_branch`·`get_main_worktree`·`get_all_worktree_paths`(repo 상태, R2) |
| `ExpectedStateAdapter` | ExpectedStateProviderPort | goal/approvedIntent(F1 binding) + lastSnapshot 영속(store/조회) |
| `NotifyWatchAdapter` | EnvironmentObservePort.subscribeChanges | `workspace_start_watch`/`stop_watch`(notify crate) |
| `TauriPtyReadAdapter` | PtyReadPort | `pty:output`/`pty:exit` event |

## B.5 composition/ — `src/main/composition/` 1곳 주입(F0/F1 동일).

## B.6 검증 매핑 (P02)
- **계약 테스트**: 권한 밖 경로 거부(PermissionDenied) · 외부변경 감지→drift 판정(expected 우선순위 결정성) · 관측 실패 contain(planning 오염 X) · 신선도(timestamp/latency 동반).
- **라이브 trace**(루크): watcher 외부변경 event·pty output·대용량 dir 관측.
- ⚠️ 신설(drift 감지 + 권위 우선순위)은 baseline 부분 → 요구사항 기반 신규(baseline=raw event 기록).

## B.7 다음
F2 초안 → (codex 리셋 후) 2클린 리뷰 → F3 → 툴체인 결정 → 스캐폴드.
