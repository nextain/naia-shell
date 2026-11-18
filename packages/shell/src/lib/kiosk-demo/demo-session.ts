import { LAB_GATEWAY_URL } from "../config";
import { primeLabCredits } from "../lab-balance";
import { Logger } from "../logger";
import { isKioskDemo } from "./flag";

export const KIOSK_DEMO_SESSION_STORAGE_KEY = "naia-kiosk-demo-session";
export const KIOSK_DEMO_REFRESH_LEAD_MS = 2 * 60 * 1000;

const REMOTE_KEY_STORAGE_KEY = "naia-remote-key";
const REMOTE_USER_ID_STORAGE_KEY = "naia-remote-user-id";
const DEFAULT_TTL_SECONDS = 30 * 60;

export type KioskDemoSessionFailureReason =
	| "missing-key"
	| "unavailable"
	| "lookup-failed";

export type KioskDemoSessionResult =
	| {
			ok: true;
			token: string;
			expiresAtMs: number;
			credits: number | null;
			refreshed: boolean;
	  }
	| {
			ok: false;
			reason: KioskDemoSessionFailureReason;
	  };

export interface KioskDemoSessionOptions {
	gatewayUrl?: string;
	forceRefresh?: boolean;
	fetchSession?: typeof fetch;
	now?: number;
}

interface StoredDemoSession {
	token: string;
	expiresAtMs: number;
}

let inFlightDefaultSession: Promise<KioskDemoSessionResult> | null = null;

function isValidDemoToken(token: string): boolean {
	return (
		typeof token === "string" &&
		token.length >= 10 &&
		token.length <= 256 &&
		/^[a-zA-Z0-9._-]+$/.test(token)
	);
}

function clearRemoteAuthStorage(): void {
	try {
		if (typeof localStorage !== "undefined") {
			localStorage.removeItem(REMOTE_KEY_STORAGE_KEY);
			localStorage.removeItem(REMOTE_USER_ID_STORAGE_KEY);
		}
	} catch {
		// ignore storage errors
	}
}

function writeRemoteDemoToken(token: string): void {
	try {
		if (typeof localStorage !== "undefined") {
			localStorage.setItem(REMOTE_KEY_STORAGE_KEY, token);
			localStorage.removeItem(REMOTE_USER_ID_STORAGE_KEY);
		}
	} catch {
		// ignore storage errors
	}
}

export function clearKioskDemoSessionStorage(): void {
	try {
		if (typeof sessionStorage !== "undefined") {
			sessionStorage.removeItem(KIOSK_DEMO_SESSION_STORAGE_KEY);
		}
	} catch {
		// ignore storage errors
	}
}

