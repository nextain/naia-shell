/// <reference lib="webworker" />
import {
	makeWebLLMProvider,
	startBrowserAgent,
	type WebLLMEngineLike,
} from "@naia-agent/composition/browser-agent.js";
import type { DiagnosticLog } from "@naia-agent/ports/uc1.js";
import { WEB_LLM_MODEL_ID } from "../src/lib/web-runtime/webllm-model";

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

async function loadEngine(): Promise<WebLLMEngineLike> {
	const startTime = performance.now();
	try {
		if (import.meta.env.VITE_NAIA_WEB_LLM === "fake") {
			const { makeFakeWebLLMEngine } = await import("./fake-engine");
			const engine = makeFakeWebLLMEngine();
			self.postMessage({
				kind: "engine-ready",
				model: WEB_LLM_MODEL_ID,
				elapsedMs: Math.round(performance.now() - startTime),
			});
			return engine;
		}
		if (
			!import.meta.env.VITE_NAIA_WEB_LLM ||
			import.meta.env.VITE_NAIA_WEB_LLM === "webllm"
		) {
			const { createWebLLMEngine } = await import("./webllm-engine");
			const engine = await createWebLLMEngine(
				WEB_LLM_MODEL_ID,
				handleProgress,
			);
			self.postMessage({
				kind: "engine-ready",
				model: WEB_LLM_MODEL_ID,
				elapsedMs: Math.round(performance.now() - startTime),
			});
			return engine;
		}
		throw new Error(
			`알 수 없는 VITE_NAIA_WEB_LLM: ${import.meta.env.VITE_NAIA_WEB_LLM}`,
		);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		self.postMessage({ kind: "engine-error", message });
		throw err;
	}
}

let enginePromise: Promise<WebLLMEngineLike> | null = null;
function getEngine(): Promise<WebLLMEngineLike> {
	if (!enginePromise) {
		enginePromise = loadEngine();
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

		// 엔진 준비 약속은 연결 메시지를 받는 순간 한 번 만들고 기억한다(내려받기를 바로 시작한다).
		void getEngine();

		const provider = makeWebLLMProvider({
			getEngine,
			model: WEB_LLM_MODEL_ID,
		});

		startBrowserAgent({
			port,
			diag,
			provider,
		});
	}
});
