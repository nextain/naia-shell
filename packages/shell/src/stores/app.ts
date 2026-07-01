import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { AppContext } from "../lib/app-registry";

function requestBrowserVisibilitySync() {
	window.dispatchEvent(new Event("naia-browser-visibility-sync"));
}

/**
 * Context types that persist across panel switches. These belong to always-on
 * UI (the app-bar BGM player) rather than a switchable panel, so they must NOT
 * be cleared when the active panel changes, and they live in a separate keyed
 * bucket so a transient panel push can never overwrite them. See
 * `selectPromptAppContexts` for how they are merged into the system prompt.
 */
const PERSISTENT_CONTEXT_TYPES = new Set<string>(["bgm"]);

interface AppState {
	/** Currently active app id. null = default avatar view. */
	activeApp: string | null;
	setActiveApp: (id: string | null) => void;
	/** Latest context pushed by the active (switchable) panel. Cleared on switch. */
	activeAppContext: AppContext | null;
	/**
	 * Persistent contexts keyed by type (e.g. "bgm"). Survive panel switches and
	 * are never overwritten by transient panel pushes.
	 */
	persistentAppContexts: Record<string, AppContext>;
	/**
	 * Route a pushed context: persistent types (bgm) go to the keyed bucket,
	 * everything else replaces the single active-panel slot. Passing null clears
	 * only the active slot (persistent contexts are unaffected).
	 */
	setActiveAppContext: (ctx: AppContext | null) => void;
	/**
	 * Incremented whenever panels are installed or removed at runtime.
	 * AppBar and other consumers subscribe to rebuild their panel list.
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
}

export const useAppStore = create<AppState>((set, get) => ({
	activeApp: null,
	setActiveApp: (id) => {
		const current = get().activeApp;
		if (current === "browser" && id !== "browser") {
			invoke("browser_wv_hide").catch(() => {});
		}
		// Clear only the transient active-panel slot; persistent contexts (bgm)
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
}));

/**
 * Contexts to inject into Naia's system prompt: the active (switchable) panel
 * plus all persistent contexts (bgm). The active context wins if a persistent
 * type collides, and we skip large/all-panel injection — only active +
 * persistent, never every panel that has ever pushed.
 */
export function selectPromptAppContexts(state: AppState): AppContext[] {
	const out: AppContext[] = [];
	if (state.activeAppContext) out.push(state.activeAppContext);
	for (const ctx of Object.values(state.persistentAppContexts)) {
		if (ctx && ctx.type !== state.activeAppContext?.type) out.push(ctx);
	}
	return out;
}
