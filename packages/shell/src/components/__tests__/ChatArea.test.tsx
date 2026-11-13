import { listen } from "@tauri-apps/api/event";
import { ensureBgmSidecar } from "../../lib/bgm-sidecar-url";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appRegistry } from "../../lib/app-registry";
import {
	clearCameraActions,
	registerCameraActions,
} from "../../lib/avatar/camera-actions";
import {
	fetchAgentSkills,
	isNewCore,
	sendChatMessage,
	sendAppSkillsClear,
	cancelChat,
} from "../../lib/chat-service";
import { SLIDE_PRESENTER_CANCEL_EVENT, SLIDE_PRESENTER_SPEECH_RESULT_EVENT, SLIDE_PRESENTER_SPEAK_EVENT } from "../../lib/slide-presenter-events";
import type { AgentResponseChunk, EnvironmentSegment } from "../../lib/types";
import * as voiceSessionApi from "../../lib/voice/index";
import type { VoiceSession } from "../../lib/voice/index";
import { setAlignedSpeechPlanSource } from "../../lib/avatar/nva-speech/speech-timing";
import { useAppStore } from "../../stores/app";
import { useAvatarStore } from "../../stores/avatar";
import { useCascadeAvatarStore } from "../../stores/cascade-avatar";
import { useChatStore } from "../../stores/chat";
import { ChatArea, modelToolBoundary } from "../ChatArea";
import {
	resetWebModelStatusForTests,
	setWebModelStatus,
} from "../../lib/web-runtime/web-model-status";
import {
	resetWebAdkStatusForTests,
	setWebAdkStatus,
} from "../../lib/web-runtime/web-adk-status";
import { BGM_APP_ID, SKILL_YOUTUBE_BGM } from "../../lib/bgm-skill";
import { requestKioskGreeting } from "../../lib/kiosk-demo/entry";
import {
	getKioskIrSlide,
	registerKioskSlidesController,
} from "../../lib/kiosk-demo/slides";
import { setWebAssetsModeForTests } from "../../lib/web-runtime/web-assets";

const ttsSyncMocks = vi.hoisted(() => ({
	synthesizeTts: vi.fn().mockResolvedValue({
		audioBase64: "default-audio",
		costUsd: 0,
	}),
	streamsAvatarPcm: vi.fn(() => false),
	enqueueOrdered: vi.fn(),
	skipOrdered: vi.fn(),
	clear: vi.fn(),
	destroy: vi.fn(),
	pauseBeforePlayback: vi.fn(),
	resumePlayback: vi.fn(),
	wavDurationSeconds: vi.fn(() => 10),
	nextSeq: 0,
	audioQueueActive: false,
	audioQueueCallbacks: null as null | {
		onPlaybackStart?: () => void;
		onPlaybackEnd?: () => void;
	},
}));
const mockSendAppSkills = vi.hoisted(() => vi.fn().mockResolvedValue(true));
const mockResetKioskMemory = vi.hoisted(() => vi.fn());
vi.mock("../../lib/kiosk-demo/memory", () => ({ resetKioskMemory: mockResetKioskMemory }));


vi.mock("../../lib/tts/synthesize", () => ({
	synthesizeTts: ttsSyncMocks.synthesizeTts,
	streamsAvatarPcm: ttsSyncMocks.streamsAvatarPcm,
}));

vi.mock("../../lib/voice/audio-queue", () => ({
	AudioQueue: class {
		constructor(
			callbacks: {
				onPlaybackStart?: () => void;
				onPlaybackEnd?: () => void;
			} = {},
		) {
			ttsSyncMocks.audioQueueCallbacks = callbacks;
		}
		get isActive() {
			return ttsSyncMocks.audioQueueActive;
		}
		reserveSeq() {
			const seq = ttsSyncMocks.nextSeq;
			ttsSyncMocks.nextSeq += 1;
			return seq;
		}
		enqueueOrdered(seq: number, audio: string, callbacks?: unknown) {
			ttsSyncMocks.audioQueueActive = true;
			ttsSyncMocks.enqueueOrdered(seq, audio, callbacks);
		}
		skipOrdered(seq: number) {
			ttsSyncMocks.skipOrdered(seq);
		}
		pauseBeforePlayback() {
			ttsSyncMocks.pauseBeforePlayback();
		}
		resumePlayback() {
			ttsSyncMocks.resumePlayback();
		}
		clear() {
			ttsSyncMocks.nextSeq = 0;
			ttsSyncMocks.audioQueueActive = false;
			ttsSyncMocks.clear();
		}
		destroy() {
			ttsSyncMocks.destroy();
		}
	},
	wavDurationSeconds: ttsSyncMocks.wavDurationSeconds,
}));

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

vi.mock("@tauri-apps/plugin-store", () => {
	const store = {
		get: vi.fn().mockResolvedValue(null),
		set: vi.fn().mockResolvedValue(undefined),
		delete: vi.fn().mockResolvedValue(undefined),
	};
	return { load: vi.fn().mockResolvedValue(store) };
});

// Mock chat-service — capture onChunk callback
let capturedOnChunk: ((chunk: AgentResponseChunk) => void) | null = null;
const capturedRequests: {
	message: string;
	provider?: {
		provider?: string;
		model?: string;
		ollamaNumCtx?: number;
	};
	history: { role: "user" | "assistant"; content: string }[];
	requestId: string;
	onChunk: (chunk: AgentResponseChunk) => void;
	disabledSkills?: string[];
	enableTools?: boolean;
	enableThinking?: boolean;
	thinking?: { level: "off" | "low" | "high" };
	environmentSegments?: EnvironmentSegment[];
}[] = [];
vi.mock("../../lib/chat-service", () => ({
	sendChatMessage: vi.fn().mockImplementation(
		(opts: {
			message: string;
			history: { role: "user" | "assistant"; content: string }[];
			requestId: string;
			onChunk: (chunk: AgentResponseChunk) => void;
			disabledSkills?: string[];
			enableTools?: boolean;
			enableThinking?: boolean;
			thinking?: { level: "off" | "low" | "high" };
			environmentSegments?: EnvironmentSegment[];
		}) => {
			capturedOnChunk = opts.onChunk;
			capturedRequests.push(opts);
			return Promise.resolve();
		},
	),
	cancelChat: vi.fn().mockResolvedValue(undefined),
	directToolCall: vi.fn().mockResolvedValue({ success: false }),
	fetchAgentSkills: vi.fn().mockResolvedValue([]),
	sendAppSkills: mockSendAppSkills,
	sendAppSkillsClear: vi.fn().mockResolvedValue(true),
	sendApprovalResponse: vi.fn().mockResolvedValue(undefined),
	sendAppToolResult: vi.fn().mockResolvedValue(undefined),
	configureSpeechProfile: vi.fn().mockResolvedValue(undefined),
	yieldSpeechActivity: vi.fn().mockResolvedValue(undefined),
	controlSpeechActivity: vi.fn().mockResolvedValue(undefined),
	stopSpeechActivity: vi.fn().mockResolvedValue(undefined),
	// 슬라이스1(isNewCore 도입) 이후 ChatArea 이 호출 — mock 누락 시 throw 로 8건 RED 였음.
	// 기본 false = 비-새-core(기존 sendChatMessage 경로) — 이 테스트들의 원래 가정 유지.
	isNewCore: vi.fn(() => false),
}));

vi.mock("../../lib/bgm-sidecar-url", () => ({
	ensureBgmSidecar: vi.fn().mockResolvedValue("http://localhost:18791"),
	bgmSidecarBaseUrl: () => "http://localhost:18791",
	BGM_SIDECAR_BASE_URL: "http://localhost:18791",
}));

// Mock Tauri APIs (needed by approval flow)
const mockInvoke = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/api/core", () => ({
	invoke: (command: string, args?: { name?: string }) => {
		// These component fixtures describe credentials separately from native I/O.
		// The real secure-store isolation contract is exercised in its own suite.
		if (command === "secure_store_get") {
			const fixture = JSON.parse(localStorage.getItem("naia-config") || "{}");
			return Promise.resolve(fixture[args?.name ?? ""] ?? null);
		}
		return mockInvoke(command, args);
	},
}));
vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn().mockResolvedValue(() => {}),
	emit: vi.fn().mockResolvedValue(undefined),
}));

// Mock gateway-sessions (SoT for session loading)
vi.mock("../../lib/gateway-sessions", () => ({
	getGatewayHistory: vi.fn().mockResolvedValue([]),
	resetGatewaySession: vi.fn().mockResolvedValue(true),
	patchGatewaySession: vi.fn().mockResolvedValue(true),
}));

// Mock Audio element (not available in jsdom)
vi.stubGlobal(
	"Audio",
	class {
		src = "";
		onended: (() => void) | null = null;
		onerror: (() => void) | null = null;
		play() {
			return Promise.resolve();
		}
	},
);

class FakeSpeechRecognition {
	static latest: FakeSpeechRecognition | null = null;
	onresult: ((event: unknown) => void) | null = null;
	onerror: ((event: { error: string; message: string }) => void) | null = null;
	lang = "";
	continuous = false;
	interimResults = false;
	maxAlternatives = 0;
	start = vi.fn();
	stop = vi.fn();
	abort = vi.fn();

	emitResult(
		results: { transcript: string; confidence?: number; isFinal: boolean }[],
	) {
		const resultList = results.map((r) => {
			const alt = { transcript: r.transcript, confidence: r.confidence ?? 1 };
			const item = Object.assign([alt], {
				isFinal: r.isFinal,
				length: 1,
				item: (index: number) => (index === 0 ? alt : undefined),
			});
			return item;
		});
		this.onresult?.({
			resultIndex: 0,
			results: Object.assign(resultList, { length: resultList.length }),
		});
	}

	constructor() {
		FakeSpeechRecognition.latest = this;
	}
}

