import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin, searchForWorkspaceRoot } from "vite";
import { resolveWebAgentDir } from "./scripts/web-agent-dir.mjs";
import { buildWebAdkBundle } from "./scripts/web-adk-bundle.mjs";
import { WEB_CSP } from "./src/lib/web-runtime/csp";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workerPath = path.resolve(__dirname, "web-worker/create-agent-worker.ts");

function webAdkPlugin(): Plugin {
	let bundleJson: string | null = null;
	let commit: string | null = null;

	function getBundleData() {
		if (bundleJson && commit) return { bundleJson, commit };
		const bundle = buildWebAdkBundle();
		commit = bundle.commit;
		bundleJson = JSON.stringify(bundle);
		return { bundleJson, commit };
	}

	return {
		name: "web-adk-bundle",
		generateBundle() {
			const { bundleJson, commit } = getBundleData();
			this.emitFile({
				type: "asset",
				fileName: `web-adk/${commit}.json`,
				source: bundleJson,
			});
		},
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				const { bundleJson, commit } = getBundleData();
				const pathname = req.url
					? new URL(req.url, "http://localhost").pathname
					: "";
				const base = server.config.base || "/";
				const normalizedBase = base.endsWith("/") ? base : `${base}/`;
				const expectedUrl = `${normalizedBase}web-adk/${commit}.json`;
				const fallbackUrl = `/web-adk/${commit}.json`;

				if (pathname === expectedUrl || pathname === fallbackUrl) {
					res.setHeader("Content-Type", "application/json");
					res.end(bundleJson);
					return;
				}
				next();
			});
		},
	};
}


function virtualAgentWorkerPlugin(mode: string): Plugin {
	const virtualId = "virtual:naia-agent-worker";
	const resolvedVirtualId = `\0${virtualId}`;

	return {
		name: "virtual-naia-agent-worker",
		resolveId(id: string) {
			if (id === virtualId) {
				if (mode === "web") {
					return workerPath;
				}
				return resolvedVirtualId;
			}
		},
		load(id: string) {
			if (id === resolvedVirtualId) {
				return 'export function createAgentWorker() { throw new Error("desktop_only:agent-worker"); }';
			}
		},
	};
}

function webCspPlugin(): Plugin {
	return {
		name: "web-csp",
		apply: "build",
		transformIndexHtml(html: string) {
			const meta = `<meta http-equiv="Content-Security-Policy" content="${WEB_CSP}">`;
			return html.replace("<head>", `<head>\n    ${meta}`);
		},
	};
}

function stripRawGithubPlugin(): Plugin {
	return {
		name: "strip-raw-github",
		renderChunk(code) {
			if (code.includes("raw.githubusercontent.com")) {
				return {
					code: code.replaceAll(
						"raw.githubusercontent.com",
						"raw.githubusercontent.invalid",
					),
					map: null,
				};
			}
		},
		transform(code) {
			if (code.includes("raw.githubusercontent.com")) {
				return {
					code: code.replaceAll(
						"raw.githubusercontent.com",
						"raw.githubusercontent.invalid",
					),
					map: null,
				};
			}
		},
	};
}

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

export default defineConfig(async ({ mode }) => {
	const isWeb = mode === "web";
	if (isWeb && !process.env.VITE_NAIA_WEB_LLM) {
		process.env.VITE_NAIA_WEB_LLM = "webllm";
	}
	const agentDir = isWeb ? resolveWebAgentDir(process.env) : null;

	return {
		plugins: [
			react(),
			virtualAgentWorkerPlugin(mode),
			...(isWeb ? [webCspPlugin(), webAdkPlugin(), stripRawGithubPlugin()] : []),
		],
		build: {
			// Bundle-budget verification uses this graph to prove that large optional
			// surfaces stay behind dynamic imports instead of merely producing a
			// similarly named output file.
			manifest: true,
			target: "es2022",
		},
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
			...(isWeb && agentDir
				? {
						fs: {
							allow: [searchForWorkspaceRoot(process.cwd()), agentDir],
						},
					}
				: {}),
		},
		resolve: {
			alias: {
				"@": "/src",
				...(isWeb && agentDir
					? {
							"@naia-agent": path.join(agentDir, "src/main"),
						}
					: {}),
			},
		},
		...(isWeb
			? {
					worker: {
						format: "es" as const,
						plugins: () => [stripRawGithubPlugin()],
					},
					preview: {
						headers: {
							"Content-Security-Policy": WEB_CSP,
						},
					},
				}
			: {}),
	};
});
