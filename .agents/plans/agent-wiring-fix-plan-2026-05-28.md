# naia-agent ↔ shell 수정 계획 v8 — 2026-05-28

**Predecessor**: `agent-wiring-diagnosis-2026-05-28.md`
**Cross-review history**:
- Round 1: 3 reviewers FOUND_ISSUES (11 findings) → v2
- Round 2: 3 reviewers FOUND_ISSUES (10 findings) → v3
- Round 3: Slop CLEAN; Platform + Reasoning FOUND_ISSUES → v4
- Round 4: Slop CLEAN; Platform + Reasoning FOUND_ISSUES → v5
- Round 5: Slop CLEAN (2nd); Platform CLEAN (1st); Reasoning FOUND_ISSUES (2 LOW) → v6
- Round 6: Slop CLEAN (3rd); Reasoning CLEAN (1st); Platform FOUND_ISSUES (1 LOW N6-1: toLLMMessage drops `toolCallId`) → v7
- Round 7: Platform CLEAN (2nd consecutive); Reasoning CLEAN (2nd consecutive); Slop FOUND_ISSUES (1 cite L55→L56 cacheBreakpoint) → v8
- Round 8: Platform CLEAN (3rd); Reasoning CLEAN (3rd); Slop CLEAN (1st post-reset). **UNANIMOUS CLEAN (1st round)** → 동일 v8 그대로 Round 9 진행
**Status**: Round 9 cross-review 진행. v8과 동일 (no changes). clean_rounds=2 spec 충족 위해 한 round 더 unanimous CLEAN 필요.

## A. v4 → v5 변경 (Round 4 findings 반영)

### A1 (R4 Reasoning MEDIUM upgrade from NEW-3): tool content block corruption 방지

**문제**: v4 A3의 history seed 변환은 모든 message content를 `String(m.content ?? "")`로
강제 변환. 하지만 assistant turn의 tool_use는 content가 `LLMContentBlock[]` (구조화된 배열).
`String(array)` 결과 = `"[object Object],[object Object]"`. 즉 tool-using conversation의
history seed가 **silent data corruption**.

또한 `role === "tool"` 메시지가 v4의 filter predicate에서 **silently dropped**. tool 응답
context loss.

**v6 fix — 정확한 LLMMessage 변환** ([packages/types/src/llm.ts:18,51](projects/naia-agent/packages/types/src/llm.ts:18) 검증된 타입에 정합):

`LLMRole = "system" | "user" | "assistant" | "tool"`, 단 `LLMMessage.role = Exclude<LLMRole, "system">` —
**system role은 LLMMessage에 들어갈 수 없음** (system prompt는 `LLMRequest.system` 별도 필드).
따라서 historySeed에서 system role 메시지는 drop해야 함 (v5 round 5 N5-1 finding).

```ts
import type { LLMMessage, LLMContentBlock } from "@nextain/agent-types";

// LLMMessage 정확한 변환 (v6 A1 — round 5 N5-1 반영)
function toLLMMessage(m: { role: unknown; content: unknown }): LLMMessage | null {
  const role = typeof m.role === "string" ? m.role : "";
  // LLMMessage.role excludes "system" — system은 LLMRequest.system에 별도 전달.
  // history seed에 system role 포함 시 type contract violation + 다운스트림 LLM provider
  // reject 가능. 명시적으로 drop.
  if (role !== "user" && role !== "assistant" && role !== "tool") {
    return null;
  }
  // content는 string 또는 LLMContentBlock[] 둘 다 valid (per LLMMessage type)
  let content: string | LLMContentBlock[];
  if (typeof m.content === "string") {
    content = m.content;
  } else if (Array.isArray(m.content)) {
    // Already a block array — preserve as-is (tool_use, tool_result, text 등).
    // shallow cast: 현재 architecture에서 wire format은 항상 typed blocks (Agent.#history
    // serialization에서 옴). element validation은 over-engineering.
    content = m.content as LLMContentBlock[];
  } else if (m.content == null) {
    content = "";
  } else {
    // Unknown shape — drop rather than risk corruption.
    return null;
  }
  const result: LLMMessage = { role: role as LLMMessage["role"], content };
  // v7 (round 6 N6-1): preserve optional toolCallId for tool role messages.
  // LLMMessage.toolCallId ([packages/types/src/llm.ts:54](projects/naia-agent/packages/types/src/llm.ts:54))
  // is required for OpenAI-compat providers (`tool_call_id` field in messages array)
  // to link tool results back to originating tool calls. Stripping it breaks
  // multi-turn tool-use history on OpenAI / GLM / vLLM. Anthropic uses
  // content-block-level ids so Anthropic-only deployments are unaffected, but
  // the lab gateway routes to multiple providers — preserve unconditionally.
  const tc = (m as { toolCallId?: unknown }).toolCallId;
  if (typeof tc === "string") {
    result.toolCallId = tc;
  }
  // cacheBreakpoint ([packages/types/src/llm.ts:55-56](projects/naia-agent/packages/types/src/llm.ts:56))
  // is optional. Preserve for prompt caching to function on history seed.
  const cb = (m as { cacheBreakpoint?: unknown }).cacheBreakpoint;
  if (typeof cb === "boolean") {
    result.cacheBreakpoint = cb;
  }
  return result;
}

// chat_request 안에서:
const historySeed: LLMMessage[] = (messages.slice(0, -1) as Array<{ role: unknown; content: unknown }>)
  .map(toLLMMessage)
  .filter((m): m is LLMMessage => m !== null);
```

