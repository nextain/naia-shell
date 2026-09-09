import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
	Suspense,
	lazy,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import type { ReactNode } from "react";
import {
	type RecognitionResult,
	onError as sttOnError,
	onResult as sttOnResult,
	onStateChange as sttOnStateChange,
	startListening as sttStart,
	stopListening as sttStop,
} from "tauri-plugin-stt-api";
import { activeBridge, getBridgeForApp } from "../lib/active-bridge";
import {
	formatAiInterferencePrompt,
	onAiInterferenceEvent,
} from "../lib/ai-interference";
import { appRegistry } from "../lib/app-registry";
import { writeAppSandboxFile } from "../lib/app-sandbox";
import { type AudioPlayer, createAudioPlayer } from "../lib/audio-player";
import { getDefaultVoiceForAvatar } from "../lib/avatar-presets";
import {
	BGM_APP_ID,
	SKILL_YOUTUBE_BGM,
	executeBgmSkill,
	shouldActivateRadioDj,
} from "../lib/bgm-skill";
import {
	type SpeechActivityResume,
	cancelChat,
	configureSpeechProfile,
	controlSpeechActivity,
	directToolCall,
	fetchAgentSkills,
	isNewCore,
	sendAppSkills,
	sendAppSkillsClear,
	sendAppToolResult,
	sendApprovalResponse,
	sendChatMessage,
	yieldSpeechActivity,
} from "../lib/chat-service";
import {
	type AppConfig,
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
import {
	ENVIRONMENT_APP_ID,
	SKILL_ENVIRONMENT,
	environmentClearNeeded,
	environmentSession,
	environmentToolRegistered,
	executeEnvironmentSkill,
	liveEnvironmentDeps,
	noteEnvironmentClear,
	noteEnvironmentToolAck,
	refreshEnvironment,
} from "../lib/environment-skill";
import {
	discoverAndPersistDiscordDmChannel,
	resetGatewaySession,
} from "../lib/gateway-sessions";
import { getLocale, t } from "../lib/i18n";
import {
	getDefaultLlmModel,
	getLlmModel,
	getLlmProvider,
	isApiKeyOptional,
	isOmniModel,
} from "../lib/llm";
import { ThinkingStreamFilter } from "../lib/llm/thinking-stream-filter";
import { Logger } from "../lib/logger";
import { type MicStream, createMicStream } from "../lib/mic-stream";
import { buildSystemPrompt } from "../lib/persona";
import { effectiveMainRole } from "../lib/slots/model";
import {
	RADIO_DJ_DEFAULT_SETTINGS,
	normalizeProactiveSpeechSettings,
	toSpeechProfileCommandInput,
} from "../lib/proactive-speech-settings";
import {
	SLIDE_PRESENTER_CANCEL_EVENT,
	SLIDE_PRESENTER_SPEAK_EVENT,
	SLIDE_PRESENTER_SPEECH_RESULT_EVENT,
	type SlidePresenterSpeechRequest,
} from "../lib/slide-presenter-events";
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
	createApiSttSession,
	createWebSpeechSttSession,
	getSttProvider,
} from "../lib/stt";
import { estimateSttCost } from "../lib/tts/cost";
import { LocalVoiceScheduler } from "../lib/tts/local-voice-scheduler";
import { decideVoiceTailRelease } from "../lib/tts/reveal-guard";
import {
	type PipelineVoiceConfig,
	type SentenceTtsPipeline,
	type TtsSynthesisResult,
	createSentenceTtsPipeline,
} from "../lib/tts/sentence-pipeline";
import { ttsTextFilter } from "../lib/tts/text-filter";
import type {
	AgentResponseChunk,
	AuditEvent,
	AuditFilter,
	CostEntry,
	ProviderId,
	ToolCall,
} from "../lib/types";
import { makeCoreAudioPlayer } from "../lib/voice-core";
import { AudioQueue } from "../lib/voice/audio-queue";
import {
	decideSttBargeIn,
	isLikelySelfEcho,
	shouldPauseSttForTts,
} from "../lib/voice/echo-gate";
import {
	type AppContextBridge,
	LIVE_PROVIDER_COST_HINTS,
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
import { wireErrorMessage } from "../lib/wire-errors";
import { useAppStore } from "../stores/app";
import { useAvatarStore } from "../stores/avatar";
import { useCascadeAvatarStore } from "../stores/cascade-avatar";
import { useChatStore } from "../stores/chat";
import { useLogsStore } from "../stores/logs";
import { useProgressStore } from "../stores/progress";
import { useSkillsStore } from "../stores/skills";
import type { AtMentionHandle, AtMentionResult } from "./AtMentionPopover";
import { formatStructuredAgentChunk } from "./chat-presentation";
import {
	buildEnvironmentSegments,
	buildMemoryContext,
	nextVoiceSessionKey,
	playBase64Audio,
} from "./chat-runtime-utils";
import {
	naiaLocalVoiceId,
	phaseToMode,
	resolveTtsVoiceId,
	voiceCloseMessage,
	voiceFailureMessage,
} from "./chat-voice-utils";

const AgentsTab = lazy(() =>
	import("./AgentsTab").then(({ AgentsTab }) => ({ default: AgentsTab })),
);
const AtMentionPopover = lazy(() =>
	import("./AtMentionPopover").then(({ AtMentionPopover }) => ({
		default: AtMentionPopover,
	})),
);
const ChannelsTab = lazy(() =>
	import("./ChannelsTab").then(({ ChannelsTab }) => ({ default: ChannelsTab })),
);
const CostDashboard = lazy(() =>
	import("./CostDashboard").then(({ CostDashboard }) => ({
		default: CostDashboard,
	})),
);
const DiagnosticsTab = lazy(() =>
	import("./DiagnosticsTab").then(({ DiagnosticsTab }) => ({
		default: DiagnosticsTab,
	})),
);
const HistoryTab = lazy(() =>
	import("./HistoryTab").then(({ HistoryTab }) => ({ default: HistoryTab })),
);
const SkillsTab = lazy(() =>
	import("./SkillsTab").then(({ SkillsTab }) => ({ default: SkillsTab })),
);
const WorkProgressArea = lazy(() =>
	import("./WorkProgressArea").then(({ WorkProgressArea }) => ({
		default: WorkProgressArea,
	})),
);
const ChatMarkdown = lazy(() =>
	import("./ChatMarkdown").then(({ ChatMarkdown }) => ({
		default: ChatMarkdown,
	})),
);
const PermissionModal = lazy(() =>
	import("./PermissionModal").then(({ PermissionModal }) => ({
		default: PermissionModal,
	})),
);
const ToolActivity = lazy(() =>
	import("./ToolActivity").then(({ ToolActivity }) => ({
		default: ToolActivity,
	})),
);

function DeferredChatMarkdown({ children }: { children: string }) {
	return (
		<Suspense fallback={children as ReactNode}>
			<ChatMarkdown>{children}</ChatMarkdown>
		</Suspense>
	);
}

function DeferredToolActivity({ tool }: { tool: ToolCall }) {
	return (
		<Suspense fallback={null}>
			<ToolActivity tool={tool} />
		</Suspense>
	);
}

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

// #428: the chunker's minimum-length split decision must measure what will be
// spoken, not the raw text — otherwise "[HAPPY] 아!" (11 chars) passes the
// minimum and a 2-char interjection reaches VoxCPM2 as its own first chunk.
const ttsChunkerOptions = {
	speakableLength: (sentence: string) => ttsTextFilter.filter(sentence).length,
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

/** 로컬 음성(naia-local-voice) 음색 id — 사용자 음성 참조(voiceRefUrl, RefAudioSection
 *  프리셋)의 **파일명**이 façade `/ref/voices` 팔레트 id 와 일치하므로 basename 을 그대로
 *  전달한다. (2026-07-15 루크 실증: 하드코딩 "default" 가 프리셋 선택을 façade 에 전달하지
 *  않아 음색이 팔레트 기본으로 고정되던 버그 — 남성 음색을 골라도 여성으로 나옴.)
 *  비팔레트 형식(녹음/업로드 data·로컬경로)은 façade 가 400 fail-closed 라 기본 음색 폴백. */
export function isDiscordConnectionIntent(text: string): boolean {
	const normalized = text.trim().toLocaleLowerCase();
	if (!/(discord|디스코드)/i.test(normalized)) return false;
	return /(connect|connection|setup|configure|configuration|bot\s*token|연결|연동|설정|구성|봇\s*토큰|토큰\s*(입력|등록|설정))/i.test(
		normalized,
	);
}

/**
 * 답을 만들지 못한 턴 (#572).
 *
 * 현장 관측(win-rtx4060): 메모 저장을 시키면 답변 자리에 `[오류] provider error:
 * invalid tool_call index` 가 그대로 찍혔다. 사용자는 무슨 일이 났는지도, 무엇을
 * 할 수 있는지도 알 수 없었다. `provider returned reasoning without a final
 * answer` 도 같은 자리에 같은 방식으로 올라왔다.
 *
 * 그래서 이 자리는 세 가지를 함께 준다 — 사용자 말로 된 한 줄, **다시 시도**,
 * 그리고 접힌 원문. `role="alert"` 은 장식이 아니다: 복구 표지 게이트
 * (`scripts/check-recovery-affordance.mjs`)가 실패 알림을 그 역할로 찾고, 그
 * 알림의 하위 트리 안에서만 조작을 센다. 재시도 버튼을 지우면 그 게이트가 이
 * 자리를 "빠져나갈 길이 없는 화면" 으로 붉힌다 — 그것이 이 버튼의 보증이다.
 */
function ChatErrorNotice({
	detail,
	onRetry,
}: {
	/** 원문 오류. 접힌 영역에만 둔다. */
	detail: string;
	/** 같은 입력을 다시 보낸다. */
	onRetry: () => void;
}) {
	return (
		<div className="chat-error-notice" role="alert">
			<p className="chat-error-notice__lead">{t("chat.answerFailed.lead")}</p>
			<button
				type="button"
				className="chat-error-notice__retry"
				onClick={onRetry}
			>
				{t("chat.answerFailed.retry")}
			</button>
			<details className="chat-error-notice__details">
				<summary>{t("chat.answerFailed.detailsLabel")}</summary>
				<pre className="chat-error-notice__detail-text">{detail}</pre>
			</details>
		</div>
	);
}

/**
 * Visual variant of the chat surface. The component is a SINGLE instance so
 * mode changes preserve the live voice/STT/TTS session:
 *   - "floating": compact lower-left dock below the avatar (default)
 *   - "rail":     full-height left rail when the user selects that preference
 */
export type ChatVariant = "rail" | "floating";

export function ChatArea({
	variant = "floating",
}: { variant?: ChatVariant } = {}) {
	const [input, setInput] = useState("");
	type OutputStage = "thinking" | "tts" | "render" | null;
	const [outputStage, setOutputStage] = useState<OutputStage>(null);
	// True while the local voice ENGINE is still booting (synthesize retries
	// with reason engine-starting). The output-stage chip then says
	// "음성 모델 준비 중…" instead of "생각 중…"/"음성 처리 중…" — the wait is the
	// voice model, not the LLM (user report 2026-08-18).
	const [voiceModelPreparing, setVoiceModelPreparing] = useState(false);
	// #520 — 정체 가드(#511)가 타이머 콜백에서 읽어야 하므로 ref 로도 들고 있는다.
	// state 는 렌더 시점 값이라 setTimeout 안에서는 낡은 값을 본다.
	const voiceModelPreparingRef = useRef(false);
	useEffect(() => {
		const onPreparing = (e: Event) => {
			const preparing = !!(e as CustomEvent<boolean>).detail;
			voiceModelPreparingRef.current = preparing;
			setVoiceModelPreparing(preparing);
		};
		window.addEventListener("naia:voice-model-preparing", onPreparing);
		return () =>
			window.removeEventListener("naia:voice-model-preparing", onPreparing);
	}, []);
	// #571 — 답 텍스트는 음성과 무관하게 도착하는 대로 그린다.
	//
	// 예전에는 이 자리에 화면 마스크(ttsVisibleContent·ttsMaskedMessageId)와, 그
	// 마스크가 영영 안 풀리는 것을 막으려고 덧댄 타이머 둘(#511 정체 공개, #520
	// 마스크 해제)이 있었다. 그런데 워밍업 홀드가 열려 있는 동안 두 타이머는 모두
	// 스스로를 다시 걸었다(lib/tts/reveal-guard 의 wait/rearm). 음성이 느린 기계에서
	// 홀드는 쉽게 1분을 넘고, 그동안 본문은 인질이 됐다 — win-rtx4060 실기에서
	// 비용 배지는 즉시 찍히는데 답은 없고 스피너만 돌았다(#571).
	//
	// 이제 남는 것은 음성 진행 상태뿐이다: 아직 말해지지 않은 문장이 몇 개인가.
	// 텍스트는 store 의 값을 그대로 그린다.
	const ttsTextSyncRef = useRef({
		generation: 0,
		active: false,
		pending: 0,
		llmFinished: false,
		canonical: "",
	});
	const ttsVoiceTailTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
		null,
	);
	const cascadeTtsJobsRef = useRef(0);
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
	// Providers may emit one usage event for each tool round before the final
	// assistant text. Keep those entries with the live request so usage cannot
	// finalize an empty assistant message before the terminal finish chunk.
	const pendingCostRef = useRef<CostEntry | null>(null);
	/** #572 — 마지막으로 보낸 사용자 발화. 실패 알림의 재시도가 이것을 다시 보낸다. */
	const lastSentTextRef = useRef("");
	const activeSpeechActivityRef = useRef<{
		activityId: string;
		profileGeneration: number;
	} | null>(null);
	const retiredSpeechActivityIdsRef = useRef(new Set<string>());
	const speechActivitySubscriptionEpochRef = useRef(0);
	const acceptSpeechActivitiesRef = useRef(true);
	const queuedSendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const voiceSessionRef = useRef<VoiceSession | null>(null);
	// #313 L3 — mid-session app context bridge handle (detached in every
	// voice cleanup path).
	const appContextBridgeRef = useRef<AppContextBridge | null>(null);
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
	const thinkingStreamFilterRef = useRef(new ThinkingStreamFilter());
	// FR-VOICE.16 Phase 2a (#420): the 6GB half-duplex admission + adaptive
	// prebuffer + generation fencing live in lib/tts/local-voice-scheduler so
	// unrelated ChatArea work cannot regress FR-VOICE.11/12 semantics.
	const localVoiceSchedulerRef = useRef<LocalVoiceScheduler | null>(null);
	if (!localVoiceSchedulerRef.current) {
		localVoiceSchedulerRef.current = new LocalVoiceScheduler({
			pausePlayback: () => audioQueueRef.current?.pauseBeforePlayback(),
			resumePlayback: () => audioQueueRef.current?.resumePlayback(),
			// FR-VOICE.19 (#519): warming hold reuses the existing "음성 모델
			// 준비 중…" indicator instead of falling back to another voice.
			setWarmingVisible: (visible) =>
				window.dispatchEvent(
					new CustomEvent("naia:voice-model-preparing", { detail: visible }),
				),
		});
	}
	const pipelineVoiceConfigRef = useRef<PipelineVoiceConfig | null>(null);
	const sttCleanupRef = useRef<(() => void)[]>([]);
	const sttDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const sttBufferRef = useRef("");
	const ttsPlayingRef = useRef(false);
	const ttsCooldownUntilRef = useRef(0);
	// 자기발화(에코) 방어 (2026-07-15 루크): ① 재생 중 마이크 정지(캡처 차단 — 1차)
	// ② 최근 TTS 문장과의 유사도 스킵(web-speech 지연 배달 누수 — 2차, echo-gate.ts).
	const sttPauseRef = useRef<(() => void) | null>(null);
	const sttResumeRef = useRef<(() => void) | null>(null);
	/** Timer for focus-after-tab-switch; cleared on unmount to prevent stale focus */
	const focusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	/** Timer for pipeline STT cooldown transition; cleared in cleanupPipeline */
	const sttCooldownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
		null,
	);
	const [ttsPlaying, setTtsPlaying] = useState(false);
	// FR-VOICE.16 Phase 2b (#420): the per-sentence TTS orchestration lives in
	// lib/tts/sentence-pipeline; ChatArea only wires environment callbacks and
	// calls the public interface. The pipeline owns the request lifecycle, the
	// one-time local-voice notice, and the recent-utterance ring (echo filter).
	const sentencePipelineRef = useRef<SentenceTtsPipeline | null>(null);
	const activeSlidePresenterSpeechRef =
		useRef<SlidePresenterSpeechRequest | null>(null);
	if (!sentencePipelineRef.current) {
		sentencePipelineRef.current = createSentenceTtsPipeline({
			generateRequestId,
			// #423: a reveal that fires while nothing is speaking anymore (failure
			// paths, playback-unavailable) must also settle the held expression —
			// settleAvatarEmotionIfIdle is internally guarded against live speech.
			reserveReveal: (sentence) => {
				const reveal = reserveTtsSentence(sentence);
				return () => {
					reveal();
					settleAvatarEmotionIfIdle();
				};
			},
			getRenderer: () => useCascadeAvatarStore.getState().renderer,
			beginCascadeJob: () => beginCascadeTtsJob(),
			setOutputStage: (stage) => setOutputStage(stage),
			getQueue: () => audioQueueRef.current,
			getVoiceConfig: () => pipelineVoiceConfigRef.current,
			getScheduler: () => localVoiceSchedulerRef.current,
			getBrowserTurnGeneration: () => ttsTextSyncRef.current.generation,
			setSpeaking: (on) => {
				ttsPlayingRef.current = on;
				setTtsPlaying(on);
				useAvatarStore.getState().setSpeaking(on);
				// #423: browser speech end/error releases the held expression.
				if (!on) {
					settleAvatarEmotionIfIdle();
					settleSlidePresenterSpeech("finished");
				}
			},
			getLocalRefAudioB64: () => getLocalRefAudioB64(),
			addCostEntry: (entry) =>
				useChatStore.getState().addSessionCostEntry({
					...entry,
					provider: entry.provider as ProviderId,
				}),
			onSynthesisResult: (result) => {
				const slide = activeSlidePresenterSpeechRef.current;
				if (result.provider !== "naia-local-voice") return;
				return writeVoiceDiagnostic(
					slide ? "land.naia.slides" : "land.naia.shell",
					slide,
					result,
				);
			},
			notifyLocalVoiceUnavailable: async () => {
				const runtimeState = await invoke<string>(
					"voxcpm2_runtime_status",
				).catch(() => "unknown");
				useChatStore.getState().addMessage({
					role: "assistant",
					content: t(
						runtimeState === "starting"
							? "chat.localVoiceStarting"
							: "chat.localVoiceUnavailable",
					),
				});
			},
		});
	}
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
				// Config hydration can complete while the async reset is in flight.
				// Re-read the cache after the await so a pre-hydration snapshot can
				// never erase freshly restored avatar/voice/profile settings.
				const currentConfig = loadConfig();
				if (currentConfig) {
					saveConfig({
						...currentConfig,
						discordSessionMigrated: true,
					});
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

	function isChatRequestActive(): boolean {
		return (
			currentRequestId.current !== null || useChatStore.getState().isStreaming
		);
	}

	function settleAvatarEmotionIfIdle(): void {
		const speechOwnsExpression =
			currentRequestId.current !== null ||
			useChatStore.getState().isStreaming ||
			sentencePipelineRef.current?.hasActiveRequests() === true ||
			audioQueueRef.current?.isActive === true ||
			ttsPlayingRef.current ||
			cascadeTtsJobsRef.current > 0 ||
			audioPlayerRef.current?.isPlaying === true;
		if (!speechOwnsExpression) setEmotion("neutral");
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
		settleAvatarEmotionIfIdle();
		scheduleNextQueuedMessage();
	}

	function handleCancelStreaming() {
		const store = useChatStore.getState();
		const ttsActive =
			ttsTextSyncRef.current.active ||
			sentencePipelineRef.current?.hasActiveRequests() === true ||
			audioQueueRef.current?.isActive === true;
		// The cancellation button is also rendered while the visual TTS state is
		// pending. A request may have been lost after the UI entered that state;
		// keep the button meaningful so a stranded "processing voice" indicator
		// cannot block the next turn forever.
		const ttsVisualStateActive = outputStage !== null;
		if (!store.isStreaming && !ttsActive && !ttsVisualStateActive) return;
		// A cancelled response may never deliver its terminal `finish` chunk.
		// Do not let an unfinished reasoning block hide the next request.
		thinkingStreamFilterRef.current.reset();
		// Cancelling the response is also a speech barge-in. Without clearing
		// the TTS generation here, a late avatar failure callback can replay
		// fallback audio from the response the user just stopped.
		interruptTts();
		const reqId = currentRequestId.current;
		if (reqId) {
			cancelChat(reqId).catch((err) => {
				Logger.warn("ChatArea", "Failed to cancel stream", {
					error: String(err),
				});
			});
		}
		if (store.isStreaming) store.finishStreaming();
		// Cancellation has no terminal provider chunk, but usage already emitted
		// for completed tool rounds still belongs to the partial assistant.
		commitPendingCost();
		setEmotion("neutral");
		completeCurrentRequest(reqId);
	}

	// ESC key to cancel streaming
	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if (
				e.key === "Escape" &&
				(useChatStore.getState().isStreaming ||
					ttsTextSyncRef.current.active ||
					ttsPlayingRef.current ||
					outputStage !== null)
			) {
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
			// The ordinary Shell TTS pipeline snapshots its provider settings when
			// the speech session starts. Keep that snapshot in sync too, otherwise a
			// preset picked while the session is active is persisted but the next
			// sentence is still synthesized with the previous voice until restart.
			const pipeline = pipelineVoiceConfigRef.current;
			if (pipeline?.ttsProvider === "naia-local-voice") {
				pipeline.voice = naiaLocalVoiceId(url ?? undefined);
				// The user's EXPLICIT Voice Host always wins — the local engine's
				// facade URL is only a fallback. The reverse order sent synthesis to
				// the local engine even when a remote host was configured
				// (2026-08-18 루크: "로컬 엔진 시작과 무관하게 voice host 우선").
				pipeline.vllmTtsHost =
					loadConfig()?.vllmTtsHost ??
					useCascadeAvatarStore.getState().localFacadeUrl ??
					pipeline.vllmTtsHost;
				Logger.info("ChatArea", "Local voice preset updated", {
					voice: pipeline.voice,
					host: pipeline.vllmTtsHost,
				});
			}
		};
		const onB64 = (e: Event) => {
			const b64 = (e as CustomEvent<string | null>).detail ?? null;
			voiceSessionRef.current?.setRefAudio?.(b64);
			const pipeline = pipelineVoiceConfigRef.current;
			if (b64 && pipeline?.ttsProvider === "naia-local-voice") {
				pipeline.voice = "naia-current";
				Logger.info("ChatArea", "Local uploaded voice updated", {
					voice: pipeline.voice,
				});
			}
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
	function writeVoiceDiagnostic(
		appId: "land.naia.shell" | "land.naia.slides",
		slide: SlidePresenterSpeechRequest | null,
		result: TtsSynthesisResult,
	): Promise<void> {
		const capturedAt = new Date().toISOString();
		const safeTimestamp = capturedAt.replace(/[:.]/g, "-");
		const base = `diagnostics/voice/${slide ? `page-${slide.page}` : "chat"}-${safeTimestamp}`;
		const audioRelativePath = `${base}.wav`;
		const audioBytes = Uint8Array.from(atob(result.audioBase64), (char) => char.charCodeAt(0));
		const record = {
			schemaVersion: 1,
			captureKind: slide ? "slides-tts" : "chat-tts",
			capturedAt,
			slide: slide ? { page: slide.page, generation: slide.generation, requestId: slide.requestId } : null,
			text: result.text,
			provider: result.provider,
			voice: result.voice ?? null,
			localReferenceAudioPresent: result.localReferenceAudioPresent,
			localVoiceRuntimeStatus: result.provider === "naia-local-voice" ? "captured-during-local-voice-request" : null,
			vllmTtsHost: result.vllmTtsHost ?? null,
			synthesisElapsedMs: result.elapsedMs,
			audioDurationSeconds: result.audioDurationSeconds,
			audioRelativePath,
		};
		return writeAppSandboxFile(appId, audioRelativePath, Array.from(audioBytes))
			.then(() => writeAppSandboxFile(appId, `${base}.json`, Array.from(new TextEncoder().encode(JSON.stringify(record, null, 2)))))
			.then(() => Logger.info("ChatArea", "captured local voice diagnostic", { appId, provider: result.provider, audioRelativePath }))
			.catch((error) => Logger.warn("ChatArea", "local voice diagnostic capture failed", { appId, error: String(error) }));
	}

	function settleSlidePresenterSpeech(
		status: "finished" | "cancelled" | "failed",
		error?: string,
	): void {
		const active = activeSlidePresenterSpeechRef.current;
		if (!active) return;
		activeSlidePresenterSpeechRef.current = null;
		window.dispatchEvent(
			new CustomEvent(SLIDE_PRESENTER_SPEECH_RESULT_EVENT, {
				detail: { ...active, status, error },
			}),
		);
		Logger.info("ChatArea", "slide narration settled", {
			page: active.page,
			generation: active.generation,
			status,
		});
	}

	function interruptTts(): void {
		settleSlidePresenterSpeech("cancelled");
		// Reveal the canonical response immediately on interruption and invalidate
		// late playback callbacks from the superseded turn.
		commitStrandedCanonical(); // #513
		ttsTextSyncRef.current.generation++;
		ttsTextSyncRef.current.active = false;
		ttsTextSyncRef.current.pending = 0;
		ttsTextSyncRef.current.llmFinished = false;
		clearVoiceTailTimer();
		cascadeTtsJobsRef.current = 0;
		setOutputStage(null);
		audioQueueRef.current?.clear();
		sentenceChunkerRef.current?.clear();
		// Do not reset the GPU admission fence here. Aborting the WebView fetch
		// does not prove that VoxCPM2 has released its execution context yet.
		// The new turn must remain behind the old local synthesis tail.
		localVoiceSchedulerRef.current?.interrupt();
		// Drop pending requests, cancel in-flight TTS fetch/WS, and stop any
		// live browser utterance — all pipeline-owned lifecycle (#363, Phase 3).
		sentencePipelineRef.current?.interrupt();
		// cascade 토킹 아바타 활성 시 발화 스트림도 중단(barge-in) — 오버레이 즉시 종료.
		useCascadeAvatarStore.getState().renderer?.interrupt();
		ttsPlayingRef.current = false;
		setTtsPlaying(false);
		useAvatarStore.getState().setSpeaking(false);
		setEmotion("neutral");
	}

	useEffect(() => {
		const onTtsEnabledChange = (event: Event) => {
			const enabled =
				(event as CustomEvent<{ enabled?: boolean }>).detail?.enabled === true;
			if (!enabled) interruptTts();
		};
		window.addEventListener("naia:tts-enabled-change", onTtsEnabledChange);
		return () =>
			window.removeEventListener("naia:tts-enabled-change", onTtsEnabledChange);
	}, []);

	function finishLocalVoicePrebuffer(): void {
		localVoiceSchedulerRef.current?.finishStream();
	}

	function beginCascadeTtsJob(): () => void {
		const generation = ttsTextSyncRef.current.generation;
		let ended = false;
		cascadeTtsJobsRef.current++;
		ttsPlayingRef.current = true;
		setTtsPlaying(true);
		return () => {
			if (ended) return;
			ended = true;
			if (generation !== ttsTextSyncRef.current.generation) return;
			cascadeTtsJobsRef.current = Math.max(0, cascadeTtsJobsRef.current - 1);
			if (cascadeTtsJobsRef.current === 0) {
				ttsPlayingRef.current = false;
				setTtsPlaying(false);
				settleAvatarEmotionIfIdle();
				settleSlidePresenterSpeech("finished");
			}
		};
	}

	// #520 — 로컬 엔진이 아직 데워지는 중이면 음성 표시를 성급히 내리지 않는다.
	//         판정은 lib/tts/reveal-guard 가 소유한다. 이제 이 판정이 정하는 것은
	//         본문 공개가 아니라 "음성 진행 표시를 언제 내리는가" 뿐이다(#571).
	const TTS_VOICE_TAIL_MS = 8_000;
	function clearVoiceTailTimer(): void {
		if (ttsVoiceTailTimerRef.current)
			clearTimeout(ttsVoiceTailTimerRef.current);
		ttsVoiceTailTimerRef.current = null;
	}

	function beginTtsTextSync(): void {
		clearVoiceTailTimer();
		const sync = ttsTextSyncRef.current;
		sync.generation++;
		sync.active = true;
		sync.pending = 0;
		sync.llmFinished = false;
		sync.canonical = "";
		setOutputStage("thinking");
	}

	/**
	 * Proactive speech arrives as an already-complete activity message rather
	 * than an ordinary streamed chat response. The transcript goes into the
	 * store immediately — the same rule as an ordinary answer (#571) — and only
	 * the voice progress indicator waits for playback.
	 */
	function beginProactiveTtsTextSync(text: string): number {
		beginTtsTextSync();
		const sync = ttsTextSyncRef.current;
		sync.canonical = text;
		sync.llmFinished = true;
		setOutputStage("tts");
		useChatStore.getState().addMessage({ role: "assistant", content: text });
		return sync.generation;
	}

	/** Speech never started for this turn; drop the voice indicator. */
	function endFailedProactiveTts(generation: number): void {
		const sync = ttsTextSyncRef.current;
		if (!sync.active || sync.generation !== generation) return;
		clearVoiceTailTimer();
		sync.active = false;
		sync.pending = 0;
		setOutputStage(null);
	}

	/**
	 * One sentence has been handed to the voice pipeline. The returned callback
	 * runs when that sentence actually starts playing.
	 *
	 * #571 — this used to also decide when the matching text became visible.
	 * It no longer touches the transcript: text is already on screen. What is
	 * left is the count of sentences not yet spoken, which drives the voice
	 * progress chip and the cancel button.
	 */
	function reserveTtsSentence(_sentence: string): () => void {
		const sync = ttsTextSyncRef.current;
		if (!sync.active) return () => {};
		const generation = sync.generation;
		sync.pending++;
		setOutputStage("tts");
		let settled = false;
		return () => {
			if (settled) return;
			settled = true;
			const current = ttsTextSyncRef.current;
			if (!current.active || current.generation !== generation) return;
			current.pending = Math.max(0, current.pending - 1);
			if (current.pending === 0) setOutputStage(null);
			if (current.llmFinished && current.pending === 0) {
				clearVoiceTailTimer();
				commitStrandedCanonical(); // #513
				current.active = false;
				setOutputStage(null);
			}
		};
	}

	// #513 — 좌초 방어 벨트: 동기화가 끝날 때 store 의 마지막 assistant 메시지가 비어 있는데
	//        canonical 본문이 있으면 canonical 을 확정 기록한다(조기완결 잔재 회수 — 어떤 경로로
	//        좌초했든 사용자 화면에서 대화가 사라지지 않게 하는 최후 방어).
	function commitStrandedCanonical(): void {
		const canonical = ttsTextSyncRef.current.canonical;
		if (!canonical.trim()) return;
		const store = useChatStore.getState();
		const last = store.messages.at(-1);
		if (last && last.role === "assistant" && !last.content.trim()) {
			Logger.warn(
				"ChatArea",
				"Committing stranded reply text to store (#513)",
				{
					length: canonical.length,
				},
			);
			store.updateLastMessage("assistant", canonical);
		}
	}

	function deferCostEntry(entry: CostEntry): void {
		const previous = pendingCostRef.current;
		pendingCostRef.current = previous
			? {
					inputTokens: previous.inputTokens + entry.inputTokens,
					outputTokens: previous.outputTokens + entry.outputTokens,
					cost: previous.cost + entry.cost,
					provider: entry.provider,
					model: entry.model,
				}
			: entry;
	}

	function commitPendingCost(): void {
		const pending = pendingCostRef.current;
		if (!pending) return;
		pendingCostRef.current = null;
		useChatStore.getState().addCostEntry(pending);
	}

	function finishStreamingWithVoiceTail(terminal = true): void {
		const store = useChatStore.getState();
		const wasStreaming = store.isStreaming;
		if (wasStreaming) store.finishStreaming();
		// Usage entries arrive before or alongside the terminal chunk. Commit only
		// after finishStreaming creates the assistant message so tool-round costs
		// attach to the final visible reply.
		commitPendingCost();
		const sync = ttsTextSyncRef.current;
		if (!sync.active) return;
		if (terminal) sync.llmFinished = true;
		// #520 — 대기 중인 문장이 없어도 워밍업 홀드가 열려 있으면 음성은 오는
		// 중이다. 콜드 엔진에서는 합성이 아직 한 문장도 내놓지 못한 상태가
		// 정상이므로 여기서 표시를 즉시 내리면 곧 다시 켜진다. 본문은 이미
		// 화면에 있으므로(#571) 이 대기는 텍스트를 붙잡지 않는다.
		if (terminal && sync.pending === 0 && !voiceModelPreparingRef.current) {
			clearVoiceTailTimer();
			commitStrandedCanonical(); // #513
			sync.active = false;
			setOutputStage(null);
			return;
		}
		if (terminal) {
			armVoiceTailRelease(sync.generation);
		}
	}

	// #520/#571 — 음성이 영영 오지 않아도 진행 표시가 남아 있지 않게 한다.
	// 판정은 lib/tts/reveal-guard 가 소유한다. 이 타이머가 정하는 것은 표시뿐이며,
	// 본문은 이 경로와 무관하게 이미 그려져 있다.
	function armVoiceTailRelease(generation: number): void {
		clearVoiceTailTimer();
		ttsVoiceTailTimerRef.current = setTimeout(() => {
			ttsVoiceTailTimerRef.current = null;
			const current = ttsTextSyncRef.current;
			const decision = decideVoiceTailRelease({
				active: current.active,
				armedGeneration: generation,
				currentGeneration: current.generation,
				llmFinished: current.llmFinished,
				warmingHold: voiceModelPreparingRef.current,
			});
			if (decision.action === "stop") return;
			if (decision.action === "rearm") {
				armVoiceTailRelease(generation);
				return;
			}
			commitStrandedCanonical(); // #513
			current.active = false;
			current.pending = 0;
			setOutputStage(null);
		}, TTS_VOICE_TAIL_MS);
	}

	function initializeSpeechTts(config: AppConfig): void {
		if (!audioQueueRef.current) {
			audioQueueRef.current = new AudioQueue({
				outputDeviceId: config.ttsOutputDeviceId || undefined,
				onPlaybackStart: () => {
					useAvatarStore.getState().setSpeaking(true);
					ttsPlayingRef.current = true;
					setTtsPlaying(true);
					useCascadeAvatarStore.getState().renderer?.setSpeakingVisual(true);
				},
				onPlaybackEnd: () => {
					useAvatarStore.getState().setSpeaking(false);
					ttsPlayingRef.current = false;
					setTtsPlaying(false);
					useCascadeAvatarStore.getState().renderer?.setSpeakingVisual(false);
					settleAvatarEmotionIfIdle();
					settleSlidePresenterSpeech("finished");
				},
			});
		}
		sentenceChunkerRef.current = new SentenceChunker(ttsChunkerOptions);
		pipelineVoiceConfigRef.current = {
			voice: resolveTtsVoiceId(config),
			ttsProvider: config.ttsProvider || "edge",
			localVoiceEnabled: config.localVoiceEnabled === true, // #512 관측
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

	// Slides requests narration but never synthesizes or plays audio itself.
	// This bridge is the only presentation entry into the Shell TTS pipeline.
	useEffect(() => {
		let disposed = false;
		const handleSpeak = (event: Event) => {
			const detail = (event as CustomEvent<SlidePresenterSpeechRequest>).detail;
			if (
				!detail?.requestId ||
				!Number.isSafeInteger(detail.generation) ||
				!Number.isSafeInteger(detail.page) ||
				!detail.text?.trim()
			) {
				return;
			}
			interruptTts();
			activeSlidePresenterSpeechRef.current = detail;
			void (async () => {
				for (
					let attempt = 0;
					currentRequestId.current && attempt < 100;
					attempt++
				) {
					await new Promise((resolve) => setTimeout(resolve, 100));
					if (
						activeSlidePresenterSpeechRef.current?.requestId !==
						detail.requestId
					)
						return;
				}
				if (
					disposed ||
					activeSlidePresenterSpeechRef.current?.requestId !== detail.requestId
				)
					return;
				if (currentRequestId.current) {
					settleSlidePresenterSpeech("failed", "chat_busy");
					return;
				}
				const config = await loadConfigWithSecrets();
				if (!config || config.ttsEnabled !== true) {
					settleSlidePresenterSpeech("failed", "tts_disabled");
					return;
				}
				initializeSpeechTts(config);
				beginProactiveTtsTextSync(detail.text.trim());
				sendSentenceToTts(detail.text.trim());
				finishLocalVoicePrebuffer();
				Logger.info("ChatArea", "slide narration entered TTS pipeline", {
					page: detail.page,
					generation: detail.generation,
					characters: detail.text.trim().length,
				});
			})().catch((error) => {
				if (
					activeSlidePresenterSpeechRef.current?.requestId === detail.requestId
				) {
					settleSlidePresenterSpeech("failed", String(error));
				}
			});
		};
		const handleCancel = (event: Event) => {
			const detail = (
				event as CustomEvent<{ requestId?: string; generation?: number }>
			).detail;
			const active = activeSlidePresenterSpeechRef.current;
			if (!active) return;
			if (detail?.requestId && detail.requestId !== active.requestId) return;
			if (detail?.generation != null && detail.generation !== active.generation)
				return;
			interruptTts();
		};
		window.addEventListener(SLIDE_PRESENTER_SPEAK_EVENT, handleSpeak);
		window.addEventListener(SLIDE_PRESENTER_CANCEL_EVENT, handleCancel);
		return () => {
			disposed = true;
			window.removeEventListener(SLIDE_PRESENTER_SPEAK_EVENT, handleSpeak);
			window.removeEventListener(SLIDE_PRESENTER_CANCEL_EVENT, handleCancel);
			if (activeSlidePresenterSpeechRef.current) interruptTts();
		};
	}, []);

	// Configure the explicitly persisted opt-in profile and consume its
	// request-independent activity stream. Ordinary chat listeners deliberately
	// ignore these events because their requestId is not the active turn.
	useEffect(() => {
		let disposed = false;
		let unlisten: (() => void) | undefined;
		const configurePersistedProfile = async (config: AppConfig) => {
			const profile = config.proactiveSpeechProfile ?? "disabled";
			const permitted = config.proactiveSpeechPermitted === true;
			const settings = normalizeProactiveSpeechSettings({
				profile: permitted ? profile : "disabled",
				idleMs: config.proactiveSpeechIdleMs,
				intervalMs: config.proactiveSpeechIntervalMs,
				timezone: config.proactiveSpeechTimezone ?? "UTC",
				bgmAutoPlay: config.proactiveSpeechBgmAutoPlay,
				weatherConsented: config.proactiveSpeechWeatherConsented,
				weatherLatitude: config.proactiveSpeechWeatherLatitude,
				weatherLongitude: config.proactiveSpeechWeatherLongitude,
				knowledgeScope: config.proactiveSpeechKnowledgeScope,
			});
			return configureSpeechProfile(toSpeechProfileCommandInput(settings));
		};
		void loadConfigWithSecrets().then((config) => {
			if (!config || disposed) return;
			void configurePersistedProfile(config);
		});
		const retireActiveSpeech = () => {
			acceptSpeechActivitiesRef.current = false;
			interruptTts();
			const active = activeSpeechActivityRef.current;
			if (active) retiredSpeechActivityIdsRef.current.add(active.activityId);
			activeSpeechActivityRef.current = null;
			window.dispatchEvent(
				new CustomEvent("naia-proactive-activity-state", {
					detail: { active: false },
				}),
			);
		};
		const handlePermissionChange = (event: Event) => {
			const permitted =
				(event as CustomEvent<{ permitted?: boolean }>).detail?.permitted ===
				true;
			void (async () => {
				const config = await loadConfigWithSecrets();
				if (!config || disposed) return;
				if (!permitted) {
					const active = activeSpeechActivityRef.current;
					retireActiveSpeech();
					if (active) await controlSpeechActivity("stop", active.activityId);
				}
				await configurePersistedProfile({
					...config,
					proactiveSpeechPermitted: permitted,
				});
			})();
		};
		window.addEventListener(
			"naia-proactive-profile-changing",
			retireActiveSpeech,
		);
		window.addEventListener(
			"naia-proactive-permission-change",
			handlePermissionChange,
		);
		const acceptConfiguredProfile = (event: Event) => {
			const detail = (
				event as CustomEvent<{
					ok?: boolean;
					subscriptionEpoch?: number;
				}>
			).detail;
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
				const raw =
					typeof event.payload === "string"
						? event.payload
						: JSON.stringify(event.payload);
				chunk = JSON.parse(raw) as Record<string, unknown>;
			} catch {
				return;
			}
			if (typeof chunk.activityId !== "string") return;
			if (
				!["app_tool_call", "text", "finish", "error"].includes(
					String(chunk.type),
				)
			) {
				return;
			}
			const activityId = chunk.activityId;
			const subscriptionEpoch = Number(chunk.subscriptionEpoch ?? 0);
			const profileGeneration = Number(chunk.profileGeneration ?? 0);
			const active = activeSpeechActivityRef.current;
			if (!acceptSpeechActivitiesRef.current) return;
			// A profile save retires the old stream before its final Configure ACK
			// reaches this WebView. A newer epoch is therefore authoritative and may
			// arrive first; accept it and advance the fence. Older activity remains
			// rejected, so a late pre-save stream can never reclaim the voice lane.
			if (subscriptionEpoch < speechActivitySubscriptionEpochRef.current)
				return;
			if (subscriptionEpoch > speechActivitySubscriptionEpochRef.current) {
				speechActivitySubscriptionEpochRef.current = subscriptionEpoch;
			}
			if (retiredSpeechActivityIdsRef.current.has(activityId)) return;
			if (active && profileGeneration < active.profileGeneration) return;
			if (active && active.activityId !== activityId) {
				retiredSpeechActivityIdsRef.current.add(active.activityId);
				if (retiredSpeechActivityIdsRef.current.size > 100) {
					const oldest = retiredSpeechActivityIdsRef.current
						.values()
						.next().value;
					if (oldest) retiredSpeechActivityIdsRef.current.delete(oldest);
				}
			}
			activeSpeechActivityRef.current = { activityId, profileGeneration };
			window.dispatchEvent(
				new CustomEvent("naia-proactive-activity-state", {
					detail: { active: true },
				}),
			);
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
				chunk.type === "app_tool_call" &&
				typeof chunk.requestId === "string" &&
				typeof chunk.toolCallId === "string" &&
				typeof chunk.toolName === "string"
			) {
				dispatchAppToolCall({
					requestId: chunk.requestId,
					toolCallId: chunk.toolCallId,
					toolName: chunk.toolName,
					args: (chunk.args as Record<string, unknown>) ?? {},
					activityId,
				});
				return;
			}
			if (
				chunk.type === "text" &&
				typeof chunk.text === "string" &&
				chunk.text.trim()
			) {
				// DJ keeps its activity alive when a normal chat cannot yield it.
				// Never let proactive text reset/share the ordinary chat TTS lane.
				if (currentRequestId.current) return;
				const text = chunk.text.trim();
				const cachedConfig = loadConfig();
				const shouldSpeak = canSpeakProactiveText({
					currentRequestId: currentRequestId.current,
					activeActivityId: activeSpeechActivityRef.current?.activityId,
					eventActivityId: activityId,
					ttsEnabled: cachedConfig?.ttsEnabled === true,
				});
				if (!shouldSpeak) {
					useChatStore
						.getState()
						.addMessage({ role: "assistant", content: text });
					return;
				}
				const ttsGeneration = beginProactiveTtsTextSync(text);
				// Capture eligibility before awaiting DPAPI/API-key hydration. A normal
				// activity finish closes the producer but must not cancel speech that was
				// already accepted. Barge-in/profile changes invalidate the generation.
				void loadConfigWithSecrets()
					.then((config) => {
						if (
							!config ||
							ttsTextSyncRef.current.generation !== ttsGeneration ||
							!ttsTextSyncRef.current.active
						) {
							if (!config) endFailedProactiveTts(ttsGeneration);
							return;
						}
						initializeSpeechTts(config);
						const chunker = sentenceChunkerRef.current;
						if (!chunker) {
							endFailedProactiveTts(ttsGeneration);
							return;
						}
						const sentences = chunker.feed(text);
						const remaining = chunker.flush();
						for (const sentence of sentences) sendSentenceToTts(sentence);
						if (remaining) sendSentenceToTts(remaining);
						finishLocalVoicePrebuffer();
						if (sentences.length === 0 && !remaining) {
							endFailedProactiveTts(ttsGeneration);
						}
					})
					.catch(() => endFailedProactiveTts(ttsGeneration));
				return;
			}
			// `finish` closes one streamed turn, not the owning long-lived speech
			// activity. Tool results can legitimately continue the same activity
			// (Radio DJ play -> observed status -> announcement), so retiring here
			// drops those follow-up calls. Explicit stop/profile changes, a newer
			// activity, or an error remain the authoritative retirement boundaries.
			if (chunk.type === "finish") return;
			if (chunk.type === "error") {
				if (activeSpeechActivityRef.current?.activityId === activityId) {
					retiredSpeechActivityIdsRef.current.add(activityId);
					activeSpeechActivityRef.current = null;
					window.dispatchEvent(
						new CustomEvent("naia-proactive-activity-state", {
							detail: { active: false },
						}),
					);
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
			window.removeEventListener(
				"naia-proactive-permission-change",
				handlePermissionChange,
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
		sentencePipelineRef.current?.rearmLocalVoiceNotice();
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
			if (
				activeSpeechActivityRef.current?.activityId ===
				speechActivity.activityId
			) {
				activeSpeechActivityRef.current = null;
				window.dispatchEvent(
					new CustomEvent("naia-proactive-activity-state", {
						detail: { active: false },
					}),
				);
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
			setEmotion("think");
			voiceSessionRef.current.sendText(text);
			return;
		}
		// Pipeline voice mode: send via normal chat path (TTS handled by handleChunk)
		// Falls through to the normal sendChatMessage flow below

		const requestId = generateRequestId();
		// Request state is isolated even when the previous transport terminated
		// without a final chunk (cancel, disconnect, provider error).
		thinkingStreamFilterRef.current.reset();
		currentRequestId.current = requestId;
		pendingCostRef.current = null;
		// #572 — 실패했을 때 "같은 입력을 다시" 를 제안하려면 그 입력을 알아야 한다.
		lastSentTextRef.current = text;

		setInput("");
		useChatStore.getState().addMessage({ role: "user", content: text });

		useChatStore.getState().startStreaming();
		// New turn supersedes any in-flight TTS: stop the previous response's
		// audio (queue + browser speechSynthesis) instead of letting it finish.
		// clear() also resets the ordering sequence for the new response.
		interruptTts();
		setEmotion("think");

		const store = useChatStore.getState();

		const config = await loadConfigWithSecrets();
		// Structured llmRoles.main is the source of truth. The flat provider/model
		// fields remain a compatibility mirror and may be stale or absent after an
		// ADK seed, so route the turn from the same effective role as Settings.
		const mainRole = config ? effectiveMainRole(config) : {};
		const configuredProvider = mainRole.provider ?? config?.provider;
		const configuredModel = mainRole.model ?? config?.model;
		// 새 core 는 에이전트가 GLM 키를 쥐므로 nextain 로그인 게이트 우회(naiaKey 없어도 전송).
		if (!isNewCore() && configuredProvider === "nextain" && !config?.naiaKey) {
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
			configuredProvider === "nextain" &&
			configuredModel &&
			isOmniModel(configuredProvider, configuredModel)
		) {
			useChatStore.getState().finishStreaming();
			completeCurrentRequest(requestId);
			await handleVoiceToggle();
			setEmotion("think");
			voiceSessionRef.current?.sendText(text);
			return;
		}
		// 새 core 는 에이전트가 provider/key(GLM_KEY env) 를 쥐므로 UI 키 게이트 우회(없어도 전송).
		if (
			!isNewCore() &&
			!isApiKeyOptional(configuredProvider ?? "") &&
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
		const activeProvider = configuredProvider || provider;

		// Initialize/update SentenceChunker + AudioQueue for chat TTS
		if (chatTtsEnabled) {
			initializeSpeechTts(config);
			beginTtsTextSync();
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
			configuredModel || getDefaultLlmModel(activeProvider) || "gemini-2.5-flash";
		const providerMeta = getLlmProvider(activeProvider);
		const hasDynamicModels = providerMeta && providerMeta.models.length === 0;
		// The gateway catalog is populated asynchronously, so a model selected
		// from that catalog may not be present in the static registry yet. A
		// structured main role is the canonical persisted selection and must
		// survive that gap.
		const hasExplicitStructuredMainModel = Boolean(
			config?.llmRoles?.main &&
				!config.llmRoles.main.inherit &&
				config.llmRoles.main.provider === activeProvider &&
				config.llmRoles.main.model === savedModel,
		);
		const modelIsValid =
			hasExplicitStructuredMainModel ||
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
			// Startup registration can race the agent process. Refresh the
			// idempotent descriptor immediately before every turn so semantic
			// requests such as Radio DJ cannot degrade into text-only claims.
			const bgmSkillReady = await sendAppSkills(BGM_APP_ID, [
				SKILL_YOUTUBE_BGM,
			]);
			Logger.info("ChatArea", "turn bgm skill registration", {
				ready: bgmSkillReady,
				requestId,
			});
			if (!bgmSkillReady) {
				throw new Error("skill_youtube_bgm_registration_failed");
			}
			// #502 (FR-ENV-ATTENTION.5): 싣기 직전에 관측을 갱신한다.
			//
			// 갱신 없이 부팅 스냅샷을 계속 실으면 "지금 뭐 돌고 있어"에 몇 시간 전 목록으로
			// 답하게 된다. 지켜보는 동안에는 그것이 더 나쁘다 — 계속 보고 있다고 말해 놓고
			// 옛것을 보여 주는 셈이다. 개수만 싣는 동안에도 개수가 틀리면 나이아가 부를
			// 이유를 잘못 판단한다.
			//
			// 관측 갱신 비용은 실측했다: herdr 스냅샷 한 번이 10ms 다(2026-08-27). 그 뒤에
			// 오는 LLM 호출 앞에서는 무시할 수준이고, Herdr 이 없으면 즉시 실패해 넘어간다.
			// 꺼 두었으면 부르지 않는다 — 껐다는 말은 값도 안 든다는 뜻이어야 한다.
			// 환경 도구도 턴마다 다시 등록한다. 부팅 등록은 agent 기동과 경쟁하고, agent 가
			// 재시작하면 조용히 사라진다 — BGM 이 같은 이유로 매 턴 재등록한다.
			// 다만 여기서는 실패해도 대화를 막지 않는다. 환경은 대화의 조건이 아니다.
			let environmentToolReady = false;
			if ((loadConfig()?.environmentAwareness ?? "auto") === "off") {
				// 꺼져 있으면 등록 경로를 타지 않으므로, 실패한 해제는 스스로 낫지 않는다.
				// 도구 선언이 뇌에 남아 요청 비용이 계속 붙는다 — 다음 턴에 한 번 더 시도한다
				// (FR-ENV-ATTENTION.17). 기다리지 않으므로 대화는 지연되지 않는다.
				if (environmentClearNeeded()) {
					void sendAppSkillsClear(ENVIRONMENT_APP_ID, { awaitAck: true })
						.then((ok) => noteEnvironmentClear(ok))
						.catch(() => noteEnvironmentClear(false));
				}
			} else {
				// 등록을 쏘되 기다리지 않는다. 기다리면 확인이 오지 않을 때 사용자의 모든
				// 대화가 시간초과만큼 멈춘다 — 실제로 그렇게 만들어 12건이 깨졌다(2026-08-28).
				// 확인이 돌아오면 상태가 바뀌고, 이 턴은 마지막으로 확인된 상태를 쓴다.
				void sendAppSkills(ENVIRONMENT_APP_ID, [SKILL_ENVIRONMENT], {
					awaitAck: true,
				})
					.then((ok) => noteEnvironmentToolAck(ok))
					.catch(() => noteEnvironmentToolAck(false));
				// 도구가 꺼져 있으면 나이아는 observe/watch 를 부를 수 없다. 그런데도 개수를
				// 실으면 안내가 "필요하면 도구를 불러라"라고 말한다 — 닫힌 길을 가리키는 셈이다
				// (2026-08-28 19차 적대리뷰 지적). 등록 확인과 도구 활성화를 함께 본다.
				environmentToolReady =
					environmentToolRegistered() && config.enableTools === true;
				if (!environmentToolReady) {
					Logger.warn(
						"ChatArea",
						"environment skill not confirmed — skipping surfaces",
						{
							requestId,
						},
					);
				}
				await refreshEnvironment().catch(() => null);
			}
			// 지켜보기 예산을 한 턴 쓴다 (FR-ENV-ATTENTION.7). 음성 경로와 같은 헬퍼를 쓴다 —
			// 여기만 따로 쓰다가 always 규칙이 이 경로에만 빠졌다(13차 적대리뷰 지적).
			noteEnvironmentTurn();
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
					openaiBaseUrl:
						activeProvider === "openai" ? config.openaiBaseUrl : undefined,
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
					environmentToolReady,
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
				finishStreamingWithVoiceTail();
				finishLocalVoicePrebuffer();
				setShowNoAuthModal(true);
				completeCurrentRequest(requestId);
			} else {
				useChatStore.getState().appendStreamChunk(`
[${t("chat.error")}] ${errStr}`);
				finishStreamingWithVoiceTail();
				finishLocalVoicePrebuffer();
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
			window.dispatchEvent(new CustomEvent("naia-proactive-profile-changing"));
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
			const configured =
				disabled &&
				(profile === "disabled" ||
					(await configureSpeechProfile(
						toSpeechProfileCommandInput(
							normalizeProactiveSpeechSettings({
								profile,
								idleMs:
									config?.proactiveSpeechIdleMs ??
									(profile === "personal_radio_dj" ? 5_000 : 1_000),
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
						),
					)));
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
					// A spoken explicit start is direct user permission; settings changes are not.
					proactiveSpeechPermitted: profile !== "disabled",
					...(profile !== "disabled" && config.proactiveSpeechIdleMs == null
						? {
								proactiveSpeechIdleMs:
									profile === "personal_radio_dj" ? 5_000 : 1_000,
							}
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
			window.dispatchEvent(
				new CustomEvent("naia-proactive-activity-state", {
					detail: { active: false },
				}),
			);
		}
		setInput("");
		useChatStore.getState().addMessage({ role: "user", content: text });
		return true;
	}

	async function activateRadioDjFromSkill(): Promise<void> {
		const config = await loadConfigWithSecrets();
		if (!config) throw new Error("radio_dj_config_unavailable");
		if (
			config.proactiveSpeechProfile === "personal_radio_dj" &&
			config.proactiveSpeechPermitted === true
		)
			return;

		window.dispatchEvent(new CustomEvent("naia-proactive-profile-changing"));
		const settings = normalizeProactiveSpeechSettings({
			profile: "personal_radio_dj",
			idleMs: config.proactiveSpeechIdleMs ?? RADIO_DJ_DEFAULT_SETTINGS.idleMs,
			intervalMs:
				config.proactiveSpeechIntervalMs ??
				RADIO_DJ_DEFAULT_SETTINGS.intervalMs,
			timezone: config.proactiveSpeechTimezone ?? "UTC",
			bgmAutoPlay: true,
			weatherConsented: config.proactiveSpeechWeatherConsented,
			weatherLatitude: config.proactiveSpeechWeatherLatitude,
			weatherLongitude: config.proactiveSpeechWeatherLongitude,
			knowledgeScope: config.proactiveSpeechKnowledgeScope,
		});
		const configured = await configureSpeechProfile(
			toSpeechProfileCommandInput(settings),
		);
		if (!configured) throw new Error("radio_dj_profile_configure_failed");
		saveConfig({
			...config,
			proactiveSpeechProfile: "personal_radio_dj",
			proactiveSpeechPermitted: true,
			proactiveSpeechIdleMs: settings.idleMs,
			proactiveSpeechIntervalMs: settings.intervalMs,
			proactiveSpeechBgmAutoPlay: true,
		});
	}

	// Shared app-tool dispatch — used by both the streaming-chat handleChunk
	// path AND the voice directToolCall path (so voice can run app tools like
	// skill_browser_*). Auto-switches to the owning app first (tool-level), so
	// a tool targeting a non-active app brings that app forward.
	/**
	 * 대화 턴 하나가 지나갔다고 환경 세션에 알린다 (FR-ENV-ATTENTION.7).
	 * 정상 종료·중단 어느 쪽으로 끝나든 턴은 턴이다. 꺼져 있으면 아무것도 하지 않는다.
	 */
	function noteEnvironmentTurn() {
		const awareness = loadConfig()?.environmentAwareness ?? "auto";
		// 꺼져 있으면 셀 것이 없다.
		if (awareness === "off") return;
		// always 는 예산과 무관하다 (FR-ENV-ATTENTION.7). 출력만 그런 것이 아니라 상태도
		// 그래야 한다 — 여기서 예산을 깎으면 always 를 쓰는 동안 잠복한 지켜보기가 소진되고,
		// 사용자가 auto 로 되돌릴 때 나이아가 끈 적 없는데 목록이 사라진다
		// (2026-08-27 13차 적대리뷰 지적).
		if (awareness === "always") return;
		environmentSession.noteTurn();
	}

	function dispatchAppToolCall(
		req: {
			requestId: string;
			toolCallId: string;
			toolName: string;
			args: Record<string, unknown>;
			activityId?: string;
		},
		/**
		 * 이 호출이 실시간 음성 세션에서 왔는가 (FR-ENV-ATTENTION.10).
		 * 음성은 연결 시점의 지시문 하나로 이야기하므로 요청마다 표면 세그먼트를 싣지 않는다.
		 * 그 사실을 나이아에게 그대로 알려야 "지켜본다"가 거짓말이 되지 않는다.
		 */
		origin: {
			readonly assemblesChatRequests?: boolean;
			/** 이 호출이 켜는 지켜보기의 주인. 통화만 준다 — 자기가 켠 것만 끄기 위해서다. */
			readonly watchOwner?: string;
		} = {},
	) {
		// UC8 BGM (FR-BGM.1): BgmPlayer 는 위젯(앱 아님)이라 appRegistry 소유자
		// 탐색으로 못 찾는다 — 전용 분기. executeBgmSkill 이 위젯이 이미 듣는
		// bgm_youtube_* 이벤트를 발사(위젯 무변경). 음성 경로도 이 dispatch 공유.
		// #502 실배선 (FR-ENV-LIVE.3~5): 작업 표면은 화면 앱이 아니라 상시 환경이라
		// appRegistry 소유자 탐색으로 못 찾는다 — 전용 분기.
		// 터미널 입력 권한은 사용자가 켠 경우에만 참이다(기본 꺼짐, FR-ENV-LIVE.4).
		if (req.toolName === SKILL_ENVIRONMENT.name) {
			executeEnvironmentSkill(
				req.args,
				liveEnvironmentDeps(
					loadConfig()?.environmentTerminalInput === true,
					loadConfig()?.environmentAwareness ?? "auto",
					origin.assemblesChatRequests === true,
					origin.watchOwner,
				),
			)
				.then((result) => {
					Logger.info("ChatArea", "environment skill result", {
						result: result.text,
					});
					return sendAppToolResult(
						req.requestId,
						req.toolCallId,
						result.text,
						// 거절·오류는 성공으로 바꾸지 않는다 — 뇌가 실패를 성공으로 말하는 경로를 막는다.
						// 판정은 실행기가 낸다. 문자열 접두사로 되짚으면 새 사유가 생길 때마다
						// 조용히 성공으로 새어 나간다 (2026-08-27 11차 적대리뷰에서 실제로 그랬다).
						result.ok,
						req.activityId,
					);
				})
				.catch((err) => {
					Logger.warn("ChatArea", "environment skill error", {
						error: String(err),
					});
					return sendAppToolResult(
						req.requestId,
						req.toolCallId,
						String(err),
						false,
						req.activityId,
					);
				});
			return;
		}
		if (req.toolName === SKILL_YOUTUBE_BGM.name) {
			// Activity-owned playback (for example Radio DJ change_vibe) replaces
			// the current track immediately. Normal chat requests still enqueue.
			const radioDjRequested = shouldActivateRadioDj(req.args);
			Promise.resolve()
				.then(() => (radioDjRequested ? activateRadioDjFromSkill() : undefined))
				.then(() =>
					executeBgmSkill(
						req.activityId ? { ...req.args, replace: true } : req.args,
					),
				)
				.then((result) => {
					Logger.info("ChatArea", "bgm skill result", { result });
					return sendAppToolResult(
						req.requestId,
						req.toolCallId,
						result,
						true,
						req.activityId,
					);
				})
				.catch((err) => {
					Logger.warn("ChatArea", "bgm skill error", { error: String(err) });
					return sendAppToolResult(
						req.requestId,
						req.toolCallId,
						String(err),
						false,
						req.activityId,
					);
				});
			return;
		}
		const ownerApp = appRegistry
			.list()
			.find((p) => p.tools?.some((t) => t.name === req.toolName));
		// Tool-level auto app switch (user request): if the tool belongs to a
		// app that isn't currently active, bring it forward before running.
		if (ownerApp && useAppStore.getState().activeApp !== ownerApp.id) {
			useAppStore.getState().setActiveApp(ownerApp.id);
			Logger.info("ChatArea", "app auto-switch for tool", {
				tool: req.toolName,
				app: ownerApp.id,
			});
		}
		const bridge = ownerApp ? getBridgeForApp(ownerApp.id) : activeBridge;
		Logger.info("ChatArea", "app_tool_call dispatch", {
			tool: req.toolName,
			owner: ownerApp?.id ?? "(none→activeBridge)",
		});
		bridge
			.callTool(req.toolName, req.args)
			.then((result) => {
				Logger.info("ChatArea", "app_tool_call result", {
					tool: req.toolName,
					result: result.slice(0, 120),
				});
				return sendAppToolResult(
					req.requestId,
					req.toolCallId,
					result,
					true,
					req.activityId,
				);
			})
			.catch((err) => {
				Logger.warn("ChatArea", "app_tool_call error", {
					tool: req.toolName,
					error: String(err),
				});
				return sendAppToolResult(
					req.requestId,
					req.toolCallId,
					String(err),
					false,
					req.activityId,
				);
			});
	}

	function dispatchAppControl(req: { action: string; appId?: string }) {
		const { setActiveApp } = useAppStore.getState();
		if (req.action === "switch" && req.appId) {
			setActiveApp(req.appId);
		} else if (req.action === "reload") {
			import("../lib/app-loader").then(({ loadInstalledApps }) => {
				loadInstalledApps().catch(() => {});
			});
		}
	}

	function appendVisibleResponseText(visibleText: string): void {
		if (!visibleText) return;
		useChatStore.getState().appendStreamChunk(visibleText);
		if (ttsTextSyncRef.current.active) {
			ttsTextSyncRef.current.canonical += visibleText;
		}
		// Parse emotion from accumulated text (tag may span multiple chunks)
		const accumulated = useChatStore.getState().streamingContent;
		if (accumulated.length <= 30 && accumulated.length >= 4) {
			const { emotion } = extractExpression(accumulated);
			if (emotion) setEmotion(emotion);
		}
		// Sentence-level TTS — same path for both pipeline and chat mode
		if (sentenceChunkerRef.current) {
			const sentences = sentenceChunkerRef.current.feed(visibleText);
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
	}

	function flushThinkingStream(): void {
		const tail = thinkingStreamFilterRef.current.flush();
		if (tail.thinking) {
			useChatStore.getState().appendThinkingChunk(tail.thinking);
		}
		appendVisibleResponseText(tail.visible);
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
				requestId: chunk.requestId,
				pipelineActive: pipelineActiveRef.current,
				hasChunker: !!sentenceChunkerRef.current,
			});
		}

		switch (chunk.type) {
			case "text": {
				const separated = thinkingStreamFilterRef.current.push(chunk.text);
				if (separated.thinking) {
					store.appendThinkingChunk(separated.thinking);
				}
				appendVisibleResponseText(separated.visible);
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
			case "app_tool_call": {
				// 이 경로만 셸이 대화 요청을 조립한다(buildEnvironmentSegments 가 붙는 곳).
				// 능동 발화와 실시간 음성은 아니다 — 그쪽은 기본값 false 를 그대로 쓴다.
				dispatchAppToolCall(
					{
						requestId: chunk.requestId,
						toolCallId: chunk.toolCallId,
						toolName: chunk.toolName,
						args: chunk.args,
						activityId: chunk.activityId,
					},
					{ assemblesChatRequests: true },
				);
				break;
			}
			case "app_control": {
				dispatchAppControl({
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
				const isEmptyZeroUsage =
					chunk.inputTokens === 0 &&
					chunk.outputTokens === 0 &&
					chunk.cost === 0 &&
					store.streamingContent.length === 0 &&
					store.streamingThinking.length === 0 &&
					store.streamingToolCalls.length === 0;
				// Provider failures emit usage(0) before their terminal error. Finalizing
				// the empty stream here would commit a blank assistant message, so the
				// following actionable error could no longer be attached to the turn.
				if (isEmptyZeroUsage) {
					Logger.info("ChatArea", "Deferring empty zero-token usage");
					break;
				}
				// A provider may emit usage after a tool round and before the final
				// assistant text. Keep the request streaming until its terminal finish;
				// otherwise the later text would be stranded outside the message.
				deferCostEntry({
					inputTokens: chunk.inputTokens,
					outputTokens: chunk.outputTokens,
					cost: chunk.cost,
					provider: activeProvider,
					model: chunk.model,
				});
				break;
			}
			case "finish":
				flushThinkingStream();
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
				finishStreamingWithVoiceTail();
				finishLocalVoicePrebuffer();
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
				flushThinkingStream();
				// Flush any partial sentence before finishing. Chat TTS needs the same
				// terminal behavior as pipeline voice or its mask can remain pending.
				if (sentenceChunkerRef.current) {
					const remaining = sentenceChunkerRef.current.flush();
					if (remaining) {
						Logger.info("ChatArea", "Pipeline voice flush on error", {
							remainingLen: remaining.length,
						});
						sendSentenceToTts(remaining);
					}
					if (!pipelineActiveRef.current) sentenceChunkerRef.current = null;
				}
				// #572 — 원시 오류를 답변 자리에 흘리지 않는다. 지금까지 온 본문이
				// 있으면 그대로 보존하고, 실패는 재시도를 낀 별도 알림으로 세운다.
				finishStreamingWithVoiceTail();
				useChatStore.getState().addMessage({
					role: "assistant",
					content: "",
					failure: {
						detail: wireErrorMessage(chunk.code, chunk.message),
						retryText: lastSentTextRef.current,
					},
				});
				finishLocalVoicePrebuffer();
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
			appContextBridgeRef.current?.detach();
			appContextBridgeRef.current = null;
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

	/** Route one sentence to the configured voice output. */
	function sendSentenceToTts(sentence: string): void {
		// FR-VOICE.16 (#420): all synthesized speech goes through the single
		// sentence TTS pipeline (lib/tts/sentence-pipeline). Do not add speech
		// side channels here — renderers and skills consume real playback only.
		sentencePipelineRef.current?.sendSentence(sentence);
	}

	/** Clean up pipeline voice resources. */
	function cleanupPipeline(): void {
		pipelineActiveRef.current = false;
		// 자기발화 방어 훅/기록 해제 (세션 밖 재개 방지 + 다음 세션 오탐 방지).
		sttPauseRef.current = null;
		sttResumeRef.current = null;
		audioQueueRef.current?.destroy();
		audioQueueRef.current = null;
		sentenceChunkerRef.current?.clear();
		sentenceChunkerRef.current = null;
		pipelineVoiceConfigRef.current = null;
		// Pipeline-owned lifecycle: pending requests, in-flight aborts, and the
		// recent-utterance ring used by the STT self-echo filter.
		sentencePipelineRef.current?.dispose();
		settleAvatarEmotionIfIdle();
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
				appContextBridgeRef.current?.detach();
				appContextBridgeRef.current = null;
				voiceSessionRef.current?.disconnect();
				micStreamRef.current?.stop();
				audioPlayerRef.current?.destroy();
				voiceSessionRef.current = null;
				micStreamRef.current = null;
				audioPlayerRef.current = null;
				settleAvatarEmotionIfIdle();
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
			if (
				shouldBlockDirectLiveForSpeechActivity(
					activeSpeechActivityRef.current != null,
					isOmni,
				)
			) {
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
						useCascadeAvatarStore.getState().renderer?.setSpeakingVisual(true);
						// ★재개 타이머 취소(2026-07-15 리뷰): 문장별 합성 지연으로 큐가 잠깐 비면
						// onPlaybackEnd 가 800ms 재개 타이머를 건다. 다음 문장이 그 전에 도착해
						// 재생을 시작해도 타이머는 살아 있어 재생 중 마이크를 재개통 → 자기발화 누수.
						// 재생이 (다시) 시작되면 대기 중 재개를 반드시 취소한다.
						if (sttCooldownTimerRef.current) {
							clearTimeout(sttCooldownTimerRef.current);
							sttCooldownTimerRef.current = null;
						}
						// 일반 TTS는 기존처럼 마이크를 닫아 에코를 차단한다. 선제발화 활동은 사용자가
						// 언제든 끼어들 수 있어야 하므로 STT를 유지하고 최종 transcript의 자기 에코만
						// decideSttBargeIn에서 거른다.
						try {
							if (
								shouldPauseSttForTts(activeSpeechActivityRef.current !== null)
							)
								sttPauseRef.current?.();
						} catch {
							/* 마이크 정지 실패 = 비치명 (2차 텍스트 필터가 방어) */
						}
					},
					onPlaybackEnd: () => {
						useAvatarStore.getState().setSpeaking(false);
						ttsPlayingRef.current = false;
						setTtsPlaying(false);
						useCascadeAvatarStore.getState().renderer?.setSpeakingVisual(false);
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
				sentenceChunkerRef.current = new SentenceChunker(ttsChunkerOptions);
				pipelineActiveRef.current = true;
				// Re-arm the local-voice-unavailable notice for this new session.
				sentencePipelineRef.current?.rearmLocalVoiceNotice();
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

						const ttsActive =
							ttsPlayingRef.current || Date.now() < ttsCooldownUntilRef.current;
						const selfEcho =
							cleanResult.isFinal &&
							isLikelySelfEcho(
								cleanResult.transcript,
								sentencePipelineRef.current?.recentTexts() ?? [],
							);
						const bargeIn = decideSttBargeIn({
							isFinal: cleanResult.isFinal,
							ttsActive,
							selfEcho,
						});
						if (bargeIn === "suppress") {
							Logger.info(
								"ChatArea",
								selfEcho
									? "STT result skipped (self-echo)"
									: "STT partial suppressed (TTS playing/cooldown)",
							);
							return;
						}
						if (bargeIn === "interrupt") {
							Logger.info("ChatArea", "STT user barge-in interrupts TTS");
							interruptTts();
							ttsCooldownUntilRef.current = 0;
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
			const systemPrompt = buildSystemPrompt(
				config.persona,
				memoryCtx,
				config.personaDisabled,
			);

			// Collect active app tools to pass to the voice session
			const activeAppId = useAppStore.getState().activeApp;
			const appTools = activeAppId
				? (appRegistry.get(activeAppId)?.tools ?? [])
				: [];
			const appToolDefs = appTools.map((tool) => ({
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
				// Filter: remove disabled, skip skill_app (app management, not useful in voice)
				agentSkills = allSkills.filter(
					(s) => !disabledSkills.has(s.name) && s.name !== "skill_app",
				);
			} catch (err) {
				Logger.warn("ChatArea", "Failed to fetch agent skills for voice", {
					error: String(err),
				});
			}

			// Merge app tools + agent skills (app tools take priority on name collision)
			const appNames = new Set(appToolDefs.map((t) => t.name));
			const voiceTools = [
				...appToolDefs,
				...agentSkills.filter((s) => !appNames.has(s.name)),
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
			// 이 통화의 식별자. 통화가 켠 지켜보기에만 이 표가 붙고, 통화가 끝날 때 그 표가
			// 붙은 것만 끈다. 시작 시점의 참/거짓으로는 통화 중에 다른 경로가 켠 것과
			// 구별할 수 없고, 늦게 도착한 옛 세션의 종료가 새 세션의 것을 지운다
			// (2026-08-27 12차 적대리뷰 지적).
			const voiceSessionKey = nextVoiceSessionKey();
			const session = createVoiceSession(liveProvider, {
				useProxy: useDirectMode,
			});
			voiceSessionRef.current = session;
			const abortIfSpeechActivityOwnsVoice = () => {
				if (
					!shouldAbortLiveConnectForSpeechActivity(
						activeSpeechActivityRef.current != null,
					)
				)
					return;
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

			// #313 L3 — bridge mid-session app context changes into the open
			// Live WS. Subscribes to the app store, debounces 500ms (rapid
			// URL hops), and forwards to `session.sendContextUpdate()` — a silent
			// no-op for providers without a mid-session inject surface
			// (vllm-omni, naia-omni). Detached in every cleanup path below.
			appContextBridgeRef.current = attachAppContextBridge(session, {
				subscribe: (listener) => useAppStore.subscribe(listener),
				getContext: () => useAppStore.getState().activeAppContext,
			});

			// Create audio player — UC2(V2) graft: isNewCore 시 새 core ExpressionPort(play/clearAudio) 경유.
			// drop-in(AudioPlayer-shape), 호출처(.enqueue/.clear/.destroy/.isPlaying) 무변경. old 경로 비파괴.
			const playerOpts = {
				sampleRate: 24000,
				onPlaybackStart: () => useAvatarStore.getState().setSpeaking(true),
				onPlaybackEnd: () => {
					useAvatarStore.getState().setSpeaking(false);
					settleAvatarEmotionIfIdle();
				},
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
				if (!inputTurnDirty) setEmotion("think");
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
				// 중단된 턴도 턴이다 (FR-ENV-ATTENTION.7). response.cancelled 와 barge-in 은
				// onTurnEnd 를 부르지 않으므로, 여기서 안 깎으면 사용자가 계속 끼어드는 동안
				// 지켜보기가 예산을 넘겨 살아남는다 (2026-08-27 10차 적대리뷰 지적).
				noteEnvironmentTurn();
			};
			session.onTurnEnd = () => {
				inputTurnDirty = false;
				outputTurnDirty = false;
				inputAccum = "";
				outputAccum = "";
				serverEmotionSeenThisTurn = false;
				settleAvatarEmotionIfIdle();
				// #502 (FR-ENV-ATTENTION.7): 실시간 음성도 대화 턴이다.
				//
				// 음성 도구 호출은 아래 onToolCall 이 같은 dispatch 로 보내므로, 음성 중에도
				// 나이아가 watch 를 켤 수 있다. 그런데 예산을 gRPC 경로에서만 깎으면 음성으로
				// 켠 지켜보기가 영원히 남는다 — 켜 둔 채 잊는 것을 막겠다는 규칙이 경로 하나에서
				// 성립하지 않게 된다 (2026-08-27 9차 적대리뷰 지적).
				noteEnvironmentTurn();
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
						// App-owned tools (skill_browser_*, skill_app switch)
						// only ran in streaming chat before; route them here too so
						// voice can drive apps. Auto-switches to the owner app.
						// 실시간 음성은 셸이 요청을 조립하지 않는다 — 기본값(false)이 사실이다.
						// 이 통화가 켠 지켜보기에는 통화 식별자를 남긴다(FR-ENV-ATTENTION.13).
						onAppToolCall: (req) =>
							dispatchAppToolCall(req, { watchOwner: voiceSessionKey }),
						onAppControl: (req) => dispatchAppControl(req),
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
				// 통화가 켠 주의만 통화가 끈다 (FR-ENV-ATTENTION.7).
				//
				// ⚠️ 무조건 끄면 텍스트 대화에서 켜 둔 지켜보기까지 지운다. EnvironmentSession 은
				//    모듈 전역 하나라 출처를 스스로 알지 못하므로, 통화 시작 시점의 상태를
				//    여기서 기억해 두고 그것과 비교한다 (2026-08-27 11차 적대리뷰 지적).
				environmentSession.unwatchIfOwner(voiceSessionKey);
				// Atomic terminal transition for a mid-call drop. Tear down (cost
				// summary, bridge, mic, player) SYNCHRONOUSLY first, THEN set the
				// terminal status once — so the derived voice button can't re-enable
				// against a half-cleaned session, and the close reason isn't lost to
				// a state thrash. showVoiceCostSummary is idempotent, so a
				// user-initiated stop that also runs the toggle path stays safe.
				showVoiceCostSummary();
				appContextBridgeRef.current?.detach();
				appContextBridgeRef.current = null;
				micStreamRef.current?.stop();
				audioPlayerRef.current?.destroy();
				voiceSessionRef.current = null;
				micStreamRef.current = null;
				audioPlayerRef.current = null;
				settleAvatarEmotionIfIdle();
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
				if (
					!activateMicUnlessSpeechActivityOwnsVoice(
						mic,
						activeSpeechActivityRef.current != null,
						voiceCancelledRef.current,
					)
				) {
					const error = new Error(
						"speech activity owns the grounded voice lane",
					);
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
			appContextBridgeRef.current?.detach();
			appContextBridgeRef.current = null;
			voiceSessionRef.current?.disconnect();
			micStreamRef.current?.stop();
			audioPlayerRef.current?.destroy();
			voiceSessionRef.current = null;
			micStreamRef.current = null;
			audioPlayerRef.current = null;
			settleAvatarEmotionIfIdle();
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

	useEffect(() => {
		const openDiscordInbox = () => setActiveTab("channels");
		window.addEventListener("naia-open-discord-inbox", openDiscordInbox);
		return () =>
			window.removeEventListener("naia-open-discord-inbox", openDiscordInbox);
	}, []);

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
					appRegistry.get("workspace") !== undefined
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
		if (atMentionOpen) {
			if (atMentionRef.current?.handleKeyDown(e)) {
				e.preventDefault();
				return;
			}
			// The popover is code-split. Do not accidentally send the message if
			// Enter/Tab arrives during the brief interval before its ref attaches.
			if (["Enter", "Tab", "ArrowDown", "ArrowUp"].includes(e.key)) {
				e.preventDefault();
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				handleAtMentionClose();
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
			<div className={`chat-app chat-app--${variant}`}>
				{/* Header with tabs */}
				<div className="chat-header">
					<div className="chat-tabs">
						<button
							type="button"
							className={`chat-tab${activeTab === "chat" ? " active" : ""}`}
							data-chat-tab="chat"
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
							data-chat-tab="history"
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
							data-chat-tab="channels"
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

				<Suspense fallback={null}>
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
					{activeTab === "channels" && <ChannelsTab />}

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
				</Suspense>

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
											<span className="thinking-inline-preview">
												{msg.thinking.trim()}
											</span>
										</summary>
										<div className="thinking-inline-content">
											{msg.thinking}
										</div>
									</details>
								)}
								{msg.toolCalls?.map((tc) => (
									<DeferredToolActivity key={tc.toolCallId} tool={tc} />
								))}
								{msg.failure ? (
									<ChatErrorNotice
										detail={msg.failure.detail}
										onRetry={() => {
											const retryText = msg.failure?.retryText ?? "";
											if (retryText) handleSend(retryText);
										}}
									/>
								) : (
									<div className="message-content">
										{msg.role === "assistant" ? (
											// #571 — 음성 상태와 무관하게 본문을 그대로 그린다.
											<DeferredChatMarkdown>
												{extractExpression(msg.content).cleanText}
											</DeferredChatMarkdown>
										) : (
											msg.content
										)}
									</div>
								)}
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
								<details className="thinking-inline">
									<summary className="thinking-inline-summary">
										<span className="thinking-inline-label">
											💭 {t("chat.thinking") || "Thinking..."}
										</span>
										<span className="thinking-inline-preview thinking-inline-preview-live">
											<span>{streamingThinking.trim()}</span>
										</span>
									</summary>
									<div className="thinking-inline-content">
										{streamingThinking}
									</div>
								</details>
							)}
							{streamingToolCalls.map((tc) => (
								<DeferredToolActivity key={tc.toolCallId} tool={tc} />
							))}
							<div className="message-content">
								{streamingContent ? (
									// #571 — 스트리밍 본문도 TTS 큐를 기다리지 않는다.
									<DeferredChatMarkdown>
										{extractExpression(streamingContent).cleanText}
									</DeferredChatMarkdown>
								) : null}
								<span className="cursor-blink">▌</span>
							</div>
						</div>
					)}

					{outputStage && (
						<output
							className="chat-output-stage"
							aria-live="polite"
							aria-atomic="true"
							data-stage={outputStage}
						>
							<span className="voice-status-spinner" aria-hidden="true" />
							<span>
								{voiceModelPreparing
									? t("chat.outputStage.voiceInit")
									: t(`chat.outputStage.${outputStage}`)}
							</span>
						</output>
					)}

					<div ref={messagesEndRef} />
				</div>

				{/* Permission Modal */}
				{pendingApproval && (
					<Suspense fallback={null}>
						<PermissionModal
							pending={pendingApproval}
							onDecision={handleApprovalDecision}
						/>
					</Suspense>
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
						<Suspense fallback={null}>
							<AtMentionPopover
								ref={atMentionRef}
								query={atMentionQuery}
								onSelect={handleAtMentionSelect}
								onClose={handleAtMentionClose}
							/>
						</Suspense>
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
					{isStreaming || outputStage !== null || ttsPlaying ? (
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
