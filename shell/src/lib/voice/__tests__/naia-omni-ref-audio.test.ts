/**
 * Wire-level tests for MiniCPM-o voice-clone reference plumbing.
 *
 * Covers:
 *  - Optional ref_audio fields are absent when no refAudio is configured
 *  - A base64 string passes through to session.update.session.ref_audio
 *  - refAudioLanguage is forwarded as ref_audio_language alongside the audio
 *  - A server `error` event matching "Invalid ref_audio" surfaces via onError
 *    (so the UI can fall back to default voice without losing the session)
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

describe("MiniCPM-o ref_audio wire plumbing", () => {
	it("omits ref_audio fields when refAudio is not set", async () => {
		const { promise } = connect({
			provider: "naia-omni",
			serverUrl: "http://localhost:8000",
		});
		await promise;
		const update = JSON.parse(lastWs.send.mock.calls[0][0]);
		expect(update.type).toBe("session.update");
		expect(update.session).not.toHaveProperty("ref_audio");
		expect(update.session).not.toHaveProperty("ref_audio_language");
	});

	it("forwards a base64 string ref_audio verbatim", async () => {
		// 32 'A' is "AAAA…", a valid base64 alphabet string. The provider
		// must accept already-encoded strings without re-decoding through
		// the AudioContext path.
		const refAudio = "A".repeat(32);
		const { promise } = connect({
			provider: "naia-omni",
			serverUrl: "http://localhost:8000",
			refAudio,
		});
		await promise;
		const update = JSON.parse(lastWs.send.mock.calls[0][0]);
		expect(update.session.ref_audio).toBe(refAudio);
	});

	it("forwards refAudioLanguage alongside ref_audio", async () => {
		const refAudio = "A".repeat(32);
		const { promise } = connect({
			provider: "naia-omni",
			serverUrl: "http://localhost:8000",
			refAudio,
			refAudioLanguage: "zh",
		});
		await promise;
		const update = JSON.parse(lastWs.send.mock.calls[0][0]);
		expect(update.session.ref_audio).toBe(refAudio);
		expect(update.session.ref_audio_language).toBe("zh");
	});

	it("surfaces 'Invalid ref_audio' server errors via onError", async () => {
		const { session, promise } = connect({
			provider: "naia-omni",
			serverUrl: "http://localhost:8000",
			refAudio: "A".repeat(32),
		});
		await promise;

		const errors: Error[] = [];
		session.onError = (e) => errors.push(e);

		lastWs.onmessage?.({
			data: JSON.stringify({
				type: "error",
				error: {
					message: "Invalid ref_audio: ref_audio must be a RIFF/WAVE file",
				},
			}),
		});

		expect(errors).toHaveLength(1);
		expect(errors[0].message).toContain("Invalid ref_audio");
		// The session itself should still report connected — the server
		// only rejects the reference, not the whole session.
		expect(session.isConnected).toBe(true);
	});

	it("treats unrelated server errors as non-fatal (no onError surfacing)", async () => {
		const { session, promise } = connect({
			provider: "naia-omni",
			serverUrl: "http://localhost:8000",
		});
		await promise;

		const errors: Error[] = [];
		session.onError = (e) => errors.push(e);

		lastWs.onmessage?.({
			data: JSON.stringify({
				type: "error",
				error: { message: "transient backpressure" },
			}),
		});

		expect(errors).toHaveLength(0);
	});

	it("rejects the connect promise when refAudio string is not pure base64", async () => {
		const session = createNaiaOmniSession();
		await expect(
			session.connect({
				provider: "naia-omni",
				serverUrl: "http://localhost:8000",
				refAudio: "!!! not base64 !!!",
			}),
		).rejects.toThrow(/not pure base64/);
	});
});
