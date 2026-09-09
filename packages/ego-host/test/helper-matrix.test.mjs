// #582 S2f — 지원 헬퍼 행렬이 **생성물**이라는 것을 고정한다 (계약 9절 S2f).
//
// 행렬은 손으로 쓰지 않는다. 그래서 커밋된 파일이 생성기와 어긋나면 그것이 결함이다.
// 여기서 셋을 검사한다.
//
//  (1) 커밋된 행렬의 헬퍼 목록이 **벤더 스킬을 지금 파싱한 결과와 같다.** 업스트림 스킬이
//      헬퍼를 늘리거나 이름을 바꾸면 여기서 먼저 걸린다.
//  (2) 커밋된 마크다운이 커밋된 JSON 에서 **그대로 렌더링된다**(바이트 일치). 표를 손으로
//      고친 흔적이 있으면 걸린다.
//  (3) 표본 몇 개를 **실제로 다시 측정**해 판정이 같다. 전부를 다시 재는 것은
//      `node scripts/probe-helpers.mjs --check` 의 몫이다(41개 × 각자 프로세스라 분 단위다).
//      여기서는 세 판정 종류를 하나씩 뽑아 생성기가 여전히 같은 답을 내는지만 본다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import {
  MATRIX_JSON,
  MATRIX_MD,
  PROBES,
  SKILL_PATH,
  measure,
  parseCommonHelpers,
  renderMarkdown,
} from "../scripts/probe-helpers.mjs";
import { cleanupAll } from "./helpers/live-browser.mjs";
import { stopAllLive } from "./helpers/live-supervisor.mjs";
import { ensureVendorDist } from "./helpers/vendor-runtime.mjs";

before(() => ensureVendorDist(), { timeout: 900_000 });

after(async () => {
  await stopAllLive();
  cleanupAll();
});

function committed() {
  return JSON.parse(readFileSync(MATRIX_JSON, "utf8"));
}

test("행렬의 헬퍼 목록은 벤더 스킬을 지금 파싱한 결과와 같다", () => {
  const fresh = parseCommonHelpers(readFileSync(SKILL_PATH, "utf8"));
  const matrix = committed();
  assert.deepEqual(
    matrix.groups,
    fresh,
    "벤더 스킬의 헬퍼 목록이 바뀌었다. `node scripts/probe-helpers.mjs` 로 행렬을 다시 만든다",
  );
  const names = fresh.flatMap((group) => group.names);
  assert.deepEqual(
    names.filter((name) => !Object.hasOwn(PROBES, name)),
    [],
    "탐침 없는 헬퍼가 있다 — 행렬은 목록 전부를 덮어야 한다",
  );
  assert.deepEqual(
    names.filter((name) => !matrix.helpers[name]),
    [],
    "행렬에 판정이 빠진 헬퍼가 있다",
  );
});

test("커밋된 마크다운은 커밋된 JSON 에서 그대로 렌더링된다", () => {
  const matrix = committed();
  assert.equal(
    readFileSync(MATRIX_MD, "utf8"),
    renderMarkdown(matrix),
    "helper-matrix.md 가 손으로 고쳐졌다. 생성기(`scripts/probe-helpers.mjs`)가 정본이다",
  );
  const counted = { total: 0, supported: 0, rejected: 0, unsupported: 0 };
  for (const group of matrix.groups) {
    for (const name of group.names) {
      counted.total += 1;
      counted[matrix.helpers[name].kind] += 1;
    }
  }
  assert.deepEqual(counted, matrix.totals, "합계가 판정과 어긋난다");
});

test(
  "표본을 다시 측정해도 같은 판정이 나온다 (supported·rejected·unsupported 각 하나)",
  { timeout: 300_000 },
  async () => {
    const matrix = committed();
    const sample = ["listTaskSpaces", "uploadFile", "cliLog"];
    for (const name of sample) {
      assert.ok(matrix.helpers[name], `표본 ${name} 이 행렬에 없다`);
    }
    assert.deepEqual(
      sample.map((name) => matrix.helpers[name].kind).sort(),
      ["rejected", "supported", "unsupported"],
      "표본이 세 판정 종류를 하나씩 덮지 않는다",
    );
    const fresh = await measure({ only: sample });
    for (const name of sample) {
      assert.equal(
        fresh.helpers[name].verdict,
        matrix.helpers[name].verdict,
        `${name} 의 판정이 커밋된 행렬과 다르다`,
      );
    }
  },
);
