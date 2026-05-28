/**
 * Secure key-value store backed by Tauri Store plugin.
 * Used for sensitive data (API keys, tokens).
 * Non-sensitive config (provider, model, theme) stays in localStorage.
 */

import { load } from "@tauri-apps/plugin-store";

const STORE_FILE = "secure-keys.dat";

let storePromise: ReturnType<typeof load> | null = null;

function getStore() {
	if (!storePromise) {
		// Type cast to bypass strict property checks on StoreOptions since we only care about autoSave
		storePromise = load(STORE_FILE, { autoSave: true } as any);
	}
	return storePromise;
}

export async function saveSecretKey(
	name: string,
	value: string,
): Promise<void> {
	const store = await getStore();
	await store.set(name, value);
}

export async function getSecretKey(name: string): Promise<string | null> {
	const store = await getStore();
	const val = await store.get<string>(name);
	return val ?? null;
}

export async function deleteSecretKey(name: string): Promise<void> {
	const store = await getStore();
	await store.delete(name);
}

/**
 * Keys that should be stored securely (not in localStorage).
 *
 * NOTE (#337 Phase 6c): the `"naiaKey"` entry is RETAINED ONLY for Phase 8
 * legacy migration (a one-time read of the stale slot to seed the agent's
 * encrypted auth file). Runtime code MUST NOT call
 * `(save|get|delete)SecretKey("naiaKey")` directly — the agent is the
 * source of truth and exposes its state via `agentAuthQuery` /
 * `agentAuthLogout` / `agentLabProxyRequest`. The entry is removed from this
 * array as part of Phase 8 wrap-up.
 */
export const SECRET_KEYS = [
	"apiKey",
	"googleApiKey",
	"naiaKey",
	"gatewayToken",
	"openaiRealtimeApiKey",
] as const;

export type SecretKeyName = (typeof SECRET_KEYS)[number];

export function isSecretKey(key: string): key is SecretKeyName {
	return (SECRET_KEYS as readonly string[]).includes(key);
}
