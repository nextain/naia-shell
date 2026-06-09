// app/chat — UC1 (contract §B.3). 포트만 사용. domain 만 다룸(protocol/wire 무지).
// ChatService implements ChatPort: startTurn/cancel/deliverChunk.
// domain↔protocol↔wire 변환·demux 는 전부 adapter(canon). 여기선 domain ChatRequest 를 transport 에 그대로.
import type {
  ChatRequest, ChatChunk, CancelTurn,
  ChatTurnState,
} from "../../domain/chat.js";
import { nextTurnState, isTerminalState } from "../../domain/chat.js";
import type {
  ChatPort, TurnHandle, AgentTransportPort, ClientSessionPort,
} from "../../ports/uc1.js";

interface Turn {
  readonly clientId: string;
  readonly onChunk: (c: ChatChunk) => void;
  state: ChatTurnState;
}

export class ChatService implements ChatPort {
  private readonly turns = new Map<string, Turn>();

  constructor(
    private readonly transport: AgentTransportPort,
    private readonly sessions: ClientSessionPort,
  ) {}

  startTurn(req: ChatRequest, onChunk: (c: ChatChunk) => void): { handle: TurnHandle; sent: Promise<void> } {
    // ownership 등록 — 중복 requestId = 충돌 거부(레지스트리 권위, ClientSessionPort).
    if (!this.sessions.register(req.requestId, req.clientId)) {
      throw new Error(`requestId 충돌(중복 등록 거부): ${req.requestId}`);
    }
    this.turns.set(req.requestId, { clientId: req.clientId, onChunk, state: "streaming" });

    const handle: TurnHandle = {
      requestId: req.requestId,
      clientId: req.clientId,
      unsubscribe: () => this.disposeTurn(req.requestId),
    };

    // 구독 선행 → send(domain req). 변환은 adapter. sent=send 결과(reject 전파).
    const sent = this.transport.send(req).catch((err) => {
      // 초기 send reject = 요청이 agent 에 도달 못 함(chunk 안 옴) → 해제 안전.
      const turn = this.turns.get(req.requestId);
      if (turn && !isTerminalState(turn.state)) {
        turn.state = "errored";
        turn.onChunk({ kind: "error", message: errMessage(err) });
      }
      this.releaseTurn(req.requestId);
      throw err; // 호출자 전파(baseline 등가)
    });

    return { handle, sent };
  }

  async cancel(handle: TurnHandle): Promise<void> {
    // 권한 인가 — 소유주 대조(타 client 차단).
    if (!this.sessions.authorize(handle.requestId, handle.clientId)) {
      throw new Error(`cancel 권한 없음(소유주 불일치): ${handle.requestId}`);
    }
    const turn = this.turns.get(handle.requestId);
    if (turn && !isTerminalState(turn.state)) {
      turn.state = nextTurnState(turn.state, { type: "cancelRequested" }); // → cancelling(비종결)
    }
    const out: CancelTurn = { kind: "cancel", requestId: handle.requestId, clientId: handle.clientId };
    // ⚠️ cancel_stream send reject 로는 해제 안 함(turn 라이브 가능 — 후속 finish/error 가 해제).
    return this.transport.send(out);
  }

  deliverChunk(chunk: ChatChunk, owner: { requestId: string; clientId: string }): void {
    const turn = this.turns.get(owner.requestId);
    if (!turn) return; // 종료/미지 turn — silent (router 가 DiagnosticSink 책임)
    turn.onChunk(chunk);
    turn.state = nextTurnState(turn.state, { type: "chunk", chunk });
    if (isTerminalState(turn.state)) {
      this.releaseTurn(owner.requestId); // finish/error = terminal → ownership 해제
    }
  }

  /** 진행 중 turn 조회(테스트/관측용). */
  turnState(requestId: string): ChatTurnState | undefined {
    return this.turns.get(requestId)?.state;
  }

  private disposeTurn(requestId: string): void {
    this.turns.delete(requestId);
  }
  private releaseTurn(requestId: string): void {
    this.turns.delete(requestId);
    this.sessions.release(requestId);
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
