/**
 * Launch-time copy of packages/shell/src/lib/naia-instance-urls.ts.
 * Keep the host table identical — the TS helper is what the desktop UI imports.
 */
export const NAIA_INSTANCE_URLS = {
	dev: {
		web: "https://dev.naia.land",
		api: "https://api-dev.naia.land",
	},
	prod: {
		web: "https://www.naia.land",
		api: "https://api.nextain.io",
	},
};

function nonemptyEnv(value) {
	const trimmed = typeof value === "string" ? value.trim() : "";
	return trimmed ? trimmed : undefined;
}

export function resolveNaiaInstance(mode) {
	return NAIA_INSTANCE_URLS[mode] ?? NAIA_INSTANCE_URLS.dev;
}

export function applyNaiaInstanceEnv(env, mode) {
	const urls = resolveNaiaInstance(mode);
	const next = { ...env };
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
