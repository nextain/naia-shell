#!/usr/bin/env node
// uc1-graft-observe — UC1 수평 관측(Option A) 스니펫 생성기.
// 새 core 의 wire variant 분류(dist 에서 파생 = 드리프트 0)를 DevTools 스니펫으로 emit.
// withGlobalTauri:false → IPC 직접 후킹 불가 → (1) 앱이 이미 찍는 콘솔 로그 관측 + (2) 수동 classify.
// 읽기 전용(설정 미변경). 사용: node scripts/builds/uc1-graft-observe.mjs
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHAT_TURN_VARIANTS, NONCHAT_KNOWN_VARIANTS,
} from "../../dist/main/domain/chat.js"; // ← 새 core 실물(단일 SoT)

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "uc1-graft-snippet.js");

const chatTurn = JSON.stringify([...CHAT_TURN_VARIANTS]);
const nonchat = JSON.stringify([...NONCHAT_KNOWN_VARIANTS]);

const snippet = `// UC1 수평 관측 스모크 — 돌고 있는 naia-os DevTools(F12) Console 에 붙여넣기. 읽기 전용(설정 미변경).
// 새 core 의 wire variant 분류(=dist/main/domain/chat.js 에서 파생, 드리프트 0)가 라이브 wire 와 등가인지 관측.
(() => {
  const CHAT_TURN = new Set(${chatTurn});
  const NONCHAT_KNOWN = new Set(${nonchat});
  // 새 core classifyVariant 와 동일 규칙(domain/chat.ts SoT 파생)
  const classify = (type) => CHAT_TURN.has(type) ? "chat-turn" : (NONCHAT_KNOWN.has(type) ? "nonchat-known" : "unknown");
  const outboundCmd = (kind) => kind === "cancel" ? "cancel_stream" : "send_to_agent_command";

  const tally = { inbound: {}, unknown: new Set(), seen: 0 };
  function note(type) {
    const lane = classify(type);
    tally.inbound[type] = (tally.inbound[type] || 0) + 1;
    tally.seen++;
    if (lane === "unknown") { tally.unknown.add(type); console.warn("[UC1-OBSERVE] ⚠ UNKNOWN variant (새 core 분류 누락 후보):", type); }
    return lane;
  }
  // 임의 chunk(객체/JSON 문자열) 분류 — 라이브 로그에서 본 chunk 를 붙여 확인
  function classifyMessage(x) {
    let o = x; if (typeof x === "string") { try { o = JSON.parse(x); } catch { return { type: "(parse 실패)", lane: "unknown" }; } }
    const type = o && typeof o.type === "string" ? o.type : "(type 없음)";
    return { type, lane: classify(type), requestId: o?.requestId };
  }

  // 콘솔 관측 — 앱이 찍는 로그 인자에서 {type:...} chunk 형태를 자동 분류(reversible).
  const orig = { log: console.log, debug: console.debug, warn: console.warn };
  function scan(args) {
    for (const a of args) {
      let o = a;
      if (typeof a === "string" && a.includes('"type"')) { try { o = JSON.parse(a); } catch {} }
      if (o && typeof o === "object" && typeof o.type === "string" && (CHAT_TURN.has(o.type) || NONCHAT_KNOWN.has(o.type))) {
        note(o.type);
      }
    }
  }
  function observeConsole() {
    console.log = (...a) => { try { scan(a); } catch {} return orig.log.apply(console, a); };
    console.debug = (...a) => { try { scan(a); } catch {} return orig.debug.apply(console, a); };
    console.warn = (...a) => { try { scan(a); } catch {} return orig.warn.apply(console, a); };
    orig.log.call(console, "[UC1-OBSERVE] 콘솔 관측 시작 — 채팅을 한 턴 해보세요. window.uc1.report() 로 집계, window.uc1.stop() 로 종료.");
  }
  function stop() { console.log = orig.log; console.debug = orig.debug; console.warn = orig.warn; orig.log.call(console, "[UC1-OBSERVE] 관측 종료."); }
  function report() {
    orig.log.call(console, "[UC1-OBSERVE] 집계", {
      관측chunk수: tally.seen,
      type별: tally.inbound,
      미분류_unknown: [...tally.unknown],
      판정: tally.unknown.size === 0 ? "✅ 모든 관측 type 이 새 core 분류에 존재(등가)" : "⚠ unknown 존재 → 새 core variant 세트 보강 필요(=drift)",
    });
    return tally;
  }

  window.uc1 = { classify, classifyMessage, outboundCmd, observeConsole, stop, report, tally,
    CHAT_TURN_VARIANTS: [...CHAT_TURN], NONCHAT_KNOWN_VARIANTS: [...NONCHAT_KNOWN] };
  const hasGlobalTauri = !!(window.__TAURI__ && window.__TAURI__.event);
  console.log("[UC1-OBSERVE] 준비됨. withGlobalTauri =", hasGlobalTauri ? "on(IPC 후킹 가능)" : "off(콘솔 관측/수동 분류)");
  console.log("  • window.uc1.observeConsole()  → 앱 로그에서 chunk 자동 분류 시작");
  console.log("  • window.uc1.classifyMessage('{\\"type\\":\\"finish\\",...}')  → 본 chunk 수동 확인");
  console.log("  • window.uc1.classify('text') → 'chat-turn'");
  console.log("  • window.uc1.report() / window.uc1.stop()");
})();
`;

writeFileSync(OUT, snippet);
console.log("[uc1-graft-observe] 생성:", OUT);
console.log("[uc1-graft-observe] chat-turn variants:", [...CHAT_TURN_VARIANTS].length, "/ nonchat-known:", [...NONCHAT_KNOWN_VARIANTS].length, "(dist 파생)");
