// #582 S2a — 가짜 CDP 백엔드.
// 실브라우저는 이 슬라이스에 없다(S2b 부터). 여기서 재현하는 것은 Chromium 의 *프로토콜 행동*
// 뿐이다: id 를 그대로 돌려주는 응답, flatten 세션, 이벤트, 그리고 우리가 강제로 만들 실패들.
export function createFakeCdp({ autoRespond = true } = {}) {
  const handlers = new Set();
  const sent = [];
  let nextSession = 1;
  let nextTarget = 1;
  let nextContext = 1;
  const responders = new Map();
  /** 응답하지 않을 메서드. 감독자 deadline 을 밟는 데 쓴다. */
  const blackHole = new Set();

  function emitRaw(raw) {
    for (const handler of handlers) handler(raw);
  }

  const backend = {
    sent,
    send(payload) {
      const data = JSON.parse(payload);
      sent.push(data);
      if (!autoRespond || blackHole.has(data.method)) return;
      const responder = responders.get(data.method);
      queueMicrotask(() => {
        if (responder) {
          const value = responder(data, backend);
          if (value === undefined) return;
          emitRaw(JSON.stringify({ id: data.id, ...value }));
          return;
        }
        if (data.method === "Target.attachToTarget") {
          emitRaw(
            JSON.stringify({ id: data.id, result: { sessionId: `S${nextSession++}` } }),
          );
          return;
        }
        if (data.method === "Target.createBrowserContext") {
          // S2c: 작업 공간 하나 = 격리 컨텍스트 하나. 가짜 백엔드도 진짜처럼 id 를 준다.
          emitRaw(JSON.stringify({ id: data.id, result: { browserContextId: `BC${nextContext++}` } }));
          return;
        }
        if (data.method === "Target.getBrowserContexts") {
          emitRaw(JSON.stringify({ id: data.id, result: { browserContextIds: [] } }));
          return;
        }
        if (data.method === "Target.createTarget") {
          emitRaw(JSON.stringify({ id: data.id, result: { targetId: `T${nextTarget++}` } }));
          return;
        }
        if (data.method === "Accessibility.getFullAXTree") {
          emitRaw(
            JSON.stringify({
              id: data.id,
              result: {
                nodes: [
                  { backendNodeId: 11, role: { value: "button" }, name: { value: "보내기" } },
                  { backendNodeId: 12, role: { value: "link" }, name: { value: "홈" } },
                ],
              },
            }),
          );
          return;
        }
        emitRaw(JSON.stringify({ id: data.id, result: {} }));
      });
    },
    onMessage(handler) {
      handlers.add(handler);
    },
    /** 테스트가 직접 밀어 넣는 원문 메시지(응답이든 이벤트든). 순서 시험에 쓴다. */
    push(message) {
      emitRaw(typeof message === "string" ? message : JSON.stringify(message));
    },
    respondTo(method, responder) {
      responders.set(method, responder);
    },
    silence(method) {
      blackHole.add(method);
    },
    /** 마지막으로 받은 요청의 상류 id. id 재작성 확인에 쓴다. */
    lastId() {
      return sent.at(-1)?.id ?? null;
    },
  };
  return backend;
}