**효과**:
- string content는 그대로 보존
- LLMContentBlock[] (tool_use/tool_result/text blocks)는 그대로 보존
- tool role 메시지 인정 + 보존
- 알 수 없는 shape는 drop (silent corruption 방지)

**Phase 1 SDK side**: `LLMMessage` 타입 시그니처 확인 필요. `agent.ts:177` `#history: LLMMessage[]`
의 타입을 따름. constructor seed가 같은 타입이라 push 안전.

**Phase 6 unit test 추가**:
- history seed에 tool_use block (object) 포함 → 그대로 보존 검증 (NOT stringified)
- tool role 메시지 포함 → 보존 검증

### A2 (R4 Platform + Reasoning LOW R4-1): L2460 stdin-close enumeration

v4 Phase 2 step 1 "기존 callers (set/get/delete) 업데이트"가 [bin/naia-agent.ts:2460](projects/naia-agent/bin/naia-agent.ts:2460)
의 stdin-close handler를 누락. TS 컴파일러가 catch하지만 plan의 enumeration 완전성 위해 명시.

**v5 Phase 2 step 1 update list (전체)**:

| 현재 line | 현재 코드 | v5 변환 |
|---|---|---|
| L1567 | `new Map<string, AbortController>()` | `new Map<string, { controller: AbortController; sessionId: string }>()` |
| L1910 | `activeStreams.set(requestId, controller)` | `activeStreams.set(requestId, { controller, sessionId })` |
| L1941 | `activeStreams.delete(requestId)` (early-exit) | 변경 없음 |
| L2036 | `activeStreams.delete(requestId)` (finally) | 변경 없음 |
| L2043 | `activeStreams.get(requestId)` + `ctrl.abort()` | `activeStreams.get(requestId)` + `entry.controller.abort()` |
| **L2460** | `for (const ctrl of activeStreams.values()) ctrl.abort()` | `for (const { controller } of activeStreams.values()) controller.abort()` |

L2460 stdin-close path는 daemon 종료 시점 cleanup. v5 변환 후 TS 검증 통과.

### A3 (R4 Slop-detector LOW): agent.ts close() line range 정정

v4: "agent.ts:466-469"
**실제**: close() body는 [agent.ts:465-468](projects/naia-agent/packages/core/src/agent.ts:465). L469는 blank.

**v5**: 인용 정정 to `agent.ts:465-468`.

### A4 (R4 Platform N4 PARTIAL): localSessionId 초기 store 값 확인 명시

v4 Phase 3의 `if (oldId) void sendSessionClose(oldId).catch(...)` 가드는 oldId가 falsy일 때만
skip. [chat.ts:73-87, 280-310](projects/naia-os/shell/src/stores/chat.ts:73) 의 store 초기값 확인:

**v5 추가 검증 step (Phase 3 시작 전)**:
1. `useChatStore` 초기 state에서 `localSessionId` 값 확인
2. 만약 cold-start에서 `generateLocalSessionId()` 호출로 즉시 set되어 있으면 (typical Zustand
   pattern), 첫 `newConversation` call에 `oldId`가 truthy → 첫 sendSessionClose가 무의미한
   sessionId로 호출됨
3. agent side의 `case "session_close"`에 `if (!cachedAgents.has(sessionId)) break` guard가
   이미 존재 (no-op on miss) → safe but wasted IPC

**v5 결정**: 그대로 진행. wasted IPC 1회는 cost 무시 가능. 다만 명시: 첫 `newConversation` 의
session_close는 미존재 session에 대한 호출 (safe no-op).

