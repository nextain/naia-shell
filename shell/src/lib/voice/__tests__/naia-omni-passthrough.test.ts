/**
 * Passthrough tests for the naia-omni realtime session.
 *
 * After the server-VAD passthrough refactor, sendAudio streams each mic chunk
 * straight to input_audio_buffer.append with NO client-side buffering, silence
 * timer, manual commit, or minimum-length filter. Turn boundaries are the
 * server's silero VAD responsibility. Mirrors openai-realtime.ts + the web demo
 * (naia-model-infra/static/voice-demo).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNaiaOmniSession } from "../naia-omni";
import type { NaiaOmniConfig } from "../types";

interface MockWSInstance {
	url: string;
	onopen: (() => void) | null;
	onmessage: ((event: { data: string }) => void) | null;
	onerror: (() => void) | null;
	onclose:
		| ((event: { code: number; reason: string; wasClean: boolean }) => void)
		| null;
	send: ReturnType<typeof vi.fn>;
	close: ReturnType<typeof vi.fn>;
}

let lastWs: MockWSInstance;

class MockWebSocket implements MockWSInstance {
	url: string;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	onclose:
		| ((event: { code: number; reason: string; wasClean: boolean }) => void)
		| null = null;
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

function connect(config: NaiaOmniConfig) {
	const session = createNaiaOmniSession();
	const promise = session.connect(config);
	setTimeout(() => {
		lastWs.onmessage?.({ data: JSON.stringify({ type: "session.created" }) });
	}, 0);
	return { session, promise };
}

/** base64-encoded Int16-LE PCM of `samples` frames (non-silent). */
function makePcmBase64(samples: number): string {
	const pcm = new Int16Array(samples).fill(1000);
	const bytes = new Uint8Array(pcm.buffer);
	let bin = "";
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
	return btoa(bin);
}

const DIRECT: NaiaOmniConfig = {
	provider: "naia-omni",
	serverUrl: "http://localhost:8000",
};

describe("naia-omni passthrough", () => {
	it("declares 24kHz capture, no AGC, echo gate on", () => {
		const session = createNaiaOmniSession();
		expect(session.audioInput).toEqual({
			sampleRate: 24000,
			autoGainControl: false,
			gateWhilePlaying: true,
		});
	});

	it("sends each chunk as input_audio_buffer.append with no manual commit", async () => {
		const { session, promise } = connect(DIRECT);
		await promise;
		lastWs.send.mockClear(); // drop the initial session.update
		session.sendAudio(makePcmBase64(160));
		session.sendAudio(makePcmBase64(160));
		const types = lastWs.send.mock.calls.map(
			(c) => JSON.parse(c[0] as string).type,
		);
		expect(types).toEqual([
			"input_audio_buffer.append",
			"input_audio_buffer.append",
		]);
		expect(types).not.toContain("input_audio_buffer.commit");
	});

	it("forwards the base64 audio verbatim (no re-encode)", async () => {
		const { session, promise } = connect(DIRECT);
		await promise;
		lastWs.send.mockClear();
		const b64 = makePcmBase64(160);
		session.sendAudio(b64);
		const msg = JSON.parse(lastWs.send.mock.calls[0][0] as string);
		expect(msg.audio).toBe(b64);
	});

	it("does not drop short chunks (no MIN_AUDIO_SAMPLES filter)", async () => {
		const { session, promise } = connect(DIRECT);
		await promise;
		lastWs.send.mockClear();
		// 10 frames — far below the old 8000-sample (0.5s) discard threshold.
		session.sendAudio(makePcmBase64(10));
		expect(lastWs.send).toHaveBeenCalledTimes(1);
		expect(JSON.parse(lastWs.send.mock.calls[0][0] as string).type).toBe(
			"input_audio_buffer.append",
		);
	});

	it("ignores audio when not connected", () => {
		const session = createNaiaOmniSession();
		// No connect() — sendAudio must be a no-op, not throw.
		expect(() => session.sendAudio(makePcmBase64(160))).not.toThrow();
	});
});
