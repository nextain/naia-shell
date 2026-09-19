/**
 * ADK path reset + restart (#642).
 *
 * `plugin-process` relaunch() exits the current window. In `tauri:dev` the
 * parent is cargo/vite, which does not come back. Packaged builds can
 * relaunch for real.
 */

export type AdkPathResetDeps = {
	dev: boolean;
	prepareAppRelaunch: () => Promise<void>;
	cancelAppRelaunch: () => Promise<void>;
	resetAdkPathBinding: () => Promise<void>;
	relaunch: () => Promise<void>;
};

export type AdkPathResetResult =
	| { outcome: "relaunched" }
	| { outcome: "restart-required" };

export function nativeRelaunchRestartsApp(dev: boolean): boolean {
	return !dev;
}

export async function resetAdkPathWithRelaunch(
	deps: AdkPathResetDeps,
): Promise<AdkPathResetResult> {
	if (!nativeRelaunchRestartsApp(deps.dev)) {
		await deps.resetAdkPathBinding();
		return { outcome: "restart-required" };
	}

	await deps.prepareAppRelaunch();
	try {
		await deps.resetAdkPathBinding();
		await deps.relaunch();
		return { outcome: "relaunched" };
	} catch (error) {
		await deps.cancelAppRelaunch().catch(() => {});
		throw error;
	}
}