### A5 (R4 Reasoning F2-related minor): R4 Reasoning이 "outer IIFE abort" 표현이 미세하게
imprecise하다고 했으나, 실질적 동작은 정확. v5에서 추가 표현 정확화:

**v5 정확화 (A8 보강)**:
> AbortController.abort() 호출 시점 → outer IIFE의 `for await (const ev of agent.sendStream(prompt))`
> 루프가 매 yield 사이 [bin/naia-agent.ts:2015](projects/naia-agent/bin/naia-agent.ts:2015)의 `if (controller.signal.aborted) break`를
> 검사 → break.
>
> Agent 내부 `sendStream(userText, signal?)`의 signal 파라미터는 현재 bin에서 전달 안 함
> ([:2014](projects/naia-agent/bin/naia-agent.ts:2014)). 따라서 abort signal은 Agent loop에 propagate되지 않음. **outer
> consumer cooperatively abort**.
>
> LLM 네트워크 mid-stream (chunk 받는 중) instant abort 불가 — 다음 chunk 받고 yield하면
> 그때 break. typical streaming LLM은 chunk 간격 < 1초이지만 `thinking` block이 길면
> 수 초 지연 가능. acceptable for current scope; future: bin에서 sendStream에 signal 전달
> 옵션 추가 가능 (별도 follow-up).

## B. 최종 Phase 계획 (v5)

### Phase 1 — Agent SDK 변경 (`packages/core/src/agent.ts`)

1. `#system`의 `readonly` 제거 → mutable
2. `setSystemPrompt(s: string | undefined): void` 추가
3. `AgentOptions` interface에 `history?: LLMMessage[]` 추가
4. constructor에서 history seed + `#turnCount` seed (user role count)
5. (변경 없음) `clearHistory()` ([:242](projects/naia-agent/packages/core/src/agent.ts:242)), `replaceLlm()` ([:250](projects/naia-agent/packages/core/src/agent.ts:250))
6. `close()` ([:465-468](projects/naia-agent/packages/core/src/agent.ts:465)) — idempotent, sync. 변경 없음

**테스트**:
- `setSystemPrompt` 후 다음 `.stream()` 호출에 새 system
- constructor history seed: `#history.length === seed.length`, `#turnCount === user role count`
- mocked LLMClient `.stream()` 첫 호출의 `LLMRequest.messages.length` 검증
- **tool_use block content가 string으로 부패되지 않고 LLMContentBlock[] 그대로 보존** (v5 A1)
- **role: "tool" 메시지가 seed에서 보존** (v5 A1)
- 4 turn 후 `#turnCount === 4`

### Phase 2 — bin/naia-agent.ts: activeStreams 구조 확장 + helpers + cachedAgents

1. **activeStreams 구조 변경** ([:1567](projects/naia-agent/bin/naia-agent.ts:1567)):
   ```ts
   const activeStreams = new Map<string, { controller: AbortController; sessionId: string }>();
   ```

2. **6 call sites 모두 업데이트** (v5 A2 표):
   - L1567 declaration, L1910 set, L2043 get/abort, **L2460 stdin-close iteration**
   - L1941/L2036 delete는 변경 없음

3. **helper 함수**:
   ```ts
   function invalidateLlmCache(): void {
     cachedLlm = undefined;
     cachedLlmModel = undefined;
   }
   function abortStreamsForSession(sessionId: string): void {
     for (const [reqId, entry] of activeStreams) {
       if (entry.sessionId === sessionId) {
         entry.controller.abort();
         activeStreams.delete(reqId);
       }
     }
   }
   function toLLMMessage(m: { role: unknown; content: unknown }): LLMMessage | null {
     // v5 A1 — accurate conversion preserving block content + tool role
   }
   ```

4. **9 site에서 `cachedLlm = undefined` → `invalidateLlmCache()` 치환**:
   L1679, L1710, L1735, L1783, L1867, L1922, L2353, L2408, L2439.
   L1922는 의도적 asymmetry (model-change branch가 rebuild를 직접 처리) — comment로 명시.

5. **cachedAgents Map + evictLRU**:
   ```ts
   const MAX_CACHED_AGENTS = 8;  // JSDoc rationale: 1-3 typical + buffer (v3 A9)
   const cachedAgents = new Map<string, { agent: Agent; model: string | undefined;
     systemPrompt: string | undefined; lastUsedAt: number; }>();

   function evictLRU(): void {
     if (cachedAgents.size <= MAX_CACHED_AGENTS) return;
     // ... find oldest by lastUsedAt ...
     if (oldest) {
       const id = oldest[0];
       abortStreamsForSession(id);  // invariant: abort before close (v4 A2)
       cachedAgents.get(id)?.agent.close();
       cachedAgents.delete(id);
     }
   }
   ```

