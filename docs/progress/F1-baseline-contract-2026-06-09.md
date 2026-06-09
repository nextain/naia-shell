# F1 — 자기상태/진단 + 승인 최소계약 (baseline + 포트 계약, 2026-06-09)

> **상태: gemini 2연속 클린** (codex 최종게이트 리셋후 대기).
> 06 실행 3단계 = F1 슬라이스. **범위(FR-F1.1~1.4)**: ① InteroceptivePort = naia 자기상태 read-only 관측·**정직** 보고(system-status·diagnostics·device·degradation) ② ApprovalPort 최소계약 **선잠금**(F3 전 확정) + FR-F1.4 승인-세션 결속. UC11·UC14·UC13 / S09·S10·S11·S12·S44·S12a.
> 구성 = §A Old-Baseline(코드 도출, 동결 입력) + §B 포트 계약(헥사고날 매핑). 레이어 규칙 = STRUCTURE.md 171~297(F0 계약과 동일: `adapters→ports→domain`·`app→ports`·protocol 중립·단일 composition).
> ⚠️ 언어/툴체인 미확정(F0 §6과 동일) — 시그니처 언어중립. F1 = **control-plane**(인지 0; Interoception=시스템 내수용, 인지 아님).

---

# §A. Old-Baseline (코드 도출, old-naia-os)

## A.1 GROUP A — 자기상태/진단/device/degradation

| 기능 | 소스 | 거동 |
|---|---|---|
| gateway/agent health | `lib.rs:2179 gateway_health()`·`535 start_gateway_health_monitor()`(30s poll→`gateway_status` event{running,healthy}) | agent child 프로세스 liveness(`try_wait`) |
| diagnostics 표면 | `DiagnosticsTab.tsx:167 fetchGatewayStatus`(skill_diagnostics status)·`186 checkHealth`(state: checking/connected/disconnected)·`245 readNewLogLines`(byte-offset 로그 tailing) | health + 로그(agent/gateway/shell) |
| skill 표면 | `skill_diagnostics`(action: status/gateway_status) · `skill_system_status`(T0 tool) | agent-facing 상태 |
| device | `lib.rs:2104 list_audio_output_devices()`(PipeWire pw-dump, Linux) · `browser.rs:1014 browser_set_permission()`(CDP mic/camera) · WebKitGTK permission filter | 오디오/권한 device |
| degradation(부분) | `registry.ts:101·111 fetchModels→{connected:false}` · `chat-service.ts` "naia-agent unavailable" **graceful swallow(W2)** · `GeminiLive.ts:178 disconnected` · `ChannelsTab.tsx:180 Discord disconnected` | provider/채널 unreachable 감지(산발) |
| connection vs key | `registry.ts connected:bool`(API 도달=connection-state) ↔ config 키 저장(key-presence) | **둘이 구분되나 통합 정직보고 없음** |

> ⚠️ **CRITICAL GAP(FR-F1.1·S44)**: "키 저장됨(config) ≠ 실제 연결됨(reachable)" 정직 신호가 **통합되어 있지 않음** — degradation 은 graceful swallow(경고 로그 + "unavailable" 텍스트)뿐. 즉 *오보 위험*(키 있으니 연결됐다고 오인). **F1 이 메워야 할 신설(S44=신설 표기)**.

## A.2 GROUP B — 승인 메커니즘 (전체 흐름 존재)

| 단계 | 소스 | 거동 |
|---|---|---|
| 요청 emit | `index.ts:233 waitForApproval()` | `approval_request` frame(stdout) + `pendingApprovals[toolCallId]` map, **timeout 120s** |
| tier 분류 | `tool-tiers.ts TOOL_TIERS`(T0 auto / T1·T2 approval / **T3 = blocked(승인 아님)** / 미매핑→T2) | ⚠️ T3=차단(`tool-bridge.ts:335-365`), 승인 tier 아님(R1 정정) |
| auto-approve(영구) | `ChatPanel.tsx:1073` chunk handler — `isToolAllowed(tool)` 면 `sendApprovalResponse("once")` 자동 | 영구 grant 우회 |
| auto-bypass(direct tool) | `index.ts:213-223·1014-1019` — `skill_voicewake`·`skill_tts`(preview)·`skill_config`(models) 등 명시 예외도 auto | R1 추가: 영구grant 외 direct 예외 다수 |
| modal | `PermissionModal.tsx` (tier badge·args·버튼 allowOnce/allowAlways/reject) → `sendApprovalResponse(requestId,toolCallId,decision)` → `send_to_agent_command` | 사용자 결정 |
| 응답 처리 | `index.ts:225 handleApprovalResponse()` resolve | once/always/reject |
| 영구 grant | `config.ts:539 addAllowedTool()`→`allowedTools[]` · `534 isToolAllowed()` pre-check | always = 영구(단 D40: Phase5 always 거부 예정=fresh-per-tier) |
| correlation | `requestId` + `toolCallId`(map key) · `audit.rs:741` 로그 | **toolCallId 결속만**. ⚠️ `sessionId`(`approval-bridge.ts:35`)=**inert bridge 타입, live flow 미탑재**(R1 정정) |
| 비-chat | `chat-service.ts:305 onApprovalRequest`(voice 자동) · `ChatPanel.tsx:2017-2031`(**voice direct-tool 전면 auto-approve**, R1 정정) | voice auto |

