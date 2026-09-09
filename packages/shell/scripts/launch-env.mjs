/**
 * Return an environment suitable for an interactive Shell launch.
 *
 * Native E2E runs own isolated workspaces and app profiles. Their variables
 * must never leak into `tauri:dev` / `tauri:prod`, where they would make the
 * Agent prefer a disposable test workspace over the user's persisted ADK.
 * Production also owns the gateway selection: the wrapper loads `.env.prod`
 * after this first scrub, so the final positional `"prod"` call prevents a
 * developer `.env.local` from opting a production launch/build back into dev.
 */
export function interactiveLaunchEnv(source = process.env, mode = "dev") {
	const env = { ...source };
	for (const key of Object.keys(env)) {
		if (
			key === "CAFE_DEBUG_E2E" ||
			key === "TAURI_WEBDRIVER_PORT" ||
			key === "WEBVIEW2_USER_DATA_FOLDER" ||
			key.startsWith("NAIA_E2E_") ||
			key.startsWith("VITE_NAIA_E2E_")
		) {
			delete env[key];
		}
	}
	if (mode === "prod") {
		env.VITE_NAIA_USE_DEV_GATEWAY = "0";
		// Keep an explicit empty value so Vite's `.env.local` fallback cannot
		// repopulate the URL after it reads the child process environment.
		env.VITE_NAIA_DEV_GATEWAY_URL = "";
	}
	return env;
}
