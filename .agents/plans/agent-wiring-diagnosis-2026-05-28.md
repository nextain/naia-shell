# naia-agent ↔ shell 연결 진단 + 수정 계획 — 2026-05-28

**Author**: claude (Opus 4.7)
**Scope**: bin/naia-agent.ts의 chat_request handler가 naia-agent SDK(packages/core/Agent)와
어떻게 연결되는지 검토. multi-turn / model swap / panel skills / system prompt 등 wiring
누락 + cache invalidate 패턴 누락을 전수 조사.
**User report**: "naia-agent 자체에서 원래 멀티턴 대화를 지원하는데 이와 연결 안되고
단일 턴 연결한거 아닌지" — 정확한 가설.

## 1. naia-agent SDK 자체 능력 (packages/core/src/agent.ts)

`Agent` 클래스 ([packages/core/src/agent.ts:174](projects/naia-agent/packages/core/src/agent.ts:174)):

| 멤버 | 역할 |
|---|---|
| `#history: LLMMessage[]` | **internal multi-turn 보존**. 매 sendStream() 호출 시 user/assistant turn 추가 |
| `#session: Session` | sessionId 발급 + 상태 (active/ended/closed) |
| `#priorRecap` | compaction recap (anchored iterative summarization, #47) |
| `#turnCount` | turn 카운터 (handoff trigger용, #50) |
| `clearHistory()` | history 명시적 초기화 |
| `replaceLlm(llm)` | **LLM 교체 — agent 재생성 없이 모델 swap 가능** |
| `sendStream(userText, signal?)` | 한 turn 처리. history에 user push → LLM 호출 → assistant text + tool calls → history에 push |

즉 Agent SDK는 multi-turn / model swap / session lifecycle 모두 first-class 지원.

## 2. bin/naia-agent.ts 연결 패턴 (현재 상태)

[case "chat_request" (≈L1863-2040)](projects/naia-agent/bin/naia-agent.ts:1863):

```ts
case "chat_request": {
  const messages = msg.messages;           // shell이 보낸 전체 history
  const sysPrompt = msg.systemPrompt;
  const requestedModel = msg.provider?.model;

  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const prompt = lastUser.content;          // ← messages에서 LAST USER만 추출

  void (async () => {
    // ... cachedLlm rebuild on model change ...
    const llm = cachedLlm;

    // 매 chat_request마다 새 Agent 생성 — #history 매번 빈 배열!
    const agent = new Agent({ host, systemPrompt: sysPrompt, tierForTool });

    for await (const ev of agent.sendStream(prompt)) {  // ← prompt(string) only
      // text/finish/error emit
    }
    agent.close();   // ← session 종료
  })();
}
```

요약: shell은 multi-turn API로 보내지만 (`messages: [...history, { user }]` + `sessionId`),
bin은 **single-turn API로 변환**해서 Agent SDK에 넘김. Agent의 multi-turn 기능 0% 사용.

## 3. 문제 리스트 (P0 → P3)

### P0 — Multi-turn 대화가 작동하지 않음

**증상**: 사용자가 "확실해?" / "모델 뭐야?" 등 follow-up 보내도 이전 turn 기억 못 함.

**원인 chain**:
1. shell이 `{ sessionId, messages: [...history, user] }` 보냄
2. bin이 `sessionId` 무시 — chat_request handler 어디서도 추출 안 함
3. bin이 `messages`에서 `lastUser`만 추출하고 history 전부 폐기
4. 매 chat_request마다 `new Agent({...})` → Agent 내부 `#history` 매번 빈 배열
5. 같은 Agent 인스턴스로 두 번째 turn 호출이 일어나지 않음
6. agent.close()가 session.state를 "ended"로 전환

**진짜 multi-turn 동작했다면** shell이 history를 굳이 매번 보낼 필요 없음 (`#history`가 다 갖고 있음). 현재는 그것이 broken.

**증거**: `agent.session` getter, `clearHistory()`, `replaceLlm()` 모두 멀티-call 보존 의도.

### P0 — Settings 모델 변경이 LLM 호출에 반영 안 됨

**증상**: Settings에서 모델 Gemini Pro→Flash→Flash Live 바꿔도 응답은 같은 모델("Claude 3.5 Sonnet"이라고 자기소개 — 환각).

**상태**: Fix 21로 부분 해결 (`cachedLlmModel` 추적 + 변경 시 `cachedLlm = undefined` + `buildLLMClient(requestedModel)`). 다만 매 chat마다 새 Agent를 만드는 한, `replaceLlm()`도 의미 없음 (새 Agent는 새 LLM으로 만들어지니까).

### P1 — System prompt 변경 wiring 누락

**증상**: shell이 매 chat_request에 새 systemPrompt 보내지만, 같은 Agent 인스턴스를 재사용해도
`Agent.constructor`만 sysPrompt를 set하고 setter 없음 (`#system` private + readonly 패턴).

**P0 multi-turn fix와 연결**: Agent 인스턴스를 cache하면 sysPrompt 갱신 메커니즘 필요.
Option A: `setSystemPrompt(s)` 메서드 추가. Option B: sysPrompt 변경 시 Agent 재생성 (history는
별도 보존 + `replaceHistory`로 복원).

### P1 — Panel skills inject 후 tool list 정합성

**증상**: Panel이 열리면 `skill_inject`로 `hostInjectedDefs`에 등록. 그러나 `cachedLlm`은
이전 baseTools만 알고 있음. LLM 입장에서는 panel skills를 모름.

**현재 코드** ([≈L1955](projects/naia-agent/bin/naia-agent.ts:1955)):
```ts
const tools = hostInjectedDefs.length > 0
  ? new CompositeToolExecutor({ subs: [{ id: "builtins", executor: baseTools }, { id: "host", executor: hostToolExecutor }] })
  : baseTools;
```
tools는 매 chat마다 새로 빌드되지만 — agent.sendStream()이 LLM 호출 시 tool list가 LLM에
어떻게 전달되는지 확인 필요. 만약 `cachedLlm`이 tool list를 알고 있다면 stale.

사용자 증상 "스킬 사용도 제대로 하는지 모르겠고" + agent timeout 다수 = 이 path가 의심.

### P1 — `cachedMemory` invalidate 누락

[L1585](projects/naia-agent/bin/naia-agent.ts:1585): `let cachedMemory: InMemoryMemory | null = null;`
+ [L1958](projects/naia-agent/bin/naia-agent.ts:1958): `if (!cachedMemory) cachedMemory = new InMemoryMemory();`

invalidate 호출 어디에도 없음. mode 변경, user 변경, session reset 등 시 stale.
auth_changed (`logged_out` → 다시 `logged_in` with different user)에서 invalidate 필요.

### P2 — `stdioMemorySystem` (SQLite) invalidate 없음

L1587. 한 번 set되면 평생. ADK path 변경 시 stale.

### P2 — `hostInjectedDefs` lifecycle

panel close 시 `skill_revoke`로 제거됨. OK. 다만 panel re-open 시 cachedLlm 무효화 안 일어남
→ LLM이 옛 tool list로 호출 → mismatch 시 정의 안 된 tool error.

### P3 — `panelSkillsByPanel` Map의 panel id 충돌

L1567. panel id 기준. panel reload 시 같은 id로 덮어쓰지만 cleanup 누락 가능.

## 4. 패턴 — "cache one, swap parts"

전체적으로 invalidate 패턴이 일관되지 않음:

| 캐시 | invalidate 호출 위치 | 일관성 |
|---|---|---|
| `cachedLlm` | auth_received, auth_logout, auth_legacy_migrate, creds_update, chat_request(model change) — 5곳 | ✓ 잘 됨 |
| `cachedLlmModel` | cachedLlm과 짝 — chat_request에서만 set | ✓ 짝 유지 |
| `cachedMemory` | **invalidate 호출 0곳** | ✗ |
| `stdioMemorySystem` | **invalidate 호출 0곳** | ✗ |
| `hostInjectedDefs` | skill_revoke로 제거. 단 cachedLlm 무효화는 없음 | ⚠ partial |
| `pendingApprovals` | timeout 또는 응답 도착 시 delete | ✓ |
| `pendingToolCalls` | timeout 또는 응답 도착 시 delete | ✓ |
| `activeStreams` | finish/error/cancel/timeout 시 delete | ✓ |
| Agent 인스턴스 | **매 chat_request마다 new** — cache 자체가 없음 | ✗ multi-turn 깨짐 |

## 5. 수정 계획

### Phase 1 — Agent 인스턴스를 sessionId별로 cache (P0 multi-turn fix)

```ts
// 모듈 스코프
const cachedAgents = new Map<string, { agent: Agent; model: string | undefined; systemPrompt: string | undefined }>();

case "chat_request": {
  const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : "default";
  // ... model swap detection ...
  let cached = cachedAgents.get(sessionId);
  const sysPromptChanged = cached && cached.systemPrompt !== sysPrompt;
  const modelChanged = cached && cached.model !== requestedModel;

  if (cached && (sysPromptChanged || modelChanged)) {
    // SDK가 setSystemPrompt를 지원 안 하면 history 보존 후 재생성
    cached.agent.close();
    cachedAgents.delete(sessionId);
    cached = undefined;
  }
  if (!cached) {
    const agent = new Agent({ host, systemPrompt: sysPrompt, tierForTool });
    cached = { agent, model: requestedModel, systemPrompt: sysPrompt };
    cachedAgents.set(sessionId, cached);
  }

  for await (const ev of cached.agent.sendStream(prompt)) {
    // ... emit ...
  }
  // close()는 session reset 시에만 — 매 turn 아님
}
```

추가 작업:
- `session_reset` IPC (이미 존재할 수도) 시 cachedAgents.get(sessionId)?.close() + delete
- 메모리 누수 방지: LRU 또는 max session count
- skill_revoke / skill_inject 시 영향 받는 모든 cached agent 무효화

### Phase 2 — Agent SDK `setSystemPrompt` 추가 검토

`#system`이 readonly로 선언됨. 변경하려면:
- Option A: `setSystemPrompt(s)` 메서드 추가 — Agent 내부 `#history`는 보존 + 다음 turn에 새 sysPrompt 적용
- Option B: 외부에서 close + new Agent + replay history — agent.ts 변경 없이 가능

Option B가 invasive하지 않음. 다만 replay 비용. 거의 없는 경우 sysPrompt 변경 시 acceptable.

### Phase 3 — cachedMemory + stdioMemorySystem invalidate

`auth_changed { loggedIn:false }` 또는 `auth_logout` 또는 user change 시 두 캐시 모두 reset.

```ts
case "auth_logout": {
  // ... existing ...
  cachedMemory = null;
  if (stdioMemorySystem) { await stdioMemorySystem.close().catch(() => {}); stdioMemorySystem = null; }
}
```

### Phase 4 — Panel skill 변경 시 cachedLlm 무효화

```ts
case "skill_inject":
case "skill_revoke": {
  // ... existing register/unregister ...
  cachedLlm = undefined;          // tool list 바뀌었으니 LLM 재빌드
  // cachedAgents도 영향 — 모두 close + Map.clear() (또는 lazy 재생성)
  for (const [_, c] of cachedAgents) c.agent.close();
  cachedAgents.clear();
}
```

### Phase 5 — chat_request에서 `prompt` 추출 제거

Phase 1 fix가 끝나면 `lastUser.content` 추출 자체가 의미 없음. 그냥
`const userText = messages.at(-1)?.content` 정도로 단순화. 단 messages가 빈 배열이면 error.

또는 shell이 last user를 별도 필드로 보내고 (`lastUser` 또는 `userText`), agent는 그것만
취급. messages 자체는 history seed 용도로만 (cold-boot 또는 session resume).

### Phase 6 — 회귀 테스트

- bin/naia-agent.ts에는 단위 테스트 없음 (벡터 tests는 packages/runtime에만). multi-turn 검증은
  stdio probe로:
  - chat_request 1: "내 이름은 Luke야"
  - chat_request 2: "내 이름이 뭐야?" → "Luke" 답이 나와야
- model swap probe (이미 작성된 코드):
  - chat 1: gemini-2.5-pro
  - chat 2: gemini-2.5-flash → 다른 모델 응답
- panel skill probe:
  - skill_inject 후 chat에서 LLM이 그 tool 호출 가능

## 6. 위험 + 트레이드오프

| 변경 | 위험 |
|---|---|
| sessionId별 Agent cache | 메모리 누수 (사용자가 세션 reset 없이 매번 새 sessionId 보내면) → LRU 또는 max-N |
| sysPrompt 변경 시 Agent 재생성 | history loss. 해결: 외부에서 history 보존 + Agent.replaceHistory (SDK 추가 필요) |
| cachedLlm 무효화 추가 | 빈번한 rebuild — LLM 빌드는 cheap (instance만, network 없음). 무시 |
| Panel skill 변경 시 모든 cachedAgents close | 진행 중 turn 끊김. 해결: 현재 turn finish 후 close |

## 7. 다음 단계 — Cross-review 후 진행

이 문서를 다른 AI 리뷰어들에게 보내 검증:
- 진단의 사실 검증 (file:line 인용 정확한지)
- 수정 계획의 logical chain 검증 (Phase 1 fix가 진짜 multi-turn 살리는지)
- 누락된 패턴 추가 발견
- 위험 평가

Cross-review 결과 반영 후 Phase 1부터 순차 적용.
