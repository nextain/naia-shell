import {
	getAdkPath,
	isNaiaConfigHydrationPending,
	readNaiaConfig,
	writeNaiaConfig,
} from "./adk-store";
import { loadConfig, saveConfig } from "./config";
import { Logger } from "./logger";

export interface BrowserLink {
	title: string;
	url: string;
	iconUrl?: string;
	createdAt: number;
}

const BOOKMARKS_KEY = "browserBookmarks";
const SHORTCUTS_KEY = "browserShortcuts";
const LEGACY_BOOKMARKS_KEY = "naia_browser_bookmarks";
const PREFS_CHANGED_EVENT = "naia-browser-prefs-changed";
type BrowserConfigKey = typeof BOOKMARKS_KEY | typeof SHORTCUTS_KEY;

function hasOwn(config: Record<string, unknown>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(config, key);
}

function normalizeLink(value: unknown): BrowserLink | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as Record<string, unknown>;
	const url = typeof raw.url === "string" ? raw.url.trim() : "";
	if (!url) return null;
	const title =
		typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : url;
	const iconUrl =
		typeof raw.iconUrl === "string" && raw.iconUrl.trim()
			? raw.iconUrl.trim()
			: undefined;
	const createdAt =
		typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt)
			? raw.createdAt
			: Date.now();
	return { title, url, iconUrl, createdAt };
}

function normalizeLinks(value: unknown): BrowserLink[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const links: BrowserLink[] = [];
	for (const item of value) {
		const link = normalizeLink(item);
		if (!link || seen.has(link.url)) continue;
		seen.add(link.url);
		links.push(link);
	}
	return links;
}

function readLegacyBookmarks(): BrowserLink[] {
	try {
		return normalizeLinks(
			JSON.parse(localStorage.getItem(LEGACY_BOOKMARKS_KEY) ?? "[]"),
		);
	} catch {
		return [];
	}
}

interface ConfigSnapshot {
	adkPath: string | null;
	config: Record<string, unknown>;
}

async function readConfig(): Promise<ConfigSnapshot> {
	// Bind the complete read/modify/write operation to the workspace selected at
	// the start. A workspace switch between the read and write must not apply an
	// old browser snapshot to the newly selected ADK.
	const adkPath = getAdkPath();
	return {
		adkPath,
		config: (await readNaiaConfig(adkPath)) ?? {},
	};
}

