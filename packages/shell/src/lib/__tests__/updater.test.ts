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

const check = vi.fn();
const relaunch = vi.fn();

vi.mock("@tauri-apps/plugin-updater", () => ({ check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch }));

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
		const downloadAndInstall = vi.fn().mockResolvedValue(undefined);
		check.mockResolvedValue({
			currentVersion: "0.1.9",
			version: "0.2.0",
			body: "Signed updater recovery",
			downloadAndInstall,
		});

		const update = await checkForUpdate();
		expect(update).toMatchObject({
			currentVersion: "0.1.9",
			version: "0.2.0",
			body: "Signed updater recovery",
		});
		await update?.installFn();
		expect(downloadAndInstall).toHaveBeenCalledOnce();
		expect(relaunch).toHaveBeenCalledOnce();
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