> ⚠️ **GAP(FR-F1.4)**: 결속이 `requestId`+`toolCallId`까지(sessionId 미탑재) — **context-identity digest**(session + canonical workspace root + active surface + 승인시점 config 버전 + client id)와 **행위 스코프(target·op·body·env) 결속**·**pre-exec drift block** 은 **미구현 = F1 선잠금 신설**.

## A.3 오류 분류 / disposition (F1)
- 자기상태/관측 실패 = **contain + 정직 보고**(상위 planning/route/skill 오염 차단, FR-F1.3), 부팅 차단 X.
- degradation = 정상 상태의 하나(오류 아님) — 단 **정직 표면화 필수**(오보 금지).
- 승인 부재/거부 = baseline 처리(reject). ⚠️ **만료(expired)·중복(duplicate)은 baseline 미구현** — old 는 timeout→`reject` 로 붕괴(`index.ts:252-256`), duplicate 별도 분기 없이 `toolCallId` map key 의존(`index.ts:88-95`). 정식 상태전이는 **F1 신설**(§A.4).

## A.4 커버리지 manifest (F1)
- **accepted**(이식): health/diagnostics/device 표면 · degradation 감지(connected:bool) · 승인 전체 흐름(요청·tier·modal·응답·영구grant·correlation toolCallId).
- **new-requirement**(baseline 부분/부재 → F1 신설): **정직 degradation 보고**(key-presence vs connection-state 통합) · **context-identity digest 결속 + 행위스코프 + pre-exec drift block**(FR-F1.4; baseline=toolCallId만, sessionId 미탑재) · **명시적 `expired`(만료) + `duplicate`(중복) 상태전이**(baseline=timeout→reject 붕괴, dup 미분기) · **contamination 격리**(FR-F1.3).
- **deferred**: lease 전체(FR-F1.4 subset 만) · SafetyPort e-stop(F-후속) · always-grant 정책(D40 Phase5).
- 미분류 = 0.

---

# §B. 포트 계약 (헥사고날 매핑)

## B.1 domain/ (순수, import 0)

| 값객체 | 규칙(불변식) |
|---|---|
| `SystemStatus` | 구성요소 상태 집계값(agent-liveness·gateway·provider). 순수 값. |
| `DegradationSignal` | **`{configured: bool, reachable: bool}`** — *key-presence 와 connection-state 분리*. `degraded = configured && !reachable`(정직: 키 있어도 unreachable=degraded). **오보 금지의 핵심 규칙**(FR-F1.1). |
| `DeviceStatus` | device 종류·가용성(audio/permission). 순수 값. |
| `Tier` | `T0`(auto) \| `T1`·`T2`(approval) \| `T3`(**blocked/disallowed — 승인 불가, 차단**, R1). `needsApproval = tier ∈ {T1,T2}`; `isBlocked = tier == T3`. 미매핑→T2(보수적). |
| `AutoBypass` | tier와 무관히 **자동 승인되는 direct-tool 명시 집합**(`skill_voicewake`·`skill_tts` preview·`skill_config` models, §A.2). 순수 멤버십 규칙(gemini R2). |
| `ApprovalRequest` | `{tool, args, tier, toolCallId, sessionId}`. |
| `ContextIdentityDigest` | **결정적 digest** = {session id + canonical workspace root(symlink/mount/대소문자 정규화 or 안정 id) + active surface/panel(headless=null 허용) + 승인시점 config 버전 + client id}. 순수 계산(FR-F1.4). |
| `ActionScope` | `{target, op, body, env}` — 승인이 묶이는 구체 행위(FR-F1.4). |
| `ApprovalBinding` | `{correlationId, digest: ContextIdentityDigest, scope: ActionScope}`. **drift 판정 규칙**: 실행 *전* 현재 digest/scope ≠ 승인시점 → `block`(재승인, side-effect 없음). |
| `ApprovalDecision` | `once` \| `always`(D40: deferred 정책) \| `reject` \| **`expired`(timeout — F1 신설; baseline 은 timeout→reject 붕괴)** \| **`duplicate`(F1 신설; baseline 미분기)**. |

> domain 은 I/O·transport·storage 모름. canonicalize/도달성 probe 등 I/O 는 포트 뒤.

## B.2 ports/ (driven, domain 만 의존)

