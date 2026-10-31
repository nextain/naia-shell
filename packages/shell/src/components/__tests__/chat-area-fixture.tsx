import { cleanup } from "@testing-library/react";
// @vitest-environment jsdom
import { afterEach, beforeEach, vi } from "vitest";
import { clearCameraActions } from "../../lib/avatar/camera-actions";
import { fetchAgentSkills, isNewCore } from "../../lib/chat-service";
import type { AgentResponseChunk, EnvironmentSegment } from "../../lib/types";
import type { VoiceSession } from "../../lib/voice/index";
import { useAppStore } from "../../stores/app";
import { useAvatarStore } from "../../stores/avatar";
import { useCascadeAvatarStore } from "../../stores/cascade-avatar";
import { useChatStore } from "../../stores/chat";
import { modelToolBoundary } from "../ChatArea";

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

export { ttsSyncMocks, mockSendAppSkills, deferred, capturedOnChunk, capturedRequests, mockInvoke, FakeSpeechRecognition };
export type { AgentResponseChunk, EnvironmentSegment, VoiceSession };

export function setupChatAreaTests() {
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
		capturedOnChunk = null;
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

}
