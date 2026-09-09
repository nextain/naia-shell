// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const uiPreferences = vi.hoisted(() => ({
	UI_PREFERENCE_KEYS: { updatePromptSnooze: "updatePromptSnooze" },
	getUiPreference: vi.fn<(key: string, fallback: unknown) => unknown>(
		() => undefined,
	),
	patchUiPreferences: vi.fn<
		(patch: Record<string, unknown>) => Promise<boolean>
	>(async () => true),
}));

vi.mock("../ui-preferences", () => uiPreferences);

const nativeMocks = vi.hoisted(() => ({
	check: vi.fn(),
	invoke: vi.fn(),
	relaunch: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-updater", () => ({
	check: nativeMocks.check,
}));
vi.mock("@tauri-apps/api/core", () => ({
	invoke: nativeMocks.invoke,
}));
vi.mock("@tauri-apps/plugin-process", () => ({
	relaunch: nativeMocks.relaunch,
}));

const { check, invoke, relaunch } = nativeMocks;

import {
	UPDATE_PROMPT_SNOOZE_KEY,
	UPDATE_PROMPT_SNOOZE_MS,
	checkForUpdate,
	shouldShowStartupUpdatePrompt,
	snoozeStartupUpdatePrompt,
} from "../updater";

function memoryStorage() {
	const values = new Map<string, string>();
	return {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
	};
}

