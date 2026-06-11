import { invoke } from "@tauri-apps/api/core";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import Markdown, { type Components } from "react-markdown";
import {
	type RecognitionResult,
	onError as sttOnError,
	onResult as sttOnResult,
	onStateChange as sttOnStateChange,
	startListening as sttStart,
	stopListening as sttStop,
} from "tauri-plugin-stt-api";
import { activeBridge, getBridgeForPanel } from "../lib/active-bridge";
import {
	formatAiInterferencePrompt,
	onAiInterferenceEvent,
} from "../lib/ai-interference";
import { type AudioPlayer, createAudioPlayer } from "../lib/audio-player";
import { getDefaultVoiceForAvatar } from "../lib/avatar-presets";
import {
	cancelChat,
	directToolCall,
	fetchAgentSkills,
	requestTts,
	sendApprovalResponse,
	sendChatMessage,
	sendPanelToolResult,
} from "../lib/chat-service";
import {
	DEFAULT_NAIA_LOCAL_URL,
	DEFAULT_VLLM_HOST,
	DEFAULT_VOICE_REF_URL,
	LAB_GATEWAY_URL,
	addAllowedTool,
	getNaiaInstanceId,
	isToolAllowed,
	loadConfig,
	loadConfigWithSecrets,
	localeToSttLanguage,
	resolveConfiguredGatewayUrl,
	saveConfig,
} from "../lib/config";
import { startDiscordRelay, stopDiscordRelay } from "../lib/discord-relay";
import {
	discoverAndPersistDiscordDmChannel,
	getGatewayHistory,
	resetGatewaySession,
} from "../lib/gateway-sessions";
import { restartGateway, syncToGateway } from "../lib/gateway-sync";
import { getLocale, t } from "../lib/i18n";
import {
	getDefaultLlmModel,
	getLlmModel,
	getLlmProvider,
	isApiKeyOptional,
	isOmniModel,
} from "../lib/llm";
import { Logger } from "../lib/logger";
import { type MicStream, createMicStream } from "../lib/mic-stream";
import { panelRegistry } from "../lib/panel-registry";
import { type MemoryContext, buildSystemPrompt } from "../lib/persona";
import {
	createApiSttSession,
	createWebSpeechSttSession,
	getSttProvider,
} from "../lib/stt";
import { getTtsProviderMeta } from "../lib/tts";
import { estimateSttCost, estimateTtsCost } from "../lib/tts/cost";
import type {
	AgentResponseChunk,
	AuditEvent,
	AuditFilter,
	ProviderId,
} from "../lib/types";
import { AudioQueue } from "../lib/voice/audio-queue";
import {
	LIVE_PROVIDER_COST_HINTS,
	type PanelContextBridge,
	SPEECH_RMS_THRESHOLD,
	type VoiceCloseReason,
	type VoiceConnectionStatus,
	type VoiceSession,
	attachPanelContextBridge,
	createVoiceSession,
	rmsFromBase64Pcm,
} from "../lib/voice/index";
import { getLocalRefAudioB64 } from "../lib/voice/ref-audio-api";
import { SentenceChunker } from "../lib/voice/sentence-chunker";
import { extractExpression, mapServerEmotion } from "../lib/vrm/expression";
import { useAvatarStore } from "../stores/avatar";
import { useChatStore } from "../stores/chat";
import { useLogsStore } from "../stores/logs";
import { selectPromptPanelContexts, usePanelStore } from "../stores/panel";
import { useProgressStore } from "../stores/progress";
import { useSkillsStore } from "../stores/skills";
import { AgentsTab } from "./AgentsTab";
import {
	type AtMentionHandle,
	AtMentionPopover,
	type AtMentionResult,
	isWorkspaceAvailable,
} from "./AtMentionPopover";
import { CostDashboard } from "./CostDashboard";
import { DiagnosticsTab } from "./DiagnosticsTab";
import { HistoryTab } from "./HistoryTab";
import { PermissionModal } from "./PermissionModal";
import { SkillsTab } from "./SkillsTab";
import { ToolActivity } from "./ToolActivity";
import { WorkProgressPanel } from "./WorkProgressPanel";

type TabId =
	| "chat"
	| "progress"
	| "skills"
	| "channels"
	| "agents"
	| "diagnostics"
	| "settings"
	| "history";

const TAB_ICONS: Record<TabId, string> = {
	chat: "💬",
	history: "🕘",
	channels: "🌐",
	progress: "📊",
	skills: "🧩",
	agents: "🤖",
	diagnostics: "🩺",
	settings: "⚙️",
};

// Built-in skills are always available in UI (non-toggle). Prevent hidden config drift
// from disabling them via chat-originated config_update events.
const BUILTIN_SKILLS = new Set([
	"skill_time",
	"skill_system_status",
	"skill_memo",
	"skill_weather",
	"skill_notify_slack",
	"skill_notify_discord",
	"skill_notify_google_chat",
	"skill_naia_discord",
	"skill_skill_manager",
	"skill_agents",
	"skill_approvals",
	"skill_botmadang",
	"skill_channels",
	"skill_config",
	"skill_cron",
	"skill_device",
	"skill_diagnostics",
	"skill_sessions",
	"skill_tts",
	"skill_voicewake",
]);

function sanitizeDisabledSkills(disabled?: string[]): string[] | undefined {
	if (!disabled || disabled.length === 0) return undefined;
	const filtered = disabled.filter((name) => !BUILTIN_SKILLS.has(name));
	return filtered.length > 0 ? filtered : undefined;
}