async function writeConfig(
	config: Record<string, unknown>,
	adkPath: string | null,
	changedKey: BrowserConfigKey,
): Promise<void> {
	if (!adkPath) throw new Error("ADK path is not configured");
	if (getAdkPath() !== adkPath) {
		throw new Error("ADK path changed during browser preference update");
	}
	if (isNaiaConfigHydrationPending()) {
		throw new Error("ADK config hydration is still pending");
	}
	// Update only the browser field synchronously, before the ADK queue can
	// yield. App's debounced full-config save may run while this write waits;
	// it must observe the new browser value or it can enqueue an old snapshot
	// that erases the just-added bookmark/shortcut.
	try {
		const cached = loadConfig();
		if (cached) saveConfig({ ...cached, [changedKey]: config[changedKey] });
	} catch (error) {
		Logger.warn("BrowserPrefs", "failed to update local config cache", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
	// writeNaiaConfig snapshots the current path synchronously before it queues
	// the native write. The guard above therefore pins this transaction to the
	// path captured before the awaited read.
	await writeNaiaConfig(config);
	window.dispatchEvent(new CustomEvent(PREFS_CHANGED_EVENT));
}

export function onBrowserPrefsChanged(handler: () => void): () => void {
	window.addEventListener(PREFS_CHANGED_EVENT, handler);
	return () => window.removeEventListener(PREFS_CHANGED_EVENT, handler);
}

export async function loadBrowserBookmarks(): Promise<BrowserLink[]> {
	const { adkPath, config } = await readConfig();
	if (hasOwn(config, BOOKMARKS_KEY)) {
		return normalizeLinks(config[BOOKMARKS_KEY]);
	}
	const legacy = readLegacyBookmarks();
	if (legacy.length > 0) {
		try {
			await writeConfig(
				{ ...config, [BOOKMARKS_KEY]: legacy },
				adkPath,
				BOOKMARKS_KEY,
			);
			localStorage.removeItem(LEGACY_BOOKMARKS_KEY);
		} catch (error) {
			// Keep the legacy copy so a later retry can recover it if the ADK is
			// unavailable or the migration write fails.
			Logger.warn("BrowserPrefs", "failed to migrate legacy bookmarks", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return legacy;
}

export async function loadBrowserShortcuts(): Promise<BrowserLink[]> {
	const { config } = await readConfig();
	return normalizeLinks(config[SHORTCUTS_KEY]);
}

export async function addBrowserBookmark(
	title: string,
	url: string,
): Promise<BrowserLink[]> {
	const { adkPath, config } = await readConfig();
	const current = normalizeLinks(config[BOOKMARKS_KEY]);
	const hasLegacy = localStorage.getItem(LEGACY_BOOKMARKS_KEY) !== null;
	const legacy = hasOwn(config, BOOKMARKS_KEY) ? [] : readLegacyBookmarks();
	const merged = [...current, ...legacy].filter(
		(item, index, all) => all.findIndex((x) => x.url === item.url) === index,
	);
	const nextLink = normalizeLink({ title, url, createdAt: Date.now() });
	if (!nextLink) return merged;
	const next = [
		nextLink,
		...merged.filter((item) => item.url !== nextLink.url),
	];
	await writeConfig(
		{ ...config, [BOOKMARKS_KEY]: next },
		adkPath,
		BOOKMARKS_KEY,
	);
	if (hasLegacy) localStorage.removeItem(LEGACY_BOOKMARKS_KEY);
	Logger.info("BrowserPrefs", "bookmark saved", { url: nextLink.url });
	return next;
}

export async function removeBrowserBookmark(
	url: string,
): Promise<BrowserLink[]> {
	const { adkPath, config } = await readConfig();
	const hasLegacy = localStorage.getItem(LEGACY_BOOKMARKS_KEY) !== null;
	const source = hasOwn(config, BOOKMARKS_KEY)
		? normalizeLinks(config[BOOKMARKS_KEY])
		: readLegacyBookmarks();
	const next = source.filter((item) => item.url !== url);
	await writeConfig(
		{ ...config, [BOOKMARKS_KEY]: next },
		adkPath,
		BOOKMARKS_KEY,
	);
	if (hasLegacy) localStorage.removeItem(LEGACY_BOOKMARKS_KEY);
	return next;
}

export async function addBrowserShortcut(
	title: string,
	url: string,
	iconUrl?: string,
): Promise<BrowserLink[]> {
	const { adkPath, config } = await readConfig();
	const current = normalizeLinks(config[SHORTCUTS_KEY]);
	const nextLink = normalizeLink({
		title,
		url,
		iconUrl,
		createdAt: Date.now(),
	});
	if (!nextLink) return current;
	const next = [
		nextLink,
		...current.filter((item) => item.url !== nextLink.url),
	];
	await writeConfig(
		{ ...config, [SHORTCUTS_KEY]: next },
		adkPath,
		SHORTCUTS_KEY,
	);
	Logger.info("BrowserPrefs", "shortcut saved", { url: nextLink.url });
	return next;
}

export async function removeBrowserShortcut(
	url: string,
): Promise<BrowserLink[]> {
	const { adkPath, config } = await readConfig();
	const next = normalizeLinks(config[SHORTCUTS_KEY]).filter(
		(item) => item.url !== url,
	);
	await writeConfig(
		{ ...config, [SHORTCUTS_KEY]: next },
		adkPath,
		SHORTCUTS_KEY,
	);
	return next;
}

/** Persist a new order for shortcuts (result of drag-to-reorder). */
export async function reorderBrowserShortcuts(
	ordered: BrowserLink[],
): Promise<BrowserLink[]> {
	const { adkPath, config } = await readConfig();
	const next = normalizeLinks(ordered);
	await writeConfig(
		{ ...config, [SHORTCUTS_KEY]: next },
		adkPath,
		SHORTCUTS_KEY,
	);
	return next;
}

/** Update the icon (emoji or URL) for an existing shortcut. */
export async function updateBrowserShortcutIcon(
	url: string,
	iconUrl: string | undefined,
): Promise<BrowserLink[]> {
	const { adkPath, config } = await readConfig();
	const current = normalizeLinks(config[SHORTCUTS_KEY]);
	const next = current.map((item) =>
		item.url === url ? { ...item, iconUrl: iconUrl || undefined } : item,
	);
	await writeConfig(
		{ ...config, [SHORTCUTS_KEY]: next },
		adkPath,
		SHORTCUTS_KEY,
	);
	return next;
}
