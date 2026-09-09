// #582 S2a — 감독자 RPC 서버 (계약 4.2·4.2.1·4.3.1·4.4).
//
// loopback 전용이다. 리눅스·macOS 는 unix 소켓, Windows 는 named pipe 이며 둘 다 node:net 이
// 같은 API 로 받는다(경로 결정은 src/supervisor/socket-path.mjs 하나가 든다).
//
// 연결 하나가 CLI heredoc 하나다. 연결마다:
//  - 첫 프레임은 핸드셰이크다. 토큰은 단일 사용이라 재사용·fork 재시도는 즉시 거부된다.
//  - 선택한 작업 공간은 **연결별 상태**다. 감독자 전역이 아니다(4.2 "탭·공간" 행).
//  - 유한 송신 큐. 넘치면 **그 연결만** 형식 있는 오류로 끊는다.
//  - 나가는 프레임은 하나의 FIFO 를 지난다. Chromium 에서 받은 순서가 그대로 유지된다(4.3.1).
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { CODES, hostError, toShape } from "../errors.mjs";
import { MAX_FRAME_BYTES, createFrameDecoder, encodeFrame } from "./rpc-framing.mjs";
import { SUPERVISOR_REQUEST_DEADLINE_MS, createCdpMux } from "./cdp-mux.mjs";
import { createLedger } from "./ledger.mjs";
import { socketNeedsUnlink } from "./socket-path.mjs";

/** 연결당 송신 큐 상한. 이벤트 폭주가 감독자 메모리를 먹지 못하게 한다. */
export const MAX_QUEUED_FRAMES = 1024;
export const MAX_QUEUED_BYTES = 16 * 1024 * 1024;

/**
 * grant 없는 연결이 부를 수 있는 것 (계약 4.4).
 * `useTaskSpace` 가 여기 있는 이유: 선택은 **연결별 상태**를 바꿀 뿐 브라우저를 바꾸지 않는다.
 * 선택을 막으면 관측 연결이 아무것도 볼 수 없어 "관측 RPC 는 허용"이 빈 말이 된다.
 */
export const OBSERVE_RPCS = new Set([
  "listTabs",
  "listTaskSpaces",
  "useTaskSpace",
  "snapshot",
  "getBrowserVersion",
]);

/** 헤드리스에서 도달 불가능한 인계 계열 (계약 4.4 표). */
export const HEADLESS_DENIED_RPCS = new Set([
  "claimTaskSpace",
  "handOffTaskSpace",
  "takeOverTaskSpace",
]);

const HEADLESS_DENIAL_MESSAGE =
  "이 브라우저는 헤드리스로 돌아 사람에게 넘길 창이 없다. 인계·회수·claim 은 지원하지 않는다 " +
  "(#582 계약 4.4). 로그인이나 captcha 가 필요하면 작업을 멈추고 사람에게 보고한다.";

export const FIXED_BROWSER_VERSION = Object.freeze({
  currentVersion: "chromium (naia ego-host)",
  updateAvailable: false,
});

function normalizePolicy(value) {
  if (typeof value === "function") return { route: value };
  return value ?? {};
}

