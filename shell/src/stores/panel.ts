import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { PanelContext } from "../lib/panel-registry";

interface PanelState {
	/** Currently active panel id. null = default avatar view. */
	activePanel: string | null;
	setActivePanel: (id: string | null) => void;
	/** Latest context pushed by the active panel (for Naia's system prompt). */
	activePanelContext: PanelContext | null;
	setActivePanelContext: (ctx: PanelContext | null) => void;
	/**
	 * Incremented whenever panels are installed or removed at runtime.
	 * ModeBar and other consumers subscribe to rebuild their panel list.
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
}

export const usePanelStore = create<PanelState>((set, get) => ({
	activePanel: null,
	setActivePanel: (id) => {
		const current = get().activePanel;
		if (current === "browser" && id !== "browser") {
			invoke("browser_wv_hide").catch(() => {});
		} else if (id === "browser" && current !== "browser") {
			invoke("browser_wv_show").catch(() => {});
		}
		set({ activePanel: id, activePanelContext: null });
	},
	activePanelContext: null,
	setActivePanelContext: (ctx) => set({ activePanelContext: ctx }),
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
			invoke("browser_wv_show").catch(() => {});
		}
	},
	aiInterferenceEnabled: false,
	setAiInterferenceEnabled: (enabled) =>
		set({ aiInterferenceEnabled: enabled }),
	toggleAiInterferenceEnabled: () =>
		set((s) => ({ aiInterferenceEnabled: !s.aiInterferenceEnabled })),
}));
