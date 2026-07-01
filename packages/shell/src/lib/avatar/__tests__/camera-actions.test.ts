import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearCameraActions,
	getCameraActions,
	registerCameraActions,
} from "../camera-actions";

describe("camera-actions bridge", () => {
	beforeEach(() => {
		clearCameraActions();
	});

	it("returns a stable singleton across calls", () => {
		expect(getCameraActions()).toBe(getCameraActions());
	});

	it("defaults to no-ops that do not throw", () => {
		const a = getCameraActions();
		expect(() => {
			a.rotate(1, 2);
			a.pan(3, 4);
			a.reset();
			a.save();
		}).not.toThrow();
	});

	it("registers an implementation that the singleton delegates to", () => {
		const pan = vi.fn();
		const reset = vi.fn();
		registerCameraActions({ pan, reset });

		getCameraActions().pan(5, -3);
		getCameraActions().reset();

		expect(pan).toHaveBeenCalledWith(5, -3);
		expect(reset).toHaveBeenCalledTimes(1);
	});

	it("partial register leaves untouched fields as prior value", () => {
		const rotate = vi.fn();
		registerCameraActions({ rotate });
		// pan was not provided → stays the default no-op (must not throw)
		expect(() => getCameraActions().pan(1, 1)).not.toThrow();
		getCameraActions().rotate(2, 2);
		expect(rotate).toHaveBeenCalledWith(2, 2);
	});

	it("clear reverts to no-ops so a stale impl is not called", () => {
		const pan = vi.fn();
		registerCameraActions({ pan });
		clearCameraActions();
		getCameraActions().pan(9, 9);
		expect(pan).not.toHaveBeenCalled();
	});
});
