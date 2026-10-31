// @vitest-environment jsdom
import { emit, listen } from "@tauri-apps/api/event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emitWebEvent, resetEventBus } from "../event-bus";
import { installWebRuntime } from "../install";

describe("event-sdk", () => {
	beforeEach(() => {
		resetEventBus();
		installWebRuntime();
	});

	it("dispatches events via real Tauri SDK functions and emitWebEvent correctly", async () => {
		const cb = vi.fn();

		// 1. listen to event "x"
		const un = await listen<number>("x", cb);

		// 2. emit("x", 1) -> cb called exactly 1 time with payload: 1
		await emit("x", 1);
		expect(cb).toHaveBeenCalledTimes(1);
		expect(cb).toHaveBeenLastCalledWith(
			expect.objectContaining({
				event: "x",
				payload: 1,
			}),
		);

		// 3. emitWebEvent("x", 2) -> cb accumulated to 2 times
		emitWebEvent("x", 2);
		expect(cb).toHaveBeenCalledTimes(2);
		expect(cb).toHaveBeenLastCalledWith(
			expect.objectContaining({
				event: "x",
				payload: 2,
			}),
		);

		// 4. unlisten
		await un();

		// 5. emit after unlisten -> cb count remains 2
		await emit("x", 3);
		emitWebEvent("x", 4);
		expect(cb).toHaveBeenCalledTimes(2);

		// 6. emit to different event "y" -> cb not called
		await emit("y", 99);
		emitWebEvent("y", 99);
		expect(cb).toHaveBeenCalledTimes(2);
	});
});
