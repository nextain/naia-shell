# 조립 매트릭스 (assembly matrix) — 이식·보충·수직·수평 동시 추적 SoT (2026-06-10)

> **목적 = drift/드롭 방지 anchor.** "한쪽(UC 수직 / gRPC 수평 / 이식 / 보충)을 강조하면 다른 쪽을 잊는" 실패모드를, *모든 축을 한 표에 박아 미분류 0 강제*로 막는다. 어느 칸을 작업해도 나머지 칸이 안 사라진다.
> SoT 연결: 진실의 출처 = **사용자 시나리오(UC)**(옛 동작은 *맞던 곳에서만* 참조). cf [[project_naia_os_brain_body_os_thesis]], `00-PHASES.md`.

## 축 (직교 — 둘 다 지킴)
- **수직 = UC(시나리오)** : UC1, UC2… 사용자 기능 흐름.
- **수평 = gRPC 중심 배선** : `protocol(transport-neutral) → AppPort(ChatPort+ToolPort) → transport 어댑터(stdio→gRPC) ↔ agent`. **경계(brain↔body↔env) 생성·다중 클라이언트·다중 UC 공통.** UC는 이 위를 *타고* 돌지, 우회 금지.
- **이식 vs 보충** : `이식`=옛것이 맞게 돌던 것 그대로 / `보충`=없거나 깨졌던 것(agent↔os) UC에 맞춰 빌드.
- **권위** : `old-auth`=옛 *관측 행동*이 기준(단 구조는 인지 포트로 재표현) / `scenario-auth`=UC가 기준(옛것과 달라도 됨).
- **인지 포트 매핑 + fit** : ⚠️ 수평은 *인지관점으로 재배선*됨(old 기능묶음 아님) → old UC 수직이 1:1 안 맞을 수 있음. 각 조각이 *어느 인지 포트*로 가는지 + `fit`(clean/​**mismatch**/​미평가). **mismatch = 숨김 없이 1급 표면화** → (a)UC를 인지흐름으로 재매핑 or (b)수평 갭 재검토. 억지 우김·직결 금지.

인지 포트 범례: SensoryPort(감각) · InteroceptivePort(내수용) · ChatPort(대화 ingress) · ExpressionPort(표현, embodiment-neutral) · EnvironmentPort(관측/행위) · ApprovalPort/SafetyPort(control) — glossary 참조.

---

## 수평 배선 트랙 (모든 UC 공통 — 별도 추적, UC 작업 시 *안 잊기*)
| # | 수평 조각 | old 존재 | 이식/보충 | 인지/포트 | fit | 권위 | 상태 |
|---|---|---|---|---|---|---|---|
| H1 | `protocol` (transport-neutral DTO; Chat payload 포함) | △ (stdio frame 산재) | 보충(정리) | ports/protocol | 미평가 | scenario-auth | F0 일부 동결·Chat DTO 신설 필요 |
| H2 | `AppPort`(=ChatPort+ToolPort 조립 facade) | △ (직접 호출 산재) | 보충 | ChatPort·ToolPort | 미평가 | scenario-auth | 계약(glossary)·코드 X |
| H3 | transport 어댑터 (stdio now → gRPC 목표) | O (`send_to_agent_command` stdio) | 이식+보충 | (transport) | 미평가 | old-auth(stdio)/scenario(gRPC) | stdio 이식 가능·gRPC=어댑터 교체 |
| H4 | agent(brain) ↔ os 연결 | **△ 제대로 연결된 적 없음** | **보충** | (AppPort 경유) | **미평가(핵심 리스크)** | **scenario-auth** | UC에 맞춰 설계 = 이식 아님 |

> ⚠️ H4 = 루크 지적의 핵심. "옛것과 같게"가 목표가 아님(연결된 적 없으니). UC1이 이 수평을 *처음 깔며* 검증한다.

---

## 수직 UC 트랙

### UC1 — 텍스트 대화 (ChatPanel 입력→응답)
> 흐름: **Chat(ingress) → 사고(llm/agent=brain) → 표현(speech-intent)**. 포트: ChatPort·llm·ExpressionPort.
> ⚠️ 이식 조각도 *인지 포트로 재표현*(old 직결 들어올리기 X). 사고 부분 = H4(agent 연결) 위에서 돎.

| # | 조각(S) | old 존재 | 이식/보충 | 인지 포트 매핑 | fit | 권위 | 상태 |
|---|---|---|---|---|---|---|---|
| U1.1 | 채팅 입력 UI (S13 ChatPanel 입력) | O (shell) | 이식 | **ChatPort**(ingress) | 미평가 | old-auth(UI) | pending |
| U1.2 | LLM 사고/추론 | △ (agent 미연결) | **보충** | agent(brain) via **AppPort/ChatPort**(H2/H4) | 미평가 | **scenario-auth** | pending — H4 의존 |
| U1.3 | 응답 표시/말하기 의도 (S13 출력) | △ (부분) | 이식+보충 | **ExpressionPort**(speech-intent, embodiment-neutral) | 미평가 | mixed | pending |
| U1.4 | @멘션 파일/폴더 선택 (S62) | O (shell) | 이식 | ChatPort + **EnvironmentPort**(workspace 관측) | 미평가 | old-auth | pending |
| U1.5 | 파일 deeplink (S70) | O (shell) | 이식 | ChatPort + EnvironmentPort(F2) | 미평가 | old-auth | pending |
| U1.6 | provider 설정 (S03, UC12 겹침) | O | 이식 | control-plane/config (F0 인접) | clean(F0) | old-auth | F0 계약 인접 |

**UC1 착수 순서 (직교 지키며):**
1. **수평 먼저**: H1·H2·H3·**H4(agent 연결)** 한 칸 — ChatPort/protocol/transport로 agent↔os를 *제대로* 깐다(보충, scenario-auth).
2. **수직 UC1**: U1.1→U1.2→U1.3 을 그 수평 위에 *재표현*으로 엮어 end-to-end 채팅(가시성).
3. 엮다 **mismatch 나오면 표면화**(인지 재매핑 or 수평 갭) — 우김/직결 금지.
4. U1.4~U1.6 부가.

> 검증: U1.1/U1.4/U1.5(old-auth) = 옛 *관측 행동* 등가(구조는 인지 포트). U1.2/H4(scenario-auth) = UC1 충족으로 검증(옛것 따라하기 아님).

---

## 다음 UC (자리만 — 안 잊기)
UC11 자기상태(F1 인접 — InteroceptivePort 이미 계약/코드), UC13 승인(F1 ApprovalPort), UC7 시스템 관측/조작(F2/F3), UC2 음성(SensoryPort, 외부키), UC10 채널(gateway, S36 discord 깨짐), UC12 온보딩(F0 인접)… → UC1 수평 깔고 나면 같은 수평 위에 수직만 추가.

> **갱신 규칙**: 조각 작업 시 이 표의 상태/fit 갱신. mismatch 발견 = 즉시 기록 + 처리경로(재매핑/수평재검토) 명시. 미분류 0 유지.
