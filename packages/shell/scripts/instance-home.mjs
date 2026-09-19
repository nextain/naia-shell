/**
 * Instance data homes used by tauri:dev (NAIA_HOME) and the packaged app.
 *
 * FR-SHELL-ISO.1: production is ~/.naia, isolated dev is ~/.naia-dev.
 * Opener scopes must allow logs under both — tauri:dev Open Log uses
 * ~/.naia-dev/logs, not ~/.naia/logs (#646).
 */
import { homedir } from "node:os";
import { resolve } from "node:path";

export const PRODUCTION_INSTANCE_HOME_NAME = ".naia";
export const DEVELOPMENT_INSTANCE_HOME_NAME = ".naia-dev";

export function productionInstanceHome(home = homedir()) {
	return resolve(home, PRODUCTION_INSTANCE_HOME_NAME);
}

export function developmentInstanceHome(home = homedir()) {
	return resolve(home, DEVELOPMENT_INSTANCE_HOME_NAME);
}

export function instanceHomeDirNames() {
	return [PRODUCTION_INSTANCE_HOME_NAME, DEVELOPMENT_INSTANCE_HOME_NAME];
}

/** Tauri opener allow entries: the log directory itself and its contents. */
export function openerLogAllowPaths() {
	return instanceHomeDirNames().flatMap((name) => [
		{ path: `$HOME/${name}/logs` },
		{ path: `$HOME/${name}/logs/**` },
	]);
}
