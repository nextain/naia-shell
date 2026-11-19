/**
 * R11: per-app key/value storage kept by the shell for sandboxed mini apps.
 *
 * Hosted and web mini apps run in an opaque iframe sandbox (no
 * `allow-same-origin`, see GenericInstalledApp). Their own `indexedDB` therefore
 * throws, and apps such as the character card fall back to memory only. The
 * shell keeps the sandbox and stores data for them in its own IndexedDB, keyed
 * by app id so one app can never read another app's data.
 */

export interface InstalledAppStorage {
	get(appId: string, key: string): Promise<unknown>;
	set(appId: string, key: string, value: unknown): Promise<void>;
	delete(appId: string, key: string): Promise<void>;
	keys(appId: string): Promise<string[]>;
}

export const MAX_APP_STORAGE_KEY_CHARS = 200;
/** Per value, measured as JSON text (a card with an embedded PNG fits). */
export const MAX_APP_STORAGE_VALUE_CHARS = 8 * 1024 * 1024;

const DB_NAME = "naia-installed-app-storage";
const STORE = "kv";

function request<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new Error("indexeddb_error"));
	});
}

let dbPromise: Promise<IDBDatabase> | null = null;
function openDb(): Promise<IDBDatabase> {
	if (dbPromise) return dbPromise;
	dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
		if (typeof indexedDB === "undefined") {
			reject(new Error("indexeddb_unavailable"));
			return;
		}
		const req = indexedDB.open(DB_NAME, 1);
		req.onupgradeneeded = () => {
			if (!req.result.objectStoreNames.contains(STORE)) {
				req.result.createObjectStore(STORE);
			}
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new Error("indexeddb_error"));
	}).catch((err) => {
		dbPromise = null;
		throw err;
	});
	return dbPromise;
}

async function withStore<T>(
	mode: IDBTransactionMode,
	run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
	const db = await openDb();
	const tx = db.transaction(STORE, mode);
	const result = await request(run(tx.objectStore(STORE)));
	if (mode === "readwrite") {
		await new Promise<void>((resolve, reject) => {
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error ?? new Error("indexeddb_error"));
			tx.onabort = () => reject(tx.error ?? new Error("indexeddb_abort"));
		});
	}
	return result;
}

export const shellIndexedDbAppStorage: InstalledAppStorage = {
	get: (appId, key) => withStore("readonly", (s) => s.get([appId, key])),
	set: async (appId, key, value) => {
		await withStore("readwrite", (s) => s.put(value, [appId, key]));
	},
	delete: async (appId, key) => {
		await withStore("readwrite", (s) => s.delete([appId, key]));
	},
	keys: async (appId) => {
		const range = IDBKeyRange.bound([appId, ""], [appId, "￿"]);
		const all = await withStore("readonly", (s) => s.getAllKeys(range));
		return all.map((k) => (Array.isArray(k) ? String(k[1]) : String(k)));
	},
};

/** In-memory backend for tests and for browsers without IndexedDB. */
export function createMemoryAppStorage(): InstalledAppStorage {
	const data = new Map<string, unknown>();
	const id = (appId: string, key: string) => `${appId}\u0000${key}`;
	return {
		get: async (appId, key) => structuredClone(data.get(id(appId, key))),
		set: async (appId, key, value) => {
			data.set(id(appId, key), structuredClone(value));
		},
		delete: async (appId, key) => {
			data.delete(id(appId, key));
		},
		keys: async (appId) =>
			[...data.keys()]
				.filter((k) => k.startsWith(`${appId}\u0000`))
				.map((k) => k.slice(appId.length + 1))
				.sort(),
	};
}

let activeStorage: InstalledAppStorage = shellIndexedDbAppStorage;
export function getInstalledAppStorage(): InstalledAppStorage {
	return activeStorage;
}
export function setInstalledAppStorageForTests(
	storage: InstalledAppStorage | null,
): void {
	activeStorage = storage ?? shellIndexedDbAppStorage;
}
