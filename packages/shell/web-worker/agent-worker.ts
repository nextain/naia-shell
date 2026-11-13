/// <reference lib="webworker" />
import { makeKnowledgeSkillsExecutor } from "@naia-agent/adapters/knowledge-skill.js";
import {
	BROWSER_READ_TOOL_NAMES,
	type WebLLMEngineLike,
	makeBrowserReadTools,
	makePersonaSourceStore,
	makeWebLLMProvider,
	makeWorkspaceContextStore,
	startBrowserAgent,
} from "@naia-agent/composition/browser-agent.js";
import type { DiagnosticLog, ProviderPort } from "@naia-agent/ports/uc1.js";
import { isKioskDemo } from "../src/lib/kiosk-demo/flag";
import { SKILL_YOUTUBE_BGM } from "../src/lib/bgm-skill-spec";
import { WEB_ADK_PATH } from "../src/lib/web-runtime/web-adk-path";
import {
	WEB_LLM_MODEL_ID,
	type WebLlmModelId,
	isWebLlmModelId,
} from "../src/lib/web-runtime/webllm-model";
import {
	type ActiveSlideRequestContext,
	EMPTY_ADK_SNAPSHOT,
	buildKioskSystemPromptFromSnapshot,
	extractActiveSlideFromChatRequest,
	makeSnapshotFs,
	readAdkSnapshot,
} from "./adk-snapshot-fs";
import {
	relayAgentPort,
	resolveWebChatTurnEnableThinking,
	wrapEngineWithEnableThinking,
} from "./agent-port-relay";
import { webGatewayBaseUrl } from "./gateway-url";
import { startKioskBrowserAgent } from "./kiosk-browser-agent";
import { makeOpenAICompatProvider } from "./openai-compat-provider";
import { makeOpfsReadFs } from "./opfs-read-fs";

// YouTube search + iframe load can take a while on a cold kiosk.
const WEB_APP_TOOL_TIMEOUT_MS = 60_000;

const diag: DiagnosticLog = {
	log(message: string, ctx?: unknown) {
		const payload: {
			kind: "diag";
			level: "log";
			message: string;
			ctx?: string;
		} = {
			kind: "diag",
			level: "log",
			message,
		};
		if (ctx !== undefined) {
			payload.ctx = typeof ctx === "string" ? ctx : JSON.stringify(ctx);
		}
		self.postMessage(payload);
	},
	debug(message: string, ctx?: unknown) {
		const payload: {
			kind: "diag";
			level: "debug";
			message: string;
			ctx?: string;
		} = {
			kind: "diag",
			level: "debug",
			message,
		};
		if (ctx !== undefined) {
			payload.ctx = typeof ctx === "string" ? ctx : JSON.stringify(ctx);
		}
		self.postMessage(payload);
	},
};

let lastReportedProgress = -1;
function handleProgress(p: { progress: number; text: string }): void {
	if (p.progress - lastReportedProgress >= 0.05 || p.progress === 1) {
		lastReportedProgress = p.progress;
		self.postMessage({
			kind: "engine-progress",
			progress: p.progress,
			text: p.text,
		});
	}
}

async function loadEngine(model: WebLlmModelId): Promise<WebLLMEngineLike> {
	const startTime = performance.now();
	try {
		if (import.meta.env.VITE_NAIA_WEB_LLM === "fake") {
			const { makeFakeWebLLMEngine } = await import("./fake-engine");
			const engine = makeFakeWebLLMEngine();
			self.postMessage({
				kind: "engine-ready",
				model,
				elapsedMs: Math.round(performance.now() - startTime),
			});
			return engine;
		}
		if (
			!import.meta.env.VITE_NAIA_WEB_LLM ||
			import.meta.env.VITE_NAIA_WEB_LLM === "webllm"
		) {
			const { createWebLLMEngine } = await import("./webllm-engine");
			const engine = await createWebLLMEngine(model, handleProgress);
			self.postMessage({
				kind: "engine-ready",
				model,
				elapsedMs: Math.round(performance.now() - startTime),
			});
			return engine;
		}
		throw new Error(
			`알 수 없는 VITE_NAIA_WEB_LLM: ${import.meta.env.VITE_NAIA_WEB_LLM}`,
		);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		const name = err instanceof Error ? err.name : "Error";
		self.postMessage({ kind: "engine-error", name, message });
		throw err;
	}
}

let selectedModel: WebLlmModelId | null = null;
let enginePromise: Promise<WebLLMEngineLike> | null = null;
function getEngine(): Promise<WebLLMEngineLike> {
	if (!selectedModel) {
		return Promise.reject(new Error("webllm-not-started"));
	}
	if (!enginePromise) {
		enginePromise = loadEngine(selectedModel);
	}
	return enginePromise;
}

