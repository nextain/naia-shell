import { Logger } from "../../lib/logger";
import type { NormalizedCharacterCard } from "./card-parser";

const TAG = "CharCardStore";

export const CHARCARD_DB_NAME = "naia-app:land.naia.charcard:cards-v1";
export const CHARCARD_STORE_NAME = "cards";
const DB_VERSION = 1;

export interface StoredCardRecord {
	id: string;
	fileName: string;
	importedAt: number;
	card: NormalizedCharacterCard;
	rawJson: Record<string, unknown>;
	imageBlob: Blob | null;
	imageOmitted?: boolean;
	builtIn?: boolean;
}

export interface CardStorageAdapter {
	mode: "indexeddb" | "memory";
	listCards(): Promise<StoredCardRecord[]>;
	saveCard(record: StoredCardRecord): Promise<void>;
	removeCard(id: string): Promise<void>;
}

export function createMemoryCardStorage(): CardStorageAdapter {
	const map = new Map<string, StoredCardRecord>();
	return {
		mode: "memory",
		async listCards() {
			return Array.from(map.values()).sort(
				(a, b) => b.importedAt - a.importedAt,
			);
		},
		async saveCard(record) {
			map.set(record.id, record);
		},
		async removeCard(id) {
			map.delete(id);
		},
	};
}

function openCardIdb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		if (typeof indexedDB === "undefined" || !indexedDB) {
			reject(new Error("indexedDB unavailable"));
			return;
		}
		let request: IDBOpenDBRequest;
		try {
			request = indexedDB.open(CHARCARD_DB_NAME, DB_VERSION);
		} catch (err) {
			reject(err instanceof Error ? err : new Error(String(err)));
			return;
		}
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(CHARCARD_STORE_NAME)) {
				db.createObjectStore(CHARCARD_STORE_NAME, { keyPath: "id" });
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () =>
			reject(request.error ?? new Error("indexedDB open failed"));
		request.onblocked = () => reject(new Error("indexedDB open blocked"));
	});
}

export async function createCardStorage(): Promise<CardStorageAdapter> {
	try {
		const db = await openCardIdb();
		Logger.debug(TAG, "opened IndexedDB storage", { dbName: CHARCARD_DB_NAME });
		return {
			mode: "indexeddb",
			listCards(): Promise<StoredCardRecord[]> {
				return new Promise((resolve, reject) => {
					try {
						const tx = db.transaction(CHARCARD_STORE_NAME, "readonly");
						const store = tx.objectStore(CHARCARD_STORE_NAME);
						const req = store.getAll();
						req.onsuccess = () => {
							const rows = Array.isArray(req.result)
								? (req.result as StoredCardRecord[])
								: [];
							rows.sort((a, b) => b.importedAt - a.importedAt);
							resolve(rows);
						};
						req.onerror = () =>
							reject(req.error ?? new Error("IDB getAll failed"));
					} catch (err) {
						reject(err instanceof Error ? err : new Error(String(err)));
					}
				});
			},
			saveCard(record: StoredCardRecord): Promise<void> {
				return new Promise((resolve, reject) => {
					try {
						const tx = db.transaction(CHARCARD_STORE_NAME, "readwrite");
						const store = tx.objectStore(CHARCARD_STORE_NAME);
						store.put(record);
						tx.oncomplete = () => resolve();
						tx.onerror = () => reject(tx.error ?? new Error("IDB put failed"));
					} catch (err) {
						reject(err instanceof Error ? err : new Error(String(err)));
					}
				});
			},
			removeCard(id: string): Promise<void> {
				return new Promise((resolve, reject) => {
					try {
						const tx = db.transaction(CHARCARD_STORE_NAME, "readwrite");
						const store = tx.objectStore(CHARCARD_STORE_NAME);
						store.delete(id);
						tx.oncomplete = () => resolve();
						tx.onerror = () =>
							reject(tx.error ?? new Error("IDB delete failed"));
					} catch (err) {
						reject(err instanceof Error ? err : new Error(String(err)));
					}
				});
			},
		};
	} catch (error) {
		Logger.warn(TAG, "falling back to in-memory card storage", {
			error: String(error),
		});
		return createMemoryCardStorage();
	}
}
