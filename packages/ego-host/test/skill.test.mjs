/**
 * 파생 스킬 검사 (#582 S4).
 *
 * 파생본은 "고쳐 쓴 문서"다. 고쳐 쓴 문서의 위험은 둘이다 — 고치다 만 것과, 고친 이유를
 * 아무도 못 읽는 것. 그래서 여기서 다섯을 본다.
 *
 *  (1) 지원 목록에 helper-matrix 의 rejected·unsupported 헬퍼가 없다. 목록은 약속이 아니라
 *      측정 결과다(계약 1절). 측정이 거부라고 한 헬퍼를 목록에 실으면 에이전트가 그것을 부른다.
 *  (2) 낡은 출력 통로 `cliLog` 를 **가르치지 않는다.** 완전 부재는 요구하지 않는다 — 계약이
 *      "쓰지 말 것" 절에 코드와 함께 적으라고 했기 때문이다. 그래서 자리를 본다.
 *  (3) "로그인 상속" 문장이 없다. 작업 공간은 비로그인 격리 공간이다(계약 3절 1번).
 *  (4) UPSTREAM-DIFF 의 원문이 실제 업스트림 원본에, 파생문이 실제 파생본에 있다.
 *      표가 낡으면 3자 diff 가 거짓말이 된다.
 *  (5) validate-site-skills 가 우리 학습 루트에서 종료 코드 0 이다.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { before } from "node:test";
import { ensureVendorDist } from "./helpers/vendor-runtime.mjs";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_DIR = join(PKG_ROOT, "skill");
const DERIVED_SKILL = join(SKILL_DIR, "SKILL.md");
const UPSTREAM_DIFF = join(SKILL_DIR, "UPSTREAM-DIFF.md");
const UPSTREAM_SKILL = join(PKG_ROOT, "vendor", "ego-lite", "skills", "ego-browser", "SKILL.md");
const VENDOR_RUNTIME = join(PKG_ROOT, "vendor", "ego-lite", "package", "ego-browser");
const VALIDATOR = join(VENDOR_RUNTIME, "dist", "scripts", "validate-site-skills.js");
const MATRIX_JSON = join(PKG_ROOT, "docs", "helper-matrix.json");

const derived = () => readFileSync(DERIVED_SKILL, "utf8");
const upstream = () => readFileSync(UPSTREAM_SKILL, "utf8");

/** 파생본의 "지원 목록" = `## Common helpers` 부터 다음 `##` 전까지. */
function commonHelpersSection(text) {
  const start = text.indexOf("## Common helpers");
  assert.notEqual(start, -1, "파생본에 `## Common helpers` 절이 없다");
  const rest = text.slice(start + 3);
  const end = rest.indexOf("\n## ");
  return end === -1 ? rest : rest.slice(0, end);
}

/** "쓰지 말 것" 절 = `## Helpers not to use` 부터 다음 `## ` 전까지 (### 하위 절은 포함). */
function notToUseSection(text) {
  const start = text.indexOf("## Helpers not to use");
  assert.notEqual(start, -1, "파생본에 `## Helpers not to use` 절이 없다");
  const rest = text.slice(start + 3);
  const end = rest.indexOf("\n## ");
  return end === -1 ? rest : rest.slice(0, end);
}

function matrix() {
  return JSON.parse(readFileSync(MATRIX_JSON, "utf8"));
}

test("지원 목록에 측정이 거부·미지원이라고 한 헬퍼가 없다", () => {
  const { helpers } = matrix();
  const refused = Object.entries(helpers)
    .filter(([, verdict]) => verdict.kind !== "supported")
    .map(([name]) => name);
  assert.ok(refused.length > 0, "행렬에 거부·미지원이 하나도 없다 — 검사가 공허하다");

  const section = commonHelpersSection(derived());
  const leaked = refused.filter((name) => section.includes(`\`${name}\``));
  assert.deepEqual(leaked, [], `지원 목록에 거부·미지원 헬퍼가 실렸다: ${leaked.join(", ")}`);

  // 공허하지 않다는 반증: supported 헬퍼는 실제로 목록에 있어야 한다.
  const supported = Object.entries(helpers)
    .filter(([, verdict]) => verdict.kind === "supported")
    .map(([name]) => name);
  const missing = supported.filter((name) => !section.includes(`\`${name}\``));
  assert.deepEqual(missing, [], `측정이 지원이라고 한 헬퍼가 목록에 없다: ${missing.join(", ")}`);
});

test("낡은 출력 통로 cliLog 는 가르치지 않는다 — '쓰지 말 것' 절에만 있다", () => {
  const text = derived();
  const outside = text.replace(notToUseSection(text), "");
  assert.equal(
    outside.includes("cliLog"),
    false,
    "`cliLog` 가 '쓰지 말 것' 절 밖에 있다 — 고정 커밋 런타임에 그 전역은 없다",
  );
  assert.ok(
    notToUseSection(text).includes("cliLog"),
    "`cliLog` 가 '쓰지 말 것' 절에도 없다 — 업스트림 문서를 읽고 온 에이전트가 그대로 쓴다",
  );
  assert.ok(text.includes("console.log(value)"), "출력 통로 `console.log` 안내가 없다");
});

