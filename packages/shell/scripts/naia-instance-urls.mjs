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

export function resolveNaiaInstance(mode) {
	return NAIA_INSTANCE_URLS[mode] ?? NAIA_INSTANCE_URLS.dev;
}

export function applyNaiaInstanceEnv(env, mode) {
	const urls = resolveNaiaInstance(mode);
	const next = { ...env };
	next.VITE_NAIA_WEB_BASE_URL = env.VITE_NAIA_WEB_BASE_URL ?? urls.web;
	if (mode === "prod") {
		delete next.VITE_NAIA_USE_DEV_GATEWAY;
		delete next.VITE_NAIA_DEV_GATEWAY_URL;
	} else {
		next.VITE_NAIA_USE_DEV_GATEWAY = env.VITE_NAIA_USE_DEV_GATEWAY ?? "1";
		next.VITE_NAIA_DEV_GATEWAY_URL = env.VITE_NAIA_DEV_GATEWAY_URL ?? urls.api;
	}
	return next;
}
