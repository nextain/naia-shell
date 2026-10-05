import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { isNaiaAccountProvider } from "../lib/credits";
import { Logger } from "../lib/logger";
import type {
	ChatMessage,
	CostEntry,
	ProviderId,
	ToolCall,
} from "../lib/types";
import { useAppStore } from "./app";

function naiaPortion(
	cost: { provider: string; cost: number } | undefined,
): number {
	return cost && isNaiaAccountProvider(cost.provider) ? cost.cost : 0;
}

function requestBrowserVisibilitySync() {
	window.dispatchEvent(new Event("naia-browser-visibility-sync"));
}

export interface PendingApproval {
	requestId: string;
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	tier: number;
	description: string;
}

export interface SessionOverlay {
	messages: ChatMessage[];
	totalCost: number;
	totalCostNaia: number;
	deleted?: boolean;
}

interface ChatState {
	sessionId: string | null;
	/** Local session ID for offline history persistence (agent-side save). */
	localSessionId: string;
	sessionOverlays: Record<string, SessionOverlay>;
	messages: ChatMessage[];
	isStreaming: boolean;
	streamingContent: string;
	streamingThinking: string;
	streamingToolCalls: ToolCall[];
	provider: ProviderId;
	totalSessionCost: number;
	/** Portion of `totalSessionCost` (USD estimate) incurred on the Naia account (#727). */
	totalSessionCostNaia: number;
	sessionCostEntries: CostEntry[];
	pendingApproval: PendingApproval | null;
	messageQueue: string[];

	setSessionId: (id: string) => void;
	setLocalSessionId: (id: string) => void;
	setMessages: (messages: ChatMessage[]) => void;
	addMessage: (
		msg: Pick<ChatMessage, "role" | "content"> &
			Partial<Pick<ChatMessage, "cost" | "failure">>,
	) => void;
	recordVoiceCostSummary: (
		targetLocalSessionId: string,
		msg: Pick<ChatMessage, "role" | "content"> &
			Partial<Pick<ChatMessage, "cost" | "failure">>,
	) => void;
	deleteSessionOverlay: (key: string) => void;
	updateLastMessage: (role: ChatMessage["role"], content: string) => void;
	startStreaming: () => void;
	appendStreamChunk: (text: string) => void;
	appendThinkingChunk: (text: string) => void;
	addStreamingToolUse: (
		toolCallId: string,
		toolName: string,
		args: Record<string, unknown>,
	) => void;
	updateStreamingToolResult: (
		toolCallId: string,
		success: boolean,
		output: string,
	) => void;
	finishStreaming: () => void;
	addCostEntry: (entry: CostEntry) => void;
	/** Add a cost entry not attached to any message (e.g. STT). Shown in CostDashboard breakdown. */
	addSessionCostEntry: (entry: CostEntry) => void;
	setProvider: (provider: ProviderId) => void;
	setPendingApproval: (approval: PendingApproval) => void;
	clearPendingApproval: () => void;
	newConversation: () => void;
	enqueueMessage: (text: string) => void;
	dequeueMessage: () => string | undefined;
}

// 새로고침에는 지금 대화를 되살리되, 앱을 새로 켜면 새 대화로 시작한다(sessionStorage).
export const CHAT_LOCAL_SESSION_KEY = "naia-chat-session-id";

export function getStoredLocalSessionId(): string | null {
	if (typeof sessionStorage === "undefined") return null;
	try {
		const val = sessionStorage.getItem(CHAT_LOCAL_SESSION_KEY);
		return val && val.trim() ? val.trim() : null;
	} catch {
		return null;
	}
}

export function setStoredLocalSessionId(id: string): void {
	if (typeof sessionStorage === "undefined") return;
	try {
		sessionStorage.setItem(CHAT_LOCAL_SESSION_KEY, id);
	} catch {}
}

export function clearStoredLocalSessionId(): void {
	if (typeof sessionStorage === "undefined") return;
	try {
		sessionStorage.removeItem(CHAT_LOCAL_SESSION_KEY);
	} catch {}
}

