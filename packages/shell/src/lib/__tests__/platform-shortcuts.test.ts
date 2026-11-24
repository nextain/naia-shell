import { describe, expect, it } from "vitest";
import {
	formatPrimaryShortcut,
	formatShortcutTextForPlatform,
	hasPrimaryModifier,
	primaryModifierLabel,
	primaryModifierSymbol,
	shortcutPlatform,
} from "../platform-shortcuts";

describe("platform shortcuts", () => {
	it("derives the primary modifier label and event mapping from one platform definition", () => {
		expect(shortcutPlatform("MacIntel")).toBe("macos");
		expect(shortcutPlatform("Darwin")).toBe("macos");
		expect(
			shortcutPlatform(
				"",
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/605.1.15",
			),
		).toBe("macos");
		expect(
			shortcutPlatform(
				"",
				"Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15",
			),
		).toBe("other");
		expect(shortcutPlatform("Win32")).toBe("other");
		expect(shortcutPlatform("Linux x86_64")).toBe("other");
		expect(primaryModifierLabel("macos")).toBe("Command");
		expect(primaryModifierLabel("other")).toBe("Ctrl");
		expect(primaryModifierSymbol("macos")).toBe("⌘");
		expect(primaryModifierSymbol("other")).toBe("Ctrl+");
		expect(formatPrimaryShortcut("B", "macos")).toBe("⌘B");
		expect(formatPrimaryShortcut("B", "other")).toBe("Ctrl+B");
		expect(hasPrimaryModifier({ ctrlKey: false, metaKey: true }, "macos")).toBe(
			true,
		);
		expect(hasPrimaryModifier({ ctrlKey: true, metaKey: false }, "other")).toBe(
			true,
		);
		expect(
			hasPrimaryModifier({ ctrlKey: false, metaKey: false }, "other"),
		).toBe(false);
	});

	it("rewrites Ctrl+ tooltip shortcuts to Apple symbols on macOS without altering other platforms", () => {
		expect(
			formatShortcutTextForPlatform(
				"Turn off AI interference (Ctrl+Alt+A)",
				"macos",
			),
		).toBe("Turn off AI interference (⌘⌥A)");
		expect(
			formatShortcutTextForPlatform(
				"Turn off AI interference (Ctrl+Alt+A)",
				"other",
			),
		).toBe("Turn off AI interference (Ctrl+Alt+A)");
		expect(
			formatShortcutTextForPlatform("Reload (Ctrl+Shift+R)", "macos"),
		).toBe("Reload (⌘⇧R)");
		expect(formatShortcutTextForPlatform("Hide chat (Ctrl+B)", "macos")).toBe(
			"Hide chat (⌘B)",
		);
	});
});
