// app/chat — UC1 (contract §B.3). 포트만 사용. domain 만 다룸(protocol/wire 무지).
// ChatService implements ChatPort: startTurn/cancel/deliverChunk.
// domain↔protocol↔wire 변환·demux 는 전부 adapter(canon). 여기선 domain ChatRequest 를 transport 에 그대로.
// ⚠️ 불변식(conceded, 계약 §B.4.1): requestId 는 turn 마다 전역 고유(baseline 보장). wire 에 generation 없음 →
//   cross-generation 재사용 안전은 *프로토콜 계약*(코드 책임 아님). 코드는 단일 콜스택 재진입만 reference 가드로 방어.
//   동일 id 재등록은 register() 충돌 거부가 1차 차단. (세대-구분이 필요하면 UC10a/gRPC turnInstanceId.)
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
    // ⚠️ turn 객체 *식별자*(reference)로 ABA 가드 — 해제 후 동일 requestId 재등록 시 옛 클로저가 새 turn 을 건드리지 않게.
    const turn: Turn = { clientId: req.clientId, onChunk, state: "streaming" };
    this.turns.set(req.requestId, turn);

    const handle: TurnHandle = {
      requestId: req.requestId,
      clientId: req.clientId,
      // unsubscribe = ownership 까지 해제(누수 방지). turn reference 가드(ABA — release 내부에서 검사).
      unsubscribe: () => this.releaseTurn(req.requestId, turn),
    };

    // 구독 선행 → send(domain req). 변환은 adapter. sent=send 결과(reject 전파).
    // ⚠️ send 가 *동기* throw 해도 catch 가 cleanup 하도록 reject promise 로 정규화(codex 코드리뷰4 HIGH).
    const sent = this.invokeSend(() => this.transport.send(req)).catch((err) => {
      // 초기 send reject = 요청이 agent 에 도달 못 함(chunk 안 옴) → 해제 안전.
      // ⚠️ ABA 가드: 그 사이 해제·재등록됐으면(다른 turn) 건드리지 않음.
      if (this.turns.get(req.requestId) === turn) {
        if (!isTerminalState(turn.state)) {
          turn.state = "errored";
          this.safeOnChunk(turn, { kind: "error", message: errMessage(err) });
        }
        this.releaseTurn(req.requestId, turn); // reference 가드(콜백 재진입 대비)
      }
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
    // ⚠️ 이미 종료/없는 turn = cancel 불필요(no-op) — 불필요한 cancel_stream 전송 방지(코드리뷰4 MED).
    if (!turn || isTerminalState(turn.state)) return;
    turn.state = nextTurnState(turn.state, { type: "cancelRequested" }); // → cancelling(비종결)
    const out: CancelTurn = { kind: "cancel", requestId: handle.requestId, clientId: handle.clientId };
    // ⚠️ cancel_stream send reject 로는 해제 안 함(turn 라이브 가능 — 후속 finish/error 가 해제).
    return this.transport.send(out);
  }

  deliverChunk(chunk: ChatChunk, owner: { requestId: string; clientId: string }): void {
    const turn = this.turns.get(owner.requestId);
    if (!turn) return; // 종료/미지 turn — silent (router 가 DiagnosticSink 책임)
    // ⚠️ 오라우팅 방어: owner.clientId 가 turn 소유주와 다르면 거부(타 client turn 종결/해제 방지, 코드리뷰4 HIGH).
    if (turn.clientId !== owner.clientId) return;
    // ⚠️ 상태전이 *먼저* → 콜백이 post-transition 상태 관측(재진입 시 stale 상태·불필요 cancel 방지, 코드리뷰4 MED).
    turn.state = nextTurnState(turn.state, { type: "chunk", chunk });
    // ⚠️ onChunk(소비자 콜백) 예외가 해제·라우터를 깨뜨리지 않게 격리(코드리뷰 HIGH).
    this.safeOnChunk(turn, chunk);
    // ⚠️ 재진입 가드: 콜백이 unsubscribe + 동일 requestId 재등록 했을 수 있음 → 같은 turn 일 때만 해제(코드리뷰2 HIGH).
    if (this.turns.get(owner.requestId) !== turn) return;
    if (isTerminalState(turn.state)) {
      this.releaseTurn(owner.requestId, turn); // finish/error = terminal → ownership 해제(reference 가드)
    }
  }

  /** 진행 중 turn 조회(테스트/관측용). */
  turnState(requestId: string): ChatTurnState | undefined {
    return this.turns.get(requestId)?.state;
  }

  /** ABA-안전 해제 — *그 turn* 이 여전히 현재일 때만(콜백 재진입·재등록 대비, codex 코드리뷰2). */
  private releaseTurn(requestId: string, turn: Turn): void {
    if (this.turns.get(requestId) !== turn) return;
    this.turns.delete(requestId);
    this.sessions.release(requestId);
  }
  /** send 호출 정규화 — *동기* throw 도 reject promise 로(catch 가 cleanup 하도록, codex 코드리뷰4 HIGH). */
  private invokeSend(fn: () => Promise<void>): Promise<void> {
    try { return fn(); }
    catch (e) { return Promise.reject(e); }
  }
  /** 소비자 콜백 격리 — 예외를 삼켜 상태기계·ownership·라우팅이 깨지지 않게(codex HIGH). */
  private safeOnChunk(turn: Turn, chunk: ChatChunk): void {
    try { turn.onChunk(chunk); }
    catch { /* 소비자(렌더) 콜백 오류는 turn 생명주기와 무관 — silent (관측은 호출측 책임) */ }
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
