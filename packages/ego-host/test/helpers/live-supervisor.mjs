// #582 S2c·S2d — 실 Chromium 을 붙인 감독자 지그.
//
// `startSupervisor()` 는 조정·lease·프로필까지 다 도는 운영 경로다. 여기서는 그 경로를 쓰되
// **CDP 통로에 얇은 껍질**을 하나 끼운다. 껍질이 필요한 이유는 두 가지뿐이다.
//
//  (1) 순서 강제 — 계약 4.3.1 은 "응답→이벤트, 이벤트→응답 두 순서"를 요구한다. Chromium 이
//      어떤 순서로 주는지는 우리가 못 정하므로, **진짜 Chromium 이 준 진짜 메시지**를 잠시
//      붙잡았다 원하는 순서로 흘려보낸다. 만들어 낸 메시지가 아니라 실제 바이트다.
//  (2) 결함 주입 — 예기치 않은 자식 `attachedToTarget` 은 auto-attach 를 켜야만 생긴다.
//      우리는 auto-attach 를 절대 켜지 않으므로(계약 4.3.1) 그 이벤트를 주입해 fail-closed
//      경로를 밟는다. 주입임을 증거에 적는다.
//
// 브라우저가 없으면 건너뛰지 않고 RED 다(live-browser.mjs 와 같은 원칙).
import { join } from "node:path";
import { connectSupervisor } from "../../src/client/rpc-client.mjs";
import { startSupervisor } from "../../src/supervisor/supervisor.mjs";
import { requireChromium, tempDir, trackPid } from "./live-browser.mjs";

const running = [];
const openClients = [];

/**
 * Chromium 백엔드에 씌우는 껍질. 감독자가 보낸 것과 브라우저가 준 것을 다 본다.
 */
export function orderableBackend(inner) {
  const handlers = new Set();
  const sent = [];
  let holdFilter = null;
  const held = [];
  inner.onMessage((raw) => {
    if (holdFilter) {
      let data = null;
      try {
        data = JSON.parse(raw);
      } catch {
        data = null;
      }
      if (data && holdFilter(data)) {
        held.push(raw);
        return;
      }
    }
    for (const handler of handlers) handler(raw);
  });
  return {
    sent,
    send(payload) {
      const text = typeof payload === "string" ? payload : JSON.stringify(payload);
      try {
        sent.push(JSON.parse(text));
      } catch {}
      inner.send(text);
    },
    onMessage(handler) {
      handlers.add(handler);
    },
    on(event, handler) {
      inner.on?.(event, handler);
    },
    /** 조건에 맞는 메시지를 붙잡아 둔다. 나머지는 그대로 흐른다. */
    hold(filter) {
      holdFilter = filter;
    },
    /** 붙잡아 둔 것을 받은 순서대로 흘려보낸다. */
    release() {
      holdFilter = null;
      for (const raw of held.splice(0)) {
        for (const handler of handlers) handler(raw);
      }
    },
    heldCount() {
      return held.length;
    },
    /** 결함 주입. 브라우저가 준 것처럼 보이는 메시지를 넣는다. */
    inject(message) {
      const raw = typeof message === "string" ? message : JSON.stringify(message);
      for (const handler of handlers) handler(raw);
    },
    sentMethods(method) {
      return sent.filter((m) => m.method === method);
    },
  };
}

/**
 * 실 Chromium + 감독자 하나.
 *
 * @param {object} [options]
 * @param {boolean} [options.wrap]  CDP 통로에 껍질을 끼운다(순서 강제·결함 주입용)
 * @returns {Promise<{supervisor:object, server:object, ledger:object, socketPath:string,
 *   backend:object|null, adkDir:string, stop:()=>Promise<void>}>}
 */
