import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

function readPositiveIntegerEnv(
	name: string,
	fallback: number,
	options: { max?: number } = {},
): number {
	const rawValue = process.env[name];
	if (rawValue === undefined || rawValue === "") {
		return fallback;
	}

	const value = Number(rawValue);
	if (
		!Number.isInteger(value) ||
		value <= 0 ||
		(options.max !== undefined && value > options.max)
	) {
		throw new Error(
			`${name} must be a positive integer${options.max !== undefined ? ` <= ${options.max}` : ""}`,
		);
	}

	return value;
}

const host = process.env.TAURI_DEV_HOST || process.env.PLAYWRIGHT_HOST;
const port = readPositiveIntegerEnv("PLAYWRIGHT_PORT", 1420, { max: 65534 });

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
		port,
		strictPort: true,
		host: host || false,
		hmr: host
			? {
					protocol: "ws",
					host,
					port: port + 1,
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
