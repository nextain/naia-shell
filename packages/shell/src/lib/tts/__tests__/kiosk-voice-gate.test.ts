import { afterEach, describe, expect, it } from "vitest";
import {
	KIOSK_VOICE_MAX_IN_FLIGHT,
	resetKioskVoiceGateForTest,
	runKioskVoiceSlot,
} from "../kiosk-voice-gate";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe("runKioskVoiceSlot", () => {
	afterEach(() => resetKioskVoiceGateForTest());

	it("never runs more than the cap at once and starts waiters in order", async () => {
		let running = 0;
		let peak = 0;
		const gates = Array.from({ length: 6 }, deferred);
		const order: number[] = [];
		const runs = gates.map((g, i) =>
			runKioskVoiceSlot(async () => {
				running += 1;
				peak = Math.max(peak, running);
				order.push(i);
				await g.promise;
				running -= 1;
				return i;
			}),
		);
		await Promise.resolve();
		expect(running).toBe(KIOSK_VOICE_MAX_IN_FLIGHT);
		for (const g of gates) {
			g.resolve();
			await new Promise((r) => setTimeout(r, 0));
		}
		expect(await Promise.all(runs)).toEqual([0, 1, 2, 3, 4, 5]);
		expect(peak).toBe(KIOSK_VOICE_MAX_IN_FLIGHT);
		expect(order).toEqual([0, 1, 2, 3, 4, 5]);
	});

	it("drops an aborted waiter without running it and frees the slot on failure", async () => {
		const hold = deferred();
		const first = runKioskVoiceSlot(() => hold.promise);
		const second = runKioskVoiceSlot(() => Promise.reject(new Error("503")));
		const controller = new AbortController();
		let ranAborted = false;
		const aborted = runKioskVoiceSlot(async () => {
			ranAborted = true;
		}, controller.signal);
		controller.abort();
		await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
		await expect(second).rejects.toThrow("503");
		const third = runKioskVoiceSlot(async () => "ok");
		await expect(third).resolves.toBe("ok");
		hold.resolve();
		await first;
		expect(ranAborted).toBe(false);
	});
});
