// #582 S2b — Chromium 런처 (계약 4.2.1·4.8·4.9).
//
// **이 파일의 존재 이유는 fd 소유권이다.** Chromium 을 `--remote-debugging-pipe` 로 띄우면
// 자식의 fd 3(읽기: 우리가 쓰는 쪽)·4(쓰기: 우리가 읽는 쪽)가 CDP 통로가 된다. Chromium 은
// 그 파이프의 EOF 를 "감독자가 죽었다"로 읽고 스스로 종료한다 — 감독자가 SIGKILL 로 죽어도
// 고아 브라우저가 남지 않는 유일한 장치다(4.8).
//
// 그런데 이것은 **부모 쪽 파이프 끝의 유일한 소유자가 감독자일 때만** 성립한다. 다른 자식이
// 그 fd 를 상속하면 감독자가 죽어도 파이프가 열려 있어 Chromium 이 계속 산다. Node 의 공개
// API 로는 사후에 CLOEXEC 를 걸 수 없으므로 규율로 집행한다:
//
//   - 부모 쪽 스트림(`child.stdio[3]`, `[4]`)은 이 클로저 밖으로 **절대** 나가지 않는다.
//     반환 객체는 스트림도 child 객체도 노출하지 않는다(child 를 주면 stdio 배열이 따라간다).
//   - 다른 spawn 은 stdio 를 세 칸 이하로 명시한다. fd 3 이상은 Node 기본이 `ignore` 라
//     명시 목록만 쓰면 상속되지 않는다(테스트가 후손 /proc/<pid>/fd 로 실측한다).
//
// CDP 프레이밍은 `\0` 구분 JSON 이다(remote-debugging-pipe 규약). 길이 접두가 아니다 —
// 소켓 RPC(rpc-framing.mjs)와 다른 규약이라 섞으면 조용히 어긋난다.
import { spawn as nodeSpawn } from "node:child_process";
import { CODES, hostError } from "../errors.mjs";

/** Chromium 이 CDP 파이프로 쓰는 자식 쪽 fd. 바꿀 수 없다(Chromium 이 고정으로 본다). */
export const CDP_PIPE_READ_FD = 3;
export const CDP_PIPE_WRITE_FD = 4;

/** marker 인자 이름. lease 의 nonce 가 값으로 들어가 PID 재사용을 배제한다(4.8). */
export const MARKER_FLAG = "--naia-ego-marker";

export function markerArg(nonce) {
  return `${MARKER_FLAG}=${nonce}`;
}

/**
 * 필요 최소 인자. 하나씩 이유가 있다 — 이유 없는 인자는 넣지 않는다.
 *  --headless=new                사람 화면에 창을 띄우지 않는다(무간섭 1겹, 4.6).
 *  --remote-debugging-pipe       CDP 를 fd 3·4 로. 포트를 열지 않아 loopback 노출이 없다.
 *  --user-data-dir               사람의 프로필과 완전히 분리한다.
 *  --no-first-run                첫 실행 마법사가 뜨면 파이프가 안 열린다.
 *  --no-default-browser-check    기본 브라우저 변경 프롬프트 제거.
 *  --disable-background-networking  에이전트 브라우저가 뒤에서 네트워크를 쓰지 않게.
 *  --naia-ego-marker=<nonce>     소유 표식. Chromium 은 모르는 스위치를 무시한다(실측).
 *
 * @returns {string[]}
 */
export function buildChromeArgs({ profileDir, headless = true, marker = null, extraArgs = [] }) {
  if (!profileDir) throw hostError(CODES.USAGE, "launchBrowser 에 profileDir 이 필요하다");
  const args = [];
  if (headless) args.push("--headless=new");
  args.push(
    "--remote-debugging-pipe",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
  );
  if (marker) args.push(markerArg(marker));
  args.push(...extraArgs);
  return args;
}

/**
 * Chromium 을 띄우고 CDP 백엔드 인터페이스를 돌려준다.
 * 반환 객체는 cdp-mux 의 `backend` 계약(`send`·`onMessage`)을 그대로 만족한다.
 *
 * @param {object} options
 * @param {string} options.executable
 * @param {string} options.profileDir
 * @param {boolean} [options.headless]  기본 true. **false 는 사람 화면에 창을 띄운다** — 계약상 금지이며
 *   테스트·운영 경로에서 쓰지 않는다. 인자로만 남겨 두고 기본값을 바꾸지 않는다.
 * @param {string|null} [options.marker]
 * @param {string[]} [options.extraArgs]
 * @param {Function} [options.spawn]  주입용.
 * @returns {{pid:number, args:string[], executable:string, send(payload:any):void,
 *   onMessage(handler:(raw:string)=>void):void, on(event:string, handler:Function):void,
 *   exited:Promise<{code:number|null,signal:string|null}>, alive():boolean,
 *   kill(signal?:string):void, close():void}}
 */
