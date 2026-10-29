import { invoke } from "@tauri-apps/api/core";
import { createGenericInstalledApp } from "../apps/generic-installed/GenericInstalledApp";
import { useAppStore } from "../stores/app";
import { appRegistry } from "./app-registry";
import type { AppDataUseSpec, AppSkillSpec, NaiaTool } from "./app-registry";
import { Logger } from "./logger";
import { hasStoreEntitlement } from "./app-store-client";
import {
	LEGACY_APP_TOOL_KEEP_LIST,
	SHELL_RESERVED_TOOL_NAMES,
} from "./model-facing-tools";

export interface InstalledAppManifest {
	id: string;
	name: string;
	description?: string;
	icon?: string;
	/** Inline SVG content loaded from iconUrl by Rust app_list_installed */
	iconSvg?: string;
	names?: Record<string, string>;
	descriptions?: Record<string, string>;
	version?: string;
	manifest_version?: number;
	manifestVersion?: number;
	context?: string;
	skills?: AppSkillSpec[];
	permissions?: string[];
	host_permissions?: string[];
	hostPermissions?: string[];
	optional_permissions?: string[];
	optionalPermissions?: string[];
	requires?: string[];
	help?: Record<string, string>;
	data_use?: AppDataUseSpec;
	dataUse?: AppDataUseSpec;
	publisher?: string;
	/** Tools the app exposes to Naia (declared in app.json). */
	tools?: NaiaTool[];
	/** True only when the Rust installer verifies its persisted Store signature receipt. */
	store_signature_verified?: boolean;
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
 * Preserves built-ins and refreshes installed descriptors from each Rust list.
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
const ENTITLEMENT_CACHE_MS = 10 * 60 * 1000;
const ENTITLEMENT_CHECK_TIMEOUT_MS = 2_000;
const entitlementCache = new Map<
	string,
	{ value: boolean; checkedAt: number }
>();
const STORE_SIGNATURE_RECHECK_MS = 60_000;
const storeSignatureCheckedAt = new Map<string, number>();

/** Verify cached Store trust against current Rust filesystem state before dispatch. */
export async function ensureStoreAppVerificationFresh(
	appId: string,
): Promise<boolean> {
	const lastChecked = storeSignatureCheckedAt.get(appId) ?? 0;
	if (Date.now() - lastChecked < STORE_SIGNATURE_RECHECK_MS) {
		return appRegistry.get(appId)?.storeSignatureVerified === true;
	}
	try {
		const verified = await invoke<boolean>("app_verify_installed_store_app", {
			appId,
		});
		storeSignatureCheckedAt.set(appId, Date.now());
		if (!verified) {
			appRegistry.updateStoreSignatureVerified(appId, false);
		}
		return verified;
	} catch (err) {
		Logger.warn("AppLoader", "Store app execution recheck failed", {
			appId,
			error: String(err),
		});
		return false;
	}
}
export function areInstalledAppsSettled(): boolean {
	return installedAppsSettled;
}
/** 테스트가 부팅을 다시 재기 위해 되돌린다. */
export function resetInstalledAppsSettled(): void {
	installedAppsSettled = false;
}

async function recheckStoreEntitlement(
	manifest: InstalledAppManifest,
): Promise<boolean> {
	if (manifest.store_signature_verified !== true) return false;
	const cached = entitlementCache.get(manifest.id);
	if (cached && Date.now() - cached.checkedAt < ENTITLEMENT_CACHE_MS) {
		return cached.value;
	}
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	try {
		const timeout = new Promise<never>((_, reject) => {
			timeoutHandle = setTimeout(
				() => reject(new Error("Entitlement check timed out")),
				ENTITLEMENT_CHECK_TIMEOUT_MS,
			);
		});
		const entitled = await Promise.race([
			hasStoreEntitlement(manifest.id),
			timeout,
		]);
		entitlementCache.set(manifest.id, { value: entitled, checkedAt: Date.now() });
		if (!entitled) {
			Logger.warn("AppLoader", "Store entitlement missing; trust revoked", {
				appId: manifest.id,
			});
		}
		return entitled;
	} catch (err) {
		// A gateway/network failure is not a revocation. Preserve the last local
		// receipt decision and retry at the next list refresh.
		Logger.debug(
			"AppLoader",
			"Store entitlement check unavailable; keeping receipt status",
			{ appId: manifest.id, error: String(err) },
		);
		return cached?.value ?? true;
	} finally {
		if (timeoutHandle) clearTimeout(timeoutHandle);
	}
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
		storeSignatureCheckedAt.delete(descriptor.id);
		appRegistry.unregister(descriptor.id);
	}
	if (
		activeApp &&
		installed.some((descriptor) => descriptor.id === activeApp)
	) {
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
	const listedIds = new Set(manifests.map((manifest) => manifest.id));
	for (const appId of entitlementCache.keys()) {
		if (!listedIds.has(appId)) entitlementCache.delete(appId);
	}
	for (const appId of storeSignatureCheckedAt.keys()) {
		if (!listedIds.has(appId)) storeSignatureCheckedAt.delete(appId);
	}
	const entitlementResults = await Promise.all(
		manifests.map(
			async (manifest) =>
				[manifest.id, await recheckStoreEntitlement(manifest)] as const,
		),
	);
	if (loadGeneration !== installedAppsLoadGeneration) return;
	const entitledById = new Map(entitlementResults);
	for (const manifest of manifests) {
		if (
			manifest.store_signature_verified === true &&
			!entitledById.get(manifest.id)
		) {
			manifest.store_signature_verified = false;
		}
		if (manifest.store_signature_verified === true) {
			storeSignatureCheckedAt.set(manifest.id, Date.now());
		} else {
			storeSignatureCheckedAt.delete(manifest.id);
		}
	}

	Logger.info("AppLoader", `Found ${manifests.length} installed app(s)`);
	const builtInToolNames = SHELL_RESERVED_TOOL_NAMES;
	const legacyAppToolNames = new Set<string>(LEGACY_APP_TOOL_KEEP_LIST);
	const declaredToolOwners = new Map<string, string[]>();
	for (const manifest of manifests) {
		if (manifest.store_signature_verified !== true) continue;
		for (const tool of manifest.tools ?? []) {
			const owners = declaredToolOwners.get(tool.name) ?? [];
			owners.push(manifest.id);
			declaredToolOwners.set(tool.name, owners);
		}
	}

	// The selected ADK is the source of truth. On an ADK switch, an installed
	// descriptor from the previous root can have the same id but an old
	// htmlEntry. Drop only installed descriptors whose current manifest is gone
	// or points at a different root; built-ins and live unchanged apps remain.
	const currentById = new Map(
		manifests.map((manifest) => [manifest.id, manifest]),
	);
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
		const manifestVersion =
			manifest.manifest_version ?? manifest.manifestVersion;
		const profile: "legacy" | "v2" =
			manifestVersion != null && manifestVersion >= 2 ? "v2" : "legacy";
		const hostPermissions =
			manifest.host_permissions ?? manifest.hostPermissions;
		const optionalPermissions =
			manifest.optional_permissions ?? manifest.optionalPermissions;
		const dataUse = manifest.data_use ?? manifest.dataUse;
		const storeSignatureVerified = manifest.store_signature_verified === true;
		let appTools = manifest.tools;
		if (
			!storeSignatureVerified &&
			appTools?.some((tool) => legacyAppToolNames.has(tool.name))
		) {
			Logger.warn(
				"AppLoader",
				"Rejected unsigned legacy app tool declaration",
				{
					appId: manifest.id,
					tools: appTools
						.filter((tool) => legacyAppToolNames.has(tool.name))
						.map((tool) => tool.name),
				},
			);
			appTools = appTools.filter((tool) => !legacyAppToolNames.has(tool.name));
		}
		if (storeSignatureVerified && appTools) {
			appTools = appTools.filter((tool) => {
				const owners = declaredToolOwners.get(tool.name) ?? [];
				const legacyCompat = legacyAppToolNames.has(tool.name);
				const rejection = !tool.name.startsWith("skill_")
					? "tool name must start with skill_"
					: builtInToolNames.has(tool.name) && !legacyCompat
						? "tool name conflicts with a Shell built-in"
						: owners.some((ownerId) => ownerId !== manifest.id)
							? "tool name is declared by another installed app"
							: null;
				if (rejection) {
					Logger.warn("AppLoader", "Rejected Store app tool declaration", {
						appId: manifest.id,
						tool: tool.name,
						reason: rejection,
					});
					return false;
				}
				return true;
			});
		}

		const previous = appRegistry.get(manifest.id);
		if (previous && previous.source !== "installed") {
			Logger.debug(
				"AppLoader",
				`App already registered, skipping: ${manifest.id}`,
			);
			continue;
		}
		if (previous?.source === "installed") {
			if (
				previous.storeSignatureVerified === storeSignatureVerified &&
				JSON.stringify(previous.tools ?? []) === JSON.stringify(appTools ?? [])
			) {
				continue;
			}
			// A fresh Rust list is authoritative for both the signed manifest and
			// its filtered tool set. Replace the descriptor so revocations and
			// manifest edits take effect without restarting the shell.
			appRegistry.unregister(manifest.id);
			Logger.debug("AppLoader", `Refreshing installed app: ${manifest.id}`);
		}

		appRegistry.register({
			id: manifest.id,
			name: manifest.name,
			names: manifest.names,
			descriptions: manifest.descriptions,
			icon: manifest.icon,
			iconSvg: manifest.iconSvg,
			htmlEntry: manifest.htmlEntry,
			manifestVersion,
			profile,
			context: manifest.context,
			skills: manifest.skills,
			permissions: manifest.permissions,
			hostPermissions,
			optionalPermissions,
			requires: manifest.requires,
			help: manifest.help,
			dataUse,
			publisher: manifest.publisher,
			tools: appTools,
			source: "installed",
			storeSignatureVerified,
			// Keep installed apps mounted across app switches — same treatment as
			// built-ins (browser/workspace/settings). An installed app renders an
			// iframe whose in-page state (e.g. a Slides deck's open PDF) is DOM
			// state: unmounting the slot destroys the iframe and loses it. Hidden
			// keepAlive slots use opacity:0, not unmount, so the iframe survives a
			// round-trip to another app and back. An app may opt out with
			// keepAlive:false in its manifest.
			keepAlive: manifest.keepAlive ?? true,
			center: createGenericInstalledApp(manifest.htmlEntry, appTools),
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

	// Prevent a list request that started before disk deletion from resurrecting
	// the app (and its model-facing tools) when its response arrives late.
	installedAppsLoadGeneration += 1;
	entitlementCache.delete(appId);
	storeSignatureCheckedAt.delete(appId);
	appRegistry.unregister(appId);
	if (useAppStore.getState().activeApp === appId) {
		useAppStore.getState().setActiveApp(null);
	}
	useAppStore.getState().bumpAppListVersion();
	Logger.debug("AppLoader", `App unregistered: ${appId}`);
}
