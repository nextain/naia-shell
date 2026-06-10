import { invoke } from "@tauri-apps/api/core";
import { createGenericInstalledPanel } from "../panels/generic-installed/GenericInstalledPanel";
import { usePanelStore } from "../stores/panel";
import { Logger } from "./logger";
import { panelRegistry } from "./panel-registry";

interface InstalledPanelManifest {
	id: string;
	name: string;
	description?: string;
	icon?: string;
	/** Inline SVG content loaded from iconUrl by Rust panel_list_installed */
	iconSvg?: string;
	names?: Record<string, string>;
	version?: string;
	/** Absolute path to index.html if present */
	htmlEntry?: string;
}

/**
 * Read manifests from ~/.naia/panels/ via Tauri command and register each
 * as a GenericInstalledPanel. Bumps panelListVersion so ModeBar re-renders.
 *
 * Skips panels already registered (e.g. built-ins or re-loaded after restart).
 */
export async function loadInstalledPanels(): Promise<void> {
	let manifests: InstalledPanelManifest[];
	try {
		Logger.debug("PanelLoader", "Invoking panel_list_installed");
		manifests = await invoke<InstalledPanelManifest[]>("panel_list_installed");
	} catch (err) {
		Logger.warn("PanelLoader", "Failed to load installed panels", {
			err: String(err),
		});
		return;
	}

	Logger.info("PanelLoader", `Found ${manifests.length} installed panel(s)`);

	for (const manifest of manifests) {
		if (panelRegistry.get(manifest.id)) {
			Logger.debug(
				"PanelLoader",
				`Panel already registered, skipping: ${manifest.id}`,
			);
			continue;
		}

		panelRegistry.register({
			id: manifest.id,
			name: manifest.name,
			names: manifest.names,
			icon: manifest.icon,
			iconSvg: manifest.iconSvg,
			htmlEntry: manifest.htmlEntry,
			source: "installed",
			center: createGenericInstalledPanel(manifest.htmlEntry),
		});

		Logger.info("PanelLoader", `Registered installed panel: ${manifest.id}`);
	}

	usePanelStore.getState().bumpPanelListVersion();
}

/**
 * Delete an installed panel from disk (Tauri command) and unregister it.
 * If disk deletion fails, still unregisters from memory so ModeBar updates.
 * Bumps panelListVersion so ModeBar re-renders.
 */
export async function removeInstalledPanel(panelId: string): Promise<void> {
	Logger.info("PanelLoader", `Removing installed panel: ${panelId}`);

	try {
		await invoke("panel_remove_installed", { panelId });
		Logger.debug("PanelLoader", `Disk removal complete: ${panelId}`);
	} catch (err) {
		Logger.error("PanelLoader", `Disk removal failed: ${panelId}`, {
			err: String(err),
		});
		// Fall through — unregister from memory regardless
	}

	panelRegistry.unregister(panelId);
	usePanelStore.getState().bumpPanelListVersion();
	Logger.debug("PanelLoader", `Panel unregistered: ${panelId}`);
}
