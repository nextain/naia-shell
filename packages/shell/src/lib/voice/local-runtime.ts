import { loadConfig } from "../config";
import { Logger } from "../logger";
import { voiceHostProfile } from "./host-profile";

/**
 * 설치·상태 확인·시작 한 흐름이 쓸 구체적인 카드 번호를 흐름 시작에 한 번 얻는다.
 * `configured` 는 사람이 고른 값(자동 = null)이고 설정에는 그대로 둔다. 백엔드가
 * 명시·기록·여유 순으로 해석하고(없는 번호는 버림) 결과를 기록한다. 해석에 실패하면
 * 설정값을 그대로 쓴다.
 */
export async function resolveLocalVoiceGpu(
	configured: number | null,
): Promise<number | null> {
	try {
		const { invoke } = await import("@tauri-apps/api/core");
		const resolved = await invoke<unknown>("resolve_voxcpm2_gpu", {
			gpuIndex: configured,
		});
		if (typeof resolved === "number" || resolved === null) return resolved;
	} catch (error) {
		Logger.warn("LocalRuntime", "resolveLocalVoiceGpu:failed", {
			error: String(error),
		});
	}
	return configured;
}

export interface LocalVoiceHealth {
	ttsReady: boolean;
	avatarReady: boolean;
	mode?: string;
}

let localVoiceAccessToken: string | null = null;

export function localVoiceAuthHeaders(): Record<string, string> {
	return localVoiceAccessToken
		? { Authorization: `Bearer ${localVoiceAccessToken}` }
		: {};
}

export function clearLocalVoiceAccessToken(): void {
	localVoiceAccessToken = null;
}

/** True only for this app's authenticated loopback Naia Host endpoint. */
export function isOwnLocalVoiceUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			url.protocol === "http:" &&
			url.port === "8910" &&
			["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
		);
	} catch {
		return false;
	}
}

/**
 * Recover the per-launch loopback bearer from the app's own running engine.
 *
 * The webview can lose (or never receive) the token while the engine keeps
 * running — e.g. the engine was auto-started and the user never passed through
 * the Settings start flow, or the webview reloaded (HMR, navigation) wiping
 * sessionStorage. Every authenticated call then 401s: empty preset palette,
 * dead preview/upload, and SILENT synthesis. `start_voxcpm2` is idempotent for
 * the app's own engine — it returns the cached ready payload (token included)
 * without respawning — so the synthesis path can self-heal instead of failing.
 * Returns true when a token is (now) available.
 */
let recoverInFlight: Promise<boolean> | null = null;

export async function recoverLocalVoiceToken(
	options: { force?: boolean } = {},
): Promise<boolean> {
	// force=true: the caller just got a 401 WITH this token — it is stale, so
	// "a header exists" is not success. Clear it and re-fetch from the engine.
	// (Without this the 401 retry re-sent the same dead token forever —
	// adversarial review finding.)
	if (options.force) clearLocalVoiceAccessToken();
	if (localVoiceAuthHeaders().Authorization) return true;
	// Tauri-only path (invoke); under vitest/node just report "no token".
	if (typeof window === "undefined") return false;
	// Single-flight: concurrent sentences must not each invoke start_voxcpm2
	// (idempotent, but N parallel IPC round-trips are wasteful spawn pressure).
	if (!recoverInFlight) {
		recoverInFlight = (async () => {
			try {
				const { invoke } = await import("@tauri-apps/api/core");
				// 프로파일 이름은 기계가 정한다 (#537). 여기서 박아 두면 다른
				// 운영체제에서 그대로 어긋난다.
				const host = await voiceHostProfile();
				const ready = await invoke<string>("start_voxcpm2", {
					expectedLoaderProfile: host.profile,
					// 사람이 고른 카드가 있으면 그것으로. 없으면 런타임이 여유가
					// 가장 많은 카드를 고른다 (#537). 구체 번호를 먼저 정해 넘긴다.
					gpuIndex: await resolveLocalVoiceGpu(
						loadConfig()?.localVoiceGpuIndex ?? null,
					),
				});
				const url = localVoiceFacadeUrlFromReady(ready);
				Logger.debug("LocalRuntime", "recoverLocalVoiceToken:result", {
					recovered: !!url,
				});
				return !!localVoiceAuthHeaders().Authorization;
			} catch (error) {
				Logger.warn("LocalRuntime", "recoverLocalVoiceToken:failed", {
					error: String(error),
				});
				return false;
			} finally {
				recoverInFlight = null;
			}
		})();
	}
	return recoverInFlight;
}

