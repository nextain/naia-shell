// app/chat — ownership 레지스트리 단일 소유자(ClientSessionPort 구현, contract §B.2).
// requestId→clientId. 등록·충돌거부·해제·권한인가 = 이 1곳(다른 컴포넌트는 조회/통지만).
// UC1 = 단일 owner 등록(in-memory). UC10a 에서 lease/다중 클라이언트 확장.
import type { ClientSessionPort } from "../../ports/uc1.js";

export class InMemoryClientSession implements ClientSessionPort {
  private readonly owners = new Map<string, string>(); // requestId → clientId

  register(requestId: string, clientId: string): boolean {
    if (this.owners.has(requestId)) return false; // 충돌 거부(중복 requestId)
    this.owners.set(requestId, clientId);
    return true;
  }
  release(requestId: string): void {
    this.owners.delete(requestId);
  }
  ownerOf(requestId: string): string | undefined {
    return this.owners.get(requestId);
  }
  authorize(requestId: string, clientId: string): boolean {
    const owner = this.owners.get(requestId);
    return owner !== undefined && owner === clientId; // 소유주 대조(타 client 차단)
  }
}
