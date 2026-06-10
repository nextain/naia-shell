import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGeminiLiveSession } from "../gemini-live";
import type { GeminiLiveConfig } from "../types";

// ── Mock WebSocket ──

interface MockWSInstance {
	url: string;
	onopen: (() => void) | null;
	onmessage: ((event: { data: string }) => void) | null;
	onerror: ((event: any) => void) | null;
	onclose: ((event: any) => void) | null;
	send: ReturnType<typeof vi.fn>;
	close: ReturnType<typeof vi.fn>;
}

let lastWs: MockWSInstance;

class MockWebSocket implements MockWSInstance {
	url: string;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onerror: ((event: any) => void) | null = null;
	onclose: ((event: any) => void) | null = null;
	send = vi.fn();
	close = vi.fn();

	constructor(url: string) {
		this.url = url;
		lastWs = this;
	}
}

beforeEach(() => {
	vi.stubGlobal("WebSocket", MockWebSocket);
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ── Helpers ──

function connectGateway() {
	const session = createGeminiLiveSession();
	const config: GeminiLiveConfig = {
		provider: "gemini-live",
		gatewayUrl: "https://gateway.example.com",
		naiaKey: "test-key",
		voice: "Kore",
		model: "gemini-live-2.5-flash-native-audio",
	};
	const promise = session.connect(config);

	// Simulate open + setupComplete
	setTimeout(() => {
		lastWs.onopen?.();
		lastWs.onmessage?.({ data: JSON.stringify({ setupComplete: true }) });
	}, 0);

	return { session, promise, config };
}

function connectDirect() {
	const session = createGeminiLiveSession();
	const config: GeminiLiveConfig = {
		provider: "gemini-live",
		googleApiKey: "user-google-key",
		voice: "Puck",
	};
	const promise = session.connect(config);

	setTimeout(() => {
		lastWs.onopen?.();
		lastWs.onmessage?.({ data: JSON.stringify({ setupComplete: true }) });
	}, 0);

	return { session, promise, config };
}

// ── Tests ──

describe("GeminiLive", () => {
	describe("Gateway mode", () => {
		it("connects to gateway /v1/live", async () => {
			const { promise } = connectGateway();
			await promise;
			expect(lastWs.url).toBe("wss://gateway.example.com/v1/live");
		});

		it("sends gateway setup with Bearer token", async () => {
			const { promise } = connectGateway();
			await promise;
			const setupMsg = JSON.parse(lastWs.send.mock.calls[0][0]);
			expect(setupMsg.setup.apiKey).toBe("Bearer test-key");
			expect(setupMsg.setup.voice).toBe("Kore");
			expect(setupMsg.setup.model).toBe("gemini-live-2.5-flash-native-audio");
		});

		it("is connected after setupComplete", async () => {
			const { session, promise } = connectGateway();
			expect(session.isConnected).toBe(false);
			await promise;
			expect(session.isConnected).toBe(true);
		});
	});

	describe("Direct mode", () => {
		it("connects to Gemini API with API key", async () => {
			const { promise } = connectDirect();
			await promise;
			expect(lastWs.url).toContain(
				"wss://generativelanguage.googleapis.com/ws",
			);
			expect(lastWs.url).toContain("key=user-google-key");
		});

		it("sends direct setup with model and voiceConfig", async () => {
			const { promise } = connectDirect();
			await promise;
			const setupMsg = JSON.parse(lastWs.send.mock.calls[0][0]);
			expect(setupMsg.setup.model).toContain(
				"gemini-2.5-flash-native-audio-preview-12-2025",
			);
			expect(
				setupMsg.setup.generationConfig.speechConfig.voiceConfig
					.prebuiltVoiceConfig.voiceName,
			).toBe("Puck");
		});
	});

	describe("sendAudio", () => {
		it("sends realtimeInput with PCM base64", async () => {
			const { session, promise } = connectGateway();
			await promise;
			lastWs.send.mockClear();

			session.sendAudio("AQID");
			const msg = JSON.parse(lastWs.send.mock.calls[0][0]);
			expect(msg.realtimeInput.mediaChunks[0].data).toBe("AQID");
			expect(msg.realtimeInput.mediaChunks[0].mimeType).toBe(
				"audio/pcm;rate=16000",
			);
		});

		it("does not send when disconnected", async () => {
			const session = createGeminiLiveSession();
			session.sendAudio("AQID");
			// No WebSocket created, no error thrown
		});
	});

	describe("sendText", () => {
		it("sends clientContent with text", async () => {
			const { session, promise } = connectGateway();
			await promise;
			lastWs.send.mockClear();

			session.sendText("hello");
			const msg = JSON.parse(lastWs.send.mock.calls[0][0]);
			expect(msg.clientContent.turns[0].parts[0].text).toBe("hello");
			expect(msg.clientContent.turnComplete).toBe(true);
		});
	});

	describe("sendToolResponse", () => {
		it("sends toolResponse with functionResponses", async () => {
			const { session, promise } = connectGateway();
			await promise;
			lastWs.send.mockClear();

			session.sendToolResponse("call-1", { result: "ok" });
			const msg = JSON.parse(lastWs.send.mock.calls[0][0]);
			expect(msg.toolResponse.functionResponses[0].id).toBe("call-1");
			expect(msg.toolResponse.functionResponses[0].response.result).toEqual({
				result: "ok",
			});
		});
	});

	describe("server events", () => {
		it("fires onAudio for inlineData", async () => {
			const { session, promise } = connectGateway();
			const onAudio = vi.fn();
			session.onAudio = onAudio;
			await promise;

			lastWs.onmessage?.({
				data: JSON.stringify({
					serverContent: {
						modelTurn: {
							parts: [{ inlineData: { data: "audio-base64" } }],
						},
					},
				}),
			});
			expect(onAudio).toHaveBeenCalledWith("audio-base64");
		});

		it("fires onInputTranscript", async () => {
			const { session, promise } = connectGateway();
			const onInput = vi.fn();
			session.onInputTranscript = onInput;
			await promise;

			lastWs.onmessage?.({
				data: JSON.stringify({
					serverContent: {
						inputTranscription: { text: "user said" },
					},
				}),
			});
			expect(onInput).toHaveBeenCalledWith("user said");
		});

		it("fires onOutputTranscript", async () => {
			const { session, promise } = connectGateway();
			const onOutput = vi.fn();
			session.onOutputTranscript = onOutput;
			await promise;

			lastWs.onmessage?.({
				data: JSON.stringify({
					serverContent: {
						outputTranscription: { text: "model said" },
					},
				}),
			});
			expect(onOutput).toHaveBeenCalledWith("model said");
		});

		it("fires onTurnEnd", async () => {
			const { session, promise } = connectGateway();
			const onEnd = vi.fn();
			session.onTurnEnd = onEnd;
			await promise;

			lastWs.onmessage?.({
				data: JSON.stringify({
					serverContent: { turnComplete: true },
				}),
			});
			expect(onEnd).toHaveBeenCalled();
		});

		it("fires onInterrupted", async () => {
			const { session, promise } = connectGateway();
			const onInt = vi.fn();
			session.onInterrupted = onInt;
			await promise;

			lastWs.onmessage?.({
				data: JSON.stringify({
					serverContent: { interrupted: true },
				}),
			});
			expect(onInt).toHaveBeenCalled();
		});

		it("fires onToolCall for function calls", async () => {
			const { session, promise } = connectGateway();
			const onTool = vi.fn();
			session.onToolCall = onTool;
			await promise;

			lastWs.onmessage?.({
				data: JSON.stringify({
					toolCall: {
						functionCalls: [
							{ id: "tc-1", name: "get_weather", args: { city: "Seoul" } },
						],
					},
				}),
			});
			expect(onTool).toHaveBeenCalledWith("tc-1", "get_weather", {
				city: "Seoul",
			});
		});
	});

	describe("disconnect", () => {
		it("closes WebSocket and sets isConnected false", async () => {
			const { session, promise } = connectGateway();
			await promise;
			expect(session.isConnected).toBe(true);

			session.disconnect();
			expect(session.isConnected).toBe(false);
			expect(lastWs.close).toHaveBeenCalled();
		});

		it("fires onDisconnect on server close", async () => {
			const { session, promise } = connectGateway();
			const onDisc = vi.fn();
			session.onDisconnect = onDisc;
			await promise;

			lastWs.onclose?.({ code: 1000, reason: "" } as any);
			expect(onDisc).toHaveBeenCalled();
			expect(session.isConnected).toBe(false);
		});
	});

	describe("error handling", () => {
		it("rejects on setup error", async () => {
			const session = createGeminiLiveSession();
			const onError = vi.fn();
			session.onError = onError;

			const config: GeminiLiveConfig = {
				provider: "gemini-live",
				gatewayUrl: "https://gw.example.com",
				naiaKey: "key",
			};
			const promise = session.connect(config);

			setTimeout(() => {
				lastWs.onopen?.();
				lastWs.onmessage?.({
					data: JSON.stringify({
						error: { message: "auth failed" },
					}),
				});
			}, 0);

			await expect(promise).rejects.toThrow("auth failed");
			expect(onError).toHaveBeenCalled();
		});

		it("rejects on WebSocket error", async () => {
			const session = createGeminiLiveSession();
			const config: GeminiLiveConfig = {
				provider: "gemini-live",
				gatewayUrl: "https://gw.example.com",
				naiaKey: "key",
			};
			const promise = session.connect(config);

			setTimeout(() => {
				lastWs.onerror?.({} as any);
			}, 0);

			await expect(promise).rejects.toThrow("WebSocket error");
		});
	});
});
