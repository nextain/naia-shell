// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
	type NvaGestureShortcutEvent,
	isNvaGestureTerminalTarget,
	nvaGestureActionIndexFromKeyboardEvent,
	nvaGestureShortcutLabel,
} from "../nva-action-hotkeys";

function keyEvent(
	overrides: Partial<NvaGestureShortcutEvent> = {},
): NvaGestureShortcutEvent {
	return {
		altKey: true,
		ctrlKey: false,
		metaKey: false,
		shiftKey: false,
		repeat: false,
		isComposing: false,
		keyCode: 49,
		code: "Digit1",
		key: "¡",
		...overrides,
	};
}

describe("NVA action shortcuts", () => {
	it.each([1, 2, 3, 4, 5, 6, 7, 8, 9])(
		"maps Alt+Digit%d to the zero-based action index",
		(number) => {
			expect(
				nvaGestureActionIndexFromKeyboardEvent(
					keyEvent({ code: `Digit${number}`, key: String(number) }),
					9,
				),
			).toBe(number - 1);
		},
	);

	it("uses code when macOS Option+1 changes key to a symbol", () => {
		expect(
			nvaGestureActionIndexFromKeyboardEvent(
				keyEvent({ code: "Digit1", key: "¡" }),
				2,
			),
		).toBe(0);
		expect(
			nvaGestureActionIndexFromKeyboardEvent(
				keyEvent({ code: "Unidentified", key: "¡" }),
				2,
			),
		).toBeNull();
	});

	it.each([
		["Ctrl", { ctrlKey: true }],
		["Meta", { metaKey: true }],
		["Shift", { shiftKey: true }],
		["repeat", { repeat: true }],
		["IME composition", { isComposing: true }],
		["IME keyCode 229", { keyCode: 229 }],
	] as const)("ignores %s", (_name, overrides) => {
		expect(
			nvaGestureActionIndexFromKeyboardEvent(keyEvent(overrides), 9),
		).toBeNull();
	});

	it("ignores Linux AltGraph when Ctrl is not reported", () => {
		expect(
			nvaGestureActionIndexFromKeyboardEvent(
				keyEvent({ getModifierState: (modifier) => modifier === "AltGraph" }),
				9,
			),
		).toBeNull();
	});

	it("ignores non-Alt, AltGr and terminal input", () => {
		expect(
			nvaGestureActionIndexFromKeyboardEvent(keyEvent({ altKey: false }), 9),
		).toBeNull();
		expect(
			nvaGestureActionIndexFromKeyboardEvent(
				keyEvent({ ctrlKey: true, altKey: true }),
				9,
			),
		).toBeNull();
		expect(
			nvaGestureActionIndexFromKeyboardEvent(keyEvent(), 9, true),
		).toBeNull();
	});

	it("does not intercept an empty/out-of-range list or keypad digits", () => {
		expect(nvaGestureActionIndexFromKeyboardEvent(keyEvent(), 0)).toBeNull();
		expect(
			nvaGestureActionIndexFromKeyboardEvent(
				keyEvent({ code: "Digit3", key: "3" }),
				2,
			),
		).toBeNull();
		expect(
			nvaGestureActionIndexFromKeyboardEvent(
				keyEvent({ code: "Numpad1", key: "1" }),
				9,
			),
		).toBeNull();
		expect(
			nvaGestureActionIndexFromKeyboardEvent(
				keyEvent({ code: "Digit0", key: "0" }),
				9,
			),
		).toBeNull();
	});

	it("allows CodeMirror targets and formats platform-specific labels", () => {
		// CodeMirror has no default Alt+digit binding in Editor.tsx's keymaps.
		expect(nvaGestureActionIndexFromKeyboardEvent(keyEvent(), 1)).toBe(0);
		expect(nvaGestureShortcutLabel(0, "MacIntel")).toBe("⌥1");
		expect(nvaGestureShortcutLabel(1, "Linux x86_64")).toBe("Alt+2");
		expect(nvaGestureShortcutLabel(9, "MacIntel")).toBeNull();
	});

	it("recognizes a focused xterm surface", () => {
		const terminal = document.createElement("div");
		terminal.className = "xterm";
		const textarea = document.createElement("textarea");
		terminal.append(textarea);
		expect(isNvaGestureTerminalTarget(textarea)).toBe(true);
		expect(isNvaGestureTerminalTarget(document.createElement("textarea"))).toBe(
			false,
		);
	});
});
