/**
 * 벤더 설치 테스트 (#582 S1).
 *
 * 확인하는 것은 넷이다.
 *  (a) 벤더 트리가 고정 커밋과 바이트 단위로 같다 (--check 종료 코드 0), 그리고
 *      실제로 어긋나면 --check 가 실패한다(변조 탐침).
 *  (b) 벤더의 package/ego-browser 를 임의 디렉터리에 복사해 npm ci → build → test 가
 *      0 으로 끝난다. 네트워크가 없으면 건너뛰지 않고 이유를 출력하며 실패한다.
 *  (c) 생성된 bin 을 아무 상관 없는 디렉터리에서 실행해도 돌고, 호스트가 없으니
 *      "browser runtime is not available" 로 0 이 아닌 코드로 끝난다.
 *  (d) EGO_BROWSER_AGENT_WORKSPACE 를 주면 학습 루트가 그 아래로 잡힌다.
 *
 * (b) 는 느리다(설치+빌드+299건). (c)(d) 는 (b) 가 만든 스테이지를 재사용하므로
 * node:test 의 기본 순차 실행에 의존한다.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import test, { after } from "node:test";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SYNC_SCRIPT = join(PKG_ROOT, "scripts", "sync-ego-lite.mjs");
const VENDOR_ROOT = join(PKG_ROOT, "vendor", "ego-lite");
const VENDOR_RUNTIME = join(VENDOR_ROOT, "package", "ego-browser");
/**
 * 벤더 런타임의 빌드는 package/ego-browser 의 두 단계 위를 저장소 루트로 보고 거기서
 * skills/ego-browser 를 찾아 dist/out/ego-browser 로 복사한다
 * (vendor/ego-lite/package/ego-browser/scripts/build.mjs:25, :30, :89).
 * 그래서 스테이징도 그 상대 위치를 그대로 재현해야 한다 — 런타임 하나만 떼어 내면
 * 빌드가 ENOENT 로 죽는다. "임의 디렉터리"는 위치가 자유롭다는 뜻이지 구조를 무시해도
 * 된다는 뜻이 아니다.
 */
const STAGED_SUBTREES = [
  "package/ego-browser",
  "skills/ego-browser",
  // test/skill-publish-workflow.test.js:6-12 가 저장소 루트의 이 워크플로 파일을 읽는다.
  ".github/workflows/publish-ego-browser-skill.yml",
];

