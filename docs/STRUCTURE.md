# naia-os 이식 구조 (1단계 산출물 — 구조 뼈대) v4

> 추적: L0 미션(naia-os 전체를 헥사고날 gRPC로 이식) / 진행 단계 **1**.
> 상태: **R1 적대 리뷰(codex·gemini) 반영 + Q1~Q4 전부 해소(voice=provider, voice-server=rejected, gateway grounding). R2 클린 확인 후 루크 최종 승인.** 승인 전 슬라이스 이식 금지.
> 범위 주의: 1단계 = *원칙 + 슬라이스 목록 + 레이어 규칙 + 경계 포트 + 이식 메커니즘*. **파일별 정밀 분류는 슬라이스 이식 시**(2~3단계).
> 작업장·이식 메커니즘 SoT = alpha-adk `.agents/progress/new-naia-transplant-workspace-2026-06-08.md`.

## v3 → v4 핵심 변경 — 변형이 아니라 이식

골격(레이어·슬라이스·경계 포트·계약)은 v3 유지. **바뀐 것은 두 가지뿐:**

- **담는 곳**: 깨진 기존 트리를 in-place 수정 ❌ → **template clean 베이스(이 프로젝트)에 이식** ✅. 게이트 0에서 green, 통과한 이식분만 받음(deny-by-default).
- **도달법**: 출처(frozen)에서 읽기 → `cleanse-scan` → 게이트 통과 → 이 프로젝트에 담기. (근거: template 존재목적 / 과거 false-success 교훈 / Caret-Cline 선례 — 작업장 SoT §1.)

## 핵심 원칙: 디렉터리 ≠ 레이어

출처 agent의 각 디렉터리는 **여러 레이어로 분화**된다. 슬라이스 = *관심사*, 레이어 분류는 이식할 때 파일 단위로.
```
gateway/   → types(ports) · tool-tiers(domain) · client(adapter) · tool-bridge(app)
providers/ → types·registry·factory(ports) · cost(domain) · 구현체(adapters)
index.ts   → transport(driving adapter) · chat-orch·tool-exec·approval·panel(app) · config(helpers)
```

## core / agent / shell 관계

- **경계 = shell ↔ agent *transport* ↔ core(use case).** "shell↔core 경계"라 부르지 않는다.
- **core(=이 프로젝트 src) 는 stdio JSON 을 직접 먹지 않는다** — `AppPort` 추상화 뒤에. ***transport-shaped(writeLine/parseRequest) 금지***. 그래야 4단계 gRPC 가 *adapter 교체만으로* 됨(core 상호작용 모델 불변).
- **AppPort = god-port 아님 (R1 codex HIGH 수정)**: 단일 거대 포트가 아니라 **구별된 semantic 서브포트의 묶음** — `ChatPort·ToolPort·ApprovalPort·PanelPort`. "AppPort"는 이들의 facade(조립 진입점)일 뿐, 각 서브포트가 독립 계약. 한 우산에 뭉치면 내부 전용 mini-protocol 로 굳어 gRPC 매핑이 깨짐.
- **이식판에서 "agent" 의 지위 변경**: v3 에선 agent 가 in-place 로 비워지며 transport host 로 잔존했다. 이식판에선 **출처 agent = frozen 읽기 전용**이고, transport/composition host 역할은 이 프로젝트의 `app` + driving adapter 가 처음부터 담당한다(좀비 thin re-export 불필요).
- **shell**: 외관 유지(75K, 리팩터 안 함). 이식 후반에 **verbatim 편입**(레이어 분해 대상 아님). 편입 형태 = `packages/shell`(R1 수렴).
- 범위: 출처 agent ~38K(218 ts) 대상, shell 외관 유지.

### voice = provider, shell = interface (루크 결정 2026-06-08)

- **음성은 별도 서버 슬라이스가 아니라 *provider***. omni/gemini-live/openai-realtime 은 OpenAI-Realtime 호환 ws 세션 = *일반 LLM 과 동일 성격*. → agent `providers/` 의 registry/factory 로 **통일**(LlmPort 계열, ws transport adapter). 모델 추가 = provider 등록.
- **현 위치 문제**: 음성 처리가 지금은 `shell/src/lib/voice/`(naia-omni·gemini-live·openai-realtime·vllm-omni 등 16파일)에 갇혀 provider 추상화 밖에 있음 → 이식 = **처리부를 shell → agent providers 로 이전**.
- **shell 잔류 = 인터페이스만**: 마이크 캡처(capture.rs)·오디오 재생(audio-queue)·ref 녹음·패널 = 인터페이스 driving adapter(core 슬라이스 아님).
- **설정 계층**: agent **기본설정**(ProviderConfig) + shell **확장설정**(디바이스·ref-audio·패널). agent default 위에 shell 확장.

