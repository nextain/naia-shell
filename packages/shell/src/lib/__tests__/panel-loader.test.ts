import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePanelStore } from "../../stores/panel";
import { loadInstalledPanels, removeInstalledPanel } from "../panel-loader";
import { panelRegistry } from "../panel-registry";

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
	let panelsSnapshot: ReturnType<typeof panelRegistry.list>;

	beforeEach(() => {
		panelsSnapshot = panelRegistry.list();
		mockInvoke.mockReset();
	});

	afterEach(() => {
		// Remove any panels added during the test
		for (const p of panelRegistry.list()) {
			if (!panelsSnapshot.find((o) => o.id === p.id)) {
				panelRegistry.unregister(p.id);
			}
		}
		vi.clearAllMocks();
	});

	describe("loadInstalledPanels", () => {
		it("registers panels returned by panel_list_installed", async () => {
			mockInvoke.mockResolvedValue([
				{ id: "test-panel", name: "Test Panel", icon: "🧪" },
			]);

			await loadInstalledPanels();

			const panel = panelRegistry.get("test-panel");
			expect(panel).toBeDefined();
			expect(panel?.name).toBe("Test Panel");
			expect(panel?.source).toBe("installed");
		});

		it("bumps panelListVersion after loading", async () => {
			mockInvoke.mockResolvedValue([{ id: "bump-test", name: "Bump Test" }]);
			const before = usePanelStore.getState().panelListVersion;

			await loadInstalledPanels();

			expect(usePanelStore.getState().panelListVersion).toBeGreaterThan(before);
		});

		it("does not overwrite already-registered panels", async () => {
			panelRegistry.register({
				id: "existing-panel",
				name: "Original",
				builtIn: true,
				center: FakeCenterPanel,
			});
			mockInvoke.mockResolvedValue([
				{ id: "existing-panel", name: "Overwrite Attempt" },
			]);

			await loadInstalledPanels();

			const panel = panelRegistry.get("existing-panel");
			expect(panel?.name).toBe("Original");
			expect(panel?.builtIn).toBe(true);
		});

		it("handles invoke failure gracefully (no crash)", async () => {
			mockInvoke.mockRejectedValue(new Error("disk error"));

			await expect(loadInstalledPanels()).resolves.not.toThrow();
		});

		it("registers multiple panels", async () => {
			mockInvoke.mockResolvedValue([
				{ id: "panel-a", name: "Panel A" },
				{ id: "panel-b", name: "Panel B" },
			]);

			await loadInstalledPanels();

			expect(panelRegistry.get("panel-a")).toBeDefined();
			expect(panelRegistry.get("panel-b")).toBeDefined();
		});
	});

	describe("removeInstalledPanel", () => {
		it("calls panel_remove_installed Tauri command", async () => {
			panelRegistry.register({
				id: "to-remove",
				name: "To Remove",
				source: "installed",
				center: FakeCenterPanel,
			});
			mockInvoke.mockResolvedValue(undefined);

			await removeInstalledPanel("to-remove");

			expect(mockInvoke).toHaveBeenCalledWith("panel_remove_installed", {
				panelId: "to-remove",
			});
		});

		it("unregisters panel from registry", async () => {
			panelRegistry.register({
				id: "to-remove-2",
				name: "To Remove 2",
				source: "installed",
				center: FakeCenterPanel,
			});
			mockInvoke.mockResolvedValue(undefined);

			await removeInstalledPanel("to-remove-2");

			expect(panelRegistry.get("to-remove-2")).toBeUndefined();
		});

		it("bumps panelListVersion after remove", async () => {
			panelRegistry.register({
				id: "to-remove-3",
				name: "To Remove 3",
				source: "installed",
				center: FakeCenterPanel,
			});
			mockInvoke.mockResolvedValue(undefined);
			const before = usePanelStore.getState().panelListVersion;

			await removeInstalledPanel("to-remove-3");

			expect(usePanelStore.getState().panelListVersion).toBeGreaterThan(before);
		});

		it("still unregisters even if Tauri command fails", async () => {
			panelRegistry.register({
				id: "to-remove-4",
				name: "To Remove 4",
				source: "installed",
				center: FakeCenterPanel,
			});
			mockInvoke.mockRejectedValue(new Error("file not found"));

			await removeInstalledPanel("to-remove-4");

			expect(panelRegistry.get("to-remove-4")).toBeUndefined();
		});
	});
});
