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
 * #337 Phase 10-pre cross-review CRITICAL #2: `"naiaKey"` is no longer a
 * generic secret managed by `loadConfigWithSecrets` / `saveConfigSecure`.
 * The agent is the SoT and the encrypted ADK auth file is the persistence
 * layer. Runtime code must drive auth via `agentAuthQuery` /
 * `agentAuthLogout` / `agentLabProxyRequest`. The legacy migration path
 * (legacy-migration.ts) still reads/deletes the slot directly via
 * {@link LEGACY_NAIA_KEY_SLOT} to drain pre-#337 installations.
 */
export const SECRET_KEYS = [
	"apiKey",
	"googleApiKey",
	"gatewayToken",
	"openaiRealtimeApiKey",
] as const;

export type SecretKeyName = (typeof SECRET_KEYS)[number];

export function isSecretKey(key: string): key is SecretKeyName {
	return (SECRET_KEYS as readonly string[]).includes(key);
}

/**
 * Legacy `secure-keys.dat` slot for the pre-#337 `naiaKey`. Deliberately NOT a
 * member of {@link SECRET_KEYS} — generic hydrate/persist must not touch it.
 * Phase 8 (legacy-migration.ts) is the only consumer: it reads this slot once
 * to seed the agent's encrypted auth file then deletes it.
 */
export const LEGACY_NAIA_KEY_SLOT = "naiaKey";
