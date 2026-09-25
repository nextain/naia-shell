import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentResponseChunk } from "../../lib/types";
import { useAppStore } from "../../stores/app";
import { useAvatarStore } from "../../stores/avatar";
import { useCascadeAvatarStore } from "../../stores/cascade-avatar";
import { useChatStore } from "../../stores/chat";
import { ChatArea } from "../ChatArea";

// gap-review-7 (2026-09-25) 구멍 6-1: 이 시험은 ChatArea.test.tsx 안에서 앞선
// (검수 대상 밖인, 오래된) 28개 시험이 남긴 상태와 뒤섞여 파일 전체 실행에서만
// 실패했다(단일 시험 실행 -t 로는 항상 통과) — 그 28개는 round-7 이전 베이스라인
// (e5388a5c)에서도 똑같이 깨져 있는 무관한 선행 결함이라 여기서 고치는 것은
// 범위 밖이다. 대신 이 시험을 자신만의 파일로 옮겨 "파일 전체 실행"이 그
// 28개 결함과 절대 섞이지 않게 격리한다 — mock 하네스는 ChatArea.test.tsx 의
// 것을 최소 복제(이 시험이 실제로 쓰는 것만).

const ttsSyncMocks = vi.hoisted(() => ({
	synthesizeTts: vi.fn().mockResolvedValue({
		audioBase64: "default-audio",
		costUsd: 0,
	}),
	streamsAvatarPcm: vi.fn(() => false),
	enqueueOrdered: vi.fn(),
	// gap-review-6 (2026-09-25): needed so a forced "streaming" voicePlaybackMode
	// decision actually opens a stream slot in tests — without this, the real
	// pipeline's `streamQueue?.enqueueOrderedStream` guard is always falsy here
	// and every decision silently collapses to non-streaming regardless of mode.
	enqueueOrderedStream: vi.fn(),
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

vi.mock("../../lib/voice/audio-queue", async (importOriginal) => ({
	// gap-review-6 (2026-09-25): keep the REAL PcmStreamSource/decodeWavPcm16 —
	// a forced mode="streaming" sentence constructs a real PcmStreamSource
	// inside the pipeline — without this, `new PcmStreamSource(...)` throws
	// ("no export on the mock").
	...(await importOriginal<typeof import("../../lib/voice/audio-queue")>()),
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
		enqueueOrderedStream(seq: number, stream: unknown, callbacks?: unknown) {
			ttsSyncMocks.audioQueueActive = true;
			ttsSyncMocks.enqueueOrderedStream(seq, stream, callbacks);
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

/** Minimal valid RIFF/WAVE payload, base64-encoded (same construction as
 * sentence-pipeline.test.ts's makeWavBase64) — for a forced-streaming
 * decision, the real (unmocked, gap-review-6) PcmStreamSource/decodeWavPcm16
 * actually parse whatever synthesizeTts resolves with. */
function makeWavBase64(durationSeconds: number, sampleRate = 24_000): string {
	const pcmBytes = Math.max(2, Math.round(durationSeconds * sampleRate) * 2);
	const bytes = new Uint8Array(44 + pcmBytes);
	const view = new DataView(bytes.buffer);
	const put = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i++)
			bytes[offset + i] = text.charCodeAt(i);
	};
	put(0, "RIFF");
	put(8, "WAVE");
	put(12, "fmt ");
	put(36, "data");
	view.setUint32(4, bytes.length - 8, true);
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	view.setUint32(40, pcmBytes, true);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

vi.mock("@tauri-apps/plugin-store", () => {
	const store = {
		get: vi.fn().mockResolvedValue(null),
		set: vi.fn().mockResolvedValue(undefined),
		delete: vi.fn().mockResolvedValue(undefined),
	};
	return { load: vi.fn().mockResolvedValue(store) };
});

// Mock chat-service — capture requests (this file's one test reads
// capturedRequests[0].onChunk directly, so no separate capturedOnChunk
// binding is needed here — keeping one avoided would be TS6133 unused).
const capturedRequests: {
	message: string;
	provider?: {
		provider?: string;
		model?: string;
	};
	history: { role: "user" | "assistant"; content: string }[];
	requestId: string;
	onChunk: (chunk: AgentResponseChunk) => void;
}[] = [];
vi.mock("../../lib/chat-service", () => ({
	sendChatMessage: vi.fn().mockImplementation(
		(opts: {
			message: string;
			history: { role: "user" | "assistant"; content: string }[];
			requestId: string;
			onChunk: (chunk: AgentResponseChunk) => void;
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
	invoke: (...args: unknown[]) => mockInvoke(...args),
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

describe("ChatArea voice-playback-mode session isolation (gap-review-7 구멍 6-1)", () => {
	afterEach(() => {
		cleanup();
		Reflect.deleteProperty(window, "SpeechRecognition");
		Reflect.deleteProperty(window, "webkitSpeechRecognition");
		FakeSpeechRecognition.latest = null;
		capturedRequests.length = 0;
		localStorage.clear();
		vi.clearAllMocks();
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

	it("gap-review-6: changing voicePlaybackMode mid voice-SESSION takes effect from the next sentence, not frozen at session start", async () => {
		// FR-VOICE.22 setting is copied into the Shell TTS pipeline's live config
		// (pipelineVoiceConfigRef) by initializeSpeechTts(). During an ordinary
		// typed-chat turn that ALWAYS runs fresh from handleSend (chatTtsEnabled
		// path), so it self-heals on every send — not a useful reproduction.
		// The real bug is scoped to an ACTIVE VOICE SESSION (handleVoiceToggle):
		// once pipelineActiveRef.current is true, handleSend's chatTtsEnabled
		// guard (`!pipelineActiveRef.current && ...`) skips re-running
		// initializeSpeechTts for every turn inside that session, so the
		// voicePlaybackMode snapshotted at session start stayed frozen until the
		// session restarted — exactly what naia-config-changed must now refresh.
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "ollama",
				model: "qwen3:8b", // requiresApiKey:false — no secure-store/apiKey detour needed
				sttProvider: "web-speech",
				sttModel: "",
				ttsEnabled: true,
				ttsProvider: "naia-local-voice",
				vllmTtsHost: "http://localhost:8910",
				voicePlaybackMode: "sentence",
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
		// Session start: pipelineVoiceConfigRef.current is snapshotted here with
		// voicePlaybackMode="sentence" (same code path this test's fix touches).
		await waitFor(() =>
			expect(FakeSpeechRecognition.latest?.start).toHaveBeenCalledTimes(1),
		);

		// Flip the setting mid-session (same pattern saveConfig() uses: persist
		// then notify) — the live voice session stays open, no restart.
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "ollama",
				model: "qwen3:8b",
				sttProvider: "web-speech",
				sttModel: "",
				ttsEnabled: true,
				ttsProvider: "naia-local-voice",
				vllmTtsHost: "http://localhost:8910",
				voicePlaybackMode: "streaming",
			}),
		);
		window.dispatchEvent(new CustomEvent("naia-config-changed"));

		// A real (unmocked, gap-review-6) PcmStreamSource/decodeWavPcm16 now runs
		// for the forced-streaming decision — resolve with an actual WAV so it
		// decodes cleanly instead of falling back to the "engine unavailable"
		// notice, which would be a distraction from what this test checks.
		ttsSyncMocks.synthesizeTts.mockResolvedValueOnce({
			audioBase64: makeWavBase64(1),
			costUsd: 0,
		});

		// A turn during the live voice session (pipelineActiveRef.current=true —
		// text input still routes through the ordinary sendChatMessage path,
		// same as the "Pipeline voice mode" flow ChatArea already uses). The
		// input placeholder changes while listening ("듣고 있어요...").
		const input = screen.getByPlaceholderText(/메시지|message|듣고/i);
		fireEvent.change(input, { target: { value: "voice-session turn" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(capturedRequests).toHaveLength(1));
		capturedRequests[0].onChunk({
			type: "text",
			requestId: capturedRequests[0].requestId,
			text: "This sentence should stream now, not use the session-start snapshot.",
		});
		capturedRequests[0].onChunk({
			type: "finish",
			requestId: capturedRequests[0].requestId,
		});

		await waitFor(() =>
			expect(ttsSyncMocks.enqueueOrderedStream).toHaveBeenCalledTimes(1),
		);
		localStorage.removeItem("naia-config");
	});
});
