export type ShortcutPlatform = "macos" | "other";

const MAC_PLATFORM_RE =
	/\b(mac|macintosh|macintel|macppc|mac68k|darwin)\b|^mac/i;
const MAC_UA_RE = /(Macintosh|Mac OS X|Darwin)/i;
const IOS_UA_RE = /(iPhone|iPad|iPod)/i;

/**
 * Detects macOS (`Darwin`) from `navigator.platform` and/or `navigator.userAgent`.
 * When `platform` is explicitly provided (e.g. unit tests passing `"Win32"` or `"MacIntel"`),
 * avoids reading global `navigator.userAgent` unless `userAgent` is also passed.
 */
export function shortcutPlatform(
	platform?: string,
	userAgent?: string,
): ShortcutPlatform {
	if (platform !== undefined) {
		if (MAC_PLATFORM_RE.test(platform)) return "macos";
		if (
			userAgent !== undefined &&
			MAC_UA_RE.test(userAgent) &&
			!IOS_UA_RE.test(userAgent)
		) {
			return "macos";
		}
		return "other";
	}
	const navPlatform =
		typeof navigator === "undefined" ? "" : (navigator.platform ?? "");
	if (MAC_PLATFORM_RE.test(navPlatform)) return "macos";
	const navUa =
		userAgent ??
		(typeof navigator === "undefined" ? "" : (navigator.userAgent ?? ""));
	if (MAC_UA_RE.test(navUa) && !IOS_UA_RE.test(navUa)) {
		return "macos";
	}
	return "other";
}

export function primaryModifierLabel(
	platform: ShortcutPlatform = shortcutPlatform(),
): string {
	return platform === "macos" ? "Command" : "Ctrl";
}

export function primaryModifierSymbol(
	platform: ShortcutPlatform = shortcutPlatform(),
): string {
	return platform === "macos" ? "⌘" : "Ctrl+";
}

export function formatPrimaryShortcut(
	key: string,
	platform: ShortcutPlatform = shortcutPlatform(),
): string {
	const trimmed = key.trim();
	return `${primaryModifierSymbol(platform)}${trimmed}`;
}

/**
 * Converts `Ctrl+...` shortcut annotations inside localized tooltip labels to
 * Apple symbol notation (`⌘`, `⌥`, `⇧`) on macOS while keeping non-macOS strings
 * byte-for-byte unchanged.
 */
export function formatShortcutTextForPlatform(
	label: string,
	platform: ShortcutPlatform = shortcutPlatform(),
): string {
	if (platform !== "macos") return label;
	return label
		.replace(/\bCtrl\+Alt\+Shift\+([A-Za-z0-9])/g, "⌘⌥⇧$1")
		.replace(/\bCtrl\+Shift\+Alt\+([A-Za-z0-9])/g, "⌘⌥⇧$1")
		.replace(/\bCtrl\+Alt\+([A-Za-z0-9])/g, "⌘⌥$1")
		.replace(/\bCtrl\+Shift\+([A-Za-z0-9])/g, "⌘⇧$1")
		.replace(/\bCtrl\+([A-Za-z0-9])/g, "⌘$1");
}

export function hasPrimaryModifier(
	event: Pick<MouseEvent, "ctrlKey" | "metaKey">,
	platform: ShortcutPlatform = shortcutPlatform(),
): boolean {
	return platform === "macos"
		? event.metaKey && !event.ctrlKey
		: event.ctrlKey && !event.metaKey;
}
