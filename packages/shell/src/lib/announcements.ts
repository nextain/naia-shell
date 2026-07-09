import { Logger } from "./logger";

const ANNOUNCEMENTS_URL = "https://www.naia.land/api/announcements";
const STORAGE_KEY = "naia_read_announcements";
const FETCH_TIMEOUT_MS = 8000;

export type AnnouncementType = "release" | "maintenance" | "info" | "warning";
export type AnnouncementPriority = "high" | "normal" | "low";

export interface Announcement {
	id: string;
	date: string;
	type: AnnouncementType;
	priority: AnnouncementPriority;
	title: Record<string, string>;
	body: Record<string, string>;
	url?: string;
}

interface AnnouncementsFile {
	version: number;
	announcements: Announcement[];
}

function getReadIds(): Set<string> {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return new Set();
		return new Set(JSON.parse(raw) as string[]);
	} catch {
		return new Set();
	}
}

export function markAnnouncementRead(id: string): void {
	try {
		const ids = getReadIds();
		ids.add(id);
		localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
	} catch (err) {
		Logger.warn("announcements", "Failed to persist read id", {
			error: String(err),
		});
	}
}

export function getLocalizedText(
	map: Record<string, string>,
	lang: string,
): string {
	if (map[lang]) return map[lang];
	// fallback: base language (e.g. "zh-TW" → "zh")
	const base = lang.split("-")[0];
	if (map[base]) return map[base];
	return map["en"] ?? Object.values(map)[0] ?? "";
}

const PRIORITY_ORDER: Record<string, number> = { high: 0, normal: 1, low: 2 };

function isValidAnnouncement(a: unknown): a is Announcement {
	if (!a || typeof a !== "object") return false;
	const obj = a as Record<string, unknown>;
	return (
		typeof obj.id === "string" &&
		obj.id.length > 0 &&
		typeof obj.date === "string" &&
		obj.date.length > 0 &&
		typeof obj.title === "object" &&
		obj.title !== null &&
		!Array.isArray(obj.title) &&
		typeof obj.body === "object" &&
		obj.body !== null &&
		!Array.isArray(obj.body) &&
		(obj.url === undefined || (typeof obj.url === "string" && /^https?:\/\//.test(obj.url)))
	);
}

/**
 * Fetch unread announcements from the Naia API.
 * Returns [] on network error — never throws.
 */
export async function fetchUnreadAnnouncements(): Promise<Announcement[]> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

	try {
		const res = await fetch(ANNOUNCEMENTS_URL, {
			signal: controller.signal,
			cache: "no-cache",
		});

		if (!res.ok) {
			Logger.warn("announcements", "Fetch failed", { status: res.status });
			return [];
		}

		const data: AnnouncementsFile = await res.json();
		if (!Array.isArray(data.announcements)) return [];

		const readIds = getReadIds();
		return data.announcements
			.filter(isValidAnnouncement)
			.filter((a) => !readIds.has(a.id))
			.sort((a, b) => {
				// high priority first, then by date desc
				const pa = PRIORITY_ORDER[a.priority] ?? 1;
				const pb = PRIORITY_ORDER[b.priority] ?? 1;
				const pd = pa - pb;
				if (pd !== 0) return pd;
				return b.date.localeCompare(a.date);
			});
	} catch (err) {
		if ((err as Error).name !== "AbortError") {
			Logger.info("announcements", "Fetch skipped", { error: String(err) });
		}
		return [];
	} finally {
		clearTimeout(timer);
	}
}
