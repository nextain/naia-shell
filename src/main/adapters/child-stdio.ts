// adapters — child-process stdio transport (Option C 헤드리스 trace 용).
// Tauri 대신 *직접* agent stdin/stdout 에 줄단위 JSON 으로 연결(rust 의 command 분리 없음 — agent readline 이 type 별 분기).
// ⚠️ 순수: Node child_process 의존 없음(LineIO 추상). 실 child 결선은 harness(.mjs)가 LineIO 를 주입.
import type { DomainOutbound } from "../domain/chat.js";
import type { AgentMessage, AgentTransportPort, Unsub } from "../ports/uc1.js";
import { toAgentOutbound, decodeAgentMessage } from "./tauri/uc1.js";

/** 줄단위 stdio 추상(테스트=mock, 실행=child_process stdin/stdout readline). */
export interface LineIO {
  /** agent stdin 으로 한 줄 쓰기(개행은 io 구현이 처리). 실패 시 throw → send rejection 전파. */
  writeLine(line: string): void;
  /** agent stdout 한 줄 도착 구독. unsubscribe 반환. */
  onLine(cb: (line: string) => void): Unsub;
}

/**
 * child stdio AgentTransportPort. 모든 outbound = stdin 한 줄 JSON(agent readline 이 type 분기로 처리:
 * chat_request·cancel_stream·approval_response·creds_update 전부). 수신 = stdout 줄 → decodeAgentMessage.
 */
export function makeChildStdioTransport(io: LineIO): AgentTransportPort {
  return {
    async send(out: DomainOutbound): Promise<void> {
      // 동기 write throw(EPIPE 등) → async 가 rejection 으로 전파(send rejection 계약).
      io.writeLine(JSON.stringify(toAgentOutbound(out)));
    },
    onMessage(cb: (m: AgentMessage) => void): Unsub {
      return io.onLine((line) => cb(decodeAgentMessage(line)));
    },
  };
}
