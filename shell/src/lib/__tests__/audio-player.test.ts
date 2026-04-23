import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAudioPlayer } from "../audio-player";

// Minimal AudioContext mock
class MockAudioBufferSourceNode {
	buffer: AudioBuffer | null = null;
	onended: (() => void) | null = null;
	connect = vi.fn();
	start = vi.fn().mockImplementation(() => {
		// Simulate immediate playback end for testing
		setTimeout(() => this.onended?.(), 0);
	});
	stop = vi.fn();
}

class MockAudioBuffer {
	numberOfChannels = 1;
	length: number;
	sampleRate: number;
	duration: number;
	private data: Float32Array;
	constructor(opts: { length: number; sampleRate: number }) {
		this.length = opts.length;
		this.sampleRate = opts.sampleRate;
		this.duration = opts.length / opts.sampleRate;
		this.data = new Float32Array(opts.length);
	}
	getChannelData = () => this.data;
}

class MockAudioContext {
	sampleRate = 24000;
	currentTime = 0;
	state: AudioContextState = "running";
	destination = {} as AudioDestinationNode;
	createBuffer = (_channels: number, length: number, sampleRate: number) =>
		new MockAudioBuffer({ length, sampleRate }) as unknown as AudioBuffer;
	createBufferSource = () =>
		new MockAudioBufferSourceNode() as unknown as AudioBufferSourceNode;
	resume = vi.fn().mockResolvedValue(undefined);
	close = vi.fn().mockResolvedValue(undefined);
}

beforeEach(() => {
	vi.stubGlobal("AudioContext", MockAudioContext);
});

// Helper: create a minimal base64 PCM chunk (2 samples = 4 bytes)
function makeChunk(): string {
	const buf = new ArrayBuffer(4);
	const view = new Int16Array(buf);
	view[0] = 1000;
	view[1] = -1000;
	// btoa expects binary string
	const bytes = new Uint8Array(buf);
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary);
}

describe("AudioPlayer", () => {
	it("calls onPlaybackStart on first enqueue", () => {
		const onStart = vi.fn();
		const player = createAudioPlayer({ onPlaybackStart: onStart });
		expect(onStart).not.toHaveBeenCalled();
		player.enqueue(makeChunk());
		expect(onStart).toHaveBeenCalledTimes(1);
	});

	it("resumes suspended AudioContext on enqueue", () => {
		let resumeCalled = false;
		const OrigCtx = MockAudioContext;
		class SuspendedCtx extends OrigCtx {
			state = "suspended" as AudioContextState;
			resume = vi.fn().mockImplementation(() => {
				resumeCalled = true;
				this.state = "running";
				return Promise.resolve();
			});
		}
		vi.stubGlobal("AudioContext", SuspendedCtx);

		const player2 = createAudioPlayer();
		player2.enqueue(makeChunk());
		expect(resumeCalled).toBe(true);
	});

	it("does not call onPlaybackEnd on clear() when already idle", () => {
		const onEnd = vi.fn();
		const player = createAudioPlayer({ onPlaybackEnd: onEnd });
		// clear without any enqueue — should NOT fire onPlaybackEnd
		player.clear();
		expect(onEnd).not.toHaveBeenCalled();
	});

	it("calls onPlaybackEnd on clear() when playing", () => {
		const onEnd = vi.fn();
		const player = createAudioPlayer({ onPlaybackEnd: onEnd });
		player.enqueue(makeChunk());
		// Now clear while "playing"
		player.clear();
		expect(onEnd).toHaveBeenCalledTimes(1);
	});

	it("does not enqueue after destroy", () => {
		const onStart = vi.fn();
		const player = createAudioPlayer({ onPlaybackStart: onStart });
		player.destroy();
		player.enqueue(makeChunk());
		// onPlaybackStart called once from clear() inside destroy — but not from enqueue
		expect(onStart).not.toHaveBeenCalled();
	});

	it("reports isPlaying correctly", () => {
		const player = createAudioPlayer();
		expect(player.isPlaying).toBe(false);
		player.enqueue(makeChunk());
		expect(player.isPlaying).toBe(true);
		player.clear();
		expect(player.isPlaying).toBe(false);
	});

	it("keeps isPlaying true within speaker-drain margin after natural playback end", async () => {
		// Per Issue #230: isPlaying must stay true for SPEAKER_DRAIN_MARGIN_MS (200ms)
		// after the last source.onended fires, to keep the mic gated while the
		// physical speaker finishes emitting audio. Without this, the last ~200ms
		// of playback gets captured back as user input (echo feedback loop).
		let capturedCtx: { currentTime: number } | null = null;
		class TrackedCtx extends MockAudioContext {
			constructor() {
				super();
				capturedCtx = this;
			}
		}
		vi.stubGlobal("AudioContext", TrackedCtx);

		const player = createAudioPlayer();
		player.enqueue(makeChunk());
		// Flush the setTimeout(() => onended(), 0) from the mock source.start
		await new Promise((resolve) => setTimeout(resolve, 1));
		// activeSourceCount is now 0 but nextStartTime > 0 and currentTime = 0
		// → should stay true via drain margin
		expect(player.isPlaying).toBe(true);

		// Advance currentTime past nextStartTime + 200ms → gate opens
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		if (capturedCtx) (capturedCtx as any).currentTime = 10;
		expect(player.isPlaying).toBe(false);
	});

	it("isPlaying is false when idle with no scheduled audio", () => {
		const player = createAudioPlayer();
		// Never enqueued — activeSourceCount=0, nextStartTime=0
		expect(player.isPlaying).toBe(false);
	});
});
