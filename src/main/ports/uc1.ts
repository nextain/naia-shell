// ports — UC1 수평 (contract §B.2). domain 만 의존. transport-neutral.
// ⚠️ domain↔protocol↔wire 변환 전부 adapter 책임(STRUCTURE canon). app 은 domain 만, protocol/wire 무지.
import type { ChatRequest, ChatChunk, DomainOutbound } from "../domain/chat.js";

// ── ports/protocol — transport-neutral DTO (중립 intermediate, ports 소유) ──
// wire-framing(JSON 라인/길이 prefix/gRPC msg) 누출 금지. stdio·gRPC 어댑터 공유 target.

/** shell→agent 송신 protocol DTO 폐쇄 union — type discriminant 판별(baseline parseRequest 집합). */
export type AgentOutbound =
  | { readonly type: "chat_request"; readonly requestId: string; readonly [k: string]: unknown }
  | { readonly type: "cancel_stream"; readonly requestId: string }
  | { readonly type: "approval_response"; readonly requestId: string; readonly toolCallId: string; readonly decision: "approve" | "reject" }
  | { readonly type: "creds_update"; readonly provider: string; readonly [k: string]: unknown };

/** agent→shell 수신 raw 디코드 union (SoT) = Known(18 variant) | Unknown(catch-all). */
export interface KnownAgentMessage {
  readonly type: string; // 18 variant 중 하나(권위=agent index.ts writeLine 출력, superset)
  readonly requestId?: string;
  readonly [k: string]: unknown;
}
export interface UnknownAgentMessage {
  readonly type: string; // 18 외
  readonly raw: unknown;
}
export type AgentMessage = KnownAgentMessage | UnknownAgentMessage;

export type Unsub = () => void;

// ── AppPort = ChatPort + ToolPort *조립 facade* (재흡수 아님, canon) ──

/** turn 핸들 — 위조 방지=레지스트리가 권위(핸들 단독 아님). */
export interface TurnHandle {
  readonly requestId: string;
  readonly clientId: string;
  readonly unsubscribe: Unsub;
}

/** 대화 ingress. 구현자=app ChatService. 의존자=TauriChatBridge(outbound 호출). */
export interface ChatPort {
  /** 원자적 listen-then-send. sent Promise=send reject 호출자 전파(baseline 등가). */
  startTurn(req: ChatRequest, onChunk: (c: ChatChunk) => void): { handle: TurnHandle; sent: Promise<void> };
  /** cancel_stream — 비동기, 전송 실패 reject 전파(send 등가). 비종결 요청. */
  cancel(handle: TurnHandle): Promise<void>;
  /** 수신 sink (driving-in). router(B.4)가 chat-turn chunk 를 여기로. 소유권 필수. */
  deliverChunk(chunk: ChatChunk, owner: { requestId: string; clientId: string }): void;
}

/** 툴 interaction (독립, UC5) — 별 계약. UC1 stub. */
export interface ToolPort {
  readonly kind: "tool";
}

/** driven — *순수 transport*(wire 책임만). demux·라우팅 안 함. */
export interface AgentTransportPort {
  /** 경계=domain outbound 의도. adapter 가 domain→AgentOutbound(protocol)→wire 변환. rejection 호출자 전파. */
  send(out: DomainOutbound): Promise<void>;
  /** raw AgentMessage 전 variant. 단일 구독자=MessageRouter(중복전달 방지). */
  onMessage(cb: (m: AgentMessage) => void): Unsub;
}

/** ownership 레지스트리 단일 소유자(requestId→clientId). 충돌거부·해제·권한인가 SoT. */
export interface ClientSessionPort {
  /** startTurn 시 등록. 중복 requestId = 충돌 거부(throw/false). */
  register(requestId: string, clientId: string): boolean;
  /** terminal(finish/error) OR 초기 send reject 시 해제. */
  release(requestId: string): void;
  /** requestId→clientId 복원(legacy agent_response 엔 clientId 없음). */
  ownerOf(requestId: string): string | undefined;
  /** cancel/approval 권한 인가 — 소유주 대조(타 client 차단). */
  authorize(requestId: string, clientId: string): boolean;
}

/** 비-chat 미배선 variant 보류(log+drop 아님). 해당 UC(UC9/UC5/voice)에서 실제 포트 배선. */
export interface PendingRouteSink {
  pending(m: AgentMessage): void;
}
/** Unknown·소유권 없는 것(error+log, 소유권 불요). silent drop 금지. */
export interface DiagnosticSink {
  diagnose(m: AgentMessage, reason: string): void;
}