export function createSupervisorServer({
  backend,
  route = null,
  /**
   * 정책 훅 공장. 장부와 감독자 전용 CDP 통로가 준비된 뒤에 만들어야 해서 함수로 받는다
   * (`route` 를 직접 주면 그것이 이긴다 — S2a 의 가짜 백엔드 테스트가 쓰는 길).
   */
  routeFactory = null,
  ledger = null,
  adkDir = null,
  requestDeadlineMs = SUPERVISOR_REQUEST_DEADLINE_MS,
  maxFrameBytes = MAX_FRAME_BYTES,
  maxQueuedFrames = MAX_QUEUED_FRAMES,
  maxQueuedBytes = MAX_QUEUED_BYTES,
  browserVersion = FIXED_BROWSER_VERSION,
  snapshotProvider = null,
} = {}) {
  // 장부 → 정책 → mux 순서로 엮인다. 장부와 정책은 감독자 전용 CDP 통로(`mux.hostRequest`)를
  // 쓰는데 그 통로는 mux 안에 있으므로, 늦게 묶이는 클로저로 넘긴다.
  let mux;
  const hostRequest = (method, params, sessionId) => mux.hostRequest(method, params, sessionId);
  const activeLedger = ledger ?? createLedger({ adkDir, hostRequest });
  // 정책 훅은 함수 하나(`route`)일 수도, 응답 필터를 함께 가진 객체일 수도 있다(중계기).
  const policy = route
    ? { route }
    : routeFactory
      ? normalizePolicy(routeFactory({ ledger: activeLedger, hostRequest, adkDir }))
      : {};
  mux = createCdpMux({
    backend,
    route: policy.route,
    filterResponse: policy.filterResponse ?? null,
    ledger: activeLedger,
    requestDeadlineMs,
  });
  /** token -> {operationId, workspaceId, grant, used} */
  const tokens = new Map();
  const connections = new Set();
  const rejected = [];
  let nextConnectionId = 1;
  let server = null;
  let listening = null;

  function issueToken({ operationId = randomUUID(), workspaceId = null, grant = null } = {}) {
    const token = randomUUID();
    tokens.set(token, { operationId, workspaceId, grant, used: false });
    return token;
  }

  function makeConnection(socket) {
    const connection = {
      id: nextConnectionId++,
      socket,
      state: "awaiting-hello",
      operationId: null,
      workspaceId: null,
      grant: null,
      deadlineAt: null,
      /** 연결별 선택 공간. 두 CLI 가 서로 다른 공간을 써도 섞이지 않는다. */
      selectedSpaceId: null,
      queue: [],
      queuedBytes: 0,
      writable: true,
      closed: false,
      /** 나가는 모든 프레임의 유일한 통로. 순서는 여기서 지켜진다. */
      send(value) {
        if (connection.closed) return false;
        let frame;
        try {
          frame = encodeFrame(value, { maxBytes: maxFrameBytes });
        } catch (error) {
          connection.kill(toShape(error).error_code, toShape(error).error);
          return false;
        }
        if (
          connection.queue.length >= maxQueuedFrames ||
          connection.queuedBytes + frame.length > maxQueuedBytes
        ) {
          connection.kill(
            CODES.BACKPRESSURE,
            `연결 ${connection.id} 의 송신 큐가 상한(${maxQueuedFrames}프레임/${maxQueuedBytes}바이트)을 넘었다. ` +
              "이 연결만 끊는다 — 다른 연결은 영향받지 않는다.",
          );
          return false;
        }
        connection.queue.push(frame);
        connection.queuedBytes += frame.length;
        connection.pump();
        return true;
      },
      pump() {
        while (connection.writable && connection.queue.length > 0 && !connection.closed) {
          const frame = connection.queue.shift();
          connection.queuedBytes -= frame.length;
          connection.writable = socket.write(frame);
        }
      },
      deliverCdp(raw) {
        connection.send({ type: "cdp", payload: raw });
      },
      /** id 없는 통로. 연결 전체가 죽은 경우에만 쓴다(ABI 2). */
      deliverCdpFatal(message, code) {
        connection.send({ type: "cdp-error", error: message, error_code: code });
      },
      kill(code, message) {
        if (connection.closed) return;
        connection.closed = true;
        connection.queue.length = 0;
        connection.queuedBytes = 0;
        rejected.push({ id: connection.id, code, message });
        try {
          // 큐를 버리고 마지막 프레임 하나만 흘려보낸다. 이유 없이 끊으면 상대가 원인을 못 읽는다.
          socket.end(encodeFrame({ type: "fatal", error: message, error_code: code }));
        } catch {
          socket.destroy();
        }
      },
    };
    return connection;
  }

  /** 감독자가 만드는 탭에 공간의 격리 컨텍스트를 붙인다. 컨텍스트가 없는 장부(테스트)는 빈 객체. */
  function contextParams(space) {
    const browserContextId = activeLedger.browserContextOf(space);
    return browserContextId ? { browserContextId } : {};
  }

  async function handleRpc(connection, method, params) {
    if (connection.grant === null && !OBSERVE_RPCS.has(method)) {
      throw hostError(
        CODES.GRANT_REQUIRED,
        `승인(grant) 없는 연결은 관측 RPC 만 부를 수 있다. 거부된 호출: ${method}`,
      );
    }
    if (HEADLESS_DENIED_RPCS.has(method)) {
      throw hostError(CODES.HANDOFF_HEADLESS, HEADLESS_DENIAL_MESSAGE);
    }

    const selected = () => {
      const space = connection.selectedSpaceId === null ? null : activeLedger.get(connection.selectedSpaceId);
      if (!space) {
        throw hostError(
          CODES.NO_TASK_SPACE,
          "선택된 작업 공간이 없다. taskSpaces.useOrCreate(name) 을 먼저 부른다",
        );
      }
      return space;
    };

    switch (method) {
      case "getBrowserVersion":
        return { ...browserVersion };
      case "listTaskSpaces":
        return { taskSpaces: activeLedger.list() };
      case "listTabs":
        return { tabs: activeLedger.tabsOf(selected()) };
      case "useTaskSpace": {
        const space = activeLedger.get(params?.id);
        if (!space) {
          throw hostError(CODES.TASK_SPACE_NOT_FOUND, `작업 공간을 찾지 못했다: ${params?.id}`);
        }
        connection.selectedSpaceId = space.id;
        return {};
      }
      case "createTaskSpace": {
        const name = params?.name;
        if (typeof name !== "string" || name === "") {
          throw hostError(CODES.HANDSHAKE_INVALID, "createTaskSpace 에는 비지 않은 이름이 필요하다");
        }
        // 멱등: 같은 키로 재전송하면 같은 공간을 돌려준다(공간이 둘 생기지 않는다).
        const space = await activeLedger.create(name, { idempotencyKey: params?.idempotencyKey ?? null });
        if (space.tabs.length === 0) {
          const created = await mux.hostRequest("Target.createTarget", {
            url: "about:blank",
            // 공간의 격리 컨텍스트 안에서만 탭을 만든다. 컨텍스트 없이 만들면 기본 컨텍스트에
            // 열려 쿠키·저장소가 다른 공간과 섞인다.
            ...contextParams(space),
          });
          activeLedger.addTab(space, { targetId: created.targetId, url: "about:blank", title: "" });
          activeLedger.claimTarget(connection, created.targetId);
        }
        connection.selectedSpaceId = space.id;
        return activeLedger.shape(space);
      }
      case "createTab": {
        const space = selected();
        const url = typeof params?.url === "string" ? params.url : "about:blank";
        const created = await mux.hostRequest("Target.createTarget", {
          url,
          ...contextParams(space),
        });
        activeLedger.addTab(space, { targetId: created.targetId, url, title: "" });
        activeLedger.claimTarget(connection, created.targetId);
        return { targetId: created.targetId };
      }
      case "closeTaskSpace": {
        const space = selected();
        for (const tab of [...space.tabs]) {
          await mux.hostRequest("Target.closeTarget", { targetId: tab.targetId }).catch(() => {});
          activeLedger.releaseTarget(tab.targetId);
        }
        // 컨텍스트 dispose 까지가 "공간 닫기"다. 탭만 닫으면 쿠키·저장소가 살아남는다.
        await activeLedger.close(space.id);
        connection.selectedSpaceId = null;
        return {};
      }
      case "completeTaskSpace": {
        // keep:true 경로. 헤드리스에서는 사람에게 넘길 대상이 없으므로 공간을 그대로 둔다.
        selected();
        return {};
      }
      case "snapshot":
        return snapshot(connection, params?.options ?? {});
      default:
        throw hostError(CODES.METHOD_DENIED, `알 수 없는 RPC: ${method}`);
    }
  }

  /**
   * 접근성 스냅샷. S2e 가 실제 렌더러를 넣는다.
   * 여기서 지키는 것은 ABI 7 의 모양뿐이다: `{content, refs}`, ref 키 = String(backendNodeId).
   */
  async function snapshot(connection, options) {
    if (snapshotProvider) return snapshotProvider(connection, options);
    const space = connection.selectedSpaceId === null ? null : activeLedger.get(connection.selectedSpaceId);
    if (!space) {
      throw hostError(
        CODES.NO_TASK_SPACE,
        "선택된 작업 공간이 없다. taskSpaces.useOrCreate(name) 을 먼저 부른다",
      );
    }
    const targetId = space.activeTargetId ?? space.tabs.at(-1)?.targetId;
    if (!targetId) throw hostError(CODES.NO_TASK_SPACE, "스냅샷을 찍을 탭이 없다");
    const attached = await mux.hostRequest("Target.attachToTarget", { targetId, flatten: true });
    const sessionId = attached.sessionId;
    try {
      const tree = await mux.hostRequest("Accessibility.getFullAXTree", {}, sessionId);
      const refs = [];
      const lines = [];
      for (const node of tree.nodes || []) {
        if (node.backendDOMNodeId === undefined && node.backendNodeId === undefined) continue;
        const backendNodeId = node.backendNodeId ?? node.backendDOMNodeId;
        const role = node.role?.value ?? node.role ?? "";
        const name = node.name?.value ?? node.name ?? "";
        refs.push({ backendNodeId, role, name });
        lines.push(`- ${role} "${name}" [ref=${backendNodeId}]`);
      }
      return { content: lines.join("\n"), refs };
    } finally {
      mux.hostRequest("Target.detachFromTarget", { sessionId }).catch(() => {});
    }
  }

  function onHello(connection, message) {
    const { token, grant = null, operationId = null, workspaceId = null, deadline = null } = message ?? {};
    if (typeof token !== "string" || token === "") {
      connection.kill(CODES.TOKEN_MISSING, "핸드셰이크에 토큰이 없다");
      return;
    }
    const record = tokens.get(token);
    if (!record) {
      connection.kill(CODES.TOKEN_MISSING, "알 수 없는 핸드셰이크 토큰이다");
      return;
    }
    if (record.used) {
      // fork·cluster 자식이 상속한 토큰으로 다시 붙는 경로가 여기서 닫힌다(계약 4.2.1).
      connection.kill(CODES.TOKEN_REUSED, "이미 쓴 핸드셰이크 토큰이다. 토큰은 단일 사용이다");
      return;
    }
    if (JSON.stringify(record.grant ?? null) !== JSON.stringify(grant ?? null)) {
      connection.kill(
        CODES.HANDSHAKE_INVALID,
        "핸드셰이크의 grant 가 토큰이 발급된 승인과 다르다",
      );
      return;
    }
    record.used = true;
    connection.state = "open";
    connection.operationId = operationId ?? record.operationId;
    connection.workspaceId = workspaceId ?? record.workspaceId;
    connection.grant = record.grant;
    // 두 상한 중 짧은 쪽이 이긴다. 호출자가 더 긴 시한을 적어 감독자 상한을 늘리지 못한다.
    const requested = typeof deadline === "number" && deadline > 0 ? deadline : requestDeadlineMs;
    connection.deadlineAt = Math.min(requested, requestDeadlineMs);
    connection.send({
      type: "welcome",
      operationId: connection.operationId,
      workspaceId: connection.workspaceId,
      deadlineMs: connection.deadlineAt,
      observeOnly: connection.grant === null,
    });
  }

  function onFrame(connection, message) {
    if (connection.closed) return;
    if (connection.state === "awaiting-hello") {
      if (message?.type !== "hello") {
        connection.kill(CODES.HANDSHAKE_REQUIRED, "첫 프레임은 핸드셰이크(hello)여야 한다");
        return;
      }
      onHello(connection, message);
      return;
    }
    if (message?.type === "cdp") {
      if (connection.grant === null) {
        // 원래 id 를 가진 CDP 오류 응답으로 돌려준다. 연결은 죽이지 않는다.
        let clientId = null;
        try {
          clientId = JSON.parse(message.payload)?.id ?? null;
        } catch {
          clientId = null;
        }
        if (typeof clientId === "number") {
          connection.deliverCdp(
            JSON.stringify({
              id: clientId,
              error: {
                message: "승인(grant) 없는 연결은 CDP 를 보낼 수 없다",
                code: CODES.GRANT_REQUIRED,
              },
            }),
          );
        } else {
          connection.deliverCdpFatal("승인 없는 연결의 CDP 송신", CODES.GRANT_REQUIRED);
        }
        return;
      }
      mux.fromClient(connection, message.payload);
      return;
    }
    if (message?.type === "rpc") {
      const { id, method, params } = message;
      Promise.resolve()
        .then(() => handleRpc(connection, method, params ?? {}))
        .then(
          (value) => connection.send({ type: "rpc-result", id, value }),
          (error) => connection.send({ type: "rpc-result", id, value: toShape(error) }),
        );
      return;
    }
    connection.kill(CODES.FRAME_MALFORMED, `알 수 없는 프레임 종류: ${message?.type}`);
  }

  function onConnection(socket) {
    socket.setNoDelay?.(true);
    const connection = makeConnection(socket);
    connections.add(connection);
    const decoder = createFrameDecoder({
      maxBytes: maxFrameBytes,
      onFrame: (message) => onFrame(connection, message),
      onError: (error) => connection.kill(toShape(error).error_code, toShape(error).error),
    });
    socket.on("data", (chunk) => decoder.push(chunk));
    socket.on("drain", () => {
      connection.writable = true;
      connection.pump();
    });
    socket.on("error", () => {
      /* 끊긴 소켓은 close 에서 정리한다. */
    });
    socket.on("close", () => {
      connection.closed = true;
      connections.delete(connection);
      mux.detach(connection);
    });
  }

  return {
    issueToken,
    mux,
    ledger: activeLedger,
    connections,
    rejected,
    listen(socketPath, { kind = "unix" } = {}) {
      if (socketNeedsUnlink(kind)) {
        const dir = socketPath.slice(0, socketPath.lastIndexOf("/"));
        if (dir) mkdirSync(dir, { recursive: true });
        if (existsSync(socketPath)) rmSync(socketPath, { force: true });
      }
      server = createServer(onConnection);
      listening = new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => resolve(socketPath));
      });
      return listening;
    },
    async close() {
      for (const connection of [...connections]) connection.socket.destroy();
      if (!server) return;
      await new Promise((resolve) => server.close(resolve));
      server = null;
    },
  };
}
