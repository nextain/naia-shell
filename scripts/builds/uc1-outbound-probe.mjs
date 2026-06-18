#!/usr/bin/env node
// uc1-outbound-probe — **송신 헤드리스 등가 게이트**(데몬·LLM·포트 불요).
// frozen agent 의 parseRequest(protocol.ts) 가 *수용*하는 type 화이트리스트를 추출해,
// 새 core toAgentOutbound 가 내보내는 모든 outbound type 이 그 안에 있는지 결정론 비교.
// = 수신측 uc1-variant-probe 의 대칭(송신측). parseRequest 는 관대(unknown 필드 거부 안 함)라 type 수용이 핵심.
// 읽기 전용. 사용: node scripts/builds/uc1-outbound-probe.mjs
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { toAgentOutbound } from "../../dist/main/adapters/tauri/uc1.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// Old-Baseline 위치: OLD_NAIA_OS env 우선 → 형제 ../../../old-naia-os. 부재 시 하드크래시 아닌 SKIP(등가게이트 미검증 명시).
const OLD_ROOT = process.env.OLD_NAIA_OS ? resolve(process.env.OLD_NAIA_OS) : join(HERE, "../../../old-naia-os");
const PROTOCOL = join(OLD_ROOT, "agent/src/protocol.ts");
if (!existsSync(PROTOCOL)) {
  console.log(`[UC1-OUTBOUND-PROBE] SKIP — Old-Baseline 부재(${PROTOCOL}). 송신 등가게이트 미검증. 실행하려면 OLD_NAIA_OS=<old-naia-os 경로> 설정 또는 형제 디렉터리 체크아웃.`);
  process.exit(0);
}

// parseRequest 가 수용하는 type 추출(obj.type === "x" 화이트리스트).
const src = readFileSync(PROTOCOL, "utf8");
const start = src.indexOf("export function parseRequest");
const block = src.slice(start, src.indexOf("}", src.indexOf("return obj as AgentRequest")));
const accepted = new Set([...block.matchAll(/obj\.type === "([a-z_]+)"/g)].map((m) => m[1]));

// 새 core 가 내보내는 outbound type(4 DomainOutbound kind).
const samples = [
  { kind: "chat", requestId: "r", clientId: "c", provider: { provider: "ollama", model: "m" }, messages: [] },
  { kind: "cancel", requestId: "r", clientId: "c" },
  { kind: "approvalResponse", requestId: "r", clientId: "c", toolCallId: "t", decision: "approve" },
  { kind: "credsUpdate", provider: "openai", secret: { apiKey: "x" } },
];
const emitted = samples.map((s) => ({ kind: s.kind, type: toAgentOutbound(s).type }));
const rejected = emitted.filter((e) => !accepted.has(e.type)); // 새 core 가 보내는데 agent 가 거부 = drift

const result = {
  source: "old-naia-os/agent/src/protocol.ts (parseRequest 수용 집합)",
  agentAccepts: [...accepted].sort(),
  newCoreEmits: emitted,
  rejected_by_agent: rejected,           // ← 0 이어야 등가
  verdict: rejected.length === 0
    ? "PASS — 새 core 의 모든 outbound type 을 실 agent parseRequest 가 수용(송신 등가)"
    : "DRIFT — agent 가 거부하는 outbound type 존재",
};
console.log("[UC1-OUTBOUND-PROBE]", JSON.stringify(result, null, 2));
process.exit(rejected.length === 0 ? 0 : 1);
