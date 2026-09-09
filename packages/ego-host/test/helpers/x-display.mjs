// #582 S2e — 무간섭 검증용 **사람이 안 보는 X 디스플레이**.
//
// 계약 4.6·4.9 는 "Xvfb + xdotool 필수, 없으면 RED" 라고 적는다. 이 머신(linux3090)에는
// `xdotool` 은 있고 **`Xvfb` 는 없다**. 그렇다고 사람의 `:0` 에서 재려고 하면 두 가지가 깨진다.
//
//  - 이 세션은 Wayland 다. `:0` 의 XWayland 에서 `xdotool getactivewindow` 는 이름도 pid 도 없는
//    같은 값(2097152)을 계속 돌려준다 — **바뀔 수 없는 값을 "안 바뀌었다"고 확인하는 죽은
//    안전망**이 된다.
//  - 계기의 살아 있음을 증명하려면 창을 하나 띄워 활성 창이 실제로 바뀌는 것을 봐야 하는데,
//    `:0` 에 창을 띄우는 것은 사람 화면을 건드리는 일이라 금지다.
//
// 그래서 같은 성질의 대체 수단을 쓴다: **`cage` 를 wlroots 헤드리스 백엔드로 띄우고 그 안의
// Xwayland 디스플레이**에서 잰다. 화면 출력이 없으므로 사람은 아무것도 보지 못하고, 그 안에서는
// 창을 띄워 계기가 살아 있음을 증명할 수 있다. `Xvfb` 가 있으면 그쪽을 먼저 쓴다.
//
// 둘 다 없거나 `xdotool` 이 없으면 **RED** 다. 건너뛰지 않는다.
import { spawnSync } from "node:child_process";

export const XDOTOOL = "xdotool";

function has(command) {
  return spawnSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" }).status === 0;
}

/**
 * 이 머신에서 쓸 디스플레이 수단 하나.
 * @returns {{kind:"xvfb"|"cage", command:string, args:(script:string[])=>string[], env:object, label:string}}
 */
export function resolveDisplayHarness() {
  if (!has(XDOTOOL)) {
    throw new Error(
      "xdotool 이 없다. 무간섭 검증(계약 4.6 두 번째 겹)을 할 수 없으므로 RED 다. " +
        "설치: dnf install xdotool",
    );
  }
  if (has("Xvfb") && has("xvfb-run")) {
    return {
      kind: "xvfb",
      label: "xvfb-run (Xvfb 가상 디스플레이)",
      command: "xvfb-run",
      args: (inner) => ["-a", "--server-args=-screen 0 1280x800x24", ...inner],
      env: {},
    };
  }
  if (has("cage")) {
    return {
      kind: "cage",
      label: "cage (wlroots 헤드리스 백엔드 + Xwayland)",
      command: "cage",
      args: (inner) => ["--", ...inner],
      env: {
        WLR_BACKENDS: "headless",
        WLR_RENDERER: "pixman",
        WLR_LIBINPUT_NO_DEVICES: "1",
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? "/run/user/1000",
      },
    };
  }
  throw new Error(
    "사람이 안 보는 X 디스플레이를 만들 수단이 없다(Xvfb 도 cage 도 없다). " +
      "계약 4.6 의 활성 창 검사를 할 수 없으므로 RED 다.",
  );
}

/** `xdotool <args>` 한 번. 실패하면 null(그 자체가 관측값이다). */
export function xdotool(args, { display, timeoutMs = 5_000 } = {}) {
  const result = spawnSync(XDOTOOL, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    env: { ...process.env, DISPLAY: display ?? process.env.DISPLAY },
  });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

/** `xdotool search --pid <pid>` 가 찾은 창 목록. 없으면 빈 배열. */
export function windowsOfPid(pid, options = {}) {
  const out = xdotool(["search", "--pid", String(pid)], options);
  if (!out) return [];
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d+$/.test(line));
}