6. **case "chat_request" 재작성**:
   - sessionId 추출 (`typeof msg.sessionId === "string" ? msg.sessionId : "default"`)
   - history wire format → LLMMessage[] via `toLLMMessage` (v5 A1)
   - cachedAgents lookup
   - sysPrompt 변경: `cached.agent.setSystemPrompt(sysPrompt)`
   - model 변경: `invalidateLlmCache()` + `buildLLMClient(requestedModel)` + `cached.agent.replaceLlm(newLlm)`
   - cold-boot/miss: `new Agent({ host, systemPrompt, tierForTool, history: historySeed })`
   - **L2035 `agent.close()` 호출 삭제** (v3 A4) — Agent 인스턴스는 cachedAgents에서 LRU/session_close/logout 시점에만 close
   - finally에서 `activeStreams.delete(requestId)` 그대로

7. **case "session_close" 추가**:
   ```ts
   case "session_close": {
     const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : "";
     if (!sessionId) break;
     abortStreamsForSession(sessionId);
     const c = cachedAgents.get(sessionId);
     if (c) {
       c.agent.close();
       cachedAgents.delete(sessionId);
     }
     break;
   }
   ```

### Phase 3 — shell `newConversation()` + `sendSessionClose`

- `chat-service.ts`: `sendSessionClose(sessionId)` export
- `chat.ts:284 newConversation`:
  - Step 1: `const oldId = get().localSessionId` (set 전)
  - Step 2: `if (oldId) void sendSessionClose(oldId).catch(...)` (첫 호출은 wasted but safe — v5 A4)
  - Step 3: 기존 `set((state) => ({...}))` 그대로
- `import { sendSessionClose } from "../lib/chat-service"` 추가

### Phase 4 — `skill_inject` / `skill_revoke`

```ts
case "skill_inject":
case "skill_revoke": {
  // ... existing register/revoke ...
  // Global scope: abort ALL streams + close ALL cached agents (next chat_request rebuilds with fresh host.tools)
  for (const [, entry] of activeStreams) entry.controller.abort();
  activeStreams.clear();
  for (const [, c] of cachedAgents) c.agent.close();
  cachedAgents.clear();
  break;
}
```

### Phase 5 — `purgeUserScopedCaches()` helper

**v6 추가** (round 5 N5-2): `stdioMemorySystem.close()`가 hang 시 dispatcher block 위험 → 2초
timeout race로 보호.

```ts
async function purgeUserScopedCaches(): Promise<void> {
  for (const [, entry] of activeStreams) entry.controller.abort();
  activeStreams.clear();
  invalidateLlmCache();
  cachedMemory = null;
  if (stdioMemorySystem) {
    try {
      // 2-second timeout guard — close()가 hang하면 dispatcher가 영구 block되어
      // 후속 auth_query / chat_request 등 모든 IPC가 timeout. logout/factory_reset은
      // 사용자 명시 의도라 빠른 응답 우선; SQLite 미닫힘은 GC + process exit 시 cleanup.
      await Promise.race([
        stdioMemorySystem.close(),
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]);
    } catch { /* best-effort */ }
    stdioMemorySystem = null;
  }
  for (const [, c] of cachedAgents) c.agent.close();
  cachedAgents.clear();
  delete process.env.NAIA_ANYLLM_API_KEY;
}
```

호출: L1735 (auth_logout) + L2353 (factory_reset) → `await purgeUserScopedCaches()`.

### Phase 6 — 검증

**Unit tests** (`packages/core/src/__tests__/agent-history.test.ts` 신규):
- `setSystemPrompt` 후 다음 `.stream()`의 LLMRequest 첫 system 메시지가 새 값
- constructor history seed 후 `#history.length === seed.length`, `#turnCount === userCount`
- mocked `.stream()` (NOT `.complete()`) 호출의 messages.length 검증
- **history seed에 LLMContentBlock[] content (tool_use 등) 포함 시 그대로 보존 — string corruption 없음 (v5 A1)**
- **role: "tool" 메시지가 seed에서 drop되지 않고 보존 (v5 A1)**
- **role: "tool" 메시지의 `toolCallId` 필드 그대로 보존 — OpenAI-compat tool history multi-turn 동작 (v7 N6-1)**
- **`cacheBreakpoint` 필드 보존 — prompt caching seed에서도 동작 (v7 N6-1)**
- 4 turn 후 `#turnCount === 4`

