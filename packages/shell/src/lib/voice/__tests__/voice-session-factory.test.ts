import { beforeEach, describe, expect, it, vi } from "vitest";
import { createVoiceSession } from "../index";

// Mock WebSocket globally
class MockWebSocket {
	url: string;
	protocols?: string | string[];
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	onclose: (() => void) | null = null;
	binaryType = "blob";
	send = vi.fn();
	close = vi.fn();
	constructor(url: string, protocols?: string | string[]) {
		this.url = url;
		this.protocols = protocols;
	}
}

beforeEach(() => {
	vi.stubGlobal("WebSocket", MockWebSocket);
});

describe("createVoiceSession factory (#603 retained providers)", () => {
	it("creates Azure Voice Live session", () => {
		const session = createVoiceSession("azure-voice-live");
		expect(session).toBeDefined();
		expect(session.isConnected).toBe(false);
		expect(session.sendAudio).toBeTypeOf("function");
		expect(session.connect).toBeTypeOf("function");
	});

	it("creates Naia Omni session", () => {
		const session = createVoiceSession("naia-omni");
		expect(session).toBeDefined();
		expect(session.isConnected).toBe(false);
		expect(session.sendAudio).toBeTypeOf("function");
	});

	it("creates vLLM Omni session", () => {
		const session = createVoiceSession("vllm-omni");
		expect(session).toBeDefined();
		expect(session.isConnected).toBe(false);
		expect(session.sendAudio).toBeTypeOf("function");
	});

	it("throws for unknown provider", () => {
		expect(() => createVoiceSession("unknown" as never)).toThrow(
			"Unknown live provider: unknown",
		);
	});

	it("throws for edge-tts (not a live websocket provider)", () => {
		expect(() => createVoiceSession("edge-tts")).toThrow(
			"Unknown live provider: edge-tts",
		);
	});

	it("all retained live providers share the VoiceSession interface", () => {
		const providers = ["azure-voice-live", "naia-omni", "vllm-omni"] as const;
		for (const p of providers) {
			const s = createVoiceSession(p);
			expect(s.connect).toBeTypeOf("function");
			expect(s.sendAudio).toBeTypeOf("function");
			expect(s.sendText).toBeTypeOf("function");
			expect(s.sendToolResponse).toBeTypeOf("function");
			expect(s.disconnect).toBeTypeOf("function");
			expect(s.isConnected).toBe(false);
		}
	});
});