describe("checkForUpdate", () => {
	beforeEach(() => {
		check.mockReset();
		invoke.mockReset();
		invoke.mockResolvedValue(undefined);
		relaunch.mockReset();
		uiPreferences.getUiPreference.mockReset();
		uiPreferences.getUiPreference.mockImplementation(
			(_key: string, fallback: unknown) => fallback,
		);
		uiPreferences.patchUiPreferences.mockReset();
		uiPreferences.patchUiPreferences.mockResolvedValue(true);
	});

	it("returns null only when the updater confirms there is no update", async () => {
		check.mockResolvedValue(null);
		await expect(checkForUpdate()).resolves.toBeNull();
	});

	it("surfaces metadata or network failures instead of reporting latest", async () => {
		check.mockRejectedValue(new Error("latest.json returned 404"));
		await expect(checkForUpdate()).rejects.toThrow("latest.json returned 404");
	});

	it("downloads, installs, and relaunches an available update", async () => {
		const events: string[] = [];
		const download = vi.fn(async () => {
			events.push("download");
		});
		const install = vi.fn(async () => {
			events.push("install");
		});
		invoke.mockImplementation(async (command: string) => {
			events.push(command);
		});
		relaunch.mockImplementation(async () => {
			events.push("relaunch");
		});
		check.mockResolvedValue({
			currentVersion: "0.1.9",
			version: "0.2.0",
			body: "Signed updater recovery",
			download,
			install,
		});

		const update = await checkForUpdate();
		expect(update).toMatchObject({
			currentVersion: "0.1.9",
			version: "0.2.0",
			body: "Signed updater recovery",
		});
		await update?.installFn();
		expect(download).toHaveBeenCalledOnce();
		expect(install).toHaveBeenCalledOnce();
		expect(events).toEqual([
			"download",
			"prepare_app_relaunch",
			"install",
			"relaunch",
		]);
		expect(relaunch).toHaveBeenCalledOnce();
	});

	it("does not release another request's guard when prepare is rejected", async () => {
		const download = vi.fn().mockResolvedValue(undefined);
		const install = vi.fn().mockResolvedValue(undefined);
		invoke.mockRejectedValueOnce(new Error("agent_relaunch_pending"));
		check.mockResolvedValue({
			currentVersion: "0.1.9",
			version: "0.2.0",
			body: "Signed updater recovery",
			download,
			install,
		});

		const update = await checkForUpdate();
		await expect(update?.installFn()).rejects.toThrow("agent_relaunch_pending");
		expect(invoke).toHaveBeenCalledTimes(1);
		expect(invoke).toHaveBeenCalledWith("prepare_app_relaunch");
		expect(install).not.toHaveBeenCalled();
		expect(relaunch).not.toHaveBeenCalled();
	});

	it("releases its guard when installation fails after prepare", async () => {
		const download = vi.fn().mockResolvedValue(undefined);
		const install = vi.fn().mockRejectedValue(new Error("install failed"));
		check.mockResolvedValue({
			currentVersion: "0.1.9",
			version: "0.2.0",
			body: "Signed updater recovery",
			download,
			install,
		});

		const update = await checkForUpdate();
		await expect(update?.installFn()).rejects.toThrow("install failed");
		expect(invoke).toHaveBeenNthCalledWith(1, "prepare_app_relaunch");
		expect(invoke).toHaveBeenNthCalledWith(2, "cancel_app_relaunch");
		expect(relaunch).not.toHaveBeenCalled();
	});

	it("defers only the selected version for exactly 30 days", () => {
		const storage = memoryStorage();
		const now = Date.UTC(2026, 7, 20);

		snoozeStartupUpdatePrompt("0.2.0", now, storage);

		expect(shouldShowStartupUpdatePrompt("0.2.0", now, storage)).toBe(false);
		expect(
			shouldShowStartupUpdatePrompt(
				"0.2.0",
				now + UPDATE_PROMPT_SNOOZE_MS - 1,
				storage,
			),
		).toBe(false);
		expect(
			shouldShowStartupUpdatePrompt(
				"0.2.0",
				now + UPDATE_PROMPT_SNOOZE_MS,
				storage,
			),
		).toBe(true);
		expect(shouldShowStartupUpdatePrompt("0.2.1", now, storage)).toBe(true);

		expect(
			JSON.parse(storage.getItem(UPDATE_PROMPT_SNOOZE_KEY) ?? "{}"),
		).toEqual({
			version: "0.2.0",
			until: now + UPDATE_PROMPT_SNOOZE_MS,
		});
	});

	it("shows the prompt when persisted deferral data is corrupt or unavailable", () => {
		const corrupt = memoryStorage();
		corrupt.setItem(UPDATE_PROMPT_SNOOZE_KEY, "not-json");
		expect(shouldShowStartupUpdatePrompt("0.2.0", Date.now(), corrupt)).toBe(
			true,
		);

		const unavailable = {
			getItem: () => {
				throw new Error("storage blocked");
			},
			setItem: () => {
				throw new Error("storage blocked");
			},
		};
		expect(() =>
			snoozeStartupUpdatePrompt("0.2.0", Date.now(), unavailable),
		).not.toThrow();
		expect(
			shouldShowStartupUpdatePrompt("0.2.0", Date.now(), unavailable),
		).toBe(true);
	});

	it("stores the product snooze in ADK UI preferences and restores it by ADK", () => {
		const values = new Map<string, unknown>();
		let activeAdk = "adk-a";
		uiPreferences.getUiPreference.mockImplementation(
			(_key: string, fallback: unknown) => values.get(activeAdk) ?? fallback,
		);
		uiPreferences.patchUiPreferences.mockImplementation(async (patch) => {
			values.set(activeAdk, patch.updatePromptSnooze);
			return true;
		});

		const now = Date.UTC(2026, 7, 20);
		snoozeStartupUpdatePrompt("0.2.0", now);

		expect(uiPreferences.patchUiPreferences).toHaveBeenCalledWith({
			updatePromptSnooze: {
				version: "0.2.0",
				until: now + UPDATE_PROMPT_SNOOZE_MS,
			},
		});
		expect(shouldShowStartupUpdatePrompt("0.2.0", now)).toBe(false);

		activeAdk = "adk-b";
		expect(shouldShowStartupUpdatePrompt("0.2.0", now)).toBe(true);
		activeAdk = "adk-a";
		expect(shouldShowStartupUpdatePrompt("0.2.0", now)).toBe(false);
	});
});
