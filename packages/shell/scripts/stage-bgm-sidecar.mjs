#!/usr/bin/env node
/**
 * Stage the shell-owned BGM sidecar and its production dependencies for Tauri.
 */
import { execSync } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const SHELL = process.cwd();
const ROOT = resolve(SHELL, "../..");
const BGM = resolve(ROOT, "packages/bgm-sidecar");
const STAGE = resolve(SHELL, "src-tauri/bgm-sidecar");
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: "inherit" });

if (!existsSync(BGM)) {
	console.error(`[stage-bgm-sidecar] ❌ package 없음: ${BGM}`);
	process.exit(1);
}

console.log("[stage-bgm-sidecar] ① build");
run("pnpm run build", BGM);
if (existsSync(STAGE)) rmSync(STAGE, { recursive: true, force: true });

console.log(`[stage-bgm-sidecar] ② deploy (prod, hoisted) → ${STAGE}`);
run(
	`pnpm --filter=@naia/bgm-sidecar --config.node-linker=hoisted deploy --prod --legacy "${STAGE}"`,
	ROOT,
);

// deploy omits gitignored build output.
cpSync(resolve(BGM, "dist"), resolve(STAGE, "dist"), { recursive: true });

for (const path of [
	"dist/bgm-server-bin.js",
	"dist/youtube-server.js",
	"package.json",
	"node_modules/youtubei.js",
]) {
	if (!existsSync(resolve(STAGE, path))) {
		console.error(`[stage-bgm-sidecar] ❌ 스테이징 검증 실패 — 누락: ${path}`);
		process.exit(1);
	}
}
console.log(`[stage-bgm-sidecar] ✅ 스테이징 완료: ${STAGE}`);
