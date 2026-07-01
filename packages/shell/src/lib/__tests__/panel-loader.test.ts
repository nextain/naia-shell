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

const FakeCenterPanel = () => null;

describe("panel-loader", () => {
	let appsSnapshot: ReturnType<typeof appRegistry.list>;

	beforeEach(() => {
		appsSnapshot = appRegistry.list();
		mockInvoke.mockReset();
	});

	afterEach(() => {
		// Remove any panels added during the test
		for (const p of appRegistry.list()) {
			if (!appsSnapshot.find((o) => o.id === p.id)) {
				appRegistry.unregister(p.id);
			}
		}
		vi.clearAllMocks();
	});

	describe("loadInstalledApps", () => {
		it("registers panels returned by app_list_installed", async () => {
			mockInvoke.mockResolvedValue([
				{ id: "test-panel", name: "Test Panel", icon: "🧪" },
			]);

			await loadInstalledApps();

			const panel = appRegistry.get("test-panel");
			expect(panel).toBeDefined();
			expect(panel?.name).toBe("Test Panel");
			expect(panel?.source).toBe("installed");
		});

		it("bumps appListVersion after loading", async () => {
			mockInvoke.mockResolvedValue([{ id: "bump-test", name: "Bump Test" }]);
			const before = useAppStore.getState().appListVersion;

			await loadInstalledApps();

			expect(useAppStore.getState().appListVersion).toBeGreaterThan(before);
		});

		it("does not overwrite already-registered panels", async () => {
			appRegistry.register({
				id: "existing-panel",
				name: "Original",
				builtIn: true,
				center: FakeCenterPanel,
			});
			mockInvoke.mockResolvedValue([
				{ id: "existing-panel", name: "Overwrite Attempt" },
			]);

			await loadInstalledApps();

			const panel = appRegistry.get("existing-panel");
			expect(panel?.name).toBe("Original");
			expect(panel?.builtIn).toBe(true);
		});

		it("handles invoke failure gracefully (no crash)", async () => {
			mockInvoke.mockRejectedValue(new Error("disk error"));

			await expect(loadInstalledApps()).resolves.not.toThrow();
		});

		it("registers multiple panels", async () => {
			mockInvoke.mockResolvedValue([
				{ id: "panel-a", name: "Panel A" },
				{ id: "panel-b", name: "Panel B" },
			]);

			await loadInstalledApps();

			expect(appRegistry.get("panel-a")).toBeDefined();
			expect(appRegistry.get("panel-b")).toBeDefined();
		});
	});

	describe("removeInstalledApp", () => {
		it("calls app_remove_installed Tauri command", async () => {
			appRegistry.register({
				id: "to-remove",
				name: "To Remove",
				source: "installed",
				center: FakeCenterPanel,
			});
			mockInvoke.mockResolvedValue(undefined);

			await removeInstalledApp("to-remove");

			expect(mockInvoke).toHaveBeenCalledWith("app_remove_installed", {
				appId: "to-remove",
			});
		});

		it("unregisters panel from registry", async () => {
			appRegistry.register({
				id: "to-remove-2",
				name: "To Remove 2",
				source: "installed",
				center: FakeCenterPanel,
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
				center: FakeCenterPanel,
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
				center: FakeCenterPanel,
			});
			mockInvoke.mockRejectedValue(new Error("file not found"));

			await removeInstalledApp("to-remove-4");

			expect(appRegistry.get("to-remove-4")).toBeUndefined();
		});
	});
});
