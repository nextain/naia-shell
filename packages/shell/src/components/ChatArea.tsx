import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
import { makeCoreAudioPlayer } from "../lib/voice-core";
import { getDefaultVoiceForAvatar } from "../lib/avatar-presets";
import {
	cancelChat,
	configureSpeechProfile,
	controlSpeechActivity,
	directToolCall,
	fetchAgentSkills,
	isNewCore,
	sendApprovalResponse,
	sendChatMessage,
	sendPanelToolResult,
	yieldSpeechActivity,
	type SpeechActivityResume,
} from "../lib/chat-service";
import { SKILL_YOUTUBE_BGM, executeBgmSkill } from "../lib/bgm-skill";
import {
	activateMicUnlessSpeechActivityOwnsVoice,
	canSpeakProactiveText,
	parseSpeechProfileCommand,
	resolveSpeechProfileSession,
	shouldAbortLiveConnectForSpeechActivity,
	shouldBlockDirectLiveForSpeechActivity,
	shouldQueueBeforeSpeechYield,
} from "../lib/speech-profile-commands";
import {
	normalizeProactiveSpeechSettings,
	toSpeechProfileCommandInput,
} from "../lib/proactive-speech-settings";
import {
	DEFAULT_NAIA_LOCAL_URL,
	DEFAULT_VLLM_HOST,
	DEFAULT_VOICE_REF_URL,
	LAB_GATEWAY_URL,
	type AppConfig,
	type TtsProviderId,
	addAllowedTool,
	getNaiaInstanceId,
	isToolAllowed,
	loadConfig,
	loadConfigWithSecrets,
	localeToSttLanguage,
	resolveConfiguredGatewayUrl,
	saveConfig,
} from "../lib/config";
import { remoteCascadeUrlFromConfig } from "../lib/avatar/cascade-renderer";
import {
	discoverAndPersistDiscordDmChannel,
	resetGatewaySession,
} from "../lib/gateway-sessions";
import { getLocale, t } from "../lib/i18n";
import { wireErrorMessage } from "../lib/wire-errors";
import {
	getDefaultLlmModel,
	getLlmModel,
	getLlmProvider,
	isApiKeyOptional,
	isOmniModel,
} from "../lib/llm";
import { Logger } from "../lib/logger";
import { type MicStream, createMicStream } from "../lib/mic-stream";
import { appRegistry } from "../lib/app-registry";
import { type MemoryContext, buildSystemPrompt } from "../lib/persona";
import {
	createApiSttSession,
	createWebSpeechSttSession,
	getSttProvider,
} from "../lib/stt";
import { getTtsProviderMeta } from "../lib/tts";
import { estimateSttCost, estimateTtsCost } from "../lib/tts/cost";
import { streamsAvatarPcm, synthesizeTts } from "../lib/tts/synthesize";
import { isLikelySelfEcho } from "../lib/voice/echo-gate";
import type {
	AgentResponseChunk,
	AuditEvent,
	AuditFilter,
	EnvironmentSegment,
	ProviderId,
} from "../lib/types";

type StructuredAgentChunk = Extract<
	AgentResponseChunk,
	{
		type:
			| "grounding"
			| "artifact"
			| "provider_session"
			| "processing_disclosure";
	}
>;

function formatStructuredAgentChunk(chunk: StructuredAgentChunk): string {
	switch (chunk.type) {
		case "grounding": {
			const sources = chunk.sources
				.map((source) => {
					const uris = source.sourceUris.join(", ");
					return uris ? `${source.title} (${uris})` : source.title;
				})
				.join("; ");
			return `\n\n[Grounding: ${chunk.status}]${sources ? ` ${sources}` : ""}`;
		}
		case "artifact": {
			const name = chunk.artifact.name ?? chunk.artifact.id;
			return `\n\n[Artifact: ${chunk.artifact.kind} ${name}] id=${chunk.artifact.id} localRef=${chunk.artifact.localRef} ${chunk.artifact.mimeType}, ${chunk.artifact.sizeBytes} bytes`;
		}
		case "provider_session":
			return `\n\n[Provider session: ${chunk.state}] sessionId=${chunk.sessionId} providerSessionRef=${chunk.providerSessionRef}`;
		case "processing_disclosure": {
			const target = [chunk.provider, chunk.model].filter(Boolean).join("/");
			return `\n\n[Processing: ${chunk.workload} -> ${chunk.destination}, ${chunk.decision}] processingProfileRef=${chunk.processingProfileRef}${target ? ` ${target}` : ""}`;
		}
	}
}

import { AudioQueue } from "../lib/voice/audio-queue";
import {
	LIVE_PROVIDER_COST_HINTS,
	type AppContextBridge,
	SPEECH_RMS_THRESHOLD,
	type VoiceCloseReason,
	type VoiceConnectionStatus,
	type VoiceSession,
	attachAppContextBridge,
	createVoiceSession,
	rmsFromBase64Pcm,
} from "../lib/voice/index";
import { getLocalRefAudioB64 } from "../lib/voice/ref-audio-api";
import { SentenceChunker } from "../lib/voice/sentence-chunker";
import { extractExpression, mapServerEmotion } from "../lib/vrm/expression";
import { useAvatarStore } from "../stores/avatar";
import { useCascadeAvatarStore } from "../stores/cascade-avatar";
import { useChatStore } from "../stores/chat";
import { useLogsStore } from "../stores/logs";
import { selectPromptAppContexts, useAppStore } from "../stores/app";
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
import { ChannelsTab } from "./ChannelsTab";
import { DiagnosticsTab } from "./DiagnosticsTab";
import { HistoryTab } from "./HistoryTab";
import { PermissionModal } from "./PermissionModal";
import { SkillsTab } from "./SkillsTab";
import { ToolActivity } from "./ToolActivity";
import { WorkProgressArea } from "./WorkProgressArea";

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
	appRegistry.getApi("workspace")?.openFile(path);
	useAppStore.getState().setActiveApp("workspace");
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

/** 로컬 음성(naia-local-voice) 음색 id — 사용자 음성 참조(voiceRefUrl, RefAudioSection
 *  프리셋)의 **파일명**이 façade `/ref/voices` 팔레트 id 와 일치하므로 basename 을 그대로
 *  전달한다. (2026-07-15 루크 실증: 하드코딩 "default" 가 프리셋 선택을 façade 에 전달하지
 *  않아 음색이 팔레트 기본으로 고정되던 버그 — 남성 음색을 골라도 여성으로 나옴.)
 *  비팔레트 형식(녹음/업로드 data·로컬경로)은 façade 가 400 fail-closed 라 기본 음색 폴백. */
function naiaLocalVoiceId(voiceRefUrl?: string): string {
	if (!voiceRefUrl) return "naia-default";
	// 쿼리/프래그먼트 제거 후 basename — GCS 서명 URL(...wav?X-Goog-...) 이나 프리셋
	// sampleUrl 의 쿼리스트링 때문에 정규식이 빗나가 프리셋이 무시되던 것 방지(2026-07-15 리뷰).
	const noQuery = voiceRefUrl.split(/[?#]/)[0];
	const base = noQuery.split(/[/\\]/).pop()?.trim() ?? "";
	// façade 팔레트 id = .wav 파일명. 팔레트 밖 값(녹음/업로드 data·경로)은 서버가 모르는
	// id 를 200+랜덤음색으로 받으므로(측정), 안전한 기본 음색으로 폴백한다.
	return /^[\w.-]+\.wav$/i.test(base) ? base : "naia-default";
}

/** TTS provider 별 voice id 해석 (단일 SoT — 파이프라인·Live 두 경로가 공유해 분기 드리프트
 *  방지, 2026-07-15 리뷰). nextain=클라우드 voice / **naia-local-voice=façade 팔레트 id**(프리셋
 *  파일명) / **vllm=사용자 임의 OpenAI-호환 서버라 "default" 그대로**(팔레트 id 를 모름 — 이걸
 *  섞으면 vllm 이 400/무음) / 그 외=config.ttsVoice. */
function resolveTtsVoiceId(config: AppConfig): string | undefined {
	if (config.ttsProvider === "nextain") {
		return (
			config.ttsVoice ||
			`ko-KR-Chirp3-HD-${config.voice ?? getDefaultVoiceForAvatar(config.vrmModel)}`
		);
	}
	if (config.ttsProvider === "naia-local-voice") {
		return naiaLocalVoiceId(config.voiceRefUrl);
	}
	if (config.ttsProvider === "vllm") {
		return "default"; // 범용 OpenAI-호환 서버 — 팔레트 id 주입 금지.
	}
	return config.ttsVoice;
}

/** Build MemoryContext for system prompt injection.
 *  Note: User facts are now handled by Agent MemorySystem (sessionRecall).
 *  Shell only provides persona/locale/panel context.
 *
 *  S4: this is now used ONLY by the **voice (Live) and Discord** paths, which do
 *  NOT route through the naia-agent core (Gemini Live / OpenAI Realtime / naia-omni
 *  build their own systemInstruction). The gRPC text-chat path no longer bakes a
 *  systemPrompt — the core assembles persona/locale/honorific/speechStyle from
 *  config.json itself, and the shell sends only `environmentSegments` (see
 *  `buildEnvironmentSegments`). */
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
		const panelCtxList = selectPromptAppContexts(useAppStore.getState());
		if (panelCtxList.length > 0) {
			ctx.panelContexts = panelCtxList;
		}
	} catch (err) {
		Logger.warn("ChatArea", "Failed to build memory context", {
			error: String(err),
		});
	}
	return ctx;
}

