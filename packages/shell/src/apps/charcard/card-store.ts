import { Logger } from "../../lib/logger";
import { MAX_APP_STORAGE_VALUE_CHARS } from "../generic-installed/installed-app-storage";
import type { NormalizedCharacterCard } from "./card-parser";

const TAG = "CharCardStore";
const CHARCARD_APP_ID = "land.naia.charcard";

export const CHARCARD_DB_NAME = `naia-app:${CHARCARD_APP_ID}:cards-v1`;
export const CHARCARD_STORE_NAME = "cards";
const DB_VERSION = 1;
const HOST_CARD_PREFIX = "card:";
const HOST_STORAGE_TIMEOUT_MS = 10_000;

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
	mode: "indexeddb" | "host" | "memory";
	listCards(): Promise<StoredCardRecord[]>;
	saveCard(record: StoredCardRecord): Promise<void>;
	removeCard(id: string): Promise<void>;
}

export class CardStorageValueTooLargeError extends Error {
	constructor() {
		super("Card exceeds the shell storage size limit");
	}
}

type HostCardRecord = Omit<StoredCardRecord, "imageBlob"> & {
	imageBlob: string | null;
};

interface HostStorageReply {
	type: string;
	id: string;
	ok: boolean;
	error?: string;
	keys?: string[];
	value?: HostCardRecord | null;
}

function requestHostStorage(
	op: "keys" | "get" | "set" | "delete",
	key?: string,
	value?: HostCardRecord,
): Promise<HostStorageReply> {
	const parent = window.parent;
	// The bundled frame URL is served from the shell's origin.
	const origin = window.location.origin;
	const id =
		crypto.randomUUID?.() ??
		`card-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	Logger.debug(TAG, "requesting shell card storage", { op });
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			window.removeEventListener("message", onMessage);
			window.clearTimeout(timer);
		};
		const onMessage = (event: MessageEvent<HostStorageReply>) => {
			const reply = event.data;
			if (
				event.source !== parent ||
				event.origin !== origin ||
				reply?.type !== "naia-app:storage-result" ||
				reply.id !== id
			)
				return;

			cleanup();
			if (reply.ok === true) resolve(reply);
			else if (reply.error === "too_large")
				reject(new CardStorageValueTooLargeError());
			else reject(new Error("Shell card storage request failed"));
		};
		const timer = window.setTimeout(() => {
			cleanup();
			reject(new Error("Shell card storage request timed out"));
		}, HOST_STORAGE_TIMEOUT_MS);
		window.addEventListener("message", onMessage);
		try {
			parent.postMessage(
				{
					type: "naia-app:storage",
					appId: CHARCARD_APP_ID,
					id,
					op,
					key,
					value,
				},
				origin,
			);
		} catch (error) {
			cleanup();
			reject(error);
		}
	});
}

function encodeCardImage(image: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.onerror = () =>
			reject(reader.error ?? new Error("Could not read card image"));
		reader.readAsDataURL(image);
	});
}

export function decodeDataUrlBytes(dataUrl: string) {
	const commaIndex = dataUrl.indexOf(",");
	const base64 = commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl;
	const binary = atob(base64.trim());
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

function restoreHostCard({
	imageBlob,
	...fields
}: HostCardRecord): StoredCardRecord {
	if (imageBlob === null) return { ...fields, imageBlob };
	const type = /^data:([^;]*);base64,/.exec(imageBlob)?.[1];
	if (type === undefined) throw new Error("Invalid saved card image");
	return {
		...fields,
		imageBlob: new Blob([decodeDataUrlBytes(imageBlob)], { type }),
	};
}

async function hostCardKeys(): Promise<string[]> {
	const { keys } = await requestHostStorage("keys");
	if (!Array.isArray(keys)) throw new Error("Missing shell card storage keys");
	return keys.filter(
		(key) => typeof key === "string" && key.startsWith(HOST_CARD_PREFIX),
	);
}

const hostCardStorage: CardStorageAdapter = {
	mode: "host",
	async listCards() {
		const keys = await hostCardKeys();
		const replies = await Promise.all(
			keys.map((key) => requestHostStorage("get", key)),
		);
		return replies
			.flatMap(({ value }) => (value ? [restoreHostCard(value)] : []))
			.sort((a, b) => b.importedAt - a.importedAt);
	},
	async saveCard({ imageBlob, ...fields }) {
		// A data URL keeps the image bytes within the host's JSON value limit.
		if (
			imageBlob &&
			Math.ceil(imageBlob.size / 3) * 4 > MAX_APP_STORAGE_VALUE_CHARS
		) {
			throw new CardStorageValueTooLargeError();
		}
		const value: HostCardRecord = {
			...fields,
			imageBlob: imageBlob ? await encodeCardImage(imageBlob) : null,
		};
		if (JSON.stringify(value).length > MAX_APP_STORAGE_VALUE_CHARS) {
			throw new CardStorageValueTooLargeError();
		}
		await requestHostStorage("set", `${HOST_CARD_PREFIX}${fields.id}`, value);
	},
	async removeCard(id) {
		await requestHostStorage("delete", `${HOST_CARD_PREFIX}${id}`);
	},
};

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
		Logger.debug(TAG, "local card storage could not be opened", {
			error: String(error),
		});
	}

	if (
		typeof window !== "undefined" &&
		window.parent !== window &&
		window.location.origin !== "null"
	) {
		try {
			await hostCardKeys();
			Logger.debug(TAG, "opened shell card storage");
			return hostCardStorage;
		} catch (error) {
			Logger.warn(TAG, "shell card storage could not be opened", {
				error: String(error),
			});
		}
	}

	Logger.warn(TAG, "falling back to in-memory card storage");
	return createMemoryCardStorage();
}
