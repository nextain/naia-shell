import { describe, expect, it } from "vitest";
import { createMouthController } from "../mouth";

/** VRM 1.0 style (lowercase vowels) */
function createMockVrm10() {
	const values = new Map<string, number>();
	return {
		expressionManager: {
			expressionMap: { aa: {}, ee: {}, ih: {}, oh: {}, ou: {} },
			setValue: (name: string, value: number) => {
				values.set(name, value);
			},
			getValue: (name: string) => values.get(name) ?? 0,
		},
		_values: values,
	};
}

/** VRM 0.0 style (PascalCase vowels: A, E, I, O, U) */
function createMockVrm00() {
	const values = new Map<string, number>();
	return {
		expressionManager: {
			expressionMap: { A: {}, E: {}, I: {}, O: {}, U: {} },
			setValue: (name: string, value: number) => {
				values.set(name, value);
			},
			getValue: (name: string) => values.get(name) ?? 0,
		},
		_values: values,
	};
}

describe("createMouthController", () => {
	it("creates controller with setSpeaking and update", () => {
		const vrm = createMockVrm10();
		const ctrl = createMouthController(vrm as any);
		expect(ctrl.setSpeaking).toBeDefined();
		expect(ctrl.update).toBeDefined();
		expect(ctrl.stop).toBeDefined();
	});

	it("all mouth blendshapes are 0 when not speaking (VRM 1.0)", () => {
		const vrm = createMockVrm10();
		const ctrl = createMouthController(vrm as any);
		ctrl.update(0.016);
		expect(vrm._values.get("aa") ?? 0).toBe(0);
		expect(vrm._values.get("ee") ?? 0).toBe(0);
		expect(vrm._values.get("ih") ?? 0).toBe(0);
		expect(vrm._values.get("oh") ?? 0).toBe(0);
		expect(vrm._values.get("ou") ?? 0).toBe(0);
	});

	it("mouth opens when speaking (VRM 1.0)", () => {
		const vrm = createMockVrm10();
		const ctrl = createMouthController(vrm as any);

		ctrl.setSpeaking(true);
		expect(ctrl.isSpeaking).toBe(true);

		for (let i = 0; i < 10; i++) {
			ctrl.update(0.016);
		}

		const aa = vrm._values.get("aa") ?? 0;
		expect(aa).toBeGreaterThan(0);
	});

	it("mouth opens when speaking (VRM 0.0 — PascalCase vowels)", () => {
		const vrm = createMockVrm00();
		const ctrl = createMouthController(vrm as any);

		ctrl.setSpeaking(true);
		for (let i = 0; i < 10; i++) {
			ctrl.update(0.016);
		}

		// VRM 0.0 uses "A" instead of "aa"
		const a = vrm._values.get("A") ?? 0;
		expect(a).toBeGreaterThan(0);
	});

	it("mouth closes after stop", () => {
		const vrm = createMockVrm10();
		const ctrl = createMouthController(vrm as any);

		ctrl.setSpeaking(true);
		for (let i = 0; i < 10; i++) ctrl.update(0.016);

		ctrl.stop();
		expect(ctrl.isSpeaking).toBe(false);

		for (let i = 0; i < 30; i++) ctrl.update(0.016);
		const aa = vrm._values.get("aa") ?? 0;
		expect(aa).toBeLessThan(0.05);
	});
});