export async function startLiveSupervisor({ wrap = false, ...options } = {}) {
  const executable = requireChromium();
  const adkDir = tempDir("ego-adk-");
  const runtimeDir = tempDir("ego-run-");
  let backend = null;
  const supervisor = await startSupervisor({
    adkDir,
    executable,
    runtimeDir,
    headless: true,
    ...(wrap
      ? {
          wrapBackend: (browser) => {
            backend = orderableBackend(browser);
            return backend;
          },
        }
      : {}),
    ...options,
  });
  trackPid(supervisor.browserPid);
  running.push(supervisor);
  return {
    supervisor,
    server: supervisor.server,
    ledger: supervisor.server.ledger,
    socketPath: supervisor.socketPath,
    adkDir,
    backend,
    downloadsDir: join(adkDir, "ego-host", "downloads"),
    stop: () => supervisor.stop(),
  };
}

/** 승인된 연결 하나. CLI heredoc 하나에 해당한다. */
export async function connectClient(live, { grant = { tier: "workspace-write" } } = {}) {
  const token = live.server.issueToken({ grant });
  const client = await connectSupervisor({
    socketPath: live.socketPath,
    token,
    grant,
    unref: false,
  });
  openClients.push(client);
  return client;
}

/**
 * 연결 하나의 CDP 통로. 요청 id 는 **연결마다 1 부터**다(벤더 런타임과 같은 규칙).
 * `sendWithId` 는 두 연결이 같은 id 를 동시에 쓰는 경우를 그대로 재현할 때 쓴다.
 */
export function cdpChannel(client, { timeoutMs = 20_000, operationId = null } = {}) {
  let nextId = 1;
  const pending = new Map();
  const events = [];
  const responses = [];
  client.onCdp((raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    if (Object.hasOwn(data, "id")) {
      responses.push(data);
      const entry = pending.get(data.id);
      if (!entry) return;
      pending.delete(data.id);
      entry(data);
      return;
    }
    events.push(data);
  });

  function await_(id) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP 응답이 ${timeoutMs}ms 안에 오지 않았다 (id=${id})`));
      }, timeoutMs);
      pending.set(id, (data) => {
        clearTimeout(timer);
        resolve(data);
      });
    });
  }

  return {
    events,
    responses,
    nextId() {
      return nextId;
    },
    /** 응답 봉투를 그대로 준다(`{id, result}` 또는 `{id, error}`). */
    send(method, params = {}, sessionId = undefined) {
      const id = nextId++;
      const waiting = await_(id);
      client.sendCdp(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }), {
        operationId,
      });
      return waiting;
    },
    sendWithId(id, method, params = {}, sessionId = undefined) {
      const waiting = await_(id);
      client.sendCdp(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }), {
        operationId,
      });
      return waiting;
    },
    /** 응답을 기다리지 않고 넣기만 한다(동시 요청 경주용). */
    fire(id, method, params = {}, sessionId = undefined) {
      const waiting = await_(id);
      client.sendCdp(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }), {
        operationId,
      });
      return waiting;
    },
    /** 결과만. 오류면 던진다. */
    async call(method, params = {}, sessionId = undefined) {
      const response = await this.send(method, params, sessionId);
      if (response.error) {
        const error = new Error(`${method}: ${response.error.message}`);
        error.code = response.error.code;
        throw error;
      }
      return response.result ?? {};
    },
    eventsOf(method) {
      return events.filter((event) => event.method === method);
    },
  };
}

/**
 * 조건이 참이 될 때까지 기다린다. 못 되면 null.
 * **비동기 조건도 기다린다** — `await` 없이 쓰면 Promise 객체 자체가 참이라 모든 대기가
 * 즉시 통과한다(그러면 "기다렸다"가 거짓말이 된다).
 */
export async function waitFor(predicate, { timeoutMs = 10_000, stepMs = 25 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return null;
}

/** 테스트가 실패해도 감독자·브라우저·소켓이 남지 않게 한다. */
export async function stopAllLive() {
  for (const client of openClients.splice(0)) {
    try {
      client.close();
    } catch {}
  }
  for (const supervisor of running.splice(0)) {
    try {
      await supervisor.stop();
    } catch {}
  }
}
