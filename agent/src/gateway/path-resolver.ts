import { homedir } from "node:os";
import { join } from "node:path";
import type { PathResolver } from "./types.js";

/**
 * Resolve the naia-settings base directory.
 *
 * When the shell writes ~/.naia/adk-path (via write_naia_path_cache) the
 * Rust spawn_agent_core reads it and passes NAIA_SETTINGS_DIR as an env var
 * before the agent process starts. This is the authoritative source.
 *
 * Fallback: ~/.naia/ (legacy, first-run, or standalone invocation).
 */
function resolveSettingsBase(): string | null {
	const fromEnv = process.env.NAIA_SETTINGS_DIR;
	if (fromEnv && fromEnv.trim()) return fromEnv.trim();
	return null;
}

/**
 * Default resolver.
 *
 * When NAIA_SETTINGS_DIR is set:
 *   sessions  → {NAIA_SETTINGS_DIR}/.sessions/
 *   memory db → {NAIA_SETTINGS_DIR}/.memory/alpha-memory-v5.db
 *   identity  → {NAIA_SETTINGS_DIR}/.identity/device.json
 *
 * Fallback (no env var):
 *   sessions  → ~/.naia/sessions/
 *   memory db → ~/.naia/memory/alpha-memory-v5.db
 *   identity  → ~/.naia/identity/device.json
 */
export class DefaultPathResolver implements PathResolver {
	private readonly settingsBase: string | null;

	constructor() {
		this.settingsBase = resolveSettingsBase();
	}

	deviceIdentityPath(): string {
		if (this.settingsBase) {
			return join(this.settingsBase, ".identity", "device.json");
		}
		return join(homedir(), ".naia", "identity", "device.json");
	}

	configCandidates(): string[] {
		return [join(homedir(), ".naia", "gateway.json")];
	}

	/** Memory-specific config path (always ~/.naia/ — written by Rust backend). */
	memoryConfigPath(): string {
		return join(homedir(), ".naia", "memory-config.json");
	}

	memoryDbPath(): string {
		if (this.settingsBase) {
			return join(this.settingsBase, ".memory", "alpha-memory-v5.db");
		}
		return join(homedir(), ".naia", "memory", "alpha-memory-v5.db");
	}

	sessionsPath(): string {
		if (this.settingsBase) {
			return join(this.settingsBase, ".sessions");
		}
		return join(homedir(), ".naia", "sessions");
	}

	identityDirPath(): string {
		if (this.settingsBase) {
			return join(this.settingsBase, ".identity");
		}
		return join(homedir(), ".naia", "identity");
	}

	embeddingModelsPath(): string {
		if (this.settingsBase) {
			return join(this.settingsBase, ".models");
		}
		return join(homedir(), ".naia", "models");
	}
}

/** Singleton for the default resolver. Consumers import this. */
export const defaultPathResolver: PathResolver = new DefaultPathResolver();
