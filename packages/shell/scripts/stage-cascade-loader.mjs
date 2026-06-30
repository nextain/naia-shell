#!/usr/bin/env node
/**
 * stage-cascade-loader — naia-omni-windows-manager 의 loader(Python 패키지)를
 * 데스크톱 배포 번들용으로 `src-tauri/cascade-loader/loader/` 에 스테이징(임베딩).
 *
 * 왜: naia-os 가 로컬 cascade 를 띄울 때 `python -m loader launch` 를 쓰는데, 패키지 앱엔
 *     windows-manager 소스가 없다. agent(stage-agent.mjs) 와 동형으로 loader 를 앱에 동봉해
 *     **외부 adk 체크아웃 의존 없이** 자기완결적으로 구동(사용자 요구: "windows-manager 임베딩").
 *
 * loader 는 순수 stdlib(.py 파일뿐 — subprocess/socket/json/argparse). deps 설치 불필요 →
 * agent 처럼 pnpm deploy 가 아니라 단순 복사로 충분. 실제 cascade 서비스(VoxCPM2 등)는 별도
 * venv/모델(loader 가 paths 로 가리킴)이라 본 번들 범위 밖(R2.3 ops).
 *
 * 런타임 해석(lib.rs resolve_cascade_loader_dir): resource_dir/cascade-loader(번들) 가 `loader/`
 * 를 담으면 `python -m loader` 가능. dev 는 NAIA_CASCADE_LOADER_DIR(소스) 우선.
 *
 * cwd = packages/shell (tauri beforeBuildCommand / package.json 스크립트 기준).
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const SHELL = process.cwd(); // packages/shell
const WM = resolve(SHELL, "../../../naia-omni-windows-manager"); // 형제 repo(stage-agent 와 동일 레벨)
const SRC = resolve(WM, "loader");
const DEST_DIR = resolve(SHELL, "src-tauri/cascade-loader");
const DEST = resolve(DEST_DIR, "loader");

if (!existsSync(SRC)) {
	console.error(
		`[stage-cascade-loader] ❌ loader 없음: ${SRC}\n` +
			`  → naia-os 와 naia-omni-windows-manager 를 같은 부모 폴더 아래 형제로 clone 했는지 확인하세요.`,
	);
	process.exit(1);
}

console.log(`[stage-cascade-loader] loader = ${SRC}`);
if (existsSync(DEST)) rmSync(DEST, { recursive: true, force: true });
mkdirSync(DEST_DIR, { recursive: true });
// __pycache__ 제외 복사(런타임 불요·OS 의존).
cpSync(SRC, DEST, {
	recursive: true,
	filter: (s) => !s.includes("__pycache__"),
});

// 스테이징 검증 — `python -m loader launch` 가 import 하는 핵심 모듈 실재.
for (const p of ["__init__.py", "cli.py", "launcher.py", "service_plan.py"]) {
	if (!existsSync(resolve(DEST, p))) {
		console.error(`[stage-cascade-loader] ❌ 스테이징 검증 실패 — 누락: ${p}`);
		process.exit(1);
	}
}
console.log(`[stage-cascade-loader] ✅ 스테이징 완료: ${DEST}`);
