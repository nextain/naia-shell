# shell ↔ external naia-agent Protocol v1 (Phase 4.1 Day 0.5.3)

> **status**: draft (Day 0.5.3, P0-1 spec 작업)
> **상위**: `.agents/progress/r4-phase4-naia-os-wire-spec.md` Day 0.5.3
> **decision**: D39 IPC protocol version + capability negotiation

---

## 1. Transport

- **stdio** (JSON lines, 1 message per line, `\n` delimited)
- shell (Tauri Rust) spawns external naia-agent (Node.js child process)
- shell.stdin.write — shell → agent
- shell.stdout.read — agent → shell
- shell.stderr — agent diagnostic logs (redacted, secret patterns scrubbed)

## 2. Handshake (D39)

**shell → agent** (initial):
```json
{ "type": "handshake", "protocolVersion": 1, "shellCapabilities": ["approval_modal", "panel_skills"] }
```

**agent → shell** (response):
```json
{ "type": "handshake_ack", "protocolVersion": 1, "agentCapabilities": ["llm_chat", "tool_execution", "approval_request"] }
```

protocolVersion mismatch → agent stderr log + exit 3 (handshake failed).

## 3. Message types (Phase 4.1 scope)

### 3.1 Chat flow
- `chat_request` (shell → agent): `{ type, sessionId, prompt, model?, systemPrompt? }`
- `chat_response_chunk` (agent → shell): `{ type, sessionId, delta: { text? | thinking? | tool_use? } }`
- `chat_response_end` (agent → shell): `{ type, sessionId, stopReason, usage }`

### 3.2 Approval flow (D40)
- `approval_request` (agent → shell): `{ type, id, tier, summary, toolName, toolArgs, timeoutMs }`
- `approval_response` (shell → agent): `{ type, id, status: "approved"|"denied"|"timeout", reason? }`
- `approval_cancel` (shell → agent, M1 mitigation): `{ type, id, reason }` — modal closed by SIGINT

**Constraints** (P0-2):
- timeout default 60s (shell modal)
- "always allow" 옵션 차단 (one-time approve only)
- fresh request per tier (cached approval 거부)

### 3.3 Tool flow (Phase 4.2 — placeholder)
- `tool_use_start` / `tool_use_end` — Phase 4.2 wire 시점에 정식

### 3.4 Panel skills (existing naia-os, shell-only)
- `panel_skills_request` (shell → agent): `{ type, skills: PanelSkillDescriptor[] }`
- (기존 naia-os/agent/src/protocol.ts 형식 유지)

### 3.5 Lifecycle
- `session_end` (agent → shell): `{ type, sessionId, reason }`
- `agent_shutdown` (shell → agent): `{ type, gracefulMs }` — Tauri close 시
- `agent_exit` (agent → shell): `{ type, code }` — clean exit notification

## 4. ApprovalRequestMessage / ApprovalResponseMessage 정확 schema (P0-1)

```typescript
// JSON schema — 양 repo (naia-os + external naia-agent)에서 공유
export interface ApprovalRequestMessage {
  type: "approval_request";
  id: string;                   // UUID
  tier: "T0" | "T1" | "T2" | "T3";
  toolName: string;
  toolArgs: unknown;            // sanitized (secret redacted)
  summary: string;              // human-readable, e.g. "write src/api.ts"
  timeoutMs?: number;           // default 60_000
  sessionId?: string;
}

export interface ApprovalResponseMessage {
  type: "approval_response";
  id: string;                   // matches request
  status: "approved" | "denied" | "timeout";
  reason?: string;              // user input or "input closed" or "modal SIGINT"
  at: number;                   // epoch ms
}

export interface ApprovalCancelMessage {
  type: "approval_cancel";
  id: string;
  reason: "user_sigint" | "modal_closed" | "agent_died" | "timeout_local";
}
```

→ external naia-agent의 `IpcApprovalBroker` (Phase 4.1 Day 2.1) 가 본 schema 따름.

## 5. naia-os 기존 protocol.ts 매핑

| naia-os existing | Phase 4.1 mapping |
|---|---|
| `ChatRequest` | `chat_request` (그대로) |
| `ToolRequest` (skill execute) | (Phase 4.2 — `tool_use_start`/`tool_use_end`) |
| **`ApprovalResponse`** | **본 v1 spec의 `ApprovalResponseMessage` 로 통합 (status field 통일)** |
| `PanelToolDescriptor` | `panel_skills_request.skills[]` (그대로) |
| `PanelSkillsRequest` / Clear | (그대로) |

기존 message type은 v1에서 그대로 유지 + `approval_*` family만 신규.

## 6. Wire compatibility

- **forward compat**: 미지원 message type 수신 시 silent drop + stderr log (`[naia-agent] unknown message type: X`)
- **backward compat**: protocolVersion mismatch 시 graceful exit (handshake_ack 단계 검증)
- **redact**: 모든 outgoing string field에 `redactString()` (Phase 1 P0-6 패턴 재사용)

## 7. test fixture (Day 2.4 unit test 시 사용)

`tests/fixtures/protocol-v1/`:
- `handshake-success.jsonl`
- `chat-text-1turn.jsonl`
- `approval-cycle-approved.jsonl`
- `approval-cycle-denied.jsonl`
- `approval-cycle-timeout.jsonl`
- `approval-cancel-sigint.jsonl`
- `panel-skills-request.jsonl`

각 fixture = 정상 시퀀스 (shell ↔ agent 양방향).

## 8. lock 후 변경 절차

protocol v1 lock 후 변경 시:
1. protocolVersion 증가 (v2)
2. 본 docs Change log
3. 양 repo (naia-os + external naia-agent) 동시 PR
4. backward compat 보장 (v1 client + v2 agent 또는 반대)

## 9. Day 0.5.4 handshake 정합

D39 handshake 명세 = §2.

cross-link: r4-phase4-naia-os-wire-spec.md Day 0.5.4
