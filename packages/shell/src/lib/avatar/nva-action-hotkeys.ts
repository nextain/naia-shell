import { shortcutPlatform } from "../platform-shortcuts";

export type NvaGestureShortcutEvent = Pick<
	KeyboardEvent,
	| "altKey"
	| "ctrlKey"
	| "metaKey"
	| "shiftKey"
	| "repeat"
	| "isComposing"
	| "keyCode"
	| "code"
	| "key"
>;

/**
 * Return the zero-based active gesture index for an Alt+1..Alt+9 keydown.
 * `code` is intentional: macOS Option+1 produces a symbol in `key` (for
 * example `¡`) while the physical number row key remains `Digit1`.
 * Numpad digits are excluded. Pass terminal focus explicitly so this stays a
 * deterministic, unit-testable decision.
 */
export function nvaGestureActionIndexFromKeyboardEvent(
	event: NvaGestureShortcutEvent,
	actionCount: number,
	terminalFocused = false,
): number | null {
	if (
		terminalFocused ||
		!event.altKey ||
		event.ctrlKey ||
		event.metaKey ||
		event.shiftKey ||
		event.repeat ||
		event.isComposing ||
		event.keyCode === 229 ||
		!Number.isInteger(actionCount) ||
		actionCount < 1
	) {
		return null;
	}

	const match = /^Digit([1-9])$/.exec(event.code);
	if (!match) return null;
	const index = Number(match[1]) - 1;
	return index < Math.min(actionCount, 9) ? index : null;
}

/** Shortcut label for a zero-based gesture index; later actions have no key. */
export function nvaGestureShortcutLabel(
	actionIndex: number,
	platform?: string,
): string | null {
	if (!Number.isInteger(actionIndex) || actionIndex < 0 || actionIndex > 8)
		return null;
	const number = String(actionIndex + 1);
	return shortcutPlatform(platform) === "macos"
		? `⌥${number}`
		: `Alt+${number}`;
}

/** A terminal owns Alt+number while its xterm surface has focus. */
export function isNvaGestureTerminalTarget(
	target: EventTarget | null,
): boolean {
	if (typeof Element === "undefined" || !(target instanceof Element))
		return false;
	return target.closest(".xterm") !== null;
}
