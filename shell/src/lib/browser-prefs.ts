import { readNaiaConfig, writeNaiaConfig } from "./adk-store";
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

async function readConfig(): Promise<Record<string, unknown>> {
	return (await readNaiaConfig()) ?? {};
}

async function writeConfig(config: Record<string, unknown>): Promise<void> {
	await writeNaiaConfig(config);
	window.dispatchEvent(new CustomEvent(PREFS_CHANGED_EVENT));
}

export function onBrowserPrefsChanged(handler: () => void): () => void {
	window.addEventListener(PREFS_CHANGED_EVENT, handler);
	return () => window.removeEventListener(PREFS_CHANGED_EVENT, handler);
}

export async function loadBrowserBookmarks(): Promise<BrowserLink[]> {
	const config = await readConfig();
	if (hasOwn(config, BOOKMARKS_KEY)) {
		return normalizeLinks(config[BOOKMARKS_KEY]);
	}
	return readLegacyBookmarks();
}

export async function loadBrowserShortcuts(): Promise<BrowserLink[]> {
	const config = await readConfig();
	return normalizeLinks(config[SHORTCUTS_KEY]);
}

export async function addBrowserBookmark(
	title: string,
	url: string,
): Promise<BrowserLink[]> {
	const config = await readConfig();
	const current = normalizeLinks(config[BOOKMARKS_KEY]);
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
	await writeConfig({ ...config, [BOOKMARKS_KEY]: next });
	Logger.info("BrowserPrefs", "bookmark saved", { url: nextLink.url });
	return next;
}

export async function removeBrowserBookmark(
	url: string,
): Promise<BrowserLink[]> {
	const config = await readConfig();
	const source = hasOwn(config, BOOKMARKS_KEY)
		? normalizeLinks(config[BOOKMARKS_KEY])
		: readLegacyBookmarks();
	const next = source.filter((item) => item.url !== url);
	await writeConfig({ ...config, [BOOKMARKS_KEY]: next });
	return next;
}

export async function addBrowserShortcut(
	title: string,
	url: string,
	iconUrl?: string,
): Promise<BrowserLink[]> {
	const config = await readConfig();
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
	await writeConfig({ ...config, [SHORTCUTS_KEY]: next });
	Logger.info("BrowserPrefs", "shortcut saved", { url: nextLink.url });
	return next;
}

export async function removeBrowserShortcut(
	url: string,
): Promise<BrowserLink[]> {
	const config = await readConfig();
	const next = normalizeLinks(config[SHORTCUTS_KEY]).filter(
		(item) => item.url !== url,
	);
	await writeConfig({ ...config, [SHORTCUTS_KEY]: next });
	return next;
}

/** Persist a new order for shortcuts (result of drag-to-reorder). */
export async function reorderBrowserShortcuts(
	ordered: BrowserLink[],
): Promise<BrowserLink[]> {
	const config = await readConfig();
	const next = normalizeLinks(ordered);
	await writeConfig({ ...config, [SHORTCUTS_KEY]: next });
	return next;
}

/** Update the icon (emoji or URL) for an existing shortcut. */
export async function updateBrowserShortcutIcon(
	url: string,
	iconUrl: string | undefined,
): Promise<BrowserLink[]> {
	const config = await readConfig();
	const current = normalizeLinks(config[SHORTCUTS_KEY]);
	const next = current.map((item) =>
		item.url === url ? { ...item, iconUrl: iconUrl || undefined } : item,
	);
	await writeConfig({ ...config, [SHORTCUTS_KEY]: next });
	return next;
}
