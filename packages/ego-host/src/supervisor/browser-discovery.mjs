// #582 S2b — 브라우저 후보 탐색 (계약 4.9 OS 행렬, 12절 Flatpak 위험).
//
// 이 파일은 **세 OS 를 이 머신에서 검증할 수 있게** 순수하게 짰다. `platform`·`env`·`fs` 를
// 전부 주입받고, 경로 조립도 주입된 platform 에 맞는 path 구현(win32/posix)을 고른다.
// 그래서 리눅스에서 win32·darwin 후보 목록을 그대로 만들어 볼 수 있다.
// (실행 실측은 linux 뿐이다 — win32·darwin 은 후보 형태까지만이며 미실측이다.)
//
// 순서의 이유:
//  1. `EGO_HOST_BROWSER` — 사람이 명시했으면 그 말이 이긴다.
//  2. Playwright chromium — 우리가 실제로 실측한 바이너리다. `--remote-debugging-pipe` 가
//     도는 것을 확인한 유일한 후보이므로 기본값이다.
//  3. 시스템 Chromium/Chrome/Edge — 있으면 쓴다.
//  4. Flatpak Chrome — **감지만 한다.** 샌드박스가 fd 3·4 전달을 막을 수 있어(계약 12절)
//     기본 후보에서 뺀다. 감지 사실은 남겨 사람이 "설치돼 있는데 왜 안 쓰나"를 묻지 않게 한다.
import {
  existsSync as nodeExistsSync,
  readFileSync as nodeReadFileSync,
  readdirSync as nodeReaddirSync,
} from "node:fs";
import { posix as posixPath, win32 as win32Path } from "node:path";
import { CODES, hostError } from "../errors.mjs";

/** 명시 경로 환경 변수. 있으면 다른 후보를 보지 않는다. */
export const EXPLICIT_ENV = "EGO_HOST_BROWSER";

/**
 * Windows 레지스트리 App Paths 키. **이번 슬라이스는 조회하지 않는다** — 경로 상수만 둔다.
 * 레지스트리 조회는 windows4060 게이트에서 실측과 함께 들어온다(계약 4.9·12절).
 */
export const WINDOWS_APP_PATHS_KEYS = Object.freeze([
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe",
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe",
]);

/** Flatpak Chrome 이 설치돼 있는지 보는 자리. 감지만 하고 후보로는 쓰지 않는다. */
export const FLATPAK_CHROME_DIRS = Object.freeze([
  "/var/lib/flatpak/app/com.google.Chrome",
  "/var/lib/flatpak/app/com.google.ChromeDev",
]);

export const FLATPAK_NOTE =
  "감지되나 파이프 전달이 막힐 수 있음 — Flatpak 샌드박스가 fd 3·4 를 넘겨주지 못할 수 있어 " +
  "기본 후보에서 제외한다(#582 계약 12절). 쓰려면 EGO_HOST_BROWSER 로 명시한다.";

function pathFor(platform) {
  return platform === "win32" ? win32Path : posixPath;
}

function homeOf(platform, env) {
  return platform === "win32" ? env.USERPROFILE || env.HOME || "" : env.HOME || "";
}

/** Playwright 캐시 루트. 세 OS 가 서로 다른 곳에 둔다. */
export function playwrightRoot(platform, env) {
  if (env.PLAYWRIGHT_BROWSERS_PATH) return env.PLAYWRIGHT_BROWSERS_PATH;
  const path = pathFor(platform);
  const home = homeOf(platform, env);
  if (!home) return null;
  if (platform === "win32") {
    const local = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    return path.join(local, "ms-playwright");
  }
  if (platform === "darwin") return path.join(home, "Library", "Caches", "ms-playwright");
  return path.join(home, ".cache", "ms-playwright");
}

/**
 * Playwright 설치본의 실행 파일 상대 경로. 배포판마다 디렉터리 이름이 다르다.
 * 리눅스는 예전 `chrome-linux` 와 지금 `chrome-linux64` 가 둘 다 돌아다닌다 — 이 머신은 후자다.
 */
function playwrightRelatives(platform) {
  if (platform === "win32") return [["chrome-win", "chrome.exe"]];
  if (platform === "darwin") {
    return [
      ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"],
      ["chrome-mac-arm64", "Chromium.app", "Contents", "MacOS", "Chromium"],
    ];
  }
  return [
    ["chrome-linux64", "chrome"],
    ["chrome-linux", "chrome"],
  ];
}

/** `chromium-1234` 에서 1234. 정렬은 숫자로 한다 — 문자열 정렬이면 999 가 1234 를 이긴다. */
function buildNumber(name) {
  const m = /^chromium-(\d+)$/.exec(name);
  return m ? Number(m[1]) : null;
}

function playwrightCandidates(platform, env, fs) {
  const root = playwrightRoot(platform, env);
  if (!root) return [];
  let entries = [];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return [];
  }
  const path = pathFor(platform);
  const builds = entries
    .map((name) => ({ name, build: buildNumber(String(name)) }))
    .filter((e) => e.build !== null)
    .sort((a, b) => b.build - a.build); // 최신 빌드부터
  const out = [];
  for (const { name, build } of builds) {
    for (const rel of playwrightRelatives(platform)) {
      out.push({
        id: `playwright:${name}`,
        kind: "playwright",
        path: path.join(root, name, ...rel),
        build,
        usable: true,
      });
    }
  }
  return out;
}