test("로그인 상속 문장이 없다 — 작업 공간은 비로그인 격리 공간이다", () => {
  const text = derived();
  for (const phrase of [
    "inherits the current user's login state",
    "reusing the user's login state",
    "login state",
  ]) {
    if (phrase === "login state") {
      // "login state" 자체는 부정문("no login state to inherit")에 쓰인다.
      // 상속을 **약속하는** 형태만 금지한다.
      assert.equal(
        /(?:inherit|reus)\w*\s+(?:the\s+)?(?:current\s+)?(?:user's\s+)?login state/i.test(
          text.replace("there is no login state to inherit", ""),
        ),
        false,
        "로그인 상속을 약속하는 문장이 남아 있다",
      );
      continue;
    }
    assert.equal(text.includes(phrase), false, `로그인 상속 문장이 남아 있다: ${phrase}`);
  }
  assert.ok(upstream().includes("inherits the current user's login state"), "업스트림 원본이 바뀌었다 — 검사가 공허하다");
});

test("UPSTREAM-DIFF 의 원문은 원본에, 파생문은 파생본에 실제로 있다", () => {
  const rows = readFileSync(UPSTREAM_DIFF, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("| "))
    .map((line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim()))
    .filter((cells) => cells.length === 5 && /^\d+$/.test(cells[0]));

  assert.ok(rows.length >= 10, `표에 행이 너무 적다(${rows.length}) — 파생 결정이 기록되지 않았다`);

  const up = upstream();
  const dv = derived();
  for (const [id, what, rawOriginal, rawDerived] of rows) {
    const quoted = (cell) => {
      assert.match(cell, /^".*"$/s, `${id}행(${what})의 인용이 큰따옴표로 감싸이지 않았다: ${cell}`);
      return cell.slice(1, -1);
    };
    const original = quoted(rawOriginal);
    const ours = quoted(rawDerived);
    assert.ok(up.includes(original), `${id}행(${what})의 원문이 업스트림 원본에 없다: ${original}`);
    assert.ok(dv.includes(ours), `${id}행(${what})의 파생문이 파생본에 없다: ${ours}`);
  }
});

test("파생본 프런트매터는 우리 이름과 출처를 밝힌다", () => {
  const text = derived();
  assert.ok(text.startsWith("---\n"), "프런트매터가 없다");
  const front = text.slice(4, text.indexOf("\n---", 4));
  assert.ok(front.includes("name: naia-browser"), "스킬 이름이 우리 것이 아니다");
  assert.equal(front.includes("name: ego-browser"), false, "업스트림 이름이 남아 있다");
  assert.match(front, /derivedFrom: .*5ca3c36cba2240b8df2e22ba32127747029039d5/, "파생 출처 커밋이 없다");
});

before(() => ensureVendorDist(), { timeout: 900_000 });

test("validate-site-skills 가 우리 학습 루트에서 0 으로 끝난다", () => {
  assert.ok(existsSync(VALIDATOR), `벤더 검사기가 없다: ${VALIDATOR}`);
  const result = spawnSync(process.execPath, [VALIDATOR], {
    cwd: VENDOR_RUNTIME,
    encoding: "utf8",
    env: { ...process.env, EGO_BROWSER_AGENT_WORKSPACE: SKILL_DIR },
  });
  assert.equal(
    result.status,
    0,
    `validate-site-skills 실패(${result.status}):\n${result.stdout}\n${result.stderr}`,
  );
  assert.match(result.stdout, /site skills ok/, "검사기가 우리 루트를 실제로 읽지 않았다");
  assert.ok(result.stdout.includes(join(SKILL_DIR, "learnings")), "검사기가 다른 루트를 봤다");
});

test("naia.land 학습이 실제 셀렉터를 들고 있다", () => {
  const dir = join(SKILL_DIR, "learnings", "naia-land");
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  assert.equal(manifest.id, "naia-land");
  assert.ok(manifest.domains.includes("naia.land"));
  const notes = readFileSync(join(dir, "notes", "overview.md"), "utf8");
  for (const selector of ['header a[href$="/login"]', "main form", 'button[type="submit"]']) {
    assert.ok(notes.includes(selector), `학습 노트에 셀렉터가 없다: ${selector}`);
  }
  // 사람이 필요한 구간을 멈춤으로 적었는가. 로그인을 시도하라고 적으면 정책 위반이다.
  assert.ok(notes.includes("멈추고"), "로그인 앞에서 멈추라는 지시가 없다");
});
