import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { AppContext } from "../lib/app-registry";

function requestBrowserVisibilitySync() {
	window.dispatchEvent(new Event("naia-browser-visibility-sync"));
}

/**
 * Context types that persist across app switches. These belong to always-on
 * UI (the app-bar BGM player) rather than a switchable app, so they must NOT
 * be cleared when the active app changes, and they live in a separate keyed
 * bucket so a transient app push can never overwrite them. See
 * `selectPromptAppContexts` for how they are merged into the system prompt.
 */
const PERSISTENT_CONTEXT_TYPES = new Set<string>(["bgm"]);

interface AppState {
	/** Currently active app id. null = default avatar view. */
	activeApp: string | null;
	setActiveApp: (id: string | null) => void;
	/** Latest context pushed by the active (switchable) app. Cleared on switch. */
	activeAppContext: AppContext | null;
	/**
	 * Persistent contexts keyed by type (e.g. "bgm"). Survive app switches and
	 * are never overwritten by transient app pushes.
	 */
	persistentAppContexts: Record<string, AppContext>;
	/**
	 * Route a pushed context: persistent types (bgm) go to the keyed bucket,
	 * everything else replaces the single active-app slot. Passing null clears
	 * only the active slot (persistent contexts are unaffected).
	 */
	setActiveAppContext: (ctx: AppContext | null) => void;
	/**
	 * Incremented whenever apps are installed or removed at runtime.
	 * AppBar and other consumers subscribe to rebuild their app list.
	 */
	appListVersion: number;
	bumpAppListVersion: () => void;
	/**
	 * Number of currently open HTML modals.
	 * When > 0, the browser webview is hidden to prevent it from overlapping.
	 */
	modalCount: number;
	pushModal: () => void;
	popModal: () => void;
	/** AI interference toggle: if true, AI can react to OS events. */
	aiInterferenceEnabled: boolean;
	setAiInterferenceEnabled: (enabled: boolean) => void;
	toggleAiInterferenceEnabled: () => void;
	/** TTS (text-to-speech) enabled toggle — persisted to config on change. */
	ttsEnabled: boolean;
	setTtsEnabled: (enabled: boolean) => void;
	toggleTtsEnabled: () => void;
	/**
	 * Requested settings tab (e.g. "profile", "brain", "voice").
	 * Read and consumed by SettingsTab on mount or change.
	 */
	requestedSettingsTab: string | null;
	setRequestedSettingsTab: (tab: string | null) => void;
}

export const VALID_SETTINGS_TABS = new Set<string>([
	"profile",
	"brain",
	"voice",
	"avatar",
	"persona",
	"memory",
	"knowledge",
	"skills",
	"general",
]);

/**
 * Normalizes requested settings tab:
 * "ai" -> "brain", valid tab IDs are kept, unlisted IDs return null.
 */
export function normalizeSettingsTab(tab: unknown): string | null {
	if (typeof tab !== "string") return null;
	const trimmed = tab.trim().toLowerCase();
	if (trimmed === "ai") return "brain";
	if (VALID_SETTINGS_TABS.has(trimmed)) return trimmed;
	return null;
}

/**
 * Navigates to Settings app and requests a specific settings tab.
 * Smoothly scrolls to steam-link-btn if in profile tab.
 */
export function navigateToSettings(tab: string = "profile"): void {
	const normalized = normalizeSettingsTab(tab) ?? "profile";
	useAppStore.getState().setRequestedSettingsTab(normalized);
	useAppStore.getState().setActiveApp("settings");
	if (typeof window !== "undefined") {
		requestAnimationFrame(() => {
			const btn = document.querySelector('[data-testid="steam-link-btn"]');
			btn?.scrollIntoView({ behavior: "smooth", block: "center" });
		});
	}
}

// Global listener for naia-open-settings events (#729 지적 4)
if (typeof window !== "undefined") {
	window.addEventListener("naia-open-settings", (e: Event) => {
		const rawTab = (e as CustomEvent<{ tab?: string }>)?.detail?.tab;
		const normalized = normalizeSettingsTab(rawTab);
		if (normalized) {
			useAppStore.getState().setRequestedSettingsTab(normalized);
			useAppStore.getState().setActiveApp("settings");
		}
	});
}

export const useAppStore = create<AppState>((set, get) => ({
	activeApp: null,
	setActiveApp: (id) => {
		const current = get().activeApp;
		if (current === "browser" && id !== "browser") {
			invoke("browser_wv_hide").catch(() => {});
		}
		// Clear only the transient active-app slot; persistent contexts (bgm)
		// must survive the switch so background music favorites stay available.
		set({ activeApp: id, activeAppContext: null });
		if (id === "browser" && current !== "browser") {
			requestBrowserVisibilitySync();
		}
	},
	activeAppContext: null,
	persistentAppContexts: {},
	setActiveAppContext: (ctx) => {
		if (ctx && PERSISTENT_CONTEXT_TYPES.has(ctx.type)) {
			set((s) => ({
				persistentAppContexts: {
					...s.persistentAppContexts,
					[ctx.type]: ctx,
				},
			}));
			return;
		}
		set({ activeAppContext: ctx });
	},
	appListVersion: 0,
	bumpAppListVersion: () =>
		set((s) => ({ appListVersion: s.appListVersion + 1 })),
	modalCount: 0,
	pushModal: () => {
		const { modalCount } = get();
		if (modalCount === 0) {
			invoke("browser_wv_hide").catch(() => {});
		}
		set((s) => ({ modalCount: s.modalCount + 1 }));
	},
	popModal: () => {
		const next = Math.max(0, get().modalCount - 1);
		set({ modalCount: next });
		if (next === 0 && get().activeApp === "browser") {
			requestBrowserVisibilitySync();
		}
	},
	aiInterferenceEnabled: false,
	setAiInterferenceEnabled: (enabled) =>
		set({ aiInterferenceEnabled: enabled }),
	toggleAiInterferenceEnabled: () =>
		set((s) => ({ aiInterferenceEnabled: !s.aiInterferenceEnabled })),
	ttsEnabled: false,
	setTtsEnabled: (enabled) => set({ ttsEnabled: enabled }),
	toggleTtsEnabled: () => set((s) => ({ ttsEnabled: !s.ttsEnabled })),
	requestedSettingsTab: null,
	setRequestedSettingsTab: (tab) => set({ requestedSettingsTab: tab }),
}));

/**
 * Contexts to inject into Naia's system prompt: the active (switchable) app
 * plus all persistent contexts (bgm). The active context wins if a persistent
 * type collides, and we skip large/all-app injection — only active +
 * persistent, never every app that has ever pushed.
 */
export function selectPromptAppContexts(state: AppState): AppContext[] {
	const out: AppContext[] = [];
	if (state.activeAppContext) out.push(state.activeAppContext);
	for (const ctx of Object.values(state.persistentAppContexts)) {
		if (ctx && ctx.type !== state.activeAppContext?.type) out.push(ctx);
	}
	return out;
}
