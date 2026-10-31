import { createAgentWorker } from "virtual:naia-agent-worker";
import { getStoredLocalSessionId, useChatStore } from "../../stores/chat";
import { Logger } from "../logger";
import { emitWebEvent } from "./event-bus";
import { type WebFs, getWebFs } from "./web-fs";
import {
	errorKindFromEngineErrorName,
	getWebModelStatus,
	setWebModelStatus,
} from "./web-model-status";
import {
	appendWebConversationMessages,
	resolveWebConversationsDir,
} from "./web-workspace-commands";
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
	getFs?: () => WebFs;
}): StartableAgentBridge {
	const resolveFs = deps.getFs ?? getWebFs;
	let worker: WorkerLike | null = null;
	let channelPort: MessagePort | null = null;
	let started = false;
	const pendingLines: string[] = [];
	const activeTurns = new Map<
		string,
		{
			sessionId: string;
			conversationsDir: string;
			userContent: string;
			userTimestamp: number;
			assistantReply: string;
		}
	>();

	function trackOutgoingLine(line: string): void {
		try {
			const parsed = JSON.parse(line) as {
				type?: unknown;
				requestId?: unknown;
				sessionId?: unknown;
				messages?: unknown;
				message?: unknown;
				prompt?: unknown;
			};
			if (!parsed || typeof parsed !== "object") return;
			if (
				parsed.type === "chat_request" &&
				typeof parsed.requestId === "string" &&
				parsed.requestId.length > 0
			) {
				const explicitSessionId =
					typeof parsed.sessionId === "string" ? parsed.sessionId.trim() : "";
				const sessionId =
					explicitSessionId.length > 0
						? explicitSessionId
						: getStoredLocalSessionId() ||
							useChatStore.getState().localSessionId ||
							"default";
				let userContent = "";
				if (Array.isArray(parsed.messages)) {
					for (let i = parsed.messages.length - 1; i >= 0; i--) {
						const msg = parsed.messages[i] as {
							role?: unknown;
							content?: unknown;
						} | null;
						if (msg && msg.role === "user" && typeof msg.content === "string") {
							userContent = msg.content;
							break;
						}
					}
				} else if (typeof parsed.message === "string") {
					userContent = parsed.message;
				} else if (typeof parsed.prompt === "string") {
					userContent = parsed.prompt;
				}
				if (userContent.length > 0) {
					activeTurns.set(parsed.requestId, {
						sessionId,
						conversationsDir: resolveWebConversationsDir(),
						userContent,
						userTimestamp: Date.now(),
						assistantReply: "",
					});
				}
			} else if (
				parsed.type === "cancel_stream" &&
				typeof parsed.requestId === "string"
			) {
				activeTurns.delete(parsed.requestId);
			}
		} catch {
			// 비 JSON 제어 라인은 무시
		}
	}

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
			if (typeof event.data !== "string") return;
			const rawLine = event.data;
			try {
				const chunk = JSON.parse(rawLine) as {
					type?: unknown;
					requestId?: unknown;
					text?: unknown;
					content?: unknown;
				};
				if (
					chunk &&
					typeof chunk === "object" &&
					typeof chunk.requestId === "string"
				) {
					const turn = activeTurns.get(chunk.requestId);
					if (turn) {
						if (chunk.type === "text") {
							const delta =
								typeof chunk.text === "string"
									? chunk.text
									: typeof chunk.content === "string"
										? chunk.content
										: "";
							if (delta.length > 0) {
								turn.assistantReply += delta;
							}
						} else if (chunk.type === "error") {
							activeTurns.delete(chunk.requestId);
						} else if (chunk.type === "finish") {
							activeTurns.delete(chunk.requestId);
							if (turn.assistantReply.length > 0) {
								const now = Math.max(Date.now(), turn.userTimestamp);
								void appendWebConversationMessages(
									turn.sessionId,
									[
										{
											role: "user",
											content: turn.userContent,
											timestamp: turn.userTimestamp,
										},
										{
											role: "assistant",
											content: turn.assistantReply,
											timestamp: now,
										},
									],
									resolveFs(),
									turn.conversationsDir,
								)
									.catch((err) => {
										Logger.warn(
											"WebAgent",
											"failed to persist conversation turn",
											{ error: String(err) },
										);
									})
									.finally(() => {
										deps.emit("agent_response", rawLine);
									});
								return;
							}
						}
					}
				}
			} catch {
				// 비 JSON 응답은 그대로 전달
			}
			deps.emit("agent_response", rawLine);
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
			trackOutgoingLine(line);
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
