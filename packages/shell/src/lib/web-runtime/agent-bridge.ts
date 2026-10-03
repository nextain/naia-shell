import { createAgentWorker } from "virtual:naia-agent-worker";
import { Logger } from "../logger";
import { emitWebEvent } from "./event-bus";

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

export function createAgentBridge(deps: {
	createWorker: () => WorkerLike;
	emit: (event: string, payload: unknown) => void;
}): AgentBridge {
	let worker: WorkerLike | null = null;
	let channelPort: MessagePort | null = null;

	function ensureWorker(): MessagePort {
		if (channelPort) return channelPort;

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
			} else if (data.kind === "engine-ready") {
				Logger.info("WebAgent", "webllm-ready", {
					model: data.model,
					elapsedMs: data.elapsedMs,
				});
			} else if (data.kind === "engine-error") {
				Logger.error("WebAgent", "webllm-error", {
					message: data.message,
				});
			}
		});

		worker.addEventListener("error", (event: unknown) => {
			const err = event as ErrorEvent;
			Logger.error("WebAgent", "worker-error", {
				message: err?.message || String(err),
			});
		});

		worker.postMessage({ kind: "naia-agent-connect" }, [channel.port2]);

		return channel.port1;
	}

	return {
		sendLine(line: string): void {
			const port = ensureWorker();
			port.postMessage(line);
		},
	};
}

let defaultBridge: AgentBridge | null = null;
let customBridge: AgentBridge | null = null;

export function getAgentBridge(): AgentBridge {
	if (customBridge) {
		return customBridge;
	}
	if (!defaultBridge) {
		defaultBridge = createAgentBridge({
			createWorker: createAgentWorker,
			emit: emitWebEvent,
		});
	}
	return defaultBridge;
}

export function setAgentBridgeForTests(bridge: AgentBridge | null): void {
	customBridge = bridge;
}
