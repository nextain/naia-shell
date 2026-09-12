// #582 S2a — `globalThis.ego` 프록시.
// 벤더 런타임이 기대하는 표면 그대로다(packages/ego-host/docs/ego-runtime-abi.md 0절).
// 실패 모양의 규칙이 둘로 갈린다는 점이 중요하다.
//   - 작업 공간·탭 계열: **reject 가 아니라 `{error, error_code}` 를 담아 resolve** 한다
//     (ego-errors.ts:162-172 의 assertNoEgoError 가 이 모양을 던진다).
//   - `snapshot` 만 예외로 **직접 reject** 한다(driver/observe.ts:49-59 의 주석이 명시).
// 미지의 error_code 는 런타임이 문구를 덮어쓰지 않으므로 `error` 문자열에 사람이 읽을 설명을 담는다.

function isErrorShape(value) {
  return value && typeof value === "object" && "error" in value && value.error != null;
}

function asError(shape) {
  const error = new Error(shape.error);
  if (shape.error_code) error.error_code = shape.error_code;
  return error;
}

/**
 * @param {object} client `connectSupervisor()` 가 돌려준 클라이언트.
 * @returns {object} `globalThis.ego` 에 그대로 대입할 객체.
 */
export function createEgoProxy(client) {
  const ego = {
    // 런타임이 매 요청마다 여기에 자기 핸들러를 대입한다(browser-runtime.ts:45-46).
    // 우리가 덮어쓰지 않고, 대입된 값을 호출 시점에 읽는다.
    onCDPMessage: null,
    onSendCDPMessageError: null,

    /** 동기 enqueue 또는 동기 throw. 반환값을 기다리는 호출자는 없다(ABI 1). */
    sendCDPMessage(payload) {
      client.sendCdp(payload);
    },

    listTabs: () => client.call("listTabs"),
    createTab: (url = "about:blank") => client.call("createTab", { url }),
    listTaskSpaces: () => client.call("listTaskSpaces"),
    createTaskSpace: (name) => client.call("createTaskSpace", { name }),
    useTaskSpace: (id) => client.call("useTaskSpace", { id }),
    claimTaskSpace: (id, name) => client.call("claimTaskSpace", { id, name }),
    closeTaskSpace: () => client.call("closeTaskSpace"),
    completeTaskSpace: () => client.call("completeTaskSpace"),
    handOffTaskSpace: () => client.call("handOffTaskSpace"),
    takeOverTaskSpace: () => client.call("takeOverTaskSpace"),
    getBrowserVersion: () => client.call("getBrowserVersion"),

    /** 이 하나만 reject 다. probeAgentControl 이 이 거부를 제어권 신호로 읽는다. */
    async snapshot(options = {}) {
      const result = await client.call("snapshot", { options });
      if (isErrorShape(result)) throw asError(result);
      return result;
    },
  };

  client.onCdp((raw) => {
    const handler = ego.onCDPMessage;
    if (typeof handler === "function") handler(raw);
  });
  client.onCdpError((message, code) => {
    const handler = ego.onSendCDPMessageError;
    if (typeof handler === "function") handler(message, code);
  });

  return ego;
}
