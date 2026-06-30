import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { PanelContext } from "../lib/panel-registry";

function requestBrowserVisibilitySync() {
	window.dispatchEvent(new Event("naia-browser-visibility-sync"));
}

/**
 * Context types that persist across panel switches. These belong to always-on
 * UI (the app-bar BGM player) rather than a switchable panel, so they must NOT
 * be cleared when the active panel changes, and they live in a separate keyed
 * bucket so a transient panel push can never overwrite them. See
 * `selectPromptPanelContexts` for how they are merged into the system prompt.
 */
const PERSISTENT_CONTEXT_TYPES = new Set<string>(["bgm"]);

interface PanelState {
	/** Currently active panel id. null = default avatar view. */
	activePanel: string | null;
	setActivePanel: (id: string | null) => void;
	/** Latest context pushed by the active (switchable) panel. Cleared on switch. */
	activePanelContext: PanelContext | null;
	/**
	 * Persistent contexts keyed by type (e.g. "bgm"). Survive panel switches and
	 * are never overwritten by transient panel pushes.
	 */
	persistentPanelContexts: Record<string, PanelContext>;
	/**
	 * Route a pushed context: persistent types (bgm) go to the keyed bucket,
	 * everything else replaces the single active-panel slot. Passing null clears
	 * only the active slot (persistent contexts are unaffected).
	 */
	setActivePanelContext: (ctx: PanelContext | null) => void;
	/**
	 * Incremented whenever panels are installed or removed at runtime.
	 * AppBar and other consumers subscribe to rebuild their panel list.
	 */
	panelListVersion: number;
	bumpPanelListVersion: () => void;
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

export const usePanelStore = create<PanelState>((set, get) => ({
	activePanel: null,
	setActivePanel: (id) => {
		const current = get().activePanel;
		if (current === "browser" && id !== "browser") {
			invoke("browser_wv_hide").catch(() => {});
		}
		// Clear only the transient active-panel slot; persistent contexts (bgm)
		// must survive the switch so background music favorites stay available.
		set({ activePanel: id, activePanelContext: null });
		if (id === "browser" && current !== "browser") {
			requestBrowserVisibilitySync();
		}
	},
	activePanelContext: null,
	persistentPanelContexts: {},
	setActivePanelContext: (ctx) => {
		if (ctx && PERSISTENT_CONTEXT_TYPES.has(ctx.type)) {
			set((s) => ({
				persistentPanelContexts: {
					...s.persistentPanelContexts,
					[ctx.type]: ctx,
				},
			}));
			return;
		}
		set({ activePanelContext: ctx });
	},
	panelListVersion: 0,
	bumpPanelListVersion: () =>
		set((s) => ({ panelListVersion: s.panelListVersion + 1 })),
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
		if (next === 0 && get().activePanel === "browser") {
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
export function selectPromptPanelContexts(state: PanelState): PanelContext[] {
	const out: PanelContext[] = [];
	if (state.activePanelContext) out.push(state.activePanelContext);
	for (const ctx of Object.values(state.persistentPanelContexts)) {
		if (ctx && ctx.type !== state.activePanelContext?.type) out.push(ctx);
	}
	return out;
}
