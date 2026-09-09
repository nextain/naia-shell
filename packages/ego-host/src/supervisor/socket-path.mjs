// #582 S2a — loopback 소켓 경로 결정. **OS 분기는 이 파일과 bin/ego-browser.mjs 에만 둔다.**
// 다른 모듈이 `process.platform` 을 보기 시작하면 세 OS 의 차이가 코드 전체로 번지고,
// 그때부터는 "리눅스에서만 돌던 것"을 나중에 발견하게 된다.
//
// linux·darwin: unix 도메인 소켓. **경로 길이 상한이 있다** — sockaddr_un.sun_path 가
//   리눅스 108, macOS 104 바이트다. 넘기면 bind 가 ENAMETOOLONG 이나 조용한 절단으로 죽는다.
//   그래서 ADK 경로를 그대로 쓰지 않고 짧은 런타임 디렉터리 + ADK 해시로 이름을 만든다.
// win32: named pipe. 파일 시스템 경로가 아니라 `\\.\pipe\<name>` 이름공간이며 길이 제한이
//   실질적으로 없고 디렉터리를 만들 필요도 없다.
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** unix 소켓 경로의 안전 상한. macOS(104)를 기준으로 잡아 세 OS 를 한 값으로 덮는다. */
export const UNIX_SOCKET_PATH_MAX = 104;

export const PIPE_PREFIX = "\\\\.\\pipe\\";

export const SOCKET_NAME_PREFIX = "naia-ego-host-";

/** ADK 루트를 짧고 안정적인 이름 조각으로 만든다. 경로 문자열을 그대로 쓰면 상한을 넘는다. */
export function adkHash(adkRoot) {
  return createHash("sha256").update(String(adkRoot)).digest("hex").slice(0, 12);
}

/**
 * 감독자 소켓 경로.
 *
 * @param {object} options
 * @param {string} options.adkRoot   ADK 루트. 이름의 유일성은 여기서 온다.
 * @param {string} [options.platform]  기본 `process.platform`. 테스트가 세 값을 주입한다.
 * @param {string} [options.runtimeDir]  unix 계열에서 쓸 짧은 디렉터리. 기본은 XDG 런타임 → tmpdir.
 * @param {object} [options.env]
 * @returns {{path: string, kind: "unix"|"pipe", dir: string|null}}
 */
export function supervisorSocketPath({
  adkRoot,
  platform = process.platform,
  runtimeDir = null,
  env = process.env,
} = {}) {
  if (!adkRoot) throw new Error("supervisorSocketPath 에 adkRoot 가 필요하다");
  const name = `${SOCKET_NAME_PREFIX}${adkHash(adkRoot)}`;
  if (platform === "win32") {
    // named pipe 는 디렉터리가 없다. 경로 구분자도 이 한 줄 밖으로 새지 않는다.
    return { path: `${PIPE_PREFIX}${name}`, kind: "pipe", dir: null };
  }
  // linux·darwin·그 밖의 POSIX. XDG_RUNTIME_DIR 은 보통 /run/user/<uid> 로 짧다.
  const dir = runtimeDir || env.XDG_RUNTIME_DIR || tmpdir();
  const path = join(dir, `${name}.sock`);
  if (Buffer.byteLength(path, "utf8") > UNIX_SOCKET_PATH_MAX) {
    throw new Error(
      `unix 소켓 경로가 상한 ${UNIX_SOCKET_PATH_MAX}바이트를 넘었다(${Buffer.byteLength(path, "utf8")}): ${path}\n` +
        "  더 짧은 runtimeDir 을 주거나 XDG_RUNTIME_DIR 을 설정한다",
    );
  }
  return { path, kind: "unix", dir };
}

/** 소켓 파일을 지워야 하는가. named pipe 는 파일이 아니라 지울 것이 없다. */
export function socketNeedsUnlink(kind) {
  return kind === "unix";
}
