/**
 * Wire-level tests for naia-omni STT recognition-language pinning.
 *
 * Background: the cascade defaults to auto-detect (manual §realtime). When the
 * spoken language is not recognized well (e.g. Korean misdetected as another
 * language) the UI language must be pinned. `setup.locale` is swallowed by the
 * gateway, so the only effective pin path is `session.update` with
 * `input_audio_transcription.language` (ISO-639-1).
 *
 * Covers:
 *  - Initial connect pins input_audio_transcription.language from `locale`
 *  - A region locale ("ko-KR") is normalized to ISO-639-1 ("ko")
 *  - The field is omitted when no locale is set (cascade auto-detect)
 *  - setLanguage() pushes a mid-session session.update (no reconnect)
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

describe("naia-omni STT language pin", () => {
	it("pins input_audio_transcription.language from locale on initial connect", async () => {
		const { promise } = connect({
			provider: "naia-omni",
			serverUrl: "http://localhost:8000",
			locale: "ko",
		});
		await promise;
		const update = JSON.parse(lastWs.send.mock.calls[0][0]);
		expect(update.type).toBe("session.update");
		expect(update.session.input_audio_transcription.language).toBe("ko");
	});

	it("normalizes a region locale (ko-KR) to ISO-639-1 (ko)", async () => {
		const { promise } = connect({
			provider: "naia-omni",
			serverUrl: "http://localhost:8000",
			locale: "ko-KR",
		});
		await promise;
		const update = JSON.parse(lastWs.send.mock.calls[0][0]);
		expect(update.session.input_audio_transcription.language).toBe("ko");
	});

	it("omits input_audio_transcription when no locale is set (cascade auto-detect)", async () => {
		const { promise } = connect({
			provider: "naia-omni",
			serverUrl: "http://localhost:8000",
		});
		await promise;
		const update = JSON.parse(lastWs.send.mock.calls[0][0]);
		expect(update.session).not.toHaveProperty("input_audio_transcription");
	});

	it("setLanguage pushes a mid-session session.update (no reconnect)", async () => {
		const { session, promise } = connect({
			provider: "naia-omni",
			serverUrl: "http://localhost:8000",
			locale: "ko",
		});
		await promise;
		lastWs.send.mockClear(); // drop the initial session.update
		session.setLanguage?.("en");
		const update = JSON.parse(lastWs.send.mock.calls[0][0]);
		expect(update.type).toBe("session.update");
		expect(update.session.input_audio_transcription.language).toBe("en");
	});

	it("setLanguage(null) is a no-op on the wire", async () => {
		const { session, promise } = connect({
			provider: "naia-omni",
			serverUrl: "http://localhost:8000",
			locale: "ko",
		});
		await promise;
		lastWs.send.mockClear();
		session.setLanguage?.(null);
		expect(lastWs.send).not.toHaveBeenCalled();
	});
});
