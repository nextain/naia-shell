import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
	vi.doUnmock("../../apps/generic-installed/GenericInstalledApp");
	vi.doUnmock("@tauri-apps/api/core");
	vi.resetModules();
});

describe("installed app renderer loading", () => {
	it("does not load a renderer for an empty list and discards an old pending load", async () => {
		vi.resetModules();
		let release!: () => void;
		let started!: () => void;
		const loading = new Promise<void>((resolve) => { started = resolve; });
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const factory = vi.fn(async () => {
			started();
			await gate;
			return { createGenericInstalledApp: () => () => null };
		});
		vi.doMock("../../apps/generic-installed/GenericInstalledApp", factory);
		let listCalls = 0;
		const invoke = vi.fn(async (command: string) => {
			if (command !== "app_list_installed") return null;
			listCalls += 1;
			return listCalls === 2 ? [{ id: "old-root-app", name: "Old root" }] : [];
		});
		vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
		const { loadInstalledApps } = await import("../app-loader");
		const { appRegistry } = await import("../app-registry");
		await loadInstalledApps();
		expect(factory).not.toHaveBeenCalled();
		const oldLoad = loadInstalledApps();
		await loading;
		await loadInstalledApps();
		release();
		await oldLoad;
		expect(appRegistry.get("old-root-app")).toBeUndefined();
	});

	it("keeps existing registrations when the renderer cannot load", async () => {
		vi.resetModules();
		vi.doMock("../../apps/generic-installed/GenericInstalledApp", async () => {
			throw new Error("renderer unavailable");
		});
		vi.doMock("@tauri-apps/api/core", () => ({
			invoke: vi.fn().mockResolvedValue([{ id: "new-app", name: "New" }]),
		}));
		const { loadInstalledApps, areInstalledAppsSettled } = await import("../app-loader");
		const { appRegistry } = await import("../app-registry");
		appRegistry.register({ id: "existing-app", name: "Existing", source: "installed", center: () => null });
		await expect(loadInstalledApps()).resolves.toBeUndefined();
		expect(appRegistry.get("existing-app")).toBeDefined();
		expect(appRegistry.get("new-app")).toBeUndefined();
		expect(areInstalledAppsSettled()).toBe(true);
	});
});