let connected = false;

self.addEventListener("message", (event: MessageEvent) => {
	const data = event.data;
	if (
		data &&
		typeof data === "object" &&
		data.kind === "naia-agent-select-model"
	) {
		if (data.model === null) {
			selectedModel = null;
			enginePromise = null;
		} else if (typeof data.model === "string" && isWebLlmModelId(data.model)) {
			if (selectedModel !== data.model) {
				selectedModel = data.model;
				enginePromise = null;
			}
			getEngine().catch(() => {});
		} else {
			self.postMessage({
				kind: "engine-error",
				name: "InvalidModel",
				message: `허용되지 않은 모델: ${String(data.model)}`,
			});
		}
		return;
	}
	if (data && typeof data === "object" && data.kind === "naia-agent-connect") {
		if (connected) {
			diag.log("이미 연결된 Worker에 중복 naia-agent-connect 수신");
			return;
		}
		connected = true;
		const port = event.ports[0];
		if (!port) {
			diag.log("naia-agent-connect에 MessagePort 누락");
			return;
		}

		if (data.model === undefined) {
			selectedModel = isKioskDemo() ? null : WEB_LLM_MODEL_ID;
		} else if (data.model === null) {
			selectedModel = null;
		} else if (typeof data.model === "string") {
			if (isWebLlmModelId(data.model)) {
				selectedModel = data.model;
			} else {
				self.postMessage({
					kind: "engine-error",
					name: "InvalidModel",
					message: `허용되지 않은 모델: ${data.model}`,
				});
				selectedModel = null;
			}
		} else {
			selectedModel = null;
		}

		if (selectedModel) {
			// Warm-up only: a failure is already reported to the UI as engine-error.
			getEngine().catch(() => {});
		}

		const kioskSpecs = isKioskDemo()
			? makeKnowledgeSkillsExecutor().specs()
			: [];
		const kiosk = isKioskDemo() ? awaitKioskTools() : null;
		let snapshot = EMPTY_ADK_SNAPSHOT;
		let activeEnableThinking = false;
		let activeSlideContext: ActiveSlideRequestContext | null = null;
		const refresh = async (rawLine: string) => {
			activeSlideContext = extractActiveSlideFromChatRequest(rawLine);
			if (kiosk) await (await kiosk).refresh(activeSlideContext);
			snapshot = await readAdkSnapshot(() => navigator.storage.getDirectory());
			activeEnableThinking = resolveWebChatTurnEnableThinking(
				rawLine,
				snapshot.configText,
			);
		};

		const getEngineWithThinking = async (): Promise<WebLLMEngineLike> => {
			const baseEngine = await getEngine();
			return wrapEngineWithEnableThinking(
				baseEngine,
				() => activeEnableThinking,
			);
		};

		const localToolNames = isKioskDemo()
			? [
					...BROWSER_READ_TOOL_NAMES,
					...kioskSpecs.map((s) => s.name),
					SKILL_YOUTUBE_BGM.name,
				]
			: [...BROWSER_READ_TOOL_NAMES, SKILL_YOUTUBE_BGM.name];

		const localProvider = makeWebLLMProvider({
			getEngine: getEngineWithThinking,
			model: selectedModel ?? WEB_LLM_MODEL_ID,
			toolNames: localToolNames,
		});

		const provider: ProviderPort = {
			chat(config, messages, opts) {
				if (config.provider === "webllm")
					return localProvider.chat(config, messages, opts);
				if (config.provider !== "nextain")
					throw new Error(`Unsupported web provider: ${config.provider}`);
				if (!config.naiaKey)
					throw new Error("Naia account authentication required");
				const baseUrl = webGatewayBaseUrl(config.labGatewayUrl);
				return makeOpenAICompatProvider({
					baseUrl,
					apiKey: config.naiaKey,
					auth: "x-anyllm",
					supportsTools: true,
					supportsThinkingLevel: true,
					echoReasoningContent: true,
				}).chat(config, messages, opts);
			},
		};

		const baseToolExecutor = makeBrowserReadTools({
			fs: makeOpfsReadFs(() => navigator.storage.getDirectory()),
		});

		async function awaitKioskTools() {
			const mod = await import("./kiosk-knowledge");
			return mod.makeKioskKnowledgeTools(baseToolExecutor);
		}
		const webBgmToolSpec = {
			name: SKILL_YOUTUBE_BGM.name,
			description: SKILL_YOUTUBE_BGM.description,
			parameters: SKILL_YOUTUBE_BGM.parameters,
		};
		// skill_youtube_bgm is owned by the shell (BgmPlayer). Delegate it the same
		// way the native agent does: emit app_tool_call on the chat stream and wait
		// for the shell's app_tool_result.
		const pendingAppTools = new Map<
			string,
			(r: { output: string; isError?: boolean }) => void
		>();
		const executeWebBgmTool: typeof baseToolExecutor.execute = (
			call,
			opts,
		) =>
			new Promise((resolve) => {
				if (!opts.requestId) {
					resolve({ output: "Error: missing requestId", isError: true });
					return;
				}
				const settle = (r: { output: string; isError?: boolean }) => {
					if (!pendingAppTools.delete(call.id)) return;
					clearTimeout(timer);
					resolve(r);
				};
				const timer = setTimeout(
					() => settle({ output: "Error: app tool timeout", isError: true }),
					WEB_APP_TOOL_TIMEOUT_MS,
				);
				pendingAppTools.set(call.id, settle);
				opts.signal?.addEventListener("abort", () =>
					settle({ output: "Error: cancelled", isError: true }),
				);
				port.postMessage(
					JSON.stringify({
						type: "app_tool_call",
						requestId: opts.requestId,
						toolCallId: call.id,
						toolName: call.name,
						args:
							call.args && typeof call.args === "object" ? call.args : {},
					}),
				);
			});
		function consumeAppToolResult(rawLine: string): boolean {
			let parsed: {
				type?: unknown;
				toolCallId?: unknown;
				result?: unknown;
				success?: unknown;
			};
			try {
				parsed = JSON.parse(rawLine);
			} catch {
				return false;
			}
			if (
				!parsed ||
				parsed.type !== "app_tool_result" ||
				typeof parsed.toolCallId !== "string"
			)
				return false;
			const settle = pendingAppTools.get(parsed.toolCallId);
			if (!settle) return false;
			settle({
				output: typeof parsed.result === "string" ? parsed.result : "",
				isError: parsed.success === false,
			});
			return true;
		}
		const withWebBgm = (
			execute: typeof baseToolExecutor.execute,
		): typeof baseToolExecutor.execute =>
			(call, opts) =>
				call.name === SKILL_YOUTUBE_BGM.name
					? executeWebBgmTool(call, opts)
					: execute(call, opts);

		const toolExecutor = isKioskDemo()
			? {
					specs: () => [
						...baseToolExecutor.specs(),
						...kioskSpecs,
						webBgmToolSpec,
					],
					execute: withWebBgm(async (...args) =>
						(await kiosk!).executor.execute(...args),
					),
				}
			: {
					specs: () => [...baseToolExecutor.specs(), webBgmToolSpec],
					execute: withWebBgm(baseToolExecutor.execute),
				};

		port.addEventListener("message", (event: MessageEvent) => {
			if (typeof event.data !== "string") return;
			try {
				const parsed = JSON.parse(event.data);
				if (
					parsed &&
					typeof parsed === "object" &&
					parsed.type === "skill_list" &&
					typeof parsed.requestId === "string"
				) {
					port.postMessage(
						JSON.stringify({
							type: "skill_list_response",
							requestId: parsed.requestId,
							tools: toolExecutor.specs(),
						}),
					);
				}
			} catch {
				// ignore
			}
		});

		const channel = new MessageChannel();
		relayAgentPort({
			outer: port,
			inner: channel.port1,
			beforeChatRequest: refresh,
			diag,
			consumeOuterLine: consumeAppToolResult,
		});

		const snapshotFs = makeSnapshotFs(() => snapshot);

		const personaSource = makePersonaSourceStore({
			fs: snapshotFs,
			adkPath: WEB_ADK_PATH,
		});
		const startAgent = isKioskDemo()
			? startKioskBrowserAgent
			: startBrowserAgent;
		startAgent({
			port: channel.port2,
			diag,
			provider,
			toolExecutor,
			personaSource: isKioskDemo()
				? {
						load() {
							const profile = personaSource.load();
							return {
								...profile,
								systemPromptPrefix: buildKioskSystemPromptFromSnapshot(
									snapshot,
									profile?.systemPromptPrefix ?? profile?.personaText ?? "",
									activeSlideContext,
								),
							};
						},
					}
				: personaSource,
			workspaceContext: makeWorkspaceContextStore({
				fs: snapshotFs,
				adkPath: WEB_ADK_PATH,
				cwd: WEB_ADK_PATH,
			}),
		});
	}
});
