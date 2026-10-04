import { createAgentWorker } from "virtual:naia-agent-worker";
import { Logger } from "../logger";
import { emitWebEvent } from "./event-bus";
import {
	errorKindFromEngineErrorName,
	getWebModelStatus,
	setWebModelStatus,
} from "./web-model-status";
import { isWebLlmModelId } from "./webllm-model";

export interface WorkerLike {
	postMessage(message: unknown, transfer?: Transferable[]): void;
	addEventListener(
		type: string,
		listener: (ev: MessageEvent | ErrorEvent | unknown) => void,
	): void;
}

export interface AgentBridge {
	sendLine(line: string): void;
}

export interface StartableAgentBridge extends AgentBridge {
	start(opts: { model: string | null }): void;
}

export function createAgentBridge(deps: {
	createWorker: () => WorkerLike;
	emit: (event: string, payload: unknown) => void;
}): StartableAgentBridge {
	let worker: WorkerLike | null = null;
	let channelPort: MessagePort | null = null;
	let started = false;
	const pendingLines: string[] = [];

	function start(opts: { model: string | null }): void {
		if (started) {
			Logger.warn("WebAgent", "duplicate start call ignored");
			return;
		}
		started = true;

		worker = deps.createWorker();
		const channel = new MessageChannel();
		channelPort = channel.port1;

		channel.port1.onmessage = (event: MessageEvent) => {
			if (typeof event.data === "string") {
				deps.emit("agent_response", event.data);
			}
		};
		channel.port1.start?.();

		worker.addEventListener("message", (event: unknown) => {
			const data = (event as MessageEvent)?.data;
			if (!data || typeof data !== "object") return;

			if (data.kind === "diag") {
				const ctx = data.ctx ? { ctx: data.ctx } : undefined;
				if (data.level === "log") {
					Logger.warn("WebAgent", data.message, ctx);
				} else if (data.level === "debug") {
					Logger.debug("WebAgent", data.message, ctx);
				}
			} else if (data.kind === "engine-progress") {
				Logger.info("WebAgent", "webllm-progress", {
					progress: data.progress,
					text: data.text,
				});
				if (getWebModelStatus().phase !== "error") {
					setWebModelStatus({
						phase: "loading",
						progress: typeof data.progress === "number" ? data.progress : 0,
					});
				}
			} else if (data.kind === "engine-ready") {
				Logger.info("WebAgent", "webllm-ready", {
					model: data.model,
					elapsedMs: data.elapsedMs,
				});
				if (isWebLlmModelId(data.model)) {
					setWebModelStatus({
						phase: "ready",
						progress: 1,
						model: data.model,
					});
				} else {
					Logger.error("WebAgent", "unknown model in engine-ready", {
						model: data.model,
					});
				}
			} else if (data.kind === "engine-error") {
				Logger.error("WebAgent", "webllm-error", {
					message: data.message,
				});
				setWebModelStatus({
					phase: "error",
					errorKind: errorKindFromEngineErrorName(data.name),
					errorMessage:
						typeof data.message === "string"
							? data.message
							: String(data.message),
				});
			}
		});

		worker.addEventListener("error", (event: unknown) => {
			const err = event as ErrorEvent;
			const message = err?.message || String(err);
			Logger.error("WebAgent", "worker-error", {
				message,
			});
			setWebModelStatus({
				phase: "error",
				errorKind: "load-failed",
				errorMessage: message,
			});
		});

		worker.postMessage({ kind: "naia-agent-connect", model: opts.model }, [
			channel.port2,
		]);

		while (pendingLines.length > 0) {
			const line = pendingLines.shift();
			if (line !== undefined) {
				channelPort.postMessage(line);
			}
		}
	}

	return {
		start,
		sendLine(line: string): void {
			if (!channelPort) {
				pendingLines.push(line);
				return;
			}
			channelPort.postMessage(line);
		},
	};
}

let defaultBridge: StartableAgentBridge | null = null;
let customBridge: AgentBridge | null = null;

export function getStartableAgentBridge(): StartableAgentBridge {
	if (!defaultBridge) {
		defaultBridge = createAgentBridge({
			createWorker: createAgentWorker,
			emit: emitWebEvent,
		});
	}
	return defaultBridge;
}

export function getAgentBridge(): AgentBridge {
	if (customBridge) {
		return customBridge;
	}
	return getStartableAgentBridge();
}

export function setAgentBridgeForTests(bridge: AgentBridge | null): void {
	customBridge = bridge;
}