function generateRequestId(): string {
	return `req-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function formatCost(cost: number): string {
	if (cost < 0.001) return `$${cost.toFixed(6)}`;
	if (cost < 0.01) return `$${cost.toFixed(4)}`;
	return `$${cost.toFixed(3)}`;
}

// ── Chat file deep-link ────────────────────────────────────────────────
// Matches absolute file paths ending with common extensions.
// Uses a capturing group so split() includes the matched path in the result.
// (?<![/\w]) lookbehind prevents false positives on relative paths like "shell/src/App.tsx"
// (where /src/App.tsx would otherwise be matched as a sub-path).
const FILE_PATH_RE =
	/(?<![/\w])(\/[\w\-\.\/]+\.(?:png|jpe?g|gif|webp|csv|json|log|pdf|tsx|ts|jsx|js|rs|py|md|yaml|yml|sh|toml)(?![.\w]))/;

function openFileInWorkspace(path: string): void {
	panelRegistry.getApi("workspace")?.openFile(path);
	usePanelStore.getState().setActivePanel("workspace");
}

/** Split a text string on file paths and return an array of strings / buttons. */
function processFilePaths(text: string): ReactNode[] {
	const parts = text.split(FILE_PATH_RE);
	return parts.map((part, idx) =>
		FILE_PATH_RE.test(part) ? (
			<button
				key={`file-${part}-${idx}`}
				type="button"
				className="chat-file-deeplink"
				onClick={() => openFileInWorkspace(part)}
				title={`워크스페이스에서 열기: ${part}`}
			>
				{part}
			</button>
		) : (
			part
		),
	);
}

/** React-Markdown components override — detects file paths in <p> text nodes. */
const mdComponents: Components = {
	p({ children, ...props }) {
		const processed = Array.isArray(children)
			? children.flatMap((child) =>
					typeof child === "string" ? processFilePaths(child) : [child],
				)
			: typeof children === "string"
				? processFilePaths(children)
				: children;
		return <p {...props}>{processed}</p>;
	},
};

/** Build MemoryContext for system prompt injection.
 *  Note: User facts are now handled by Agent MemorySystem (sessionRecall).
 *  Shell only provides persona/locale/panel context. */
async function buildMemoryContext(): Promise<MemoryContext> {
	const ctx: MemoryContext = {};
	try {
		const cfg = loadConfig();
		ctx.userName = cfg?.userName;
		ctx.agentName = cfg?.agentName;
		ctx.locale = cfg?.locale || getLocale();
		ctx.honorific = cfg?.honorific;
		ctx.speechStyle = cfg?.speechStyle;
		ctx.discordDefaultUserId = cfg?.discordDefaultUserId;
		ctx.discordDmChannelId = cfg?.discordDmChannelId;

		// Active panel context + persistent contexts (bgm favorites/current track).
		// Persistent contexts survive panel switches so background music state is
		// always available — fixes the AI hallucinating favorites when another
		// panel was active.
		const panelCtxList = selectPromptPanelContexts(usePanelStore.getState());
		if (panelCtxList.length > 0) {
			ctx.panelContexts = panelCtxList;
		}
	} catch (err) {
		Logger.warn("ChatPanel", "Failed to build memory context", {
			error: String(err),
		});
	}
	return ctx;
}

// Keep reference to prevent garbage collection during playback
let currentAudio: HTMLAudioElement | null = null;

/** Play base64 MP3 via HTML Audio element (reliable in webkit2gtk). */
function playBase64Audio(base64: string): void {
	Logger.info("ChatPanel", "Audio chunk received", {
		length: base64.length,
	});
	const avatarStore = useAvatarStore.getState();
	avatarStore.setSpeaking(true);
	avatarStore.setPendingAudio(base64);

	// Stop previous audio if still playing
	if (currentAudio) {
		currentAudio.pause();
		currentAudio = null;
	}

	const audio = new Audio(`data:audio/mp3;base64,${base64}`);
	currentAudio = audio; // prevent GC
	audio.onended = () => {
		Logger.info("ChatPanel", "Audio playback ended");
		currentAudio = null;
		avatarStore.setSpeaking(false);
	};
	audio.onerror = (e) => {
		Logger.warn("ChatPanel", "Audio playback error", {
			error: String(e),
		});
		currentAudio = null;
		avatarStore.setSpeaking(false);
	};
	audio.play().then(
		() => Logger.info("ChatPanel", "Audio play() started"),
		(err) => {
			Logger.warn("ChatPanel", "Audio play() rejected", {
				error: String(err),
			});
			currentAudio = null;
			avatarStore.setSpeaking(false);
		},
	);
}

// ⚠️ UC13: 로컬 sendApprovalResponse(직접 invoke) 제거 → chat-service 의 것 사용(NEW_CORE 분기 + once/always→approve 매핑 + fire-and-forget swallow). import 참조.

/**
 * Pick a scenario-specific failure message from the last voice connection
 * status the session emitted (sold-out / out-of-credits / auth / timeout),
 * falling back to a raw error dump. Taking `st` as a typed parameter keeps the
 * full status union in scope (a ref read at the call site gets control-flow
 * narrowed to the literals assigned earlier in the same function).
 */
function voiceFailureMessage(
	st: VoiceConnectionStatus | null,
	err: unknown,
): string {
	if (st?.phase === "sold-out") return t("chat.voiceSoldOut");
	if (st?.phase === "error" && st.reason === "credits")
		return t("chat.voiceErrorCredits");
	if (st?.phase === "error" && st.reason === "auth")
		return t("chat.voiceErrorAuth");
	if (st?.phase === "error" && st.reason === "superseded")
		return t("chat.voiceErrorSuperseded");
	if (st?.phase === "error" && st.reason === "consent")
		return t("chat.voiceErrorConsent");
	if (st?.phase === "error" && st.reason === "timeout")
		return t("chat.voiceErrorTimeout");
	return `${t("chat.voiceError")}: ${err}`;
}

/**
 * Message for a mid-call disconnect, keyed off the close reason. Returns null
 * for normal/unknown closes (user stop, clean exit) so they stay silent. Used by
 * the onDisconnect handler — superseded/credits/auth deserve an explanation, a
 * user-initiated stop does not.
 */
function voiceCloseMessage(reason: VoiceCloseReason): string | null {
	switch (reason) {
		case "superseded":
			return t("chat.voiceErrorSuperseded");
		case "consent":
			return t("chat.voiceErrorConsent");
		case "credits":
			return t("chat.voiceErrorCredits");
		case "auth":
			return t("chat.voiceErrorAuth");
		default:
			return null; // normal / unknown → silent
	}
}

/**
 * Derive the voice button mode from the connection status — the single source of
 * truth. No parallel voiceMode state. Mirrors naia.nextain.io deriving its badge
 * straight from ConnectionState.
 */
function phaseToMode(
	s: VoiceConnectionStatus | null,
): "off" | "connecting" | "active" {
	switch (s?.phase) {
		case "connecting":
		case "cold-start":
			return "connecting";
		case "active":
			return "active";
		default:
			return "off"; // idle / sold-out / error / closed / null
	}
}

export function ChatPanel() {
	const [input, setInput] = useState("");
	const [activeTab, setActiveTab] = useState<TabId>("chat");
	// Discord configured = at least one Discord webhook / bot token is set
	const [showCostDashboard, setShowCostDashboard] = useState(false);
	const [showNoAuthModal, setShowNoAuthModal] = useState(false);
	// Single source of truth for voice UI state (naia-omni RunPod on-demand +
	// every other provider). Drives the status banner (cold-start / sold-out /
	// credit failures) and the voice button — `voiceMode` is derived, not stored,
	// so the two can never disagree. `lastVoiceStatusRef` mirrors it for the
	// connect() catch (state is stale inside that closure).
	const [voiceStatus, setVoiceStatus] = useState<VoiceConnectionStatus>({
		phase: "idle",
	});
	const voiceMode = phaseToMode(voiceStatus);
	const lastVoiceStatusRef = useRef<VoiceConnectionStatus>({ phase: "idle" });
	const voiceCancelledRef = useRef(false);
	const messagesEndRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const sessionLoaded = useRef(false);
	const currentRequestId = useRef<string | null>(null);
	const queuedSendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const voiceSessionRef = useRef<VoiceSession | null>(null);
	// #313 L3 — mid-session panel context bridge handle (detached in every
	// voice cleanup path).
	const panelContextBridgeRef = useRef<PanelContextBridge | null>(null);
	const micStreamRef = useRef<MicStream | null>(null);
	const audioPlayerRef = useRef<AudioPlayer | null>(null);
	const voiceStartRef = useRef<{
		time: number;
		provider: string;
		/** Naia Local (own GPU container) — no Naia-credit cost. */
		localContainer?: boolean;
	} | null>(null);

	// ── Input history (↑↓ arrow key recall) ──────────────────────────────
	const inputHistoryRef = useRef<string[]>([]);
	const historyIndexRef = useRef(-1);
	/** Snapshot of current input before the user starts browsing history */
	const historyDraftRef = useRef("");

	// ── @ mention popover ────────────────────────────────────────────────
	const [atMentionOpen, setAtMentionOpen] = useState(false);
	const [atMentionQuery, setAtMentionQuery] = useState("");
	/** Character index where @ was typed (to replace @query on selection) */
	const atMentionStartRef = useRef(-1);
	const atMentionRef = useRef<AtMentionHandle>(null);

	// Pipeline voice state (Vosk STT → LLM → sentence TTS → audio queue)
	const pipelineActiveRef = useRef(false);
	const audioQueueRef = useRef<AudioQueue | null>(null);
	const sentenceChunkerRef = useRef<SentenceChunker | null>(null);
	const activeTtsRequestsRef = useRef<Set<string>>(new Set());
	const pipelineVoiceConfigRef = useRef<{
		voice?: string;
		ttsProvider?: string;
		ttsApiKey?: string;
	} | null>(null);
	const sttCleanupRef = useRef<(() => void)[]>([]);
	const sttDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const sttBufferRef = useRef("");
	const ttsPlayingRef = useRef(false);
	const ttsCooldownUntilRef = useRef(0);
	/** Timer for focus-after-tab-switch; cleared on unmount to prevent stale focus */
	const focusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	/** Timer for pipeline STT cooldown transition; cleared in cleanupPipeline */
	const sttCooldownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
		null,
	);
	const [ttsPlaying, setTtsPlaying] = useState(false);
	const [sttPartial, setSttPartial] = useState("");
	const [sttState, setSttState] = useState<
		"idle" | "initializing" | "listening"
	>("idle");

	const messages = useChatStore((s) => s.messages);
	const isStreaming = useChatStore((s) => s.isStreaming);
	const streamingContent = useChatStore((s) => s.streamingContent);
	const streamingThinking = useChatStore((s) => s.streamingThinking);
	const streamingToolCalls = useChatStore((s) => s.streamingToolCalls);
	const totalSessionCost = useChatStore((s) => s.totalSessionCost);
	const sessionCostEntries = useChatStore((s) => s.sessionCostEntries);
	const provider = useChatStore((s) => s.provider);
	const pendingApproval = useChatStore((s) => s.pendingApproval);
	const messageQueue = useChatStore((s) => s.messageQueue);

	const setEmotion = useAvatarStore((s) => s.setEmotion);

	// Load previous session from Gateway (SoT)
	useEffect(() => {
		if (sessionLoaded.current) return;
		sessionLoaded.current = true;

		const loadSession = async () => {
			const store = useChatStore.getState();
			store.setSessionId("agent:main:main");

			const config = loadConfig();
			if (!config?.discordSessionMigrated) {
				// One-time migration: restart Gateway to pick up session.dmScope,
				// then reset the contaminated main session (Discord DMs mixed in).
				await restartGateway();
				await resetGatewaySession("agent:main:main");
				if (config) {
					saveConfig({ ...config, discordSessionMigrated: true });
				}
				Logger.info(
					"ChatPanel",
					"One-time reset: cleared Discord-contaminated main session",
				);
			} else {
				const messages = await getGatewayHistory("agent:main:main");
				if (messages.length > 0) {
					store.setMessages(messages);
					Logger.info("ChatPanel", "Session loaded from Gateway", {
						messageCount: messages.length,
					});
				}
			}
		};

		loadSession().catch((err) => {
			Logger.warn("ChatPanel", "Failed to load session", {
				error: String(err),
			});
		});

		// Auto-discover Discord DM channel ID from Gateway sessions
		// (skip on migration run — no new sessions exist yet)
		if (loadConfig()?.discordSessionMigrated) {
			discoverAndPersistDiscordDmChannel().catch(() => {});
		}

		// Startup sync: ensure Gateway has latest config
		const cfg = loadConfig();
		if (cfg) {
			syncToGateway(
				cfg.provider,
				cfg.model,
				cfg.apiKey,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				cfg.ollamaHost,
			).catch(() => {});
		}

		// Start Discord relay polling (if Discord is linked)
		startDiscordRelay().catch((err) => {
			Logger.warn("ChatPanel", "Failed to start Discord relay", {
				error: String(err),
			});
		});

		return () => {
			stopDiscordRelay();
		};
	}, []);

	useEffect(() => {
		messagesEndRef.current?.scrollIntoView?.({ behavior: "smooth" });
	}, [messages, streamingContent]);

	function isChatRequestActive(): boolean {
		return (
			currentRequestId.current !== null || useChatStore.getState().isStreaming
		);
	}

	function scheduleNextQueuedMessage() {
		if (queuedSendTimerRef.current || isChatRequestActive()) return;

		const next = useChatStore.getState().dequeueMessage();
		if (!next) return;

		queuedSendTimerRef.current = setTimeout(() => {
			queuedSendTimerRef.current = null;
			handleSend(next);
		}, 0);
	}

	function completeCurrentRequest(requestId?: string | null) {
		if (
			requestId &&
			currentRequestId.current &&
			requestId !== currentRequestId.current
		) {
			return;
		}

		currentRequestId.current = null;
		scheduleNextQueuedMessage();
	}

	function handleCancelStreaming() {
		const store = useChatStore.getState();
		if (!store.isStreaming) return;
		const reqId = currentRequestId.current;
		if (reqId) {
			cancelChat(reqId).catch((err) => {
				Logger.warn("ChatPanel", "Failed to cancel stream", {
					error: String(err),
				});
			});
		}
		store.finishStreaming();
		setEmotion("neutral");
		completeCurrentRequest(reqId);
	}

	// ESC key to cancel streaming
	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if (e.key === "Escape" && useChatStore.getState().isStreaming) {
				handleCancelStreaming();
			}
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	// Receive "Ask AI" requests from NaiaMetaPanel (Skills, Channels tabs)
	useEffect(() => {
		const handler = (e: Event) => {
			const message = (e as CustomEvent<string>).detail;
			setInput(message);
			setActiveTab("chat");
			if (focusTimerRef.current) clearTimeout(focusTimerRef.current);
			focusTimerRef.current = setTimeout(() => {
				inputRef.current?.focus();
				focusTimerRef.current = null;
			}, 50);
		};
		window.addEventListener("naia:ask-ai", handler);
		return () => {
			window.removeEventListener("naia:ask-ai", handler);
			if (focusTimerRef.current) {
				clearTimeout(focusTimerRef.current);
				focusTimerRef.current = null;
			}
		};
	}, []);

	// Mid-session reference-voice switch: when the user applies a preset in
	// Settings, RefAudioSection dispatches "naia:voice-ref-url". If a voice
	// session is live, switch the cloned voice now (no reconnect) — web-demo
	// parity. Otherwise it's a no-op; the next connect reads config.voiceRefUrl.
	useEffect(() => {
		const onUrl = (e: Event) => {
			const url = (e as CustomEvent<string | null>).detail ?? null;
			voiceSessionRef.current?.setRefAudioUrl?.(url);
		};
		const onB64 = (e: Event) => {
			const b64 = (e as CustomEvent<string | null>).detail ?? null;
			voiceSessionRef.current?.setRefAudio?.(b64);
		};
		window.addEventListener("naia:voice-ref-url", onUrl);
		window.addEventListener("naia:voice-ref-audio", onB64);
		return () => {
			window.removeEventListener("naia:voice-ref-url", onUrl);
			window.removeEventListener("naia:voice-ref-audio", onB64);
		};
	}, []);

	useEffect(() => {
		return onAiInterferenceEvent((event) => {
			const message = formatAiInterferencePrompt(event);
			setActiveTab("chat");
			handleSend(message);
		});
	}, []);

	// Discord messages are now shown in the dedicated Channels tab (ChannelsTab)
	// via direct Discord REST API, so no polling into main chat.

	// Auto-send queued messages when streaming ends
	useEffect(() => {
		if (!isChatRequestActive() && messageQueue.length > 0) {
			scheduleNextQueuedMessage();
		}
	}, [isStreaming, messageQueue.length]);

	/**
	 * Stop any in-flight TTS so a new turn does not keep reading the previous
	 * response. Covers both paths: the AudioQueue (server/edge MP3 chunks) AND
	 * the browser client-side `speechSynthesis` path, which AudioQueue.clear()
	 * does not control. Also clears the sentence chunker and pending request
	 * tracking, and resets the speaking/avatar state.
	 */
	function interruptTts(): void {
		audioQueueRef.current?.clear();
		sentenceChunkerRef.current?.clear();
		activeTtsRequestsRef.current.clear();
		if (typeof window !== "undefined" && "speechSynthesis" in window) {
			try {
				window.speechSynthesis.cancel();
			} catch {
				// best-effort — some webviews throw if no utterance is active
			}
		}
		ttsPlayingRef.current = false;
		setTtsPlaying(false);
		useAvatarStore.getState().setSpeaking(false);
	}

	async function handleNewConversation() {
		const store = useChatStore.getState();
		// Stop any TTS still reading the previous conversation.
		interruptTts();
		store.newConversation();

		// Reset Gateway session and set local session ID
		try {
			await resetGatewaySession();
			useChatStore.getState().setSessionId("agent:main:main");
			Logger.info("ChatPanel", "New conversation started via Gateway");
		} catch (err) {
			Logger.warn("ChatPanel", "Failed to reset Gateway session", {
				error: String(err),
			});
		}
	}

	async function handleSend(overrideText?: string) {
		const text = (overrideText ?? input).trim();
		if (!text) return;

		// Record in input history (deduplicate consecutive duplicates, FIFO max 50)
		const hist = inputHistoryRef.current;
		if (hist.length === 0 || hist[hist.length - 1] !== text) {
			if (hist.length >= 50) hist.shift();
			hist.push(text);
		}
		historyIndexRef.current = -1;
		historyDraftRef.current = "";

		// Omni voice mode: send text via the open Live session so a typed
		// message gets the SAME treatment as spoken input (Naia answers in
		// voice). Mirror it into the transcript too — otherwise the user's own
		// line never appears on screen.
		if (
			voiceMode === "active" &&
			!pipelineActiveRef.current &&
			voiceSessionRef.current?.isConnected
		) {
			setInput("");
			useChatStore.getState().addMessage({ role: "user", content: text });
			voiceSessionRef.current.sendText(text);
			return;
		}
		// Pipeline voice mode: send via normal chat path (TTS handled by handleChunk)
		// Falls through to the normal sendChatMessage flow below

		// If a response is active, queue instead of racing another request into the
		// shared streaming buffer. Some callers keep an old React closure, so check
		// the ref/store directly instead of relying only on the hook value.
		if (isChatRequestActive()) {
			useChatStore.getState().enqueueMessage(text);
			setInput("");
			return;
		}

		const requestId = generateRequestId();
		currentRequestId.current = requestId;

		setInput("");
		useChatStore.getState().addMessage({ role: "user", content: text });

		useChatStore.getState().startStreaming();
		// New turn supersedes any in-flight TTS: stop the previous response's
		// audio (queue + browser speechSynthesis) instead of letting it finish.
		// clear() also resets the ordering sequence for the new response.
		interruptTts();

		const store = useChatStore.getState();

		const config = await loadConfigWithSecrets();
		if (config?.provider === "nextain" && !config?.naiaKey) {
			useChatStore
				.getState()
				.appendStreamChunk(
					"Naia 계정 로그인이 필요합니다. 설정에서 로그인해주세요.",
				);
			useChatStore.getState().finishStreaming();
			completeCurrentRequest(requestId);
			return;
		}
		// naia-omni models (naia-*-omni-*) are realtime-only via the /v1/realtime
		// WebSocket — they have no text-completion path. If no voice session is
		// open yet, auto-start one (handleVoiceToggle connects the WS, then opens
		// the mic for voice transition) and route this text turn through it via
		// sendText. The user message was already added above; the realtime
		// session streams the reply (response.text.delta → onOutputTranscript).
		if (
			config?.provider === "nextain" &&
			config?.model &&
			isOmniModel(config.provider, config.model) &&
			config.model.startsWith("naia-")
		) {
			useChatStore.getState().finishStreaming();
			completeCurrentRequest(requestId);
			await handleVoiceToggle();
			voiceSessionRef.current?.sendText(text);
			return;
		}
		if (
			!isApiKeyOptional(config?.provider ?? "") &&
			!config?.apiKey &&
			!config?.naiaKey
		) {
			useChatStore.getState().appendStreamChunk(t("chat.noApiKey"));
			useChatStore.getState().finishStreaming();
			completeCurrentRequest(requestId);
			return;
		}
		if (!config) {
			useChatStore.getState().finishStreaming();
			completeCurrentRequest(requestId);
			return;
		}

		const history = store.messages
			.filter((m) => m.role === "user" || m.role === "assistant")
			.map((m) => ({ role: m.role, content: m.content }));

		// TTS is handled by Shell via SentenceChunker (both chat and pipeline mode).
		// Agent auto-TTS disabled — Shell controls TTS directly via requestTts IPC.
		const chatTtsEnabled =
			!pipelineActiveRef.current && config.ttsEnabled === true;
		const activeProvider = config.provider || provider;

		// Initialize/update SentenceChunker + AudioQueue for chat TTS
		if (chatTtsEnabled) {
			if (!audioQueueRef.current) {
				audioQueueRef.current = new AudioQueue({
					outputDeviceId: config.ttsOutputDeviceId || undefined,
					onPlaybackStart: () => {
						useAvatarStore.getState().setSpeaking(true);
						ttsPlayingRef.current = true;
						setTtsPlaying(true);
					},
					onPlaybackEnd: () => {
						useAvatarStore.getState().setSpeaking(false);
						ttsPlayingRef.current = false;
						setTtsPlaying(false);
					},
				});
			}
			sentenceChunkerRef.current = new SentenceChunker();
			// Always refresh voice config from latest settings
			pipelineVoiceConfigRef.current = {
				voice:
					config.ttsProvider === "nextain"
						? `ko-KR-Chirp3-HD-${config.voice ?? getDefaultVoiceForAvatar(config.vrmModel)}`
						: config.ttsVoice,
				ttsProvider: config.ttsProvider || "edge",
				ttsApiKey:
					config.ttsProvider === "google"
						? config.googleApiKey || config.apiKey
						: config.ttsProvider === "openai"
							? config.openaiTtsApiKey
							: config.ttsProvider === "elevenlabs"
								? config.elevenlabsApiKey
								: undefined,
			};
		}

		const memoryCtx = await buildMemoryContext();
		Logger.info("ChatPanel", "handleSend → sendChatMessage", {
			pipelineActive: pipelineActiveRef.current,
			chatTtsEnabled,
			hasChunker: !!sentenceChunkerRef.current,
			requestId,
			textPreview: text.slice(0, 40),
		});
		// Guard against provider/model mismatch (e.g. provider=gemini, model=claude-sonnet-4-6).
		// When the saved model is not valid for the active provider, fall back to the default.
		// Skip validation for providers with dynamic models (e.g. Ollama — empty static model list).
		const savedModel =
			config.model || getDefaultLlmModel(activeProvider) || "gemini-2.5-flash";
		const providerMeta = getLlmProvider(activeProvider);
		const hasDynamicModels = providerMeta && providerMeta.models.length === 0;
		const modelIsValid =
			!providerMeta ||
			hasDynamicModels ||
			providerMeta.models.some((m) => m.id === savedModel);
		const resolvedModel =
			(modelIsValid ? savedModel : getDefaultLlmModel(activeProvider)) ||
			"gemini-2.5-flash";
		if (!modelIsValid) {
			Logger.warn("ChatPanel", "Model not valid for provider — using default", {
				provider: activeProvider,
				savedModel,
				resolvedModel,
			});
		}

		const gatewayUrl = resolveConfiguredGatewayUrl(config);

		try {
			await sendChatMessage({
				message: text,
				provider: {
					provider: activeProvider,
					model: resolvedModel,
					apiKey: config.apiKey,
					labGatewayUrl:
						activeProvider === "nextain" ? LAB_GATEWAY_URL : undefined,
					ollamaHost:
						activeProvider === "ollama" ? config.ollamaHost : undefined,
					vllmHost: activeProvider === "vllm" ? config.vllmHost : undefined,
				},
				history: history.slice(0, -1),
				onChunk: (chunk) => handleChunk(chunk, activeProvider),
				requestId,
				sessionId: useChatStore.getState().localSessionId,
				// TTS handled by Shell — don't send TTS params to agent
				systemPrompt: pipelineActiveRef.current
					? `You are in a voice conversation. Keep responses brief and conversational (2-3 sentences max). Speak naturally as if talking to a friend.${config.enableTools ? "\nWhen the user asks you to perform an action that requires a tool, call the tool immediately in the same response. Include a short acknowledgement sentence before your tool call so the user hears feedback while the tool executes. After the tool completes, summarize the result in 1-2 sentences." : ""}\n\n${buildSystemPrompt(config.persona, memoryCtx)}`
					: buildSystemPrompt(config.persona, memoryCtx),
				enableTools: config.enableTools,
				enableThinking: config.enableThinking,
				gatewayUrl,
				disabledSkills: config.enableTools
					? [...(sanitizeDisabledSkills(config.disabledSkills) ?? [])]
					: undefined,
				routeViaGateway:
					!!gatewayUrl &&
					config.enableTools &&
					(config.chatRouting ?? "auto") !== "direct"
						? true
						: undefined,
				// Webhook URLs + Discord defaults are pushed via sendNotifyConfig at
				// app startup / settings save (#260). Not transmitted per-chat.
			});
		} catch (err) {
			const errStr = String(err);
			if (errStr.includes("Naia provider requires")) {
				useChatStore.getState().finishStreaming();
				setShowNoAuthModal(true);
				completeCurrentRequest(requestId);
			} else {
				useChatStore.getState().appendStreamChunk(`
[${t("chat.error")}] ${errStr}`);
				useChatStore.getState().finishStreaming();
				completeCurrentRequest(requestId);
			}
		}
	}

	// Shared panel-tool dispatch — used by both the streaming-chat handleChunk
	// path AND the voice directToolCall path (so voice can run panel tools like
	// skill_browser_*). Auto-switches to the owning panel first (tool-level), so
	// a tool targeting a non-active panel brings that panel forward.
	function dispatchPanelToolCall(req: {
		requestId: string;
		toolCallId: string;
		toolName: string;
		args: Record<string, unknown>;
	}) {
		const ownerPanel = panelRegistry
			.list()
			.find((p) => p.tools?.some((t) => t.name === req.toolName));
		// Tool-level auto panel switch (user request): if the tool belongs to a
		// panel that isn't currently active, bring it forward before running.
		if (ownerPanel && usePanelStore.getState().activePanel !== ownerPanel.id) {
			usePanelStore.getState().setActivePanel(ownerPanel.id);
			Logger.info("ChatPanel", "panel auto-switch for tool", {
				tool: req.toolName,
				panel: ownerPanel.id,
			});
		}
		const bridge = ownerPanel ? getBridgeForPanel(ownerPanel.id) : activeBridge;
		Logger.info("ChatPanel", "panel_tool_call dispatch", {
			tool: req.toolName,
			owner: ownerPanel?.id ?? "(none→activeBridge)",
		});
		bridge
			.callTool(req.toolName, req.args)
			.then((result) => {
				Logger.info("ChatPanel", "panel_tool_call result", {
					tool: req.toolName,
					result: result.slice(0, 120),
				});
				return sendPanelToolResult(req.requestId, req.toolCallId, result, true);
			})
			.catch((err) => {
				Logger.warn("ChatPanel", "panel_tool_call error", {
					tool: req.toolName,
					error: String(err),
				});
				return sendPanelToolResult(
					req.requestId,
					req.toolCallId,
					String(err),
					false,
				);
			});
	}

	function dispatchPanelControl(req: { action: string; panelId?: string }) {
		const { setActivePanel } = usePanelStore.getState();
		if (req.action === "switch" && req.panelId) {
			setActivePanel(req.panelId);
		} else if (req.action === "reload") {
			import("../lib/panel-loader").then(({ loadInstalledPanels }) => {
				loadInstalledPanels().catch(() => {});
			});
		}
	}

	function handleChunk(chunk: AgentResponseChunk, activeProvider: ProviderId) {
		const store = useChatStore.getState();

		if ("requestId" in chunk && chunk.requestId !== currentRequestId.current) {
			Logger.info("ChatPanel", "Ignoring chunk for inactive request", {
				type: chunk.type,
				requestId: chunk.requestId,
				activeRequestId: currentRequestId.current,
			});
			return;
		}

		if (
			chunk.type === "text" ||
			chunk.type === "finish" ||
			chunk.type === "usage"
		) {
			Logger.info("ChatPanel", "handleChunk", {
				type: chunk.type,
				pipelineActive: pipelineActiveRef.current,
				hasChunker: !!sentenceChunkerRef.current,
				...(chunk.type === "text"
					? { textLen: chunk.text.length, textPreview: chunk.text.slice(0, 60) }
					: {}),
			});
		}

		switch (chunk.type) {
			case "text": {
				store.appendStreamChunk(chunk.text);
				// Parse emotion from accumulated text (tag may span multiple chunks)
				const accumulated = store.streamingContent;
				if (accumulated.length <= 30 && accumulated.length >= 4) {
					const { emotion } = extractExpression(accumulated);
					if (emotion) setEmotion(emotion);
				}
				// Sentence-level TTS — same path for both pipeline and chat mode
				if (sentenceChunkerRef.current) {
					const sentences = sentenceChunkerRef.current.feed(chunk.text);
					if (sentences.length > 0) {
						Logger.info("ChatPanel", "SentenceChunker produced sentences", {
							count: sentences.length,
							sentences,
						});
					}
					for (const sentence of sentences) {
						sendSentenceToTts(sentence);
					}
				}
				break;
			}
			case "thinking":
				store.appendThinkingChunk(chunk.text);
				break;
			case "audio":
				// Agent auto-TTS disabled — Shell handles TTS via SentenceChunker.
				// This case handles legacy audio events if any.
				if (!sentenceChunkerRef.current) {
					playBase64Audio(chunk.data);
				}
				break;
			case "tool_use":
				store.addStreamingToolUse(chunk.toolCallId, chunk.toolName, chunk.args);
				break;
			case "tool_result":
				store.updateStreamingToolResult(
					chunk.toolCallId,
					chunk.success,
					chunk.output,
				);
				break;
			case "approval_request":
				if (isToolAllowed(chunk.toolName)) {
					sendApprovalResponse(chunk.requestId, chunk.toolCallId, "once");
				} else {
					store.setPendingApproval({
						requestId: chunk.requestId,
						toolCallId: chunk.toolCallId,
						toolName: chunk.toolName,
						args: chunk.args,
						tier: chunk.tier,
						description: chunk.description,
					});
				}
				break;
			case "panel_tool_call": {
				dispatchPanelToolCall({
					requestId: chunk.requestId,
					toolCallId: chunk.toolCallId,
					toolName: chunk.toolName,
					args: chunk.args,
				});
				break;
			}
			case "panel_control": {
				dispatchPanelControl({
					action: chunk.action,
					panelId: chunk.panelId,
				});
				break;
			}
			case "panel_install_result": {
				// Handled by PanelInstallDialog's direct listener — no-op here
				break;
			}
			case "usage": {
				store.finishStreaming();
				setEmotion("neutral");
				store.addCostEntry({
					inputTokens: chunk.inputTokens,
					outputTokens: chunk.outputTokens,
					cost: chunk.cost,
					provider: activeProvider,
					model: chunk.model,
				});
				break;
			}
			case "finish":
				// Flush remaining text to TTS (both pipeline and chat mode)
				if (sentenceChunkerRef.current) {
					const remaining = sentenceChunkerRef.current.flush();
					if (remaining) {
						Logger.info("ChatPanel", "SentenceChunker flush on finish", {
							remaining: remaining.slice(0, 60),
						});
						sendSentenceToTts(remaining);
					}
					// Chat mode: clean up chunker after message complete (pipeline keeps it)
					if (!pipelineActiveRef.current) {
						sentenceChunkerRef.current = null;
					}
				}
				if (store.isStreaming) {
					store.finishStreaming();
				}
				setEmotion("neutral");
				completeCurrentRequest(chunk.requestId);
				break;
			case "config_update": {
				const cfg = loadConfig();
				if (cfg) {
					// Ignore built-in skill toggles from chat/tool output.
					if (BUILTIN_SKILLS.has(chunk.skillName)) {
						Logger.info(
							"ChatPanel",
							"Ignored config_update for built-in skill",
							{
								skillName: chunk.skillName,
								action: chunk.action,
							},
						);
						break;
					}
					const disabled = cfg.disabledSkills ?? [];
					if (chunk.action === "enable_skill") {
						cfg.disabledSkills = disabled.filter((n) => n !== chunk.skillName);
					} else if (chunk.action === "disable_skill") {
						if (!disabled.includes(chunk.skillName)) {
							cfg.disabledSkills = [...disabled, chunk.skillName];
						}
					}
					saveConfig(cfg);
					useSkillsStore.getState().bumpConfigVersion();
				}
				break;
			}
			case "gateway_approval_request":
				// Gateway-originated approval — treat like local approval
				store.setPendingApproval({
					requestId: chunk.requestId,
					toolCallId: chunk.toolCallId,
					toolName: chunk.toolName,
					args: chunk.args,
					tier: 2,
					description: `Gateway: ${chunk.toolName}`,
				});
				break;
			case "log_entry":
				useLogsStore.getState().addEntry({
					level: chunk.level,
					message: chunk.message,
					timestamp: chunk.timestamp,
				});
				break;
			case "discord_message":
				// Discord DM messages are shown in the dedicated Channels tab.
				// Ignore them here to keep the main chat clean.
				break;
			case "error":
				Logger.warn("ChatPanel", "Agent error chunk", {
					message: chunk.message,
				});
				// Pipeline voice: flush remaining text to TTS before finishing
				if (pipelineActiveRef.current && sentenceChunkerRef.current) {
					const remaining = sentenceChunkerRef.current.flush();
					if (remaining) {
						Logger.info("ChatPanel", "Pipeline voice flush on error", {
							remainingLen: remaining.length,
						});
						sendSentenceToTts(remaining);
					}
				}
				store.appendStreamChunk(`\n[${t("chat.error")}] ${chunk.message}`);
				store.finishStreaming();
				setEmotion("neutral");
				completeCurrentRequest(chunk.requestId);
				break;
		}
	}

	function handleApprovalDecision(decision: "once" | "always" | "reject") {
		const approval = useChatStore.getState().pendingApproval;
		if (!approval) return;

		if (decision === "always") {
			addAllowedTool(approval.toolName);
		}

		sendApprovalResponse(approval.requestId, approval.toolCallId, decision);
		useChatStore.getState().clearPendingApproval();
	}

	// Cleanup voice session on unmount
	useEffect(() => {
		return () => {
			if (queuedSendTimerRef.current) {
				clearTimeout(queuedSendTimerRef.current);
				queuedSendTimerRef.current = null;
			}
			panelContextBridgeRef.current?.detach();
			panelContextBridgeRef.current = null;
			voiceSessionRef.current?.disconnect();
			micStreamRef.current?.stop();
			audioPlayerRef.current?.destroy();
		};
	}, []);

	function showVoiceCostSummary() {
		const info = voiceStartRef.current;
		if (!info) return;
		voiceStartRef.current = null;
		const elapsed = (Date.now() - info.time) / 1000;
		if (elapsed < 3) return; // ignore very short sessions
		// Naia Local runs on the user's own GPU — no Naia-credit charge. Show a
		// free indicator (no $ amount, no cost entry) instead of an hourly estimate.
		if (info.localContainer) {
			const dur =
				elapsed < 60
					? `${Math.round(elapsed)}s`
					: `${Math.floor(elapsed / 60)}m ${Math.round(elapsed % 60)}s`;
			useChatStore.getState().addMessage({
				role: "assistant",
				content: `🎙️ ${dur} · 로컬 (무료)`,
			});
			return;
		}
		const minutes = elapsed / 60;
		const hint =
			LIVE_PROVIDER_COST_HINTS[
				info.provider as keyof typeof LIVE_PROVIDER_COST_HINTS
			];
		if (!hint || hint.cost === "Free") return;
		// Cost hints carry a unit: "/hr" (hourly session models like naia-omni)
		// or "/min" (per-minute providers). Hourly models bill by wall-clock
		// time — applying the per-minute formula over-charged ~60×.
		const match = hint.cost.match(/\$([\d.]+)\s*\/\s*(hr|min)/);
		if (!match) return;
		const rate = Number.parseFloat(match[1]);
		const perHour = match[2] === "hr";
		const totalCost = perHour ? rate * (elapsed / 3600) : rate * minutes;
		const durationStr =
			minutes < 1
				? `${Math.round(elapsed)}s`
				: `${Math.floor(minutes)}m ${Math.round(elapsed % 60)}s`;
		// Per-minute providers (Gemini/OpenAI) bill by tokens — estimate for the
		// breakdown. Hourly session models (naia-omni) do NOT bill by tokens, so
		// don't fabricate token counts for them (showed up as inflated usage).
		const isOpenAI = info.provider === "openai-realtime";
		const inputTokens = perHour
			? 0
			: Math.round(elapsed * (isOpenAI ? 10 : 32));
		const outputTokens = perHour
			? 0
			: Math.round(elapsed * (isOpenAI ? 20 : 32));
		// Map provider to ProviderId-compatible string
		const providerMap: Record<string, string> = {
			naia: "nextain",
			"gemini-live": "gemini",
			"openai-realtime": "openai",
		};
		useChatStore.getState().addMessage({
			role: "assistant",
			content: `🎙️ ${durationStr} · ~$${totalCost.toFixed(3)} (${hint.note})`,
			cost: {
				provider: (providerMap[info.provider] ?? info.provider) as any,
				model: isOpenAI ? "gpt-realtime" : "gemini-live",
				inputTokens,
				outputTokens,
				cost: totalCost,
			},
		});
	}

	/** Send a sentence to TTS via Agent and enqueue the resulting audio. */
	function sendSentenceToTts(sentence: string): void {
		// Strip emotion tags and emoji before TTS
		const clean = sentence
			.replace(/\[(?:HAPPY|SAD|ANGRY|SURPRISED|NEUTRAL|THINK)]\s*/gi, "")
			.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "")
			.trim();
		if (!clean) return;

		const reqId = generateRequestId();
		// Reserve sequence number BEFORE async request to guarantee order
		const seq = audioQueueRef.current?.reserveSeq() ?? 0;
		activeTtsRequestsRef.current.add(reqId);
		const voiceCfg = pipelineVoiceConfigRef.current;
		Logger.info("ChatPanel", "Sending TTS request", {
			reqId,
			seq,
			sentence: clean.slice(0, 50),
			provider: voiceCfg?.ttsProvider,
		});
		const ttsProviderForCost = voiceCfg?.ttsProvider ?? "edge";
		const ttsVoiceForCost = voiceCfg?.voice;

		// Browser TTS — synthesize directly in browser, skip agent pipeline
		const ttsMeta = getTtsProviderMeta(ttsProviderForCost);
		if (ttsMeta?.isClientSide) {
			if (typeof window !== "undefined" && "speechSynthesis" in window) {
				const utter = new SpeechSynthesisUtterance(clean);
				utter.lang =
					voiceCfg?.voice || document.documentElement.lang || "ko-KR";
				utter.onstart = () => {
					useAvatarStore.getState().setSpeaking(true);
				};
				utter.onend = () => {
					useAvatarStore.getState().setSpeaking(false);
					activeTtsRequestsRef.current.delete(reqId);
				};
				utter.onerror = () => {
					activeTtsRequestsRef.current.delete(reqId);
				};
				window.speechSynthesis.speak(utter);
				Logger.info("ChatPanel", "Browser TTS speak", {
					text: clean.slice(0, 50),
				});
			} else {
				Logger.warn("ChatPanel", "Browser TTS not available");
				activeTtsRequestsRef.current.delete(reqId);
			}
			return;
		}

		requestTts({
			text: clean,
			voice: voiceCfg?.voice,
			ttsProvider: voiceCfg?.ttsProvider as
				| "edge"
				| "google"
				| "openai"
				| "elevenlabs"
				| "nextain"
				| undefined,
			ttsApiKey: voiceCfg?.ttsApiKey,
			requestId: reqId,
			onAudio: (mp3Base64, costUsd) => {
				Logger.info("ChatPanel", "TTS audio received", {
					reqId,
					seq,
					size: mp3Base64.length,
					costUsd,
				});
				// Drop stale audio from a superseded turn. interruptTts() clears
				// activeTtsRequestsRef on a new turn / new conversation, so a
				// late-arriving response whose reqId is no longer active must NOT
				// be enqueued — clear() reset the sequence counter, so an old
				// seq=0 chunk would otherwise replay as the new turn's first audio.
				if (activeTtsRequestsRef.current.has(reqId)) {
					audioQueueRef.current?.enqueueOrdered(seq, mp3Base64);
				}
				activeTtsRequestsRef.current.delete(reqId);
				// Track TTS cost: use server cost for Naia Cloud, estimate for others.
				// Naia account (nextain): apply 10% service markup on top of base cost.
				const NAIA_TTS_MARKUP = 1.1;
				const isNaiaTts = ttsProviderForCost === "nextain";
				const baseTtsCost =
					costUsd != null
						? costUsd
						: estimateTtsCost(
								ttsProviderForCost,
								clean.length,
								ttsVoiceForCost,
							);
				const ttsCost = isNaiaTts ? baseTtsCost * NAIA_TTS_MARKUP : baseTtsCost;
				if (ttsCost > 0) {
					// addSessionCostEntry keeps TTS in a separate row in CostDashboard
					useChatStore.getState().addSessionCostEntry({
						inputTokens: 0,
						outputTokens: 0,
						cost: ttsCost,
						provider: ttsProviderForCost as ProviderId,
						model: isNaiaTts
							? "tts:nextain (+10%)"
							: `tts:${ttsProviderForCost}`,
					});
				}
			},
		});
	}

	/** Clean up pipeline voice resources. */
	function cleanupPipeline(): void {
		pipelineActiveRef.current = false;
		audioQueueRef.current?.destroy();
		audioQueueRef.current = null;
		sentenceChunkerRef.current?.clear();
		sentenceChunkerRef.current = null;
		pipelineVoiceConfigRef.current = null;
		activeTtsRequestsRef.current.clear();
		// Stop Vosk STT
		for (const fn of sttCleanupRef.current) fn();
		sttCleanupRef.current = [];
		if (sttDebounceRef.current) {
			clearTimeout(sttDebounceRef.current);
			sttDebounceRef.current = null;
		}
		if (sttCooldownTimerRef.current) {
			clearTimeout(sttCooldownTimerRef.current);
			sttCooldownTimerRef.current = null;
		}
		sttBufferRef.current = "";
		setSttPartial("");
		setSttState("idle");
		sttStop().catch(() => {});
	}

	async function handleVoiceToggle() {
		// Barge-in: if TTS is playing, stop TTS + cancel stream, stay in voice mode
		if (voiceMode === "active" && ttsPlayingRef.current) {
			Logger.info("ChatPanel", "Barge-in via button: stopping TTS");
			audioQueueRef.current?.clear();
			ttsPlayingRef.current = false;
			setTtsPlaying(false);
			handleCancelStreaming();
			sentenceChunkerRef.current?.clear();
			ttsCooldownUntilRef.current = Date.now() + 300;
			return;
		}

		if (voiceMode !== "off") {
			// Stop voice session — show cost summary before cleanup
			if (pipelineActiveRef.current) {
				cleanupPipeline();
			} else {
				showVoiceCostSummary();
				panelContextBridgeRef.current?.detach();
				panelContextBridgeRef.current = null;
				voiceSessionRef.current?.disconnect();
				micStreamRef.current?.stop();
				audioPlayerRef.current?.destroy();
				voiceSessionRef.current = null;
				micStreamRef.current = null;
				audioPlayerRef.current = null;
			}
			setVoiceStatus({ phase: "idle" });
			lastVoiceStatusRef.current = { phase: "idle" };
			return;
		}

		voiceCancelledRef.current = false;
		lastVoiceStatusRef.current = { phase: "connecting" };
		setVoiceStatus({ phase: "connecting" });

		try {
			const config = await loadConfigWithSecrets();
			if (!config) {
				setVoiceStatus({ phase: "idle" });
				return;
			}
			const naiaKey = config?.naiaKey;
			const modelMeta = getLlmModel(config.provider, config.model);
			const isOmni = isOmniModel(config.provider, config.model ?? "");
			// ASR mode: STT provider is vllm, or LLM model has "asr" capability,
			// or vllm non-omni model (naia-omni /v1/realtime WebSocket handles ASR)
			const isAsrModel =
				config.sttProvider === "vllm" ||
				(config.provider === "vllm" && !isOmni) ||
				(modelMeta?.capabilities.includes("asr") ?? false);

			// LLM models use pipeline voice (Vosk STT → LLM → sentence TTS)
			if (!isOmni) {
				// Guard: STT provider must be configured; model required only for offline engines
				// ASR models are self-contained — skip guard
				const sttProviderMeta = getSttProvider(config.sttProvider || "");
				const needsModel = sttProviderMeta?.engineType === "tauri";
				if (
					!isAsrModel &&
					(!config.sttProvider || (needsModel && !config.sttModel))
				) {
					setVoiceStatus({ phase: "idle" });
					if (
						globalThis.confirm(
							`${t("voice.setupRequired")}\n\n${t("voice.goToSettings")}?`,
						)
					) {
						setActiveTab("settings");
					}
					return;
				}

				const queue = new AudioQueue({
					outputDeviceId: config.ttsOutputDeviceId || undefined,
					onPlaybackStart: () => {
						useAvatarStore.getState().setSpeaking(true);
						ttsPlayingRef.current = true;
						setTtsPlaying(true);
					},
					onPlaybackEnd: () => {
						useAvatarStore.getState().setSpeaking(false);
						ttsPlayingRef.current = false;
						setTtsPlaying(false);
						// Cooldown: suppress STT for 1.5s after TTS ends
						// to prevent mic echo from final TTS audio
						ttsCooldownUntilRef.current = Date.now() + 800;
						// Brief "waiting" state during cooldown, then back to listening
						setSttState("initializing");
						if (sttCooldownTimerRef.current)
							clearTimeout(sttCooldownTimerRef.current);
						sttCooldownTimerRef.current = setTimeout(() => {
							setSttState("listening");
							sttCooldownTimerRef.current = null;
						}, 800);
					},
				});
				audioQueueRef.current = queue;
				sentenceChunkerRef.current = new SentenceChunker();
				pipelineActiveRef.current = true;
				pipelineVoiceConfigRef.current = {
					voice: config.ttsVoice || config.voice,
					ttsProvider: config.ttsProvider || "edge",
					ttsApiKey:
						config.ttsProvider === "google"
							? config.googleApiKey || config.apiKey
							: config.ttsProvider === "openai"
								? config.openaiTtsApiKey
								: config.ttsProvider === "elevenlabs"
									? config.elevenlabsApiKey
									: undefined,
				};

				// Start STT engine — route to Tauri plugin (offline) or API-based
				setSttState("initializing");
				try {
					const sttLang = localeToSttLanguage(getLocale());
					const sttEngine = isAsrModel ? "vllm" : config.sttProvider || "vosk";
					const sttMeta = getSttProvider(sttEngine);
					const isApiBased =
						sttMeta?.engineType === "api" || sttMeta?.engineType === "vllm";
					const isWebBased = sttMeta?.engineType === "web";

					// Shared result handler for both offline and API-based STT
					const handleSttResult = (result: {
						transcript: string;
						isFinal: boolean;
						confidence?: number;
					}) => {
						// Filter Whisper hallucinations: (sound descriptions), [noise], etc.
						const filtered = result.transcript
							.replace(/\([^)]*\)/g, "")
							.replace(/\[[^\]]*\]/g, "")
							.trim();
						if (!filtered) return;
						const cleanResult = { ...result, transcript: filtered };
						Logger.info("ChatPanel", "STT result", {
							transcript: cleanResult.transcript,
							isFinal: cleanResult.isFinal,
							confidence: cleanResult.confidence,
						});
						if (!pipelineActiveRef.current) return;

						if (
							ttsPlayingRef.current ||
							Date.now() < ttsCooldownUntilRef.current
						) {
							Logger.info(
								"ChatPanel",
								"STT result suppressed (TTS playing/cooldown)",
							);
							return;
						}

						if (!cleanResult.isFinal) {
							setSttPartial(cleanResult.transcript);
						}

						if (cleanResult.isFinal && cleanResult.transcript.trim()) {
							setSttPartial("");
							sttBufferRef.current +=
								(sttBufferRef.current ? " " : "") +
								cleanResult.transcript.trim();
							if (sttDebounceRef.current) clearTimeout(sttDebounceRef.current);
							sttDebounceRef.current = setTimeout(() => {
								const text = sttBufferRef.current.trim();
								sttBufferRef.current = "";
								if (text && pipelineActiveRef.current) {
									if (useChatStore.getState().isStreaming) {
										Logger.info(
											"ChatPanel",
											"Skipping duplicate send (already streaming)",
											{ text },
										);
										return;
									}
									handleSend(text);
								}
							}, 300);
						}
					};

					if (isApiBased) {
						// API-based STT — browser MediaStream + cloud API
						const apiKey = sttMeta?.requiresNaiaKey
							? config.naiaKey
							: sttMeta?.apiKeyConfigField === "googleApiKey"
								? config.googleApiKey
								: sttMeta?.apiKeyConfigField === "elevenlabsApiKey"
									? config.elevenlabsApiKey
									: "";
						if (!apiKey && !isAsrModel) {
							Logger.warn("ChatPanel", "API STT requires API key", {
								provider: sttEngine,
							});
							setSttState("idle");
							pipelineActiveRef.current = false;
							setVoiceStatus({ phase: "idle" });
							if (
								globalThis.confirm(
									"STT API key is required.\n\nGo to Settings?",
								)
							) {
								setActiveTab("settings");
							}
							return;
						}
						const endpointUrl = isAsrModel
							? config.vllmSttHost || config.vllmHost || DEFAULT_VLLM_HOST
							: sttMeta?.requiresEndpointUrl && sttMeta.endpointUrlConfigField
								? (config[
										sttMeta.endpointUrlConfigField as keyof typeof config
									] as string | undefined)
								: undefined;
						// vLLM model: ASR model (LLM=ASR) → config.model, STT=vllm → config.vllmSttModel
						const vllmSttModel =
							sttEngine === "vllm"
								? (modelMeta?.capabilities.includes("asr")
										? config.model
										: config.vllmSttModel) || undefined
								: undefined;
						const session = createApiSttSession({
							provider: sttEngine as
								| "google"
								| "elevenlabs"
								| "nextain"
								| "vllm",
							apiKey: apiKey ?? "",
							language: sttLang,
							endpointUrl,
							model: vllmSttModel,
							inputDeviceId: config.sttInputDeviceId || undefined,
						});
						const cleanupResult = session.onResult(handleSttResult);
						sttCleanupRef.current.push(cleanupResult);
						if (session.onError) {
							const cleanupError = session.onError((err) => {
								Logger.warn("ChatPanel", "API STT error", {
									code: err.code,
									message: err.message,
								});
							});
							sttCleanupRef.current.push(cleanupError);
						}
						// Track STT cost per API call — shown in CostDashboard breakdown
						if (session.onCost) {
							const cleanupCost = session.onCost(
								(cost: { durationSeconds: number }) => {
									const sttCost = estimateSttCost(
										sttEngine,
										cost.durationSeconds,
									);
									if (sttCost > 0) {
										useChatStore.getState().addSessionCostEntry({
											inputTokens: 0,
											outputTokens: 0,
											cost: sttCost,
											provider: sttEngine,
											model: `stt:${sttEngine}`,
										});
									}
								},
							);
							sttCleanupRef.current.push(cleanupCost);
						}
						sttCleanupRef.current.push(() => session.stop());
						await session.start();
						setSttState("listening");
					} else if (isWebBased) {
						// Web Speech API — browser built-in, free, no model download
						const session = createWebSpeechSttSession(sttLang);
						const cleanupResult = session.onResult(handleSttResult);
						sttCleanupRef.current.push(cleanupResult);
						if (session.onError) {
							const cleanupError = session.onError((err) => {
								Logger.warn("ChatPanel", "Web Speech STT error", {
									code: err.code,
									message: err.message,
								});
							});
							sttCleanupRef.current.push(cleanupError);
						}
						sttCleanupRef.current.push(() => session.stop());
						await session.start();
						setSttState("listening");
					} else {
						// Tauri plugin (offline: Vosk/Whisper)
						const unlistenResult = await sttOnResult(
							(result: RecognitionResult) => {
								handleSttResult(result);
							},
						);
						const resultCleanup =
							typeof unlistenResult === "function"
								? unlistenResult
								: () => unlistenResult.unregister();
						sttCleanupRef.current.push(resultCleanup);

						const unlistenState = await sttOnStateChange((event) => {
							Logger.info("ChatPanel", "STT state change", {
								state: event.state,
							});
							if (event.state === "listening") setSttState("listening");
						});
						const stateCleanup =
							typeof unlistenState === "function"
								? unlistenState
								: () => unlistenState.unregister();
						sttCleanupRef.current.push(stateCleanup);

						const unlistenError = await sttOnError((err) => {
							Logger.warn("ChatPanel", "STT error", {
								code: err.code,
								message: err.message,
							});
						});
						const errorCleanup =
							typeof unlistenError === "function"
								? unlistenError
								: () => unlistenError.unregister();
						sttCleanupRef.current.push(errorCleanup);

						Logger.info("ChatPanel", "Starting STT", {
							engine: sttEngine,
							model: config.sttModel,
							language: sttLang,
						});
						await sttStart({
							engine: sttEngine,
							modelId: config.sttModel,
							language: sttLang,
							continuous: true,
							interimResults: true,
						} as Record<string, unknown> & Parameters<typeof sttStart>[0]);
					}
					Logger.info("ChatPanel", "STT started successfully", {
						engine: sttEngine,
						apiMode: isApiBased,
					});
				} catch (sttErr) {
					Logger.warn("ChatPanel", "STT start failed", {
						error: String(sttErr),
					});
					setSttState("idle");
					pipelineActiveRef.current = false;
					audioQueueRef.current = null;
					sentenceChunkerRef.current = null;
					setVoiceStatus({ phase: "idle" });
					return;
				}

				Logger.info("ChatPanel", "Pipeline voice mode started", {
					provider: config.provider,
					model: config.model,
					ttsProvider: config.ttsProvider || "edge",
				});

				// Pipeline voice (Vosk/Whisper STT → LLM → TTS) is live. Set the
				// canonical status so the derived button shows active — without this
				// the derived voiceMode would stay stuck "connecting" for pipeline
				// sessions (they never emit onStatusChange "active").
				setVoiceStatus({ phase: "active" });
				lastVoiceStatusRef.current = { phase: "active" };
				// Voice mode notification — not sent to agent, not read by TTS
				Logger.info("ChatPanel", "Voice mode started notification displayed");
				return;
			}

			// Determine the live provider from the current model/provider.
			// Naia omni (naia-*-omni-*, e.g. naia-0.9-omni-24g) routes to OpenAI
			// Realtime (/v1/realtime via gateway). Gemini live (gemini-*-live)
			// routes to Gemini Live (/v1/live) under "naia". Both are isOmni,
			// so branch on the model id prefix first.
			const liveProvider =
				isOmni && config.model?.startsWith("naia-")
					? ("naia-omni" as const)
					: isOmni && config.provider === "vllm"
						? ("naia-omni" as const)
						: config.provider === "vllm"
							? ("vllm-omni" as const)
							: config.provider === "openai"
								? ("openai-realtime" as const)
								: naiaKey
									? ("naia" as const)
									: ("gemini-live" as const);

			Logger.info("ChatPanel", "Voice config", {
				provider: config.provider,
				model: config.model,
				liveProvider,
				hasNaiaKey: !!naiaKey,
				hasGoogleApiKey: !!config.googleApiKey,
				hasOpenaiKey: !!(config.openaiRealtimeApiKey ?? config.apiKey),
			});

			// Validate credentials per provider
			if (liveProvider === "naia" && !naiaKey) {
				Logger.warn("ChatPanel", "Naia OS voice requires Naia key");
				useChatStore.getState().addMessage({
					role: "assistant",
					content: t("chat.voiceNeedLabKey"),
				});
				setVoiceStatus({ phase: "idle" });
				return;
			}
			if (liveProvider === "gemini-live" && !naiaKey && !config.googleApiKey) {
				Logger.warn("ChatPanel", "Gemini Live requires Google API key");
				useChatStore.getState().addMessage({
					role: "assistant",
					content: "Gemini Live를 사용하려면 Google API Key를 입력하세요.",
				});
				setVoiceStatus({ phase: "idle" });
				return;
			}
			if (liveProvider === "openai-realtime") {
				const openaiKey = config.openaiRealtimeApiKey ?? config.apiKey;
				if (!openaiKey) {
					Logger.warn("ChatPanel", "OpenAI Realtime requires API key");
					useChatStore.getState().addMessage({
						role: "assistant",
						content: "OpenAI Realtime을 사용하려면 API Key를 입력하세요.",
					});
					setVoiceStatus({ phase: "idle" });
					return;
				}
			}

			const memoryCtx = await buildMemoryContext();
			const systemPrompt = buildSystemPrompt(config.persona, memoryCtx);

			// Collect active panel tools to pass to the voice session
			const activePanelId = usePanelStore.getState().activePanel;
			const panelTools = activePanelId
				? (panelRegistry.get(activePanelId)?.tools ?? [])
				: [];
			const panelToolDefs = panelTools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters ?? {
					type: "object" as const,
					properties: {},
				},
			}));

			// Fetch built-in + custom skills from Agent registry
			const disabledSkills = new Set(
				sanitizeDisabledSkills(config.disabledSkills) ?? [],
			);
			let agentSkills: {
				name: string;
				description: string;
				parameters: Record<string, unknown>;
			}[] = [];
			try {
				const allSkills = await fetchAgentSkills();
				// Filter: remove disabled, skip skill_panel (panel management, not useful in voice)
				agentSkills = allSkills.filter(
					(s) => !disabledSkills.has(s.name) && s.name !== "skill_panel",
				);
			} catch (err) {
				Logger.warn("ChatPanel", "Failed to fetch agent skills for voice", {
					error: String(err),
				});
			}

			// Merge panel tools + agent skills (panel tools take priority on name collision)
			const panelNames = new Set(panelToolDefs.map((t) => t.name));
			const voiceTools = [
				...panelToolDefs,
				...agentSkills.filter((s) => !panelNames.has(s.name)),
			];

			// Append tool usage instructions to system prompt so the model
			// knows to call the tools instead of saying they're unavailable.
			const voiceSystemPrompt =
				voiceTools.length > 0
					? `${systemPrompt}\n\nAvailable tools (call them proactively when the user asks):\n${voiceTools.map((t) => `- ${t.name}: ${t.description}`).join("\n")}`
					: systemPrompt;

			// Create voice session via provider factory
			// Gemini Direct uses Rust proxy (WebKitGTK can't connect to Google's WS)
			const useDirectMode =
				liveProvider === "gemini-live" && !!config.googleApiKey;
			const session = createVoiceSession(liveProvider, {
				useProxy: useDirectMode,
			});
			voiceSessionRef.current = session;

			// Cold-start-aware status → banner. naia-omni emits connecting /
			// cold-start(elapsed) / sold-out / error; other providers leave it unset.
			session.onStatusChange = (status) => {
				lastVoiceStatusRef.current = status;
				setVoiceStatus(status);
			};

			// #313 L3 — bridge mid-session panel context changes into the open
			// Live WS. Subscribes to the panel store, debounces 500ms (rapid
			// URL hops), and forwards to `session.sendContextUpdate()` — a silent
			// no-op for providers without a mid-session inject surface
			// (vllm-omni, naia-omni). Detached in every cleanup path below.
			panelContextBridgeRef.current = attachPanelContextBridge(session, {
				subscribe: (listener) => usePanelStore.subscribe(listener),
				getContext: () => usePanelStore.getState().activePanelContext,
			});

			// Create audio player
			const player = createAudioPlayer({
				sampleRate: 24000,
				onPlaybackStart: () => useAvatarStore.getState().setSpeaking(true),
				onPlaybackEnd: () => useAvatarStore.getState().setSpeaking(false),
			});
			audioPlayerRef.current = player;

			// Wire session events — accumulate incremental transcript chunks
			let inputTurnDirty = false;
			let outputTurnDirty = false;
			let inputAccum = "";
			let outputAccum = "";
			// Precedence: a server emotion.updated this turn is authoritative, so the
			// transcript-derived fallback below must not override it.
			let serverEmotionSeenThisTurn = false;

			session.onAudio = (pcmBase64) => player.enqueue(pcmBase64);
			session.onInputTranscript = (text) => {
				const store = useChatStore.getState();
				inputAccum += text;
				if (inputTurnDirty) {
					store.updateLastMessage("user", inputAccum);
				} else {
					store.addMessage({ role: "user", content: text });
					inputTurnDirty = true;
				}
			};
			session.onOutputTranscript = (text) => {
				const store = useChatStore.getState();
				outputAccum += text;
				// Robust fallback: derive the avatar expression from the transcript
				// itself (uppercase/lowercase tags or a leaked stage direction) when
				// the server did NOT send emotion.updated this turn — LLM output is
				// imperfect. A present server emotion.updated takes precedence. Also
				// use the cleaned text for the chat row so tags/stage directions don't
				// show. emotion=null leaves the current face unchanged (no neutral reset).
				const { emotion, cleanText } = extractExpression(outputAccum);
				if (emotion && !serverEmotionSeenThisTurn) setEmotion(emotion);
				if (outputTurnDirty) {
					store.updateLastMessage("assistant", cleanText);
				} else {
					store.addMessage({ role: "assistant", content: cleanText });
					outputTurnDirty = true;
				}
			};
			session.onEmotion = (state) => {
				// naia-omni emotion.updated (manual §5) → avatar expression. This is
				// authoritative for the turn: mark it so the transcript fallback in
				// onOutputTranscript does not override it. Unknown tags map to null →
				// leave the current expression as is.
				const emotion = mapServerEmotion(state);
				if (emotion) {
					setEmotion(emotion);
					serverEmotionSeenThisTurn = true;
				}
			};
			session.onInterrupted = () => {
				player.clear();
				inputTurnDirty = false;
				outputTurnDirty = false;
				inputAccum = "";
				outputAccum = "";
				serverEmotionSeenThisTurn = false;
			};
			session.onTurnEnd = () => {
				inputTurnDirty = false;
				outputTurnDirty = false;
				inputAccum = "";
				outputAccum = "";
				serverEmotionSeenThisTurn = false;
			};
			session.onToolCall = async (callId, toolName, args) => {
				try {
					const result = await directToolCall({
						toolName,
						args,
						requestId: generateRequestId(),
						gatewayUrl: resolveConfiguredGatewayUrl(config),
						// Voice mode: the user spoke the request out loud, which is
						// implicit consent. Auto-approve Tier>0 tools instead of
						// popping a modal the user would have to hunt for mid-
						// conversation (which otherwise hangs until timeout). The
						// server-side tier gate still logs the decision.
						onApprovalRequest: (req) => {
							sendApprovalResponse(req.requestId, req.toolCallId, "once");
						},
						// Panel-owned tools (skill_browser_*, skill_panel switch)
						// only ran in streaming chat before; route them here too so
						// voice can drive panels. Auto-switches to the owner panel.
						onPanelToolCall: (req) => dispatchPanelToolCall(req),
						onPanelControl: (req) => dispatchPanelControl(req),
					});
					session.sendToolResponse(callId, result.output);
				} catch (err) {
					session.sendToolResponse(callId, `Error: ${err}`);
				}
			};
			session.onError = (err) => {
				Logger.warn("ChatPanel", "Voice session error", { error: err.message });
				useChatStore.getState().addMessage({
					role: "assistant",
					content: `${t("chat.voiceError")}: ${err.message}`,
				});
				session.disconnect();
			};
			session.onDisconnect = (info) => {
				// Atomic terminal transition for a mid-call drop. Tear down (cost
				// summary, bridge, mic, player) SYNCHRONOUSLY first, THEN set the
				// terminal status once — so the derived voice button can't re-enable
				// against a half-cleaned session, and the close reason isn't lost to
				// a state thrash. showVoiceCostSummary is idempotent, so a
				// user-initiated stop that also runs the toggle path stays safe.
				showVoiceCostSummary();
				panelContextBridgeRef.current?.detach();
				panelContextBridgeRef.current = null;
				micStreamRef.current?.stop();
				audioPlayerRef.current?.destroy();
				voiceSessionRef.current = null;
				micStreamRef.current = null;
				audioPlayerRef.current = null;
				// Surface why the call ended (superseded / credits / auth); a normal
				// or user-initiated close stays silent.
				const reason: VoiceCloseReason = info?.reason ?? "normal";
				const msg = voiceCloseMessage(reason);
				if (msg) {
					useChatStore
						.getState()
						.addMessage({ role: "assistant", content: msg });
				}
				const terminal: VoiceConnectionStatus =
					reason === "normal" || reason === "unknown"
						? { phase: "idle" }
						: { phase: "closed", code: info?.code, reason };
				setVoiceStatus(terminal);
				lastVoiceStatusRef.current = terminal;
			};

			// Build provider-specific config and connect
			const selectedVoice =
				config.voice ?? getDefaultVoiceForAvatar(config.vrmModel);
			if (liveProvider === "vllm-omni") {
				const vllmBase = (config.vllmHost ?? DEFAULT_VLLM_HOST).replace(
					/\/+$/,
					"",
				);
				// vllmHost may be ws:// (from settings) → convert to http://
				const httpHost = vllmBase.replace(/^ws/, "http");
				await session.connect({
					provider: "vllm-omni",
					host: httpHost,
					model: config.model ?? "",
					systemInstruction: voiceSystemPrompt,
					tools: voiceTools.length ? voiceTools : undefined,
				});
			} else if (liveProvider === "naia-omni") {
				// naia-omni: gateway when logged in; Naia Local = direct to the
				// user's OWN container (even when logged in); else direct (vllm).
				const isLocalContainer = config.model === "naia-local";
				// Naia Local needs the login key — the container validates entitlement.
				if (isLocalContainer && !naiaKey) {
					Logger.warn("ChatPanel", "Naia Local requires login (Naia key)");
					useChatStore.getState().addMessage({
						role: "assistant",
						content: t("chat.voiceNeedLabKey"),
					});
					setVoiceStatus({ phase: "idle" });
					return;
				}
				const useGw = !!naiaKey && !isLocalContainer;
				const vllmBase = (config.vllmHost ?? DEFAULT_VLLM_HOST).replace(
					/\/+$/,
					"",
				);
				const wsBase = vllmBase.replace(/^http/, "ws");
				// Reference voice: send the preset sample_url the user picked, taken
				// DIRECTLY from config — the same deterministic source the web demo
				// uses (no unreliable GET /v1/ref-audio status round-trip).
				// Sent for BOTH cloud gateway AND Naia Local (own container, direct
				// mode): both run the same omni cascade and accept ref_audio_url in
				// session.update. For Naia Local there is NO gateway GCS injection in
				// the path, so the client sending the URL is the ONLY way the cloned
				// voice reaches the container — gating this behind gateway mode left
				// local-container voice with a random per-turn voice. The sample_url
				// is a public storage.googleapis.com URL (no secret), so it is safe
				// on the direct socket. Empty for uploads (injected server-side).
				// Naia Local recorded/uploaded voice is kept as a base64 WAV locally
				// (no gateway upload → no credit charge) and sent embedded. It wins
				// over a preset URL when present.
				const localRefB64 = isLocalContainer ? getLocalRefAudioB64() : null;
				// Default the voice to "여성 음색 1" when nothing is chosen, so the
				// omni voice is never the unconditioned/random default (the "이상한
				// 목소리" the user hit after removing a ref). A custom recording
				// (base64) takes priority over any URL.
				const naiaRefAudioUrl = localRefB64
					? undefined
					: useGw || isLocalContainer
						? config.voiceRefUrl || DEFAULT_VOICE_REF_URL
						: undefined;
				Logger.info("ChatPanel", "naia-omni ref audio resolved", {
					hasRefAudioUrl: !!naiaRefAudioUrl,
					hasRefAudioB64: !!localRefB64,
				});
				await session.connect({
					provider: "naia-omni",
					localContainer: isLocalContainer || undefined,
					refAudioUrl: naiaRefAudioUrl,
					refAudio: localRefB64 ?? undefined,
					serverUrl: isLocalContainer
						? (config.naiaLocalUrl ?? DEFAULT_NAIA_LOCAL_URL)
						: useGw
							? undefined
							: wsBase,
					gatewayUrl: useGw ? LAB_GATEWAY_URL : undefined,
					// Naia Local reuses the logged-in key (no key input) so the
					// container can validate entitlement (gated by localContainer).
					naiaKey: useGw || isLocalContainer ? naiaKey : undefined,
					instanceId:
						useGw || isLocalContainer
							? getNaiaInstanceId(config.naiaUserId)
							: undefined,
					// Wire model = the real model the container serves; "naia-local" is
					// a UI alias only (cross-review: don't send the alias on the wire).
					model: isLocalContainer ? "naia-0.9-omni-24g" : config.model,
					systemInstruction: voiceSystemPrompt,
					voice: selectedVoice,
					locale: getLocale(),
					tools: voiceTools.length ? voiceTools : undefined,
				});
			} else if (liveProvider === "openai-realtime") {
				// Pure OpenAI Realtime (user's own key). Naia voice routes via the
				// "naia-omni" provider branch above (/v1/realtime gateway), never here.
				const openaiKey = config.openaiRealtimeApiKey ?? config.apiKey;
				await session.connect({
					provider: "openai-realtime",
					apiKey: openaiKey!,
					model: config.model,
					voice: selectedVoice,
					locale: getLocale(),
					systemInstruction: voiceSystemPrompt,
					tools: voiceTools.length ? voiceTools : undefined,
				});
			} else {
				// Gemini Live: naia (gateway) or gemini-live (direct via Rust proxy)
				await session.connect({
					provider: "gemini-live",
					gatewayUrl: useDirectMode ? undefined : LAB_GATEWAY_URL,
					naiaKey: useDirectMode ? undefined : naiaKey,
					googleApiKey: useDirectMode ? config.googleApiKey : undefined,
					voice: selectedVoice,
					locale: getLocale(),
					systemInstruction: voiceSystemPrompt,
					tools: voiceTools.length ? voiceTools : undefined,
				});
			}

			// Create mic stream — tolerate a missing/erroring mic. The omni session
			// is already connected and can still answer TYPED text (+ voice output),
			// exactly like the web demo. A mic failure (e.g. no input device →
			// OverconstrainedError) must NOT tear down the session, so catch it here
			// instead of letting it reach the outer catch that disconnects everything.
			try {
			const mic = await createMicStream({
				onChunk: (pcmBase64) => {
					// Barge-in: stream the mic continuously so the server VAD can
					// detect the user interrupting Naia mid-utterance → fires
					// `interrupted` → onInterrupted clears the audio player.
					//
					// Echo gate, declared per-provider via session.audioInput.
					// On weak-AEC paths (WebKitGTK) gateWhilePlaying drops
					// sub-threshold chunks while Naia speaks so AEC-residual echo
					// doesn't self-trigger the server VAD (#216,
					// SPEECH_RMS_THRESHOLD=200). Real user speech still passes; the
					// short-circuit skips the RMS decode when the gate is off.
					if (
						session.audioInput.gateWhilePlaying &&
						audioPlayerRef.current?.isPlaying &&
						rmsFromBase64Pcm(pcmBase64) < SPEECH_RMS_THRESHOLD
					) {
						return;
					}
					session.sendAudio(pcmBase64);
				},
				sampleRate: session.audioInput.sampleRate,
				autoGainControl: session.audioInput.autoGainControl,
			});
			micStreamRef.current = mic;
			mic.start();
			} catch (micErr) {
				// No usable microphone → keep the session alive for typed input +
				// voice output (web-demo parity). Do not rethrow / disconnect.
				Logger.warn(
					"ChatPanel",
					"mic unavailable — voice session continues text-only",
					{ error: String(micErr) },
				);
			}

			setVoiceStatus({ phase: "active" });
			lastVoiceStatusRef.current = { phase: "active" };
			voiceStartRef.current = {
				time: Date.now(),
				provider: liveProvider,
				// Naia Local runs on the user's OWN GPU (direct, no cloud pod) → free.
				localContainer: config.model === "naia-local",
			};
			Logger.info("ChatPanel", "Voice conversation started", {
				provider: liveProvider,
			});
		} catch (err) {
			const cancelled =
				voiceCancelledRef.current ||
				(err instanceof Error && err.name === "AbortError");
			const errStr = String(err);
			Logger.warn("ChatPanel", "Voice connection failed", {
				error: errStr,
				cancelled,
			});
			// User-initiated cold-start cancel → no message. Otherwise: Naia Local
			// entitlement gate (subscription-required / auth-failed) takes priority,
			// then a scenario message from the last status the session emitted
			// (sold-out / credits / auth / superseded / consent / timeout), else a
			// raw dump. Cleanup below turns voice off so there is no retry loop.
			if (!cancelled) {
				const content = errStr.includes("subscription-required")
					? t("chat.voiceSubscriptionRequired")
					: errStr.includes("auth-failed")
						? t("chat.voiceNeedLabKey")
						: voiceFailureMessage(lastVoiceStatusRef.current, err);
				useChatStore.getState().addMessage({ role: "assistant", content });
			}
			voiceCancelledRef.current = false;
			// Detach onDisconnect before cleanup to prevent double-cleanup
			if (voiceSessionRef.current) voiceSessionRef.current.onDisconnect = null;
			panelContextBridgeRef.current?.detach();
			panelContextBridgeRef.current = null;
			voiceSessionRef.current?.disconnect();
			micStreamRef.current?.stop();
			audioPlayerRef.current?.destroy();
			voiceSessionRef.current = null;
			micStreamRef.current = null;
			audioPlayerRef.current = null;
			// Single terminal transition back to idle (button + banner derive off).
			setVoiceStatus({ phase: "idle" });
			lastVoiceStatusRef.current = { phase: "idle" };
		}
	}

	function handleVoiceCancel() {
		// Cancel an in-progress cold-start. disconnect() breaks naia-omni's retry
		// loop (abortableSleep → AbortError) and fires abandonPod to release the
		// warming Pod; the connect() catch then runs cleanup and clears the banner.
		voiceCancelledRef.current = true;
		voiceSessionRef.current?.disconnect();
	}

	function handleTabChange(tab: TabId) {
		setActiveTab(tab);
		if (tab === "progress") {
			const store = useProgressStore.getState();
			store.setLoading(true);
			const filter: AuditFilter = { limit: 100 };
			Promise.all([
				invoke("get_audit_log", { filter }),
				invoke("get_audit_stats"),
			])
				.then(([eventsResult, statsResult]) => {
					const s = useProgressStore.getState();
					s.setEvents(eventsResult as AuditEvent[]);
					s.setStats(statsResult as Parameters<typeof s.setStats>[0]);
				})
				.catch((err) => {
					Logger.warn("ChatPanel", "Failed to load progress data", {
						error: String(err),
					});
				})
				.finally(() => {
					useProgressStore.getState().setLoading(false);
				});
		}
	}

	// ── @ mention: track input changes ──────────────────────────────────
	const handleInputChange = useCallback(
		(e: React.ChangeEvent<HTMLTextAreaElement>) => {
			const value = e.target.value;
			setInput(value);

			// Detect @ trigger
			const cursorPos = e.target.selectionStart ?? value.length;

			if (atMentionOpen) {
				// Update query: text between @ and cursor
				const start = atMentionStartRef.current;
				if (start >= 0 && cursorPos > start) {
					const q = value.slice(start + 1, cursorPos);
					// Close if space right after @ or cursor moved before @
					if (q.includes(" ") && q.indexOf(" ") === 0) {
						setAtMentionOpen(false);
						setAtMentionQuery("");
						atMentionStartRef.current = -1;
					} else {
						setAtMentionQuery(q);
					}
				} else {
					// Cursor moved before @, close popover
					setAtMentionOpen(false);
					setAtMentionQuery("");
					atMentionStartRef.current = -1;
				}
			} else {
				// Check if @ was just typed (the char before cursor is @)
				if (
					cursorPos > 0 &&
					value[cursorPos - 1] === "@" &&
					isWorkspaceAvailable()
				) {
					// Only trigger if @ is at start or preceded by whitespace
					const charBefore = cursorPos >= 2 ? value[cursorPos - 2] : undefined;
					if (!charBefore || /\s/.test(charBefore)) {
						setAtMentionOpen(true);
						setAtMentionQuery("");
						atMentionStartRef.current = cursorPos - 1;
					}
				}
			}
		},
		[atMentionOpen],
	);

	// ── @ mention: handle selection ─────────────────────────────────────
	const handleAtMentionSelect = useCallback(
		(item: AtMentionResult) => {
			const start = atMentionStartRef.current;
			if (start < 0) return;
			const el = inputRef.current;
			const cursorPos = el?.selectionStart ?? input.length;
			// Replace @query with @relative/path
			const before = input.slice(0, start);
			const after = input.slice(cursorPos);
			const mention = `@${item.rel} `;
			const newValue = before + mention + after;
			setInput(newValue);
			setAtMentionOpen(false);
			setAtMentionQuery("");
			atMentionStartRef.current = -1;
			// Move cursor after the inserted mention
			requestAnimationFrame(() => {
				const pos = before.length + mention.length;
				inputRef.current?.setSelectionRange(pos, pos);
				inputRef.current?.focus();
			});
		},
		[input],
	);

	const handleAtMentionClose = useCallback(() => {
		setAtMentionOpen(false);
		setAtMentionQuery("");
		atMentionStartRef.current = -1;
	}, []);

	function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
		// ── @ mention keyboard navigation (intercept before other handlers)
		if (atMentionOpen && atMentionRef.current) {
			const handled = atMentionRef.current.handleKeyDown(e);
			if (handled) {
				e.preventDefault();
				return;
			}
		}

		if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
			e.preventDefault();
			handleSend();
			return;
		}

		// ── Arrow key input history ──────────────────────────────────────
		const hist = inputHistoryRef.current;
		if (hist.length === 0) return;
		const el = e.currentTarget;

		if (e.key === "ArrowUp") {
			// Only activate when cursor is at the very start and no selection
			if (el.selectionStart !== 0 || el.selectionEnd !== 0) return;

			e.preventDefault();
			if (historyIndexRef.current === -1) {
				historyDraftRef.current = input;
				historyIndexRef.current = hist.length - 1;
			} else if (historyIndexRef.current > 0) {
				historyIndexRef.current -= 1;
			}
			const text = hist[historyIndexRef.current];
			setInput(text);
			// After React re-renders, move cursor to start so next ArrowUp works
			requestAnimationFrame(() => {
				inputRef.current?.setSelectionRange(0, 0);
			});
		} else if (e.key === "ArrowDown") {
			if (historyIndexRef.current === -1) return;

			e.preventDefault();
			let text: string;
			if (historyIndexRef.current < hist.length - 1) {
				historyIndexRef.current += 1;
				text = hist[historyIndexRef.current];
			} else {
				historyIndexRef.current = -1;
				text = historyDraftRef.current;
			}
			setInput(text);
			requestAnimationFrame(() => {
				inputRef.current?.setSelectionRange(0, 0);
			});
		}
	}

	return (
		<>
			<div className="chat-panel">
				{/* Header with tabs */}
				<div className="chat-header">
					<div className="chat-tabs">
						<button
							type="button"
							className={`chat-tab${activeTab === "chat" ? " active" : ""}`}
							onClick={() => handleTabChange("chat")}
							title={t("progress.tabChat")}
							aria-label={t("progress.tabChat")}
							data-tooltip={t("progress.tabChat")}
						>
							<span className="chat-tab-icon" aria-hidden="true">
								{TAB_ICONS.chat}
							</span>
						</button>
						<button
							type="button"
							className={`chat-tab${activeTab === "history" ? " active" : ""}`}
							onClick={() => handleTabChange("history")}
							title={t("history.tabHistory")}
							aria-label={t("history.tabHistory")}
							data-tooltip={t("history.tabHistory")}
						>
							<span className="chat-tab-icon" aria-hidden="true">
								{TAB_ICONS.history}
							</span>
						</button>
						<button
							type="button"
							className={`chat-tab${activeTab === "channels" ? " active" : ""}`}
							onClick={() => handleTabChange("channels")}
							title={t("channels.tabChannels")}
							aria-label={t("channels.tabChannels")}
							data-tooltip={t("channels.tabChannels")}
						>
							<span className="chat-tab-icon" aria-hidden="true">
								{TAB_ICONS.channels}
							</span>
						</button>
					</div>
					<div className="chat-header-right">
						{totalSessionCost > 0 &&
							provider !== "ollama" &&
							provider !== "vllm" && (
								<button
									type="button"
									className="cost-badge session-cost cost-badge-clickable"
									onClick={() => setShowCostDashboard((v) => !v)}
								>
									{formatCost(totalSessionCost)}
								</button>
							)}
						<button
							type="button"
							className="settings-icon-btn new-chat-btn"
							onClick={handleNewConversation}
							title={t("chat.newConversation")}
							disabled={isStreaming}
						>
							+
						</button>
					</div>
				</div>

				{/* Progress tab */}
				{activeTab === "progress" && <WorkProgressPanel />}

				{/* Skills tab */}
				{activeTab === "skills" && (
					<SkillsTab
						onAskAI={(message) => {
							setInput(message);
							setActiveTab("chat");
							if (focusTimerRef.current) clearTimeout(focusTimerRef.current);
							focusTimerRef.current = setTimeout(() => {
								inputRef.current?.focus();
								focusTimerRef.current = null;
							}, 50);
						}}
					/>
				)}

				{/* Agents tab */}
				{activeTab === "agents" && <AgentsTab />}

				{/* Diagnostics tab */}
				{activeTab === "diagnostics" && <DiagnosticsTab />}

				{/* Settings tab */}

				{/* Channels tab */}
				{activeTab === "channels" && (
					<div className="chat-tab-placeholder">
						<span>🌐</span>
						<p>{t("channels.maintenance")}</p>
					</div>
				)}

				{/* History tab */}
				{activeTab === "history" && (
					<HistoryTab onLoadSession={() => setActiveTab("chat")} />
				)}

				{/* Cost dashboard (dropdown) */}
				{showCostDashboard && activeTab === "chat" && (
					<CostDashboard
						messages={messages}
						sessionCostEntries={sessionCostEntries}
					/>
				)}

				{/* Messages (chat tab) */}
				<div
					className="chat-messages"
					style={{ display: activeTab === "chat" ? "flex" : "none" }}
				>
					{messages
						.filter((msg) => {
							if (
								msg.role === "user" &&
								msg.content.startsWith("Read HEARTBEAT.md if it exists")
							)
								return false;
							if (
								msg.role === "assistant" &&
								/^HEARTBEAT_OK\b/.test(msg.content.trim())
							)
								return false;
							return true;
						})
						.map((msg) => (
							<div key={msg.id} className={`chat-message ${msg.role}`}>
								{msg.thinking && (
									<details className="thinking-inline">
										<summary className="thinking-inline-summary">
											<span className="thinking-inline-label">
												💭 {t("chat.thinking") || "Thinking..."}
											</span>
										</summary>
										<div className="thinking-inline-content">
											{msg.thinking}
										</div>
									</details>
								)}
								{msg.toolCalls?.map((tc) => (
									<ToolActivity key={tc.toolCallId} tool={tc} />
								))}
								<div className="message-content">
									{msg.role === "assistant" ? (
										<Markdown components={mdComponents}>
											{extractExpression(msg.content).cleanText}
										</Markdown>
									) : (
										msg.content
									)}
								</div>
								{msg.cost && provider !== "ollama" && provider !== "vllm" && (
									<span className="cost-badge">
										{formatCost(msg.cost.cost)} ·{" "}
										{msg.cost.inputTokens + msg.cost.outputTokens}{" "}
										{t("chat.tokens")}
									</span>
								)}
							</div>
						))}

					{/* Streaming content */}
					{isStreaming && (
						<div className="chat-message assistant streaming">
							{streamingThinking && (
								<details className="thinking-inline" open>
									<summary className="thinking-inline-summary">
										<span className="thinking-inline-label">
											💭 {t("chat.thinking") || "Thinking..."}
										</span>
									</summary>
									<div className="thinking-inline-content">
										{streamingThinking}
									</div>
								</details>
							)}
							{streamingToolCalls.map((tc) => (
								<ToolActivity key={tc.toolCallId} tool={tc} />
							))}
							<div className="message-content">
								{streamingContent ? (
									<Markdown components={mdComponents}>
										{extractExpression(streamingContent).cleanText}
									</Markdown>
								) : null}
								<span className="cursor-blink">▌</span>
							</div>
						</div>
					)}

					<div ref={messagesEndRef} />
				</div>

				{/* Permission Modal */}
				{pendingApproval && (
					<PermissionModal
						pending={pendingApproval}
						onDecision={handleApprovalDecision}
					/>
				)}

				{/* Cold-start-aware voice connection status (naia-omni RunPod). The
				    voice button is disabled while connecting, so cold-start exposes
				    an explicit Cancel here (→ abandon Pod) instead of a frozen wait. */}
				{activeTab === "chat" && voiceMode === "connecting" && (
					<div className="voice-status-banner">
						<span className="voice-status-spinner" />
						<span className="voice-status-text">
							{voiceStatus.phase === "cold-start"
								? `${t("chat.voiceColdStart")} · ${voiceStatus.elapsedSeconds}s` +
									(voiceStatus.queuePosition != null
										? ` · ${t("chat.voiceColdStartQueue")} ${voiceStatus.queuePosition}`
										: "") +
									(voiceStatus.etaSeconds != null
										? ` · ${t("chat.voiceColdStartEta")} ~${voiceStatus.etaSeconds}s`
										: "")
								: t("chat.voiceConnecting")}
						</span>
						{voiceStatus.phase === "cold-start" && (
							<button
								type="button"
								className="voice-status-cancel"
								onClick={handleVoiceCancel}
							>
								{t("chat.voiceColdStartCancel")}
							</button>
						)}
					</div>
				)}

				{/* Input (chat tab only) */}
				<div
					className="chat-input-bar"
					style={{ display: activeTab === "chat" ? "flex" : "none" }}
				>
					<button
						type="button"
						className={`chat-voice-btn${voiceMode === "connecting" ? " connecting" : voiceMode === "active" ? " active" : ""}${sttPartial ? " hearing" : ""}${ttsPlaying ? " speaking" : ""}${sttState === "initializing" && !ttsPlaying ? " preparing" : ""}`}
						onClick={handleVoiceToggle}
						disabled={voiceMode === "connecting"}
						title={
							voiceMode === "off"
								? t("chat.voiceStart")
								: voiceMode === "connecting"
									? t("chat.voiceConnecting")
									: ttsPlaying
										? "끼어들기 (TTS 중단)"
										: t("chat.voiceEnd")
						}
					>
						<span className="voice-bar" />
						<span className="voice-bar" />
						<span className="voice-bar" />
						<span className="voice-bar" />
					</button>
					{pipelineActiveRef.current && sttPartial && (
						<div className="stt-partial">{sttPartial}</div>
					)}
					{atMentionOpen && (
						<AtMentionPopover
							ref={atMentionRef}
							query={atMentionQuery}
							onSelect={handleAtMentionSelect}
							onClose={handleAtMentionClose}
						/>
					)}
					<textarea
						ref={inputRef}
						value={input}
						onChange={handleInputChange}
						onKeyDown={handleKeyDown}
						placeholder={
							pipelineActiveRef.current
								? ttsPlaying
									? "나이아가 말하는 중... (버튼을 눌러 끊기)"
									: sttState === "initializing"
										? "음성 인식 준비 중..."
										: sttState === "listening"
											? "듣고 있어요... (텍스트 입력도 가능)"
											: t("chat.placeholder")
								: t("chat.placeholder")
						}
						rows={3}
						// Allow typing during an active Live voice session too — a
						// typed line is routed to the Live session (see sendChat above)
						// and answered in voice, same as spoken input. Only block
						// while the session is still connecting.
						disabled={voiceMode === "connecting"}
						className="chat-input"
					/>
					{messageQueue.length > 0 && (
						<span className="queue-badge">
							{messageQueue.length} {t("chat.queued")}
						</span>
					)}
					{isStreaming ? (
						<button
							type="button"
							onClick={handleCancelStreaming}
							className="chat-send-btn chat-cancel-btn"
							title="ESC"
						>
							■
						</button>
					) : (
						<button
							type="button"
							onClick={() => handleSend()}
							disabled={!input.trim()}
							className="chat-send-btn"
						>
							↑
						</button>
					)}
				</div>
			</div>
			{showNoAuthModal && (
				<div
					className="sync-dialog-overlay"
					onClick={() => setShowNoAuthModal(false)}
				>
					<div
						className="sync-dialog-card"
						onClick={(e) => e.stopPropagation()}
						style={{ maxWidth: 360 }}
					>
						<p
							style={{
								marginBottom: 16,
								lineHeight: 1.6,
								whiteSpace: "pre-line",
							}}
						>
							{t("chat.noAuthMessage")}
						</p>
						<div className="sync-dialog-actions">
							<button
								type="button"
								className="onboarding-next-btn"
								onClick={() => {
									setShowNoAuthModal(false);
									usePanelStore.getState().setActivePanel("settings");
									window.dispatchEvent(
										new CustomEvent("naia-open-settings", {
											detail: { tab: "ai" },
										}),
									);
								}}
							>
								{t("chat.noAuthConfirm")}
							</button>
						</div>
					</div>
				</div>
			)}
		</>
	);
}
