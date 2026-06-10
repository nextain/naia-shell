import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenAIRealtimeSession } from "../openai-realtime";
import type { OpenAIRealtimeConfig } from "../types";

interface MockWSInstance {
	url: string;
	protocols?: string | string[];
	onopen: (() => void) | null;
	onmessage: ((event: { data: string }) => void) | null;
	onerror: (() => void) | null;
	onclose: (() => void) | null;
	send: ReturnType<typeof vi.fn>;
	close: ReturnType<typeof vi.fn>;
}

let lastWs: MockWSInstance;

class MockWebSocket implements MockWSInstance {
	url: string;
	protocols?: string | string[];
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	onclose: (() => void) | null = null;
	send = vi.fn();
	close = vi.fn();
	constructor(url: string, protocols?: string | string[]) {
		this.url = url;
		this.protocols = protocols;
		lastWs = this;
	}
}

beforeEach(() => {
	vi.stubGlobal("WebSocket", MockWebSocket);
});

afterEach(() => {
	vi.restoreAllMocks();
});

function connectSession() {
	const session = createOpenAIRealtimeSession();
	const config: OpenAIRealtimeConfig = {
		provider: "openai-realtime",
		apiKey: "sk-test-key",
		voice: "shimmer",
		model: "gpt-4o-mini-realtime-preview",
	};
	const promise = session.connect(config);

	setTimeout(() => {
		lastWs.onopen?.();
		lastWs.onmessage?.({
			data: JSON.stringify({ type: "session.created" }),
		});
	}, 0);

	return { session, promise };
}

describe("OpenAIRealtime", () => {
	it("connects with correct URL and subprotocols", async () => {
		const { promise } = connectSession();
		await promise;
		expect(lastWs.url).toContain("wss://api.openai.com/v1/realtime");
		expect(lastWs.url).toContain("gpt-4o-mini-realtime-preview");
		expect(lastWs.protocols).toContain("realtime");
		expect(lastWs.protocols).toContain("openai-insecure-api-key.sk-test-key");
	});

	it("sends session.update on open", async () => {
		const { promise } = connectSession();
		await promise;
		const msg = JSON.parse(lastWs.send.mock.calls[0][0]);
		expect(msg.type).toBe("session.update");
		expect(msg.session.voice).toBe("shimmer");
		expect(msg.session.input_audio_format).toBe("pcm16");
		expect(msg.session.output_audio_format).toBe("pcm16");
	});

	it("sendAudio sends input_audio_buffer.append", async () => {
		const { session, promise } = connectSession();
		await promise;
		lastWs.send.mockClear();

		session.sendAudio("AQID");
		const msg = JSON.parse(lastWs.send.mock.calls[0][0]);
		expect(msg.type).toBe("input_audio_buffer.append");
		expect(msg.audio).toBe("AQID");
	});

	it("sendText sends conversation.item.create + response.create", async () => {
		const { session, promise } = connectSession();
		await promise;
		lastWs.send.mockClear();

		session.sendText("hello");
		expect(lastWs.send).toHaveBeenCalledTimes(2);
		const item = JSON.parse(lastWs.send.mock.calls[0][0]);
		expect(item.type).toBe("conversation.item.create");
		expect(item.item.content[0].text).toBe("hello");
		const resp = JSON.parse(lastWs.send.mock.calls[1][0]);
		expect(resp.type).toBe("response.create");
	});

	it("sendToolResponse sends function_call_output + response.create", async () => {
		const { session, promise } = connectSession();
		await promise;
		lastWs.send.mockClear();

		session.sendToolResponse("call-1", { ok: true });
		const item = JSON.parse(lastWs.send.mock.calls[0][0]);
		expect(item.type).toBe("conversation.item.create");
		expect(item.item.type).toBe("function_call_output");
		expect(item.item.call_id).toBe("call-1");
	});

	it("fires onAudio for response.audio.delta", async () => {
		const { session, promise } = connectSession();
		const onAudio = vi.fn();
		session.onAudio = onAudio;
		await promise;

		lastWs.onmessage?.({
			data: JSON.stringify({
				type: "response.audio.delta",
				delta: "audio-data",
			}),
		});
		expect(onAudio).toHaveBeenCalledWith("audio-data");
	});

	it("fires onOutputTranscript for response.audio_transcript.delta", async () => {
		const { session, promise } = connectSession();
		const onOutput = vi.fn();
		session.onOutputTranscript = onOutput;
		await promise;

		lastWs.onmessage?.({
			data: JSON.stringify({
				type: "response.audio_transcript.delta",
				delta: "model said",
			}),
		});
		expect(onOutput).toHaveBeenCalledWith("model said");
	});

	it("fires onInputTranscript for transcription completed", async () => {
		const { session, promise } = connectSession();
		const onInput = vi.fn();
		session.onInputTranscript = onInput;
		await promise;

		lastWs.onmessage?.({
			data: JSON.stringify({
				type: "conversation.item.input_audio_transcription.completed",
				transcript: "user said",
			}),
		});
		expect(onInput).toHaveBeenCalledWith("user said");
	});

	it("fires onTurnEnd for response.done", async () => {
		const { session, promise } = connectSession();
		const onEnd = vi.fn();
		session.onTurnEnd = onEnd;
		await promise;

		lastWs.onmessage?.({
			data: JSON.stringify({ type: "response.done" }),
		});
		expect(onEnd).toHaveBeenCalled();
	});

	it("fires onInterrupted for speech_started", async () => {
		const { session, promise } = connectSession();
		const onInt = vi.fn();
		session.onInterrupted = onInt;
		await promise;

		lastWs.onmessage?.({
			data: JSON.stringify({
				type: "input_audio_buffer.speech_started",
			}),
		});
		expect(onInt).toHaveBeenCalled();
	});

	it("fires onToolCall for function_call_arguments.done", async () => {
		const { session, promise } = connectSession();
		const onTool = vi.fn();
		session.onToolCall = onTool;
		await promise;

		lastWs.onmessage?.({
			data: JSON.stringify({
				type: "response.function_call_arguments.done",
				call_id: "fc-1",
				name: "get_weather",
				arguments: '{"city":"Seoul"}',
			}),
		});
		expect(onTool).toHaveBeenCalledWith("fc-1", "get_weather", {
			city: "Seoul",
		});
	});
});