/**
 * Authenticated request helper for every non-synthesis Naia Host endpoint.
 * The per-launch bearer stays in process memory, is never persisted, and a
 * stale-token 401 is refreshed and retried exactly once.
 */
export async function fetchLocalVoiceAuthenticated(
	baseUrl: string,
	path: string,
	init: RequestInit = {},
): Promise<Response> {
	const base = baseUrl.trim().replace(/\/+$/, "");
	if (!isOwnLocalVoiceUrl(base)) return fetch(`${base}${path}`, init);
	if (!localVoiceAuthHeaders().Authorization) await recoverLocalVoiceToken();
	const request = () => {
		const headers = new Headers(init.headers);
		for (const [key, value] of Object.entries(localVoiceAuthHeaders()))
			headers.set(key, value);
		return fetch(`${base}${path}`, { ...init, headers });
	};
	let response = await request();
	if (
		response.status === 401 &&
		(await recoverLocalVoiceToken({ force: true }))
	)
		response = await request();
	return response;
}

/**
 * FR-VOICE.14 (#418): the single readiness verdict for the local voice façade.
 * A listening port or a stored URL is NOT readiness — only the façade /health
 * body reporting the TTS service enabled counts. Returns null when the façade
 * is unreachable (engine not running) or the body is not the health contract,
 * so callers can distinguish "engine off" from "engine up, TTS unavailable".
 */
export async function fetchLocalVoiceHealth(
	baseUrl: string,
	init?: { signal?: AbortSignal },
): Promise<LocalVoiceHealth | null> {
	try {
		const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/health`, {
			signal: init?.signal,
		});
		if (!res.ok) return null;
		const body = (await res.json()) as {
			tts_enabled?: unknown;
			avatar_enabled?: unknown;
			mode?: unknown;
			service?: unknown;
			capabilities?: unknown;
			ready?: unknown;
		};
		if (
			body.service === "voxcpm2-tensorrt" &&
			body.ready === true &&
			Array.isArray(body.capabilities) &&
			body.capabilities.includes("tts")
		)
			return { ttsReady: true, avatarReady: false, mode: "tts_only" };
		if (typeof body?.tts_enabled !== "boolean") return null;
		return {
			ttsReady: body.tts_enabled === true,
			avatarReady: body.avatar_enabled === true,
			mode: typeof body.mode === "string" ? body.mode : undefined,
		};
	} catch {
		return null;
	}
}

export function localVoiceFacadeUrlFromReady(ready: string): string | null {
	try {
		const payload = JSON.parse(ready) as {
			service?: unknown;
			capabilities?: unknown;
			port?: unknown;
			facade_port?: number;
			services?: Array<{ kind?: string }>;
			local_access_token?: unknown;
		};
		if (
			payload.service === "voxcpm2-tensorrt" &&
			Array.isArray(payload.capabilities) &&
			payload.capabilities.includes("tts") &&
			payload.port === 8910
		) {
			if (
				typeof payload.local_access_token !== "string" ||
				!/^[a-f0-9]{64}$/.test(payload.local_access_token)
			)
				return null;
			localVoiceAccessToken = payload.local_access_token;
			Logger.debug("LocalRuntime", "facadeFromReady:token-captured", {
				port: payload.port,
				branch: "direct-voxcpm2",
			});
			return `http://127.0.0.1:${payload.port}`;
		}
		const port = payload.facade_port;
		if (typeof port !== "number" || !Number.isFinite(port)) {
			Logger.debug("LocalRuntime", "facadeFromReady:no-facade", {
				service: payload.service,
				hasToken: typeof payload.local_access_token === "string",
			});
			return null;
		}
		const hasVoice =
			Array.isArray(payload.services) &&
			payload.services.some((service) => service?.kind === "tts");
		// A facade_port payload (adopted/legacy) carries NO per-launch token — the
		// webview will be unauthenticated. Surface it so an empty palette / 401 is
		// diagnosable from the log rather than guessed at.
		Logger.debug("LocalRuntime", "facadeFromReady:facade-port-no-token", {
			port,
			hasVoice,
		});
		return hasVoice ? `http://127.0.0.1:${port}` : null;
	} catch (error) {
		Logger.warn("LocalRuntime", "facadeFromReady:parse-failed", {
			error: String(error),
		});
		return null;
	}
}
