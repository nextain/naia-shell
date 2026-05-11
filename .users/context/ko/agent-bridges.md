# Agent Bridges (한국어)

[이슈 #272](https://github.com/nextain/naia-os/issues/272) reconcile 이후의
**shell ↔ naia-agent ↔ naia-memory** wire SoT.

> English mirror: [`agent-bridges.md`](../agent-bridges.md)
> AI 최적화 계약: [`.agents/context/agent-bridges.yaml`](../../../.agents/context/agent-bridges.yaml)

## 배경

`#201` 이 OpenClaw gateway daemon 을 제거한 이후, Tauri shell + 임베드된
naia-agent 프로세스 + naia-memory R4 는 stdio JSON 으로만 조정됩니다.
3개 bridge + 5개 strangler-fig provider 어댑터가 그 역할.

## 3개 bridge

### 1. Protocol bridge — `agent/src/protocol-bridge.ts`

StdioFrame v1 envelope 코덱. 단일 stdio reader 가 여러 request type 을 다룰
수 있도록 legacy flat JSON 을 typed envelope 로 wrap.

| 함수 | 용도 |
|------|------|
| `looksLikeFrame(line)` | JSON parse 전 빠른 prechecker |
| `unwrapFrame(line)` | envelope → `{ type, payload }` 또는 `null` |

**활성화**: 기본 off. `NAIA_PROTOCOL_ENVELOPE_ONLY=1` 이면 legacy flat
frame 모두 거부 — opt-in 전용 (shell 측이 envelope 전송 준비 후). Phase 5 가
shell 측 wire 담당.

### 2. Memory bridge — `agent/src/memory-bridge.ts`

naia-memory `MemorySystem` 을 wrap 해서 `@nextain/agent-types`
`MemoryProvider` 인터페이스로 노출하는 어댑터.

```ts
const memorySystem = buildMemorySystem();              // naia-memory 네이티브
const memoryProvider = createNaiaMemoryProvider(       // bridge wrap
  memorySystem,
  { defaultProject: "naia-os" }
);
```

| 연산 | bridge 동작 |
|------|------------|
| `encode` | `MemoryInput.context` (`Record<string,string>`) ↔ naia-memory `MemoryInput.context` (단일 문자열). `scoring` 키가 그 문자열로, `project/sessionId/activeFile` 은 `EncodingContext` 로. |
| `recall` | `MemoryHit[]` 반환 (facts + episodes 통합, 정규화 score 정렬, `topK` cap). |
| `sessionRecall` | naia-memory `MemorySystem.sessionRecall` 로 pass-through. |

**Paired lifecycle**. `memorySystem` 과 `memoryProvider` 둘 다 모듈 스코프
`let` binding. `handleAuthUpdate` 가 둘을 atomic 하게 재빌드해서 naia
embedding + fact extractor 가 새 key 를 즉시 적용:

```ts
const old = memorySystem;
memorySystem = buildMemorySystem();
memorySystem.startConsolidation();
memoryProvider = createNaiaMemoryProvider(memorySystem, { defaultProject: "naia-os" });
void old.close().catch((err) => console.error(`[agent:memory] ...`));
```

**Race 주의**: `auth_update` 중 mid-flight 인 fire-and-forget
`memoryProvider.encode(...)` 가 OLD `MemorySystem` 에 떨어질 수 있음. 에러는
이제 로깅됨 (silent 였음 — #272 adversarial F4 fix). 완전한 drain barrier 는
follow-up.

### 3. Approval bridge — `agent/src/approval-bridge.ts`

IPC approval broker. 현재 `agent/src/index.ts` 에서 `void approvalBridge;` 로
inert. Phase 5 Day 6.3 가 `pendingApprovals` Map + `waitForApproval` 패턴을
`approvalBridge.decide()` 로 교체. compile time presence 가 downstream 테스트
import surface 안정성 보장.

## 5개 strangler-fig provider adapter

네이티브 LLM provider 보존. 가족(family) 별로 parallel `@nextain/agent-providers`
어댑터 추가. 라우팅은 호출 당:

- `NEXTAIN_AGENT_PROVIDERS=1` → 모든 가족 external
- `NEXTAIN_<FAMILY>=1` → 해당 가족만 external
- unset → 네이티브 (0 위험 기본)
- Truthy 값: `1` / `true` / `yes` / `on` (대소문자 무관)

| 파일 | 범위 |
|------|------|
| `nextain-openai-adapter.ts` | OpenAI / Ollama / vLLM / xAI / zai (OpenAI-compat 가족) |
| `nextain-gemini-adapter.ts` | Google Gemini 풀 SDK (`thoughtSignature` parity) |
| `nextain-claude-cli-adapter.ts` | Claude Code CLI subprocess |
| `nextain-lab-proxy-adapter.ts` | Naia Lab Proxy SSE (chat completions) |
| `nextain-lab-proxy-live-adapter.ts` | Naia Lab Proxy WebSocket (Live API, `-live` 모델 suffix) |

### 탐지 헬퍼

`agent/src/providers/factory.ts` 에서 export — 테스트는 반드시 여기서 import
(regex 복사 금지):

- `isOmni(model)` — vllm-omni audio-inline 탐지
- `isLive(model)` — Lab-proxy `-live` suffix 탐지

**Omni 의도**: 오디오 포함 모델 (`gpt-4o`, `minicpm-o`, `qwen-vl-omni` …) 은
`NEXTAIN_VLLM=1` 이라도 네이티브 path 유지. #272 가 광범위 `/[-_]o\b/i`
fallback 제거 — `claude-opus-4-o`, `gemma-4-o` 오분류 원인.

## 인증 흐름

Agent 가 credential 소유. Shell 은 `auth_update` 1회만 전송, 매 request 마다
`naiaKey` 보내지 않음.

```ts
// shell 측
agent.write({ type: "auth_update", naiaKey: "gw-..." });

// agent 측 (factory.ts)
let _agentNaiaKey: string | undefined;
export function setAgentNaiaKey(key: string): void { _agentNaiaKey = key; }

// 매 request
export function buildProvider(config: ProviderConfig): LLMProvider {
  const naiaKey = _agentNaiaKey;
  if (naiaKey) return /* lab-proxy 라우팅 */;
  return /* 네이티브 또는 env-gated strangler-fig */;
}
```

테스트 규율: `beforeEach` 에 `setAgentNaiaKey("gw-...")` 로 seed,
`afterEach` 에서 clear. 제거된 `config.naiaKey` 필드는 함정 — 아직 그걸
넘기는 테스트는 silent 하게 fall-through path 를 탑니다.

## Vendored 패키지

| 파일 | 용도 |
|------|------|
| `agent/vendor/nextain-agent-protocol-0.1.0.tgz` | Envelope 프로토콜 contract |
| `agent/vendor/nextain-agent-providers-0.1.0.tgz` | Strangler-fig 어댑터 |
| `agent/vendor/nextain-agent-types-0.1.0.tgz` | `MemoryProvider` / `ApprovalRequest` / 등 |

vendored 인 이유: 내부 Nextain 패키지로 npm 공개 안됨. 업데이트:
tgz 교체 + `agent/package.json` 의 version pin 올림.

## 크로스-repo 의존성

| Repo | 필수 exports | Pin |
|------|------------|-----|
| `naia-memory` | `MemorySystem`, `LocalAdapter`, embedding providers, `buildLLMFactExtractor`, **`HeuristicContradictionFilter`** (#272 추가) | alpha-adk submodule |
| `naia-adk/packages/skills-builtin` | 전체 21-skill 카탈로그 (#273 으로 Phase 4.0 Day 3-7 완료) + `ALL_DESCRIPTORS` enum | file:path |
| `@nextain/agent-types` (vendored) | Bridge contract 타입 | `agent/vendor/` 내 tgz |

## 보류된 작업

- Phase 4.3 Day 6.2-6.4: 18-skill envelope wire, IpcApprovalBroker 직접 wire, `handleChatRequest` 분해 (1276 → ~300 LOC)
- Phase 4.4 Day 7.3: Claude-CLI Flatpak/Windows subprocess + partial-JSON
- `auth_update` drain barrier (현재 에러 로깅만; 완전 barrier 는 ref-counted op 필요)
- `approvalBridge` wire-in (현재 inert)
- `naia-adk/skills-builtin` 의 남은 9개 skill descriptor
