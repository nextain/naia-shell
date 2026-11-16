import { cpSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { type Plugin, defineConfig } from "vite";
import packageJson from "./package.json";
import { shouldIncludeDesktopPublicAsset } from "./src/lib/avatar/desktop-public-assets";

export { shouldIncludeDesktopPublicAsset };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

export function desktopPublicAssetsPlugin(): Plugin {
	let outputDirectory = "";
	const publicDirectory = path.resolve(__dirname, "public");
	return {
		name: "desktop-public-assets",
		apply: "build",
		configResolved(config) {
			outputDirectory = path.resolve(config.root, config.build.outDir);
		},
		writeBundle() {
			if (!existsSync(publicDirectory)) return;
			cpSync(publicDirectory, outputDirectory, {
				recursive: true,
				filter: (source) => {
					const rel = path.relative(publicDirectory, source);
					if (!rel) return true;
					let isDir = false;
					try {
						isDir = statSync(source).isDirectory();
					} catch {
						isDir = false;
					}
					return shouldIncludeDesktopPublicAsset(rel, isDir);
				},
			});
		},
	};
}

const host = process.env.TAURI_DEV_HOST || process.env.PLAYWRIGHT_HOST;
const port = readPositiveIntegerEnv("PLAYWRIGHT_PORT", 1420, { max: 65534 });

export default defineConfig(({ command }) => ({
	publicDir: command === "build" ? false : "public",
	plugins: [
		react(),
		...(command === "build" ? [desktopPublicAssetsPlugin()] : []),
	],
	build: {
		// Bundle-budget verification uses this graph to prove that large optional
		// surfaces stay behind dynamic imports instead of merely producing a
		// similarly named output file.
		manifest: true,
	},
	define: {
		__USAGE_VERSION__: JSON.stringify(packageJson.version),
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
		// Prefer explicit TAURI/PLAYWRIGHT host; otherwise bind all interfaces for Tailscale.
		host: host || true,
		// Vite 6 blocks unknown Host headers (Tailscale MagicDNS → 403) unless allowed.
		// ".ts.net" admits any MagicDNS name without naming a private tailnet here.
		allowedHosts: ["localhost", "127.0.0.1", ".ts.net"],
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
