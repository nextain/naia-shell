#!/usr/bin/env node
/**
 * stage-agent — naia-agent(분리 repo)를 데스크톱 배포 번들용으로 `src-tauri/agent/` 에 스테이징.
 *
 * 왜 필요한가:
 *   tauri 번들은 agent 의 `dist` + prod `node_modules` 를 resource 로 싣는다. 그런데 sibling repo 의
 *   전체 node_modules(dev 포함, pnpm `.pnpm` 중첩 레이아웃)를 그대로 실으면 Windows MAX_PATH(260자)
 *   초과로 makensis(NSIS)가 파일 열기에 실패한다 — 예: `@browserbasehq/stagehand`(claude-agent-sdk 의
 *   deep dev-transitive)의 `dist/evals/.../*.d.ts`. 옛 `prune-nsis.py` 가 이 프루닝을 했으나 미이식이었다.
 *
 *   해결 = **prod-only + hoisted(평탄) 레이아웃**으로 deploy. dev-transitive(stagehand 등) 제거 +
 *   `.pnpm` 중첩 완화 → 실측 최대경로 < 260. (이 스크립트가 prune-nsis.py 의 의도를 대체한다.)
 *
 * 단계: ① agent install + build  ② 임시 workspace 로 `pnpm deploy --prod --node-linker=hoisted`
 *       → `src-tauri/agent/{package.json, scripts, node_modules}`(추적파일+prod deps)
 *       ③ 빌드된 `dist/` 복사(deploy 는 gitignore 라 dist 미포함).
 *
 * 번들 엔트리: production 엔트리 = `scripts/builds/agent-stdio-entry.mjs`(dev 와 동일). Rust(lib.rs)가
 *   resource_dir/agent 에서 이 파일을 node 로 spawn → 엔트리가 `../../dist/main/**` + `node_modules` 사용.
 *
 * ⚠️ better-sqlite3 / protobufjs 네이티브 build script 는 미실행(deploy --prod 기본). 기본 메모리 경로
 *    (LocalAdapter, 순수 JS)는 무영향. SqliteAdapter(opt-in)를 쓰려면 네이티브 빌드가 별도로 필요.
 *
 * cwd = packages/shell (package.json 스크립트/ tauri beforeBuildCommand 기준).
 */
import { execSync } from "node:child_process";
import { cpSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const SHELL = process.cwd(); // packages/shell
const AGENT = resolve(SHELL, "../../../naia-agent"); // 형제 repo (dev-setup.mjs 와 동일 가정)
const STAGE = resolve(SHELL, "src-tauri/agent");

if (!existsSync(AGENT)) {
	console.error(
		`[stage-agent] ❌ agent repo 없음: ${AGENT}\n  → naia-os 와 naia-agent 를 같은 부모 폴더 아래 형제로 clone 했는지 확인하세요.`,
	);
	process.exit(1);
}

const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: "inherit" });

console.log(`[stage-agent] agent = ${AGENT}`);
console.log("[stage-agent] ① agent install + build");
run("pnpm install --frozen-lockfile", AGENT);
run("pnpm run build", AGENT);

console.log(`[stage-agent] ② deploy (prod, hoisted) → ${STAGE}`);
const wsFile = resolve(AGENT, "pnpm-workspace.yaml");
const hadWs = existsSync(wsFile); // standalone repo 면 임시 생성 후 정리
try {
	if (!hadWs) writeFileSync(wsFile, "packages:\n  - '.'\n");
	if (existsSync(STAGE)) rmSync(STAGE, { recursive: true, force: true });
	run(
		`pnpm --filter=@nextain/naia-agent --config.node-linker=hoisted deploy --prod --legacy "${STAGE}"`,
		AGENT,
	);
} finally {
	if (!hadWs && existsSync(wsFile)) rmSync(wsFile, { force: true });
}

console.log("[stage-agent] ③ dist 복사 (deploy 는 dist gitignore 라 미포함)");
const dist = resolve(AGENT, "dist");
// 실 엔트리(scripts/builds/agent-stdio-entry.mjs)가 import 하는 빌드 출력 = dist/main/**.
// agent tsc 는 rootDir=src · outDir=dist → dist/main/...(dist/index.js 아님).
if (!existsSync(resolve(dist, "main/composition/index.js"))) {
	console.error(
		`[stage-agent] ❌ agent dist/main 빌드 산출 없음(build 실패?): ${dist}`,
	);
	process.exit(1);
}
cpSync(dist, resolve(STAGE, "dist"), { recursive: true });

// TypeScript does not copy non-code assets. grpc-server.js resolves the proto
// beside its compiled module first, so the deploy stage must place it there.
const grpcProto = resolve(AGENT, "src/main/adapters/grpc/naia_agent.proto");
const stagedGrpcProto = resolve(
	STAGE,
	"dist/main/adapters/grpc/naia_agent.proto",
);
cpSync(grpcProto, stagedGrpcProto);

// 스테이징 검증 — 번들 resource(agent/{scripts,dist,node_modules,package.json})가 참조하는
// 실 엔트리·deps 가 전부 실재해야. production 엔트리 = scripts/builds/agent-stdio-entry.mjs
// (dev 와 동일; Rust 가 resource_dir 에서 이 파일을 node 로 spawn → GRPC_LISTENING 핸드셰이크).
for (const p of [
	"scripts/builds/agent-stdio-entry.mjs",
	"dist/main/composition/index.js",
	"dist/main/adapters/grpc/naia_agent.proto",
	"package.json",
	"node_modules/@grpc/grpc-js",
	"node_modules/@nextain/naia-memory",
]) {
	if (!existsSync(resolve(STAGE, p))) {
		console.error(`[stage-agent] ❌ 스테이징 검증 실패 — 누락: ${p}`);
		process.exit(1);
	}
}
console.log(`[stage-agent] ✅ 스테이징 완료: ${STAGE}`);
