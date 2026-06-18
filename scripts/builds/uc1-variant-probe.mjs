#!/usr/bin/env node
// uc1-variant-probe — UC1 관측(Option A) **헤드리스 등가 게이트**(앱 불요).
// frozen shell 의 AgentResponseChunk union(=소비자가 실제 받는 권위 집합)을 추출해
// 새 core 의 variant 분류(dist classifyVariant SoT)가 *전부 커버*하는지 결정론 비교.
// = f0-boot-probe 가 f0-graft 의 헤드리스 버전인 것과 동일(라이브 paste 없이 drift 검출).
// 읽기 전용. 사용: node scripts/builds/uc1-variant-probe.mjs
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CHAT_TURN_VARIANTS, NONCHAT_KNOWN_VARIANTS, classifyVariant } from "../../dist/main/domain/chat.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// Old-Baseline 위치: OLD_NAIA_OS env 우선 → 형제 ../../../old-naia-os. 부재 시 하드크래시 아닌 SKIP(등가게이트 미검증 명시).
const OLD_ROOT = process.env.OLD_NAIA_OS ? resolve(process.env.OLD_NAIA_OS) : join(HERE, "../../../old-naia-os");
const SHELL = join(OLD_ROOT, "shell/src");
if (!existsSync(join(SHELL, "lib/types.ts"))) {
  console.log(`[UC1-VARIANT-PROBE] SKIP — Old-Baseline 부재(${SHELL}). 수신 등가게이트 미검증. 실행하려면 OLD_NAIA_OS=<old-naia-os 경로> 설정 또는 형제 디렉터리 체크아웃.`);
  process.exit(0);
}

// agent_response 전체 소비자 surface = chat AgentResponseChunk union ∪ 타 리스너(BgmPlayer/PanelInstall) 분기 type.
// (새 아키텍처: MessageRouter 단일구독이 *모든* agent_response 를 demux → 전부 분류돼야 함.)
const types1 = (() => {
  const src = readFileSync(join(SHELL, "lib/types.ts"), "utf8");
  const start = src.indexOf("export type AgentResponseChunk");
  if (start < 0) { console.error("AgentResponseChunk union 못 찾음"); process.exit(2); }
  const after = src.indexOf("\nexport ", start + 10);
  const block = src.slice(start, after < 0 ? undefined : after);
  return [...block.matchAll(/type:\s*"([a-z_]+)"/g)].map((m) => m[1]);
})();
const consumerFiles = ["components/BgmPlayer.tsx", "components/PanelInstallDialog.tsx"];
const types2 = consumerFiles.flatMap((f) => {
  let src = ""; try { src = readFileSync(join(SHELL, f), "utf8"); } catch { return []; }
  return [...src.matchAll(/\.type === "([a-z_]+)"|case "([a-z_]+)"/g)].map((m) => m[1] || m[2]);
});
const liveTypes = [...new Set([...types1, ...types2])].sort();

const known = new Set([...CHAT_TURN_VARIANTS, ...NONCHAT_KNOWN_VARIANTS]);
const missing = liveTypes.filter((t) => classifyVariant(t) === "unknown"); // shell 은 받는데 새 core 미분류 = drift
const coreExtra = [...known].filter((t) => !liveTypes.includes(t)).sort();   // 새 core 에만(superset — 무해)

const result = {
  source: "old-naia-os/shell/src (AgentResponseChunk + BgmPlayer + PanelInstall 소비자)",
  liveConsumerTypes: liveTypes,
  newCoreKnown: [...known].sort(),
  missing_in_new_core: missing,          // ← 0 이어야 등가(아니면 drift)
  new_core_superset_only: coreExtra,     // 무해(agent 가 emit 안 하면 미도달, emit 하면 nonchat 분류)
  verdict: missing.length === 0
    ? "PASS — shell 이 받는 모든 type 을 새 core 가 분류(Old-Baseline 등가)"
    : "DRIFT — 새 core 가 일부 라이브 type 을 unknown 처리",
};
console.log("[UC1-VARIANT-PROBE]", JSON.stringify(result, null, 2));
process.exit(missing.length === 0 ? 0 : 1);