export function readActiveKioskDemoSession(
	now: number = Date.now(),
): StoredDemoSession | null {
	try {
		if (typeof sessionStorage === "undefined") return null;
		const raw = sessionStorage.getItem(KIOSK_DEMO_SESSION_STORAGE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as Partial<StoredDemoSession>;
		const token = typeof parsed?.token === "string" ? parsed.token.trim() : "";
		const expiresAtMs = Number(parsed?.expiresAtMs);
		if (
			!isValidDemoToken(token) ||
			!Number.isFinite(expiresAtMs) ||
			expiresAtMs - now <= KIOSK_DEMO_REFRESH_LEAD_MS
		) {
			return null;
		}
		return { token, expiresAtMs };
	} catch {
		return null;
	}
}

function writeStoredDemoSession(session: StoredDemoSession): void {
	try {
		if (typeof sessionStorage !== "undefined") {
			sessionStorage.setItem(
				KIOSK_DEMO_SESSION_STORAGE_KEY,
				JSON.stringify(session),
			);
		}
	} catch {
		// ignore storage errors
	}
}

function extractErrorCode(payload: unknown): string {
	if (!payload || typeof payload !== "object") return "";
	const record = payload as Record<string, unknown>;
	if (typeof record.error_code === "string") return record.error_code;
	if (typeof record.detail === "string") return record.detail;
	if (record.detail && typeof record.detail === "object") {
		const detail = record.detail as Record<string, unknown>;
		if (typeof detail.error_code === "string") return detail.error_code;
	}
	return "";
}

export async function requestKioskDemoSession(
	gatewayUrl: string,
	fetchImpl: typeof fetch = fetch,
	now: number = Date.now(),
): Promise<
	| Omit<Extract<KioskDemoSessionResult, { ok: true }>, "refreshed">
	| Extract<KioskDemoSessionResult, { ok: false }>
> {
	try {
		const response = await fetchImpl(
			`${gatewayUrl.replace(/\/+$/, "")}/v1/demo/session`,
			{ method: "POST" },
		);
		if (response.status === 503 || response.status === 401) {
			return { ok: false, reason: "missing-key" };
		}
		if (response.status === 402 || response.status === 429) {
			return { ok: false, reason: "unavailable" };
		}
		if (response.status === 403) {
			const errBody = await response.json().catch(() => null);
			const code = extractErrorCode(errBody);
			if (code === "origin_forbidden") {
				return { ok: false, reason: "missing-key" };
			}
			return { ok: false, reason: "unavailable" };
		}
		if (!response.ok) {
			return { ok: false, reason: "lookup-failed" };
		}

		const body = (await response.json()) as Record<string, unknown>;
		const token = typeof body?.token === "string" ? body.token.trim() : "";
		if (!isValidDemoToken(token)) {
			return { ok: false, reason: "lookup-failed" };
		}

		const credits =
			typeof body.credits === "number" && Number.isFinite(body.credits)
				? body.credits
				: null;
		const remainingTurns =
			typeof body.remaining_chat_turns === "number" &&
			Number.isFinite(body.remaining_chat_turns)
				? body.remaining_chat_turns
				: null;
		if (
			(credits !== null && credits <= 0) ||
			(remainingTurns !== null && remainingTurns <= 0)
		) {
			return { ok: false, reason: "unavailable" };
		}

		const parsedExp =
			typeof body.expires_at === "string"
				? Date.parse(body.expires_at)
				: Number.NaN;
		const ttlSec =
			typeof body.ttl_seconds === "number" &&
			Number.isFinite(body.ttl_seconds) &&
			body.ttl_seconds > 0
				? body.ttl_seconds
				: DEFAULT_TTL_SECONDS;
		const expiresAtMs =
			Number.isFinite(parsedExp) && parsedExp > now
				? parsedExp
				: now + ttlSec * 1000;

		return {
			ok: true,
			token,
			expiresAtMs,
			credits,
		};
	} catch {
		Logger.debug("KioskDemo", "demo session request failed");
		return { ok: false, reason: "lookup-failed" };
	}
}

async function acquireAndStoreDemoSession(
	gatewayUrl: string,
	fetchImpl: typeof fetch,
	now?: number,
): Promise<KioskDemoSessionResult> {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const res = await requestKioskDemoSession(
			gatewayUrl,
			fetchImpl,
			now ?? Date.now(),
		);
		if (res.ok) {
			writeStoredDemoSession({
				token: res.token,
				expiresAtMs: res.expiresAtMs,
			});
			writeRemoteDemoToken(res.token);
			if (res.credits !== null) {
				primeLabCredits(res.credits);
			}
			return { ...res, refreshed: true };
		}
		if (res.reason !== "lookup-failed") {
			return res;
		}
	}
	return { ok: false, reason: "lookup-failed" };
}

/**
 * Ensures an active short-lived gateway demo token is present in browser auth
 * storage without reading any build-embedded secret. Wipes any stale personal
 * `naia-remote-key` before minting a session so personal credentials are never
 * reused in kiosk demo mode.
 */
export async function ensureKioskDemoSession(
	opts?: KioskDemoSessionOptions,
): Promise<KioskDemoSessionResult> {
	if (!isKioskDemo()) {
		return { ok: false, reason: "missing-key" };
	}

	const now = opts?.now ?? Date.now();
	if (!opts?.forceRefresh) {
		const active = readActiveKioskDemoSession(now);
		if (active) {
			writeRemoteDemoToken(active.token);
			return {
				ok: true,
				token: active.token,
				expiresAtMs: active.expiresAtMs,
				credits: null,
				refreshed: false,
			};
		}
	} else {
		clearKioskDemoSessionStorage();
	}

	// Never fall back to a pre-existing personal login key in localStorage.
	clearRemoteAuthStorage();

	const gatewayUrl = (opts?.gatewayUrl || LAB_GATEWAY_URL).trim();
	const useSharedFlight =
		!opts?.forceRefresh &&
		!opts?.fetchSession &&
		opts?.now === undefined &&
		gatewayUrl === LAB_GATEWAY_URL.trim();

	if (useSharedFlight) {
		if (!inFlightDefaultSession) {
			inFlightDefaultSession = acquireAndStoreDemoSession(
				gatewayUrl,
				fetch,
			).finally(() => {
				inFlightDefaultSession = null;
			});
		}
		return inFlightDefaultSession;
	}

	return acquireAndStoreDemoSession(
		gatewayUrl,
		opts?.fetchSession ?? fetch,
		opts?.now,
	);
}
