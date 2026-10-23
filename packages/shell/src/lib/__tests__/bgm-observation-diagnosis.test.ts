import { describe, expect, it } from "vitest";
import {
	type BgmObservationCounters,
	createYoutubeIframeBridgeHandshake,
	decideIframeMessageSource,
	diagnoseBgmObservationFailure,
	emptyBgmObservationCounters,
	YOUTUBE_WIDGET_LISTENING_MESSAGE,
	YOUTUBE_WIDGET_SUBSCRIBE_MESSAGES,
} from "../bgm-observation-diagnosis";

function counters(
	over: Partial<BgmObservationCounters> = {},
): BgmObservationCounters {
	return { ...emptyBgmObservationCounters(), ...over };
}

describe("diagnoseBgmObservationFailure", () => {
	it("아무 메시지도 안 왔으면 브리지가 성립하지 않은 것이다", () => {
		const d = diagnoseBgmObservationFailure(counters());
		expect(d.cause).toBe("no_bridge_messages");
		expect(d.summary).toContain("한 건도");
	});

	it("전부 필터에 걸렸으면 보낸 창이 다른 것이다", () => {
		const d = diagnoseBgmObservationFailure(counters({ filteredOut: 14 }));
		expect(d.cause).toBe("source_filter_dropped");
		expect(d.summary).toContain("14건");
	});

	it("도착은 했는데 식별자가 어긋났으면 그것으로 가른다", () => {
		const d = diagnoseBgmObservationFailure(
			counters({
				received: 9,
				idMismatched: 9,
				expectedPlaybackId: "pb-a",
				activePlaybackId: "pb-b",
			}),
		);
		expect(d.cause).toBe("playback_id_mismatch");
		expect(d.summary).toContain("pb-a");
		expect(d.summary).toContain("pb-b");
	});

	it("상태 메시지까지 봤다면 식별자 탓으로 돌리지 않는다", () => {
		const d = diagnoseBgmObservationFailure(
			counters({ received: 9, idMismatched: 2, stateChangeSeen: true }),
		);
		expect(d.cause).toBe("no_playing_state");
	});

	it("메시지는 왔으나 재생 상태가 없으면 그렇게 적는다", () => {
		const d = diagnoseBgmObservationFailure(
			counters({ received: 20, stateChangeSeen: true, infoDeliverySeen: true }),
		);
		expect(d.cause).toBe("no_playing_state");
		expect(d.summary).toContain("onStateChange 있음");
		expect(d.summary).toContain("infoDelivery 있음");
	});

	it("필터 드랍이 섞여 있어도 도착분이 있으면 필터 탓이 아니다", () => {
		const d = diagnoseBgmObservationFailure(
			counters({ received: 3, filteredOut: 40, stateChangeSeen: true }),
		);
		expect(d.cause).toBe("no_playing_state");
	});

	it("새 재생마다 셈은 0 에서 시작한다", () => {
		expect(emptyBgmObservationCounters()).toEqual({
			received: 0,
			filteredOut: 0,
			idMismatched: 0,
			stateChangeSeen: false,
			infoDeliverySeen: false,
		});
	});
});

describe("decideIframeMessageSource (#671 / #557)", () => {
	const active = {} as Window;

	it("keeps a matching window", () => {
		expect(
			decideIframeMessageSource({
				eventSource: active as unknown as MessageEventSource,
				activeContentWindow: active,
				event: "onStateChange",
				info: 1,
			}),
		).toBe("accept");
	});

	it("drops a different window", () => {
		expect(
			decideIframeMessageSource({
				eventSource: {} as MessageEventSource,
				activeContentWindow: active,
				event: "onStateChange",
				info: 1,
			}),
		).toBe("drop_foreign_window");
	});

	it("accepts Tauri null-source playing and progress events", () => {
		expect(
			decideIframeMessageSource({
				eventSource: null,
				activeContentWindow: active,
				event: "onStateChange",
				info: 1,
			}),
		).toBe("accept");
		expect(
			decideIframeMessageSource({
				eventSource: null,
				activeContentWindow: active,
				event: "infoDelivery",
				info: { currentTime: 2 },
			}),
		).toBe("accept");
	});

	it("drops null-source error and ended so a detached track cannot fail the next one", () => {
		expect(
			decideIframeMessageSource({
				eventSource: null,
				activeContentWindow: active,
				event: "onError",
				info: 150,
			}),
		).toBe("drop_null_terminal");
		expect(
			decideIframeMessageSource({
				eventSource: null,
				activeContentWindow: active,
				event: "onStateChange",
				info: 0,
			}),
		).toBe("drop_null_terminal");
	});
});

describe("createYoutubeIframeBridgeHandshake (#521)", () => {
	it("initiates listening on start, polls until first message, then subscribes to onStateChange and onError once", () => {
		const posted: string[] = [];
		let tickFn: (() => void) | null = null;
		let cleared = 0;

		const handshake = createYoutubeIframeBridgeHandshake(
			(payload) => {
				posted.push(payload);
				return true;
			},
			{
				intervalMs: 250,
				maxAttempts: 4,
				setTimer: (fn) => {
					tickFn = fn;
					return 1 as unknown as ReturnType<typeof setInterval>;
				},
				clearTimer: () => {
					cleared += 1;
					tickFn = null;
				},
			},
		);

		handshake.start();
		expect(posted).toEqual([YOUTUBE_WIDGET_LISTENING_MESSAGE]);
		expect(handshake.attempts()).toBe(1);
		expect(handshake.isSubscribed()).toBe(false);

		tickFn?.();
		expect(posted).toEqual([
			YOUTUBE_WIDGET_LISTENING_MESSAGE,
			YOUTUBE_WIDGET_LISTENING_MESSAGE,
		]);
		expect(handshake.attempts()).toBe(2);

		expect(handshake.onFirstMessage()).toBe(true);
		expect(handshake.isSubscribed()).toBe(true);
		expect(cleared).toBeGreaterThanOrEqual(1);
		expect(posted.slice(2)).toEqual([...YOUTUBE_WIDGET_SUBSCRIBE_MESSAGES]);

		// Subsequent messages must not re-send subscriptions.
		expect(handshake.onFirstMessage()).toBe(false);
		expect(posted).toHaveLength(2 + YOUTUBE_WIDGET_SUBSCRIBE_MESSAGES.length);
	});

	it("stops polling after maxAttempts when the iframe never responds", () => {
		const posted: string[] = [];
		let tickFn: (() => void) | null = null;
		let cleared = 0;

		const handshake = createYoutubeIframeBridgeHandshake(
			(payload) => {
				posted.push(payload);
				return true;
			},
			{
				intervalMs: 250,
				maxAttempts: 3,
				setTimer: (fn) => {
					tickFn = fn;
					return 1 as unknown as ReturnType<typeof setInterval>;
				},
				clearTimer: () => {
					cleared += 1;
					tickFn = null;
				},
			},
		);

		handshake.start();
		tickFn?.();
		tickFn?.();
		expect(handshake.attempts()).toBe(3);
		expect(posted).toHaveLength(3);
		expect(cleared).toBeGreaterThanOrEqual(1);
	});
});