describe("ChatArea", () => {
	beforeEach(() => {
		vi.mocked(listen).mockResolvedValue(() => {});
		vi.mocked(sendChatMessage).mockImplementation(async (opts) => {
			capturedOnChunk = opts.onChunk;
			capturedRequests.push(opts as (typeof capturedRequests)[number]);
		});
		vi.mocked(sendAppSkillsClear).mockResolvedValue(true);
		vi.mocked(cancelChat).mockResolvedValue(undefined);
		vi.mocked(ensureBgmSidecar).mockResolvedValue("http://localhost:18791");
		localStorage.setItem("naia-adk-path", "/tmp/chat-area-test-adk");
		mockSendAppSkills.mockReset().mockResolvedValue(true);
		vi.mocked(fetchAgentSkills).mockResolvedValue([]);
		modelToolBoundary.reset();
		resetWebModelStatusForTests();
		resetWebAdkStatusForTests();
	});
	afterEach(() => {
		cleanup();
		clearCameraActions();
		Reflect.deleteProperty(window, "SpeechRecognition");
		Reflect.deleteProperty(window, "webkitSpeechRecognition");
		FakeSpeechRecognition.latest = null;
		capturedOnChunk = null;
		capturedRequests.length = 0;
		vi.clearAllMocks();
		vi.restoreAllMocks();
		setAlignedSpeechPlanSource(null);
		modelToolBoundary.reset();
		vi.mocked(isNewCore).mockReturnValue(false);
		mockInvoke.mockResolvedValue(undefined);
		useChatStore.setState(useChatStore.getInitialState());
		useAvatarStore.setState(useAvatarStore.getInitialState());
		useCascadeAvatarStore.setState(useCascadeAvatarStore.getInitialState());
		useAppStore.setState({ activeApp: null });
		ttsSyncMocks.nextSeq = 0;
		ttsSyncMocks.audioQueueActive = false;
		ttsSyncMocks.audioQueueCallbacks = null;
		ttsSyncMocks.streamsAvatarPcm.mockReturnValue(false);
		ttsSyncMocks.wavDurationSeconds.mockReturnValue(10);
		ttsSyncMocks.synthesizeTts.mockResolvedValue({
			audioBase64: "default-audio",
			costUsd: 0,
		});
		resetWebModelStatusForTests();
		setWebAssetsModeForTests(null);
		vi.unstubAllEnvs();
		vi.mocked(ensureBgmSidecar).mockReset().mockResolvedValue("http://localhost:18791");
	});

	it("kiosk reset blocks duplicates and offers retry after safe storage failure", async () => {
		vi.stubEnv("MODE", "web");
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "1");
		let rejectReset!: (error: Error) => void;
		mockResetKioskMemory.mockImplementationOnce(() => new Promise<void>((_, reject) => { rejectReset = reject; }));
		render(<ChatArea />);
		const reset = screen.getByRole("button", { name: "처음으로" });
		fireEvent.click(reset);
		await waitFor(() => expect(mockResetKioskMemory).toHaveBeenCalledOnce());
		expect((reset as HTMLButtonElement).disabled).toBe(true);
		fireEvent.click(reset);
		expect(mockResetKioskMemory).toHaveBeenCalledOnce();
		await act(async () => rejectReset(new Error("private storage detail")));
		expect((await screen.findByText(/기억을 초기화하지 못했어요/)).getAttribute("role")).toBe("alert");
		expect(screen.queryByText(/private storage detail/)).toBeNull();
		expect((reset as HTMLButtonElement).disabled).toBe(false);
		mockResetKioskMemory.mockRejectedValueOnce(new Error("still unavailable"));
		fireEvent.click(reset);
		await waitFor(() => expect(mockResetKioskMemory).toHaveBeenCalledTimes(2));
	});

	it("S5: kiosk demo greeting respects config ttsProvider (nextain gateway) in web mode", async () => {
		setWebAssetsModeForTests(true);
		vi.stubEnv("MODE", "web");
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "1");
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				agentName: "지나",
				ttsEnabled: true,
				ttsProvider: "nextain",
				ttsVoice: "ko-KR-Neural2-A",
			}),
		);
		requestKioskGreeting();
		render(<ChatArea />);
		await waitFor(() => expect(ttsSyncMocks.synthesizeTts).toHaveBeenCalled());
		expect(ttsSyncMocks.synthesizeTts).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "nextain",
				voice: "naia-voice:tpl-jina",
			}),
		);
	});

	describe("kiosk first greeting mouth and wave order (r13)", () => {
		const greetingPlan = {
			version: "1",
			quality_mode: "aligned",
			audio: { duration_us: 500_000 },
			events: [{ unit: "sil", start_us: 0, end_us: 500_000 }],
		} as never;
		type GreetingCallbacks = {
			beforePlayback?: () => Promise<unknown>;
			onPlaybackStart?: (playback?: { clock: () => number }) => void;
		};
		function enterKioskWithRenderer() {
			setWebAssetsModeForTests(true);
			vi.stubEnv("MODE", "web");
			vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "1");
			localStorage.setItem(
				"naia-config",
				JSON.stringify({
					agentName: "지나",
					ttsEnabled: true,
					ttsProvider: "nextain",
				}),
			);
			const wave: { end: () => void } = { end: () => {} };
			const play = vi.fn(async () => true);
			const renderer = {
				hasAuthoredClip: () => false,
				playAuthoredClip: vi.fn(),
				setSpeakingVisual: vi.fn(),
				playSpeechTiming: vi.fn(async () => true),
				interrupt: vi.fn(),
				stop: vi.fn(),
				canPlaySpeechPlans: () => true,
				prepareSpeechTiming: vi.fn(async () => ({ play })),
				warmSpeechAssets: vi.fn(async () => {}),
				playGreetingAction: vi.fn(
					async (options?: { onEnded?: () => void }) => {
						wave.end = () => options?.onEnded?.();
						return "greeting";
					},
				),
			};
			useCascadeAvatarStore.setState({ renderer: renderer as never });
			requestKioskGreeting();
			return { renderer, wave, play };
		}
		const settled = async (promise: Promise<unknown> | undefined) => {
			let done = false;
			void promise?.then(() => {
				done = true;
			});
			await new Promise((resolve) => setTimeout(resolve, 20));
			return done;
		};

		it("asks for a mouth plan and holds the sound until the wave ends", async () => {
			const aligned = vi.fn(async () => greetingPlan);
			setAlignedSpeechPlanSource(aligned);
			const { renderer, wave, play } = enterKioskWithRenderer();
			render(<ChatArea />);
			await waitFor(() =>
				expect(ttsSyncMocks.enqueueOrdered).toHaveBeenCalledTimes(1),
			);
			expect(aligned).toHaveBeenCalledWith(
				expect.objectContaining({
					text: expect.stringContaining("안내를 맡은 지나입니다"),
				}),
			);
			// The wave waits for the voice: nothing waved while it was synthesized.
			expect(renderer.playGreetingAction).not.toHaveBeenCalled();
			const callbacks = ttsSyncMocks.enqueueOrdered.mock
				.calls[0][2] as GreetingCallbacks;
			const gate = callbacks.beforePlayback?.();
			await waitFor(() =>
				expect(renderer.playGreetingAction).toHaveBeenCalledTimes(1),
			);
			expect(renderer.prepareSpeechTiming).toHaveBeenCalledTimes(1);
			expect(await settled(gate)).toBe(false);
			wave.end();
			await gate;
			const clock = () => 0;
			callbacks.onPlaybackStart?.({ clock });
			await waitFor(() => expect(play).toHaveBeenCalledWith(clock));
			expect(renderer.playGreetingAction).toHaveBeenCalledTimes(1);
		});

		it("speech plan 400: the sound is not held and the wave plays alongside", async () => {
			const aligned = vi.fn(async () => {
				throw new Error("speech plan HTTP 400");
			});
			setAlignedSpeechPlanSource(aligned);
			const { renderer } = enterKioskWithRenderer();
			render(<ChatArea />);
			await waitFor(() =>
				expect(ttsSyncMocks.enqueueOrdered).toHaveBeenCalledTimes(1),
			);
			expect(aligned).toHaveBeenCalledTimes(1);
			const callbacks = ttsSyncMocks.enqueueOrdered.mock
				.calls[0][2] as GreetingCallbacks;
			// Resolves with the wave still running (never ended in this test).
			await callbacks.beforePlayback?.();
			expect(renderer.playGreetingAction).toHaveBeenCalledTimes(1);
			expect(renderer.prepareSpeechTiming).not.toHaveBeenCalled();
			callbacks.onPlaybackStart?.({ clock: () => 0 });
			expect(renderer.playSpeechTiming).not.toHaveBeenCalled();
			expect(
				useChatStore
					.getState()
					.messages.some((m) => m.content.includes("안내를 맡은 지나입니다")),
			).toBe(true);
		});

		it("voice failure: the greeting text and wave still come out", async () => {
			setAlignedSpeechPlanSource(vi.fn(async () => greetingPlan));
			ttsSyncMocks.synthesizeTts.mockRejectedValue(new Error("tts 502"));
			const { renderer, wave } = enterKioskWithRenderer();
			render(<ChatArea />);
			await waitFor(() =>
				expect(renderer.playGreetingAction).toHaveBeenCalledTimes(1),
			);
			wave.end();
			await waitFor(() =>
				expect(ttsSyncMocks.skipOrdered).toHaveBeenCalledTimes(1),
			);
			expect(ttsSyncMocks.enqueueOrdered).not.toHaveBeenCalled();
			expect(
				useChatStore
					.getState()
					.messages.some((m) => m.content.includes("안내를 맡은 지나입니다")),
			).toBe(true);
		});
	});

	it("hides message cost-badge in kiosk mode and shows it in normal web mode", () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "nextain",
				model: "gpt-6.1-terra",
			}),
		);
		useChatStore.getState().setMessages([
			{
				id: "m-cost-1",
				role: "assistant",
				content: "답변입니다.",
				timestamp: 1000,
				cost: {
					provider: "nextain",
					model: "gpt-6.1-terra",
					inputTokens: 0,
					outputTokens: 0,
					cost: 0,
				},
			},
		]);

		vi.stubEnv("MODE", "web");
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "1");
		const { container: kioskContainer, unmount } = render(<ChatArea />);
		expect(kioskContainer.querySelector(".cost-badge")).toBeNull();
		unmount();

		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "0");
		const { container: normalContainer } = render(<ChatArea />);
		expect(normalContainer.querySelector(".cost-badge")).not.toBeNull();
		expect(normalContainer.querySelector(".cost-badge")?.textContent).toContain(
			"0",
		);
	});

	it("renders input field and buttons", () => {
		render(<ChatArea />);
		expect(screen.getByPlaceholderText(/메시지|message/i)).toBeDefined();
		const buttons = screen.getAllByRole("button");
		expect(buttons.length).toBeGreaterThanOrEqual(2);
	});

	it("blocks local Ollama chat when its fresh runtime status is unreserved", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "ollama",
				model: "qwen3:8b",
				ollamaHost: "http://localhost:11434",
			}),
		);
		mockInvoke.mockImplementation((command: string) =>
			command === "ollama_runtime_status"
				? Promise.resolve({
						serverState: "connected_unreserved",
						reservation: {
							kind: "local_llm",
							status: "denied",
							bytes: null,
							reasonCode: "same_device_conflict",
						},
						error: {
							code: "reservation_denied",
							reasonCode: "same_device_conflict",
						},
					})
				: Promise.resolve(undefined),
		);
		const { sendChatMessage } = await import("../../lib/chat-service");
		vi.mocked(sendChatMessage).mockClear();
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/메시지|message/i);
		fireEvent.change(input, { target: { value: "hello local model" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => {
			expect(mockInvoke).toHaveBeenCalledWith(
				"ollama_runtime_status",
				expect.objectContaining({ host: "http://localhost:11434" }),
			);
		});
		expect(sendChatMessage).not.toHaveBeenCalled();
		expect(capturedRequests).toHaveLength(0);
	});

	it("admits local Ollama chat only with a running LocalLlm lease", async () => {
		const confirmedTag = "huihui_ai/qwen3.5-abliterated:2B";
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "ollama",
				model: confirmedTag,
				ollamaHost: "http://localhost:11434",
			}),
		);
		mockInvoke.mockImplementation((command: string) => {
			if (command === "ollama_runtime_status") {
				return Promise.resolve({
					serverState: "ready_managed",
					reservation: {
						kind: "local_llm",
						status: "running",
						bytes: null,
					},
				});
			}
			if (command === "ollama_model_catalog_list") {
				return Promise.resolve({
					candidates: [{ tag: confirmedTag }],
					contextDefaultTokens: 8192,
				});
			}
			return Promise.resolve(undefined);
		});
		const { sendChatMessage } = await import("../../lib/chat-service");
		vi.mocked(sendChatMessage).mockClear();
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/메시지|message/i);
		fireEvent.change(input, { target: { value: "hello local model" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => expect(sendChatMessage).toHaveBeenCalledTimes(1));
		expect(capturedRequests[0]?.provider).toMatchObject({
			provider: "ollama",
			model: confirmedTag,
			ollamaHost: "http://localhost:11434",
			ollamaNumCtx: 8192,
		});
	});

	it("preserves context settings for a managed noncatalog Ollama model", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "ollama",
				model: "qwen3:8b",
				ollamaHost: "http://localhost:11434",
			}),
		);
		mockInvoke.mockImplementation((command: string) => {
			if (command === "ollama_runtime_status") {
				return Promise.resolve({
					serverState: "ready_managed",
					reservation: { kind: "local_llm", status: "running", bytes: null },
				});
			}
			if (command === "ollama_model_catalog_list") {
				return Promise.resolve({
					candidates: [{ tag: "huihui_ai/qwen3.5-abliterated:4B" }],
					contextDefaultTokens: 8192,
				});
			}
			return Promise.resolve(undefined);
		});
		const { sendChatMessage } = await import("../../lib/chat-service");
		vi.mocked(sendChatMessage).mockClear();
		render(<ChatArea />);
		fireEvent.change(screen.getByPlaceholderText(/메시지|message/i), {
			target: { value: "hello other local model" },
		});
		fireEvent.keyDown(screen.getByPlaceholderText(/메시지|message/i), {
			key: "Enter",
		});

		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		expect(capturedRequests[0]?.provider).toMatchObject({
			provider: "ollama",
			model: "qwen3:8b",
		});
		expect(capturedRequests[0]?.provider?.ollamaNumCtx).toBeUndefined();
	});

	it("cleans up the pipeline when Web Speech reports a permission error", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "ollama",
				model: "qwen3:8b",
				sttProvider: "web-speech",
				sttModel: "",
				ttsEnabled: true,
			}),
		);
		Object.defineProperty(window, "SpeechRecognition", {
			configurable: true,
			value: FakeSpeechRecognition,
		});

		render(<ChatArea />);
		fireEvent.click(
			document.querySelector(".chat-voice-btn") as HTMLButtonElement,
		);

		await waitFor(() =>
			expect(FakeSpeechRecognition.latest?.start).toHaveBeenCalledTimes(1),
		);
		FakeSpeechRecognition.latest?.onerror?.({
			error: "not-allowed",
			message: "Permission denied",
		});

		await waitFor(() => {
			expect(useChatStore.getState().messages.at(-1)?.content).toContain(
				"Voice connection failed: not-allowed: Permission denied",
			);
		});
		expect(FakeSpeechRecognition.latest?.abort).toHaveBeenCalledTimes(1);
		expect(FakeSpeechRecognition.latest?.onerror).toBeNull();
		expect(document.querySelector(".chat-voice-btn")?.className).not.toContain(
			"active",
		);
	});

	it("does not send while the lazy at-mention picker is opening", () => {
		vi.spyOn(appRegistry, "get").mockReturnValueOnce({} as never);
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/메시지|message/i);

		fireEvent.change(input, {
			target: { value: "@", selectionStart: 1 },
		});
		fireEvent.keyDown(input, { key: "Enter" });

		expect(capturedRequests).toHaveLength(0);
	});

	it("interrupts the active speech pipeline when the global TTS toggle turns off", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({ ttsEnabled: true, ttsProvider: "edge" }),
		);
		useAvatarStore.getState().setSpeaking(true);
		render(<ChatArea />);

		window.dispatchEvent(
			new CustomEvent("naia:tts-enabled-change", {
				detail: { enabled: false },
			}),
		);

		await waitFor(() =>
			expect(useAvatarStore.getState().isSpeaking).toBe(false),
		);
		localStorage.removeItem("naia-config");
	});

	it("drops a deferred AI gesture when the global TTS toggle turns off", async () => {
		const playAction = vi.fn().mockResolvedValue(true);
		registerCameraActions({
			getGestureActions: () => [{ key: "wave", label: "Wave" }],
			playAction,
		});
		useCascadeAvatarStore.getState().setRenderer({
			interrupt: vi.fn(),
			hasAuthoredClip: vi.fn(() => false),
			setSpeakingVisual: vi.fn(),
		} as never);
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: true,
			}),
		);
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "first request" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: "Hello [[gesture:wave]]",
		});
		request.onChunk({ type: "finish", requestId: request.requestId });
		await waitFor(() => expect(ttsSyncMocks.enqueueOrdered).toHaveBeenCalled());
		window.dispatchEvent(
			new CustomEvent("naia:tts-enabled-change", {
				detail: { enabled: false },
			}),
		);
		act(() => {
			ttsSyncMocks.audioQueueActive = false;
			ttsSyncMocks.audioQueueCallbacks?.onPlaybackEnd?.();
		});
		expect(playAction).not.toHaveBeenCalled();
		localStorage.removeItem("naia-config");
	});

	it("drops a deferred AI gesture when slide narration interrupts TTS", async () => {
		const playAction = vi.fn().mockResolvedValue(true);
		registerCameraActions({
			getGestureActions: () => [{ key: "wave", label: "Wave" }],
			playAction,
		});
		useCascadeAvatarStore.getState().setRenderer({
			interrupt: vi.fn(),
			hasAuthoredClip: vi.fn(() => false),
			setSpeakingVisual: vi.fn(),
		} as never);
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: true,
			}),
		);
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "first request" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: "Hello [[gesture:wave]]",
		});
		request.onChunk({ type: "finish", requestId: request.requestId });
		await waitFor(() => expect(ttsSyncMocks.enqueueOrdered).toHaveBeenCalled());
		window.dispatchEvent(
			new CustomEvent(SLIDE_PRESENTER_SPEAK_EVENT, {
				detail: {
					requestId: "slide-speak-gesture",
					generation: 1,
					page: 1,
					text: "Slide narration",
				},
			}),
		);
		act(() => {
			ttsSyncMocks.audioQueueActive = false;
			ttsSyncMocks.audioQueueCallbacks?.onPlaybackEnd?.();
		});
		expect(playAction).not.toHaveBeenCalled();
		localStorage.removeItem("naia-config");
	});

	it("shows think while waiting and returns to neutral when a silent turn finishes", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
			}),
		);
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "complex question" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		expect(useAvatarStore.getState().currentEmotion).toBe("think");
		const request = capturedRequests[0];
		request.onChunk({ type: "finish", requestId: request.requestId });
		expect(useAvatarStore.getState().currentEmotion).toBe("neutral");
		localStorage.removeItem("naia-config");
	});

	it("routes the structured main role when the flat provider mirror is stale", async () => {
		vi.mocked(isNewCore).mockReturnValue(true);
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "gemini",
				model: "gemini-2.5-flash",
				llmRoles: {
					main: { provider: "nextain", model: "deepseek-v4-flash" },
				},
				enableTools: false,
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "structured role route" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		expect(capturedRequests[0].provider).toMatchObject({
			provider: "nextain",
			model: "deepseek-v4-flash",
		});
		localStorage.removeItem("naia-config");
	});

	it("does not send and shows the three-way guide when no LLM is configured (FR-LLM-LOGOUT.2)", async () => {
		vi.mocked(isNewCore).mockReturnValue(true);
		localStorage.setItem(
			"naia-config",
			JSON.stringify({ provider: "", model: "", enableTools: false }),
		);
		const before = capturedRequests.length;

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "hello without llm" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => {
			const last = useChatStore.getState().messages.at(-1);
			expect(last?.role).toBe("assistant");
		});
		const guide = useChatStore.getState().messages.at(-1)?.content ?? "";
		expect(guide).toMatch(/Naia/);
		expect(guide).toMatch(/Ollama/);
		expect(guide).toMatch(/CLI/);
		expect(capturedRequests.length).toBe(before);
		localStorage.removeItem("naia-config");
	});

	it("preserves a dynamically catalogued structured main model", async () => {
		vi.mocked(isNewCore).mockReturnValue(true);
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "gemini",
				model: "gemini-2.5-flash",
				llmRoles: {
					main: { provider: "nextain", model: "gemini-3.7-flash" },
				},
				enableTools: false,
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "dynamic gateway model" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		expect(capturedRequests[0].provider).toMatchObject({
			provider: "nextain",
			model: "gemini-3.7-flash",
		});
		localStorage.removeItem("naia-config");
	});

	it("shows the provider error when a zero-token usage event precedes failure", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "invalid-test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
			}),
		);
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "certification probe" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		request.onChunk({
			type: "usage",
			requestId: request.requestId,
			inputTokens: 0,
			outputTokens: 0,
			cost: 0,
			model: "gemini-2.5-flash",
		});
		request.onChunk({
			type: "error",
			requestId: request.requestId,
			message: "provider rejected the API key",
		});

		// #572 — 원문은 답변 본문이 아니라 실패 표시의 접힌 상세로 간다.
		await waitFor(() =>
			expect(
				useChatStore.getState().messages.at(-1)?.failure?.detail,
			).toContain("provider rejected the API key"),
		);
		expect(useChatStore.getState().messages.at(-1)?.content).toBe("");
		expect(useChatStore.getState().isStreaming).toBe(false);
		localStorage.removeItem("naia-config");
	});

	it("keeps an explicit emotion until queued speech ends", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: true,
				ttsProvider: "edge",
			}),
		);
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "tell me good news" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: "[HAPPY] Great news!",
		});
		await waitFor(() => expect(ttsSyncMocks.synthesizeTts).toHaveBeenCalled());
		await waitFor(() => expect(ttsSyncMocks.enqueueOrdered).toHaveBeenCalled());
		expect(useAvatarStore.getState().currentEmotion).toBe("happy");

		request.onChunk({ type: "finish", requestId: request.requestId });
		expect(useAvatarStore.getState().currentEmotion).toBe("happy");

		ttsSyncMocks.audioQueueActive = false;
		ttsSyncMocks.audioQueueCallbacks?.onPlaybackEnd?.();
		expect(useAvatarStore.getState().currentEmotion).toBe("neutral");
		localStorage.removeItem("naia-config");
	});

	it("does not send a turn when pre-turn BGM skill registration fails", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
			}),
		);
		mockSendAppSkills.mockResolvedValueOnce(false);
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/메시지|message/i);
		fireEvent.change(input, { target: { value: "radio please" } });
		fireEvent.keyDown(input, { key: "Enter" });

		expect(
			await screen.findByText(/skill_youtube_bgm_registration_failed/),
		).toBeDefined();
		expect(capturedRequests).toHaveLength(0);
	});

	it("does not send empty message", () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
			}),
		);
		render(<ChatArea />);
		// Send button is the last button in the input bar
		const buttons = screen.getAllByRole("button");
		const sendBtn = buttons.find((b) => b.textContent === "↑")!;
		fireEvent.click(sendBtn);
		// No messages should be added
		expect(useChatStore.getState().messages).toHaveLength(0);
		localStorage.removeItem("naia-config");
	});

	it("sends message on Enter", async () => {
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/메시지|message/i);
		fireEvent.change(input, { target: { value: "안녕" } });
		fireEvent.keyDown(input, { key: "Enter" });

		// Wait for async state updates
		await new Promise((r) => setTimeout(r, 50));

		// User message + assistant error message (no API key)
		const { messages } = useChatStore.getState();
		expect(messages.length).toBeGreaterThanOrEqual(1);
		expect(messages[0].content).toBe("안녕");
		expect(messages[0].role).toBe("user");
	});

	it("displays session cost header", () => {
		useChatStore.setState({ totalSessionCost: 0.005 });
		render(<ChatArea />);
		expect(screen.getByText(/\$0\.005/)).toBeDefined();
	});

	it("shows Naia-account session cost in credits, not dollars (#727)", () => {
		useChatStore.setState({
			provider: "nextain",
			totalSessionCost: 0.005,
			totalSessionCostNaia: 0.005,
		});
		render(<ChatArea />);
		expect(screen.getByText("≈ 5 credits")).toBeDefined();
		expect(screen.queryByText(/\$0\.005/)).toBeNull();
	});

	it("labels own-key session cost as a provider-price estimate (#727)", () => {
		useChatStore.setState({
			provider: "gemini",
			totalSessionCost: 0.005,
			totalSessionCostNaia: 0,
		});
		render(<ChatArea />);
		expect(screen.getByText("$0.0050 (provider price est.)")).toBeDefined();
	});

	it("shows streaming indicator when streaming", () => {
		useChatStore.setState({
			isStreaming: true,
			streamingContent: "응답 중...",
		});
		render(<ChatArea />);
		expect(screen.getByText(/응답 중/)).toBeDefined();
	});

	it("separates split think-tag text and keeps streaming reasoning collapsed", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
			}),
		);
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "reason carefully" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		for (const text of [
			"<thi",
			"nk>private chain",
			"</thi",
			"nk>Final answer.",
		]) {
			request.onChunk({ type: "text", requestId: request.requestId, text });
		}

		expect(useChatStore.getState().streamingThinking).toBe("private chain");
		expect(useChatStore.getState().streamingContent).toBe("Final answer.");
		const reasoning = (await screen.findAllByText("private chain")).find(
			(node) => node.classList.contains("thinking-inline-content"),
		);
		expect(reasoning).toBeDefined();
		expect(reasoning?.closest("details")?.hasAttribute("open")).toBe(false);
		expect(
			reasoning
				?.closest("details")
				?.querySelector(".thinking-inline-preview-live > span")?.textContent,
		).toBe("private chain");

		request.onChunk({ type: "finish", requestId: request.requestId });
		const assistant = useChatStore
			.getState()
			.messages.find((message) => message.role === "assistant");
		expect(assistant?.thinking).toBe("private chain");
		expect(assistant?.content).toBe("Final answer.");
		localStorage.removeItem("naia-config");
	});

	it("strips split NVA gesture markers from chat and TTS and sends active actions to the core", async () => {
		const playAction = vi.fn().mockResolvedValue(true);
		registerCameraActions({
			getGestureActions: () => [
				{ key: "wave", label: "Wave" },
				{ key: "nod", label: "Nod" },
			],
			playAction,
		});
		useCascadeAvatarStore.getState().setRenderer({
			interrupt: vi.fn(),
			hasAuthoredClip: vi.fn(() => false),
			setSpeakingVisual: vi.fn(),
		} as never);
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: true,
				ttsProvider: "edge",
			}),
		);
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "say hello" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		const actionsSegment = request.environmentSegments?.find(
			(segment) =>
				segment.kind === "app" &&
				segment.entries.some((entry) => entry.type === "NVA gesture actions"),
		);
		expect(actionsSegment).toBeDefined();
		if (actionsSegment?.kind === "app") {
			const actionData = actionsSegment.entries[0]?.data as
				| { instructions?: string }
				| undefined;
			expect(actionData?.instructions).toContain("[[gesture:key]]");
		}

		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: "Hello [[ges",
		});
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: "ture:wave]] [[gesture:nod]] there.",
		});
		expect(useChatStore.getState().streamingContent).toBe("Hello there.");
		expect(useChatStore.getState().streamingContent).not.toContain(
			"[[gesture:",
		);
		expect(playAction).not.toHaveBeenCalled();

		request.onChunk({ type: "finish", requestId: request.requestId });
		await waitFor(() => expect(ttsSyncMocks.synthesizeTts).toHaveBeenCalled());
		await waitFor(() => expect(ttsSyncMocks.enqueueOrdered).toHaveBeenCalled());
		expect(playAction).not.toHaveBeenCalled();
		act(() => ttsSyncMocks.audioQueueCallbacks?.onPlaybackStart?.());
		expect(playAction).not.toHaveBeenCalled();
		act(() => {
			ttsSyncMocks.audioQueueActive = false;
			ttsSyncMocks.audioQueueCallbacks?.onPlaybackEnd?.();
		});
		await waitFor(() => expect(playAction).toHaveBeenCalledTimes(1));
		expect(playAction).toHaveBeenCalledWith("wave");
		expect(
			ttsSyncMocks.synthesizeTts.mock.calls.map(([input]) => input.text),
		).toEqual(["Hello there."]);
		expect(
			useChatStore
				.getState()
				.messages.find((message) => message.role === "assistant")?.content,
		).toBe("Hello there.");
		localStorage.removeItem("naia-config");
	});

	it("keeps a deferred AI gesture while the user edits a draft", async () => {
		const playAction = vi.fn().mockResolvedValue(true);
		registerCameraActions({
			getGestureActions: () => [{ key: "wave", label: "Wave" }],
			playAction,
		});
		useCascadeAvatarStore.getState().setRenderer({
			interrupt: vi.fn(),
			hasAuthoredClip: vi.fn(() => false),
			setSpeakingVisual: vi.fn(),
		} as never);
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: true,
			}),
		);
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "first request" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: "Hello [[gesture:wave]]",
		});
		expect(playAction).not.toHaveBeenCalled();

		fireEvent.change(input, { target: { value: "new user draft" } });
		request.onChunk({ type: "finish", requestId: request.requestId });
		await waitFor(() => expect(ttsSyncMocks.enqueueOrdered).toHaveBeenCalled());
		act(() => {
			ttsSyncMocks.audioQueueActive = false;
			ttsSyncMocks.audioQueueCallbacks?.onPlaybackEnd?.();
		});
		await waitFor(() => expect(playAction).toHaveBeenCalledWith("wave"));
		localStorage.removeItem("naia-config");
	});

	it("drops a deferred AI gesture after a new message is sent", async () => {
		const playAction = vi.fn().mockResolvedValue(true);
		registerCameraActions({
			getGestureActions: () => [{ key: "wave", label: "Wave" }],
			playAction,
		});
		useCascadeAvatarStore.getState().setRenderer({
			interrupt: vi.fn(),
			hasAuthoredClip: vi.fn(() => false),
			setSpeakingVisual: vi.fn(),
		} as never);
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: true,
			}),
		);
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "first request" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const first = capturedRequests[0];
		first.onChunk({
			type: "text",
			requestId: first.requestId,
			text: "Hello [[gesture:wave]]",
		});
		first.onChunk({ type: "finish", requestId: first.requestId });
		await waitFor(() => expect(ttsSyncMocks.enqueueOrdered).toHaveBeenCalled());

		fireEvent.change(input, { target: { value: "new submitted message" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(2));
		capturedRequests[1].onChunk({
			type: "finish",
			requestId: capturedRequests[1].requestId,
		});
		act(() => {
			ttsSyncMocks.audioQueueActive = false;
			ttsSyncMocks.audioQueueCallbacks?.onPlaybackEnd?.();
		});
		expect(playAction).not.toHaveBeenCalled();
		localStorage.removeItem("naia-config");
	});

	it("does not record a manual hotkey when the renderer refuses playback", async () => {
		const playAction = vi
			.fn()
			.mockResolvedValueOnce(false)
			.mockResolvedValue(true);
		registerCameraActions({
			getGestureActions: () => [{ key: "wave", label: "Wave" }],
			playAction,
		});
		useCascadeAvatarStore.getState().setRenderer({
			interrupt: vi.fn(),
			hasAuthoredClip: vi.fn(() => false),
			setSpeakingVisual: vi.fn(),
		} as never);
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: false,
			}),
		);
		render(<ChatArea />);

		const hotkey = new KeyboardEvent("keydown", {
			bubbles: true,
			cancelable: true,
			key: "¡",
			code: "Digit1",
			altKey: true,
		});
		window.dispatchEvent(hotkey);
		expect(hotkey.defaultPrevented).toBe(true);
		await waitFor(() => expect(playAction).toHaveBeenCalledTimes(1));

		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "another response" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		capturedRequests[0].onChunk({
			type: "text",
			requestId: capturedRequests[0].requestId,
			text: "[[gesture:wave]]",
		});
		await waitFor(() => expect(playAction).toHaveBeenCalledTimes(2));
		expect(playAction).toHaveBeenLastCalledWith("wave");
		localStorage.removeItem("naia-config");
	});

	it("discards a deferred gesture when its active avatar is replaced", async () => {
		const playAction = vi.fn().mockResolvedValue(true);
		registerCameraActions({
			getGestureActions: () => [{ key: "wave", label: "Wave" }],
			playAction,
		});
		useCascadeAvatarStore.getState().setRenderer({
			interrupt: vi.fn(),
			hasAuthoredClip: vi.fn(() => false),
			setSpeakingVisual: vi.fn(),
		} as never);
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: true,
			}),
		);
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "first request" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: "Hello [[gesture:wave]]",
		});
		act(() =>
			useCascadeAvatarStore.getState().setRenderer({
				interrupt: vi.fn(),
				hasAuthoredClip: vi.fn(() => false),
				setSpeakingVisual: vi.fn(),
			} as never),
		);
		request.onChunk({ type: "finish", requestId: request.requestId });
		await waitFor(() => expect(ttsSyncMocks.enqueueOrdered).toHaveBeenCalled());
		act(() => {
			ttsSyncMocks.audioQueueActive = false;
			ttsSyncMocks.audioQueueCallbacks?.onPlaybackEnd?.();
		});
		expect(playAction).not.toHaveBeenCalled();
		localStorage.removeItem("naia-config");
	});

	it("discards a deferred gesture when the response is cancelled", async () => {
		const playAction = vi.fn().mockResolvedValue(true);
		registerCameraActions({
			getGestureActions: () => [{ key: "wave", label: "Wave" }],
			playAction,
		});
		useCascadeAvatarStore.getState().setRenderer({
			interrupt: vi.fn(),
			hasAuthoredClip: vi.fn(() => false),
			setSpeakingVisual: vi.fn(),
		} as never);
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: true,
			}),
		);
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "first request" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: "Hello [[gesture:wave]]",
		});
		fireEvent.keyDown(window, { key: "Escape" });
		expect(playAction).not.toHaveBeenCalled();
		localStorage.removeItem("naia-config");
	});

	it("plays AI gestures immediately with TTS off and limits the next response", async () => {
		const playAction = vi.fn().mockResolvedValue(true);
		registerCameraActions({
			getGestureActions: () => [
				{ key: "wave", label: "Wave" },
				{ key: "cheer", label: "Cheer" },
			],
			playAction,
		});
		useCascadeAvatarStore.getState().setRenderer({
			interrupt: vi.fn(),
			hasAuthoredClip: vi.fn(() => false),
			setSpeakingVisual: vi.fn(),
		} as never);
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: false,
			}),
		);
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "first response" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const first = capturedRequests[0];
		first.onChunk({
			type: "text",
			requestId: first.requestId,
			text: "Hello [[gesture:wave]]",
		});
		expect(playAction).toHaveBeenCalledTimes(1);
		expect(playAction).toHaveBeenCalledWith("wave");
		first.onChunk({ type: "finish", requestId: first.requestId });

		fireEvent.change(input, { target: { value: "second response" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(2));
		const second = capturedRequests[1];
		second.onChunk({
			type: "text",
			requestId: second.requestId,
			text: "Great [[gesture:cheer]]",
		});
		expect(playAction).toHaveBeenCalledTimes(1);
		second.onChunk({ type: "finish", requestId: second.requestId });
		localStorage.removeItem("naia-config");
	});

	it.each(["onTurnEnd", "onInterrupted"] as const)(
		"records pending live voice text when %s flushes the response",
		async (terminalEvent) => {
			localStorage.setItem(
				"naia-config",
				JSON.stringify({
					provider: "nextain",
					model: "test-omni",
					naiaKey: "test-key",
				}),
			);
			const originalAudioContext = globalThis.AudioContext;
			vi.stubGlobal(
				"AudioContext",
				class {
					sampleRate = 24000;
					state = "running";
					currentTime = 0;
					destination = {};
					close = vi.fn().mockResolvedValue(undefined);
				},
			);
			const session: VoiceSession = {
				audioInput: {
					sampleRate: 24000,
					autoGainControl: false,
					gateWhilePlaying: false,
				},
				connect: vi.fn().mockResolvedValue(undefined),
				sendAudio: vi.fn(),
				sendText: vi.fn(),
				sendToolResponse: vi.fn(),
				disconnect: vi.fn(),
				isConnected: true,
				onAudio: null,
				onInputTranscript: null,
				onOutputTranscript: null,
				onToolCall: null,
				onTurnEnd: null,
				onInterrupted: null,
				onError: null,
				onDisconnect: null,
			};
			const createSession = vi
				.spyOn(voiceSessionApi, "createVoiceSession")
				.mockReturnValue(session);
			render(<ChatArea />);
			fireEvent.click(
				document.querySelector(".chat-voice-btn") as HTMLButtonElement,
			);
			await waitFor(() => expect(session.connect).toHaveBeenCalledTimes(1));

			act(() => session.onOutputTranscript?.("Live answer ["));
			expect(
				useChatStore
					.getState()
					.messages.find((message) => message.role === "assistant")?.content,
			).toBe("Live answer");
			act(() => session[terminalEvent]?.());

			expect(
				useChatStore
					.getState()
					.messages.find((message) => message.role === "assistant")?.content,
			).toBe("Live answer [");
			expect(createSession).toHaveBeenCalledTimes(1);
			vi.stubGlobal("AudioContext", originalAudioContext);
			localStorage.removeItem("naia-config");
		},
	);

	it("refreshes live gesture actions at the next voice turn boundary", async () => {
		const playAction = vi.fn().mockResolvedValue(true);
		registerCameraActions({
			getGestureActions: () => [{ key: "wave", label: "Wave" }],
			playAction,
		});
		useCascadeAvatarStore.getState().setRenderer({
			interrupt: vi.fn(),
			hasAuthoredClip: vi.fn(() => false),
			setSpeakingVisual: vi.fn(),
		} as never);
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "nextain",
				model: "test-omni",
				naiaKey: "test-key",
			}),
		);
		const originalAudioContext = globalThis.AudioContext;
		vi.stubGlobal(
			"AudioContext",
			class {
				sampleRate = 24000;
				state = "running";
				currentTime = 0;
				destination = {};
				close = vi.fn().mockResolvedValue(undefined);
			},
		);
		const session: VoiceSession = {
			audioInput: {
				sampleRate: 24000,
				autoGainControl: false,
				gateWhilePlaying: false,
			},
			connect: vi.fn().mockResolvedValue(undefined),
			sendAudio: vi.fn(),
			sendText: vi.fn(),
			sendToolResponse: vi.fn(),
			disconnect: vi.fn(),
			isConnected: true,
			onAudio: null,
			onInputTranscript: null,
			onOutputTranscript: null,
			onToolCall: null,
			onTurnEnd: null,
			onInterrupted: null,
			onError: null,
			onDisconnect: null,
		};
		vi.spyOn(voiceSessionApi, "createVoiceSession").mockReturnValue(session);
		render(<ChatArea />);
		fireEvent.click(
			document.querySelector(".chat-voice-btn") as HTMLButtonElement,
		);
		await waitFor(() => expect(session.connect).toHaveBeenCalledTimes(1));

		registerCameraActions({
			getGestureActions: () => [{ key: "cheer", label: "Cheer" }],
		});
		act(() => session.onTurnEnd?.());
		act(() => session.onOutputTranscript?.("Hello [[gesture:cheer]]"));
		act(() => session.onTurnEnd?.());

		await waitFor(() => expect(playAction).toHaveBeenCalledWith("cheer"));
		expect(
			useChatStore
				.getState()
				.messages.find((message) => message.role === "assistant")?.content,
		).not.toContain("[[gesture:cheer]]");
		vi.stubGlobal("AudioContext", originalAudioContext);
		localStorage.removeItem("naia-config");
	});

	it("never sends textual reasoning to sentence TTS", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: true,
				ttsProvider: "edge",
			}),
		);
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "speak final only" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		for (const text of [
			"<think>Secret sentence.",
			" Still secret.</think>",
			"Public sentence.",
		]) {
			request.onChunk({ type: "text", requestId: request.requestId, text });
		}
		request.onChunk({ type: "finish", requestId: request.requestId });

		await waitFor(() => expect(ttsSyncMocks.synthesizeTts).toHaveBeenCalled());
		expect(
			ttsSyncMocks.synthesizeTts.mock.calls.map(([input]) => input.text),
		).toEqual(["Public sentence."]);
		localStorage.removeItem("naia-config");
	});

	it("renders ToolActivity for tool_use chunk during streaming", async () => {
		// Set up API key so sendChatMessage is actually called
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/메시지|message/i);
		fireEvent.change(input, { target: { value: "파일 읽어줘" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await new Promise((r) => setTimeout(r, 50));

		expect(capturedOnChunk).not.toBeNull();
		const requestId = capturedRequests[0].requestId;
		capturedOnChunk?.({
			type: "tool_use",
			requestId,
			toolCallId: "tc-1",
			toolName: "read_file",
			args: { path: "/test.txt" },
		});

		// Store should have the tool call
		const { streamingToolCalls } = useChatStore.getState();
		expect(streamingToolCalls).toHaveLength(1);
		expect(streamingToolCalls[0].toolName).toBe("read_file");
		expect(streamingToolCalls[0].status).toBe("running");

		localStorage.removeItem("naia-config");
	});

	it("updates tool call on tool_result chunk", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/메시지|message/i);
		fireEvent.change(input, { target: { value: "파일 읽어줘" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await new Promise((r) => setTimeout(r, 50));

		const requestId = capturedRequests[0].requestId;
		capturedOnChunk?.({
			type: "tool_use",
			requestId,
			toolCallId: "tc-1",
			toolName: "read_file",
			args: { path: "/test.txt" },
		});

		capturedOnChunk?.({
			type: "tool_result",
			requestId,
			toolCallId: "tc-1",
			toolName: "read_file",
			output: "file contents",
			success: true,
		});

		const { streamingToolCalls } = useChatStore.getState();
		expect(streamingToolCalls[0].status).toBe("success");
		expect(streamingToolCalls[0].output).toBe("file contents");

		localStorage.removeItem("naia-config");
	});

	it("keeps UC-WIRE-V1 structured chunks visible in the chat stream", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/硫붿떆吏|message/i);
		fireEvent.change(input, { target: { value: "wire check" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => expect(capturedRequests.length).toBe(1));
		const requestId = capturedRequests[0].requestId;
		capturedOnChunk?.({
			type: "grounding",
			requestId,
			status: "grounded",
			sources: [{ title: "KB", sourceUris: ["kb://workshop"] }],
		});
		capturedOnChunk?.({
			type: "artifact",
			requestId,
			artifact: {
				id: "artifact-1",
				kind: "image",
				mimeType: "image/png",
				sizeBytes: 2048,
				localRef: "img_1",
				name: "preview.png",
			},
		});
		capturedOnChunk?.({
			type: "provider_session",
			requestId,
			sessionId: "session-1",
			providerSessionRef: "opaque-provider-ref",
			state: "started",
		});
		capturedOnChunk?.({
			type: "processing_disclosure",
			requestId,
			workload: "embedding",
			destination: "external_cloud",
			decision: "allowed",
			processingProfileRef: "profile-local-cloud-001",
			provider: "openai",
			model: "gpt-4.1",
		});
		capturedOnChunk?.({ type: "finish", requestId });

		await waitFor(() => {
			const assistant = useChatStore
				.getState()
				.messages.find((msg) => msg.role === "assistant");
			expect(assistant?.content).toContain("[Grounding: grounded] KB");
			expect(assistant?.content).toContain("[Artifact: image preview.png]");
			expect(assistant?.content).toContain("id=artifact-1");
			expect(assistant?.content).toContain("localRef=img_1");
			expect(assistant?.content).toContain(
				"[Provider session: started] sessionId=session-1 providerSessionRef=opaque-provider-ref",
			);
			expect(assistant?.content).toContain(
				"[Processing: embedding -> external_cloud, allowed] processingProfileRef=profile-local-cloud-001 openai/gpt-4.1",
			);
		});

		localStorage.removeItem("naia-config");
	});

	it("renders ToolActivity for completed messages with toolCalls", async () => {
		useChatStore.setState({
			messages: [
				{
					id: "msg-1",
					role: "assistant",
					content: "파일을 읽었습니다.",
					timestamp: Date.now(),
					toolCalls: [
						{
							toolCallId: "tc-1",
							toolName: "read_file",
							args: { path: "/test.txt" },
							status: "success",
							output: "contents",
						},
					],
				},
			],
		});

		render(<ChatArea />);
		// Should render the tool activity label
		expect(
			await screen.findByText(/파일 읽기|Read File/, {}, { timeout: 5_000 }),
		).toBeDefined();
	});

	it("sets pendingApproval on approval_request chunk", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/메시지|message/i);
		fireEvent.change(input, { target: { value: "npm test 실행해" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await new Promise((r) => setTimeout(r, 50));

		expect(capturedOnChunk).not.toBeNull();
		const requestId = capturedRequests[0].requestId;
		capturedOnChunk?.({
			type: "approval_request",
			requestId,
			toolCallId: "tc-1",
			toolName: "execute_command",
			args: { command: "npm test" },
			tier: 2,
			description: "명령 실행: npm test",
		});

		const { pendingApproval } = useChatStore.getState();
		expect(pendingApproval).not.toBeNull();
		expect(pendingApproval?.toolName).toBe("execute_command");

		localStorage.removeItem("naia-config");
	});

	it("queues rapid sends until the active stream finishes", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
			}),
		);
		const { sendChatMessage } = await import("../../lib/chat-service");
		vi.mocked(sendChatMessage).mockClear();

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/메시지|message/i);

		fireEvent.change(input, { target: { value: "첫번째" } });
		fireEvent.keyDown(input, { key: "Enter" });
		fireEvent.change(input, { target: { value: "두번째" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => expect(sendChatMessage).toHaveBeenCalledTimes(1));
		expect(useChatStore.getState().messageQueue).toEqual(["두번째"]);

		const first = capturedRequests[0];
		first.onChunk({
			type: "text",
			requestId: first.requestId,
			text: "첫 응답",
		});
		first.onChunk({ type: "finish", requestId: first.requestId });

		await waitFor(() => expect(sendChatMessage).toHaveBeenCalledTimes(2));
		expect(capturedRequests[1].message).toBe("두번째");
		expect(capturedRequests[1].history).toEqual([
			{ role: "user", content: "첫번째" },
			{ role: "assistant", content: "첫 응답" },
		]);

		localStorage.removeItem("naia-config");
	});

	it("sends a rapidly repeated identical message only once and clears the input before the first await", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
			}),
		);
		const { sendChatMessage } = await import("../../lib/chat-service");
		vi.mocked(sendChatMessage).mockClear();
		capturedRequests.length = 0;

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(
			/메시지|message/i,
		) as HTMLTextAreaElement;

		for (let i = 0; i < 5; i++) {
			fireEvent.change(input, { target: { value: "같은 질문" } });
			fireEvent.keyDown(input, { key: "Enter" });
			if (i === 0) expect(input.value).toBe("");
		}

		await waitFor(() => expect(sendChatMessage).toHaveBeenCalledTimes(1));
		expect(useChatStore.getState().messageQueue).toEqual([]);
		expect(
			useChatStore
				.getState()
				.messages.filter((m) => m.role === "user" && m.content === "같은 질문"),
		).toHaveLength(1);

		// While the reply streams, the same text is still a duplicate.
		fireEvent.change(input, { target: { value: "같은 질문" } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(useChatStore.getState().messageQueue).toEqual([]);

		const first = capturedRequests[0];
		first.onChunk({ type: "text", requestId: first.requestId, text: "답" });
		first.onChunk({ type: "finish", requestId: first.requestId });
		await new Promise((r) => setTimeout(r, 20));
		expect(sendChatMessage).toHaveBeenCalledTimes(1);

		localStorage.removeItem("naia-config");
	});

	it("drops Enter with the same text while the previous reply is still speaking but sends a new text", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: true,
				ttsProvider: "edge",
			}),
		);
		const { sendChatMessage } = await import("../../lib/chat-service");
		vi.mocked(sendChatMessage).mockClear();
		capturedRequests.length = 0;
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(
			/메시지|message/i,
		) as HTMLTextAreaElement;
		fireEvent.change(input, { target: { value: "말해줘" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: "들려 드릴게요.",
		});
		request.onChunk({ type: "finish", requestId: request.requestId });
		await waitFor(() => expect(ttsSyncMocks.enqueueOrdered).toHaveBeenCalled());
		act(() => ttsSyncMocks.audioQueueCallbacks?.onPlaybackStart?.());

		fireEvent.change(input, { target: { value: "말해줘" } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(input.value).toBe("");
		await new Promise((r) => setTimeout(r, 20));
		expect(sendChatMessage).toHaveBeenCalledTimes(1);

		fireEvent.change(input, { target: { value: "다른 질문" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(sendChatMessage).toHaveBeenCalledTimes(2));
		expect(capturedRequests[1].message).toBe("다른 질문");
		localStorage.removeItem("naia-config");
	});

	it("drops Enter with the same text after the reply text ends but before its voice starts", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: true,
				ttsProvider: "edge",
			}),
		);
		const { sendChatMessage } = await import("../../lib/chat-service");
		vi.mocked(sendChatMessage).mockClear();
		capturedRequests.length = 0;
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(
			/메시지|message/i,
		) as HTMLTextAreaElement;
		fireEvent.change(input, { target: { value: "말해줘" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: "들려 드릴게요.",
		});
		request.onChunk({ type: "finish", requestId: request.requestId });
		await waitFor(() => expect(ttsSyncMocks.enqueueOrdered).toHaveBeenCalled());

		// 음성은 아직 만드는 중(재생 시작 전)이다.
		fireEvent.change(input, { target: { value: "말해줘" } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(input.value).toBe("");
		await new Promise((r) => setTimeout(r, 20));
		expect(sendChatMessage).toHaveBeenCalledTimes(1);
		localStorage.removeItem("naia-config");
	});

	it("restores the cleared input when the send throws before dispatch", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
			}),
		);
		const { sendChatMessage } = await import("../../lib/chat-service");
		vi.mocked(sendChatMessage).mockClear();
		const original = useChatStore.getState().startStreaming;
		useChatStore.setState({
			startStreaming: () => {
				throw new Error("boom before dispatch");
			},
		});
		try {
			render(<ChatArea />);
			const input = screen.getByPlaceholderText(
				/메시지|message/i,
			) as HTMLTextAreaElement;
			fireEvent.change(input, { target: { value: "되돌릴 글" } });
			fireEvent.keyDown(input, { key: "Enter" });
			expect(input.value).toBe("");
			await waitFor(() => expect(input.value).toBe("되돌릴 글"));
			expect(sendChatMessage).not.toHaveBeenCalled();
		} finally {
			useChatStore.setState({ startStreaming: original });
			localStorage.removeItem("naia-config");
		}
	});

	it("auto-approves when tool is in allowedTools", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				allowedTools: ["execute_command"],
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/메시지|message/i);
		fireEvent.change(input, { target: { value: "npm test 실행해" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await new Promise((r) => setTimeout(r, 50));

		expect(capturedOnChunk).not.toBeNull();
		const requestId = capturedRequests[0].requestId;
		capturedOnChunk?.({
			type: "approval_request",
			requestId,
			toolCallId: "tc-1",
			toolName: "execute_command",
			args: { command: "npm test" },
			tier: 2,
			description: "명령 실행: npm test",
		});

		// Should NOT set pendingApproval (auto-approved)
		const { pendingApproval } = useChatStore.getState();
		expect(pendingApproval).toBeNull();

		localStorage.removeItem("naia-config");
	});

	it("renders PermissionModal when pendingApproval is set", async () => {
		useChatStore.setState({
			isStreaming: true,
			streamingContent: "",
			pendingApproval: {
				requestId: "req-1",
				toolCallId: "tc-1",
				toolName: "execute_command",
				args: { command: "npm test" },
				tier: 2,
				description: "명령 실행: npm test",
			},
		});

		render(<ChatArea />);
		expect(
			await screen.findByText(/도구 실행 승인|Tool Execution Approval/),
		).toBeDefined();
	});

	it("sets isSpeaking and pendingAudio on audio chunk", async () => {
		// Set up API key so sendChatMessage is actually called
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/메시지|message/i);
		fireEvent.change(input, { target: { value: "안녕" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await new Promise((r) => setTimeout(r, 50));

		// Simulate audio chunk via captured callback
		expect(capturedOnChunk).not.toBeNull();
		const requestId = capturedRequests[0].requestId;
		capturedOnChunk?.({
			type: "audio",
			requestId,
			data: "base64audio==",
		});

		// isSpeaking should be set (Audio element playback triggers this)
		expect(useAvatarStore.getState().isSpeaking).toBe(true);
		expect(useAvatarStore.getState().pendingAudio).toBe("base64audio==");

		localStorage.removeItem("naia-config");
	});

	// === Local conversation ownership ===

	it("plays authored NVA clips in order without Shell synthesis", async () => {
		const playAuthoredClip = vi.fn().mockResolvedValue(undefined);
		useCascadeAvatarStore.setState({
			renderer: {
				hasAuthoredClip: () => true,
				playAuthoredClip,
				setSpeakingVisual: vi.fn(),
				setVoice: vi.fn().mockResolvedValue(false),
				interrupt: vi.fn(),
				stop: vi.fn(),
			} as never,
		});
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: true,
				ttsProvider: "naia-local-voice",
				avatarProvider: "naia-video-avatar",
				nvaModel: "naia",
				vllmTtsHost: "http://localhost:8910",
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "ordering test" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: "First sentence.",
		});
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: "Second sentence.",
		});
		await waitFor(() => expect(playAuthoredClip).toHaveBeenCalledTimes(2));
		expect(playAuthoredClip.mock.calls[0][0]).toBe("First sentence.");
		expect(playAuthoredClip.mock.calls[0][1]).toEqual(
			expect.objectContaining({
				onPlaybackReady: expect.any(Function),
				onPlaybackFailure: expect.any(Function),
			}),
		);
		expect(playAuthoredClip.mock.calls[1][0]).toBe("Second sentence.");
		expect(ttsSyncMocks.synthesizeTts).not.toHaveBeenCalled();
		expect(ttsSyncMocks.enqueueOrdered).not.toHaveBeenCalled();
		localStorage.removeItem("naia-config");
	});

	it("routes dynamic NVA speech through Shell TTS instead of the renderer", async () => {
		const playAuthoredClip = vi.fn();
		const setSpeakingVisual = vi.fn();
		useCascadeAvatarStore.setState({
			renderer: {
				hasAuthoredClip: () => false,
				playAuthoredClip,
				setSpeakingVisual,
				setVoice: vi.fn().mockResolvedValue(false),
				interrupt: vi.fn(),
				stop: vi.fn(),
			} as never,
		});
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: true,
				ttsProvider: "naia-local-voice",
				avatarProvider: "naia-video-avatar",
				nvaModel: "naia",
				vllmTtsHost: "http://localhost:8910",
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "dynamic speech test" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: "No authored clip matches this sentence.",
		});

		await waitFor(() => expect(ttsSyncMocks.synthesizeTts).toHaveBeenCalled());
		expect(playAuthoredClip).not.toHaveBeenCalled();
		localStorage.removeItem("naia-config");
	});

	it("applies a local voice preset to the active Shell TTS pipeline", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: true,
				ttsProvider: "naia-local-voice",
				voiceRefUrl: "http://127.0.0.1:8910/ref/audio/ref_ko_485.wav",
				vllmTtsHost: "http://localhost:8910",
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "voice switch test" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));

		window.dispatchEvent(
			new CustomEvent("naia:voice-ref-url", {
				detail: "http://127.0.0.1:8910/ref/audio/male-20s-01.wav",
			}),
		);
		capturedRequests[0].onChunk({
			type: "text",
			requestId: capturedRequests[0].requestId,
			text: "The selected voice is active.",
		});

		await waitFor(() => expect(ttsSyncMocks.synthesizeTts).toHaveBeenCalled());
		expect(ttsSyncMocks.synthesizeTts).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "naia-local-voice",
				voice: "male-20s-01.wav",
			}),
		);
		localStorage.removeItem("naia-config");
	});

	it("keeps the video avatar visible without synthesizing speech when TTS is off", async () => {
		const playAuthoredClip = vi.fn();
		useCascadeAvatarStore.setState({
			renderer: {
				hasAuthoredClip: () => true,
				playAuthoredClip,
				setSpeakingVisual: vi.fn(),
				setVoice: vi.fn().mockResolvedValue(false),
				interrupt: vi.fn(),
				stop: vi.fn(),
			} as never,
		});
		ttsSyncMocks.streamsAvatarPcm.mockReturnValue(true);
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: false,
				ttsProvider: "naia-local-voice",
				avatarProvider: "naia-video-avatar",
				nvaModel: "naia",
				vllmTtsHost: "http://localhost:8910",
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "silent avatar test" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: "The avatar remains visible without voice.",
		});

		await waitFor(() =>
			expect(
				screen.getByText("The avatar remains visible without voice."),
			).toBeDefined(),
		);
		expect(ttsSyncMocks.synthesizeTts).not.toHaveBeenCalled();
		expect(playAuthoredClip).not.toHaveBeenCalled();
		localStorage.removeItem("naia-config");
	});

	it("serializes 6GB local sentence synthesis while playback queues independently", async () => {
		// A resolved test promise can take <1ms. Control elapsed synthesis time
		// so the intended cold-engine RTF>1 condition does not depend on CPU load.
		let elapsed = 0;
		vi.spyOn(performance, "now").mockImplementation(() => (elapsed += 100));
		const firstTts = deferred<{ audioBase64: string; costUsd: number }>();
		const secondTts = deferred<{ audioBase64: string; costUsd: number }>();
		ttsSyncMocks.streamsAvatarPcm.mockReturnValue(false);
		ttsSyncMocks.wavDurationSeconds.mockReturnValue(0.001);
		ttsSyncMocks.synthesizeTts.mockImplementation(
			({ text }: { text: string }) =>
				text.startsWith("First") ? firstTts.promise : secondTts.promise,
		);
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: true,
				ttsProvider: "naia-local-voice",
				vllmTtsHost: "http://localhost:8910",
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "voice queue test" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: "First sentence.",
		});
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: "Second sentence.",
		});

		await waitFor(() =>
			expect(ttsSyncMocks.synthesizeTts).toHaveBeenCalledTimes(1),
		);
		expect(ttsSyncMocks.synthesizeTts.mock.calls[0][0].text).toBe(
			"First sentence.",
		);
		firstTts.resolve({ audioBase64: "audio-1", costUsd: 0 });

		await waitFor(() =>
			expect(ttsSyncMocks.enqueueOrdered).toHaveBeenCalledWith(
				0,
				"audio-1",
				expect.any(Object),
			),
		);
		expect(ttsSyncMocks.pauseBeforePlayback).toHaveBeenCalledTimes(1);
		expect(ttsSyncMocks.resumePlayback).not.toHaveBeenCalled();
		// #688 (Luke 2026-09-22): supersedes FR-VOICE.19 complete-then-play.
		// Playback window releases after a 1 s grace for the first sentence
		// when RTF>1, without waiting for the whole turn or finishStream.
		await waitFor(
			() => expect(ttsSyncMocks.resumePlayback).toHaveBeenCalledTimes(1),
			{ timeout: 3000 },
		);
		await waitFor(() =>
			expect(ttsSyncMocks.synthesizeTts).toHaveBeenCalledTimes(2),
		);
		expect(ttsSyncMocks.synthesizeTts.mock.calls[1][0].text).toBe(
			"Second sentence.",
		);
		secondTts.resolve({ audioBase64: "audio-2", costUsd: 0 });
		await waitFor(() =>
			expect(ttsSyncMocks.enqueueOrdered).toHaveBeenCalledWith(
				1,
				"audio-2",
				expect.any(Object),
			),
		);
		// Later sentences never re-hold playback; resumePlayback is still 1.
		expect(ttsSyncMocks.resumePlayback).toHaveBeenCalledTimes(1);
		request.onChunk({ type: "finish", requestId: request.requestId });
		expect(ttsSyncMocks.resumePlayback).toHaveBeenCalledTimes(1);
		localStorage.removeItem("naia-config");
	});

	it("reveals text without duplicate AudioQueue playback when media runtime fails", async () => {
		const playAuthoredClip = vi
			.fn()
			.mockImplementation(
				(_text: string, opts: { onPlaybackFailure?: () => void }) => {
					opts.onPlaybackFailure?.();
					return Promise.resolve();
				},
			);
		useCascadeAvatarStore.setState({
			renderer: {
				hasAuthoredClip: () => true,
				playAuthoredClip,
				setSpeakingVisual: vi.fn(),
				setVoice: vi.fn().mockResolvedValue(false),
				interrupt: vi.fn(),
				stop: vi.fn(),
			} as never,
		});
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: true,
				ttsProvider: "naia-local-voice",
				vllmTtsHost: "http://localhost:8910",
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "failure test" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: "Avatar failure sentence.",
		});

		await waitFor(() => expect(playAuthoredClip).toHaveBeenCalledTimes(1));
		await waitFor(() =>
			expect(screen.getByText("Avatar failure sentence.")).toBeDefined(),
		);
		expect(ttsSyncMocks.synthesizeTts).not.toHaveBeenCalled();
		expect(ttsSyncMocks.enqueueOrdered).not.toHaveBeenCalled();
		localStorage.removeItem("naia-config");
	});

	// #571 — 예전 계약은 "재생이 시작될 때까지 본문을 감춘다" 였다. 그 감춤이 음성이
	// 느린 기계에서 본문을 인질로 잡았다(win-rtx4060: 비용 배지만 찍히고 60초 공백).
	// 지금 계약은 그 반대다 — 본문은 재생과 무관하게 즉시 그려지고, 재생 상태는
	// 별도의 진행 표시로만 나타난다.
	it("renders chat text immediately and tracks avatar playback only in the voice chip", async () => {
		const playback = deferred<void>();
		const interrupt = vi.fn();
		const playAuthoredClip = vi.fn(
			(_text: string, _options: { onPlaybackReady?: () => void }) =>
				playback.promise,
		);
		useCascadeAvatarStore.setState({
			renderer: {
				hasAuthoredClip: () => true,
				playAuthoredClip,
				setSpeakingVisual: vi.fn(),
				setVoice: vi.fn().mockResolvedValue(false),
				interrupt,
				stop: vi.fn(),
			} as never,
		});
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: true,
				ttsProvider: "naia-local-voice",
				vllmTtsHost: "http://localhost:8910",
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "sync test" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: "Visible with speech.",
		});

		await waitFor(() => expect(playAuthoredClip).toHaveBeenCalledTimes(1));
		// 재생이 시작되기 전에 이미 읽을 수 있어야 한다.
		expect(screen.getByText("Visible with speech.")).toBeDefined();
		expect(screen.getByRole("status").getAttribute("data-stage")).toBe(
			"render",
		);
		const playbackOptions = playAuthoredClip.mock.calls[0][1] as {
			onPlaybackReady?: () => void;
		};
		playbackOptions.onPlaybackReady?.();
		await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
		expect(screen.getByText("Visible with speech.")).toBeDefined();
		interrupt.mockClear();
		const cancel = screen.getByTitle("ESC");
		fireEvent.click(cancel);
		await waitFor(() => expect(interrupt).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(screen.queryByTitle("ESC")).toBeNull());
		expect(useAvatarStore.getState().currentEmotion).toBe("neutral");
		expect(screen.getByText("Visible with speech.")).toBeDefined();

		playback.resolve();
		localStorage.removeItem("naia-config");
	});

	// #572 — 현장 관측: 메모 저장을 시키면 답변 자리에 `[오류] provider error:
	// invalid tool_call index` 가 그대로 찍혔다. 계약은 셋이다 — 원시 문자열이
	// 답변 버블에 없을 것, 사용자 말로 된 안내와 재시도가 있을 것, 원문은 접힌
	// 영역에만 있을 것. 재시도는 같은 입력을 다시 보낸다.
	it("replaces a raw provider error with a recoverable notice and retries the same input", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
			}),
		);
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "save a memo" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		const raw = "provider error: invalid tool_call index";
		request.onChunk({
			type: "error",
			requestId: request.requestId,
			message: raw,
		});

		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("I could not finish that answer");
		// 원문은 접힌 영역 안에만 둔다.
		expect(alert.querySelector("details")?.textContent).toContain(raw);
		// 답변 버블 어디에도 원시 문자열이 없다.
		for (const bubble of document.querySelectorAll(".message-content")) {
			expect(bubble.textContent ?? "").not.toContain("invalid tool_call index");
		}

		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		await waitFor(() => expect(capturedRequests).toHaveLength(2));
		expect(capturedRequests[1].message).toBe("save a memo");
		localStorage.removeItem("naia-config");
	});

	// #571 — 이 기계(리눅스)는 음성이 빨라 현장 증상이 재현되지 않는다. 그래서
	// 합성을 5초 뒤에 끝나게 만들어 느린 기계를 흉내낸다. 계약은 하나다:
	// **답 텍스트는 TTS 합성이 끝나기 전에 이미 DOM 에 있다.** 현장 보고(win-rtx4060)
	// 에서 비용 배지는 즉시 찍히는데 본문만 없었으므로, 둘이 같은 시점에 있는지도
	// 함께 잰다.
	it("shows the answer and its cost badge before a slow TTS synthesis finishes", async () => {
		let finishSynthesis!: () => void;
		const synthesis = new Promise<{ audioBase64: string; costUsd: number }>(
			(resolve) => {
				finishSynthesis = () =>
					resolve({ audioBase64: "slow-audio", costUsd: 0 });
			},
		);
		ttsSyncMocks.synthesizeTts.mockReturnValue(synthesis);
		ttsSyncMocks.streamsAvatarPcm.mockReturnValue(false);
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: true,
				ttsProvider: "naia-local-voice",
				vllmTtsHost: "http://localhost:8910",
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "slow voice" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		const answer = "Text must not wait for the voice.";
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: answer,
		});
		request.onChunk({
			type: "usage",
			requestId: request.requestId,
			inputTokens: 1,
			outputTokens: 2,
			cost: 0.0059,
			model: "test",
		});
		request.onChunk({ type: "finish", requestId: request.requestId });
		await waitFor(() => expect(ttsSyncMocks.synthesizeTts).toHaveBeenCalled());

		// 합성은 아직 끝나지 않았다 — 그런데도 본문과 비용 배지가 함께 있어야 한다.
		expect(screen.getByText(answer)).toBeDefined();
		await waitFor(() =>
			expect(document.querySelector(".cost-badge")).not.toBeNull(),
		);
		expect(screen.getByText(answer)).toBeDefined();

		// 느린 기계 흉내: 합성은 5초 뒤에야 끝난다. 그 뒤에도 본문은 그대로다.
		vi.useFakeTimers();
		setTimeout(finishSynthesis, 5_000);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_000);
		});
		expect(screen.getByText(answer)).toBeDefined();
		vi.useRealTimers();
		ttsSyncMocks.synthesizeTts.mockResolvedValue({
			audioBase64: "default-audio",
			costUsd: 0,
		});
		localStorage.removeItem("naia-config");
	});

	it("keeps the final text streaming after tool-round usage", async () => {
		localStorage.removeItem("naia-adk-path");
		vi.mocked(isNewCore).mockReturnValue(true);
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "continue after tool" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		request.onChunk({
			type: "tool_use",
			requestId: request.requestId,
			toolCallId: "tool-1",
			toolName: "list_dir",
			args: { path: "." },
		});
		request.onChunk({
			type: "tool_result",
			requestId: request.requestId,
			toolCallId: "tool-1",
			toolName: "list_dir",
			output: "[]",
			success: true,
		});
		request.onChunk({
			type: "usage",
			requestId: request.requestId,
			inputTokens: 3,
			outputTokens: 2,
			cost: 0.0059,
			model: "gemini-2.5-flash",
		});
		// The first text chunk is still inside a thinking tag, so there is no
		// visible text yet. The usage event must not commit a blank assistant.
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: "<thi",
		});
		expect(useChatStore.getState().isStreaming).toBe(true);
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: "nk>private chain</think>Visible answer.",
		});
		request.onChunk({ type: "finish", requestId: request.requestId });

		await waitFor(() =>
			expect(screen.getByText("Visible answer.")).toBeDefined(),
		);
		const assistants = useChatStore
			.getState()
			.messages.filter((message) => message.role === "assistant");
		expect(assistants).toHaveLength(1);
		expect(assistants[0].content).toContain("Visible answer.");
		await waitFor(() =>
			expect(document.querySelector(".cost-badge")).not.toBeNull(),
		);
		localStorage.removeItem("naia-config");
	});

	it("commits accumulated tool-round cost when a response is cancelled", async () => {
		localStorage.removeItem("naia-adk-path");
		vi.mocked(isNewCore).mockReturnValue(true);
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "cancel after tool usage" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: "Partial answer.",
		});
		request.onChunk({
			type: "usage",
			requestId: request.requestId,
			inputTokens: 1,
			outputTokens: 2,
			cost: 0.001,
			model: "gemini-2.5-flash",
		});
		request.onChunk({
			type: "usage",
			requestId: request.requestId,
			inputTokens: 3,
			outputTokens: 4,
			cost: 0.002,
			model: "gemini-2.5-flash",
		});

		fireEvent.click(screen.getByTitle("ESC"));
		await waitFor(() =>
			expect(useChatStore.getState().isStreaming).toBe(false),
		);
		const assistants = useChatStore
			.getState()
			.messages.filter((message) => message.role === "assistant");
		expect(assistants).toHaveLength(1);
		expect(assistants[0].content).toContain("Partial answer.");
		expect(assistants[0].cost).toMatchObject({
			inputTokens: 4,
			outputTokens: 6,
			cost: 0.003,
		});
		localStorage.removeItem("naia-config");
	});

	// #571 — 문장 단위 공개가 사라지면서 "문장 사이에 공백이 끼는가" 는 이어 붙인
	// 본문을 그대로 그리는 문제가 됐다. 계약은 남는다: 두 문장이 붙어 나오되
	// 사이에 없던 공백이 생기지 않는다. 달라진 것은 시점뿐이다 — 재생을 기다리지
	// 않는다.
	it("renders both CJK sentences as they arrive without inserting a space", async () => {
		const playAuthoredClip = vi.fn().mockResolvedValue(undefined);
		useCascadeAvatarStore.setState({
			renderer: {
				hasAuthoredClip: () => true,
				playAuthoredClip,
				setSpeakingVisual: vi.fn(),
				setVoice: vi.fn().mockResolvedValue(false),
				interrupt: vi.fn(),
				stop: vi.fn(),
			} as never,
		});
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: true,
				ttsProvider: "naia-local-voice",
				vllmTtsHost: "http://localhost:8910",
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "中文同步" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		const first = "这是第一句测试内容。";
		const second = "这是第二句测试内容。";
		let spacedApart = false;
		const spacingObserver = new MutationObserver(() => {
			if (document.body.textContent?.includes(`${first} ${second}`)) {
				spacedApart = true;
			}
		});
		spacingObserver.observe(document.body, {
			childList: true,
			characterData: true,
			subtree: true,
		});
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: first,
		});
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: second,
		});
		request.onChunk({
			type: "usage",
			requestId: request.requestId,
			inputTokens: 1,
			outputTokens: 2,
			cost: 0,
			model: "test",
		});
		request.onChunk({ type: "finish", requestId: request.requestId });

		await waitFor(() => expect(playAuthoredClip).toHaveBeenCalledTimes(2));
		// 재생 콜백이 하나도 오지 않은 지금 이미 전문이 읽힌다.
		expect(document.body.textContent).toContain(first + second);
		const firstOptions = playAuthoredClip.mock.calls[0][1] as {
			onPlaybackReady?: () => void;
		};
		firstOptions.onPlaybackReady?.();
		const secondOptions = playAuthoredClip.mock.calls[1][1] as {
			onPlaybackReady?: () => void;
		};
		secondOptions.onPlaybackReady?.();
		await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
		expect(document.body.textContent).toContain(first + second);
		spacingObserver.disconnect();
		expect(spacedApart).toBe(false);
		localStorage.removeItem("naia-config");
	});

	// #571 — 재생 준비 콜백이 유실돼도 본문은 애초에 가려져 있지 않다. 남은 계약은
	// "말하는 중" 표시가 영영 남지 않는가이다.
	it("keeps a completed answer readable and drops the voice chip when a playback-ready callback is lost", async () => {
		const playAuthoredClip = vi.fn().mockReturnValue(new Promise(() => {}));
		useCascadeAvatarStore.setState({
			renderer: {
				hasAuthoredClip: () => true,
				playAuthoredClip,
				setSpeakingVisual: vi.fn(),
				setVoice: vi.fn().mockResolvedValue(false),
				interrupt: vi.fn(),
				stop: vi.fn(),
			} as never,
		});
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: true,
				ttsProvider: "naia-local-voice",
				vllmTtsHost: "http://localhost:8910",
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "lost callback" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		const answer = "The complete answer must remain readable.";
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: answer,
		});
		await waitFor(() => expect(playAuthoredClip).toHaveBeenCalledTimes(1));
		expect(screen.getByText(answer)).toBeDefined();

		vi.useFakeTimers();
		request.onChunk({ type: "finish", requestId: request.requestId });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(8_000);
		});
		expect(screen.getByText(answer)).toBeDefined();
		expect(screen.queryByRole("status")).toBeNull();
		vi.useRealTimers();
		localStorage.removeItem("naia-config");
	});

	it("does not retarget the completed-message mask to a later TTS failure notice", async () => {
		let rejectSynthesis!: (reason?: unknown) => void;
		const synthesis = new Promise<{ audioBase64: string; costUsd: number }>(
			(_resolve, reject) => {
				rejectSynthesis = reject;
			},
		);
		ttsSyncMocks.synthesizeTts.mockReturnValue(synthesis);
		ttsSyncMocks.streamsAvatarPcm.mockReturnValue(false);
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: true,
				ttsProvider: "naia-local-voice",
				vllmTtsHost: "http://localhost:8910",
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "failure mask" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		const answer = "This sentence remains the answer.";
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: answer,
		});
		request.onChunk({
			type: "usage",
			requestId: request.requestId,
			inputTokens: 1,
			outputTokens: 2,
			cost: 0,
			model: "test",
		});
		await waitFor(() => expect(ttsSyncMocks.synthesizeTts).toHaveBeenCalled());
		request.onChunk({ type: "finish", requestId: request.requestId });
		expect(useAvatarStore.getState().currentEmotion).toBe("think");
		rejectSynthesis(new Error("voice offline"));

		await waitFor(() => expect(screen.getByText(answer)).toBeDefined());
		await waitFor(() =>
			expect(
				screen.getByText(/Can't reach the host voice engine/),
			).toBeDefined(),
		);
		await waitFor(() => expect(screen.getAllByText(answer)).toHaveLength(1));
		await waitFor(() =>
			expect(useAvatarStore.getState().currentEmotion).toBe("neutral"),
		);
		expect(screen.getByText(/Can't reach the host voice engine/)).toBeDefined();
		localStorage.removeItem("naia-config");
	});

	it("reports VoxCPM2 startup instead of an unreachable engine while cascade is starting", async () => {
		ttsSyncMocks.synthesizeTts.mockRejectedValue(new Error("voice starting"));
		mockInvoke.mockImplementation((command: string) =>
			Promise.resolve(
				command === "voxcpm2_runtime_status" ? "starting" : undefined,
			),
		);
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: true,
				ttsProvider: "naia-local-voice",
				vllmTtsHost: "http://localhost:8910",
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "startup state" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: "This sentence waits for the model.",
		});

		await waitFor(() =>
			expect(screen.getByText(/host voice model is starting/i)).toBeDefined(),
		);
		expect(screen.queryByText(/Can't reach the host voice engine/)).toBeNull();
		localStorage.removeItem("naia-config");
	});

	it("does not synthesize stale fallback audio after a media runtime interrupt", async () => {
		const playback = deferred<void>();
		let playbackFailure = () => {};
		const interrupt = vi.fn();
		const playAuthoredClip = vi.fn(
			(_text: string, opts: { onPlaybackFailure?: () => void }) => {
				playbackFailure = opts.onPlaybackFailure ?? (() => {});
				return playback.promise;
			},
		);
		useCascadeAvatarStore.setState({
			renderer: {
				hasAuthoredClip: () => true,
				playAuthoredClip,
				setSpeakingVisual: vi.fn(),
				setVoice: vi.fn().mockResolvedValue(false),
				interrupt,
				stop: vi.fn(),
			} as never,
		});
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: true,
				ttsProvider: "naia-local-voice",
				vllmTtsHost: "http://localhost:8910",
			}),
		);

		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/message/i);
		fireEvent.change(input, { target: { value: "interrupt test" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		const request = capturedRequests[0];
		request.onChunk({
			type: "text",
			requestId: request.requestId,
			text: "Interrupted sentence.",
		});
		await waitFor(() => expect(playAuthoredClip).toHaveBeenCalledTimes(1));
		interrupt.mockClear();
		const cancel = screen.getByTitle("ESC");
		fireEvent.click(cancel);
		await waitFor(() => expect(screen.queryByTitle("ESC")).toBeNull());
		expect(interrupt).toHaveBeenCalledTimes(1);
		playbackFailure();
		playback.resolve();
		await Promise.resolve();
		expect(ttsSyncMocks.synthesizeTts).not.toHaveBeenCalled();
		expect(ttsSyncMocks.enqueueOrdered).not.toHaveBeenCalled();
		localStorage.removeItem("naia-config");
	});

	it("does not hydrate stale Gateway history over the local conversation", async () => {
		// A completed first turn must remain the source of the second request.
		localStorage.setItem("naia-config", JSON.stringify({}));
		const { getGatewayHistory } = await import("../../lib/gateway-sessions");
		(getGatewayHistory as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
			{
				id: "gw-1",
				role: "user",
				content: "이전 메시지",
				timestamp: 1000,
			},
			{
				id: "gw-2",
				role: "assistant",
				content: "이전 응답",
				timestamp: 2000,
			},
		]);

		render(<ChatArea />);
		await new Promise((r) => setTimeout(r, 100));

		const state = useChatStore.getState();
		expect(state.sessionId).toBe("agent:main:main");
		expect(getGatewayHistory).not.toHaveBeenCalled();
		expect(state.messages).toHaveLength(0);

		localStorage.removeItem("naia-config");
	});

	it("renders new conversation button", () => {
		render(<ChatArea />);
		const btn = screen.getByTitle(/새 대화|New Chat/);
		expect(btn).toBeDefined();
		expect(btn.textContent).toBe("+");
	});

	it("new conversation resets messages", async () => {
		// Pre-populate some state
		useChatStore.setState({
			sessionId: "agent:main:main",
			messages: [
				{
					id: "m1",
					role: "user",
					content: "old",
					timestamp: 1000,
				},
			],
		});

		render(<ChatArea />);
		const btn = screen.getByTitle(/새 대화|New Chat/);
		fireEvent.click(btn);

		await new Promise((r) => setTimeout(r, 100));

		const state = useChatStore.getState();
		expect(state.messages).toHaveLength(0);
		expect(state.sessionId).toBe("agent:main:main");
	});

	it("restores current conversation messages on mount when stored key and transcript exist", async () => {
		sessionStorage.setItem("naia-chat-session-id", "chat-mount-restore-test");
		const jsonl = [
			JSON.stringify({
				role: "user",
				content: "복원된 메시지",
				timestamp: 1000,
			}),
			JSON.stringify({
				role: "assistant",
				content: "복원된 답변",
				timestamp: 1001,
			}),
		].join("\n");
		mockInvoke.mockImplementation((cmd, args) => {
			if (
				cmd === "read_conversation" &&
				args?.sessionId === "chat-mount-restore-test"
			) {
				return Promise.resolve(jsonl);
			}
			return Promise.resolve(undefined);
		});

		render(<ChatArea />);
		await waitFor(() => {
			expect(screen.getByText("복원된 메시지")).toBeDefined();
			expect(screen.getByText("복원된 답변")).toBeDefined();
		});

		const state = useChatStore.getState();
		expect(state.localSessionId).toBe("chat-mount-restore-test");
		expect(state.sessionId).toBe("agent:main:main");
		expect(state.messages).toHaveLength(2);
		expect(state.messages[0].content).toBe("복원된 메시지");
		expect(state.messages[1].content).toBe("복원된 답변");
		sessionStorage.removeItem("naia-chat-session-id");
	});

	it("keeps stored key and shows empty messages on mount when no transcript exists", async () => {
		sessionStorage.setItem(
			"naia-chat-session-id",
			"chat-fresh-key-no-transcript",
		);
		mockInvoke.mockImplementation((cmd) => {
			if (cmd === "read_conversation") {
				return Promise.resolve("");
			}
			return Promise.resolve(undefined);
		});

		render(<ChatArea />);
		await new Promise((r) => setTimeout(r, 100));

		const state = useChatStore.getState();
		expect(state.localSessionId).toBe("chat-fresh-key-no-transcript");
		expect(state.sessionId).toBe("agent:main:main");
		expect(state.messages).toHaveLength(0);
		sessionStorage.removeItem("naia-chat-session-id");
	});

	it("new conversation button replaces stored key in sessionStorage and resets messages", async () => {
		sessionStorage.setItem("naia-chat-session-id", "chat-previous-session");
		useChatStore.setState({
			sessionId: "agent:main:main",
			localSessionId: "chat-previous-session",
			messages: [
				{
					id: "m1",
					role: "user",
					content: "이전 대화",
					timestamp: 1000,
				},
			],
		});

		render(<ChatArea />);
		const btn = screen.getByTitle(/새 대화|New Chat/);
		fireEvent.click(btn);

		await new Promise((r) => setTimeout(r, 100));

		const state = useChatStore.getState();
		expect(state.messages).toHaveLength(0);
		expect(state.localSessionId).not.toBe("chat-previous-session");
		expect(state.localSessionId.startsWith("chat-")).toBe(true);
		expect(sessionStorage.getItem("naia-chat-session-id")).toBe(
			state.localSessionId,
		);
		sessionStorage.removeItem("naia-chat-session-id");
	});

	it("recalls previous input with ArrowUp", async () => {
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(
			/메시지|message/i,
		) as HTMLTextAreaElement;

		// Send two messages
		fireEvent.change(input, { target: { value: "첫번째" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await new Promise((r) => setTimeout(r, 50));

		fireEvent.change(input, { target: { value: "두번째" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await new Promise((r) => setTimeout(r, 50));

		// Input should be empty after send
		expect(input.value).toBe("");

		// ArrowUp should recall "두번째" (most recent)
		// Set selectionStart/End to 0 for empty input
		Object.defineProperty(input, "selectionStart", {
			value: 0,
			writable: true,
		});
		Object.defineProperty(input, "selectionEnd", { value: 0, writable: true });
		fireEvent.keyDown(input, { key: "ArrowUp" });
		await new Promise((r) => setTimeout(r, 50));
		expect(input.value).toBe("두번째");
	});

	it("navigates history with ArrowUp/ArrowDown and restores draft", async () => {
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(
			/메시지|message/i,
		) as HTMLTextAreaElement;

		// Send two messages
		fireEvent.change(input, { target: { value: "첫번째" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await new Promise((r) => setTimeout(r, 50));

		fireEvent.change(input, { target: { value: "두번째" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await new Promise((r) => setTimeout(r, 50));

		// Type a draft (not sent)
		fireEvent.change(input, { target: { value: "작성 중" } });

		// Set cursor to position 0 for ArrowUp to work
		Object.defineProperty(input, "selectionStart", {
			value: 0,
			writable: true,
		});
		Object.defineProperty(input, "selectionEnd", { value: 0, writable: true });

		// ArrowUp → most recent ("두번째")
		fireEvent.keyDown(input, { key: "ArrowUp" });
		await new Promise((r) => setTimeout(r, 50));
		expect(input.value).toBe("두번째");

		// ArrowUp → older ("첫번째")
		fireEvent.keyDown(input, { key: "ArrowUp" });
		await new Promise((r) => setTimeout(r, 50));
		expect(input.value).toBe("첫번째");

		// ArrowDown → back to "두번째"
		fireEvent.keyDown(input, { key: "ArrowDown" });
		await new Promise((r) => setTimeout(r, 50));
		expect(input.value).toBe("두번째");

		// ArrowDown → restore draft "작성 중"
		fireEvent.keyDown(input, { key: "ArrowDown" });
		await new Promise((r) => setTimeout(r, 50));
		expect(input.value).toBe("작성 중");
	});

	it("ArrowDown does nothing when not browsing history", () => {
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(
			/메시지|message/i,
		) as HTMLTextAreaElement;

		fireEvent.change(input, { target: { value: "some text" } });
		fireEvent.keyDown(input, { key: "ArrowDown" });
		// Value should remain unchanged
		expect(input.value).toBe("some text");
	});

	it("splits slide narration into sentences instead of one page-sized request", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: true,
				ttsProvider: "nextain",
			}),
		);
		render(<ChatArea />);
		window.dispatchEvent(
			new CustomEvent(SLIDE_PRESENTER_SPEAK_EVENT, {
				detail: {
					requestId: "slide-speak-1",
					generation: 1,
					page: 3,
					text: "첫 문장입니다. 둘째 문장입니다. 셋째 문장입니다.",
					nextPrefetch: {
						id: "slides-prefetch-1",
						page: 4,
						text: "다음 쪽 예열 문장입니다.",
					},
				},
			}),
		);
		// One request per sentence — the first one can play while the rest
		// are still being synthesized.
		await waitFor(() =>
			expect(ttsSyncMocks.synthesizeTts).toHaveBeenCalledTimes(3),
		);
		expect(
			ttsSyncMocks.synthesizeTts.mock.calls.map((call: any[]) => call[0].text),
		).toEqual(["첫 문장입니다.", "둘째 문장입니다.", "셋째 문장입니다."]);
		const currentPlayback = ttsSyncMocks.enqueueOrdered.mock.calls[0][2] as {
			onPlaybackStart?: (playback?: { clock: () => number }) => void;
		};
		currentPlayback.onPlaybackStart?.({ clock: () => 0 });
		await waitFor(() =>
			expect(ttsSyncMocks.synthesizeTts).toHaveBeenCalledTimes(4),
		);
		expect(ttsSyncMocks.synthesizeTts.mock.calls[3][0].text).toBe(
			"다음 쪽 예열 문장입니다.",
		);
		// Prefetch is a standby cache only; it must not enqueue a second page early.
		expect(ttsSyncMocks.enqueueOrdered).toHaveBeenCalledTimes(3);

		window.dispatchEvent(
			new CustomEvent(SLIDE_PRESENTER_CANCEL_EVENT, {
				detail: {
					requestId: "slide-speak-1",
					generation: 1,
					prefetchId: "slides-prefetch-1",
					invalidateGeneration: true,
				},
			}),
		);
		window.dispatchEvent(
			new CustomEvent(SLIDE_PRESENTER_SPEAK_EVENT, {
				detail: {
					requestId: "slide-speak-stale",
					generation: 1,
					page: 4,
					text: "이전 세대의 문장입니다.",
					prefetchId: "slides-prefetch-1",
				},
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(ttsSyncMocks.synthesizeTts).toHaveBeenCalledTimes(4);
		expect(ttsSyncMocks.enqueueOrdered).toHaveBeenCalledTimes(3);
		localStorage.removeItem("naia-config");
	});

	it("2a waits for every slide sentence when the next synthesis arrives after queue end", async () => {
		const secondSynthesis = deferred<{ audioBase64: string }>();
		ttsSyncMocks.synthesizeTts.mockImplementation((input: { text: string }) =>
			input.text === "첫 조각입니다."
				? Promise.resolve({ audioBase64: "first-audio" })
				: secondSynthesis.promise,
		);
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: true,
				ttsProvider: "nextain",
			}),
		);
		const results: CustomEvent[] = [];
		const onResult = (event: Event) => results.push(event as CustomEvent);
		window.addEventListener(SLIDE_PRESENTER_SPEECH_RESULT_EVENT, onResult);
		try {
			render(<ChatArea />);
			window.dispatchEvent(
				new CustomEvent(SLIDE_PRESENTER_SPEAK_EVENT, {
					detail: {
						requestId: "slide-sentence-wait",
						generation: 11,
						page: 2,
						text: "첫 조각입니다. 둘째 조각입니다.",
					},
				}),
			);
			await waitFor(() =>
				expect(ttsSyncMocks.enqueueOrdered).toHaveBeenCalledTimes(1),
			);
			const first = ttsSyncMocks.enqueueOrdered.mock.calls[0][2] as {
				onPlaybackStart?: (playback?: { clock: () => number }) => void;
				onPlaybackEnd?: () => void;
			};
			first.onPlaybackStart?.({ clock: () => 0.5 });
			first.onPlaybackEnd?.();
			// This is the observed race: AudioQueue reports empty before sentence 2's
			// serial TTS result has arrived. It must not finish the slide request.
			ttsSyncMocks.audioQueueCallbacks?.onPlaybackEnd?.();
			expect(results).toHaveLength(0);

			secondSynthesis.resolve({ audioBase64: "second-audio" });
			await waitFor(() =>
				expect(ttsSyncMocks.enqueueOrdered).toHaveBeenCalledTimes(2),
			);
			const second = ttsSyncMocks.enqueueOrdered.mock.calls[1][2] as {
				onPlaybackStart?: (playback?: { clock: () => number }) => void;
				onPlaybackEnd?: () => void;
			};
			second.onPlaybackStart?.({ clock: () => 0.25 });
			second.onPlaybackEnd?.();
			await waitFor(() => expect(results).toHaveLength(1));
			expect(results[0]?.detail).toMatchObject({
				requestId: "slide-sentence-wait",
				status: "finished",
			});
		} finally {
			window.removeEventListener(SLIDE_PRESENTER_SPEECH_RESULT_EVENT, onResult);
			localStorage.removeItem("naia-config");
		}
	});

	it("2b settles the slide after a later sentence's synthesis fails", async () => {
		ttsSyncMocks.synthesizeTts
			.mockResolvedValueOnce({ audioBase64: "first-audio" })
			.mockRejectedValueOnce(new Error("second sentence synthesis failed"));
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: true,
				ttsProvider: "naia-local-voice",
			}),
		);
		const results: CustomEvent[] = [];
		const onResult = (event: Event) => results.push(event as CustomEvent);
		window.addEventListener(SLIDE_PRESENTER_SPEECH_RESULT_EVENT, onResult);
		try {
			render(<ChatArea />);
			window.dispatchEvent(
				new CustomEvent(SLIDE_PRESENTER_SPEAK_EVENT, {
					detail: {
						requestId: "slide-sentence-failure",
						generation: 12,
						page: 3,
						text: "재생할 첫 조각입니다. 실패할 둘째 조각입니다.",
					},
				}),
			);
			await waitFor(() => {
				expect(ttsSyncMocks.enqueueOrdered).toHaveBeenCalledTimes(1);
				expect(ttsSyncMocks.skipOrdered).toHaveBeenCalledTimes(1);
			});
			expect(results).toHaveLength(0);
			const first = ttsSyncMocks.enqueueOrdered.mock.calls[0][2] as {
				onPlaybackEnd?: () => void;
			};
			first.onPlaybackEnd?.();
			await waitFor(() => expect(results).toHaveLength(1));
			expect(results[0]?.detail).toMatchObject({
				requestId: "slide-sentence-failure",
				status: "finished",
			});
		} finally {
			window.removeEventListener(SLIDE_PRESENTER_SPEECH_RESULT_EVENT, onResult);
			localStorage.removeItem("naia-config");
		}
	});

	it("prefers the same-page standby stage and delays the following page stage until the last sentence starts", async () => {
		ttsSyncMocks.synthesizeTts.mockResolvedValue({
			audioBase64: "slide-audio",
		});
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				ttsEnabled: true,
				ttsProvider: "nextain",
			}),
		);
		const events: string[] = [];
		let stageNumber = 0;
		const renderer = {
			hasAuthoredClip: () => false,
			playAuthoredClip: vi.fn(),
			setSpeakingVisual: vi.fn(),
			playSpeechTiming: vi.fn(async () => true),
			interrupt: vi.fn(),
			stop: vi.fn(),
			canPlaySpeechPlans: () => true,
			prepareSpeechTiming: vi.fn(async () => ({
				play: vi.fn(async () => {
					events.push("active-play");
					return true;
				}),
			})),
			prefetchSpeechTiming: vi.fn(async () => {
				const currentStage = ++stageNumber;
				events.push(`stage-prefetch-${currentStage}`);
				return {
					play: vi.fn(async () => {
						events.push(`stage-play-${currentStage}`);
						return true;
					}),
				};
			}),
			cancelPrefetchedSpeechTiming: vi.fn(),
		};
		const alignedPlan = {
			version: "1",
			quality_mode: "aligned",
			audio: { duration_us: 500_000 },
			events: [{ unit: "sil", start_us: 0, end_us: 500_000 }],
		} as never;
		setAlignedSpeechPlanSource(vi.fn(async () => alignedPlan));
		useCascadeAvatarStore.setState({ renderer: renderer as never });
		try {
			render(<ChatArea />);
			window.dispatchEvent(
				new CustomEvent(SLIDE_PRESENTER_SPEAK_EVENT, {
					detail: {
						requestId: "slide-prefetch-order",
						generation: 13,
						page: 1,
						text: "현재 첫 조각입니다. 현재 마지막 조각입니다.",
						nextPrefetch: {
							id: "slides-prefetch-order",
							page: 2,
							text: "다음 쪽 첫 문장입니다.",
						},
					},
				}),
			);
			await waitFor(() =>
				expect(ttsSyncMocks.enqueueOrdered).toHaveBeenCalledTimes(2),
			);
			await waitFor(() =>
				expect(ttsSyncMocks.synthesizeTts).toHaveBeenCalledTimes(2),
			);
			const first = ttsSyncMocks.enqueueOrdered.mock.calls[0][2] as {
				beforePlayback?: () => Promise<unknown>;
				onPlaybackStart?: (playback?: { clock: () => number }) => void;
			};
			const last = ttsSyncMocks.enqueueOrdered.mock.calls[1][2] as {
				beforePlayback?: () => Promise<unknown>;
				onPlaybackStart?: (playback?: { clock: () => number }) => void;
			};
			await first.beforePlayback?.();
			first.onPlaybackStart?.({ clock: () => 0.2 });
			await waitFor(() =>
				expect(ttsSyncMocks.synthesizeTts).toHaveBeenCalledTimes(3),
			);
			await waitFor(() =>
				expect(renderer.prefetchSpeechTiming).toHaveBeenCalledTimes(1),
			);
			expect(events).toContain("active-play");
			expect(events).toContain("stage-prefetch-1");
			expect(renderer.prefetchSpeechTiming).toHaveBeenCalledTimes(1);

			await last.beforePlayback?.();
			last.onPlaybackStart?.({ clock: () => 0.4 });
			await waitFor(() =>
				expect(renderer.prefetchSpeechTiming).toHaveBeenCalledTimes(2),
			);
			expect(events.indexOf("stage-play-1")).toBeLessThan(
				events.indexOf("stage-prefetch-2"),
			);
		} finally {
			localStorage.removeItem("naia-config");
		}
	});

	it("offers knowledge tools and filters non-model tools on both turn 1 and turn 2", async () => {
		vi.mocked(fetchAgentSkills).mockResolvedValue([
			{ name: "skill_knowledge_ask", description: "ask", parameters: {} },
			{ name: "skill_memory_recall", description: "recall", parameters: {} },
			{ name: "shell_exec", description: "exec", parameters: {} },
		]);
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				enableTools: true,
			}),
		);
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/메시지|message/i);

		fireEvent.change(input, { target: { value: "Turn 1 message" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		capturedRequests[0].onChunk({
			type: "finish",
			requestId: capturedRequests[0].requestId,
		});

		fireEvent.change(input, { target: { value: "Turn 2 message" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => expect(capturedRequests).toHaveLength(2));
		capturedRequests[1].onChunk({
			type: "finish",
			requestId: capturedRequests[1].requestId,
		});

		expect(capturedRequests[0].enableTools).toBe(true);
		expect(capturedRequests[0].disabledSkills).toContain("shell_exec");
		expect(capturedRequests[0].disabledSkills).not.toContain(
			"skill_knowledge_ask",
		);

		expect(capturedRequests[1].enableTools).toBe(true);
		expect(capturedRequests[1].disabledSkills).toContain("shell_exec");
		expect(capturedRequests[1].disabledSkills).not.toContain(
			"skill_knowledge_ask",
		);

		localStorage.removeItem("naia-config");
	});

	it("disables tools on first send when fetchAgentSkills rejects", async () => {
		vi.mocked(fetchAgentSkills).mockRejectedValue(new Error("Agent offline"));
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				enableTools: true,
			}),
		);
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/메시지|message/i);

		fireEvent.change(input, { target: { value: "Hello" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		expect(capturedRequests[0].enableTools).toBe(false);

		capturedRequests[0].onChunk({
			type: "finish",
			requestId: capturedRequests[0].requestId,
		});
		localStorage.removeItem("naia-config");
	});

	it("sends thinking { level: 'high' } and enableThinking: true when thinkingLevel is high (#709 / FR-CHAT-THINKING.5)", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
				thinkingLevel: "high",
			}),
		);
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/메시지|message/i);
		fireEvent.change(input, { target: { value: "Hello High" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() =>
			expect(capturedRequests.length).toBeGreaterThanOrEqual(1),
		);
		const lastReq = capturedRequests[capturedRequests.length - 1];
		expect(lastReq.thinking).toEqual({ level: "high" });
		expect(lastReq.enableThinking).toBe(true);

		lastReq.onChunk({ type: "finish", requestId: lastReq.requestId });
		localStorage.removeItem("naia-config");
	});

	it("sends thinking { level: 'off' } and enableThinking: false by default (#709 / FR-CHAT-THINKING.5)", async () => {
		useChatStore.setState(useChatStore.getInitialState());
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
			}),
		);
		render(<ChatArea />);
		const input = screen.getByPlaceholderText(/메시지|message/i);
		fireEvent.change(input, { target: { value: "Hello Off" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() =>
			expect(capturedRequests.length).toBeGreaterThanOrEqual(1),
		);
		const lastReq = capturedRequests[capturedRequests.length - 1];
		expect(lastReq.thinking).toEqual({ level: "off" });
		expect(lastReq.enableThinking).toBe(false);

		lastReq.onChunk({ type: "finish", requestId: lastReq.requestId });
		localStorage.removeItem("naia-config");
	});

	it("sends request when pre-ready event subscription callback is invoked after ready in web mode", async () => {
		vi.stubEnv("MODE", "web");
		setWebModelStatus({ phase: "checking" });

		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "openai",
				model: "gpt-4o",
				apiKey: "test-key",
			}),
		);

		render(<ChatArea />);

		// Model and workspace transition to ready after mount
		setWebModelStatus({ phase: "ready" });
		setWebAdkStatus({ phase: "ready" });

		// Trigger event subscription callback registered before ready
		window.dispatchEvent(
			new CustomEvent("naia:interference-event", {
				detail: {
					source: "browser",
					action: "opened",
					url: "https://example.com",
				},
			}),
		);

		await waitFor(
			() => {
				expect(capturedRequests.length).toBeGreaterThan(0);
			},
			{ timeout: 1000 },
		);
		const req = capturedRequests[capturedRequests.length - 1];
		expect(req.message).toContain("https://example.com");
	});

	it("preserves pre-ready STT final result in input and prevents transmission after debounce in web mode", async () => {
		vi.stubEnv("MODE", "web");
		setWebModelStatus({ phase: "checking" });

		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "openai",
				model: "gpt-4o",
				sttProvider: "web-speech",
			}),
		);
		Object.defineProperty(window, "SpeechRecognition", {
			configurable: true,
			value: FakeSpeechRecognition,
		});

		render(<ChatArea />);

		const voiceBtn = document.querySelector(".chat-voice-btn") as HTMLButtonElement;
		fireEvent.click(voiceBtn);

		await waitFor(() => {
			expect(FakeSpeechRecognition.latest?.start).toHaveBeenCalledTimes(1);
		});

		act(() => {
			FakeSpeechRecognition.latest?.emitResult([
				{ transcript: "준비 전 STT 텍스트", isFinal: true },
			]);
		});

		const input = document.querySelector(".chat-input") as HTMLTextAreaElement;
		await waitFor(() => expect(input.value).toBe("준비 전 STT 텍스트"));
		expect(capturedRequests).toHaveLength(0);
	});

	it("skips ensureBgmSidecar and does not render bgm-sidecar-error in web mode", async () => {
		vi.mocked(ensureBgmSidecar).mockReset().mockResolvedValue("http://localhost:18791");
		vi.stubEnv("MODE", "web");
		vi.mocked(ensureBgmSidecar).mockRejectedValueOnce(
			new Error("desktop_only:ensure_bgm_server"),
		);
		try {
			render(<ChatArea />);
			await screen.findByPlaceholderText(/메시지|message/i);
			expect(ensureBgmSidecar).toHaveBeenCalledTimes(0);
			expect(screen.queryByTestId("bgm-sidecar-error")).toBeNull();
		} finally {
			vi.unstubAllEnvs();
			vi.mocked(ensureBgmSidecar).mockReset().mockResolvedValue("http://localhost:18791");
		}
	});

	it("renders bgm-sidecar-error notification when ensureBgmSidecar fails in desktop mode", async () => {
		vi.mocked(ensureBgmSidecar).mockReset().mockResolvedValue("http://localhost:18791");
		vi.mocked(ensureBgmSidecar).mockRejectedValueOnce(
			new Error("desktop_only:ensure_bgm_server"),
		);
		try {
			render(<ChatArea />);
			const alert = await screen.findByTestId("bgm-sidecar-error");
			expect(alert).toBeDefined();
			expect(alert.textContent).toContain(
				"BGM 서버를 시작하지 못했습니다. 음악 검색이 동작하지 않습니다.",
			);
			expect(ensureBgmSidecar).toHaveBeenCalledTimes(1);
		} finally {
			vi.mocked(ensureBgmSidecar).mockReset().mockResolvedValue("http://localhost:18791");
		}
	});

	it("calls BGM sendAppSkills on send in web mode", async () => {
		vi.stubEnv("MODE", "web");
		setWebModelStatus({ phase: "ready" });
		setWebAdkStatus({ phase: "ready" });
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
			}),
		);
		mockSendAppSkills.mockClear();
		try {
			render(<ChatArea />);
			const input = await screen.findByPlaceholderText(/메시지|message/i);
			fireEvent.change(input, { target: { value: "hello web" } });
			fireEvent.keyDown(input, { key: "Enter" });
			await waitFor(() => expect(capturedRequests).toHaveLength(1));
			expect(mockSendAppSkills).toHaveBeenCalledTimes(1);
		} finally {
			vi.unstubAllEnvs();
			localStorage.removeItem("naia-config");
		}
	});

	it("calls BGM sendAppSkills once per turn in desktop mode", async () => {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				apiKey: "test-key",
				provider: "gemini",
				model: "gemini-2.5-flash",
			}),
		);
		mockSendAppSkills.mockClear();
		try {
			render(<ChatArea />);
			const input = await screen.findByPlaceholderText(/메시지|message/i);
			fireEvent.change(input, { target: { value: "hello desktop" } });
			fireEvent.keyDown(input, { key: "Enter" });
			await waitFor(() => expect(capturedRequests).toHaveLength(1));
			expect(mockSendAppSkills).toHaveBeenCalledTimes(1);
			expect(mockSendAppSkills).toHaveBeenCalledWith(
				BGM_APP_ID,
				[SKILL_YOUTUBE_BGM],
			);
		} finally {
			localStorage.removeItem("naia-config");
		}
	});

	it("FR-WEB-KIOSK-FIX.10 forces nextain + gpt-5.6-luna on send in kiosk mode even when saved config has gpt-6.1-terra or another provider, and transitions to unavailable screen on credit exhaustion without retry bubble", async () => {
		const { KIOSK_DEMO_UNAVAILABLE_EVENT } = await import(
			"../../lib/kiosk-demo/entry"
		);
		vi.stubEnv("MODE", "web");
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "1");
		setWebModelStatus({ phase: "ready" });
		setWebAdkStatus({ phase: "ready" });
		localStorage.setItem("naia-remote-key", "test-kiosk-fixture-only");

		try {
			// 1. Saved gpt-6.1-terra + polluted thinkingLevel xhigh + enableTools false -> sent request uses nextain + gpt-5.6-luna + thinking low + enableTools true
			localStorage.setItem(
				"naia-config",
				JSON.stringify({
					provider: "nextain",
					model: "gpt-6.1-terra",
					apiKey: "",
					enableTools: false,
					thinkingLevel: "xhigh",
					enableThinking: false,
					environmentAwareness: "always",
					environmentTerminalInput: true,
					llmRoles: {
						main: {
							provider: "nextain",
							model: "gpt-6.1-terra",
							thinkingLevel: "xhigh",
						},
					},
					mainModelThinkingLevels: {
						"nextain:gpt-6.1-terra": "xhigh",
						"nextain:gpt-5.6-luna": "xhigh",
					},
				}),
			);
			const { unmount } = render(<ChatArea />);
			const input = await screen.findByPlaceholderText(/메시지|message/i);
			fireEvent.change(input, { target: { value: "terra test" } });
			fireEvent.keyDown(input, { key: "Enter" });
			await waitFor(() => expect(capturedRequests).toHaveLength(1));
			expect(capturedRequests[0]?.provider?.provider).toBe("nextain");
			expect(capturedRequests[0]?.provider?.model).toBe("gpt-5.6-luna");
			expect(capturedRequests[0]?.thinking).toEqual({ level: "low" });
			expect(capturedRequests[0]?.enableThinking).toBe(true);
			expect(capturedRequests[0]?.enableTools).toBe(true);
			unmount();

			// 2. Saved other provider (codex) + polluted xhigh + enableTools false -> sent request uses nextain + gpt-5.6-luna + thinking low + enableTools true
			capturedRequests.length = 0;
			useChatStore.getState().newConversation();
			localStorage.setItem(
				"naia-config",
				JSON.stringify({
					provider: "codex",
					model: "gpt-5.6-sol",
					apiKey: "",
					enableTools: false,
					thinkingLevel: "xhigh",
					enableThinking: false,
					environmentAwareness: "always",
					environmentTerminalInput: true,
					llmRoles: {
						main: {
							provider: "codex",
							model: "gpt-5.6-sol",
							thinkingLevel: "xhigh",
						},
					},
				}),
			);
			const unavailableEvents: Event[] = [];
			const onUnavailable = (e: Event) => unavailableEvents.push(e);
			window.addEventListener(KIOSK_DEMO_UNAVAILABLE_EVENT, onUnavailable);
			try {
				render(<ChatArea />);
				const input2 = await screen.findByPlaceholderText(/메시지|message/i);
				fireEvent.change(input2, { target: { value: "codex test" } });
				fireEvent.keyDown(input2, { key: "Enter" });
				await waitFor(() => expect(capturedRequests).toHaveLength(1));
				expect(capturedRequests[0]?.provider?.provider).toBe("nextain");
				expect(capturedRequests[0]?.provider?.model).toBe("gpt-5.6-luna");
				expect(capturedRequests[0]?.thinking).toEqual({ level: "low" });
				expect(capturedRequests[0]?.enableThinking).toBe(true);
				expect(capturedRequests[0]?.enableTools).toBe(true);

				// 3. Non-exhaustion or 402 error when balance > 0 -> retries once and shows polite message without triggering unavailable screen
				let balanceCredits = 67;
				mockInvoke.mockImplementation((command: string) => {
					if (command === "fetch_naia_balance") {
						return Promise.resolve({ credits: balanceCredits });
					}
					return Promise.resolve(undefined);
				});
				vi.stubGlobal(
					"fetch",
					vi.fn(async () =>
						new Response(JSON.stringify({ credits: balanceCredits }), {
							status: 200,
						}),
					),
				);

				await act(async () => {
					capturedRequests[0].onChunk({
						type: "error",
						requestId: capturedRequests[0].requestId,
						message:
							"OpenAI-compat https://gateway.nextain.io/v1 failed: 402 Payment Required: insufficient_quota",
					});
				});
				// Should NOT trigger unavailable when balance > 0; instead retries once
				await waitFor(() => expect(capturedRequests).toHaveLength(2));
				expect(unavailableEvents).toHaveLength(0);

				// Second failure after 1x auto-retry -> shows polite chat message "잠시 문제가 있어요, 다시 말해 주세요."
				await act(async () => {
					capturedRequests[1].onChunk({
						type: "error",
						requestId: capturedRequests[1].requestId,
						message: "upstream timeout",
					});
				});
				await waitFor(() =>
					expect(
						useChatStore
							.getState()
							.messages.some((m) =>
								m.content.includes("잠시 문제가 있어요, 다시 말해 주세요."),
							),
					).toBe(true),
				);
				expect(unavailableEvents).toHaveLength(0);
				expect(
					useChatStore
						.getState()
						.messages.some((m) => Boolean(m.failure)),
				).toBe(false);

				// 4. Error when balance lookup confirms credits <= 0 -> triggers unavailable screen
				balanceCredits = 0;
				fireEvent.change(input2, { target: { value: "zero credit test" } });
				fireEvent.keyDown(input2, { key: "Enter" });
				await waitFor(() => expect(capturedRequests).toHaveLength(3));
				await act(async () => {
					capturedRequests[2].onChunk({
						type: "error",
						requestId: capturedRequests[2].requestId,
						message: "402 Payment Required",
					});
				});
				await waitFor(() => expect(unavailableEvents).toHaveLength(1));
			} finally {
				vi.unstubAllGlobals();
				window.removeEventListener(
					KIOSK_DEMO_UNAVAILABLE_EVENT,
					onUnavailable,
				);
			}
		} finally {
			vi.unstubAllEnvs();
			localStorage.removeItem("naia-config");
			localStorage.removeItem("naia-remote-key");
		}
	});

	it("FR-WEB-KIOSK-ADK.3~4 renders evidence line below replies, opens clicked file in workspace, and defaults local answer toggle to OFF with 8GB notice", async () => {
		vi.stubEnv("MODE", "web");
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "1");
		localStorage.removeItem("naia-kiosk-local-answer");
		try {
			useChatStore.setState({
				messages: [
					{
						id: "msg-kiosk-1",
						role: "assistant",
						content: "나이아는 비주얼 에이전트입니다.\n\n근거: naia.md (기준일 2026-10-31)",
						timestamp: Date.now(),
						toolCalls: [
							{
								toolCallId: "tc-kiosk-ev",
								toolName: "skill_knowledge_ask",
								args: { question: "나이아란?" },
								status: "success",
								output: JSON.stringify({
									abstained: false,
									sources: [
										{
											sourceUris: [
												"opfs://naia-adk/.bundle/knowledge/naia.md",
											],
										},
									],
								}),
							},
						],
						localAnswer: true,
					},
				],
			});

			const openedPaths: string[] = [];
			const onOpenFile = (e: Event) => {
				const detail = (e as CustomEvent<{ path?: string }>).detail;
				if (detail?.path) openedPaths.push(detail.path);
			};
			window.addEventListener("naia-web-workspace-open-file", onOpenFile);

			try {
				render(<ChatArea />);

				const toggleBtn = screen.getByTestId("kiosk-local-answer-toggle");
				expect(toggleBtn).toHaveTextContent("내 기기(웹GPU) 에서 대답하기");
				expect(toggleBtn).toHaveAttribute("aria-pressed", "false");
				expect(
					screen.getByTestId("kiosk-answer-source-gateway"),
				).toHaveAttribute("aria-pressed", "true");
				expect(screen.getByTestId("kiosk-local-answer-hint")).toHaveTextContent(
					"그래픽 메모리 8GB 이상 기기에서만 됩니다",
				);
				// jsdom has no navigator.gpu: the 내 PC option is shown as off with the reason.
				await waitFor(() =>
					expect(toggleBtn).toHaveAttribute("aria-disabled", "true"),
				);
				expect(screen.getByTestId("kiosk-local-answer-hint")).toHaveTextContent(
					"이 브라우저는 WebGPU 가 없어 쓸 수 없어요",
				);

				expect(
					screen.getByTestId("kiosk-local-answer-badge"),
				).toHaveTextContent("내 PC 에서 나온 답");

				const evidence = screen.getByTestId("chat-kiosk-evidence");
				expect(evidence).not.toHaveTextContent("AGENTS.md");
				expect(evidence).toHaveTextContent("knowledge/naia.md");
				expect(evidence).not.toHaveTextContent("memory/guest-memory.md");

				const cardChip = screen.getByRole("button", {
					name: "knowledge/naia.md",
				});
				fireEvent.click(cardChip);
				expect(openedPaths).toContain("opfs://naia-adk/knowledge/naia.md");

				// Clicking local toggle without WebGPU shows notice and keeps toggle OFF
				fireEvent.click(toggleBtn);
				await waitFor(() =>
					expect(
						screen.getByTestId("kiosk-local-answer-notice"),
					).toHaveTextContent("그래픽 메모리 8GB 이상 기기에서만 됩니다"),
				);
				expect(toggleBtn).toHaveAttribute("aria-pressed", "false");

				// P2-3: With WebGPU available, clicking local toggle shows ~2.5GB + "처음 한 번 내려받아요" confirmation first; cancel does nothing, confirm enables local mode
				Object.defineProperty(navigator, "gpu", {
					value: {
						requestAdapter: async () => ({
							features: new Set(["shader-f16"]),
							limits: {
								maxBufferSize: 1024 * 1024 * 512,
								maxStorageBufferBindingSize: 1024 * 1024 * 256,
							},
						}),
					},
					configurable: true,
				});
				try {
					fireEvent.click(toggleBtn);
					const confirmBox = await screen.findByTestId(
						"kiosk-local-answer-confirm",
					);
					expect(confirmBox).toHaveTextContent("약 2.5GB");
					expect(confirmBox).toHaveTextContent("처음 한 번 내려받아요");
					expect(toggleBtn).toHaveAttribute("aria-pressed", "false");
					expect(localStorage.getItem("naia-kiosk-local-answer")).toBeNull();

					// Cancel -> does nothing
					fireEvent.click(
						screen.getByTestId("kiosk-local-answer-confirm-cancel"),
					);
					expect(
						screen.queryByTestId("kiosk-local-answer-confirm"),
					).toBeNull();
					expect(toggleBtn).toHaveAttribute("aria-pressed", "false");
					expect(localStorage.getItem("naia-kiosk-local-answer")).toBeNull();

					// Click again and confirm -> enables local answer mode
					fireEvent.click(toggleBtn);
					await screen.findByTestId("kiosk-local-answer-confirm");
					fireEvent.click(
						screen.getByTestId("kiosk-local-answer-confirm-accept"),
					);
					await waitFor(() =>
						expect(toggleBtn).toHaveAttribute("aria-pressed", "true"),
					);
					expect(localStorage.getItem("naia-kiosk-local-answer")).toBe("1");
					expect(toggleBtn).toHaveAttribute("aria-disabled", "false");
					expect(
						screen.getByTestId("kiosk-answer-source-gateway"),
					).toHaveAttribute("aria-pressed", "false");
					expect(
						screen.getByTestId("kiosk-local-answer-hint"),
					).toHaveTextContent("내 PC 의 WebLLM 으로 대답해요");

					// While a local answer streams, the row says so.
					act(() => {
						useChatStore.setState({ isStreaming: true });
					});
					expect(
						screen.getByTestId("kiosk-local-answer-live"),
					).toHaveTextContent("내 PC 로 대답 중");
					act(() => {
						useChatStore.setState({ isStreaming: false });
					});
					expect(screen.queryByTestId("kiosk-local-answer-live")).toBeNull();

					// Picking 게이트웨이 goes back to the cloud answer.
					fireEvent.click(screen.getByTestId("kiosk-answer-source-gateway"));
					await waitFor(() =>
						expect(toggleBtn).toHaveAttribute("aria-pressed", "false"),
					);
					expect(localStorage.getItem("naia-kiosk-local-answer")).not.toBe("1");
				} finally {
					Reflect.deleteProperty(navigator, "gpu");
				}
			} finally {
				window.removeEventListener("naia-web-workspace-open-file", onOpenFile);
			}
		} finally {
			vi.unstubAllEnvs();
			localStorage.removeItem("naia-kiosk-local-answer");
		}
	});

	it("FR-WEB-KIOSK-S6 sends active slide body, speaker script, and rules in model input during slide questions and attaches only the active slide manuscript file as evidence", async () => {
		vi.stubEnv("MODE", "web");
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "1");
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO_KEY", "naia_test_kiosk_fixture_123456");
		setWebModelStatus({ phase: "ready" });
		setWebAdkStatus({ phase: "ready" });
		localStorage.setItem("naia-remote-key", "naia_test_kiosk_fixture_123456");
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "nextain",
				model: "gpt-5.6-luna",
				naiaKey: "naia_test_kiosk_fixture_123456",
				enableTools: true,
				enableThinking: true,
				thinkingLevel: "low",
				ttsEnabled: false,
			}),
		);

		const unregisterSlides = registerKioskSlidesController({
			performAction: vi.fn(),
			isPresenting: () => false,
			isAnsweringQuestion: () => true,
			getCurrentPage: () => 2,
			onTurnSettled: vi.fn(),
		});
		useAppStore.getState().setActiveApp("land.naia.slides");

		try {
			const capturedRequests: any[] = [];
			vi.mocked(sendChatMessage).mockImplementation(async (opts: any) => {
				capturedRequests.push(opts);
				return opts.requestId;
			});

			render(<ChatArea />);
			const input = await screen.findByPlaceholderText(/메시지|message/i);

			const slide2 = getKioskIrSlide(2)!;
			const testTurns = [
				{
					question: "방금 장에서 핵심 지표가 뭐예요?",
					reply:
						"게스트님, 이 장에는 핵심 지표가 없어요. 지금 보고 계신 2장 '브랜드 체계: 나이아와 별자리 모델 이름'에서는 물의 요정 나이아드에서 온 나이아(Naia)의 의미와 루나(달)·테라(지구)·솔(태양)·스텔라(별)·노바(신성) 별자리 모델 이름 체계를 안내하고 있어요. 이어 가기를 누르시면 발표를 계속 들으실 수 있어요.",
				},
				{
					question: "이 장에서 노바는 뭐예요?",
					reply:
						"이 장에서 노바(신성)는 루나(달)·테라(지구)·솔(태양)·스텔라(별)·노바(신성)으로 이어지는 나이아 자체 모델 라인업 가운데 하나예요.",
				},
			];

			for (let i = 0; i < testTurns.length; i += 1) {
				const turn = testTurns[i]!;
				fireEvent.change(input, { target: { value: turn.question } });
				fireEvent.keyDown(input, { key: "Enter" });
				await waitFor(() => expect(capturedRequests).toHaveLength(i + 1));

				const req = capturedRequests[i];
				expect(req.message).toBe(turn.question);
				expect(req.disabledSkills).toEqual(
					expect.arrayContaining([
						"skill_knowledge_search",
						"skill_knowledge_ask",
						"read_file",
					]),
				);

				const appSeg = (req.environmentSegments as EnvironmentSegment[]).find(
					(seg) => seg.kind === "app",
				);
				expect(appSeg).toBeDefined();
				const slideEntry =
					appSeg?.kind === "app"
						? appSeg.entries.find(
								(e) => e.type === "Active IR Slide Context",
							)
						: undefined;
				expect(slideEntry).toBeDefined();
				const slideData = slideEntry?.data as
					| Record<string, unknown>
					| undefined;
				expect(slideData?.page).toBe(2);
				expect(slideData?.source).toBe("brand.md");
				expect(slideData?.bullets).toEqual(slide2.bullets);
				expect(slideData?.script).toBe(slide2.script);
				expect(String(slideData?.instructions)).toContain(
					"별자리 코드명: 루나(달)·테라(지구)·솔(태양)·스텔라(별)·노바(신성)",
				);
				expect(String(slideData?.instructions)).toContain(
					slide2.script,
				);
				expect(String(slideData?.instructions)).toContain(
					"근거 파일은 오직 knowledge/brand.md 하나만 사용하세요.",
				);

				await act(async () => {
					req.onChunk({
						type: "text",
						requestId: req.requestId,
						text: turn.reply,
					});
					req.onChunk({
						type: "finish",
						requestId: req.requestId,
					});
				});

				await waitFor(() =>
					expect(screen.getByText(turn.reply)).toBeInTheDocument(),
				);
			}

			// Verify evidence chips under slide question replies contain ONLY knowledge/brand.md
			const evidenceBlocks = screen.getAllByTestId("chat-kiosk-evidence");
			const lastEvidence = evidenceBlocks.at(-1)!;
			expect(lastEvidence).toHaveTextContent("knowledge/brand.md");
			expect(lastEvidence).not.toHaveTextContent("AGENTS.md");
			expect(lastEvidence).not.toHaveTextContent("marketing.md");
			expect(lastEvidence).not.toHaveTextContent("growth.md");
			expect(lastEvidence).not.toHaveTextContent("memory/guest-memory.md");
		} finally {
			unregisterSlides();
			useAppStore.getState().setActiveApp(null);
			vi.unstubAllEnvs();
			localStorage.removeItem("naia-config");
			localStorage.removeItem("naia-remote-key");
		}
	});

	it("P2-1 & P2-2 preserves past message evidence chips when slides open or change pages, and enables knowledge search with slide reference when presentation is completed or paused", async () => {
		vi.stubEnv("MODE", "web");
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "1");
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO_KEY", "naia_test_kiosk_fixture_123456");
		setWebModelStatus({ phase: "ready" });
		setWebAdkStatus({ phase: "ready" });
		localStorage.setItem("naia-remote-key", "naia_test_kiosk_fixture_123456");
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "nextain",
				model: "gpt-5.6-luna",
				naiaKey: "naia_test_kiosk_fixture_123456",
				enableTools: true,
				enableThinking: true,
				thinkingLevel: "low",
				ttsEnabled: false,
			}),
		);
		useAppStore.getState().setActiveApp(null);
		useChatStore.getState().newConversation();

		let slideMode: "presenting" | "answering" | "paused" | "completed" =
			"presenting";
		let slidePage = 3;
		let unregisterSlides: (() => void) | null = null;

		try {
			const capturedRequests: any[] = [];
			vi.mocked(sendChatMessage).mockImplementation(async (opts: any) => {
				capturedRequests.push(opts);
				return opts.requestId;
			});

			render(<ChatArea />);
			const input = await screen.findByPlaceholderText(/메시지|message/i);

			// 1. Before opening slides: ask "넥스테인은 뭘 하는 회사예요?" -> evidence is knowledge/company.md
			fireEvent.change(input, {
				target: { value: "넥스테인은 뭘 하는 회사예요?" },
			});
			fireEvent.keyDown(input, { key: "Enter" });
			await waitFor(() => expect(capturedRequests).toHaveLength(1));

			const req1 = capturedRequests[0];
			await act(async () => {
				req1.onChunk({
					type: "tool_use",
					requestId: req1.requestId,
					toolCallId: "tc-company",
					toolName: "skill_knowledge_search",
					args: { query: "넥스테인 회사 소개" },
				});
				req1.onChunk({
					type: "tool_result",
					requestId: req1.requestId,
					toolCallId: "tc-company",
					success: true,
					output: JSON.stringify({
						abstained: false,
						hits: [
							{
								id: "company-1",
								sourceUris: [
									"opfs://naia-adk/.bundle/knowledge/company.md",
								],
							},
						],
					}),
				});
				req1.onChunk({
					type: "text",
					requestId: req1.requestId,
					text: "넥스테인은 비주얼 에이전트 나이아를 만드는 AI 기업이에요.",
				});
				req1.onChunk({
					type: "finish",
					requestId: req1.requestId,
				});
			});

			await waitFor(() =>
				expect(screen.getAllByTestId("chat-kiosk-evidence")).toHaveLength(1),
			);
			expect(screen.getAllByTestId("chat-kiosk-evidence")[0]).toHaveTextContent(
				"knowledge/company.md",
			);

			// 2. Open slides on slide 3 (naia.md) while presenting/answering and ask a mid-presentation question
			slideMode = "answering";
			slidePage = 3;
			unregisterSlides = registerKioskSlidesController({
				performAction: vi.fn(),
				isPresenting: () => slideMode === "presenting",
				isAnsweringQuestion: () => slideMode === "answering",
				getCurrentPage: () => slidePage,
				onTurnSettled: vi.fn(),
			});
			useAppStore.getState().setActiveApp("land.naia.slides");

			fireEvent.change(input, {
				target: { value: "방금 장에서 핵심 지표가 뭐예요?" },
			});
			fireEvent.keyDown(input, { key: "Enter" });
			await waitFor(() => expect(capturedRequests).toHaveLength(2));

			const req2 = capturedRequests[1];
			expect(req2.disabledSkills).toEqual(
				expect.arrayContaining([
					"skill_knowledge_search",
					"skill_knowledge_ask",
					"read_file",
				]),
			);
			await act(async () => {
				req2.onChunk({
					type: "text",
					requestId: req2.requestId,
					text: "이 장에는 핵심 지표가 없어요. 3장에서는 나이아 3종 구성을 소개하고 있어요.",
				});
				req2.onChunk({
					type: "finish",
					requestId: req2.requestId,
				});
			});

			await waitFor(() =>
				expect(screen.getAllByTestId("chat-kiosk-evidence")).toHaveLength(2),
			);

			// Navigate slides to slide 5 (adk.md) -> neither turn 1 (company.md) nor turn 2 (naia.md) may change to adk.md
			slidePage = 5;
			const evidencesAfterSlide5 = screen.getAllByTestId("chat-kiosk-evidence");
			expect(evidencesAfterSlide5[0]).toHaveTextContent("knowledge/company.md");
			expect(evidencesAfterSlide5[0]).not.toHaveTextContent(
				"knowledge/naia.md",
			);
			expect(evidencesAfterSlide5[0]).not.toHaveTextContent("knowledge/adk.md");
			expect(evidencesAfterSlide5[1]).toHaveTextContent("knowledge/naia.md");
			expect(evidencesAfterSlide5[1]).not.toHaveTextContent("knowledge/adk.md");

			// 3. P2-2: Presentation finishes on slide 9 (completed) while slides window stays open -> asking "기억의 주인은 누구인가요?" keeps slide 9 as reference but enables knowledge search
			slideMode = "completed";
			slidePage = 9;
			fireEvent.change(input, {
				target: { value: "기억의 주인은 누구인가요?" },
			});
			fireEvent.keyDown(input, { key: "Enter" });
			await waitFor(() => expect(capturedRequests).toHaveLength(3));

			const req3 = capturedRequests[2];
			expect(req3.disabledSkills ?? []).not.toContain(
				"skill_knowledge_search",
			);
			expect(req3.disabledSkills ?? []).not.toContain("skill_knowledge_ask");
			expect(req3.disabledSkills ?? []).not.toContain("read_file");

			const appSeg3 = (req3.environmentSegments as EnvironmentSegment[]).find(
				(seg) => seg.kind === "app",
			);
			const slideEntry3 =
				appSeg3?.kind === "app"
					? appSeg3.entries.find(
							(e) => e.type === "Active IR Slide Context",
						)
					: undefined;
			expect(slideEntry3).toBeDefined();
			const slideData3 = slideEntry3?.data as
				| Record<string, unknown>
				| undefined;
			expect(slideData3?.page).toBe(9);
			expect(slideData3?.source).toBe("future.md");
			expect(slideData3?.restrictToSlide).toBe(false);
			expect(String(slideData3?.instructions)).toContain(
				"skill_knowledge_search",
			);

			await act(async () => {
				req3.onChunk({
					type: "tool_use",
					requestId: req3.requestId,
					toolCallId: "tc-memory",
					toolName: "skill_knowledge_search",
					args: { query: "기억의 주인" },
				});
				req3.onChunk({
					type: "tool_result",
					requestId: req3.requestId,
					toolCallId: "tc-memory",
					success: true,
					output: JSON.stringify({
						abstained: false,
						hits: [
							{
								id: "memory-1",
								sourceUris: [
									"opfs://naia-adk/.bundle/knowledge/memory.md",
								],
							},
						],
					}),
				});
				req3.onChunk({
					type: "text",
					requestId: req3.requestId,
					text: "나이아에서 기억의 주인은 사용자 자신이에요.",
				});
				req3.onChunk({
					type: "finish",
					requestId: req3.requestId,
				});
			});

			await waitFor(() =>
				expect(screen.getAllByTestId("chat-kiosk-evidence")).toHaveLength(3),
			);
			const finalEvidences = screen.getAllByTestId("chat-kiosk-evidence");
			expect(finalEvidences[0]).toHaveTextContent("knowledge/company.md");
			expect(finalEvidences[1]).toHaveTextContent("knowledge/naia.md");
			expect(finalEvidences[2]).toHaveTextContent("knowledge/memory.md");
			expect(finalEvidences[2]).not.toHaveTextContent("knowledge/future.md");
		} finally {
			unregisterSlides?.();
			useAppStore.getState().setActiveApp(null);
			vi.unstubAllEnvs();
			localStorage.removeItem("naia-config");
			localStorage.removeItem("naia-remote-key");
		}
	});

	it("handles conversational YouTube play and stop requests in web kiosk mode via skill_youtube_bgm tool call (fix7d)", async () => {
		vi.stubEnv("MODE", "web");
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "1");
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO_KEY", "naia_test_kiosk_fixture_123456");
		const { bgmPlayback } = await import("../../lib/bgm-playback");
		setWebModelStatus({ phase: "ready" });
		setWebAdkStatus({ phase: "ready" });
		bgmPlayback.reset();

		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "nextain",
				model: "glm-5.1",
				naiaKey: "naia_test_kiosk_fixture_123456",
				ttsEnabled: false,
				enableTools: true,
			}),
		);

		try {
			render(<ChatArea />);
			const input = screen.getByPlaceholderText(/메시지|message/i);

			// 1. User requests YouTube playback in chat
			fireEvent.change(input, { target: { value: "유튜브 틀어 줘" } });
			fireEvent.keyDown(input, { key: "Enter" });

			await waitFor(() => {
				expect(bgmPlayback.current()?.status).toBe("playing");
			});

			const playMessages = useChatStore.getState().messages;
			const assistantPlayMsg = playMessages.at(-1);
			expect(assistantPlayMsg?.role).toBe("assistant");
			expect(assistantPlayMsg?.content).toContain("재생을 시작했어요");
			expect(assistantPlayMsg?.toolCalls?.[0]).toMatchObject({
				toolName: "skill_youtube_bgm",
				args: { action: "play", category: "lofi" },
				status: "success",
			});

			// 2. User requests stopping YouTube playback in chat
			fireEvent.change(input, { target: { value: "유튜브 멈춰 줘" } });
			fireEvent.keyDown(input, { key: "Enter" });

			await waitFor(() => {
				expect(bgmPlayback.current()?.status).toBe("ended");
			});

			const stopMessages = useChatStore.getState().messages;
			const assistantStopMsg = stopMessages.at(-1);
			expect(assistantStopMsg?.role).toBe("assistant");
			expect(assistantStopMsg?.content).toContain("재생을 멈췄어요");
			expect(assistantStopMsg?.toolCalls?.[0]).toMatchObject({
				toolName: "skill_youtube_bgm",
				args: { action: "stop" },
				status: "success",
			});
		} finally {
			bgmPlayback.reset();
			vi.unstubAllEnvs();
			localStorage.removeItem("naia-config");
		}
	});

	it("renders compactable local-answer toggle label and prevents overlap with '처음으로' across 1440x900 desktop card (368px), 412x915 mobile, and 360px widths (fix7f)", async () => {
		vi.stubEnv("MODE", "web");
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "1");
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO_KEY", "naia_test_kiosk_fixture_123456");
		const { readFileSync } = await import("node:fs");
		const { resolve } = await import("node:path");

		try {
			render(<ChatArea />);
			const headerWrap = screen.getByTestId("kiosk-local-answer-header");
			const toggleBtn = screen.getByTestId("kiosk-local-answer-toggle");
			const resetBtn = screen.getByRole("button", { name: "처음으로" });

			expect(toggleBtn).toHaveAttribute("aria-label", "내 기기(웹GPU)에서 대답하기");
			expect(toggleBtn.getAttribute("title")).toContain("내 기기(웹GPU)에서 대답하기");
			expect(toggleBtn.textContent).toBe("내 기기(웹GPU) 에서 대답하기");

			const prefix = toggleBtn.querySelector(
				".kiosk-local-answer-label-prefix",
			);
			const suffix = toggleBtn.querySelector(
				".kiosk-local-answer-label-suffix",
			);
			expect(prefix?.textContent).toBe("내 기기(웹GPU)");
			expect(suffix?.textContent).toBe(" 에서 대답하기");
			// The answer-source row sits below the chat header, so the compact
			// header only holds "처음으로" and "+" (r11).
			expect(headerWrap.closest(".chat-header")).toBeNull();
			expect(headerWrap.compareDocumentPosition(resetBtn)).toBe(
				Node.DOCUMENT_POSITION_PRECEDING,
			);

			const webModeCss = readFileSync(
				resolve(__dirname, "../../styles/web-mode.css"),
				"utf8",
			);
			const kioskCss = readFileSync(
				resolve(__dirname, "../KioskDemoGate.css"),
				"utf8",
			);
			expect(webModeCss).toContain("min-width: max-content;");
			expect(webModeCss).toContain(
				'[data-naia-web="true"][data-naia-mobile="true"] .chat-header .kiosk-local-answer-label-suffix',
			);
			expect(kioskCss).toContain(
				'.app-root[data-kiosk-demo="true"]:not([data-layout-orientation="portrait"]) .chat-header .kiosk-local-answer-hint',
			);
			expect(kioskCss).toContain(
				'.app-root[data-kiosk-demo="true"]:not([data-layout-orientation="portrait"]):not([data-ui-mode="workspace"])\n\t\t.chat-header\n\t\t.kiosk-local-answer-label-suffix',
			);

			// Verify single-row non-overlap budget across widths: 360px (narrow mobile), 368px (1440x900 desktop card), 412px (mobile portrait)
			for (const headerWidth of [360, 368, 412]) {
				const horizontalPad = headerWidth === 368 ? 20 : 12;
				const tabsWidth = 104;
				const aiControlWidth = 56;
				const compactToggleWidth = 42; // "내 PC" compact pill
				const resetWidth = 54; // "처음으로"
				const newChatWidth = 24; // "+"
				const gaps = headerWidth === 368 ? 24 : 15;
				const rightGroupStart =
					headerWidth -
					horizontalPad / 2 -
					(compactToggleWidth + resetWidth + newChatWidth + 8);
				const leftGroupEnd =
					horizontalPad / 2 + tabsWidth + aiControlWidth + gaps;
				const toggleRight = rightGroupStart + compactToggleWidth;
				const resetLeft = toggleRight + 4;
				expect(leftGroupEnd).toBeLessThanOrEqual(rightGroupStart);
				expect(toggleRight).toBeLessThanOrEqual(resetLeft);
			}
		} finally {
			vi.unstubAllEnvs();
		}
	});
});
