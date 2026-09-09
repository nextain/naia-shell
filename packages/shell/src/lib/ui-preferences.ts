import { useSyncExternalStore } from "react";
import { getAdkPath, writeNaiaUiConfig } from "./adk-store";
import { loadConfig, saveConfig } from "./config";

/** Stable names used inside AppConfig.uiPreferences. */
export const UI_PREFERENCE_KEYS = {
	chatMode: "chatMode",
	workspaceRailCollapsed: "workspaceRailCollapsed",
	avatarCamera: "avatarCamera",
	nvaPan: "nvaPan",
	youtubeAppHeight: "youtubeAppHeight",
	browserToolPerms: "browserToolPerms",
	browserToolbarCollapsed: "browserToolbarCollapsed",
	editorZoom: "editorZoom",
	classifiedDirs: "classifiedDirs",
	readAnnouncementIds: "readAnnouncementIds",
	updatePromptSnooze: "updatePromptSnooze",
} as const;

export type UiPreferenceKey =
	(typeof UI_PREFERENCE_KEYS)[keyof typeof UI_PREFERENCE_KEYS];
export type UiPreferences = Record<string, unknown>;

const LEGACY_OWNER_KEY = "naia-ui-preferences-legacy-owner";
const UPDATE_PROMPT_SNOOZE_LEGACY_KEY = "naia.updatePromptSnooze";

function readStorage(key: string): string | null {
	try {
		return typeof localStorage === "undefined"
			? null
			: localStorage.getItem(key);
	} catch {
		return null;
	}
}

function writeStorage(key: string, value: string): void {
	try {
		if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
	} catch {
		/* A blocked storage area must not break application startup. */
	}
}

function removeStorage(key: string): void {
	try {
		if (typeof localStorage !== "undefined") localStorage.removeItem(key);
	} catch {
		/* best effort */
	}
}

