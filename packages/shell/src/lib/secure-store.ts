/**
 * Secure key-value store backed by Tauri Store plugin.
 * Used for sensitive data (API keys, tokens).
 * Non-sensitive config (provider, model, theme) stays in localStorage.
 */

import { load } from "@tauri-apps/plugin-store";

const STORE_FILE = "secure-keys.dat";
const STORE_LOAD_RETRIES = 3;
const STORE_RETRY_DELAY_MS = 150;

let storePromise: ReturnType<typeof load> | null = null;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getStore() {
	for (let attempt = 0; attempt < STORE_LOAD_RETRIES; attempt++) {
		try {
			if (!storePromise) {
				// Type cast to bypass strict property checks on StoreOptions since we only care about autoSave
				storePromise = load(
					STORE_FILE,
					{ autoSave: true } as Parameters<typeof load>[1],
				);
			}
			return await storePromise;
		} catch (err) {
			storePromise = null;
			if (attempt === STORE_LOAD_RETRIES - 1) throw err;
			await delay(STORE_RETRY_DELAY_MS * (attempt + 1));
		}
	}
	throw new Error("secure store unavailable");
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

/** Keys that should be stored securely (not in localStorage). */
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