## 헥사고날 레이어 (이 프로젝트 소스 루트)
```
domain/    순수 값객체·규칙 (import 0)
ports/     인터페이스(계약) — domain만
adapters/  포트 구현 — ports+domain   (driving adapter = transport: protocol/stdio 포함)
app/       use case orchestration — ports만 (※ shell 경계 자체가 아님; god-layer 금지)
```
의존성 규칙(dependency-cruiser): `adapters→ports→domain` · **`app→ports`(adapters 직접 import 금지)** · `driving(transport)→app` · orphan 0.
- **포트 방향은 관심사에 맞게 (R1 codex MED 수정)**: 이벤트 스트림이 *실제로 있는* 포트만 bidirectional(`invoke` + `subscribe/onEvent`, EventPort). 순수 요청/응답 포트는 `invoke`-only. 무차별 양방향 강제 = hollow event channel + transport 모양 역침투 → 금지.

## 슬라이스 (관심사 단위 = cut line, 12) — 출처 = old-naia-os/agent

| 슬라이스 | 출처 | 주 레이어(분화) | 포트 |
|---|---|---|---|
| llm | providers/* | ports(types·factory) + domain(cost) + adapters(구현) | LlmPort |
| voice (provider) | **shell/lib/voice→agent** (naia-omni·gemini-live·openai-realtime·vllm-omni) | providers 확장/분기(ws adapter) — 처리는 전부 agent | LlmPort 계열 |
| tts | tts/* | adapters | TtsPort |
| memory | memory-scrubber(domain) + (bridge) | adapters + domain | MemoryPort |
| skill | skills/built-in/*, loader | adapters(loader) + app(빌트인=gateway proxy 응용) | SkillPort |
| gateway | gateway/* | ports(types)+domain(tool-tiers)+adapters(client)+app(tool-bridge) | GatewayPort |
| mcp | mcp/* | adapters | McpPort |
| cron | cron/* | adapters + domain | CronPort |
| tasks | tasks/*(JobTracker) | domain(수명주기) + app | — |
| conversation | conversation/*(token-budget·context-limits) | domain | — |
| session | local-sessions(fs+path-resolver) | adapters(저장) + SessionPort | SessionPort |
| approval | index.ts 승인흐름, approval-bridge | app(+ApprovalPort) | ApprovalPort |
| transport/app-shell | index.ts(1384), protocol-bridge | driving adapter(transport) + app(chat-orch·tool-exec·panel) | **AppPort(semantic)** |

**이식 제외 (rejected)**: `voice-server/`(py minicpm-o 브리지) = 죽음 확정(증거 = 미해결 Q3). 커버리지 manifest `rejected`. · 음성 *인터페이스*(마이크 캡처·재생·ref녹음) = shell 잔류(core 슬라이스 아님).

## 경계 계약 (boundary contract — 1단계에 못 박음, 미정 아님)

> ⚠️ R1 리뷰 수정(codex·gemini 수렴, HIGH): 계약 소유권이 transport(adapter)에 있으면 의존성 역전(DIP)이 깨지고 계약 SoT가 둘이 된다. 아래로 교정.

- **두 계약을 레이어로 분리, 단일 의존 방향**:
  - `ports/protocol` = **외부 wire DTO**(shell↔agent 직렬화 형태). **ports 레이어 소유**(adapter 아님). transport adapter 는 이를 *import 만* 한다.
  - `AppPort` = **내부 semantic 유스케이스 포트**(아래). ports 레이어 소유.
  - **매핑 규칙**: transport(driving adapter)가 `protocol` DTO ↔ `AppPort` 호출을 **번역**한다. 의존 = `transport(adapter) → ports(protocol, AppPort)`. core/app 은 wire DTO 를 절대 모른다.
- `protocol-bridge.ts` / `approval-bridge.ts` = 각 슬라이스의 driving/경계 **adapter**(계약 소유 아님, 위 ports 계약을 구현/번역).
- 효과: wire 포맷(stdio→gRPC) 교체 = transport adapter 만 교체, ports·core 불변. 계약 SoT 충돌 제거.

## 이식 메커니즘 (deny-by-default, 슬라이스 단위)

각 슬라이스마다:
1. **출처(frozen)에서 읽기** — old 트리 수정 0.
2. **소스 인벤토리 작성 (R1 codex HIGH 수정 — false-success 방지 핵심)**: 출처 슬라이스의 export·심볼·동작을 열거 → 각 항목 `accepted | deferred | rejected(+사유)` 로 분류한 **커버리지 manifest**. 게이트는 "들어온 것의 정합"뿐 아니라 **"인벤토리 100% 처분됨(미분류 0)"**을 강제 → 일부만 옮기고 green 나는 것 차단.
3. `scripts/cleanse-scan.mjs` 로 군더더기·죽은코드 식별.
4. 헥사고날 레이어로 분해 → 이 프로젝트에 **이식**.
5. `scripts/conform/manifest.json` 에 계약↔코드 region 등록(빈 manifest=inert 에서 채워감).
6. 계약 테스트(port) + 통합 테스트(app) 작성·통과.
7. **conform 게이트 + 커버리지 manifest(미분류 0) 통과해야** commit(3회 연속 드리프트면 차단).
8. 이식하며 얻은 **일반화 패턴만** template 로 환류. **"Template Reusable Unit" 판정 (R1 gemini MED 수정)**: naia-os 전용 식별자·도메인 결합이 없는지 검증 통과분만 환류(template 오염 방지).

## 테스트 구분 (완료조건)
- **계약 테스트** = port 인터페이스(모든 어댑터 만족) / **통합 테스트** = app 오케스트레이션.
- 슬라이스 이관 완료조건 = 출처 테스트 → (해당) 계약/통합 테스트 전환 + 통과.

## composition root (R1 gemini HIGH 수정 — 단일 root 강제)
- 와이어링은 **`src/composition/`(또는 `src/main.ts`) 1곳에만**. src/ 전역으로 분산 금지(헥사고날 '단일 구성' 이점 상실).
- 각 슬라이스는 와이어링 로직을 노출하지 않고 **Factory/Registry 포트만** 노출 → composition root 가 그것들을 주입.
- 의존: driving adapter 진입 → app use case 호출 → ports 통해 adapters 주입.

## 미해결 → R1 리뷰 결과 (codex·gemini)

- **Q2 shell 편입 = 해소(수렴)**: `pnpm workspace + packages/shell` verbatim. (양 AI 동의: "외관 유지" + 통합 빌드 + 4단계 프로세스 분리 선제.)
- **Q4 standalone naia-agent = 해소(수렴)**: 4단계까지 동결, agent 는 이 프로젝트 `src/` 내부 슬라이스로 유지(Port/Adapter 분리 연습장). repo 경계는 1단계 밖.
- **Q1 소스 루트 배치 = 경미**: codex `src/main` 권고(template churn 최소) vs gemini `src/` flat(domain/ports/adapters/app) 권고. 둘 다 `packages/core` 조기분할은 반대. → **잠정 `src/` flat 레이어 + `src/test` 유지**, template `src/main` 규약과의 정합은 이식 착수 시 확정. (저위험)
- **Q3 = 해소(grounding 으로 가짜 이분법 분해, 루크 결정 2026-06-08)**:
  - **voice-server (py minicpm-o) = 죽음 확정 → `rejected`(미이식)**. 증거: 라이브 참조 0(테스트 fixture 문자열·문서뿐), `:8765` 참조 0, 빌드/기동 스크립트 0, 마지막 손댐 2026-03-30 #177(음성 아닌 base 이미지 부수). 현 라이브 음성 = 외부 vLLM/gateway realtime.
  - **voice 처리 = agent provider 확장/분기**: omni/gemini-live/openai-realtime = 일반 LLM 동격(ws). 마이크 의존이라 *인터페이스*는 shell(UI)이나 *내부 처리는 전부 agent 가 관리* = agent providers 의 확장/분기(LlmPort 계열). shell→agent 이전.
  - **원격 naia gateway service = 외부 capability**(`GatewayPort` + client adapter, 원래 외부). **naia-os/gateway 채널어댑터(Discord·GoogleChat) = 라이브러리**. 우리 서비스 **프로세스 토폴로지 = 4단계**.

## 슬라이스 리뷰 메모 (R1 MED, 이식 시 유의)
- `tasks`·`conversation` 은 현재 포트 없음(domain/app 내부) — persistence/scheduler/telemetry 와 닿는 순간 포트 신설(경계 지연 시 app 응집도 붕괴).
- `skill` = "builtin=gateway proxy 응용"이라 skill 정책 ↔ gateway 호출 책임선이 흐려질 수 있음 → 이식 시 `SkillPort`/`GatewayPort` 경계 명확화.

## 다음 (2단계)
구조 승인 후 → 사용자 시나리오 분류 리스트 + glossary(G1, 가장 강한 휴먼 게이트). 시나리오가 위 슬라이스를 어떻게 관통하는지로 첫 vertical(5단계) 선정.