**Integration tests** (bin/naia-agent.ts behaviour, mocked LLM):
- cachedAgents cold-boot seed 동작
- session_close → abortStreamsForSession + close + delete 시퀀스 확인
- evictLRU도 abort 우선 (spy로 검증)
- skill_inject → cachedAgents.clear() 동작
- Map iteration with delete (abortStreamsForSession) 안전성 (ECMAScript spec 기반 — separate test 불필요)

**stdio probe** (real LLM, dev gateway):
- chat 1 sessionId="s1" "내 이름은 Luke야"
- chat 2 sessionId="s1" "내 이름이 뭐야?" → "Luke" 포함 응답
- `session_close { sessionId: "s1" }`
- chat 3 sessionId="s1" "내 이름이 뭐야?" → 모름 답 (history reset 확인)

**Model swap probe**:
- chat 1 sessionId="s1" model A
- chat 2 sessionId="s1" model B → stderr `provider=naia model=A` → `provider=naia model=B`
- chat 2 응답이 chat 1 내용 인지 (replaceLlm으로 history 보존)

**Panel skill probe**:
- skill_inject 발사 → 다음 chat에서 LLMRequest.tools에 새 panel skill 포함

## C. 위험 + 트레이드오프 (v5)

| 변경 | 위험 | 완화 |
|---|---|---|
| Agent SDK 변경 | 다른 consumer 영향 | optional 추가만, 기본 동작 변경 없음 |
| activeStreams entry 구조 변경 | 6 call site 모두 update 필요 (L2460 포함) | TS compiler catch + v5 A2 enumeration 완전 |
| cachedAgents LRU max 8 | 8+ session 시 history loss | rationale 명시 (v3 A9). 1-3 typical |
| session_close partial deploy | shell 안 보내면 LRU만 의지 | 안전 |
| abort cooperative (LLM mid-stream instant 불가) | thinking block 길면 수초 지연 | acceptable for current scope. follow-up issue 가능 |
| L1922 cachedLlmModel asymmetric | code reading 시 confusing 가능 | comment 명시 (v4 A5) |
| history seed type conversion | 알 수 없는 shape는 drop (silent loss) | v6 A1: tool role + block content 모두 보존; system role + unknown shape만 drop (LLMMessage type contract 준수). v7: `toolCallId` + `cacheBreakpoint` optional 필드도 보존 |
| 첫 newConversation의 wasted session_close | agent side guard로 no-op | safe (v5 A4) |
| stdioMemorySystem.close() hang | dispatcher block → 모든 IPC timeout | v6 Phase 5: 2초 timeout race (logout 빠른 응답 우선, SQLite는 process exit 시 cleanup) |

## D. 배포 순서

```
1. Agent SDK 변경 (packages/core/src/agent.ts)
   ↓ pnpm build (packages/core)
2. bin/naia-agent.ts 변경
   ├─ activeStreams 구조 (L1567 + 6 callsite, L2460 포함)
   ├─ invalidateLlmCache + abortStreamsForSession + toLLMMessage helpers
   ├─ 9 site refactor + L1922 asymmetric comment
   ├─ cachedAgents Map + evictLRU (abort 우선)
   ├─ case "chat_request" 재작성 + L2035 close 삭제
   └─ case "session_close" 추가
   ↓ pnpm build (packages/runtime)
3. shell 변경
   ├─ chat-service.ts sendSessionClose export
   └─ chat.ts newConversation restructure + import
   ↓ Vite HMR
4. case "skill_inject" + "skill_revoke" — abort 우선 + cachedAgents clear
5. case "auth_logout" + "factory_reset" — await purgeUserScopedCaches()
6. 검증 (unit + integration + stdio probe)
```

각 Phase 후 vitest + probe.

## E. Round 5 cross-review 체크리스트

- Round 4 Reasoning MEDIUM (tool content corruption): v5 A1이 진짜 해결?
- Round 4 Platform/Reasoning LOW (L2460): v5 A2 enumeration table에 명시?
- Round 4 Slop LOW (line range 466→465-468): v5 A3 정정?
- Round 4 Platform N4 PARTIAL (first newConversation wasted call): v5 A4 명시 + safe 확인?
- v5에서 새로 도입한 `toLLMMessage` helper의 타입 정확성 (LLMMessage / LLMContentBlock import)
- 변경된 Phase 2 step 1 표가 완전한지 (6 call site 누락 없음)
