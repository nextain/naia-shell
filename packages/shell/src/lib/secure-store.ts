/**
 * Secure key-value store backed by the selected ADK's native store.
 * Used for sensitive data (API keys, tokens).
 * Non-sensitive config (provider, model, theme) stays in localStorage.
 */

import { invoke } from "@tauri-apps/api/core";
import { load } from "@tauri-apps/plugin-store";

const ADK_PATH_KEY = "naia-adk-path";
/** Receipt kept in the pre-ADK app-data store, never in localStorage. */
const FIRST_ADK_BINDING_RECEIPT_KEY = "__naia_secure_store_first_adk";
const PRIVATE_DATA_DIR = "data-private";
const STORE_FILE_NAME = "secure-keys.dat";
const LEGACY_STORE_FILE_NAME = "secure-keys.dat";
let legacyStorePromise: ReturnType<typeof load> | null = null;

function selectedAdkPath(): string | null {
	if (typeof localStorage === "undefined") return null;
	const path = localStorage.getItem(ADK_PATH_KEY)?.trim();
	if (!path) return null;
	// Keep filesystem roots intact while accepting pointers written by older
	// versions with a trailing separator.
	if (path === "/" || /^[A-Za-z]:[\\/]?$/.test(path)) return path;
	return path.replace(/[/\\]+$/, "");
}

function secureStorePath(): string | null {
	const adkPath = selectedAdkPath();
	if (!adkPath) return null;
	const separator = adkPath.includes("\\") ? "\\" : "/";
	const root = adkPath.endsWith(separator) ? adkPath : `${adkPath}${separator}`;
	return `${root}${PRIVATE_DATA_DIR}${separator}${STORE_FILE_NAME}`;
}

/** Resolve the canonical secret store for the currently selected ADK. */
export function getSecureStorePath(): string | null {
	return secureStorePath();
}

function requireSecureStorePath(): string {
	const path = secureStorePath();
	if (!path) {
		throw new Error("Cannot access secure credentials without a selected ADK");
	}
	return path;
}

/**
 * Canonical ADK secrets are read and written by Rust. The expected path is
 * sent with every operation so an ADK switch during an awaited operation is
 * rejected by native code instead of mixing two workspaces.
 */
async function nativeSecureStoreGet(
	name: string,
	expectedStorePath: string,
): Promise<string | null> {
	return (
		(await invoke<string | null>("secure_store_get", {
			name,
			expectedStorePath,
		})) ?? null
	);
}

async function nativeSecureStoreSet(
	name: string,
	value: string,
	expectedStorePath: string,
): Promise<void> {
	await invoke<void>("secure_store_set", {
		name,
		value,
		expectedStorePath,
	});
}

async function nativeSecureStoreDelete(
	name: string,
	expectedStorePath: string,
): Promise<void> {
	await invoke<void>("secure_store_delete", {
		name,
		expectedStorePath,
	});
}

/**
 * Read the old app-data store during the one-time first-ADK migration.
 * It is intentionally kept separate from the canonical ADK store cache.
 */
async function getLegacyStore() {
	if (!legacyStorePromise) {
		legacyStorePromise = load(
			LEGACY_STORE_FILE_NAME,
			{ autoSave: false } as Parameters<typeof load>[1],
		);
	}
	return await legacyStorePromise;
}

export async function getLegacySecretKey(
	name: string,
): Promise<string | null> {
	const store = await getLegacyStore();
	const value = await store.get<string>(name);
	return value ?? null;
}

/** Enumerate legacy values for the one-time migration without exposing them. */
export async function getLegacySecretEntries(): Promise<
	Array<[string, unknown]>
> {
	const store = await getLegacyStore();
	return store.entries<unknown>();
}

/**
 * The receipt is persisted in the old device store so a cache-free restart
 * cannot make a later ADK inherit credentials from that store. The legacy
 * values remain untouched and recoverable if a migration is interrupted.
 */
export async function hasFirstAdkBindingReceipt(): Promise<boolean> {
	const store = await getLegacyStore();
	return Boolean(
		await store.get<string>(FIRST_ADK_BINDING_RECEIPT_KEY),
	);
}

export async function markFirstAdkBinding(adkPath: string): Promise<void> {
	const store = await getLegacyStore();
	await store.set(FIRST_ADK_BINDING_RECEIPT_KEY, adkPath);
	await store.save();
}

export async function saveSecretKey(
	name: string,
	value: string,
): Promise<void> {
	await saveSecretKeyAtPath(name, value, requireSecureStorePath());
}

/** Save to a previously captured ADK path; native rejects a changed pointer. */
export async function saveSecretKeyAtPath(
	name: string,
	value: string,
	path: string,
): Promise<void> {
	await nativeSecureStoreSet(name, value, path);
}

export async function getSecretKey(name: string): Promise<string | null> {
	const path = secureStorePath();
	if (!path) return null;
	return getSecretKeyAtPath(name, path);
}

/** Read a snapshot path so one hydrate cannot mix values after an ADK switch. */
export async function getSecretKeyAtPath(
	name: string,
	path: string,
): Promise<string | null> {
	return nativeSecureStoreGet(name, path);
}

export async function deleteSecretKey(name: string): Promise<void> {
	const path = secureStorePath();
	if (!path) return;
	await deleteSecretKeyAtPath(name, path);
}

/** Delete from a previously captured ADK path; native rejects a changed pointer. */
export async function deleteSecretKeyAtPath(
	name: string,
	path: string,
): Promise<void> {
	await nativeSecureStoreDelete(name, path);
}

/** Keys that should be stored securely (not in localStorage). */
export const SECRET_KEYS = [
	"apiKey",
	"googleApiKey",
	"openaiTtsApiKey",
	"elevenlabsApiKey",
	"naiaKey",
	"gatewayToken",
	"openaiRealtimeApiKey",
	"subLlmApiKey",
	"memoryLlmApiKey",
	"memoryEmbeddingApiKey",
	"qdrantApiKey",
] as const;

export type SecretKeyName = (typeof SECRET_KEYS)[number];

export function isSecretKey(key: string): key is SecretKeyName {
	return (SECRET_KEYS as readonly string[]).includes(key);
}