/** PATH 를 직접 훑는다. `which` 를 부르지 않는 이유: 주입된 platform·fs 로 세 OS 를 검증해야 한다. */
function fromPath(platform, env, fs, name) {
  const path = pathFor(platform);
  const sep = platform === "win32" ? ";" : ":";
  const raw = env.PATH || env.Path || "";
  for (const dir of raw.split(sep)) {
    if (!dir) continue;
    const full = path.join(dir, name);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

/**
 * PATH 의 `google-chrome` 이 실은 `exec flatpak run com.google.Chrome "$@"` 두 줄짜리 래퍼인
 * 기계가 있다(이 머신이 그렇다). 그대로 spawn 하면 Chromium 이 아니라 flatpak 이 뜨고
 * fd 3·4 는 샌드박스 경계에서 사라진다. 그래서 **경로 이름이 아니라 내용**으로 판별한다.
 */
function isFlatpakWrapper(fs, full) {
  if (typeof fs.readFileSync !== "function") return false;
  try {
    const head = String(fs.readFileSync(full)).slice(0, 512);
    return /flatpak\s+run/.test(head);
  } catch {
    return false; // 바이너리거나 읽을 수 없으면 래퍼가 아니다.
  }
}

function linuxCandidates(env, fs) {
  const out = [];
  for (const name of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
    const found = fromPath("linux", env, fs, name);
    if (!found) continue;
    if (isFlatpakWrapper(fs, found)) {
      out.push({ id: `path:${name}`, kind: "flatpak", path: found, usable: false, note: FLATPAK_NOTE });
      continue;
    }
    out.push({ id: `path:${name}`, kind: "system", path: found, usable: true });
  }
  for (const dir of FLATPAK_CHROME_DIRS) {
    if (fs.existsSync(dir)) {
      out.push({ id: `flatpak:${dir}`, kind: "flatpak", path: dir, usable: false, note: FLATPAK_NOTE });
    }
  }
  return out;
}

function win32Candidates(env, fs) {
  const path = win32Path;
  const programFiles = env["ProgramFiles"] || "C:\\Program Files";
  const programFilesX86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const localAppData = env.LOCALAPPDATA || path.join(env.USERPROFILE || "C:\\Users\\user", "AppData", "Local");
  const specs = [
    ["edge", path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe")],
    ["edge", path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe")],
    ["chrome", path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe")],
    ["chrome", path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe")],
    ["chrome", path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe")],
  ];
  return specs
    .filter(([, full]) => fs.existsSync(full))
    .map(([name, full]) => ({ id: `win:${name}`, kind: "system", path: full, usable: true }));
}

function darwinCandidates(env, fs) {
  const specs = [
    ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "chrome"],
    ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "edge"],
    ["/Applications/Chromium.app/Contents/MacOS/Chromium", "chromium"],
  ];
  return specs
    .filter(([full]) => fs.existsSync(full))
    .map(([full, name]) => ({ id: `mac:${name}`, kind: "system", path: full, usable: true }));
}

/**
 * 이 플랫폼에서 실제로 존재하는 후보 전부를 계약 4.9 의 순서대로.
 * 존재하지 않는 경로는 목록에 넣지 않는다(목록 = "여기 있다"는 뜻이어야 한다).
 *
 * @param {object} options
 * @param {string} [options.platform]
 * @param {Record<string,string|undefined>} [options.env]
 * @param {{existsSync(p:string):boolean, readdirSync(p:string):string[]}} [options.fs]
 * @returns {Array<{id:string, kind:string, path:string, usable:boolean, note?:string}>}
 */
export function browserCandidates({
  platform = process.platform,
  env = process.env,
  fs = { existsSync: nodeExistsSync, readdirSync: nodeReaddirSync, readFileSync: nodeReadFileSync },
} = {}) {
  const out = [];
  const explicit = env[EXPLICIT_ENV];
  if (explicit) {
    out.push({
      id: "explicit",
      kind: "explicit",
      path: explicit,
      usable: true,
      exists: fs.existsSync(explicit),
    });
  }
  for (const candidate of playwrightCandidates(platform, env, fs)) {
    if (fs.existsSync(candidate.path)) out.push(candidate);
  }
  if (platform === "win32") out.push(...win32Candidates(env, fs));
  else if (platform === "darwin") out.push(...darwinCandidates(env, fs));
  else out.push(...linuxCandidates(env, fs));
  return out;
}

/**
 * 첫 실행 가능 후보. 없으면 형식 있는 오류를 던진다(조용한 null 은 나중에 어디서 죽었는지 못 찾는다).
 *
 * @returns {{executable:string, candidate:object, candidates:object[]}}
 */
export function discoverBrowser({
  platform = process.platform,
  env = process.env,
  fs = { existsSync: nodeExistsSync, readdirSync: nodeReaddirSync, readFileSync: nodeReadFileSync },
} = {}) {
  const candidates = browserCandidates({ platform, env, fs });
  const explicit = candidates.find((c) => c.kind === "explicit");
  if (explicit) {
    if (explicit.exists === false) {
      throw hostError(
        CODES.BROWSER_NOT_FOUND,
        `${EXPLICIT_ENV} 가 가리키는 브라우저가 없다: ${explicit.path}`,
      );
    }
    return { executable: explicit.path, candidate: explicit, candidates };
  }
  const usable = candidates.find((c) => c.usable);
  if (!usable) {
    const seen = candidates.map((c) => `${c.id} (${c.note ? "제외" : "?"})`).join(", ") || "없음";
    throw hostError(
      CODES.BROWSER_NOT_FOUND,
      `${platform} 에서 쓸 수 있는 Chromium 계열 브라우저를 찾지 못했다. 감지된 것: ${seen}\n` +
        `  Playwright chromium 을 설치하거나 ${EXPLICIT_ENV} 로 실행 파일을 지정한다.`,
    );
  }
  return { executable: usable.path, candidate: usable, candidates };
}