/**
 * S4 — environment-only segments for the gRPC text-chat path. The shell stops
 * baking persona/locale/honorific/speechStyle/userName into a raw systemPrompt
 * (the core owns those, read from config.json). It sends ONLY its environment-
 * specific context:
 *   - `avatarEmotion`: the desktop shell always renders an avatar, so the core
 *     should emit its standard emotion-tag instructions (the wording lives in the
 *     core now; the shell only signals the capability).
 *   - `panel`: live UI panel context (bgm favorites, browser url, …) as isolated
 *     reference data.
 *   - `responseStyle`: voice-pipeline turns ask for brief spoken answers. The core
 *     owns the brevity wording and appends it AFTER persona, so voice replies stay
 *     in-persona (Alpha) yet short. `"normal"` (text chat) emits nothing.
 * Always returns at least the avatar segment (the desktop shell always has an
 * avatar), so the core merges environment context onto persona+workspace.
 */
function buildEnvironmentSegments(
	memoryCtx: MemoryContext,
	responseStyle: "brief" | "normal" = "normal",
): EnvironmentSegment[] {
	const segs: EnvironmentSegment[] = [{ kind: "avatarEmotion" }];
	if (memoryCtx.panelContexts?.length) {
		segs.push({
			kind: "app",
			entries: memoryCtx.panelContexts.map((pc) => ({
				type: pc.type,
				data: pc.data,
			})),
		});
	}
	// 음성 파이프라인(STT→채팅→TTS)은 brief — 코어가 간결성 지시를 persona 뒤에 append(persona 안 덮음).
	// normal(텍스트 채팅)은 무영향(코어가 블록 미생성).
	if (responseStyle === "brief") {
		segs.push({ kind: "responseStyle", style: "brief" });
	}
	return segs;
}

// Keep reference to prevent garbage collection during playback
let currentAudio: HTMLAudioElement | null = null;

