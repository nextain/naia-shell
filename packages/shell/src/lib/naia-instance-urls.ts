// Canonical Naia land/API hosts for the desktop client.
// `tauri:dev` → dev.naia.land + api-dev.naia.land
// `tauri:prod` → www.naia.land + api.nextain.io (historical prod gateway alias)
// Components and launch env must use this helper — do not scatter host strings.

export type NaiaLaunchMode = "dev" | "prod";

export interface NaiaInstanceUrls {
	readonly web: string;
	readonly api: string;
}

export const NAIA_INSTANCE_URLS: Record<NaiaLaunchMode, NaiaInstanceUrls> = {
	dev: {
		web: "https://dev.naia.land",
		api: "https://api-dev.naia.land",
	},
	prod: {
		web: "https://www.naia.land",
		api: "https://api.nextain.io",
	},
};

export function resolveNaiaInstance(mode: NaiaLaunchMode): NaiaInstanceUrls {
	return NAIA_INSTANCE_URLS[mode];
}

export function naiaLaunchMode(input: {
	useDevGateway?: string;
	webBaseUrl?: string;
	viteDev?: boolean;
}): NaiaLaunchMode {
	if (input.useDevGateway === "1") return "dev";
	if (input.webBaseUrl === NAIA_INSTANCE_URLS.dev.web) return "dev";
	if (input.webBaseUrl === NAIA_INSTANCE_URLS.prod.web) return "prod";
	// `tauri:prod` still uses the Vite dev server, so import.meta.env.DEV is not
	// the instance. The launcher must set the web base or the dev-gateway flag.
	if (input.viteDev === true && !input.webBaseUrl) return "dev";
	return "prod";
}

export function naiaWebUrl(path: string, base: string): string {
	const root = base.replace(/\/+$/u, "");
	const suffix = path.replace(/^\/+/u, "");
	return suffix ? `${root}/${suffix}` : root;
}

export function applyNaiaInstanceEnv(
	env: Record<string, string | undefined>,
	mode: NaiaLaunchMode,
): Record<string, string | undefined> {
	const urls = resolveNaiaInstance(mode);
	const next = { ...env };
	next.VITE_NAIA_WEB_BASE_URL = env.VITE_NAIA_WEB_BASE_URL ?? urls.web;
	// Agent chat must use the same API host as credit fetch. A parent-shell
	// NAIA_ANYLLM_BASE_URL=https://api.nextain.io must not leak into tauri:dev (#638).
	next.NAIA_ANYLLM_BASE_URL = urls.api;
	next.NAIA_GATEWAY_URL = urls.api;
	if (mode === "prod") {
		delete next.VITE_NAIA_USE_DEV_GATEWAY;
		delete next.VITE_NAIA_DEV_GATEWAY_URL;
	} else {
		next.VITE_NAIA_USE_DEV_GATEWAY = env.VITE_NAIA_USE_DEV_GATEWAY ?? "1";
		next.VITE_NAIA_DEV_GATEWAY_URL = env.VITE_NAIA_DEV_GATEWAY_URL ?? urls.api;
	}
	return next;
}
