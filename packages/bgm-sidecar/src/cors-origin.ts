const STATIC_ALLOWED_ORIGINS = new Set([
	"tauri://localhost",
	"http://tauri.localhost",
	"https://tauri.localhost",
	"http://localhost:1420",
	// The isolated native Shell runs Vite on this loopback origin. Keep it
	// explicit: this is not a wildcard CORS relaxation for the sidecar.
	"http://127.0.0.1:1422",
]);

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function debugE2eEnabled(): boolean {
	return (
		["1", "true", "TRUE"].includes(process.env.CAFE_DEBUG_E2E ?? "") &&
		process.env.NAIA_E2E_MODE === "1"
	);
}

/**
 * Resolve the one dev origin that the shell gave to this E2E run.
 *
 * The Tauri binary validates NAIA_E2E_DEV_URL before using it as its dev URL.
 * The sidecar inherits the same environment, so it can allow that exact
 * loopback origin without opening CORS to arbitrary local or remote ports.
 */
export function explicitE2eOrigin(): string | undefined {
	if (!debugE2eEnabled()) return undefined;
	const raw = process.env.NAIA_E2E_DEV_URL?.trim();
	if (!raw) return undefined;

	try {
		const parsed = new URL(raw);
		if (
			parsed.protocol !== "http:" ||
			parsed.username ||
			parsed.password ||
			!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())
		) {
			return undefined;
		}
		return parsed.origin;
	} catch {
		return undefined;
	}
}

export function isAllowedOrigin(origin: string): boolean {
	return STATIC_ALLOWED_ORIGINS.has(origin) || explicitE2eOrigin() === origin;
}

export function allowOriginFor(origin: string): string {
	return isAllowedOrigin(origin) ? origin : "tauri://localhost";
}
