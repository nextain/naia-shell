import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { Logger } from "../lib/logger";
import type {
	ChatMessage,
	CostEntry,
	ProviderId,
	ToolCall,
} from "../lib/types";
import { useAppStore } from "./app";

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

interface ChatState {
	sessionId: string | null;
	/** Local session ID for offline history persistence (agent-side save). */
	localSessionId: string;
	messages: ChatMessage[];
	isStreaming: boolean;
	streamingContent: string;
	streamingThinking: string;
	streamingToolCalls: ToolCall[];
	provider: ProviderId;
	totalSessionCost: number;
	sessionCostEntries: CostEntry[];
	pendingApproval: PendingApproval | null;
	messageQueue: string[];

	setSessionId: (id: string) => void;
	setMessages: (messages: ChatMessage[]) => void;
	addMessage: (
		msg: Pick<ChatMessage, "role" | "content"> &
			Partial<Pick<ChatMessage, "cost">>,
	) => void;
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

function generateId(): string {
	return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function generateLocalSessionId(): string {
	return `chat-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export const useChatStore = create<ChatState>()((set, get) => ({
	sessionId: null,
	localSessionId: generateLocalSessionId(),
	messages: [],
	isStreaming: false,
	streamingContent: "",
	streamingThinking: "",
	streamingToolCalls: [],
	provider: "gemini",
	totalSessionCost: 0,
	sessionCostEntries: [],
	pendingApproval: null,
	messageQueue: [],

	setSessionId: (id) => set({ sessionId: id }),

	setMessages: (messages) => set({ messages }),

	addMessage: (msg) =>
		set((s) => ({
			messages: [
				...s.messages,
				{ ...msg, id: generateId(), timestamp: Date.now() },
			],
			totalSessionCost: s.totalSessionCost + (msg.cost?.cost ?? 0),
		})),

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
			};
		}),

	setProvider: (provider) => set({ provider }),

	setPendingApproval: (approval) => {
		// browser panel ?쒖꽦 以묒씠硫?WebView2瑜?React render ?댁쟾??hide ??紐⑤떖??WebView2??媛?ㅼ???寃?諛⑹?
		if (useAppStore.getState().activeApp === "browser") {
			invoke("browser_wv_hide").catch(() => {});
		}
		set({ pendingApproval: approval });
	},

	clearPendingApproval: () => {
		// browser panel ?쒖꽦 以묒씠怨??ㅼ젣 approval???덉뿀???뚮쭔 show ??setPendingApproval??hide? ?移?
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
		set({
			sessionId: null,
			localSessionId: generateLocalSessionId(),
			messages: [],
			isStreaming: false,
			streamingContent: "",
			streamingThinking: "",
			streamingToolCalls: [],
			totalSessionCost: 0,
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
