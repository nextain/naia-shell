/**
 * Tab skills — common AI tools available to any panel with a viewport.
 *
 * Usage (in a panel center component):
 *
 *   const tabTools = useTabSkills(viewportRef, naia);
 *   // In panel's index.tsx tools array, spread TAB_SKILL_DESCRIPTORS.
 *
 * The hook registers tool call handlers.
 * TAB_SKILL_DESCRIPTORS must be included in the panel's static `tools` list
 * so the Agent knows the tools exist.
 *
 * Adding new common skills: define the descriptor here, add a handler
 * in useTabSkills, and spread TAB_SKILL_DESCRIPTORS in the panel's index.tsx.
 */

import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";
import type { RefObject } from "react";
import { addAllowedTool } from "./config";
import type { NaiaContextBridge, NaiaTool } from "./panel-registry";

// ─── Descriptors (static, sent to Agent) ─────────────────────────────────────

/** Screenshot the panel's native viewport area (screen-level capture). */
export const SKILL_TAB_SCREENSHOT: NaiaTool = {
	name: "skill_tab_screenshot",
	description:
		"Take a screenshot of the current panel viewport area by capturing the screen region directly. Returns a base64 PNG image that you can visually analyze.",
	parameters: { type: "object", properties: {} },
	tier: 0,
};

/**
 * All tab skill descriptors.
 * Spread this into a panel's `tools` array in index.tsx:
 *
 *   tools: [...TAB_SKILL_DESCRIPTORS, ...panelSpecificTools]
 */
export const TAB_SKILL_DESCRIPTORS: NaiaTool[] = [SKILL_TAB_SCREENSHOT];

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Register common tab skill handlers for a panel.
 *
 * @param viewportRef - ref to the panel's main content/viewport div.
 *   `getBoundingClientRect()` on this element is used to determine the
 *   capture region in CSS logical pixels.
 * @param naia - the panel's NaiaContextBridge instance.
 */
export function useTabSkills(
	viewportRef: RefObject<HTMLElement | null>,
	naia: NaiaContextBridge,
): void {
	useEffect(() => {
		// Auto-allow tab skills (no per-tool confirmation needed)
		addAllowedTool("skill_tab_screenshot");

		const unsub = naia.onToolCall("skill_tab_screenshot", async () => {
			const el = viewportRef.current;
			if (!el) return "Error: panel viewport not available";

			const rect = el.getBoundingClientRect();
			if (rect.width <= 0 || rect.height <= 0) {
				return "Error: panel viewport has zero size";
			}

			try {
				// Returns data:image/png;base64,... — agent sends as vision image block
				return await invoke<string>("capture_screen_region", {
					x: rect.left,
					y: rect.top,
					width: rect.width,
					height: rect.height,
				});
			} catch (e) {
				return `Screenshot failed: ${String(e)}`;
			}
		});

		return unsub;
	}, [viewportRef, naia]);
}