```
# ports/protocol — transport-neutral
SystemStatusReport = { components: [...], degradations: DegradationSignal[] }   # 정직 보고 payload
ApprovalRequestPayload / ApprovalResponsePayload = { ...DTO, wire-framing 누출 금지 }

# ports/
InteroceptivePort:                          # read-only 자기 관측 (FR-F1.1)
    systemStatus(): SystemStatus             # agent liveness·gateway·provider 집계
    diagnostics(): Diagnostic[]              # health + 로그 요약(byte-offset tailing 은 adapter)
    devices(): DeviceStatus[]                # audio/permission
    degradations(): DegradationSignal[]      # ⚠️ configured&&!reachable 정직 산출(probe=adapter, 판정=domain)
ApprovalPort:                               # 최소계약 선잠금 (FR-F1.2·1.4)
    classify(tool, args): Tier               # tool-tiers 매핑(T0 auto / T1·T2 approval / T3 blocked / 미매핑=T2)
    request(req: ApprovalRequest, binding: ApprovalBinding): ApprovalDecision
                                             # 부재·거부·**expired(만료)·duplicate(중복) = F1 신설 상태**. 결과에 binding 동봉
    isPreGranted(tool): bool                 # 영구 grant pre-check(allowedTools). ⚠️ always 정책=D40 deferred
PersistentGrantPort:                        # 영구 승인 저장(분리 — 정책 격리)
    isAllowed(tool): bool / add(tool): void  # config.allowedTools (D40 Phase5 거부 예정 = deferred 표기)
```

> ⚠️ degradation **probe**(provider 도달성 fetch)는 adapter, **degraded 판정**(configured&&!reachable)은 domain. 정직성 규칙이 I/O에 안 묻히게.

## B.3 app/control/ (포트 사용, 인지 0)

```
# ① 정직 자기상태 (FR-F1.1·F1.3)
StatusReporter:
  report():
    s = InteroceptivePort.systemStatus(); d = InteroceptivePort.degradations()
    return honest(s, d)   # ⚠️ key-presence 를 connection 으로 승격 금지(오보 금지)
  # FR-F1.3: 이 보고 실패/degradation 은 contain — planning/route/skill 입력으로 오염 전파 금지

# ② 승인 게이트 (FR-F1.2·F1.4)
ApprovalGate:
  gate(tool, args, ctx):
    tier = ApprovalPort.classify(tool, args)
    if tier == T3: return Blocked   # ⚠️ T3 = 차단(승인 불가, R1)
    if AutoBypass.contains(tool): return Approved(once)   # direct-tool 명시 예외(skill_voicewake·tts preview·config models, §A.2; gemini R2)
    if tier == T0 or PersistentGrantPort.isAllowed(tool): return Approved(once)   # T0/영구grant auto
    binding = ApprovalBinding{ correlationId, digest=ContextIdentityDigest(ctx), scope=ActionScope(tool,args,ctx) }
    decision = ApprovalPort.request(req, binding)        # 거부·만료·중복 처리
    # ⚠️ 실행 *직전* drift 재검사(FR-F1.4): 현재 digest/scope ≠ binding → block(재승인, side-effect 없음)
    return decision (+ binding 동행)
  # FR-F1.3: 승인 실패가 downstream(plan/route/skill) 오염 금지 — 실패는 격리된 negative 결과
```

> 실행 개시 *후* drift/uncertain = FR-F3.3(F3) 소관 — 여기선 **실행 전**만(block/재승인).

## B.4 adapters/ (Tauri/agent-wire, 스캐폴드 시 stub)

| 어댑터 | 포트 | 호출 |
|---|---|---|
| `TauriStatusAdapter` | InteroceptivePort | `gateway_health`·`skill_diagnostics`·`skill_system_status`·로그 byte-offset tailing |
| `TauriDeviceAdapter` | InteroceptivePort.devices | `list_audio_output_devices`·`browser_set_permission` |
| `ProviderProbeAdapter` | InteroceptivePort.degradations | `registry fetchModels`(connected) + provider 도달성 |
| `AgentWireApprovalAdapter` | ApprovalPort | `waitForApproval`/`sendApprovalResponse` via `send_to_agent_command`(timeout·tier) |
| `ConfigGrantAdapter` | PersistentGrantPort | `config.allowedTools`(isToolAllowed/addAllowedTool) |

> correlation·digest 계산은 domain/app; wire frame·timeout·serialization 은 adapter.

## B.5 composition/ — `src/main/composition/` 1곳 주입(F0 계약과 동일 단일 root).

## B.6 검증 매핑 (P02)
- **계약 테스트**: degradation 정직성(configured&&!reachable=degraded, key-presence≠connected) · 승인 상태전이(부재/거부/만료/중복) · **pre-exec drift→block**(digest/scope 불일치) · **contamination 격리**(상태/승인 실패가 planning 입력 오염 X). drift-gate.
- **라이브 trace**(루크): health poll·approval modal 왕복·tier·timeout 실측.
- ⚠️ 신설(정직 degradation·digest 결속·contamination 격리)은 baseline 부분/부재 → **요구사항 기반 신규 계약**(old 등가 아닌 *개선*; baseline 은 갭 기록).

## B.7 다음
F1 baseline+계약 2클린 리뷰(codex: baseline 충실·FR-F1 충족·의존성규칙·신설 표기 정직) → F2(관측)·F3(조작) 계약 → 툴체인 결정 → 스캐폴드.
