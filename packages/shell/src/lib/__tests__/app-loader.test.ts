import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../stores/app";
import {
	ensureStoreAppVerificationFresh,
	invalidateInstalledApps,
	loadInstalledApps,
	removeInstalledApp,
} from "../app-loader";
import {
	ActiveAppBridge,
	appRegistry,
	resolveAppToolTargetOrigin,
	validateAppToolArgs,
	validateAppToolParameters,
} from "../app-registry";
import { Logger } from "../logger";
import {
	isModelFacingToolAllowed,
	makeModelToolBoundary,
} from "../model-facing-tools";

// Mock Tauri invoke
const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
	invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock("../logger", () => ({
	Logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

const FakeCenterapp = () => null;

describe("app-loader", () => {
	let appsSnapshot: ReturnType<typeof appRegistry.list>;
	let storage: Map<string, string>;

	beforeEach(() => {
		appsSnapshot = appRegistry.list();
		mockInvoke.mockReset();
		storage = new Map();
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => storage.set(key, value),
			removeItem: (key: string) => storage.delete(key),
		});
		useAppStore.setState({ activeApp: null, activeAppContext: null });
	});

	afterEach(() => {
		// Remove any apps added during the test
		for (const p of appRegistry.list()) {
			if (!appsSnapshot.find((o) => o.id === p.id)) {
				appRegistry.unregister(p.id);
			}
		}
		useAppStore.setState({ activeApp: null, activeAppContext: null });
		vi.clearAllMocks();
		vi.unstubAllGlobals();
	});

	describe("loadInstalledApps", () => {
		it("registers apps returned by app_list_installed", async () => {
			mockInvoke.mockResolvedValue([
				{ id: "test-app", name: "Test app", icon: "?㎦" },
			]);

			await loadInstalledApps();

			const app = appRegistry.get("test-app");
			expect(app).toBeDefined();
			expect(app?.name).toBe("Test app");
			expect(app?.source).toBe("installed");
		});

		it("bumps appListVersion after loading", async () => {
			mockInvoke.mockResolvedValue([{ id: "bump-test", name: "Bump Test" }]);
			const before = useAppStore.getState().appListVersion;

			await loadInstalledApps();

			expect(useAppStore.getState().appListVersion).toBeGreaterThan(before);
		});

		it("does not overwrite already-registered apps", async () => {
			appRegistry.register({
				id: "existing-app",
				name: "Original",
				builtIn: true,
				center: FakeCenterapp,
			});
			mockInvoke.mockResolvedValue([
				{ id: "existing-app", name: "Overwrite Attempt" },
			]);

			await loadInstalledApps();

			const app = appRegistry.get("existing-app");
			expect(app?.name).toBe("Original");
			expect(app?.builtIn).toBe(true);
		});

		it("handles invoke failure gracefully (no crash)", async () => {
			mockInvoke.mockRejectedValue(new Error("disk error"));

			await expect(loadInstalledApps()).resolves.not.toThrow();
		});

		it("registers multiple apps", async () => {
			mockInvoke.mockResolvedValue([
				{ id: "app-a", name: "app A" },
				{ id: "app-b", name: "app B" },
			]);

			await loadInstalledApps();

			expect(appRegistry.get("app-a")).toBeDefined();
			expect(appRegistry.get("app-b")).toBeDefined();
		});

		it("keeps installed apps alive by default so state survives app switches", async () => {
			// Regression: an installed app (iframe) was unmounted on app switch,
			// destroying its in-page state (e.g. a Slides deck's open PDF). Installed
			// apps must default to keepAlive so the shell renders them in a hidden
			// slot instead of tearing the iframe down.
			mockInvoke.mockResolvedValue([{ id: "keepalive-default", name: "KA" }]);

			await loadInstalledApps();

			expect(appRegistry.get("keepalive-default")?.keepAlive).toBe(true);
		});

		it("respects an explicit keepAlive:false opt-out in the manifest", async () => {
			mockInvoke.mockResolvedValue([
				{ id: "keepalive-off", name: "KA off", keepAlive: false },
			]);

			await loadInstalledApps();

			expect(appRegistry.get("keepalive-off")?.keepAlive).toBe(false);
		});

		it("assigns profile 'legacy' when manifest_version is absent", async () => {
			mockInvoke.mockResolvedValue([{ id: "legacy-app", name: "Legacy App" }]);

			await loadInstalledApps();

			const app = appRegistry.get("legacy-app");
			expect(app?.profile).toBe("legacy");
			expect(app?.manifestVersion).toBeUndefined();
		});

		it("assigns profile 'v2' and maps v2 fields when manifest_version is 2", async () => {
			const collisionManifests = [
				{
					id: "v2-app",
					name: "V2 App",
					manifest_version: 2,
					descriptions: { ko: "설명", en: "desc" },
					context: "context.md",
					skills: [
						{
							id: "test-skill",
							version: "1.0.0",
							path: "skills/test/SKILL.md",
						},
					],
					permissions: ["speech", "browser"],
					host_permissions: ["https://example.com/*"],
					optional_permissions: ["modals"],
					requires: ["land.naia.slides@>=0.2"],
					help: { ko: "help/ko.md" },
					data_use: {
						leaves_device: ["https://api.example.com"],
						note: "telemetry",
					},
					publisher: "nextain",
					tools: [
						{
							name: "skill_test_action",
							description: "Test action",
							exported: true,
						},
					],
				},
			];
			mockInvoke.mockImplementation((command: string) =>
				command === "app_list_installed"
					? Promise.resolve(collisionManifests)
					: Promise.resolve(true),
			);

			await loadInstalledApps();

			const app = appRegistry.get("v2-app");
			expect(app).toBeDefined();
			expect(app?.profile).toBe("v2");
			expect(app?.manifestVersion).toBe(2);
			expect(app?.descriptions).toEqual({ ko: "설명", en: "desc" });
			expect(app?.context).toBe("context.md");
			expect(app?.skills).toHaveLength(1);
			expect(app?.skills?.[0].id).toBe("test-skill");
			expect(app?.permissions).toEqual(["speech", "browser"]);
			expect(app?.hostPermissions).toEqual(["https://example.com/*"]);
			expect(app?.optionalPermissions).toEqual(["modals"]);
			expect(app?.requires).toEqual(["land.naia.slides@>=0.2"]);
			expect(app?.help).toEqual({ ko: "help/ko.md" });
			expect(app?.dataUse?.leaves_device).toEqual(["https://api.example.com"]);
			expect(app?.publisher).toBe("nextain");
			expect(app?.tools?.[0].exported).toBe(true);
		});

		it("rejects signed Store tool declarations that collide with built-ins or another app", async () => {
			const signedManifest = [
				{
					id: "signed-store-collision",
					name: "Signed Store app",
					store_signature_verified: true,
					tools: [
						{ name: "skill_memory_save", description: "built-in collision" },
						{ name: "skill_config", description: "paired Agent built-in" },
						{ name: "skill_environment", description: "reserved Shell tool" },
						{ name: "skill_shared_collision", description: "duplicate" },
						{ name: "skill_unique_store", description: "allowed" },
					],
				},
				{
					id: "other-installed-collision",
					name: "Other app",
					store_signature_verified: true,
					tools: [{ name: "skill_shared_collision", description: "duplicate" }],
				},
			];
			mockInvoke.mockImplementation((command: string) =>
				command === "app_list_installed"
					? Promise.resolve(signedManifest)
					: Promise.resolve(true),
			);

			await loadInstalledApps();

			expect(
				appRegistry
					.get("signed-store-collision")
					?.tools?.map((tool) => tool.name),
			).toEqual(["skill_unique_store"]);
			expect(
				appRegistry.get("signed-store-collision")?.storeSignatureVerified,
			).toBe(true);
			expect(
				appRegistry
					.get("other-installed-collision")
					?.tools?.map((tool) => tool.name),
			).toEqual([]);
			expect(Logger.warn).toHaveBeenCalledWith(
				"AppLoader",
				"Rejected Store app tool declaration",
				expect.objectContaining({
					appId: "signed-store-collision",
					tool: "skill_memory_save",
				}),
			);
			expect(Logger.warn).toHaveBeenCalledWith(
				"AppLoader",
				"Rejected Store app tool declaration",
				expect.objectContaining({
					appId: "signed-store-collision",
					tool: "skill_config",
					reason: "tool name conflicts with a Shell built-in",
				}),
			);
		});

		it("revokes Store tool trust when Rust no longer verifies the installed receipt", async () => {
			mockInvoke.mockImplementation((command: string) =>
				command === "app_list_installed"
					? Promise.resolve([
							{
								id: "store-trust-refresh",
								name: "Store app",
								store_signature_verified: true,
								tools: [
									{ name: "skill_store_refresh", description: "Refresh" },
								],
							},
						])
					: Promise.resolve(true),
			);
			await loadInstalledApps();
			expect(
				appRegistry.get("store-trust-refresh")?.storeSignatureVerified,
			).toBe(true);

			mockInvoke.mockImplementation((command: string) =>
				command === "app_list_installed"
					? Promise.resolve([
							{
								id: "store-trust-refresh",
								name: "Store app",
								store_signature_verified: false,
								tools: [
									{ name: "skill_store_refresh", description: "Refresh" },
								],
							},
						])
					: Promise.resolve(true),
			);
			await loadInstalledApps();
			expect(
				appRegistry.get("store-trust-refresh")?.storeSignatureVerified,
			).toBe(false);
		});

		it("replaces an installed registration when the same app id moves roots", async () => {
			appRegistry.register({
				id: "relocated-app",
				name: "Old location",
				source: "installed",
				htmlEntry: "/old/.naia/apps/relocated-app/index.html",
				center: FakeCenterapp,
			});
			useAppStore.setState({
				activeApp: "relocated-app",
				activeAppContext: { type: "relocated-app", data: { root: "old" } },
			});
			mockInvoke.mockResolvedValue([
				{
					id: "relocated-app",
					name: "New location",
					htmlEntry: "/new/.naia/apps/relocated-app/index.html",
				},
			]);

			await loadInstalledApps();

			expect(appRegistry.get("relocated-app")?.name).toBe("New location");
			expect(appRegistry.get("relocated-app")?.htmlEntry).toBe(
				"/new/.naia/apps/relocated-app/index.html",
			);
			expect(useAppStore.getState().activeApp).toBeNull();
			expect(useAppStore.getState().activeAppContext).toBeNull();
		});

		it("removes an active app when the selected ADK no longer lists it", async () => {
			appRegistry.register({
				id: "removed-active-app",
				name: "Removed",
				source: "installed",
				center: FakeCenterapp,
			});
			useAppStore.setState({
				activeApp: "removed-active-app",
				activeAppContext: {
					type: "removed-active-app",
					data: { active: true },
				},
			});
			mockInvoke.mockResolvedValue([]);

			await loadInstalledApps();

			expect(appRegistry.get("removed-active-app")).toBeUndefined();
			expect(useAppStore.getState().activeApp).toBeNull();
			expect(useAppStore.getState().activeAppContext).toBeNull();
		});

		it("ignores an older list result after a newer ADK load starts", async () => {
			let resolveOlder!: (manifests: unknown[]) => void;
			const olderResult = new Promise<unknown[]>((resolve) => {
				resolveOlder = resolve;
			});
			mockInvoke
				.mockImplementationOnce(() => olderResult)
				.mockResolvedValueOnce([{ id: "new-root-app", name: "New root" }]);

			const olderLoad = loadInstalledApps();
			const newerLoad = loadInstalledApps();
			await newerLoad;
			resolveOlder([{ id: "old-root-app", name: "Old root" }]);
			await olderLoad;

			expect(appRegistry.get("new-root-app")).toBeDefined();
			expect(appRegistry.get("old-root-app")).toBeUndefined();
		});

		it("ignores unsigned declarations when building signed owners and legacy dispatch", async () => {
			mockInvoke.mockImplementation((command: string) => {
				if (command === "app_list_installed") {
					return Promise.resolve([
						{
							id: "signed-owner-test",
							name: "Signed owner",
							store_signature_verified: true,
							tools: [
								{ name: "skill_signed_unique", description: "Signed" },
								{ name: "skill_blackjack_tutor", description: "Legacy" },
							],
						},
						{
							id: "unsigned-squatter-test",
							name: "Unsigned side load",
							tools: [
								{ name: "skill_signed_unique", description: "Squat" },
								{ name: "skill_blackjack_tutor", description: "Legacy squat" },
							],
						},
					]);
				}
				return Promise.resolve(true);
			});
			await loadInstalledApps();
			const signed = appRegistry.get("signed-owner-test");
			const unsigned = appRegistry.get("unsigned-squatter-test");
			expect(signed?.tools?.map((tool) => tool.name)).toContain(
				"skill_signed_unique",
			);
			expect(unsigned?.tools?.map((tool) => tool.name)).toEqual([
				"skill_signed_unique",
			]);
			useAppStore.getState().setActiveApp("signed-owner-test");
			expect(isModelFacingToolAllowed("skill_signed_unique")).toBe(true);
			expect(isModelFacingToolAllowed("skill_blackjack_tutor")).toBe(true);
			useAppStore.getState().setActiveApp("unsigned-squatter-test");
			expect(isModelFacingToolAllowed("skill_signed_unique")).toBe(false);
			expect(isModelFacingToolAllowed("skill_blackjack_tutor")).toBe(false);
		});

		it("replaces tools and verification state on every installed app refresh", async () => {
			let list = [
				{
					id: "refresh-tools-test",
					name: "Refresh",
					store_signature_verified: true,
					tools: [{ name: "skill_before_refresh", description: "Before" }],
				},
			];
			mockInvoke.mockImplementation((command: string) =>
				command === "app_list_installed"
					? Promise.resolve(list)
					: Promise.resolve(true),
			);
			await loadInstalledApps();
			expect(
				appRegistry.get("refresh-tools-test")?.storeSignatureVerified,
			).toBe(true);
			list = [
				{
					id: "refresh-tools-test",
					name: "Refresh",
					store_signature_verified: false,
					tools: [{ name: "skill_after_refresh", description: "After" }],
				},
			];
			await loadInstalledApps();
			expect(
				appRegistry.get("refresh-tools-test")?.storeSignatureVerified,
			).toBe(false);
			expect(
				appRegistry.get("refresh-tools-test")?.tools?.map((tool) => tool.name),
			).toEqual(["skill_after_refresh"]);
			expect(isModelFacingToolAllowed("skill_after_refresh")).toBe(false);
		});

		it("refreshes displayed app fields even when its tool declaration is unchanged", async () => {
			let label = "Old label";
			mockInvoke.mockImplementation((command: string) =>
				command === "app_list_installed"
					? Promise.resolve([
							{
								id: "display-refresh-test",
								name: label,
								store_signature_verified: true,
								store_signature_issued_at_ms: Date.now(),
								tools: [{ name: "skill_display_refresh", description: "same" }],
							},
						])
					: Promise.resolve(true),
			);
			await loadInstalledApps();
			label = "New label";
			await loadInstalledApps();
			expect(appRegistry.get("display-refresh-test")?.name).toBe("New label");
		});

		it("revokes on denial, then promotes again when entitlement is re-granted on the next list", async () => {
			let granted = false;
			const listing = [
				{
					id: "entitlement-transition-test",
					name: "Transition",
					store_signature_verified: true,
					store_signature_issued_at_ms: Date.now(),
					tools: [
						{ name: "skill_entitlement_transition", description: "Tool" },
					],
				},
			];
			mockInvoke.mockImplementation((command: string) =>
				command === "app_list_installed"
					? Promise.resolve(listing.map((app) => ({ ...app })))
					: Promise.resolve(granted),
			);
			await loadInstalledApps();
			expect(
				appRegistry.get("entitlement-transition-test")?.storeSignatureVerified,
			).toBe(false);
			expect(appRegistry.get("entitlement-transition-test")?.tools).toEqual([]);
			expect(isModelFacingToolAllowed("skill_entitlement_transition")).toBe(
				false,
			);
			granted = true;
			await loadInstalledApps();
			expect(
				appRegistry.get("entitlement-transition-test")?.storeSignatureVerified,
			).toBe(true);
			expect(
				appRegistry
					.get("entitlement-transition-test")
					?.tools?.map((tool) => tool.name),
			).toContain("skill_entitlement_transition");
			useAppStore.getState().setActiveApp("entitlement-transition-test");
			expect(isModelFacingToolAllowed("skill_entitlement_transition")).toBe(
				true,
			);
		});

		it("allows offline grace through 72 hours from receipt and blocks after it", async () => {
			const now = Date.now();
			const dateNow = vi.spyOn(Date, "now").mockReturnValue(now);
			mockInvoke.mockImplementation((command: string) =>
				command === "app_list_installed"
					? Promise.resolve([
							{
								id: "grace-test",
								name: "Grace",
								store_signature_verified: true,
								store_signature_issued_at_ms: now - 71 * 60 * 60 * 1000,
							},
						])
					: Promise.reject(new Error("offline")),
			);
			await loadInstalledApps();
			expect(appRegistry.get("grace-test")?.storeSignatureVerified).toBe(true);
			dateNow.mockReturnValue(now + 73 * 60 * 60 * 1000);
			await loadInstalledApps();
			expect(appRegistry.get("grace-test")?.storeSignatureVerified).toBe(false);
			dateNow.mockRestore();
		});

		it("persists the last positive entitlement timestamp across a loader restart", async () => {
			const now = Date.now();
			let offline = false;
			const listing = () => [
				{
					id: "persisted-grace-test",
					name: "Persisted",
					store_signature_verified: true,
					store_signature_issued_at_ms: now - 100 * 60 * 60 * 1000,
				},
			];
			mockInvoke.mockImplementation((command: string) =>
				command === "app_list_installed"
					? Promise.resolve(listing())
					: offline
						? Promise.reject(new Error("offline"))
						: Promise.resolve(true),
			);
			await loadInstalledApps();
			const saved = JSON.parse(
				storage.get("naia.store.entitlement.last-granted.v1") ?? "{}",
			);
			expect(saved["persisted-grace-test"]).toBe(now);
			invalidateInstalledApps();
			offline = true;
			const dateNow = vi
				.spyOn(Date, "now")
				.mockReturnValue(now + 71 * 60 * 60 * 1000);
			await loadInstalledApps();
			expect(
				appRegistry.get("persisted-grace-test")?.storeSignatureVerified,
			).toBe(true);
			dateNow.mockRestore();
		});

		it("applies the same bounded grace to entitlement timeouts", async () => {
			vi.useFakeTimers();
			const issuedAt = Date.now();
			mockInvoke.mockImplementation((command: string) =>
				command === "app_list_installed"
					? Promise.resolve([
							{
								id: "timeout-grace-test",
								name: "Timeout",
								store_signature_verified: true,
								store_signature_issued_at_ms: issuedAt,
							},
						])
					: new Promise(() => {}),
			);
			const loading = loadInstalledApps();
			await vi.advanceTimersByTimeAsync(2_001);
			await loading;
			expect(
				appRegistry.get("timeout-grace-test")?.storeSignatureVerified,
			).toBe(true);
			vi.useRealTimers();
		});

		it("revokes a signed app for explicit entitlement loss and blocks offline without a valid grace start", async () => {
			const manifest = (id: string) => [
				{
					id,
					name: id,
					store_signature_verified: true,
					tools: [{ name: `skill_${id}`, description: id }],
				},
			];
			mockInvoke.mockImplementation(
				(command: string, args: { appId?: string }) => {
					if (command === "app_list_installed")
						return Promise.resolve(manifest("entitlement-denied-test"));
					if (args.appId === "entitlement-denied-test")
						return Promise.resolve(false);
					return Promise.reject(new Error("offline"));
				},
			);
			await loadInstalledApps();
			expect(
				appRegistry.get("entitlement-denied-test")?.storeSignatureVerified,
			).toBe(false);

			mockInvoke.mockImplementation((command: string) =>
				command === "app_list_installed"
					? Promise.resolve([
							{
								...manifest("entitlement-offline-test")[0],
								store_signature_issued_at_ms: Date.now() - 73 * 60 * 60 * 1000,
							},
						])
					: Promise.reject(new Error("offline")),
			);
			await loadInstalledApps();
			expect(
				appRegistry.get("entitlement-offline-test")?.storeSignatureVerified,
			).toBe(false);
		});

		it("rechecks one Store app in Rust and the entitlement after the ten-minute dispatch window", async () => {
			mockInvoke.mockImplementation((command: string) =>
				command === "app_list_installed"
					? Promise.resolve([
							{
								id: "dispatch-refresh-test",
								name: "Dispatch refresh",
								store_signature_verified: true,
								tools: [
									{ name: "skill_dispatch_refresh", description: "Tool" },
								],
							},
						])
					: Promise.resolve(true),
			);
			await loadInstalledApps();
			const now = Date.now();
			const dateNow = vi
				.spyOn(Date, "now")
				.mockReturnValue(now + 10 * 60_000 + 1);
			mockInvoke.mockImplementation((command: string) =>
				command === "app_verify_installed_store_app"
					? Promise.resolve(false)
					: Promise.resolve(true),
			);
			try {
				expect(
					await ensureStoreAppVerificationFresh("dispatch-refresh-test"),
				).toBe(false);
				expect(mockInvoke).toHaveBeenCalledWith(
					"app_verify_installed_store_app",
					{
						appId: "dispatch-refresh-test",
					},
				);
				expect(
					appRegistry.get("dispatch-refresh-test")?.storeSignatureVerified,
				).toBe(false);
			} finally {
				dateNow.mockRestore();
			}
		});

		it("blocks execution and downgrades the tool when entitlement is denied at dispatch", async () => {
			mockInvoke.mockImplementation((command: string) =>
				command === "app_list_installed"
					? Promise.resolve([
							{
								id: "dispatch-entitlement-denied",
								name: "Dispatch denial",
								store_signature_verified: true,
								store_signature_issued_at_ms: Date.now(),
								tools: [
									{ name: "skill_dispatch_entitlement", description: "Tool" },
								],
							},
						])
					: Promise.resolve(true),
			);
			await loadInstalledApps();
			vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10 * 60_000 + 1);
			mockInvoke.mockImplementation((command: string) =>
				command === "app_verify_installed_store_app"
					? Promise.resolve(true)
					: Promise.resolve(false),
			);
			expect(
				await ensureStoreAppVerificationFresh("dispatch-entitlement-denied"),
			).toBe(false);
			expect(
				appRegistry.get("dispatch-entitlement-denied")?.storeSignatureVerified,
			).toBe(false);
			vi.restoreAllMocks();
		});

		it("connects Rust list output through loader, model boundary, and deletion", async () => {
			mockInvoke.mockImplementation(
				(command: string, args: { appId?: string }) => {
					if (command === "app_list_installed") {
						return Promise.resolve([
							{
								id: "integration-store-test",
								name: "Integration Store",
								store_signature_verified: true,
								tools: [
									{ name: "skill_integration_store", description: "Signed" },
								],
							},
							{
								id: "integration-squatter-test",
								name: "Unsigned",
								tools: [
									{ name: "skill_integration_store", description: "Squat" },
								],
							},
						]);
					}
					if (command === "app_store_has_entitlement")
						return Promise.resolve(true);
					if (
						command === "app_remove_installed" &&
						args.appId === "integration-store-test"
					)
						return Promise.resolve();
					return Promise.resolve(false);
				},
			);
			await loadInstalledApps();
			useAppStore.getState().setActiveApp("integration-store-test");
			const boundary = makeModelToolBoundary({
				fetchTools: async () => [{ name: "skill_integration_store" }],
			});
			expect((await boundary.resolve()).disabledSkills).toEqual([]);
			expect(appRegistry.get("integration-squatter-test")?.tools).toEqual([
				{ name: "skill_integration_store", description: "Squat" },
			]);
			await removeInstalledApp("integration-store-test");
			expect(isModelFacingToolAllowed("skill_integration_store")).toBe(false);
			expect(mockInvoke).toHaveBeenCalledWith("app_remove_installed", {
				appId: "integration-store-test",
			});
		});
	});

	describe("removeInstalledApp", () => {
		it("calls app_remove_installed Tauri command", async () => {
			appRegistry.register({
				id: "to-remove",
				name: "To Remove",
				source: "installed",
				center: FakeCenterapp,
			});
			mockInvoke.mockResolvedValue(undefined);

			await removeInstalledApp("to-remove");

			expect(mockInvoke).toHaveBeenCalledWith("app_remove_installed", {
				appId: "to-remove",
			});
		});

		it("unregisters app from registry", async () => {
			appRegistry.register({
				id: "to-remove-2",
				name: "To Remove 2",
				source: "installed",
				center: FakeCenterapp,
			});
			mockInvoke.mockResolvedValue(undefined);

			await removeInstalledApp("to-remove-2");

			expect(appRegistry.get("to-remove-2")).toBeUndefined();
		});

		it("does not resurrect a removed app from a pending list response", async () => {
			let resolvePending!: (manifests: unknown[]) => void;
			const pendingList = new Promise<unknown[]>((resolve) => {
				resolvePending = resolve;
			});
			mockInvoke
				.mockImplementationOnce(() => pendingList)
				.mockResolvedValueOnce(undefined);

			const loading = loadInstalledApps();
			await removeInstalledApp("removed-before-list-completes");
			resolvePending([
				{
					id: "removed-before-list-completes",
					name: "Removed",
					store_signature_verified: true,
					tools: [{ name: "skill_removed_store_tool", description: "Removed" }],
				},
			]);
			await loading;

			expect(appRegistry.get("removed-before-list-completes")).toBeUndefined();
		});

		it("bumps appListVersion after remove", async () => {
			appRegistry.register({
				id: "to-remove-3",
				name: "To Remove 3",
				source: "installed",
				center: FakeCenterapp,
			});
			mockInvoke.mockResolvedValue(undefined);
			const before = useAppStore.getState().appListVersion;

			await removeInstalledApp("to-remove-3");

			expect(useAppStore.getState().appListVersion).toBeGreaterThan(before);
		});

		it("preserves registration and rejects if disk removal fails", async () => {
			appRegistry.register({
				id: "to-remove-4",
				name: "To Remove 4",
				source: "installed",
				center: FakeCenterapp,
			});
			mockInvoke.mockRejectedValue(new Error("file not found"));

			await expect(removeInstalledApp("to-remove-4")).rejects.toThrow(
				"file not found",
			);

			expect(appRegistry.get("to-remove-4")).toBeDefined();
		});
	});
});

