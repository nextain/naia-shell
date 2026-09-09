// #582 S2b — 브라우저 후보 탐색 (계약 4.9 OS 행렬, 12절 Flatpak).
// 세 OS 를 이 머신에서 검증한다: platform·env·fs 를 전부 주입한다.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EXPLICIT_ENV,
  WINDOWS_APP_PATHS_KEYS,
  browserCandidates,
  discoverBrowser,
  playwrightRoot,
} from "../src/supervisor/browser-discovery.mjs";

/** 존재한다고 선언한 경로만 있는 가짜 파일 시스템. 디렉터리 목록도 표로 준다. */
function fakeFs({ files = [], dirs = {}, contents = {} } = {}) {
  const set = new Set(files);
  return {
    existsSync: (p) => set.has(p),
    readdirSync: (p) => {
      if (!dirs[p]) throw new Error(`ENOENT ${p}`);
      return dirs[p];
    },
    readFileSync: (p) => {
      if (!(p in contents)) throw new Error(`ENOENT ${p}`);
      return contents[p];
    },
  };
}

test("탐색: 리눅스 후보 순서는 Playwright chromium → chromium → google-chrome 이다", () => {
  const env = { HOME: "/home/u", PATH: "/usr/bin:/usr/local/bin" };
  const fs = fakeFs({
    files: [
      "/home/u/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
      "/usr/bin/chromium",
      "/usr/bin/google-chrome",
    ],
    dirs: { "/home/u/.cache/ms-playwright": ["chromium-1234", "ffmpeg-1011"] },
  });
  const ids = browserCandidates({ platform: "linux", env, fs }).map((c) => c.id);
  assert.deepEqual(ids, ["playwright:chromium-1234", "path:chromium", "path:google-chrome"]);
  assert.equal(
    discoverBrowser({ platform: "linux", env, fs }).executable,
    "/home/u/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
  );
});

test("탐색: Playwright 빌드가 여럿이면 문자열이 아니라 숫자로 최신을 고른다", () => {
  const env = { HOME: "/home/u", PATH: "" };
  const fs = fakeFs({
    files: [
      "/home/u/.cache/ms-playwright/chromium-999/chrome-linux64/chrome",
      "/home/u/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
    ],
    dirs: { "/home/u/.cache/ms-playwright": ["chromium-999", "chromium-1234"] },
  });
  assert.match(discoverBrowser({ platform: "linux", env, fs }).executable, /chromium-1234/);
});

test("탐색: 리눅스 Playwright 는 chrome-linux64 와 옛 chrome-linux 두 배치를 모두 본다", () => {
  const env = { HOME: "/home/u", PATH: "" };
  const fs = fakeFs({
    files: ["/home/u/.cache/ms-playwright/chromium-1100/chrome-linux/chrome"],
    dirs: { "/home/u/.cache/ms-playwright": ["chromium-1100"] },
  });
  assert.equal(
    discoverBrowser({ platform: "linux", env, fs }).executable,
    "/home/u/.cache/ms-playwright/chromium-1100/chrome-linux/chrome",
  );
});

test("탐색: 명시 경로 EGO_HOST_BROWSER 가 Playwright 보다 먼저다", () => {
  const env = { HOME: "/home/u", PATH: "/usr/bin", [EXPLICIT_ENV]: "/opt/my-chrome" };
  const fs = fakeFs({
    files: ["/opt/my-chrome", "/home/u/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome"],
    dirs: { "/home/u/.cache/ms-playwright": ["chromium-1234"] },
  });
  const result = discoverBrowser({ platform: "linux", env, fs });
  assert.equal(result.executable, "/opt/my-chrome");
  assert.equal(result.candidate.kind, "explicit");
});

test("탐색: 명시 경로가 없는 파일이면 조용히 다음 후보로 넘어가지 않고 형식 있는 오류다", () => {
  const env = { HOME: "/home/u", PATH: "", [EXPLICIT_ENV]: "/opt/gone" };
  const fs = fakeFs({
    files: ["/home/u/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome"],
    dirs: { "/home/u/.cache/ms-playwright": ["chromium-1234"] },
  });
  assert.throws(() => discoverBrowser({ platform: "linux", env, fs }), (error) => {
    assert.equal(error.error_code, "EGO_HOST_BROWSER_NOT_FOUND");
    assert.match(error.message, /\/opt\/gone/);
    return true;
  });
});

