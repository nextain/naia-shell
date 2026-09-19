import { invoke } from "@tauri-apps/api/core";

const DEFAULT_BGM_SIDECAR_BASE_URL = "http://localhost:18791";

export type BgmServerStatus = {
	ready: boolean;
	port: number;
	error?: string;
};

/**
 * The production sidecar prefers 18791. Native E2E assigns an owned port
 * so a live Shell's sidecar cannot make an isolated test pass by accident.
 * Runtime may pick a free port when the preferred one is stolen (#637).
 */
export const BGM_SIDECAR_BASE_URL =
	import.meta.env.VITE_NAIA_BGM_BASE?.replace(/\/$/, "") ??
	DEFAULT_BGM_SIDECAR_BASE_URL;

let cachedBase: string | undefined;

export function bgmSidecarBaseUrl(): string {
	return cachedBase ?? BGM_SIDECAR_BASE_URL;
}

function isE2eHarness(): boolean {
	return (
		import.meta.env.VITE_NAIA_E2E_MODE === "1" ||
		(typeof window !== "undefined" && "__E2E_OUTBOUND__" in window)
	);
}

/** Ensure the Shell-owned sidecar is alive and return the URL the UI must use. */
export async function ensureBgmSidecar(): Promise<string> {
	if (isE2eHarness()) {
		const base = BGM_SIDECAR_BASE_URL;
		cachedBase = base;
		return base;
	}
	const status = await invoke<BgmServerStatus>("ensure_bgm_server");
	if (!status?.ready || !Number.isInteger(status.port) || status.port <= 0) {
		throw new Error(status?.error ?? "bgm_sidecar_not_ready");
	}
	const base = `http://127.0.0.1:${status.port}`;
	cachedBase = base;
	return base;
}

export function resetBgmSidecarBaseUrl(): void {
	cachedBase = undefined;
}
