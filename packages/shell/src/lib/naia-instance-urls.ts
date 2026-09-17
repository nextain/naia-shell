// Canonical Naia land/API hosts for the desktop client.
// `tauri:dev` → dev.naia.land + api-dev.naia.land
// `tauri:prod` → www.naia.land + api.nextain.io
// Chat completions, credit fetch, and the spawned Agent must share `api`.

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

export function nonemptyEnv(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

export function naiaLaunchMode(input: {
	useDevGateway?: string;
	webBaseUrl?: string;
}): NaiaLaunchMode {
	if (input.useDevGateway === "1") return "dev";
	if (input.webBaseUrl === NAIA_INSTANCE_URLS.dev.web) return "dev";
	return "prod";
}

export function resolveLabGatewayUrl(input: {
	useDevGateway?: string;
	webBaseUrl?: string;
	devGatewayUrl?: string;
	prodGatewayUrl?: string;
}): string {
	const mode = naiaLaunchMode(input);
	const urls = resolveNaiaInstance(mode);
	if (mode === "dev") {
		return nonemptyEnv(input.devGatewayUrl) ?? urls.api;
	}
	return nonemptyEnv(input.prodGatewayUrl) ?? urls.api;
}

/** Align Vite, Agent, and native credit-fetch hosts to one instance. */
export function applyNaiaInstanceEnv(
	env: Record<string, string | undefined>,
	mode: NaiaLaunchMode,
): Record<string, string | undefined> {
	const urls = resolveNaiaInstance(mode);
	const next: Record<string, string | undefined> = { ...env };
	next.VITE_NAIA_WEB_BASE_URL =
		nonemptyEnv(next.VITE_NAIA_WEB_BASE_URL) ?? urls.web;
	if (mode === "prod") {
		next.VITE_NAIA_USE_DEV_GATEWAY = "0";
		next.VITE_NAIA_DEV_GATEWAY_URL = "";
		next.VITE_NAIA_GATEWAY_URL =
			nonemptyEnv(next.VITE_NAIA_GATEWAY_URL) ?? urls.api;
	} else {
		next.VITE_NAIA_USE_DEV_GATEWAY = "1";
		next.VITE_NAIA_DEV_GATEWAY_URL =
			nonemptyEnv(next.VITE_NAIA_DEV_GATEWAY_URL) ?? urls.api;
	}
	const api =
		mode === "dev"
			? (nonemptyEnv(next.VITE_NAIA_DEV_GATEWAY_URL) ?? urls.api)
			: (nonemptyEnv(next.VITE_NAIA_GATEWAY_URL) ?? urls.api);
	next.NAIA_ANYLLM_BASE_URL = api;
	next.NAIA_GATEWAY_URL = api;
	return next;
}