function parseJson(raw: string | null): unknown {
	if (!raw) return undefined;
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUpdatePromptSnooze(value: unknown): value is {
	version: string;
	until: number;
} {
	return (
		isRecord(value) &&
		typeof value.version === "string" &&
		Number.isFinite(value.until)
	);
}

function normalizeAdkPath(path: string | null | undefined): string | null {
	const trimmed = path?.trim();
	return trimmed ? trimmed.replace(/[\\/]$/, "") : null;
}

function readLegacyPreferences(): UiPreferences {
	const next: UiPreferences = {};
	const chatMode = readStorage("naia-chat-mode-v1");
	if (chatMode === "workspace" || chatMode === "app" || chatMode === "home")
		next[UI_PREFERENCE_KEYS.chatMode] = chatMode === "home" ? "app" : chatMode;

	const railCollapsed = readStorage("naia-ws-rail-collapsed");
	if (railCollapsed === "1" || railCollapsed === "0")
		next[UI_PREFERENCE_KEYS.workspaceRailCollapsed] = railCollapsed === "1";

	const camera = parseJson(readStorage("naia-camera-v20"));
	if (isRecord(camera)) next[UI_PREFERENCE_KEYS.avatarCamera] = camera;

	const nvaPan = parseJson(readStorage("naia-nva-pan-v1"));
	if (isRecord(nvaPan)) next[UI_PREFERENCE_KEYS.nvaPan] = nvaPan;

	const appHeightRaw = readStorage("yt-app-height");
	const appHeight = Number(appHeightRaw);
	if (appHeightRaw !== null && Number.isFinite(appHeight))
		next[UI_PREFERENCE_KEYS.youtubeAppHeight] = appHeight;

	const browserPerms = parseJson(readStorage("browser-tool-perms"));
	if (isRecord(browserPerms))
		next[UI_PREFERENCE_KEYS.browserToolPerms] = browserPerms;

	const toolbarCollapsed = readStorage("browser-toolbar-collapsed");
	if (toolbarCollapsed === "1" || toolbarCollapsed === "0")
		next[UI_PREFERENCE_KEYS.browserToolbarCollapsed] = toolbarCollapsed === "1";

	const editorZoomRaw = readStorage("workspace-editor-zoom");
	const editorZoom = Number(editorZoomRaw);
	if (editorZoomRaw !== null && Number.isFinite(editorZoom))
		next[UI_PREFERENCE_KEYS.editorZoom] = editorZoom;

	const classifiedDirs = parseJson(readStorage("workspace-classified-dirs"));
	if (Array.isArray(classifiedDirs))
		next[UI_PREFERENCE_KEYS.classifiedDirs] = classifiedDirs;

	const readAnnouncementIds = parseJson(readStorage("naia_read_announcements"));
	if (Array.isArray(readAnnouncementIds))
		next[UI_PREFERENCE_KEYS.readAnnouncementIds] = readAnnouncementIds;

	const updatePromptSnooze = parseJson(
		readStorage(UPDATE_PROMPT_SNOOZE_LEGACY_KEY),
	);
	if (isUpdatePromptSnooze(updatePromptSnooze))
		next[UI_PREFERENCE_KEYS.updatePromptSnooze] = updatePromptSnooze;

	return next;
}

function clearLegacyPreferences(): void {
	for (const key of [
		"naia-chat-mode-v1",
		"naia-ws-rail-collapsed",
		"naia-camera-v20",
		"naia-nva-pan-v1",
		"yt-app-height",
		"browser-tool-perms",
		"browser-toolbar-collapsed",
		"workspace-editor-zoom",
		"workspace-classified-dirs",
		"naia_read_announcements",
		UPDATE_PROMPT_SNOOZE_LEGACY_KEY,
	])
		removeStorage(key);
}

const listeners = new Set<() => void>();
let snapshot: UiPreferences = Object.freeze({});
let hydrated = false;
let writesEnabled = false;
let activeAdkPath: string | null = null;

function publish(next: UiPreferences): void {
	snapshot = Object.freeze({ ...next });
	for (const listener of listeners) listener();
}

function persistRenderCache(next: UiPreferences): void {
	const current = loadConfig();
	if (!current) return;
	try {
		saveConfig({ ...current, uiPreferences: next });
	} catch {
		/* The ADK file remains the persistence authority. */
	}
}

function enqueueWrite(path: string, next: UiPreferences): Promise<boolean> {
	// Bind approval and target path at request time. The ADK store owns the shared
	// write queue, so a second local queue would let a workspace switch invalidate
	// an already-approved request before it reaches the native writer.
	const approved = writesEnabled && activeAdkPath === path;
	return approved
		? writeNaiaUiConfig({ uiPreferences: next }, path)
		: Promise.resolve(false);
}

export interface HydrateUiPreferencesOptions {
	/** A successful config read means it is safe to open the file write gate. */
	canPersist?: boolean;
	/** The path selected by the shell, used to bind legacy migration to one ADK. */
	adkPath?: string | null;
}

export interface HydrateUiPreferencesResult {
	migrated: boolean;
	persisted: boolean;
}

/**
 * Replace the render cache from the selected ADK and perform the legacy
 * localStorage migration at most once for that ADK.  A path-specific owner
 * marker prevents a failed migration from leaking the legacy cache into a
 * different ADK later.
 */
export async function hydrateUiPreferences(
	uiConfig: Record<string, unknown> | null,
	options: HydrateUiPreferencesOptions = {},
): Promise<HydrateUiPreferencesResult> {
	const path = normalizeAdkPath(options.adkPath ?? getAdkPath());
	const persisted = isRecord(uiConfig?.uiPreferences)
		? { ...uiConfig.uiPreferences }
		: null;
	const owner = normalizeAdkPath(readStorage(LEGACY_OWNER_KEY));
	const canPersist = Boolean(options.canPersist && path);
	let next = persisted ?? {};
	let migrated = false;

	if (persisted) {
		// A real ADK value is authoritative, even when it is an empty object.
		if (path) writeStorage(LEGACY_OWNER_KEY, path);
		clearLegacyPreferences();
	} else if (path && (!owner || owner === path)) {
		const legacy = readLegacyPreferences();
		if (Object.keys(legacy).length > 0) {
			next = legacy;
			migrated = true;
			// Claim the legacy cache before writing. If the write fails, the same
			// ADK may retry, while another ADK can never adopt these values.
			writeStorage(LEGACY_OWNER_KEY, path);
		}
	} else if (!path && !owner) {
		// The app may render before an ADK is selected. Preserve legacy runtime
		// values, but leave the write gate closed so this is never a success claim.
		next = readLegacyPreferences();
	}

	activeAdkPath = path;
	writesEnabled = canPersist;
	hydrated = true;
	publish(next);
	persistRenderCache(next);

	if (!migrated || !canPersist || !path) return { migrated, persisted: false };

	const persistedToAdk = await enqueueWrite(path, next);
	if (persistedToAdk) clearLegacyPreferences();
	return { migrated, persisted: persistedToAdk };
}

export function getUiPreferencesSnapshot(): UiPreferences {
	return snapshot;
}

export function subscribeUiPreferences(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function useUiPreferencesSnapshot(): UiPreferences {
	return useSyncExternalStore(
		subscribeUiPreferences,
		getUiPreferencesSnapshot,
		getUiPreferencesSnapshot,
	);
}

export function getUiPreference<T>(key: string, fallback: T): T {
	if (Object.prototype.hasOwnProperty.call(snapshot, key))
		return snapshot[key] as T;
	if (hydrated) return fallback;
	const legacy = readLegacyPreferences();
	return Object.prototype.hasOwnProperty.call(legacy, key)
		? (legacy[key] as T)
		: fallback;
}

export function useUiPreference<T>(key: string, fallback: T): T {
	const current = useUiPreferencesSnapshot();
	return Object.prototype.hasOwnProperty.call(current, key)
		? (current[key] as T)
		: fallback;
}

/** Merge and persist a preference patch when the ADK write gate is open. */
export function patchUiPreferences(
	patch: Record<string, unknown | undefined>,
): Promise<boolean> {
	const next = { ...snapshot };
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) delete next[key];
		else next[key] = value;
	}
	publish(next);
	persistRenderCache(next);
	if (!hydrated || !writesEnabled || !activeAdkPath)
		return Promise.resolve(false);
	return enqueueWrite(activeAdkPath, next);
}

/** Test-only reset; it also prevents one browser profile leaking into another test. */
export function resetUiPreferencesForTests(): void {
	snapshot = Object.freeze({});
	hydrated = false;
	writesEnabled = false;
	activeAdkPath = null;
	listeners.clear();
}
