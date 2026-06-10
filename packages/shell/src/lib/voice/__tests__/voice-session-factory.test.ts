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

describe("createVoiceSession factory", () => {
	it("creates Gemini Live session", () => {
		const session = createVoiceSession("gemini-live");
		expect(session).toBeDefined();
		expect(session.isConnected).toBe(false);
		expect(session.sendAudio).toBeTypeOf("function");
		expect(session.connect).toBeTypeOf("function");
	});

	it("creates Naia session (Gemini Live gateway)", () => {
		const session = createVoiceSession("naia");
		expect(session).toBeDefined();
		expect(session.isConnected).toBe(false);
		expect(session.sendAudio).toBeTypeOf("function");
	});

	it("creates OpenAI Realtime session", () => {
		const session = createVoiceSession("openai-realtime");
		expect(session).toBeDefined();
		expect(session.isConnected).toBe(false);
		expect(session.sendAudio).toBeTypeOf("function");
	});

	it("throws for unknown provider", () => {
		expect(() => createVoiceSession("unknown" as any)).toThrow(
			"Unknown live provider: unknown",
		);
	});

	it("throws for edge-tts (not a live provider)", () => {
		expect(() => createVoiceSession("edge-tts" as any)).toThrow(
			"Unknown live provider: edge-tts",
		);
	});

	it("all live providers share the same VoiceSession interface", () => {
		const providers = ["naia", "gemini-live", "openai-realtime"] as const;
		for (const p of providers) {
			const s = createVoiceSession(p);
			// All required methods/properties exist
			expect(s.connect).toBeTypeOf("function");
			expect(s.sendAudio).toBeTypeOf("function");
			expect(s.sendText).toBeTypeOf("function");
			expect(s.sendToolResponse).toBeTypeOf("function");
			expect(s.disconnect).toBeTypeOf("function");
			expect(s.isConnected).toBe(false);
			// All event handlers are initially null
			expect(s.onAudio).toBeNull();
			expect(s.onInputTranscript).toBeNull();
			expect(s.onOutputTranscript).toBeNull();
			expect(s.onToolCall).toBeNull();
			expect(s.onTurnEnd).toBeNull();
			expect(s.onInterrupted).toBeNull();
			expect(s.onError).toBeNull();
			expect(s.onDisconnect).toBeNull();
		}
	});
});
