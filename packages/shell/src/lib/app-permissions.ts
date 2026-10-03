/**
 * Naia App Permissions (PC 4.2 draft).
 * Aligned with Rust KNOWN_PERMISSIONS in packages/shell/src-tauri/src/app.rs.
 */
export const KNOWN_PERMISSIONS = [
	"fullscreen",
	"downloads",
	"modals",
	"speech",
	"environment",
	"files.pick",
	"media.record",
	"character.read",
	"character.write",
	"browser",
	"browser.upload",
	"login-handoff",
	"shell.command",
] as const;

export type AppPermission = (typeof KNOWN_PERMISSIONS)[number];

export function isKnownPermission(permission: string): permission is AppPermission {
	return (KNOWN_PERMISSIONS as readonly string[]).includes(permission);
}
