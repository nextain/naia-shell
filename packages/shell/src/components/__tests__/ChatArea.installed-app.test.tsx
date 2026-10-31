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
import { INSTALLED_APP_ASK_EVENT, INSTALLED_APP_RESPONSE_EVENT, INSTALLED_APP_SPEAK_EVENT, INSTALLED_APP_CANCEL_EVENT, INSTALLED_APP_SPEECH_RESULT_EVENT } from "../../apps/generic-installed/installed-app-host-bridge";
import { appRegistry } from "../../lib/app-registry";
import {
	clearCameraActions,
} from "../../lib/avatar/camera-actions";
import { fetchAgentSkills, isNewCore } from "../../lib/chat-service";
import { getLocale, setLocale } from "../../lib/i18n";
import type { AgentResponseChunk, EnvironmentSegment } from "../../lib/types";
import { useAppStore } from "../../stores/app";
import { useAvatarStore } from "../../stores/avatar";
import { useCascadeAvatarStore } from "../../stores/cascade-avatar";
import { useChatStore } from "../../stores/chat";
import { ChatArea, modelToolBoundary } from "../ChatArea";

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

vi.mock("@tauri-apps/plugin-store", () => {
	const store = {
		get: vi.fn().mockResolvedValue(null),
		set: vi.fn().mockResolvedValue(undefined),
		delete: vi.fn().mockResolvedValue(undefined),
	};
	return { load: vi.fn().mockResolvedValue(store) };
});

// Mock chat-service — capture onChunk callback
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

	constructor() {
		FakeSpeechRecognition.latest = this;
	}
}