export function launchBrowser({
  executable,
  profileDir,
  headless = true,
  marker = null,
  extraArgs = [],
  env = process.env,
  spawn = nodeSpawn,
} = {}) {
  if (!executable) throw hostError(CODES.USAGE, "launchBrowser 에 executable 이 필요하다");
  const args = buildChromeArgs({ profileDir, headless, marker, extraArgs });

  let child;
  try {
    child = spawn(executable, args, {
      // 정확히 다섯 칸. 3·4 만 파이프이며 그 스트림은 이 클로저를 벗어나지 않는다(4.8).
      stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
      env,
      shell: false,
      windowsHide: true,
    });
  } catch (error) {
    throw hostError(CODES.BROWSER_LAUNCH_FAILED, `Chromium 실행 실패: ${error.message}`);
  }

  // ── 이 두 스트림이 파이프의 부모 쪽 끝이다. 아래 클로저 밖으로 나가지 않는다. ──
  const pipeWrite = child.stdio[CDP_PIPE_READ_FD]; // 자식이 읽는 쪽 = 우리가 쓴다
  const pipeRead = child.stdio[CDP_PIPE_WRITE_FD]; // 자식이 쓰는 쪽 = 우리가 읽는다
  if (!pipeWrite || !pipeRead) {
    try {
      child.kill("SIGKILL");
    } catch {}
    throw hostError(
      CODES.BROWSER_LAUNCH_FAILED,
      "fd 3·4 파이프가 열리지 않았다. Flatpak 처럼 샌드박스된 브라우저는 추가 fd 를 넘기지 못한다(#582 계약 12절).",
    );
  }

  const handlers = { message: [], exit: [], "pipe-eof": [], error: [], stderr: [] };
  function emit(event, ...payload) {
    for (const handler of handlers[event] ?? []) {
      try {
        handler(...payload);
      } catch {
        /* 구독자의 실패가 감독자를 끌고 내려가지 않는다 */
      }
    }
  }

  // `\0` 구분 JSON. 한 chunk 에 여러 개가 붙어 오고 한 개가 여러 chunk 로 쪼개져 온다.
  let buffer = Buffer.alloc(0);
  pipeRead.on("data", (chunk) => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    let index;
    while ((index = buffer.indexOf(0)) !== -1) {
      const raw = buffer.subarray(0, index).toString("utf8");
      buffer = buffer.subarray(index + 1);
      if (raw.length > 0) emit("message", raw);
    }
  });
  let pipeEnded = false;
  pipeRead.on("end", () => {
    pipeEnded = true;
    emit("pipe-eof");
  });
  pipeRead.on("error", () => {
    /* 종료 중 EPIPE 는 exit 가 말해 준다 */
  });
  pipeWrite.on("error", () => {
    /* 상동 */
  });

  child.stderr?.on("data", (chunk) => emit("stderr", String(chunk)));
  child.stdout?.on("data", () => {});

  /** 파이프 스트림을 확실히 닫는다. 열린 채로 두면 이벤트 루프가 비지 않아 감독자가 종료하지 못한다. */
  function disposePipes() {
    for (const stream of [pipeWrite, pipeRead]) {
      try {
        stream.destroy();
      } catch {}
    }
  }

  let exitInfo = null;
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      exitInfo = { code, signal };
      // Chromium 이 나갔으면 파이프는 쓸모가 없다. 붙잡고 있으면 프로세스가 안 끝난다.
      disposePipes();
      emit("exit", exitInfo);
      resolve(exitInfo);
    });
  });
  child.once("error", (error) => emit("error", error));

  return {
    pid: child.pid,
    args,
    executable,
    profileDir,
    exited,
    alive() {
      return exitInfo === null;
    },
    pipeClosed() {
      return pipeEnded;
    },
    /** cdp-mux 가 부르는 동기 송신. 문자열이든 객체든 받는다. 실패는 동기 throw 다(ABI 1). */
    send(payload) {
      if (exitInfo !== null) throw hostError(CODES.BROWSER_GONE, "Chromium 이 이미 종료했다");
      const text = typeof payload === "string" ? payload : JSON.stringify(payload);
      pipeWrite.write(text);
      pipeWrite.write("\0");
    },
    onMessage(handler) {
      handlers.message.push(handler);
    },
    on(event, handler) {
      if (!handlers[event]) throw hostError(CODES.USAGE, `알 수 없는 런처 이벤트: ${event}`);
      handlers[event].push(handler);
    },
    kill(signal = "SIGKILL") {
      try {
        child.kill(signal);
      } catch {}
    },
    /** 파이프를 닫는다 = Chromium 에게 EOF 를 준다 = 스스로 종료한다. */
    close() {
      try {
        pipeWrite.end();
      } catch {}
      try {
        pipeRead.destroy();
      } catch {}
    },
    /** 남은 스트림 핸들까지 걷어낸다. 종료 경로의 마지막 한 줄이다. */
    dispose: disposePipes,
  };
}