describe("app tool IPC argument guard", () => {
	it("checks declared required parameters and top-level value types", () => {
		const tool = {
			name: "skill_schema_test",
			description: "Schema",
			parameters: {
				type: "object" as const,
				required: ["query"],
				properties: { query: { type: "string" }, limit: { type: "integer" } },
			},
		};
		expect(validateAppToolParameters(tool, {})).toContain("required");
		expect(validateAppToolParameters(tool, { query: 2 })).toContain("type");
		expect(
			validateAppToolParameters(tool, { query: "search", limit: 2 }),
		).toBeNull();
	});

	it("accepts plain JSON objects and rejects invalid or oversized arguments", async () => {
		expect(validateAppToolArgs({ answer: 42 })).toBeNull();
		expect(validateAppToolArgs(null)).toContain("JSON object");
		expect(validateAppToolArgs([1, 2])).toContain("JSON object");
		expect(validateAppToolArgs(new Date())).toContain("plain JSON object");
		expect(validateAppToolArgs({ value: "x".repeat(65 * 1024) })).toContain(
			"64 KB",
		);
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(validateAppToolArgs(cyclic)).toContain("serializable");

		const bridge = new ActiveAppBridge("args-test");
		const handler = vi.fn(() => "delivered");
		bridge.onToolCall("skill_args_test", handler);
		await expect(
			bridge.callTool("skill_args_test", { value: "x".repeat(65 * 1024) }),
		).rejects.toThrow("64 KB");
		expect(handler).not.toHaveBeenCalled();
	});

	it("stops target-origin parsing failures instead of using wildcard", () => {
		expect(
			resolveAppToolTargetOrigin("https://apps.example.test/index.html"),
		).toBe("https://apps.example.test");
		expect(resolveAppToolTargetOrigin("not a url")).toBeNull();
		expect(resolveAppToolTargetOrigin("data:text/html,hello")).toBeNull();
	});
});
