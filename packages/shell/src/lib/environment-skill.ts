/**
 * Shell-owned environment observation.
 *
 * #611 removed the model-facing environment control tool. The shell still
 * observes Herdr for explicit `always` awareness and clears stale declarations
 * left by older Agent processes.
 */

import { invoke } from "@tauri-apps/api/core";
import { EnvironmentSession } from "@nextain/naia-os-core/composition";
import { Logger } from "./logger";

export const ENVIRONMENT_APP_ID = "environment";

export const environmentSession = new EnvironmentSession();

let environmentClearPending = false;

/** Whether a failed stale-registration clear should be retried. */
export function environmentClearNeeded(): boolean {
	return environmentClearPending;
}

/** Record the result of clearing a legacy model-facing declaration. */
export function noteEnvironmentClear(ok: boolean): void {
	environmentClearPending = !ok;
}

/** Refresh the observation snapshot without exposing an execution handler. */
export async function refreshEnvironment(): Promise<
	ReturnType<EnvironmentSession["latestReport"]>
> {
	try {
		const snapshot = await invoke<unknown>("herdr_snapshot");
		return environmentSession.observeSnapshot(snapshot as never);
	} catch (error) {
		Logger.info("environment", "herdr snapshot unavailable", {
			error: String(error),
		});
		environmentSession.markUnavailable();
		return null;
	}
}
