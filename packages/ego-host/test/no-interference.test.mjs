// #582 S2e — 무간섭 세 겹 (계약 4.6).
//
// 재는 일은 `helpers/no-interference-probe.mjs` 가 **디스플레이 안에서** 한다(활성 창은 그
// 디스플레이에 붙은 프로세스만 볼 수 있다). 이 파일은 탐침을 띄우고 결과를 판정한다.
//
// 디스플레이 수단은 `helpers/x-display.mjs` 가 고른다: Xvfb 가 있으면 Xvfb, 없으면 `cage` 의
// wlroots 헤드리스 백엔드. 둘 다 없거나 `xdotool` 이 없으면 **RED** 다 — 건너뛰지 않는다.
// 어느 쪽을 썼는지는 테스트 출력에 남는다(증거 문서가 그 값을 적는다).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { resolveDisplayHarness } from "./helpers/x-display.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE = join(HERE, "helpers", "no-interference-probe.mjs");

/** 탐침 하나를 디스플레이 안에서 돌리고 결과 JSON 을 읽는다. */
function runProbe(harness, { timeoutMs = 180_000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ego-ni-"));
  const outPath = join(dir, "result.json");
  const inner = [process.execPath, PROBE, outPath];
  return new Promise((resolve, reject) => {
    const child = spawn(harness.command, harness.args(inner), {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...harness.env,
        // 탐침 안의 브라우저가 사람의 세션으로 새지 않게 한다.
        DISPLAY: harness.kind === "xvfb" ? process.env.DISPLAY : undefined,
        WAYLAND_DISPLAY: undefined,
        NODE_TEST_CONTEXT: undefined,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`탐침이 ${timeoutMs}ms 안에 끝나지 않았다\n${stdout}\n${stderr}`));
    }, timeoutMs);
    child.on("close", () => {
      clearTimeout(timer);
      let payload;
      try {
        payload = JSON.parse(readFileSync(outPath, "utf8"));
      } catch (error) {
        reject(
          new Error(
            `탐침이 결과를 남기지 않았다(${error.message})\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
          ),
        );
        return;
      }
      rmSync(dir, { recursive: true, force: true });
      resolve({ payload, stdout, stderr });
    });
  });
}

test(
  "헤드리스 인자·활성 창 불변·감독자 트리 창 0 (Xvfb·cage·xdotool 부재 = RED)",
  { timeout: 240_000 },
  async () => {
    // 수단이 없으면 여기서 던진다. 건너뛴 검사는 초록으로 보이고, 초록으로 보이는 미검증은
    // 나중에 "검증했다"로 보고된다.
    const harness = resolveDisplayHarness();
    console.log(`[무간섭] 디스플레이 수단: ${harness.label}`);

    const { payload, stdout, stderr } = await runProbe(harness);
    assert.equal(payload.ok, true, `탐침 실패: ${payload.error}\n${payload.stack}\n${stderr}`);
    for (const note of payload.notes ?? []) console.log(`[무간섭] ${note}`);

    // ── 1겹: 실제 프로세스의 명령줄 ──────────────────────────────────────────
    assert.ok(
      payload.headlessArgs.args.includes("--headless=new"),
      `Chromium 명령줄에 헤드리스 인자가 없다: ${payload.headlessArgs.args.join(" ")}`,
    );

    // 그리고 에이전트가 실제로 일했다 — 아무 일도 안 했으면 "창이 안 떴다"는 공허하다.
    assert.ok(payload.work.refs > 0, "스냅샷이 비었다 — 실제 작업 없이 잰 무간섭은 의미가 없다");
    assert.ok(payload.work.screenshot, "캡처가 없다");

    // ── 2겹: 활성 창 전후 동일 (+ 계기가 살아 있음) ────────────────────────
    const instrument = payload.activeWindowInstrument;
    assert.ok(instrument.anchor, "디스플레이에 기준 창이 없다");
    assert.notEqual(
      instrument.moved,
      instrument.anchor,
      "창을 더 띄웠는데 활성 창이 안 바뀌었다 — 이 검사는 죽어 있다",
    );
    assert.equal(
      payload.activeWindow.after,
      payload.activeWindow.before,
      `호스트 동작 전후로 활성 창이 바뀌었다: ${payload.activeWindow.before} → ${payload.activeWindow.after}`,
    );

    // ── 3겹: 감독자 트리 창 0 (+ 계기가 살아 있음) ─────────────────────────
    assert.ok(
      payload.windowSearchInstrument.windows.length > 0,
      "창 있는 모드의 Chromium 조차 못 찾았다 — 창 소유 검사가 죽어 있다",
    );
    assert.ok(payload.tree.size > 1, `감독자 트리가 비었다: ${JSON.stringify(payload.tree)}`);
    assert.deepEqual(
      payload.tree.owners,
      [],
      `감독자 트리의 프로세스가 창을 갖고 있다: ${JSON.stringify(payload.tree.owners)}`,
    );

    if (stdout.trim()) console.log(`[무간섭] 탐침 stdout 마지막 줄: ${stdout.trim().split("\n").at(-1)}`);
  },
);
