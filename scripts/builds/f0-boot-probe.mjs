#!/usr/bin/env node
// f0-boot-probe — Tauri 없이 *실제 디스크 상태*로 새 core 의 부팅 결정을 구동.
// = P02 1단계 Old-Baseline drift-gate 의 headless 실행본. 컴파일된 새 core(dist) 를 직접 import.
// 읽기 전용. 사용: node scripts/builds/f0-boot-probe.mjs [adkPathFile]
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { decideBoot } from "../../dist/main/domain/boot.js"; // ← 새 core 실물

const adkPathFile = process.argv[2] || join(homedir(), ".naia", "adk-path");
let adkPath = null;
try { adkPath = readFileSync(adkPathFile, "utf8").trim() || null; } catch { /* 없음 */ }
const adkPresent = adkPath !== null && adkPath !== "";

let onboardingComplete = false, cfgFound = false;
if (adkPresent) {
  try {
    const cfg = JSON.parse(readFileSync(join(adkPath, "naia-settings", "config.json"), "utf8"));
    onboardingComplete = cfg.onboardingComplete === true; cfgFound = true;
  } catch { /* 파일 config 없음 — onboarding 은 localStorage 권위, 디스크선 미확정 */ }
}

const newDecision = decideBoot(adkPresent, onboardingComplete); // ← 새 core 규칙 실행
const oldExpected = !adkPresent ? "SetupRequired" : (onboardingComplete ? "Main" : "OnboardingOverlay");

console.log("[F0-BOOT-PROBE]", JSON.stringify({
  source: { adkPathFile, adkPath, configFile: adkPresent ? join(adkPath, "naia-settings", "config.json") : null, cfgFound },
  adkPresent, onboardingComplete,
  newDecision, oldExpected, match: newDecision === oldExpected,
}, null, 2));
