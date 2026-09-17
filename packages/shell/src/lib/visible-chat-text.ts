/**
 * User-visible chat must not dump tool JSON (BGM receipts, empty knowledge `{}`).
 * Tool results stay on the tool-result channel for the model.
 */

const TOOL_DUMP_KEYS = [
	"ok",
	"action",
	"playback",
	"instruction",
	"announceTrack",
	"currentTrack",
	"hits",
	"abstained",
	"nodes",
	"empty",
] as const;

export function isToolResultDump(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed) return false;
	if (trimmed === "{}") return true;
	if (!(trimmed.startsWith("{") && trimmed.endsWith("}"))) return false;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			return false;
		}
		const keys = Object.keys(parsed);
		if (keys.length === 0) return true;
		return TOOL_DUMP_KEYS.some((key) => keys.includes(key));
	} catch {
		return false;
	}
}

export function filterUserVisibleAssistantText(text: string): string {
	return isToolResultDump(text) ? "" : text;
}