function generateId(): string {
	return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function generateLocalSessionId(): string {
	return `chat-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function getInitialLocalSessionId(): string {
	const stored = getStoredLocalSessionId();
	if (stored) {
		return stored;
	}
	const fresh = generateLocalSessionId();
	setStoredLocalSessionId(fresh);
	return fresh;
}

export const useChatStore = create<ChatState>()((set, get) => ({
	sessionId: null,
	localSessionId: getInitialLocalSessionId(),
	sessionOverlays: {},
	messages: [],
	isStreaming: false,
	streamingContent: "",
	streamingThinking: "",
	streamingToolCalls: [],
	// FR-LLM-LOGOUT.2: 초기 제공자는 비어 있다. 설정이 제공자를 정한다.
	provider: "",
	totalSessionCost: 0,
	totalSessionCostNaia: 0,
	sessionCostEntries: [],
	pendingApproval: null,
	messageQueue: [],

	setSessionId: (id) => set({ sessionId: id }),
	setLocalSessionId: (id) => {
		setStoredLocalSessionId(id);
		set({ localSessionId: id });
	},

	setMessages: (messages) =>
		set((s) => {
			const overlay = s.sessionOverlays[s.localSessionId];
			const baseCost = messages.reduce((sum, m) => sum + (m.cost?.cost ?? 0), 0);
			const baseNaia = messages.reduce((sum, m) => sum + naiaPortion(m.cost), 0);
			if (overlay && !overlay.deleted && overlay.messages.length > 0) {
				const existingIds = new Set(messages.map((m) => m.id));
				const extra = overlay.messages.filter((m) => !existingIds.has(m.id));
				return {
					messages: [...messages, ...extra],
					totalSessionCost: baseCost + overlay.totalCost,
					totalSessionCostNaia: baseNaia + overlay.totalCostNaia,
				};
			}
			return {
				messages,
				totalSessionCost: baseCost,
				totalSessionCostNaia: baseNaia,
			};
		}),

	addMessage: (msg) =>
		set((s) => ({
			messages: [
				...s.messages,
				{ ...msg, id: generateId(), timestamp: Date.now() },
			],
			totalSessionCost: s.totalSessionCost + (msg.cost?.cost ?? 0),
			totalSessionCostNaia: s.totalSessionCostNaia + naiaPortion(msg.cost),
		})),

	recordVoiceCostSummary: (targetLocalSessionId, msg) =>
		set((s) => {
			if (s.sessionOverlays[targetLocalSessionId]?.deleted) {
				return s;
			}
			const newMsg: ChatMessage = {
				...msg,
				id: generateId(),
				timestamp: Date.now(),
			};
			const costDelta = msg.cost?.cost ?? 0;
			const naiaDelta = naiaPortion(msg.cost);

			const prevOverlay = s.sessionOverlays[targetLocalSessionId] ?? {
				messages: [],
				totalCost: 0,
				totalCostNaia: 0,
			};
			const nextOverlay: SessionOverlay = {
				messages: [...prevOverlay.messages, newMsg],
				totalCost: prevOverlay.totalCost + costDelta,
				totalCostNaia: prevOverlay.totalCostNaia + naiaDelta,
			};

			const sessionOverlays = {
				...s.sessionOverlays,
				[targetLocalSessionId]: nextOverlay,
			};

			if (s.localSessionId === targetLocalSessionId) {
				return {
					sessionOverlays,
					messages: [...s.messages, newMsg],
					totalSessionCost: s.totalSessionCost + costDelta,
					totalSessionCostNaia: s.totalSessionCostNaia + naiaDelta,
				};
			}

			return { sessionOverlays };
		}),

	deleteSessionOverlay: (key) =>
		set((s) => {
			const overlays = { ...s.sessionOverlays };
			overlays[key] = {
				messages: [],
				totalCost: 0,
				totalCostNaia: 0,
				deleted: true,
			};
			return { sessionOverlays: overlays };
		}),

	updateLastMessage: (role, content) =>
		set((s) => {
			for (let i = s.messages.length - 1; i >= 0; i--) {
				if (s.messages[i].role === role) {
					const updated = [...s.messages];
					updated[i] = { ...updated[i], content };
					return { messages: updated };
				}
			}
			// No existing message ??add new one
			return {
				messages: [
					...s.messages,
					{ role, content, id: generateId(), timestamp: Date.now() },
				],
			};
		}),

	startStreaming: () =>
		set({
			isStreaming: true,
			streamingContent: "",
			streamingThinking: "",
			streamingToolCalls: [],
		}),

	appendStreamChunk: (text) =>
		set((s) => ({ streamingContent: s.streamingContent + text })),

	appendThinkingChunk: (text) =>
		set((s) => ({ streamingThinking: s.streamingThinking + text })),

	addStreamingToolUse: (toolCallId, toolName, args) =>
		set((s) => {
			if (s.streamingToolCalls.some((tc) => tc.toolCallId === toolCallId)) {
				return s;
			}
			return {
				streamingToolCalls: [
					...s.streamingToolCalls,
					{ toolCallId, toolName, args, status: "running" as const },
				],
			};
		}),

	updateStreamingToolResult: (toolCallId, success, output) =>
		set((s) => {
			const found = s.streamingToolCalls.some(
				(tc) => tc.toolCallId === toolCallId,
			);
			if (!found) {
				Logger.warn("ChatStore", "tool_result for unknown toolCallId", {
					toolCallId,
				});
				return s;
			}
			return {
				streamingToolCalls: s.streamingToolCalls.map((tc) =>
					tc.toolCallId === toolCallId
						? {
								...tc,
								status: (success ? "success" : "error") as "success" | "error",
								output,
							}
						: tc,
				),
			};
		}),

	finishStreaming: () => {
		const {
			isStreaming,
			streamingContent,
			streamingThinking,
			streamingToolCalls,
			pendingApproval,
		} = get();
		if (!isStreaming) return;
		// If approval was pending and browser is active, re-show WebView2 (mirrors clearPendingApproval)
		if (pendingApproval && useAppStore.getState().activeApp === "browser") {
			requestBrowserVisibilitySync();
		}
		const toolCalls =
			streamingToolCalls.length > 0 ? streamingToolCalls : undefined;
		set((s) => ({
			isStreaming: false,
			streamingContent: "",
			streamingThinking: "",
			streamingToolCalls: [],
			pendingApproval: null,
			messages: [
				...s.messages,
				{
					id: generateId(),
					role: "assistant" as const,
					content: streamingContent,
					thinking: streamingThinking || undefined,
					timestamp: Date.now(),
					toolCalls,
				},
			],
		}));
	},

	addCostEntry: (entry) =>
		set((s) => {
			const messages = [...s.messages];
			let attached = false;
			for (let i = messages.length - 1; i >= 0; i--) {
				if (messages[i].role === "assistant") {
					const prev = messages[i].cost;
					// Accumulate cost ??don't overwrite previous entries
					messages[i] = {
						...messages[i],
						cost: prev
							? {
									inputTokens: prev.inputTokens + entry.inputTokens,
									outputTokens: prev.outputTokens + entry.outputTokens,
									cost: prev.cost + entry.cost,
									provider: entry.provider,
									model: entry.model,
								}
							: entry,
					};
					attached = true;
					break;
				}
			}
			if (!attached) {
				Logger.warn("ChatStore", "No assistant message to attach cost entry");
			}
			return {
				messages,
				totalSessionCost: s.totalSessionCost + entry.cost,
				totalSessionCostNaia: s.totalSessionCostNaia + naiaPortion(entry),
			};
		}),

	addSessionCostEntry: (entry) =>
		set((s) => {
			const key = `${entry.provider}|${entry.model}`;
			const existing = s.sessionCostEntries.find(
				(e) => `${e.provider}|${e.model}` === key,
			);
			const sessionCostEntries = existing
				? s.sessionCostEntries.map((e) =>
						`${e.provider}|${e.model}` === key
							? { ...e, cost: e.cost + entry.cost }
							: e,
					)
				: [...s.sessionCostEntries, entry];
			return {
				sessionCostEntries,
				totalSessionCost: s.totalSessionCost + entry.cost,
				totalSessionCostNaia: s.totalSessionCostNaia + naiaPortion(entry),
			};
		}),

	setProvider: (provider) => set({ provider }),

	setPendingApproval: (approval) => {
		// browser app ?쒖꽦 以묒씠硫?WebView2瑜?React render ?댁쟾??hide ??紐⑤떖??WebView2??媛?ㅼ???寃?諛⑹?
		if (useAppStore.getState().activeApp === "browser") {
			invoke("browser_wv_hide").catch(() => {});
		}
		set({ pendingApproval: approval });
	},

	clearPendingApproval: () => {
		// browser app ?쒖꽦 以묒씠怨??ㅼ젣 approval???덉뿀???뚮쭔 show ??setPendingApproval??hide? ?移?
		if (
			get().pendingApproval &&
			useAppStore.getState().activeApp === "browser"
		) {
			requestBrowserVisibilitySync();
		}
		set({ pendingApproval: null });
	},

	newConversation: () => {
		// If approval was pending and browser is active, re-show WebView2 before clearing
		if (
			get().pendingApproval &&
			useAppStore.getState().activeApp === "browser"
		) {
			requestBrowserVisibilitySync();
		}
		const nextSessionId = generateLocalSessionId();
		setStoredLocalSessionId(nextSessionId);
		set({
			sessionId: null,
			localSessionId: nextSessionId,
			messages: [],
			isStreaming: false,
			streamingContent: "",
			streamingThinking: "",
			streamingToolCalls: [],
			totalSessionCost: 0,
			totalSessionCostNaia: 0,
			sessionCostEntries: [],
			pendingApproval: null,
			messageQueue: [],
		});
	},

	enqueueMessage: (text) =>
		set((s) => ({ messageQueue: [...s.messageQueue, text] })),

	dequeueMessage: () => {
		const { messageQueue } = get();
		if (messageQueue.length === 0) return undefined;
		const [first, ...rest] = messageQueue;
		set({ messageQueue: rest });
		return first;
	},
}));

// Expose for Playwright screenshot capture & dev tools
if (typeof window !== "undefined") (window as any).useChatStore = useChatStore;
