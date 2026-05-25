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

function readLocal(key: string): BrowserLink[] {
	try {
		return normalizeLinks(JSON.parse(localStorage.getItem(key) ?? "[]"));
	} catch {
		return [];
	}
}

function writeLocal(key: string, links: BrowserLink[]): void {
	localStorage.setItem(key, JSON.stringify(links));
	window.dispatchEvent(new CustomEvent(PREFS_CHANGED_EVENT));
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

export function onBrowserPrefsChanged(handler: () => void): () => void {
	window.addEventListener(PREFS_CHANGED_EVENT, handler);
	return () => window.removeEventListener(PREFS_CHANGED_EVENT, handler);
}

export async function loadBrowserBookmarks(): Promise<BrowserLink[]> {
	const stored = readLocal(BOOKMARKS_KEY);
	if (stored.length > 0 || localStorage.getItem(BOOKMARKS_KEY) !== null) {
		return stored;
	}
	// First run: migrate from legacy key
	return readLegacyBookmarks();
}

export async function loadBrowserShortcuts(): Promise<BrowserLink[]> {
	return readLocal(SHORTCUTS_KEY);
}

export async function addBrowserBookmark(
	title: string,
	url: string,
): Promise<BrowserLink[]> {
	const current = readLocal(BOOKMARKS_KEY);
	const legacy =
		localStorage.getItem(BOOKMARKS_KEY) !== null ? [] : readLegacyBookmarks();
	const merged = [...current, ...legacy].filter(
		(item, index, all) => all.findIndex((x) => x.url === item.url) === index,
	);
	const nextLink = normalizeLink({ title, url, createdAt: Date.now() });
	if (!nextLink) return merged;
	const next = [
		nextLink,
		...merged.filter((item) => item.url !== nextLink.url),
	];
	writeLocal(BOOKMARKS_KEY, next);
	Logger.info("BrowserPrefs", "bookmark saved", { url: nextLink.url });
	return next;
}

export async function removeBrowserBookmark(
	url: string,
): Promise<BrowserLink[]> {
	const source =
		localStorage.getItem(BOOKMARKS_KEY) !== null
			? readLocal(BOOKMARKS_KEY)
			: readLegacyBookmarks();
	const next = source.filter((item) => item.url !== url);
	writeLocal(BOOKMARKS_KEY, next);
	return next;
}

export async function addBrowserShortcut(
	title: string,
	url: string,
	iconUrl?: string,
): Promise<BrowserLink[]> {
	const current = readLocal(SHORTCUTS_KEY);
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
	writeLocal(SHORTCUTS_KEY, next);
	Logger.info("BrowserPrefs", "shortcut saved", { url: nextLink.url });
	return next;
}

export async function removeBrowserShortcut(
	url: string,
): Promise<BrowserLink[]> {
	const next = readLocal(SHORTCUTS_KEY).filter((item) => item.url !== url);
	writeLocal(SHORTCUTS_KEY, next);
	return next;
}

/** Persist a new order for shortcuts (result of drag-to-reorder). */
export async function reorderBrowserShortcuts(
	ordered: BrowserLink[],
): Promise<BrowserLink[]> {
	const next = normalizeLinks(ordered);
	writeLocal(SHORTCUTS_KEY, next);
	return next;
}

/** Update the icon (emoji or URL) for an existing shortcut. */
export async function updateBrowserShortcutIcon(
	url: string,
	iconUrl: string | undefined,
): Promise<BrowserLink[]> {
	const current = readLocal(SHORTCUTS_KEY);
	const next = current.map((item) =>
		item.url === url ? { ...item, iconUrl: iconUrl || undefined } : item,
	);
	writeLocal(SHORTCUTS_KEY, next);
	return next;
}
