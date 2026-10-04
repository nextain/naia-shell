/// <reference lib="webworker" />
import {
	makePersonaSourceStore,
	makeWorkspaceContextStore,
	makeWebLLMProvider,
	startBrowserAgent,
	type WebLLMEngineLike,
} from "@naia-agent/composition/browser-agent.js";
import type { DiagnosticLog } from "@naia-agent/ports/uc1.js";
import { WEB_ADK_PATH } from "../src/lib/web-runtime/web-adk-path";
import {
	isWebLlmModelId,
	WEB_LLM_MODEL_ID,
	type WebLlmModelId,
} from "../src/lib/web-runtime/webllm-model";
import {
	EMPTY_ADK_SNAPSHOT,
	makeSnapshotFs,
	readAdkSnapshot,
} from "./adk-snapshot-fs";
import { relayAgentPort } from "./agent-port-relay";

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
			selectedModel = WEB_LLM_MODEL_ID;
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
			void getEngine();
		}

		const provider = makeWebLLMProvider({
			getEngine,
			model: selectedModel ?? WEB_LLM_MODEL_ID,
		});

		let snapshot = EMPTY_ADK_SNAPSHOT;
		const refresh = async () => {
			snapshot = await readAdkSnapshot(() => navigator.storage.getDirectory());
		};

		const channel = new MessageChannel();
		relayAgentPort({
			outer: port,
			inner: channel.port1,
			beforeChatRequest: refresh,
			diag,
		});

		const snapshotFs = makeSnapshotFs(() => snapshot);

		startBrowserAgent({
			port: channel.port2,
			diag,
			provider,
			personaSource: makePersonaSourceStore({
				fs: snapshotFs,
				adkPath: WEB_ADK_PATH,
			}),
			workspaceContext: makeWorkspaceContextStore({
				fs: snapshotFs,
				adkPath: WEB_ADK_PATH,
				cwd: WEB_ADK_PATH,
			}),
		});
	}
});
