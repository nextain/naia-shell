import { describe, expect, it } from "vitest";
import type { BgmPlaybackSnapshot } from "../../bgm-playback";
import {
	WEB_DJ_END_GRACE_MS,
	createWebRadioDj,
	djFallbackLine,
} from "../web-radio-dj";

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function snap(
	id: string,
	status: BgmPlaybackSnapshot["status"],
	title = `T-${id}`,
): BgmPlaybackSnapshot {
	return {
		playbackId: id,
		commandId: "c",
		sequence: 1,
		status,
		updatedAt: 0,
		freshUntil: 0,
		selected: { videoId: id, title },
	};
}

function setup(
	generate: (p: string) => Promise<string>,
	isChatBusy?: () => boolean,
) {
	let current: BgmPlaybackSnapshot | null = null;
	let t = 0;
	const out: Array<Record<string, unknown>> = [];
	const dj = createWebRadioDj({
		emit: (_e, p) => out.push(JSON.parse(p)),
		getPlayback: () => current,
		generate,
		isChatBusy,
		sleep: () => flush(),
		now: () => t,
		setTimer: () => 1,
		clearTimer: () => {},
	});
	return {
		dj,
		out,
		set: (s: BgmPlaybackSnapshot | null) => {
			current = s;
		},
		advance: (ms: number) => {
			t += ms;
		},
	};
}

describe("web radio dj", () => {
	it("introduces a playing track with a proactive text chunk", async () => {
		const h = setup(async () => "  곡 소개 멘트 ");
		h.dj.start({ subscriptionEpoch: 3 });
		h.set(snap("p1", "loading"));
		h.dj.tick();
		await flush();
		expect(h.out).toHaveLength(0);
		h.set(snap("p1", "playing"));
		h.dj.tick();
		await flush();
		h.dj.tick();
		await flush();
		expect(h.out).toHaveLength(1);
		expect(h.out[0]).toMatchObject({
			type: "text",
			text: "곡 소개 멘트",
			subscriptionEpoch: 3,
			profileGeneration: 3,
			activityId: "web-radio-dj-3",
		});
	});

	it("holds the intro until the user's chat turn finishes", async () => {
		let chatBusy = true;
		const h = setup(async () => "멘트", () => chatBusy);
		h.dj.start({ subscriptionEpoch: 1 });
		h.set(snap("p1", "playing"));
		h.dj.tick();
		for (let i = 0; i < 5; i++) await flush();
		expect(h.out).toHaveLength(0);
		chatBusy = false;
		for (let i = 0; i < 3; i++) await flush();
		expect(h.out).toHaveLength(1);
		expect(h.out[0]).toMatchObject({ type: "text", text: "멘트" });
	});

	it("falls back to a fixed line when the LLM fails", async () => {
		const h = setup(async () => {
			throw new Error("x");
		});
		h.dj.start({ subscriptionEpoch: 1 });
		h.set(snap("p1", "playing", "Song A"));
		h.dj.tick();
		await flush();
		expect(h.out[0]?.text).toBe(
			djFallbackLine({ kind: "intro", title: "Song A" }),
		);
	});

	it("speaks one transition line when the next track follows an end", async () => {
		const prompts: string[] = [];
		const h = setup(async (p) => {
			prompts.push(p);
			return "";
		});
		h.dj.start({ subscriptionEpoch: 1 });
		h.set(snap("p1", "playing", "A"));
		h.dj.tick();
		await flush();
		h.set(snap("p1", "ended", "A"));
		h.dj.tick();
		h.set(snap("p2", "playing", "B"));
		h.dj.tick();
		await flush();
		expect(h.out).toHaveLength(2);
		expect(prompts[1]).toContain("A");
		expect(prompts[1]).toContain("B");
	});

	it("speaks an outro after the grace period with no next track", async () => {
		const h = setup(async () => "");
		h.dj.start({ subscriptionEpoch: 1 });
		h.set(snap("p1", "playing", "A"));
		h.dj.tick();
		await flush();
		h.set(snap("p1", "ended", "A"));
		h.dj.tick();
		h.advance(WEB_DJ_END_GRACE_MS + 1);
		h.dj.tick();
		await flush();
		expect(h.out).toHaveLength(2);
		expect(String(h.out[1]?.text)).toContain("A");
	});

	it("drops a pending line after stop", async () => {
		let release!: (v: string) => void;
		const h = setup(() => new Promise<string>((r) => (release = r)));
		h.dj.start({ subscriptionEpoch: 1 });
		h.set(snap("p1", "playing"));
		h.dj.tick();
		h.dj.stop();
		release("late");
		await flush();
		expect(h.out).toHaveLength(0);
		expect(h.dj.running).toBe(false);
	});
});
