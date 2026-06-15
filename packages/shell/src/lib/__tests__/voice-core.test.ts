// UC2(V2) graft seam 테스트 — makeCoreAudioPlayer 가 실 core(dist) V2 ExpressionPort 경유로
// enqueue→play / clear→clearAudio 를 라우팅하나(셸 audio-player 주입). shell-compat(core) mock 안 함(실 dist 통합).
import { describe, expect, it, vi } from "vitest";
import type { AudioPlayer } from "../audio-player";
import { makeCoreAudioPlayer } from "../voice-core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));

function fakePlayer() {
	const calls = { enqueue: [] as string[], clear: 0, destroy: 0 };
	let playing = false;
	const player: AudioPlayer = {
		enqueue: (pcm: string) => { calls.enqueue.push(pcm); playing = true; },
		clear: () => { calls.clear++; playing = false; },
		destroy: () => { calls.destroy++; },
		get isPlaying() { return playing; },
	};
	return { player, calls };
}

describe("UC2 graft seam — makeCoreAudioPlayer (실 core ExpressionPort 경유)", () => {
	it("enqueue(pcm) → ExpressionPort.play → 주입 player.enqueue", () => {
		const { player, calls } = fakePlayer();
		const core = makeCoreAudioPlayer({}, () => player);
		core.enqueue("PCM_A");
		core.enqueue("PCM_B");
		expect(calls.enqueue).toEqual(["PCM_A", "PCM_B"]);
	});

	it("clear() → ExpressionPort.clearAudio → 주입 player.clear (barge-in)", () => {
		const { player, calls } = fakePlayer();
		const core = makeCoreAudioPlayer({}, () => player);
		core.enqueue("X");
		core.clear();
		expect(calls.clear).toBe(1);
	});

	it("destroy()/isPlaying = lifecycle 브리지(포트 밖) → 내부 player 직결", () => {
		const { player, calls } = fakePlayer();
		const core = makeCoreAudioPlayer({}, () => player);
		expect(core.isPlaying).toBe(false);
		core.enqueue("X");
		expect(core.isPlaying).toBe(true); // player.enqueue 가 playing=true
		core.destroy();
		expect(calls.destroy).toBe(1);
	});

	it("opts(onPlaybackStart/End/sampleRate) 가 생성자에 전달(avatar speaking 보존)", () => {
		const create = vi.fn(() => fakePlayer().player);
		const opts = { sampleRate: 24000, onPlaybackStart: () => {}, onPlaybackEnd: () => {} };
		makeCoreAudioPlayer(opts, create);
		expect(create).toHaveBeenCalledWith(opts);
	});
});