test("탐색: Flatpak Chrome 은 감지되지만 기본 후보에서 빠진다 (계약 12절)", () => {
  const env = { HOME: "/home/u", PATH: "/usr/bin" };
  const fs = fakeFs({
    files: ["/var/lib/flatpak/app/com.google.Chrome"],
    dirs: {},
  });
  const candidates = browserCandidates({ platform: "linux", env, fs });
  const flatpak = candidates.find((c) => c.kind === "flatpak");
  assert.ok(flatpak, "Flatpak Chrome 이 감지돼야 한다");
  assert.equal(flatpak.usable, false);
  assert.match(flatpak.note, /파이프 전달이 막힐 수 있음/);
  // 쓸 수 있는 후보가 하나도 없으므로 탐색은 실패한다 — Flatpak 을 몰래 쓰지 않는다.
  assert.throws(() => discoverBrowser({ platform: "linux", env, fs }), /찾지 못했다/);
});

test("탐색: PATH 의 google-chrome 이 flatpak 래퍼면 이름이 아니라 내용으로 걸러낸다", () => {
  const env = { HOME: "/home/u", PATH: "/home/u/.local/bin" };
  const fs = fakeFs({
    files: ["/home/u/.local/bin/google-chrome"],
    dirs: {},
    contents: { "/home/u/.local/bin/google-chrome": '#!/bin/bash\nexec flatpak run com.google.Chrome "$@"\n' },
  });
  const candidates = browserCandidates({ platform: "linux", env, fs });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].kind, "flatpak");
  assert.equal(candidates[0].usable, false);
});

test("탐색: win32 후보는 Playwright → Edge → Chrome 이고 경로 구분자가 역슬래시다", () => {
  const env = {
    USERPROFILE: "C:\\Users\\u",
    LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
  };
  const fs = fakeFs({
    files: [
      "C:\\Users\\u\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win\\chrome.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    ],
    dirs: { "C:\\Users\\u\\AppData\\Local\\ms-playwright": ["chromium-1234"] },
  });
  const candidates = browserCandidates({ platform: "win32", env, fs });
  assert.deepEqual(candidates.map((c) => c.id), ["playwright:chromium-1234", "win:edge", "win:chrome"]);
  assert.equal(
    discoverBrowser({ platform: "win32", env, fs }).executable,
    "C:\\Users\\u\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win\\chrome.exe",
  );
  assert.equal(playwrightRoot("win32", env), "C:\\Users\\u\\AppData\\Local\\ms-playwright");
});

test("탐색: 레지스트리 App Paths 는 이번 슬라이스에서 조회하지 않고 상수로만 있다", () => {
  assert.equal(WINDOWS_APP_PATHS_KEYS.length, 2);
  for (const key of WINDOWS_APP_PATHS_KEYS) assert.match(key, /App Paths/);
  // 상수는 후보 목록에 섞이지 않는다 — 조회하지 않았다는 사실이 목록으로 드러나야 한다.
  const fs = fakeFs({ files: [], dirs: {} });
  const ids = browserCandidates({ platform: "win32", env: { USERPROFILE: "C:\\Users\\u" }, fs }).map((c) => c.id);
  assert.deepEqual(ids, []);
});

test("탐색: darwin 후보는 Playwright → Google Chrome → Edge → Chromium 이다", () => {
  const env = { HOME: "/Users/u" };
  const fs = fakeFs({
    files: [
      "/Users/u/Library/Caches/ms-playwright/chromium-1234/chrome-mac/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ],
    dirs: { "/Users/u/Library/Caches/ms-playwright": ["chromium-1234"] },
  });
  assert.deepEqual(browserCandidates({ platform: "darwin", env, fs }).map((c) => c.id), [
    "playwright:chromium-1234",
    "mac:chrome",
    "mac:edge",
    "mac:chromium",
  ]);
});

test("탐색: darwin 에 Playwright 가 없으면 /Applications 의 Google Chrome 을 고른다", () => {
  const env = { HOME: "/Users/u" };
  const fs = fakeFs({
    files: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
    dirs: {},
  });
  assert.equal(
    discoverBrowser({ platform: "darwin", env, fs }).executable,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  );
});

test("탐색: 이 머신(linux)에서 실제로 Chromium 을 찾는다 — 없으면 RED", () => {
  const found = discoverBrowser({});
  assert.ok(found.executable.length > 0);
  assert.equal(found.candidate.kind, "playwright");
});
