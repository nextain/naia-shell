// #582 S2a — CLI 쪽 감독자 클라이언트.
// OS 가정을 넣지 않는다. 경로는 호출자가 주고(socket-path.mjs 가 결정), unix 소켓과 named pipe
// 둘 다 node:net 의 같은 `connect(path)` 로 붙는다.
//
// 핵심 제약: `sendCdp` 는 **동기**다. 벤더 런타임은 `sendCDPMessage` 의 반환을 기다리지 않고
// 호출 전에 pending 과 15초 타이머를 만든다(ABI 1). 그래서 여기서 할 수 있는 것은 동기 enqueue
// 아니면 동기 throw 둘뿐이다. 비동기로 미루면 그 사이의 실패가 15초 뒤 timeout 으로만 보인다.
import { connect } from "node:net";
import { CODES, hostError } from "../errors.mjs";
import { MAX_FRAME_BYTES, createFrameDecoder, encodeFrame } from "../supervisor/rpc-framing.mjs";

/** 클라이언트 쪽 미전송 큐 상한. 감독자가 안 읽어 갈 때 CLI 메모리를 지킨다. */
export const CLIENT_MAX_QUEUED_FRAMES = 1024;

export async function connectSupervisor({
  socketPath,
  token,
  grant = null,
  operationId = null,
  workspaceId = null,
  deadline = null,
  maxFrameBytes = MAX_FRAME_BYTES,
  maxQueuedFrames = CLIENT_MAX_QUEUED_FRAMES,
  unref = true,
} = {}) {
  if (!socketPath) throw hostError(CODES.NOT_CONNECTED, "감독자 소켓 경로가 없다");

  const socket = connect(socketPath);
  socket.setNoDelay?.(true);
  let closed = false;
  let fatal = null;
  let queued = 0;
  const cdpHandlers = new Set();
  const cdpErrorHandlers = new Set();
  const closeHandlers = new Set();
  const calls = new Map();
  let nextCallId = 1;
  let welcome = null;

  /**
   * 소켓이 프로세스를 붙잡는 시간을 대기 중인 RPC 로 한정한다.
   * 계속 ref 하면 스크립트가 끝나도 CLI 가 안 죽고, 계속 unref 하면 `await ego.listTabs()`
   * 하나만 남았을 때 이벤트 루프가 비어 최상위 await 가 미해결로 프로세스가 13번으로 죽는다.
   * CDP 요청은 런타임이 자기 15초 타이머(ref 됨)로 루프를 잡고 있으므로 여기서 셀 필요가 없다.
   */
  function syncRef() {
    if (!unref) return;
    if (calls.size > 0) socket.ref();
    else socket.unref();
  }

  function write(value) {
    if (closed) {
      throw fatal ?? hostError(CODES.DISCONNECTED, "감독자 연결이 끊겼다");
    }
    if (queued >= maxQueuedFrames) {
      throw hostError(
        CODES.BACKPRESSURE,
        `클라이언트 송신 큐가 상한 ${maxQueuedFrames}프레임을 넘었다`,
      );
    }
    const frame = encodeFrame(value, { maxBytes: maxFrameBytes });
    queued += 1;
    socket.write(frame, () => {
      queued -= 1;
    });
  }

  function fail(error) {
    if (closed) return;
    closed = true;
    fatal = error;
    for (const entry of calls.values()) entry.resolve({ error: error.message, error_code: error.error_code });
    calls.clear();
    syncRef();
    for (const handler of cdpErrorHandlers) handler(error.message, error.error_code);
    for (const handler of closeHandlers) handler(error);
  }

  const decoder = createFrameDecoder({
    maxBytes: maxFrameBytes,
    onFrame: (message) => {
      if (message?.type === "cdp") {
        for (const handler of cdpHandlers) handler(message.payload);
        return;
      }
      if (message?.type === "cdp-error") {
        for (const handler of cdpErrorHandlers) handler(message.error, message.error_code);
        return;
      }
      if (message?.type === "rpc-result") {
        const entry = calls.get(message.id);
        if (!entry) return;
        calls.delete(message.id);
        syncRef();
        entry.resolve(message.value);
        return;
      }
      if (message?.type === "welcome") {
        welcome?.resolve(message);
        return;
      }
      if (message?.type === "fatal") {
        const error = hostError(message.error_code, message.error);
        welcome?.reject(error);
        fail(error);
      }
    },
    onError: (error) => fail(error),
  });

  socket.on("data", (chunk) => decoder.push(chunk));
  socket.on("error", (error) =>
    fail(hostError(CODES.DISCONNECTED, `감독자 소켓 오류: ${error.message}`)),
  );
  socket.on("close", () => fail(hostError(CODES.DISCONNECTED, "감독자 연결이 닫혔다")));

  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  const greeting = await new Promise((resolve, reject) => {
    welcome = { resolve, reject };
    try {
      write({ type: "hello", token, grant, operationId, workspaceId, deadline });
    } catch (error) {
      reject(error);
    }
  });
  welcome = null;
  syncRef();

  return {
    greeting,
    /** 동기 enqueue 또는 동기 throw. 이 함수는 절대 Promise 를 돌려주지 않는다. */
    sendCdp(payload) {
      write({ type: "cdp", payload });
    },
    call(method, params = {}) {
      const id = nextCallId++;
      return new Promise((resolve) => {
        calls.set(id, { resolve });
        syncRef();
        try {
          write({ type: "rpc", id, method, params });
        } catch (error) {
          calls.delete(id);
          syncRef();
          resolve({ error: error.message, error_code: error.error_code });
        }
      });
    },
    onCdp(handler) {
      cdpHandlers.add(handler);
      return () => cdpHandlers.delete(handler);
    },
    onCdpError(handler) {
      cdpErrorHandlers.add(handler);
      return () => cdpErrorHandlers.delete(handler);
    },
    onClose(handler) {
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
    /** 소켓 읽기를 멈춘다. 멈춘 CLI 를 흉내 내 감독자 쪽 역압을 밟는 데 쓴다. */
    pause() {
      socket.pause();
    },
    resume() {
      socket.resume();
    },
    close() {
      socket.destroy();
    },
  };
}
