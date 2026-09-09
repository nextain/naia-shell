import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../stores/app";
import { loadInstalledApps, removeInstalledApp } from "../app-loader";
import { appRegistry } from "../app-registry";

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

	beforeEach(() => {
		appsSnapshot = appRegistry.list();
		mockInvoke.mockReset();
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
				.mockResolvedValueOnce([
					{ id: "new-root-app", name: "New root" },
				]);

			const olderLoad = loadInstalledApps();
			const newerLoad = loadInstalledApps();
			await newerLoad;
			resolveOlder([{ id: "old-root-app", name: "Old root" }]);
			await olderLoad;

			expect(appRegistry.get("new-root-app")).toBeDefined();
			expect(appRegistry.get("old-root-app")).toBeUndefined();
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
