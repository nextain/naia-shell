#!/usr/bin/env node
// #582 S2d — 벤더 런타임이 실제로 부르는 CDP 메서드 소스 스캔 (계약 4.3.2).
//
// 정책표(mediator-policy.mjs)는 사람이 손으로 적은 데이터다. 손으로 적은 목록은 업스트림이
// 메서드를 하나 더 부르기 시작하는 날 조용히 낡는다. 그래서 **소스가 정본**이다: 벤더
// `driver/*.ts`·`element-resolver.ts`·`browser-runtime.ts` 에서 CDP 호출의 첫 문자열 인자를
// 뽑아, 정책표에 없는 것이 하나라도 있으면 테스트 **수집 단계**에서 실패한다.
//
// 왜 이벤트 이름은 안 뽑는가: 이벤트는 감독자가 필터해 내려보내는 것이지 연결이 부르는
// 메서드가 아니다. 그래서 문자열 리터럴을 통째로 긁지 않고 **호출 자리**만 본다
// (`subscribeBrowserEvent("Page.screencastFrame", …)` 은 호출이 아니라 구독이다).
//
// 인식하는 호출 형태 (벤더 소스에 실제로 있는 것만):
//   cdp("Page.navigate", …)                     driver/*.ts
//   await cdp(\n  "Runtime.callFunctionOn", …)   여러 줄
//   dependencies.browserCdp("Page.startScreencast", …)
//   rawCdp("Page.enable", {}, sessionId)        browser-runtime.ts
//   send(cdp, "DOM.getBoxModel", …)             element-resolver.ts (첫 인자가 통로 함수)
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const VENDOR_SRC = resolve(
  HERE,
  "..",
  "vendor",
  "ego-lite",
  "package",
  "ego-browser",
  "src",
);

/** CDP 통로 함수 이름. 이 이름으로 부른 것만 CDP 메서드로 본다. */
export const CDP_CALLERS = ["cdp", "rawCdp", "browserCdp", "sendRaw", "send", "cdpOverride"];

const CALL_RE = new RegExp(
  String.raw`(?:^|[^\w$.])((?:[\w$]+\.)?(?:${CDP_CALLERS.join("|")}))\s*\(`,
  "g",
);
/** `(` 바로 뒤 또는 `(통로함수,` 뒤의 첫 문자열 리터럴만 메서드로 인정한다. */
const FIRST_ARG_RE = /^\s*(?:[\w$]+\s*,\s*)?"([A-Z][A-Za-z]*\.[a-zA-Z][A-Za-z]*)"/;

/** 주석 안의 예시 메서드가 정책표를 늘리지 않도록 먼저 지운다(자리는 공백으로 보존). */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (match) => " ".repeat(match.length));
}

function lineOf(source, index) {
  let line = 1;
  for (let at = 0; at < index; at += 1) if (source[at] === "\n") line += 1;
  return line;
}

/**
 * 벤더 `src` 전체(테스트 제외). 계약이 지목한 세 자리 **밖에도** CDP 호출이 있다 —
 * `helpers.ts:697` 의 `Page.reload` 가 그렇다. 정책표는 넓은 쪽을 덮어야 한다.
 */
export function scanAllTargets(root = VENDOR_SRC) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(full);
    }
  };
  walk(root);
  return files;
}

/** 계약 4.3.2 가 전수표의 근거로 지목한 파일들. */
export function scanTargets(root = VENDOR_SRC) {
  const driver = readdirSync(join(root, "driver"))
    .filter((name) => name.endsWith(".ts"))
    .sort()
    .map((name) => join(root, "driver", name));
  return [...driver, join(root, "element-resolver.ts"), join(root, "browser-runtime.ts")];
}

/**
 * @param {object} [options]
 * @param {string} [options.root]  벤더 `src` 디렉터리
 * @param {string[]} [options.files]
 * @returns {{methods:string[], sites:{method:string,file:string,line:number}[]}}
 */
export function scanCdpMethods({ root = VENDOR_SRC, files = null } = {}) {
  const targets = files ?? scanTargets(root);
  const sites = [];
  for (const file of targets) {
    const source = stripComments(readFileSync(file, "utf8"));
    CALL_RE.lastIndex = 0;
    let match;
    while ((match = CALL_RE.exec(source)) !== null) {
      const rest = source.slice(CALL_RE.lastIndex);
      const arg = FIRST_ARG_RE.exec(rest);
      if (!arg) continue;
      sites.push({
        method: arg[1],
        file: relative(resolve(root, "..", "..", "..", ".."), file),
        line: lineOf(source, match.index),
      });
    }
  }
  const methods = [...new Set(sites.map((site) => site.method))].sort();
  return { methods, sites };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const all = process.argv.includes("--all");
  const { methods, sites } = scanCdpMethods(all ? { files: scanAllTargets() } : {});
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ methods, sites }, null, 2));
  } else {
    for (const method of methods) {
      const where = sites.filter((site) => site.method === method).length;
      console.log(`${method}\t(호출 ${where}곳)`);
    }
    console.log(`\n메서드 ${methods.length}개, 호출 자리 ${sites.length}곳`);
  }
}
