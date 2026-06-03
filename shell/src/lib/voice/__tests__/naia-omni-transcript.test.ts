/**
 * Protocol-level tests for naia-omni transcript surfacing.
 *
 * Regression cover for the two server events the provider previously dropped:
 *  - G1: conversation.item.input_audio_transcription.completed → onInputTranscript
 *        (server STT of the user's spoken turn; registry marks
 *         naia-0.9-omni-24g transcriptProvided:true)
 *  - G2: response.text.delta → onOutputTranscript
 *        (text-input turns stream the assistant reply via text.delta from the
 *         server's _process_text_turn; voice turns use audio_transcript.delta)
 *
 * Verified against the live dev gateway (2026-05-31): a text turn returns
 * `response.text.delta` chunks, not `response.audio_transcript.delta`.
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

const DIRECT: NaiaOmniConfig = {
	provider: "naia-omni",
	serverUrl: "http://localhost:8000",
};

function emit(msg: Record<string, unknown>) {
	lastWs.onmessage?.({ data: JSON.stringify(msg) });
}

describe("naia-omni transcript surfacing", () => {
	it("forwards user STT via onInputTranscript (input_audio_transcription.completed)", async () => {
		const { session, promise } = connect(DIRECT);
		await promise;

		const inputs: string[] = [];
		session.onInputTranscript = (t) => inputs.push(t);

		emit({
			type: "conversation.item.input_audio_transcription.completed",
			transcript: "안녕하세요",
			item_id: "item_1",
		});

		expect(inputs).toEqual(["안녕하세요"]);
	});

	it("forwards text-turn output via onOutputTranscript (response.text.delta)", async () => {
		const { session, promise } = connect(DIRECT);
		await promise;

		const outputs: string[] = [];
		session.onOutputTranscript = (t) => outputs.push(t);

		emit({ type: "response.text.delta", delta: "무엇을", response_id: "resp_1" });
		emit({
			type: "response.text.delta",
			delta: " 도와드릴까요?",
			response_id: "resp_1",
		});

		expect(outputs).toEqual(["무엇을", " 도와드릴까요?"]);
	});

	it("still forwards voice-turn output via onOutputTranscript (response.audio_transcript.delta)", async () => {
		// Regression: the existing voice path must keep working after adding the
		// shared text.delta case (fall-through to the same handler).
		const { session, promise } = connect(DIRECT);
		await promise;

		const outputs: string[] = [];
		session.onOutputTranscript = (t) => outputs.push(t);

		emit({
			type: "response.audio_transcript.delta",
			delta: "네",
			item_id: "i",
			response_id: "r",
		});

		expect(outputs).toEqual(["네"]);
	});

	it("forwards server emotion tags via onEmotion (emotion.updated, manual §5)", async () => {
		const { session, promise } = connect(DIRECT);
		await promise;

		const emotions: string[] = [];
		session.onEmotion = (state) => emotions.push(state);

		emit({ type: "emotion.updated", state: "happy", tag: "[happy]", known: true });
		emit({ type: "emotion.updated", state: "shy", tag: "[shy]", known: false });

		// Raw state forwarded (UI maps to an avatar EmotionName; unknown ignored).
		expect(emotions).toEqual(["happy", "shy"]);
	});

	it("ignores emotion.updated with no state", async () => {
		const { session, promise } = connect(DIRECT);
		await promise;

		const emotions: string[] = [];
		session.onEmotion = (state) => emotions.push(state);

		emit({ type: "emotion.updated" });

		expect(emotions).toEqual([]);
	});

	it("ignores transcript events that carry no payload", async () => {
		const { session, promise } = connect(DIRECT);
		await promise;

		const inputs: string[] = [];
		const outputs: string[] = [];
		session.onInputTranscript = (t) => inputs.push(t);
		session.onOutputTranscript = (t) => outputs.push(t);

		emit({ type: "conversation.item.input_audio_transcription.completed" });
		emit({ type: "response.text.delta" });

		expect(inputs).toEqual([]);
		expect(outputs).toEqual([]);
	});
});
