import { invoke } from "@tauri-apps/api/core";

export interface CachedLabCredits {
	value: number;
	timestamp: number;
}

let cachedLabCredits: CachedLabCredits | null = null;

export function readCachedLabCredits(
	maxAgeMs: number,
): CachedLabCredits | null {
	return cachedLabCredits && Date.now() - cachedLabCredits.timestamp < maxAgeMs
		? cachedLabCredits
		: null;
}

export function primeLabCredits(value: number): void {
	cachedLabCredits = { value, timestamp: Date.now() };
}

export function clearCachedLabCredits(): void {
	cachedLabCredits = null;
}

/**
 * Gateway balance is expressed in micro-dollars (`balance`), while the
 * naia.land account endpoint returns already-normalized `credits`. Accept both
 * response envelopes so login, dashboard, and direct gateway deployments show
 * the same value.
 */
export function parseLabCredits(payload: unknown): number | null {
	if (!payload || typeof payload !== "object") return null;

	const parse = (record: Record<string, unknown>): number | null => {
		const balance = record.balance;
		if (typeof balance === "number" && Number.isFinite(balance)) {
			return balance / 100_000;
		}
		const credits = record.credits;
		if (typeof credits === "number" && Number.isFinite(credits)) {
			return credits;
		}
		return null;
	};

	const record = payload as Record<string, unknown>;
	return (
		parse(record) ??
		(record.data && typeof record.data === "object"
			? parse(record.data as Record<string, unknown>)
			: null)
	);
}

/**
 * True when `err` represents an HTTP 401 from the balance endpoint. A 401
 * means the stored key itself is invalid/expired, not a transient network
 * failure, so callers must flip to a re-login state instead of a retryable
 * error (#402). Browser `fetch` throws `Error("HTTP 401")`; the Tauri
 * `fetch_naia_balance` command rejects with the string
 * `"Naia balance HTTP 401"` — both carry the status code in the message, so
 * match on that rather than requiring a specific Error subclass.
 */
export function isLabBalanceUnauthorized(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return /\b401\b/.test(message);
}

const NAIA_KEY_UNAUTHORIZED_EVENT = "naia_key_unauthorized";

/**
 * Broadcasts that the stored Naia key was rejected by the backend — whether
 * from the balance endpoint or a chat completion 401 — so every mounted
 * "connected" surface (Settings, cost dashboard) flips to the same re-login
 * state together, even though each tracks its own local unauthorized flag
 * (#402).
 */
export function markNaiaKeyUnauthorized(): void {
	window.dispatchEvent(new CustomEvent(NAIA_KEY_UNAUTHORIZED_EVENT));
}

export function onNaiaKeyUnauthorized(handler: () => void): () => void {
	window.addEventListener(NAIA_KEY_UNAUTHORIZED_EVENT, handler);
	return () =>
		window.removeEventListener(NAIA_KEY_UNAUTHORIZED_EVENT, handler);
}

/** Use native HTTP inside Tauri to avoid WebView CORS/PNA balance failures. */
export async function fetchLabBalancePayload(
	gatewayUrl: string,
	naiaKey: string,
	signal?: AbortSignal,
): Promise<unknown> {
	if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
		return invoke<unknown>("fetch_naia_balance", {
			gatewayUrl,
			naiaKey,
		});
	}
	const response = await fetch(
		`${gatewayUrl.replace(/\/+$/, "")}/v1/profile/balance`,
		{
			headers: { "X-AnyLLM-Key": `Bearer ${naiaKey}` },
			signal,
		},
	);
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return response.json();
}
