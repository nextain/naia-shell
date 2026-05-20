/**
 * One-shot migration: copy existing ~/.naia/ user-data into naia-settings/
 * when NAIA_SETTINGS_DIR is set for the first time.
 *
 * Migrates:
 *   ~/.naia/sessions/    → {NAIA_SETTINGS_DIR}/.sessions/
 *   ~/.naia/memory/      → {NAIA_SETTINGS_DIR}/.memory/
 *   ~/.naia/identity/    → {NAIA_SETTINGS_DIR}/.identity/
 *
 * Source files are NOT deleted — migration is additive only.
 * Skips destination files that already exist (idempotent).
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function migrateDir(src: string, dst: string): void {
	if (!existsSync(src)) return;
	mkdirSync(dst, { recursive: true });
	let entries: string[];
	try {
		entries = readdirSync(src);
	} catch {
		return;
	}
	for (const name of entries) {
		const srcFile = join(src, name);
		const dstFile = join(dst, name);
		if (existsSync(dstFile)) continue; // already migrated
		try {
			copyFileSync(srcFile, dstFile);
		} catch {
			// Non-fatal: migration is best-effort
		}
	}
}

/**
 * Run migration if NAIA_SETTINGS_DIR is configured.
 * Safe to call multiple times — idempotent.
 */
export function runUserDataMigration(settingsDir: string): void {
	const home = homedir();
	const legacyBase = join(home, ".naia");

	migrateDir(join(legacyBase, "sessions"), join(settingsDir, ".sessions"));
	migrateDir(join(legacyBase, "memory"), join(settingsDir, ".memory"));
	migrateDir(join(legacyBase, "identity"), join(settingsDir, ".identity"));
}
