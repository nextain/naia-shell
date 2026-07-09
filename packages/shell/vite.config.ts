import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
	plugins: [react()],
	define: {
		__BUILD_ID__: JSON.stringify(
			new Date().toISOString().replace(/[-:]/g, "").slice(0, 15),
		),
	},
	test: {
		exclude: [
			"e2e/**",
			"e2e-tauri/**",
			"node_modules/**",
			// src-tauri 전체 제외: Rust 테스트는 cargo test, 스테이징된 agent(src-tauri/agent,
			// stage-agent.mjs 산출물)는 자체 vitest 스위트로 검증. 여기 나열하면 agent 의
			// 620+ 테스트(naia-memory sqlite 등)가 셸 스코프로 새어들어 P04 신호를 오염시킨다.
			"src-tauri/**",
		],
		setupFiles: ["./vitest.setup.ts"],
		// Run test files sequentially. Several panel suites time out or leak shared
		// state when many files run in parallel under load (they pass individually
		// and with --no-file-parallelism); sequential keeps the suite green.
		fileParallelism: false,
		testTimeout: 15000,
	},
	clearScreen: false,
	server: {
		port: 1420,
		strictPort: true,
		host: host || false,
		hmr: host
			? {
					protocol: "ws",
					host,
					port: 1421,
				}
			: undefined,
		watch: {
			ignored: ["**/src-tauri/**"],
		},
	},
	resolve: {
		alias: {
			"@": "/src",
		},
	},
}));
