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
	/** Tools the app exposes to Naia (declared in app.json). */
	tools?: NaiaTool[];
	/** Absolute path to index.html if present */
	htmlEntry?: string;
	/**
	 * Keep the app mounted across app switches (default true). An app may set
	 * false in its manifest to be unmounted when it loses focus (e.g. a purely
	 * stateless view where re-render is cheap and a fresh start is preferable).
	 */
	keepAlive?: boolean;
}

/**
 * Read manifests from ~/.naia/apps/ via Tauri command and register each
 * as a GenericInstalledApp. Bumps appListVersion so AppBar re-renders.
 *
 * Skips apps already registered (e.g. built-ins or re-loaded after restart).
 */
/**
 * 설치된 앱 목록을 다 읽었는가.
 *
 * 부팅 지연을 재는 표지가 `data-app-ready` 하나뿐이던 동안, 그것은 설정과
 * 로케일 하이드레이션·아바타까지만 기다렸다. 그래서 이 목록 읽기에 3초를
 * 넣어도 측정값이 움직이지 않았다 — 앱바가 3초 동안 비어 있어도 성능 축은
 * 아무 말을 하지 않았다. 부팅의 이 구간을 측정 안으로 들인다.
 */
let installedAppsSettled = false;
let installedAppsLoadGeneration = 0;
export function areInstalledAppsSettled(): boolean {
	return installedAppsSettled;
}
/** 테스트가 부팅을 다시 재기 위해 되돌린다. */
export function resetInstalledAppsSettled(): void {
	installedAppsSettled = false;
}

/**
 * Drop registrations from the previous ADK before loading a newly selected
 * root. This is intentionally separate from a normal refresh: unchanged
 * installed apps stay mounted during ordinary list calls, while an ADK switch
 * must not leave an old app (or its active context) visible during the async
 * replacement.
 */
export function invalidateInstalledApps(): void {
	const installed = appRegistry
		.list()
		.filter((descriptor) => descriptor.source === "installed");
	if (installed.length === 0) return;

	const activeApp = useAppStore.getState().activeApp;
	for (const descriptor of installed) {
		appRegistry.unregister(descriptor.id);
	}
	if (activeApp && installed.some((descriptor) => descriptor.id === activeApp)) {
		useAppStore.getState().setActiveApp(null);
	}
	useAppStore.getState().bumpAppListVersion();
}

export async function loadInstalledApps(): Promise<void> {
	const loadGeneration = ++installedAppsLoadGeneration;
	let manifests: InstalledAppManifest[];
	try {
		Logger.debug("AppLoader", "Invoking app_list_installed");
		manifests = await invoke<InstalledAppManifest[]>("app_list_installed");
	} catch (err) {
		if (loadGeneration !== installedAppsLoadGeneration) return;
		Logger.warn("AppLoader", "Failed to load installed apps", {
			err: String(err),
		});
		// 실패도 "이 구간이 끝났다" 는 사실이다. 안 세우면 부팅이 영원히
		// 끝나지 않은 것으로 보인다.
		installedAppsSettled = true;
		return;
	}

	// A path switch can start a second list while the first native call is
	// pending. The older result belongs to the previous ADK and must not mutate
	// the registry after the newer request has started.
	if (loadGeneration !== installedAppsLoadGeneration) return;

	Logger.info("AppLoader", `Found ${manifests.length} installed app(s)`);

	// The selected ADK is the source of truth. On an ADK switch, an installed
	// descriptor from the previous root can have the same id but an old
	// htmlEntry. Drop only installed descriptors whose current manifest is gone
	// or points at a different root; built-ins and live unchanged apps remain.
	const currentById = new Map(manifests.map((manifest) => [manifest.id, manifest]));
	for (const registered of appRegistry.list()) {
		if (registered.source !== "installed") continue;
		const current = currentById.get(registered.id);
		if (!current || registered.htmlEntry !== current.htmlEntry) {
			if (useAppStore.getState().activeApp === registered.id) {
				useAppStore.getState().setActiveApp(null);
			}
			appRegistry.unregister(registered.id);
			Logger.debug(
				"AppLoader",
				`Removed stale installed registration: ${registered.id}`,
			);
		}
	}

	for (const manifest of manifests) {
		if (appRegistry.get(manifest.id)) {
			Logger.debug(
				"AppLoader",
				`App already registered, skipping: ${manifest.id}`,
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
			// Keep installed apps mounted across app switches — same treatment as
			// built-ins (browser/workspace/settings). An installed app renders an
			// iframe whose in-page state (e.g. a Slides deck's open PDF) is DOM
			// state: unmounting the slot destroys the iframe and loses it. Hidden
			// keepAlive slots use opacity:0, not unmount, so the iframe survives a
			// round-trip to another app and back. An app may opt out with
			// keepAlive:false in its manifest.
			keepAlive: manifest.keepAlive ?? true,
			center: createGenericInstalledApp(manifest.htmlEntry, manifest.tools),
		});

		Logger.info("AppLoader", `Registered installed app: ${manifest.id}`);
	}

	useAppStore.getState().bumpAppListVersion();
	installedAppsSettled = true;
}

/**
 * Delete an installed app from disk and unregister it only after deletion succeeds.
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
		throw err;
	}

	appRegistry.unregister(appId);
	if (useAppStore.getState().activeApp === appId) {
		useAppStore.getState().setActiveApp(null);
	}
	useAppStore.getState().bumpAppListVersion();
	Logger.debug("AppLoader", `App unregistered: ${appId}`);
}
