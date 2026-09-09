/**
 * #582 S2a — 출처 게이트 `--provenance` (계약 6절).
 *
 * `--check` 는 MANIFEST 와 대조할 뿐이다. 매니페스트·벤더·UPSTREAM.md 를 함께 바꾸면 속는다.
 * 이 게이트는 UPSTREAM.md 의 고정 커밋 트리를 실체화해 **형식·모드·심링크·바이트·누락·추가**를
 * 직접 비교한다. 판정은 종료 코드다.
 *
 * 실체화 출처: 기본은 로컬 클론(네트워크 없이 돌기 위해)이고, 없으면 업스트림 URL 로 간다.
 * 건너뛰지 않는다 — 건너뛴 게이트는 게이트가 아니다.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, chmodSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { sha256File } from "../scripts/sync-ego-lite.mjs";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SYNC_SCRIPT = join(PKG_ROOT, "scripts", "sync-ego-lite.mjs");
const VENDOR_DIR = join(PKG_ROOT, "vendor", "ego-lite");
const MANIFEST = join(VENDOR_DIR, "MANIFEST.sha256");
const TARGET_REL = "package/ego-browser/src/browser-runtime.ts";
const TARGET = join(VENDOR_DIR, ...TARGET_REL.split("/"));

const DEFAULT_LOCAL_CLONE =
  "/tmp/claude-1000/-var-home-luke-alpha-adk/b45721bf-d636-4e1a-b00f-9e68dcd8c4f8/scratchpad/ego-lite";

function provenanceSource() {
  const fromEnv = process.env.EGO_LITE_PROVENANCE_SOURCE;
  if (fromEnv) return fromEnv;
  if (existsSync(DEFAULT_LOCAL_CLONE)) return DEFAULT_LOCAL_CLONE;
  return null; // 업스트림 URL 로 간다(네트워크 필요).
}

function run(args) {
  return spawnSync(process.execPath, [SYNC_SCRIPT, ...args], { cwd: PKG_ROOT, encoding: "utf8" });
}

function provenance() {
  const source = provenanceSource();
  return run(source ? ["--provenance", "--source", source] : ["--provenance"]);
}

/** 벤더를 잠깐 건드렸다가 반드시 되돌린다. 되돌리지 못하면 그 사실이 테스트 실패다. */
function withTamper(mutate, assertions) {
  const original = readFileSync(TARGET);
  const originalMode = lstatSync(TARGET).mode;
  const originalManifest = readFileSync(MANIFEST);
  try {
    mutate();
    assertions();
  } finally {
    rmSync(TARGET, { force: true });
    writeFileSync(TARGET, original);
    chmodSync(TARGET, originalMode);
    writeFileSync(MANIFEST, originalManifest);
  }
  const restored = provenance();
  assert.equal(restored.status, 0, `복원 뒤 --provenance 가 0 이 아니다:\n${restored.stderr}`);
}

test("--provenance 는 손대지 않은 벤더 트리에서 종료 코드 0 이다", () => {
  const result = provenance();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /형식·모드·심링크·바이트까지 같다/);
});

test("--provenance: 바이트 하나가 바뀌면 1 이다", () => {
  withTamper(
    () => writeFileSync(TARGET, Buffer.concat([readFileSync(TARGET), Buffer.from("\n// 한 줄\n")])),
    () => {
      const result = provenance();
      assert.equal(result.status, 1);
      assert.match(result.stderr, /browser-runtime\.ts/);
    },
  );
});

test("--provenance 는 매니페스트까지 함께 위조해도 잡는다 — 이것이 --check 와의 차이다", () => {
  withTamper(
    () => {
      writeFileSync(TARGET, Buffer.concat([readFileSync(TARGET), Buffer.from("\n// 위조\n")]));
      // 매니페스트를 새 해시로 갈아 끼운다. --check 는 이제 속는다.
      const updated = readFileSync(MANIFEST, "utf8")
        .split("\n")
        .map((row) => (row.endsWith(`  ${TARGET_REL}`) ? `${sha256File(TARGET)}  ${TARGET_REL}` : row))
        .join("\n");
      writeFileSync(MANIFEST, updated);
    },
    () => {
      assert.equal(run(["--check"]).status, 0, "--check 가 위조를 잡았다면 이 게이트의 근거가 바뀐 것이다");
      const result = provenance();
      assert.equal(result.status, 1, "출처 게이트가 매니페스트 위조를 통과시켰다");
      assert.match(result.stderr, /바이트가 다르다|크기가 다르다/);
    },
  );
});

test("--provenance: 실행 비트가 바뀌면 1 이다", () => {
  withTamper(
    () => chmodSync(TARGET, 0o755),
    () => {
      const result = provenance();
      assert.equal(result.status, 1);
      assert.match(result.stderr, /실행 비트가 다르다/);
    },
  );
});

test("--provenance: 실파일이 같은 내용의 심링크로 바뀌어도 1 이다", () => {
  const sibling = join(dirname(TARGET), "state.ts");
  withTamper(
    () => {
      renameSync(TARGET, `${TARGET}.orig`);
      symlinkSync(sibling, TARGET);
    },
    () => {
      const result = provenance();
      assert.equal(result.status, 1);
      assert.match(result.stderr, /형식이 다르다/);
      rmSync(TARGET, { force: true });
      renameSync(`${TARGET}.orig`, TARGET);
    },
  );
});

test("--provenance: 업스트림에 없는 파일이 벤더에 있으면 1 이다", () => {
  const stray = join(VENDOR_DIR, "package", "ego-browser", "src", "우리-파일.ts");
  try {
    writeFileSync(stray, "// 업스트림에 없는 파일\n");
    const result = provenance();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /업스트림에 없는 파일/);
  } finally {
    rmSync(stray, { force: true });
  }
  assert.equal(provenance().status, 0);
});
