import { cpSync, realpathSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin, searchForWorkspaceRoot } from "vite";
import { resolveWebAgentDir } from "./scripts/web-agent-dir.mjs";
import { buildWebAdkBundle } from "./scripts/web-adk-bundle.mjs";
import {
	PRIVATE_SLIDES_SOURCE_ENV,
	ensureWebKioskPrivateSlides,
} from "./scripts/web-kiosk-private-slides.mjs";
import { stampBuiltServiceWorker } from "./scripts/web-sw-version.mjs";
import { stageWebHostedApps } from "./scripts/web-hosted-apps.mjs";
import { WEB_CSP } from "./src/lib/web-runtime/csp";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workerPath = path.resolve(__dirname, "web-worker/create-agent-worker.ts");

// Web NVA and background bundles are served by the web build. Desktop reads
// these assets from the ADK workspace; copying the web bundles into its package
// duplicates them while the existing desktop public assets remain necessary.
function desktopPublicAssetsPlugin(): Plugin {
	let outputDirectory = "";
	const publicDirectory = path.resolve(__dirname, "public");
	const webOnly = new Set(["nva", "backgrounds", "kiosk-slides"]);
	return {
		name: "desktop-public-assets",
		apply: "build",
		configResolved(config) {
			outputDirectory = path.resolve(config.root, config.build.outDir);
		},
		writeBundle() {
			cpSync(publicDirectory, outputDirectory, {
				recursive: true,
				filter: (source) => !webOnly.has(path.relative(publicDirectory, source).split(path.sep)[0]),
			});
		},
	};
}

// 회사 소개 슬라이드 그림은 비밀번호를 거치는 시연판에서만 내보낸다. 일반 웹판 산출물에서는 지운다.
function kioskSlidesAssetsPlugin(): Plugin {
	let outputDirectory = "";
	return {
		name: "kiosk-slides-assets",
		apply: "build",
		configResolved(config) {
			outputDirectory = path.resolve(config.root, config.build.outDir);
		},
		closeBundle() {
			if (process.env.VITE_NAIA_KIOSK_DEMO === "1") return;
			rmSync(path.join(outputDirectory, "kiosk-slides"), {
				recursive: true,
				force: true,
			});
		},
	};
}

// 숫자가 든 비공개 장의 원고는 저장소 밖에 있다. 시연판 웹 빌드에서만 기록(sha256)과 맞는 원고를
// 덱에 합치고, 없으면 빌드를 멈춘다. 그 밖의 빌드와 시험에는 빈 목록을 준다.
function kioskPrivateSlidesPlugin(mode: string, command: string): Plugin {
	const virtualId = "virtual:kiosk-private-slides";
	const resolvedVirtualId = `\0${virtualId}`;
	return {
		name: "kiosk-private-slides",
		resolveId(id: string) {
			if (id === virtualId) return resolvedVirtualId;
		},
		load(id: string) {
			if (id !== resolvedVirtualId) return;
			let deck: { slides: unknown[] } = { slides: [] };
			if (mode === "web" && process.env.VITE_NAIA_KIOSK_DEMO === "1") {
				try {
					deck = ensureWebKioskPrivateSlides({
						source: process.env[PRIVATE_SLIDES_SOURCE_ENV],
					});
				} catch (error) {
					if (command === "build") throw error;
					// 개발 서버는 공개 장만으로 띄운다.
					console.warn(`[kiosk-private-slides] ${(error as Error).message}`);
				}
			}
			return `export default ${JSON.stringify(deck)};`;
		},
	};
}

function webAdkPlugin(): Plugin {
	let bundleJson: string | null = null;
	let commit: string | null = null;

	function getBundleData() {
		if (bundleJson && commit) return { bundleJson, commit };
		// 시연판은 공개 번들 중 허용 목록(.agents/context, .users, 참고 원본)만 싣는다. 걸러내기는 빌드에서 한다.
		const bundle = buildWebAdkBundle({
			kiosk: process.env.VITE_NAIA_KIOSK_DEMO === "1",
		});
		if (process.env.VITE_NAIA_KIOSK_DEMO === "1") {
			bundle.dirs = ["knowledge", "conversations"];
		}
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

function webServiceWorkerPlugin(revision: string): Plugin {
	let outputDirectory = "";
	let buildFailed = false;
	return {
		name: "web-service-worker",
		apply: "build",
		configResolved(config) {
			outputDirectory = path.resolve(config.root, config.build.outDir);
		},
		buildEnd(error) {
			if (error) buildFailed = true;
		},
		renderError() {
			buildFailed = true;
		},
		closeBundle(error) {
			if (buildFailed || error) return;
			stampBuiltServiceWorker({
				outDir: outputDirectory,
				revision,
			});
		},
	};
}

function webHostedAppsPlugin(): Plugin {
	let outputDirectory = "";
	return {
		name: "web-hosted-apps",
		configResolved(config) {
			outputDirectory = path.resolve(config.root, config.build.outDir);
		},
		writeBundle() {
			stageWebHostedApps(outputDirectory);
		},
		configurePreviewServer(server) {
			const prefix = `${server.config.base}hosted-apps/`;
			server.middlewares.use((req, res, next) => {
				if (req.url?.startsWith(prefix)) {
					// The public app assets can be loaded by an iframe whose origin is null.
					res.setHeader("Access-Control-Allow-Origin", "*");
					res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
					res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
				}
				next();
			});
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

export default defineConfig(async ({ mode, command }) => {
	const isWeb = mode === "web";
	let revision = "unknown";
	try {
		revision = execFileSync("git", ["rev-parse", "--short=8", "HEAD"], { cwd: __dirname, encoding: "utf8" }).trim();
	} catch { /* source archives may not include git metadata */ }
	if (isWeb && !process.env.VITE_NAIA_WEB_LLM) {
		process.env.VITE_NAIA_WEB_LLM = "webllm";
	}
	const agentDir = isWeb ? resolveWebAgentDir(process.env) : null;
	const workspaceRoot = searchForWorkspaceRoot(process.cwd());
	const fsAllow = [workspaceRoot];
	try {
		fsAllow.push(realpathSync(path.resolve(workspaceRoot, "node_modules")));
	} catch {
		/* ignore when node_modules is absent */
	}
	if (agentDir) {
		fsAllow.push(agentDir);
	}

	return {
		publicDir: command === "build" && !isWeb ? false : "public",
		plugins: [
			react(),
			...(command === "build" && !isWeb ? [desktopPublicAssetsPlugin()] : []),
			virtualAgentWorkerPlugin(mode),
			kioskPrivateSlidesPlugin(mode, command),
			...(isWeb ? [
				webCspPlugin(),
				webAdkPlugin(),
				kioskSlidesAssetsPlugin(),
				webServiceWorkerPlugin(revision),
				webHostedAppsPlugin(),
			] : []),
		],
		build: {
			// Bundle-budget verification uses this graph to prove that large optional
			// surfaces stay behind dynamic imports instead of merely producing a
			// similarly named output file.
			manifest: true,
		},
		define: {
			__WEB_VERSION__: JSON.stringify(`0.2.5-dev (${revision})`),
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
			fs: {
				allow: fsAllow,
			},
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
