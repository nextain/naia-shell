const DEFAULT_BGM_SIDECAR_BASE_URL = "http://localhost:18791";

/**
 * The production sidecar always uses 18791. Native E2E assigns an owned port
 * so a live Shell's sidecar cannot make an isolated test pass by accident.
 */
export const BGM_SIDECAR_BASE_URL =
	import.meta.env.VITE_NAIA_BGM_BASE?.replace(/\/$/, "") ??
	DEFAULT_BGM_SIDECAR_BASE_URL;
