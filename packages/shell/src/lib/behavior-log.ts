/**
 * Panel behavior log — Shell WebView IndexedDB.
 *
 * Stores structured behavior events from iframe panels.
 * Intentionally separate from Rust SQLite to avoid new Rust state.
 *
 * Auto-purges entries older than PURGE_DAYS on open.
 */

import { Logger } from "./logger";

const DB_NAME = "naia_behavior";
const DB_VERSION = 1;
const STORE = "log";
const PURGE_DAYS = 30;

export interface BehaviorEntry {
	id?: number;
	panelId: string;
	event: string;
	data?: Record<string, unknown>;
	createdAt: string; // ISO 8601
}

export interface BehaviorFilter {
	panelId?: string;
	event?: string;
	/** ISO 8601 — only entries at or after this timestamp */
	since?: string;
	limit?: number;
}

// ── DB open ──────────────────────────────────────────────────────────────────

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
	if (dbPromise) return dbPromise;
	dbPromise = new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(STORE)) {
				const store = db.createObjectStore(STORE, {
					keyPath: "id",
					autoIncrement: true,
				});
				store.createIndex("panelId", "panelId", { unique: false });
				store.createIndex("event", "event", { unique: false });
				store.createIndex("createdAt", "createdAt", { unique: false });
			}
		};
		req.onsuccess = () => {
			const db = req.result;
			purgeOldEntries(db).catch((err) => {
				Logger.warn("behavior-log", "purgeOldEntries failed", { err });
			});
			resolve(db);
		};
		req.onerror = () => reject(req.error);
	});
	return dbPromise;
}

// ── Purge ─────────────────────────────────────────────────────────────────────

function purgeOldEntries(db: IDBDatabase): Promise<void> {
	const cutoff = new Date(
		Date.now() - PURGE_DAYS * 24 * 60 * 60 * 1000,
	).toISOString();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE, "readwrite");
		const idx = tx.objectStore(STORE).index("createdAt");
		// IDBKeyRange.upperBound includes createdAt < cutoff
		const range = IDBKeyRange.upperBound(cutoff, true);
		const req = idx.openCursor(range);
		req.onsuccess = () => {
			const cursor = req.result;
			if (!cursor) return;
			cursor.delete();
			cursor.continue();
		};
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function logBehavior(
	panelId: string,
	event: string,
	data?: Record<string, unknown>,
): Promise<void> {
	const db = await openDB();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE, "readwrite");
		tx.objectStore(STORE).add({
			panelId,
			event,
			data,
			createdAt: new Date().toISOString(),
		} satisfies Omit<BehaviorEntry, "id">);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

export async function queryBehavior(
	filter?: BehaviorFilter,
): Promise<BehaviorEntry[]> {
	const db = await openDB();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE, "readonly");
		const store = tx.objectStore(STORE);
		const results: BehaviorEntry[] = [];
		const maxResults =
			filter?.limit && filter.limit > 0
				? filter.limit
				: Number.MAX_SAFE_INTEGER;

		// Use panelId index when available — avoids full scan
		const cursorReq: IDBRequest<IDBCursorWithValue | null> = filter?.panelId
			? store
					.index("panelId")
					.openCursor(IDBKeyRange.only(filter.panelId), "prev")
			: store.openCursor(null, "prev");

		cursorReq.onsuccess = () => {
			const cursor = cursorReq.result;
			if (!cursor || results.length >= maxResults) {
				resolve(results);
				return;
			}
			const entry = cursor.value as BehaviorEntry;
			const matches =
				(!filter?.event || entry.event === filter.event) &&
				(!filter?.since || entry.createdAt >= filter.since);
			if (matches) results.push(entry);
			cursor.continue();
		};
		cursorReq.onerror = () => reject(cursorReq.error);
	});
}
