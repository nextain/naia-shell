import { invoke } from "@tauri-apps/api/core";
import { createGenericInstalledApp } from "../apps/generic-installed/GenericInstalledApp";
import { useAppStore } from "../stores/app";
import { Logger } from "./logger";
import { appRegistry } from "./app-registry";
import type { NaiaTool } from "./app-registry";

interface InstalledAppManifest {
	id: string;
	name: string;
	description?: string;
	icon?: string;
	/** Inline SVG content loaded from iconUrl by Rust app_list_installed */
	iconSvg?: string;
	names?: Record<string, string>;
	version?: string;
	/** Tools the panel exposes to Naia (declared in app.json). */
	tools?: NaiaTool[];
	/** Absolute path to index.html if present */
	htmlEntry?: string;
}

/**
 * Read manifests from ~/.naia/apps/ via Tauri command and register each
 * as a GenericInstalledApp. Bumps appListVersion so AppBar re-renders.
 *
 * Skips panels already registered (e.g. built-ins or re-loaded after restart).
 */
export async function loadInstalledApps(): Promise<void> {
	let manifests: InstalledAppManifest[];
	try {
		Logger.debug("AppLoader", "Invoking app_list_installed");
		manifests = await invoke<InstalledAppManifest[]>("app_list_installed");
	} catch (err) {
		Logger.warn("AppLoader", "Failed to load installed panels", {
			err: String(err),
		});
		return;
	}

	Logger.info("AppLoader", `Found ${manifests.length} installed panel(s)`);

	for (const manifest of manifests) {
		if (appRegistry.get(manifest.id)) {
			Logger.debug(
				"AppLoader",
				`Panel already registered, skipping: ${manifest.id}`,
			);
			continue;
		}

		appRegistry.register({
			id: manifest.id,
			name: manifest.name,
			names: manifest.names,
			icon: manifest.icon,
			iconSvg: manifest.iconSvg,
			htmlEntry: manifest.htmlEntry,
			tools: manifest.tools,
			source: "installed",
			center: createGenericInstalledApp(manifest.htmlEntry, manifest.tools),
		});

		Logger.info("AppLoader", `Registered installed app: ${manifest.id}`);
	}

	useAppStore.getState().bumpAppListVersion();
}

/**
 * Delete an installed panel from disk (Tauri command) and unregister it.
 * If disk deletion fails, still unregisters from memory so AppBar updates.
 * Bumps appListVersion so AppBar re-renders.
 */
export async function removeInstalledApp(appId: string): Promise<void> {
	Logger.info("AppLoader", `Removing installed app: ${appId}`);

	try {
		await invoke("app_remove_installed", { appId });
		Logger.debug("AppLoader", `Disk removal complete: ${appId}`);
	} catch (err) {
		Logger.error("AppLoader", `Disk removal failed: ${appId}`, {
			err: String(err),
		});
		// Fall through — unregister from memory regardless
	}

	appRegistry.unregister(appId);
	useAppStore.getState().bumpAppListVersion();
	Logger.debug("AppLoader", `Panel unregistered: ${appId}`);
}