/** Play base64 MP3 via HTML Audio element (reliable in webkit2gtk). */
function playBase64Audio(base64: string): void {
	Logger.info("ChatArea", "Audio chunk received", {
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
		Logger.info("ChatArea", "Audio playback ended");
		currentAudio = null;
		avatarStore.setSpeaking(false);
	};
	audio.onerror = (e) => {
		Logger.warn("ChatArea", "Audio playback error", {
			error: String(e),
		});
		currentAudio = null;
		avatarStore.setSpeaking(false);
	};
	audio.play().then(
		() => Logger.info("ChatArea", "Audio play() started"),
		(err) => {
			Logger.warn("ChatArea", "Audio play() rejected", {
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
 * truth. No parallel voiceMode state. Mirrors www.naia.land deriving its badge
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

export function isDiscordConnectionIntent(text: string): boolean {
	const normalized = text.trim().toLocaleLowerCase();
	if (!/(discord|디스코드)/i.test(normalized)) return false;
	return /(connect|connection|setup|configure|configuration|bot\s*token|연결|연동|설정|구성|봇\s*토큰|토큰\s*(입력|등록|설정))/i.test(
		normalized,
	);
}

/**
 * Visual variant of the chat surface. The component is a SINGLE instance
 * repositioned across UI modes via CSS (never remounted — preserves the live
 * voice/STT/TTS session). `variant` only changes UI density/chrome:
 *   - "floating": legacy bottom-left dock over the avatar (any non-home panel)
 *   - "vn":       immersive visual-novel dialogue box (home screen)
 *   - "rail":     full-height left rail inside the workspace mission-control
 */
export type ChatVariant = "vn" | "rail" | "floating";

export function ChatArea({
	variant = "floating",
}: { variant?: ChatVariant } = {}) {
	const [input, setInput] = useState("");
	// UC-compaction: agent 가 예산 압박으로 이전 대화를 요약했을 때 표시할 알림(흡수된 메시지 수). null=숨김.
	const [compactionNotice, setCompactionNotice] = useState<number | null>(null);
	const [activeTab, setActiveTab] = useState<TabId>("chat");
	// Discord configured = at least one Discord webhook / bot token is set
	const [showCostDashboard, setShowCostDashboard] = useState(false);
	const [showNoAuthModal, setShowNoAuthModal] = useState(false);
	const [showDiscordConnectionGuide, setShowDiscordConnectionGuide] =
		useState(false);
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
	const activeSpeechActivityRef = useRef<{
		activityId: string;
		profileGeneration: number;
	} | null>(null);
	const retiredSpeechActivityIdsRef = useRef(new Set<string>());
	const speechActivitySubscriptionEpochRef = useRef(0);
	const acceptSpeechActivitiesRef = useRef(true);
	const queuedSendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const voiceSessionRef = useRef<VoiceSession | null>(null);
	// #313 L3 — mid-session panel context bridge handle (detached in every
	// voice cleanup path).
	const panelContextBridgeRef = useRef<AppContextBridge | null>(null);
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
	// Per-sentence AbortControllers so interrupt/cleanup actually cancels the
	// in-flight TTS fetch/WS (and stops billing for superseded paid TTS) — #363
	// cross-review HIGH.
	const ttsAbortControllersRef = useRef<Map<string, AbortController>>(
		new Map(),
	);
	// One-time "local voice unavailable" notice per pipeline session — so a local
	// engine that isn't running surfaces a clear message once instead of either
	// spamming per sentence or silently masquerading as the browser free voice.
	const localVoiceUnavailableNoticedRef = useRef<boolean>(false);
	const pipelineVoiceConfigRef = useRef<{
		voice?: string;
		ttsProvider?: string;
		ttsApiKey?: string;
		/** nextain provider: gateway credit key. */
		naiaKey?: string;
		/** nextain provider: gateway base URL. */
		gatewayUrl?: string;
		/** vllm provider: local OpenAI-compatible host. */
		vllmHost?: string;
		/** naia-local-voice provider: local cascade / VoxCPM2 voice host. */
		vllmTtsHost?: string;
	} | null>(null);
	const sttCleanupRef = useRef<(() => void)[]>([]);
	const sttDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const sttBufferRef = useRef("");
	const ttsPlayingRef = useRef(false);
	const ttsCooldownUntilRef = useRef(0);
	// 자기발화(에코) 방어 (2026-07-15 루크): ① 재생 중 마이크 정지(캡처 차단 — 1차)
	// ② 최근 TTS 문장과의 유사도 스킵(web-speech 지연 배달 누수 — 2차, echo-gate.ts).
	const sttPauseRef = useRef<(() => void) | null>(null);
	const sttResumeRef = useRef<(() => void) | null>(null);
	const recentTtsTextsRef = useRef<string[]>([]);
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

	// E2E 통짜 검증(VITE_NAIA_E2E_AUTOCHAT=1): wdio 없이 앱 내부서 채팅을 구동해 실 webview→Rust gRPC 클라→
	// agent→z.ai→UI 렌더 전 경로를 관통. 응답+토큰을 naia-debug.log 로 기록(헤드리스 통짜 검증, 환경 SIGUSR1=wdio 회피).
	useEffect(() => {
		if (import.meta.env.VITE_NAIA_E2E_AUTOCHAT !== "1") return;
		const t = setTimeout(() => {
			Logger.info("ChatArea", "[E2E-AUTOCHAT] send 안녕");
			void handleSend("안녕");
		}, 5000); // config 로딩 + agent gRPC connect 여유
		return () => clearTimeout(t);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
	useEffect(() => {
		if (import.meta.env.VITE_NAIA_E2E_AUTOCHAT !== "1") return;
		// 진단 robust: cost 유무 무관, assistant 메시지가 생기면 기록(응답 안 옴 vs 로거 놓침 구분). streaming/에러도.
		const last = messages[messages.length - 1];
		if (last && last.role === "assistant") {
			Logger.info("ChatArea", "[E2E-AUTOCHAT] response", {
				text: last.content.slice(0, 120),
				tokens: last.cost
					? (last.cost.inputTokens ?? 0) + (last.cost.outputTokens ?? 0)
					: "no-cost",
				hasError: /\[오류\]|provider error|grpc/.test(last.content),
			});
		}
	}, [messages]);
	useEffect(() => {
		if (import.meta.env.VITE_NAIA_E2E_AUTOCHAT !== "1") return;
		if (streamingContent)
			Logger.info("ChatArea", "[E2E-AUTOCHAT] streaming", {
				len: streamingContent.length,
			});
	}, [streamingContent]);

	const setEmotion = useAvatarStore((s) => s.setEmotion);

	// The agent owns the local transcript. Do not hydrate the visual chat from
	// the legacy Gateway session: its asynchronous response can arrive after a
	// first local turn and replace the completed user/assistant pair with an
	// unrelated history. The next request then has an invalid role sequence.
	useEffect(() => {
		if (sessionLoaded.current) return;
		sessionLoaded.current = true;

		const loadSession = async () => {
			const store = useChatStore.getState();
			store.setSessionId("agent:main:main");

			const config = loadConfig();
			if (!config?.discordSessionMigrated) {
				// One-time migration: reset the contaminated main session (Discord DMs mixed in).
				// (restartGateway 제거됨 2026-06-12 — gateway 없음(#201). resetGatewaySession=agent skill_sessions 유지.)
				await resetGatewaySession("agent:main:main");
				if (config) {
					saveConfig({ ...config, discordSessionMigrated: true });
				}
				Logger.info(
					"ChatArea",
					"One-time reset: cleared Discord-contaminated main session",
				);
			} else {
				Logger.info("ChatArea", "Skipped legacy Gateway history hydration", {
					reason: "agent-local-transcript-is-authoritative",
				});
			}
		};

		loadSession().catch((err) => {
			Logger.warn("ChatArea", "Failed to load session", {
				error: String(err),
			});
		});

		// Auto-discover Discord DM channel ID from Gateway sessions
		// (skip on migration run — no new sessions exist yet)
		if (loadConfig()?.discordSessionMigrated) {
			discoverAndPersistDiscordDmChannel().catch(() => {});
		}

		// (startup gateway sync 제거됨 2026-06-12 — gateway.json 미사용 죽은 경로. config=naia-settings.)

	}, []);

	useEffect(() => {
		messagesEndRef.current?.scrollIntoView?.({ behavior: "smooth" });
	}, [messages, streamingContent]);

	// VN (home) is a focused conversation surface with no tab navigation. If we
	// enter VN while a non-chat tab was active (e.g. user left it on History in a
	// panel, then closed the panel), snap back to chat so the input stays visible.
	// Pure UI guard — touches no voice/session state.
	useEffect(() => {
		if (variant === "vn" && activeTab !== "chat") setActiveTab("chat");
	}, [variant, activeTab]);

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
				Logger.warn("ChatArea", "Failed to cancel stream", {
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

	// Receive "Ask AI" requests from NaiaMetaArea (Skills, Channels tabs)
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
		// Mid-session language switch: Settings dispatches "naia:locale-change" when
		// the UI language changes. If a voice session is live, pin the new STT
		// recognition language now (no reconnect). Otherwise no-op; the next connect
		// reads the language from getLocale() in the session config.
		const onLocale = (e: Event) => {
			const loc = (e as CustomEvent<string | null>).detail ?? null;
			voiceSessionRef.current?.setLanguage?.(loc);
		};
		window.addEventListener("naia:voice-ref-url", onUrl);
		window.addEventListener("naia:voice-ref-audio", onB64);
		window.addEventListener("naia:locale-change", onLocale);
		return () => {
			window.removeEventListener("naia:voice-ref-url", onUrl);
			window.removeEventListener("naia:voice-ref-audio", onB64);
			window.removeEventListener("naia:locale-change", onLocale);
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
		// Cancel in-flight TTS fetch/WS so a barge-in stops paid synthesis (#363).
		for (const ac of ttsAbortControllersRef.current.values()) ac.abort();
		ttsAbortControllersRef.current.clear();
		if (typeof window !== "undefined" && "speechSynthesis" in window) {
			try {
				window.speechSynthesis.cancel();
			} catch {
				// best-effort — some webviews throw if no utterance is active
			}
		}
		// cascade 토킹 아바타 활성 시 발화 스트림도 중단(barge-in) — 오버레이 즉시 종료.
		useCascadeAvatarStore.getState().renderer?.interrupt();
		ttsPlayingRef.current = false;
		setTtsPlaying(false);
		useAvatarStore.getState().setSpeaking(false);
	}

	function initializeSpeechTts(config: AppConfig): void {
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
		pipelineVoiceConfigRef.current = {
			voice: resolveTtsVoiceId(config),
			ttsProvider: config.ttsProvider || "edge",
			ttsApiKey:
				config.ttsProvider === "google"
					? config.googleApiKey || config.apiKey
					: config.ttsProvider === "openai"
						? config.openaiTtsApiKey
						: config.ttsProvider === "elevenlabs"
							? config.elevenlabsApiKey
							: undefined,
			naiaKey: config.naiaKey,
			gatewayUrl: LAB_GATEWAY_URL,
			vllmHost: config.vllmHost ?? DEFAULT_VLLM_HOST,
			vllmTtsHost: config.vllmTtsHost,
		};
	}

	// Configure the explicitly persisted opt-in profile and consume its
	// request-independent activity stream. Ordinary chat listeners deliberately
	// ignore these events because their requestId is not the active turn.
	useEffect(() => {
		let disposed = false;
		let unlisten: (() => void) | undefined;
		void loadConfigWithSecrets().then((config) => {
			if (!config || disposed) return;
			void configureSpeechProfile(toSpeechProfileCommandInput(
				normalizeProactiveSpeechSettings({
				profile: config.proactiveSpeechProfile ?? "disabled",
				idleMs: config.proactiveSpeechIdleMs,
				intervalMs: config.proactiveSpeechIntervalMs,
				timezone: config.proactiveSpeechTimezone ?? "UTC",
				bgmAutoPlay: config.proactiveSpeechBgmAutoPlay,
				weatherConsented: config.proactiveSpeechWeatherConsented,
				weatherLatitude: config.proactiveSpeechWeatherLatitude,
				weatherLongitude: config.proactiveSpeechWeatherLongitude,
				knowledgeScope: config.proactiveSpeechKnowledgeScope,
				}),
			));
		});
		const retireActiveSpeech = () => {
			acceptSpeechActivitiesRef.current = false;
			interruptTts();
			const active = activeSpeechActivityRef.current;
			if (active) retiredSpeechActivityIdsRef.current.add(active.activityId);
			activeSpeechActivityRef.current = null;
		};
		window.addEventListener(
			"naia-proactive-profile-changing",
			retireActiveSpeech,
		);
		const acceptConfiguredProfile = (event: Event) => {
			const detail = (event as CustomEvent<{
				ok?: boolean;
				subscriptionEpoch?: number;
			}>).detail;
			const epoch = Number(detail?.subscriptionEpoch);
			if (detail?.ok === true && Number.isSafeInteger(epoch) && epoch >= 0) {
				speechActivitySubscriptionEpochRef.current = epoch;
				acceptSpeechActivitiesRef.current = true;
			}
		};
		window.addEventListener(
			"naia-proactive-profile-configured",
			acceptConfiguredProfile,
		);
		void listen<string>("agent_response", (event) => {
			let chunk: Record<string, unknown>;
			try {
				const raw = typeof event.payload === "string" ? event.payload : JSON.stringify(event.payload);
				chunk = JSON.parse(raw) as Record<string, unknown>;
			} catch {
				return;
			}
			if (typeof chunk.activityId !== "string") return;
			if (!["panel_tool_call", "text", "finish", "error"].includes(String(chunk.type))) {
				return;
			}
			const activityId = chunk.activityId;
			const subscriptionEpoch = Number(chunk.subscriptionEpoch ?? 0);
			const profileGeneration = Number(chunk.profileGeneration ?? 0);
			const active = activeSpeechActivityRef.current;
			if (!acceptSpeechActivitiesRef.current) return;
			if (subscriptionEpoch !== speechActivitySubscriptionEpochRef.current) return;
			if (retiredSpeechActivityIdsRef.current.has(activityId)) return;
			if (
				active
				&& profileGeneration < active.profileGeneration
			) return;
			if (active && active.activityId !== activityId) {
				retiredSpeechActivityIdsRef.current.add(active.activityId);
				if (retiredSpeechActivityIdsRef.current.size > 100) {
					const oldest = retiredSpeechActivityIdsRef.current.values().next().value;
					if (oldest) retiredSpeechActivityIdsRef.current.delete(oldest);
				}
			}
			activeSpeechActivityRef.current = { activityId, profileGeneration };
			// A direct Live/omni model would answer visitor audio outside the
			// exhibition KB/privacy path. Proactive profiles therefore own the
			// voice lane; pipeline STT remains available for grounded questions.
			if (!pipelineActiveRef.current && voiceSessionRef.current) {
				voiceCancelledRef.current = true;
				audioPlayerRef.current?.clear();
				micStreamRef.current?.stop();
				voiceSessionRef.current.disconnect();
			}

			if (
				chunk.type === "panel_tool_call"
				&& typeof chunk.requestId === "string"
				&& typeof chunk.toolCallId === "string"
				&& typeof chunk.toolName === "string"
			) {
				dispatchPanelToolCall({
					requestId: chunk.requestId,
					toolCallId: chunk.toolCallId,
					toolName: chunk.toolName,
					args: (chunk.args as Record<string, unknown>) ?? {},
					activityId,
				});
				return;
			}
			if (chunk.type === "text" && typeof chunk.text === "string" && chunk.text.trim()) {
				// DJ keeps its activity alive when a normal chat cannot yield it.
				// Never let proactive text reset/share the ordinary chat TTS lane.
				if (currentRequestId.current) return;
				const text = chunk.text.trim();
					useChatStore.getState().addMessage({ role: "assistant", content: text });
					void loadConfigWithSecrets().then((config) => {
						if (!config) return;
						if (!canSpeakProactiveText({
						currentRequestId: currentRequestId.current,
						activeActivityId: activeSpeechActivityRef.current?.activityId,
						eventActivityId: activityId,
							ttsEnabled: config.ttsEnabled === true,
					})) return;
					initializeSpeechTts(config);
					const chunker = sentenceChunkerRef.current;
					if (!chunker) return;
					const sentences = chunker.feed(text);
					const remaining = chunker.flush();
					for (const sentence of sentences) sendSentenceToTts(sentence);
					if (remaining) sendSentenceToTts(remaining);
				});
				return;
			}
			if (chunk.type === "finish" || chunk.type === "error") {
				if (activeSpeechActivityRef.current?.activityId === activityId) {
					retiredSpeechActivityIdsRef.current.add(activityId);
					activeSpeechActivityRef.current = null;
				}
			}
		}).then((off) => {
			if (disposed) off();
			else unlisten = off;
		});
		return () => {
			disposed = true;
			unlisten?.();
			window.removeEventListener(
				"naia-proactive-profile-changing",
				retireActiveSpeech,
			);
			window.removeEventListener(
				"naia-proactive-profile-configured",
				acceptConfiguredProfile,
			);
		};
	}, []);

	async function handleNewConversation() {
		const store = useChatStore.getState();
		// Stop any TTS still reading the previous conversation.
		interruptTts();
		// Re-arm the local-voice-unavailable notice per conversation (chat mode has
		// no pipeline-start reset) so it surfaces once per conversation, not once
		// per app session — parity with the pipeline path's reset.
		localVoiceUnavailableNoticedRef.current = false;
		store.newConversation();

		// Reset Gateway session and set local session ID
		try {
			await resetGatewaySession();
			useChatStore.getState().setSessionId("agent:main:main");
			Logger.info("ChatArea", "New conversation started via Gateway");
		} catch (err) {
			Logger.warn("ChatArea", "Failed to reset Gateway session", {
				error: String(err),
			});
		}
	}

	async function handleSend(overrideText?: string) {
		const text = (overrideText ?? input).trim();
		if (!text) return;
		if (isDiscordConnectionIntent(text)) {
			setInput("");
			useChatStore.getState().addMessage({
				role: "assistant",
				content: t("chat.discordConnectionSecretGuide"),
			});
			setShowDiscordConnectionGuide(true);
			return;
		}
		if (await handleSpeechProfilePhrase(text)) return;

		// Record in input history (deduplicate consecutive duplicates, FIFO max 50)
		const hist = inputHistoryRef.current;
		if (hist.length === 0 || hist[hist.length - 1] !== text) {
			if (hist.length >= 50) hist.shift();
			hist.push(text);
		}
		historyIndexRef.current = -1;
		historyDraftRef.current = "";

		// Preserve the user text, not a single-use yield token, while another
		// ordinary turn owns the stream. The queued retry will yield when it can
		// immediately send the profile-bound question.
		if (shouldQueueBeforeSpeechYield(isChatRequestActive())) {
			useChatStore.getState().enqueueMessage(text);
			setInput("");
			return;
		}

		let activityResume: SpeechActivityResume | undefined;
		const speechActivity = activeSpeechActivityRef.current;
		if (speechActivity) {
			// This runs before both Live text and ordinary chat routing. A
			// successful exhibition binding must never be handed to the Live LLM.
			interruptTts();
			activityResume = await yieldSpeechActivity(speechActivity.activityId);
			if (activeSpeechActivityRef.current?.activityId === speechActivity.activityId) {
				activeSpeechActivityRef.current = null;
			}
		}

		// Omni voice mode: send text via the open Live session so a typed
		// message gets the SAME treatment as spoken input (Naia answers in
		// voice). Mirror it into the transcript too — otherwise the user's own
		// line never appears on screen.
		if (
			voiceMode === "active" &&
			!activityResume &&
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
		// 새 core 는 에이전트가 GLM 키를 쥐므로 nextain 로그인 게이트 우회(naiaKey 없어도 전송).
		if (!isNewCore() && config?.provider === "nextain" && !config?.naiaKey) {
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
		// omni-voice(naia-*-omni-*) 모델은 항상 /v1/realtime WS 로 직행(음성 = 후속 UC2 경로) — 새 core 여부와 무관.
		// 텍스트 채팅을 새 core(os core → stdio agent → GLM)로 보내려면 *텍스트 모델*을 선택해야 한다(= UC12
		// 모델셋팅 슬라이스). 여기에 !isNewCore() 가드를 걸면 omni 모델 텍스트가 새 core 로 잘못 흘러
		// uc1-new-core "omni → realtime 우회" 계약을 깬다(라이브 검증서 회귀로 적발, 2026-06-12).
		if (
			config?.provider === "nextain" &&
			config?.model &&
			isOmniModel(config.provider, config.model)
		) {
			useChatStore.getState().finishStreaming();
			completeCurrentRequest(requestId);
			await handleVoiceToggle();
			voiceSessionRef.current?.sendText(text);
			return;
		}
		// 새 core 는 에이전트가 provider/key(GLM_KEY env) 를 쥐므로 UI 키 게이트 우회(없어도 전송).
		if (
			!isNewCore() &&
			!isApiKeyOptional(config?.provider ?? "") &&
			!config?.apiKey &&
			!config?.naiaKey
		) {
			useChatStore.getState().appendStreamChunk(t("chat.noApiKey"));
			useChatStore.getState().finishStreaming();
			completeCurrentRequest(requestId);
			return;
		}
		// config 없음 = 설정/온보딩 전 신규 유저. 새 core 라도 다운스트림(provider/model/tts)이 config 필드를
		// 요구하므로 여기서 안전 종료(우회 시 null 참조). 신규 유저의 config 생성 = 온보딩/모델셋팅 슬라이스 범위.
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
			initializeSpeechTts(config);
		}

		const memoryCtx = await buildMemoryContext();
		Logger.info("ChatArea", "handleSend → sendChatMessage", {
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
			Logger.warn("ChatArea", "Model not valid for provider — using default", {
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
					ollamaNumGpu:
						activeProvider === "ollama" ? config.ollamaNumGpu : undefined,
					vllmHost: activeProvider === "vllm" ? config.vllmHost : undefined,
				},
				history: history.slice(0, -1),
				onChunk: (chunk) => handleChunk(chunk, activeProvider),
				requestId,
				// A validated exhibition resume is bound to the proactive profile
				// session, not the conversation's rotating local transcript ID.
				// Sending the latter would miss handleProfileChat and leak the
				// question into ordinary memory/transcript persistence.
				sessionId: resolveSpeechProfileSession(
					useChatStore.getState().localSessionId,
					activityResume,
				),
				// TTS handled by Shell — don't send TTS params to agent.
				// S4 (두벌 제거 + 음성 persona 회귀 닫기): the shell no longer bakes persona/
				// locale/honorific/speechStyle into a raw systemPrompt — the core assembles
				// those from config.json itself. The shell sends ONLY its environment-specific
				// context via `environmentSegments`. The voice-pipeline turn (STT→chat→TTS)
				// goes through the core too, so it must NOT send a raw systemPrompt override
				// (that would replace the whole core assembly and drop the Alpha persona from
				// spoken replies). Instead it adds a `responseStyle: "brief"` segment — the
				// core owns the brevity wording and appends it AFTER persona+workspace, so the
				// avatar speaks as Alpha *and* keeps voice answers short. The proactive
				// tool-narration capability is carried structurally by `enableTools`
				// (passed below); the voice path no longer needs a free-text directive.
				environmentSegments: buildEnvironmentSegments(
					memoryCtx,
					pipelineActiveRef.current ? "brief" : "normal",
				),
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
				activityResume,
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

	async function handleSpeechProfilePhrase(text: string): Promise<boolean> {
		const command = parseSpeechProfileCommand(text);
		if (!command) return false;
		if (command.kind === "configure") {
			const { profile } = command;
			const config = await loadConfig();
			interruptTts();
			window.dispatchEvent(
				new CustomEvent("naia-proactive-profile-changing"),
			);
			if (activeSpeechActivityRef.current) {
				retiredSpeechActivityIdsRef.current.add(
					activeSpeechActivityRef.current.activityId,
				);
			}
			activeSpeechActivityRef.current = null;
			const disabled = await configureSpeechProfile({
				profile: "disabled",
				timezone: config?.proactiveSpeechTimezone ?? "UTC",
				weatherConsented: false,
			});
			const configured = disabled && (
				profile === "disabled"
				|| await configureSpeechProfile(toSpeechProfileCommandInput(
				normalizeProactiveSpeechSettings({
				profile,
				idleMs:
					config?.proactiveSpeechIdleMs
					?? (profile === "personal_radio_dj" ? 5_000 : 1_000),
				intervalMs: config?.proactiveSpeechIntervalMs,
				timezone: config?.proactiveSpeechTimezone ?? "UTC",
				bgmAutoPlay:
					profile === "personal_radio_dj"
						? true
						: config?.proactiveSpeechBgmAutoPlay,
				weatherConsented: config?.proactiveSpeechWeatherConsented,
				weatherLatitude: config?.proactiveSpeechWeatherLatitude,
				weatherLongitude: config?.proactiveSpeechWeatherLongitude,
					knowledgeScope: config?.proactiveSpeechKnowledgeScope,
				}),
				))
			);
			if (!configured) {
				useChatStore.getState().addMessage({
					role: "assistant",
					content: t("settings.proactiveSaveError"),
				});
				setInput("");
				return true;
			}
			if (config) {
				saveConfig({
					...config,
					proactiveSpeechProfile: profile,
					...(profile !== "disabled" && config.proactiveSpeechIdleMs == null
						? { proactiveSpeechIdleMs: profile === "personal_radio_dj" ? 5_000 : 1_000 }
						: {}),
					...(profile === "personal_radio_dj"
						? { proactiveSpeechBgmAutoPlay: true }
						: {}),
				});
			}
			setInput("");
			useChatStore.getState().addMessage({ role: "user", content: text });
			return true;
		}

		const activity = activeSpeechActivityRef.current;
		if (!activity) return false;
		const { action } = command;
		interruptTts();
		await controlSpeechActivity(action, activity.activityId);
		if (action === "stop") {
			retiredSpeechActivityIdsRef.current.add(activity.activityId);
			activeSpeechActivityRef.current = null;
		}
		setInput("");
		useChatStore.getState().addMessage({ role: "user", content: text });
		return true;
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
		activityId?: string;
	}) {
		// UC8 BGM (FR-BGM.1): BgmPlayer 는 위젯(앱 아님)이라 appRegistry 소유자
		// 탐색으로 못 찾는다 — 전용 분기. executeBgmSkill 이 위젯이 이미 듣는
		// bgm_youtube_* 이벤트를 발사(위젯 무변경). 음성 경로도 이 dispatch 공유.
		if (req.toolName === SKILL_YOUTUBE_BGM.name) {
			executeBgmSkill(req.args)
				.then((result) => {
					Logger.info("ChatArea", "bgm skill result", { result });
					return sendPanelToolResult(req.requestId, req.toolCallId, result, true, req.activityId);
				})
				.catch((err) => {
					Logger.warn("ChatArea", "bgm skill error", { error: String(err) });
					return sendPanelToolResult(
						req.requestId,
						req.toolCallId,
						String(err),
						false,
						req.activityId,
					);
				});
			return;
		}
		const ownerPanel = appRegistry
			.list()
			.find((p) => p.tools?.some((t) => t.name === req.toolName));
		// Tool-level auto panel switch (user request): if the tool belongs to a
		// panel that isn't currently active, bring it forward before running.
		if (ownerPanel && useAppStore.getState().activeApp !== ownerPanel.id) {
			useAppStore.getState().setActiveApp(ownerPanel.id);
			Logger.info("ChatArea", "panel auto-switch for tool", {
				tool: req.toolName,
				app: ownerPanel.id,
			});
		}
		const bridge = ownerPanel ? getBridgeForPanel(ownerPanel.id) : activeBridge;
		Logger.info("ChatArea", "panel_tool_call dispatch", {
			tool: req.toolName,
			owner: ownerPanel?.id ?? "(none→activeBridge)",
		});
		bridge
			.callTool(req.toolName, req.args)
			.then((result) => {
				Logger.info("ChatArea", "panel_tool_call result", {
					tool: req.toolName,
					result: result.slice(0, 120),
				});
				return sendPanelToolResult(req.requestId, req.toolCallId, result, true, req.activityId);
			})
			.catch((err) => {
				Logger.warn("ChatArea", "panel_tool_call error", {
					tool: req.toolName,
					error: String(err),
				});
				return sendPanelToolResult(
					req.requestId,
					req.toolCallId,
					String(err),
					false,
					req.activityId,
				);
			});
	}

	function dispatchPanelControl(req: { action: string; appId?: string }) {
		const { setActiveApp } = useAppStore.getState();
		if (req.action === "switch" && req.appId) {
			setActiveApp(req.appId);
		} else if (req.action === "reload") {
			import("../lib/app-loader").then(({ loadInstalledApps }) => {
				loadInstalledApps().catch(() => {});
			});
		}
	}

	function handleChunk(chunk: AgentResponseChunk, activeProvider: ProviderId) {
		const store = useChatStore.getState();

		if ("requestId" in chunk && chunk.requestId !== currentRequestId.current) {
			Logger.info("ChatArea", "Ignoring chunk for inactive request", {
				type: chunk.type,
				requestId: chunk.requestId,
				activeRequestId: currentRequestId.current,
			});
			return;
		}

		// text 청크는 스트리밍마다 와서 INFO 로 찍으면 응답 1회에 수십~수백 줄 홍수(루크 #2) → debug 로(평상시
		// 게이트). finish/usage 는 턴당 1회뿐(=예외)이라 info 유지. 턴 집계는 finish 시 별도(아래).
		if (chunk.type === "text") {
			Logger.debug("ChatArea", "handleChunk text", {
				textLen: chunk.text.length,
				pipelineActive: pipelineActiveRef.current,
				hasChunker: !!sentenceChunkerRef.current,
			});
		} else if (chunk.type === "finish" || chunk.type === "usage") {
			Logger.info("ChatArea", "handleChunk", {
				type: chunk.type,
				pipelineActive: pipelineActiveRef.current,
				hasChunker: !!sentenceChunkerRef.current,
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
						Logger.info("ChatArea", "SentenceChunker produced sentences", {
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
					activityId: chunk.activityId,
				});
				break;
			}
			case "panel_control": {
				dispatchPanelControl({
					action: chunk.action,
					appId: chunk.appId,
				});
				break;
			}
			case "app_install_result": {
				// Handled by AppInstallDialog's direct listener — no-op here
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
						Logger.info("ChatArea", "SentenceChunker flush on finish", {
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
							"ChatArea",
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
			case "compacted":
				// UC-compaction: 예산 압박 요약 발생 → 사용자 알림.
				setCompactionNotice(chunk.droppedCount);
				break;
			case "grounding":
			case "artifact":
			case "provider_session":
			case "processing_disclosure":
				store.appendStreamChunk(formatStructuredAgentChunk(chunk));
				break;
			case "discord_message":
				// Discord DM messages are shown in the dedicated Channels tab.
				// Ignore them here to keep the main chat clean.
				break;
			case "error":
				Logger.warn("ChatArea", "Agent error chunk", {
					message: chunk.message,
				});
				// Pipeline voice: flush remaining text to TTS before finishing
				if (pipelineActiveRef.current && sentenceChunkerRef.current) {
					const remaining = sentenceChunkerRef.current.flush();
					if (remaining) {
						Logger.info("ChatArea", "Pipeline voice flush on error", {
							remainingLen: remaining.length,
						});
						sendSentenceToTts(remaining);
					}
				}
				store.appendStreamChunk(`\n[${t("chat.error")}] ${wireErrorMessage(chunk.code, chunk.message)}`);
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

	/** Synthesize one sentence shell-side (#363) and enqueue/play the audio. */
	function sendSentenceToTts(sentence: string): void {
		// Strip emotion tags and emoji before TTS
		const clean = sentence
			.replace(/\[(?:HAPPY|SAD|ANGRY|SURPRISED|NEUTRAL|THINK)]\s*/gi, "")
			.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "")
			.trim();
		if (!clean) return;

		// cascade 토킹 아바타 활성 시: 셸이 합성한 TTS 오디오를 cascade /stream 으로 보내 Ditto
		// 립싱크를 구동한다(8GB avatar-only facade 엔 TTS 가 없어 텍스트 /stream_text 는 무음).
		// nextain = LINEAR16(PCM 24k) 로 받아 speakAudio; 브라우저/미합성 provider 는 아래에서
		// facade 내장 TTS(/stream_text) 로 폴백. (라우팅은 합성 결과가 나온 뒤 아래에서 수행.)
		const cascadeAvatar = useCascadeAvatarStore.getState().renderer;
		const configuredCascadeUrl = remoteCascadeUrlFromConfig(loadConfig());
		if (cascadeAvatar && configuredCascadeUrl) {
			// An explicit NVA Host owns TTS and avatar rendering. This keeps the proven
			// remote cascade independent from a failed or stale local voice facade.
			void cascadeAvatar.speak(clean);
			return;
		}

		// 자기발화 텍스트 필터용 — 이 턴에 말한 문장을 기록 (최근 6문장 링버퍼).
		recentTtsTextsRef.current.push(clean);
		if (recentTtsTextsRef.current.length > 6) recentTtsTextsRef.current.shift();

		const reqId = generateRequestId();
		// Reserve sequence number BEFORE async request to guarantee order
		const seq = audioQueueRef.current?.reserveSeq() ?? 0;
		activeTtsRequestsRef.current.add(reqId);
		const voiceCfg = pipelineVoiceConfigRef.current;
		const ttsProviderForCost = voiceCfg?.ttsProvider ?? "edge";
		// 아바타 립싱크에 합성 오디오(WAV/PCM)를 직접 흘릴 수 있는 provider 인가 (FR-VOICE.5).
		// naia-local-voice 포함(2026-07-15 개정): 구 "추가 금지" 경고는 raw /tts 직결(음색 상태
		// 우회 → 무지문 랜덤 음색) 전제였는데, synthesize.ts 가 OpenAI 표면 /v1/audio/speech 로
		// 전환되며 음색이 **합성 시점에 서버에서 해석**되어 사유가 소멸했다. 오히려 8g avatar-only
		// 파사드(자체 TTS 없음)에선 /stream_text 폴백이 무음이라 PCM 직결이 유일한 립싱크 경로.
		const avatarPcm = !!cascadeAvatar && streamsAvatarPcm(ttsProviderForCost);
		const ttsVoiceForCost = voiceCfg?.voice;
		Logger.info("ChatArea", "Sending TTS request", {
			reqId,
			seq,
			sentence: clean.slice(0, 50),
			provider: ttsProviderForCost,
		});

		// Speak via the browser's built-in speechSynthesis (free, client-side).
		// Manages the avatar speaking state + clears the request on end/error.
		const speakViaBrowser = (): void => {
			if (typeof window !== "undefined" && "speechSynthesis" in window) {
				const utter = new SpeechSynthesisUtterance(clean);
				utter.lang =
					voiceCfg?.voice || document.documentElement.lang || "ko-KR";
				utter.onstart = () => useAvatarStore.getState().setSpeaking(true);
				utter.onend = () => {
					useAvatarStore.getState().setSpeaking(false);
					activeTtsRequestsRef.current.delete(reqId);
				};
				// onerror too, else a failure after onstart leaves the avatar stuck
				// in the speaking state (#363 review).
				utter.onerror = () => {
					useAvatarStore.getState().setSpeaking(false);
					activeTtsRequestsRef.current.delete(reqId);
				};
				window.speechSynthesis.speak(utter);
			} else {
				Logger.warn("ChatArea", "Browser TTS not available");
				activeTtsRequestsRef.current.delete(reqId);
			}
		};

		// Browser provider → client-side speechSynthesis (skip shell synthesis).
		const ttsMeta = getTtsProviderMeta(ttsProviderForCost);
		if (ttsMeta?.isClientSide) {
			// 브라우저 TTS 는 버퍼가 없음 → 아바타면 facade 텍스트 경로, 아니면 브라우저 발화.
			if (cascadeAvatar) void cascadeAvatar.speak(clean);
			else speakViaBrowser();
			return;
		}

		// Shell-direct synthesis (#363): the new-core agent has no TTS, so every
		// non-browser provider is synthesized here (gateway / direct API / edge WS)
		// instead of via the dropped `tts_request` IPC. The AbortController lets
		// interrupt/cleanup cancel the in-flight fetch/WS (and stop paid TTS).
		const abort = new AbortController();
		ttsAbortControllersRef.current.set(reqId, abort);
		synthesizeTts({
			text: clean,
			voice: voiceCfg?.voice,
			encoding: avatarPcm ? "LINEAR16" : undefined,
			provider: ttsProviderForCost as TtsProviderId,
			apiKey: voiceCfg?.ttsApiKey,
			naiaKey: voiceCfg?.naiaKey,
			gatewayUrl: voiceCfg?.gatewayUrl,
			vllmHost: voiceCfg?.vllmHost,
			vllmTtsHost: voiceCfg?.vllmTtsHost,
			signal: abort.signal,
		})
			.then(({ audioBase64, costUsd }) => {
				// Drop stale audio AND skip billing for a superseded/aborted turn:
				// interruptTts() cleared activeTtsRequestsRef and reset the AudioQueue
				// sequence, so a late response must NOT enqueue (would replay as the
				// new turn's first audio) nor record cost.
				if (!activeTtsRequestsRef.current.has(reqId)) return;
				activeTtsRequestsRef.current.delete(reqId);
				if (avatarPcm) {
					// Keep voice playback independent from remote rendering. The remote video
					// follows muted, so a media event or render failure can never cause silence.
					audioQueueRef.current?.enqueueOrdered(seq, audioBase64);
					void cascadeAvatar?.speakAudio(audioBase64, 24000, { muted: true });
				} else if (cascadeAvatar) {
					// nextain 외 아바타: facade 내장 TTS 경로(best-effort, full cascade 전제).
					void cascadeAvatar.speak(clean);
				} else {
					audioQueueRef.current?.enqueueOrdered(seq, audioBase64);
				}
				// Track TTS cost: server cost for Naia Cloud, estimate for others.
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
			})
			.catch((err) => {
				// Superseded / aborted turn (interrupt cleared the set) — don't fall
				// back or bill; the queue was already reset.
				if (!activeTtsRequestsRef.current.has(reqId)) return;
				// Release the reserved ordered slot so later sentences don't stall
				// behind this seq (enqueueOrdered waits for contiguous sequence nums).
				audioQueueRef.current?.skipOrdered(seq);
				// LOCAL voice engines (naia-local-voice / vllm): the user explicitly
				// chose a local engine. Do NOT substitute the browser's free TTS —
				// that masquerade is exactly the "free voice" surprise the user
				// flagged. Surface a clear one-time notice and stay silent; the local
				// voice engine must be running and reachable at vllmTtsHost (Round-2
				// embedding). Cloud providers keep the free fallback below.
				const isLocalVoiceProvider =
					ttsProviderForCost === "naia-local-voice" ||
					ttsProviderForCost === "vllm";
				if (isLocalVoiceProvider) {
					Logger.warn(
						"ChatArea",
						"Local voice engine unavailable — no free fallback",
						{ reqId, provider: ttsProviderForCost, error: String(err) },
					);
					if (!localVoiceUnavailableNoticedRef.current) {
						localVoiceUnavailableNoticedRef.current = true;
						useChatStore.getState().addMessage({
							role: "assistant",
							content: t("chat.localVoiceUnavailable"),
						});
					}
					activeTtsRequestsRef.current.delete(reqId);
					return;
				}
				// Cloud synthesis failed (missing key/login, network, quota). Fall
				// back to the browser's built-in TTS so the voice is never silently
				// dropped — better a basic voice than nothing.
				Logger.warn("ChatArea", "TTS synthesis failed — browser TTS fallback", {
					reqId,
					provider: ttsProviderForCost,
					error: String(err),
				});
				speakViaBrowser();
			})
			.finally(() => {
				ttsAbortControllersRef.current.delete(reqId);
			});
	}

	/** Clean up pipeline voice resources. */
	function cleanupPipeline(): void {
		pipelineActiveRef.current = false;
		// 자기발화 방어 훅/기록 해제 (세션 밖 재개 방지 + 다음 세션 오탐 방지).
		sttPauseRef.current = null;
		sttResumeRef.current = null;
		recentTtsTextsRef.current = [];
		audioQueueRef.current?.destroy();
		audioQueueRef.current = null;
		sentenceChunkerRef.current?.clear();
		sentenceChunkerRef.current = null;
		pipelineVoiceConfigRef.current = null;
		activeTtsRequestsRef.current.clear();
		for (const ac of ttsAbortControllersRef.current.values()) ac.abort();
		ttsAbortControllersRef.current.clear();
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
			Logger.info("ChatArea", "Barge-in via button: stopping TTS");
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
			if (shouldBlockDirectLiveForSpeechActivity(
				activeSpeechActivityRef.current != null,
				isOmni,
			)) {
				// Direct Live audio cannot carry the single-use exhibition
				// activityResume binding. Do not allow an ungrounded parallel lane.
				setVoiceStatus({ phase: "idle" });
				lastVoiceStatusRef.current = { phase: "idle" };
				return;
			}
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
						// ★재개 타이머 취소(2026-07-15 리뷰): 문장별 합성 지연으로 큐가 잠깐 비면
						// onPlaybackEnd 가 800ms 재개 타이머를 건다. 다음 문장이 그 전에 도착해
						// 재생을 시작해도 타이머는 살아 있어 재생 중 마이크를 재개통 → 자기발화 누수.
						// 재생이 (다시) 시작되면 대기 중 재개를 반드시 취소한다.
						if (sttCooldownTimerRef.current) {
							clearTimeout(sttCooldownTimerRef.current);
							sttCooldownTimerRef.current = null;
						}
						// ★자기발화 1차 방어(2026-07-15 루크 "발화 때 마이크 죽이기"):
						// 재생 중엔 마이크(인식 세션)를 정지해 캡처 자체를 차단한다. 결과-도착 게이트
						// (ttsPlayingRef)만으로는 web-speech 연속 인식이 재생 중 캡처한 오디오를
						// 게이트 해제 후 늦게 배달하는 누수를 못 막는다(실증). barge-in 은 버튼식이라 안전.
						try {
							sttPauseRef.current?.();
						} catch {
							/* 마이크 정지 실패 = 비치명 (2차 텍스트 필터가 방어) */
						}
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
							// 쿨다운 종료 후 마이크 재개 (세션이 살아있을 때만).
							if (pipelineActiveRef.current) {
								try {
									sttResumeRef.current?.();
								} catch {
									/* 재개 실패 = 다음 발화 토글로 복구 가능 */
								}
							}
						}, 800);
					},
				});
				audioQueueRef.current = queue;
				sentenceChunkerRef.current = new SentenceChunker();
				pipelineActiveRef.current = true;
				// Re-arm the local-voice-unavailable notice for this new session.
				localVoiceUnavailableNoticedRef.current = false;
				pipelineVoiceConfigRef.current = {
					voice: resolveTtsVoiceId(config) ?? config.voice,
					ttsProvider: config.ttsProvider || "edge",
					ttsApiKey:
						config.ttsProvider === "google"
							? config.googleApiKey || config.apiKey
							: config.ttsProvider === "openai"
								? config.openaiTtsApiKey
								: config.ttsProvider === "elevenlabs"
									? config.elevenlabsApiKey
									: undefined,
					// nextain (gateway credit) + vllm (local) creds — #363.
					naiaKey: config.naiaKey,
					gatewayUrl: LAB_GATEWAY_URL,
					vllmHost: config.vllmHost ?? DEFAULT_VLLM_HOST,
					vllmTtsHost: config.vllmTtsHost,
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
						Logger.info("ChatArea", "STT result", {
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
								"ChatArea",
								"STT result suppressed (TTS playing/cooldown)",
							);
							return;
						}

						// 자기발화 2차 방어(2026-07-15 루크 "일정 이상 유사도면 스킵"):
						// 최근 나이아 TTS 문장과 유사하면 에코로 보고 버린다 — 재생 중 캡처분이
						// 게이트 해제 후 늦게 배달되는 web-speech 누수를 텍스트로 차단.
						if (
							cleanResult.isFinal &&
							isLikelySelfEcho(
								cleanResult.transcript,
								recentTtsTextsRef.current,
							)
						) {
							Logger.info("ChatArea", "STT result skipped (self-echo)", {
								transcript: cleanResult.transcript.slice(0, 40),
							});
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
											"ChatArea",
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
							Logger.warn("ChatArea", "API STT requires API key", {
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
								Logger.warn("ChatArea", "API STT error", {
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
						// 자기발화 방어: 재생 중 마이크 정지/재개 훅 (API STT 경로).
						sttPauseRef.current = () => void session.stop();
						sttResumeRef.current = () => void session.start();
						await session.start();
						setSttState("listening");
					} else if (isWebBased) {
						// Web Speech API — browser built-in, free, no model download
						const session = createWebSpeechSttSession(sttLang);
						const cleanupResult = session.onResult(handleSttResult);
						sttCleanupRef.current.push(cleanupResult);
						if (session.onError) {
							const cleanupError = session.onError((err) => {
								Logger.warn("ChatArea", "Web Speech STT error", {
									code: err.code,
									message: err.message,
								});
							});
							sttCleanupRef.current.push(cleanupError);
						}
						sttCleanupRef.current.push(() => session.stop());
						// 자기발화 방어: 재생 중 마이크 정지/재개 훅 (세션은 stop→start 재사용 가능 —
						// stop 이 recognition 을 비우고 start 가 재구성한다).
						sttPauseRef.current = () => void session.stop();
						sttResumeRef.current = () => void session.start();
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
							Logger.info("ChatArea", "STT state change", {
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
							Logger.warn("ChatArea", "STT error", {
								code: err.code,
								message: err.message,
							});
						});
						const errorCleanup =
							typeof unlistenError === "function"
								? unlistenError
								: () => unlistenError.unregister();
						sttCleanupRef.current.push(errorCleanup);

						Logger.info("ChatArea", "Starting STT", {
							engine: sttEngine,
							model: config.sttModel,
							language: sttLang,
						});
						const sttStartParams = {
							engine: sttEngine,
							modelId: config.sttModel,
							language: sttLang,
							continuous: true,
							interimResults: true,
						} as Record<string, unknown> & Parameters<typeof sttStart>[0];
						// 자기발화 방어: 재생 중 마이크 정지/재개 훅 (플러그인 STT 경로).
						sttPauseRef.current = () => void sttStop().catch(() => {});
						sttResumeRef.current = () =>
							void sttStart(sttStartParams).catch(() => {});
						await sttStart(sttStartParams);
					}
					Logger.info("ChatArea", "STT started successfully", {
						engine: sttEngine,
						apiMode: isApiBased,
					});
				} catch (sttErr) {
					Logger.warn("ChatArea", "STT start failed", {
						error: String(sttErr),
					});
					setSttState("idle");
					pipelineActiveRef.current = false;
					audioQueueRef.current = null;
					sentenceChunkerRef.current = null;
					setVoiceStatus({ phase: "idle" });
					return;
				}

				Logger.info("ChatArea", "Pipeline voice mode started", {
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
				Logger.info("ChatArea", "Voice mode started notification displayed");
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

			Logger.info("ChatArea", "Voice config", {
				provider: config.provider,
				model: config.model,
				liveProvider,
				hasNaiaKey: !!naiaKey,
				hasGoogleApiKey: !!config.googleApiKey,
				hasOpenaiKey: !!(config.openaiRealtimeApiKey ?? config.apiKey),
			});

			// Validate credentials per provider
			if (liveProvider === "naia" && !naiaKey) {
				Logger.warn("ChatArea", "Naia OS voice requires Naia key");
				useChatStore.getState().addMessage({
					role: "assistant",
					content: t("chat.voiceNeedLabKey"),
				});
				setVoiceStatus({ phase: "idle" });
				return;
			}
			if (liveProvider === "gemini-live" && !naiaKey && !config.googleApiKey) {
				Logger.warn("ChatArea", "Gemini Live requires Google API key");
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
					Logger.warn("ChatArea", "OpenAI Realtime requires API key");
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
			const activeAppId = useAppStore.getState().activeApp;
			const panelTools = activeAppId
				? (appRegistry.get(activeAppId)?.tools ?? [])
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
				Logger.warn("ChatArea", "Failed to fetch agent skills for voice", {
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
			const abortIfSpeechActivityOwnsVoice = () => {
				if (!shouldAbortLiveConnectForSpeechActivity(
					activeSpeechActivityRef.current != null,
				)) return;
				voiceCancelledRef.current = true;
				session.disconnect();
				const error = new Error("speech activity owns the grounded voice lane");
				error.name = "AbortError";
				throw error;
			};

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
			panelContextBridgeRef.current = attachAppContextBridge(session, {
				subscribe: (listener) => useAppStore.subscribe(listener),
				getContext: () => useAppStore.getState().activeAppContext,
			});

			// Create audio player — UC2(V2) graft: isNewCore 시 새 core ExpressionPort(play/clearAudio) 경유.
			// drop-in(AudioPlayer-shape), 호출처(.enqueue/.clear/.destroy/.isPlaying) 무변경. old 경로 비파괴.
			const playerOpts = {
				sampleRate: 24000,
				onPlaybackStart: () => useAvatarStore.getState().setSpeaking(true),
				onPlaybackEnd: () => useAvatarStore.getState().setSpeaking(false),
			};
			const player = isNewCore()
				? makeCoreAudioPlayer(playerOpts)
				: createAudioPlayer(playerOpts);
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
				Logger.warn("ChatArea", "Voice session error", { error: err.message });
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
			abortIfSpeechActivityOwnsVoice();
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
					Logger.warn("ChatArea", "Naia Local requires login (Naia key)");
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
				Logger.info("ChatArea", "naia-omni ref audio resolved", {
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
			// The activity may have started while session.connect() awaited a
			// provider/cold start. Recheck before any microphone can start.
			abortIfSpeechActivityOwnsVoice();

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
				if (!activateMicUnlessSpeechActivityOwnsVoice(
					mic,
					activeSpeechActivityRef.current != null,
					voiceCancelledRef.current,
				)) {
					const error = new Error("speech activity owns the grounded voice lane");
					error.name = "AbortError";
					throw error;
				}
				micStreamRef.current = mic;
			} catch (micErr) {
				if (micErr instanceof Error && micErr.name === "AbortError") {
					throw micErr;
				}
				// No usable microphone → keep the session alive for typed input +
				// voice output (web-demo parity). Do not rethrow / disconnect.
				Logger.warn(
					"ChatArea",
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
			Logger.info("ChatArea", "Voice conversation started", {
				provider: liveProvider,
			});
		} catch (err) {
			const cancelled =
				voiceCancelledRef.current ||
				(err instanceof Error && err.name === "AbortError");
			const errStr = String(err);
			Logger.warn("ChatArea", "Voice connection failed", {
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
					Logger.warn("ChatArea", "Failed to load progress data", {
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
			<div className={`chat-panel chat-panel--${variant}`}>
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
				{activeTab === "progress" && <WorkProgressArea />}

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
					<ChannelsTab />
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

				{compactionNotice !== null && activeTab === "chat" && (
					<div
						className="chat-compaction-notice"
						data-testid="compaction-notice"
					>
						<span>
							🗜 {t("chat.summarized")}
							{compactionNotice > 0 ? ` (${compactionNotice})` : ""}
						</span>
						<button
							type="button"
							aria-label="dismiss"
							onClick={() => setCompactionNotice(null)}
						>
							×
						</button>
					</div>
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
									useAppStore.getState().setActiveApp("settings");
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
			{showDiscordConnectionGuide && (
				<div className="sync-dialog-overlay">
					<div
						className="sync-dialog-card"
						role="dialog"
						aria-modal="true"
						style={{ maxWidth: 420 }}
					>
						<p style={{ marginBottom: 8, lineHeight: 1.6 }}>
							{t("chat.discordConnectionSecretGuide")}
						</p>
						<p style={{ marginBottom: 16, lineHeight: 1.6 }}>
							{t("settings.connectionsSetupHelp")}
						</p>
						<div className="sync-dialog-actions">
							<button
								type="button"
								className="onboarding-next-btn"
								onClick={() => {
									setShowDiscordConnectionGuide(false);
									useAppStore.getState().setActiveApp("settings");
									window.dispatchEvent(
										new CustomEvent("naia-open-settings", {
											detail: { tab: "connections" },
										}),
									);
									window.setTimeout(() => {
										document
											.querySelector<HTMLButtonElement>(
												'[data-settings-tab="connections"]',
											)
											?.click();
									}, 0);
								}}
							>
								{t("settings.tabConnections")} ·{" "}
								{t("settings.connectionsDiscord")}
							</button>
						</div>
					</div>
				</div>
			)}
		</>
	);
}