const scratchDirs = [];
function scratch(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * 자식 프로세스용 환경. `NODE_TEST_CONTEXT` 를 반드시 지운다 — 이 변수가 상속되면
 * 벤더의 `node --test` 가 자기를 "테스트 러너의 자식"으로 보고 리포터를 직렬화 형식으로
 * 바꿔서 사람이 읽는 요약(`pass N`)이 사라진다. 종료 코드는 그대로라 조용히 어긋난다.
 */
function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function runSync(args) {
  return spawnSync(process.execPath, [SYNC_SCRIPT, ...args], {
    cwd: PKG_ROOT,
    encoding: "utf8",
  });
}

/** 실패 시 왜 실패했는지 보여준다. 조용한 실패는 게이트가 아니다. */
function reportAndAssert(label, result, expected = 0) {
  if (result.status !== expected) {
    console.error(`\n--- ${label} stdout ---\n${result.stdout ?? ""}`);
    console.error(`--- ${label} stderr ---\n${result.stderr ?? ""}`);
  }
  assert.equal(
    result.status,
    expected,
    `${label} 이(가) 종료 코드 ${expected} 이어야 한다 (실제 ${result.status})`,
  );
}

// ---------------------------------------------------------------------- (a)

test("(a) sync-ego-lite --check 가 종료 코드 0 으로 끝난다", () => {
  reportAndAssert("sync-ego-lite --check", runSync(["--check"]));
});

test("(a-probe) 벤더 파일이 바뀌면 --check 가 실패한다", () => {
  const target = join(VENDOR_RUNTIME, "src", "browser-runtime.ts");
  const original = readFileSync(target);
  try {
    writeFileSync(target, Buffer.concat([original, Buffer.from("\n// tamper\n")]));
    const result = runSync(["--check"]);
    assert.notEqual(result.status, 0, "수정된 벤더 파일을 --check 가 통과시켰다");
    assert.match(result.stderr, /browser-runtime\.ts/);
  } finally {
    writeFileSync(target, original);
  }
  reportAndAssert("복원 후 --check", runSync(["--check"]));
});

test("(a-probe) 허용 목록 밖 파일이 벤더에 있으면 --check 가 실패한다", () => {
  const stray = join(PKG_ROOT, "vendor", "ego-lite", "docs", "stray.md");
  mkdirSync(dirname(stray), { recursive: true });
  writeFileSync(stray, "허용 목록 밖 파일\n");
  try {
    const result = runSync(["--check"]);
    assert.notEqual(result.status, 0, "허용 목록 밖 파일을 --check 가 통과시켰다");
    assert.match(result.stderr, /허용 목록 밖|MANIFEST 에 없는/);
  } finally {
    rmSync(join(PKG_ROOT, "vendor", "ego-lite", "docs"), {
      recursive: true,
      force: true,
    });
  }
  reportAndAssert("정리 후 --check", runSync(["--check"]));
});

// ---------------------------------------------------------------------- (b)

/** (b) 가 만든 스테이지. (c)(d) 가 재사용한다. */
const stage = { dir: null };

test(
  "(b) 임의 디렉터리에서 npm ci + build + test 가 0 으로 끝난다",
  { timeout: 900_000 },
  () => {
    const stageRoot = join(scratch("ego-vendor-install-"), "ego-lite");
    for (const subtree of STAGED_SUBTREES) {
      const from = join(VENDOR_ROOT, ...subtree.split("/"));
      const to = join(stageRoot, ...subtree.split("/"));
      mkdirSync(dirname(to), { recursive: true });
      cpSync(from, to, { recursive: statSync(from).isDirectory() });
    }
    const dir = join(stageRoot, "package", "ego-browser");
    assert.ok(
      existsSync(join(stageRoot, "skills", "ego-browser", "SKILL.md")),
      "스테이지에 skills/ego-browser 가 없다 — 빌드가 여기를 찾는다",
    );

    const install = spawnSync(
      "npm",
      ["ci", "--prefer-offline", "--ignore-scripts"],
      { cwd: dir, encoding: "utf8", env: childEnv() },
    );
    if (install.status !== 0) {
      console.error(
        "\n[vendor-install] npm ci 실패. 네트워크나 npm 캐시가 없으면 이 테스트는 " +
          "건너뛰지 않고 실패한다 — 벤더 런타임이 실제로 설치되는지가 S1 의 게이트다.",
      );
    }
    reportAndAssert("npm ci --prefer-offline --ignore-scripts", install);

    const build = spawnSync("npm", ["run", "build"], {
      cwd: dir,
      encoding: "utf8",
      env: childEnv({ CI: "true" }),
    });
    reportAndAssert("npm run build", build);

    const unit = spawnSync("npm", ["test"], {
      cwd: dir,
      encoding: "utf8",
      env: childEnv({ CI: "true" }),
    });
    reportAndAssert("npm test", unit);

    const passLine = /^(?:\u2139|#)\s*pass (\d+)\s*$/m.exec(unit.stdout || "");
    assert.ok(passLine, "벤더 npm test 출력에서 'pass N' 요약을 찾지 못했다");
    const failLine = /^(?:\u2139|#)\s*fail (\d+)\s*$/m.exec(unit.stdout || "");
    assert.equal(failLine?.[1], "0", `벤더 단위 테스트 실패 건수: ${failLine?.[1]}`);
    assert.ok(
      Number(passLine[1]) >= 299,
      `벤더 단위 테스트 통과 수가 299 미만이다: ${passLine[1]}`,
    );
    console.log(`[vendor-install] 벤더 단위 테스트 통과 ${passLine[1]}건`);

    const bin = join(dir, "dist", "out", "index.js");
    assert.ok(existsSync(bin), `빌드 산출물 bin 이 없다: ${bin}`);
    stage.dir = dir;
  },
);

// ---------------------------------------------------------------------- (c)

test("(c) bin 이 임의 cwd 에서 돌고 호스트가 없으면 형식이 맞는 오류로 죽는다", () => {
  assert.ok(stage.dir, "(b) 가 스테이지를 만들지 못해 (c) 를 돌릴 수 없다");
  const bin = join(stage.dir, "dist", "out", "index.js");
  const elsewhere = scratch("ego-arbitrary-cwd-");
  assert.ok(
    !resolve(elsewhere).startsWith(resolve(stage.dir) + sep),
    "cwd 가 스테이지 밖이어야 한다",
  );

  const result = spawnSync(process.execPath, [bin], {
    cwd: elsewhere,
    input: "console.log(await browser.listTabs())\n",
    encoding: "utf8",
    env: childEnv({ CI: "true" }),
  });

  assert.notEqual(result.status, 0, "호스트 없이 성공으로 끝났다");
  assert.match(
    result.stderr,
    /browser runtime is not available/,
    `stderr 에 호스트 부재 오류가 없다: ${result.stderr}`,
  );
});

// ---------------------------------------------------------------------- (d)

test("(d) EGO_BROWSER_AGENT_WORKSPACE 가 학습 루트를 결정한다", async () => {
  assert.ok(stage.dir, "(b) 가 스테이지를 만들지 못해 (d) 를 돌릴 수 없다");
  const workspace = scratch("ego-agent-workspace-");
  const moduleUrl = pathToFileURL(
    join(stage.dir, "dist", "src", "learning", "check-domain-learning.js"),
  ).href;

  const before = process.env.EGO_BROWSER_AGENT_WORKSPACE;
  process.env.EGO_BROWSER_AGENT_WORKSPACE = workspace;
  try {
    const { learningsRoot } = await import(moduleUrl);
    assert.equal(typeof learningsRoot, "function", "learningsRoot 를 import 하지 못했다");
    assert.equal(learningsRoot(), join(workspace, "learnings"));
  } finally {
    if (before === undefined) delete process.env.EGO_BROWSER_AGENT_WORKSPACE;
    else process.env.EGO_BROWSER_AGENT_WORKSPACE = before;
  }
});