describe("ChatArea", () => {
	beforeEach(() => {
		localStorage.setItem("naia-adk-path", "/tmp/chat-area-test-adk");
		mockSendAppSkills.mockReset().mockResolvedValue(true);
		vi.mocked(fetchAgentSkills).mockResolvedValue([]);
		modelToolBoundary.reset();
	});
	afterEach(() => {
		cleanup();
		clearCameraActions();
		Reflect.deleteProperty(window, "SpeechRecognition");
		Reflect.deleteProperty(window, "webkitSpeechRecognition");
		FakeSpeechRecognition.latest = null;
		capturedRequests.length = 0;
		vi.clearAllMocks();
		vi.restoreAllMocks();
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
	});

	it("routes a Cafe Lua Tarot reveal through the selected local main model and returns Naia's reply", async () => {
		const tools = [
			{
				name: "skill_cafelua_tarot",
				description: "Control a tarot reading.",
				parameters: {
					type: "object" as const,
					properties: { action: { type: "string" } },
				},
				tier: 0,
			},
		];
		appRegistry.register({
			id: "test.app",
			name: "Cafe Lua Tarot",
			center: () => null,
			tools,
		});
		useAppStore.setState({ activeApp: "test.app" });
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "openai",
				model: "gpt-4o",
				apiKey: "test-key",
				ttsEnabled: true,
				ttsProvider: "nextain",

				enableTools: false,
				locale: "en",
			}),
		);
		useChatStore.getState().addMessage({ role: "user", content: "Private previous conversation" });
		useChatStore.getState().addMessage({ role: "assistant", content: "Private previous reply" });
		const reply = vi.fn();
		window.addEventListener(INSTALLED_APP_RESPONSE_EVENT, reply);
		render(<ChatArea />);

		window.dispatchEvent(
			new CustomEvent(INSTALLED_APP_ASK_EVENT, {
				detail: {
					appId: "test.app",
					requestId: "reading-1-card-0",
					prompt: "You are Naia. Interpret The Fool in the Present position.",
				},
			}),
		);
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		expect(mockSendAppSkills).toHaveBeenCalledWith(
			"test.app",
			tools,
			{ awaitAck: true },
		);
		expect(capturedRequests[0].provider).toMatchObject({
			provider: "openai",
			model: "gpt-4o",
				apiKey: "test-key",
		});
		expect(capturedRequests[0].message).toContain("You are Naia");
		expect(capturedRequests[0].history).toEqual([]);
		capturedRequests[0].onChunk({
			type: "text",
			requestId: capturedRequests[0].requestId,
			text: "A new path.",
		});
		capturedRequests[0].onChunk({ type: "tool_use", requestId: capturedRequests[0].requestId, toolCallId: "call-1", toolName: "skill_cafelua_tarot", args: {} });
		capturedRequests[0].onChunk({ type: "text", requestId: capturedRequests[0].requestId, text: "A door opens." });
		capturedRequests[0].onChunk({
			type: "finish",
			requestId: capturedRequests[0].requestId,
		});
		await waitFor(() => expect(reply).toHaveBeenCalledOnce());
		expect((reply.mock.calls[0][0] as CustomEvent).detail).toEqual({
			appId: "test.app",
			requestId: "reading-1-card-0",
			text: "A new path.\n\nA door opens.",
		});
		await waitFor(() => expect(ttsSyncMocks.synthesizeTts).toHaveBeenCalled());
		const messages = useChatStore.getState().messages;
		expect(messages.filter((m) => m.appName === "Cafe Lua Tarot").map((m) => m.role)).toEqual(["user", "assistant"]);
		expect(screen.getAllByText("Cafe Lua Tarot").length).toBeGreaterThanOrEqual(1);
		const input = screen.getByPlaceholderText(/메시지|message/i);
		fireEvent.change(input, { target: { value: "Next user question" } });
		fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(2));
		expect(capturedRequests[1].history).toEqual([
			{ role: "user", content: "Private previous conversation" },
			{ role: "assistant", content: "Private previous reply" },
		]);
		window.removeEventListener(INSTALLED_APP_RESPONSE_EVENT, reply);
		appRegistry.unregister("test.app");
		localStorage.removeItem("naia-config");
	});

	it("returns an app error instead of claiming Naia received a reveal when tool registration fails", async () => {
		appRegistry.register({
			id: "test.app",
			name: "Cafe Lua Tarot",
			center: () => null,
			tools: [
				{
					name: "skill_cafelua_tarot",
					description: "Control a tarot reading.",
					parameters: { type: "object", properties: {} },
					tier: 0,
				},
			],
		});
		useAppStore.setState({ activeApp: "test.app" });
		localStorage.setItem(
			"naia-config",
			JSON.stringify({ provider: "openai", model: "gpt-4o" }),
		);
		mockSendAppSkills.mockResolvedValueOnce(false);
		const reply = vi.fn();
		window.addEventListener(INSTALLED_APP_RESPONSE_EVENT, reply);
		render(<ChatArea />);
		window.dispatchEvent(
			new CustomEvent(INSTALLED_APP_ASK_EVENT, {
				detail: {
					appId: "test.app",
					requestId: "reading-registration-error",
					prompt: "Interpret this card.",
				},
			}),
		);

		await waitFor(() => expect(reply).toHaveBeenCalledOnce());
		expect(capturedRequests).toHaveLength(0);
		expect((reply.mock.calls[0][0] as CustomEvent).detail).toMatchObject({
			requestId: "reading-registration-error",
			error: expect.stringContaining("could not register"),
		});
		window.removeEventListener(INSTALLED_APP_RESPONSE_EVENT, reply);
		appRegistry.unregister("test.app");
		localStorage.removeItem("naia-config");
	});

	it.each([
		["ko", "음성 대화 중에는 앱 응답을 받을 수 없어요. 음성 대화를 끄고 다시 눌러 주세요."],
		["en", "The app cannot receive a reply during voice chat. Turn off voice chat and try again."],
	] as const)("rejects a tarot request when the default model requires realtime voice (%s)", async (locale, error) => {
		const previousLocale = getLocale();
		await setLocale(locale);
		const reply = vi.fn();
		try {
			useAppStore.setState({ activeApp: "test.app" });
			localStorage.setItem("naia-config", JSON.stringify({ provider: "nextain", model: "naia-0.9-omni-24g" }));
			window.addEventListener(INSTALLED_APP_RESPONSE_EVENT, reply);
			render(<ChatArea />);
			act(() => window.dispatchEvent(new CustomEvent(INSTALLED_APP_ASK_EVENT, {
				detail: { appId: "test.app", requestId: "voice-reading", prompt: "Interpret this card." },
			})));
			expect(reply).toHaveBeenCalledOnce();
			expect((reply.mock.calls[0][0] as CustomEvent).detail).toEqual({
				appId: "test.app", requestId: "voice-reading", text: "",
				error,
			});
			expect(capturedRequests).toHaveLength(0);
			expect(mockSendAppSkills).not.toHaveBeenCalled();
		} finally {
			window.removeEventListener(INSTALLED_APP_RESPONSE_EVENT, reply);
			localStorage.removeItem("naia-config");
			await setLocale(previousLocale);
		}
	});

	it.each([
		["missing model", { provider: "openai", apiKey: "test-key" }],
		["not logged in", { provider: "nextain", model: "model" }],
		["missing API key", { provider: "openai", model: "model" }],
	])("returns an empty app response for %s", async (_label, config) => {
		localStorage.setItem("naia-config", JSON.stringify(config));
		const reply = vi.fn();
		window.addEventListener(INSTALLED_APP_RESPONSE_EVENT, reply);
		render(<ChatArea />);
		act(() => window.dispatchEvent(new CustomEvent(INSTALLED_APP_ASK_EVENT, { detail: { appId: "test.app", requestId: "early", prompt: "Question" } })));
		await waitFor(() => expect(reply).toHaveBeenCalledOnce());
		expect((reply.mock.calls[0][0] as CustomEvent).detail).toMatchObject({ appId: "test.app", requestId: "early", text: "", error: expect.any(String) });
		expect(capturedRequests).toHaveLength(0);
		window.removeEventListener(INSTALLED_APP_RESPONSE_EVENT, reply);
		localStorage.removeItem("naia-config");
	});

	it("settles an app request when its stream is cancelled", async () => {
		localStorage.setItem("naia-config", JSON.stringify({ provider: "openai", model: "gpt-4o", apiKey: "test-key" }));
		const reply = vi.fn();
		window.addEventListener(INSTALLED_APP_RESPONSE_EVENT, reply);
		render(<ChatArea />);
		act(() => window.dispatchEvent(new CustomEvent(INSTALLED_APP_ASK_EVENT, { detail: { appId: "test.app", requestId: "cancel", prompt: "Question" } })));
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		fireEvent.click(screen.getByTitle("ESC"));
		await waitFor(() => expect(reply).toHaveBeenCalledOnce());
		expect((reply.mock.calls[0][0] as CustomEvent).detail).toMatchObject({ appId: "test.app", requestId: "cancel", text: "", error: expect.any(String) });
		window.removeEventListener(INSTALLED_APP_RESPONSE_EVENT, reply);
		localStorage.removeItem("naia-config");
	});

	it.each(["finished", "cancelled", "failed"])("reports installed app narration %s", async (status) => {
		const originalSpeech = globalThis.speechSynthesis;
		const originalUtterance = globalThis.SpeechSynthesisUtterance;
		const utterances: Array<{ onstart: (() => void) | null; onend: (() => void) | null; onerror: (() => void) | null }> = [];
		vi.stubGlobal("speechSynthesis", { speak: (utterance: typeof utterances[number]) => utterances.push(utterance), cancel: vi.fn() });
		vi.stubGlobal("SpeechSynthesisUtterance", class { lang = ""; onstart: (() => void) | null = null; onend: (() => void) | null = null; onerror: (() => void) | null = null; });
		localStorage.setItem("naia-config", JSON.stringify({ ttsEnabled: true, ttsProvider: "browser" }));
		const result = vi.fn();
		window.addEventListener(INSTALLED_APP_SPEECH_RESULT_EVENT, result);
		render(<ChatArea />);
		act(() => window.dispatchEvent(new CustomEvent(INSTALLED_APP_SPEAK_EVENT, { detail: { appId: "test.app", requestId: "speech", generation: 0, page: 1, text: "Hello." } })));
		await waitFor(() => expect(utterances).toHaveLength(1));
		act(() => {
			utterances[0].onstart?.();
			if (status === "finished") utterances[0].onend?.();
			else if (status === "failed") utterances[0].onerror?.();
			else window.dispatchEvent(new CustomEvent(INSTALLED_APP_CANCEL_EVENT, { detail: { appId: "test.app", requestId: "speech" } }));
		});
		expect(result).toHaveBeenCalledOnce();
		expect((result.mock.calls[0][0] as CustomEvent).detail).toMatchObject({ appId: "test.app", requestId: "speech", status });
		window.removeEventListener(INSTALLED_APP_SPEECH_RESULT_EVENT, result);
		localStorage.removeItem("naia-config");
		vi.stubGlobal("speechSynthesis", originalSpeech);
		vi.stubGlobal("SpeechSynthesisUtterance", originalUtterance);
	});

	it("waits for every sentence before reporting narration finished", async () => {
		const originalSpeech = globalThis.speechSynthesis;
		const originalUtterance = globalThis.SpeechSynthesisUtterance;
		const utterances: Array<{ onstart: (() => void) | null; onend: (() => void) | null }> = [];
		vi.stubGlobal("speechSynthesis", { speak: (utterance: typeof utterances[number]) => utterances.push(utterance), cancel: vi.fn() });
		vi.stubGlobal("SpeechSynthesisUtterance", class { lang = ""; onstart: (() => void) | null = null; onend: (() => void) | null = null; onerror = null; });
		localStorage.setItem("naia-config", JSON.stringify({ ttsEnabled: true, ttsProvider: "browser" }));
		const result = vi.fn();
		window.addEventListener(INSTALLED_APP_SPEECH_RESULT_EVENT, result);
		render(<ChatArea />);
		act(() => window.dispatchEvent(new CustomEvent(INSTALLED_APP_SPEAK_EVENT, { detail: { appId: "test.app", requestId: "multi", generation: 0, page: 1, text: "First sentence. Second sentence." } })));
		await waitFor(() => expect(utterances).toHaveLength(2));
		act(() => { utterances[0].onstart?.(); utterances[0].onend?.(); });
		expect(result).not.toHaveBeenCalled();
		act(() => { utterances[1].onstart?.(); utterances[1].onend?.(); });
		expect((result.mock.calls[0][0] as CustomEvent).detail).toMatchObject({ appId: "test.app", requestId: "multi", status: "finished" });
		window.removeEventListener(INSTALLED_APP_SPEECH_RESULT_EVENT, result);
		localStorage.removeItem("naia-config");
		vi.stubGlobal("speechSynthesis", originalSpeech);
		vi.stubGlobal("SpeechSynthesisUtterance", originalUtterance);
	});

});
