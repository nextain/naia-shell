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
	});

	afterEach(() => {
		// Remove any apps added during the test
		for (const p of appRegistry.list()) {
			if (!appsSnapshot.find((o) => o.id === p.id)) {
				appRegistry.unregister(p.id);
			}
		}
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

		it("still unregisters even if Tauri command fails", async () => {
			appRegistry.register({
				id: "to-remove-4",
				name: "To Remove 4",
				source: "installed",
				center: FakeCenterapp,
			});
			mockInvoke.mockRejectedValue(new Error("file not found"));

			await removeInstalledApp("to-remove-4");

			expect(appRegistry.get("to-remove-4")).toBeUndefined();
		});
	});
});
