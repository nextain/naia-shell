// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getAdkPath: vi.fn<() => string | null>(() => null),
	writeNaiaUiConfig: vi.fn<
		(
			config: Record<string, unknown>,
			adkPath?: string | null,
		) => Promise<boolean>
	>(async () => true),
	loadConfig: vi.fn<() => Record<string, unknown> | null>(() => ({
		provider: "ollama",
	})),
	saveConfig: vi.fn<(config: Record<string, unknown>) => void>(),
}));

vi.mock("../adk-store", () => ({
	getAdkPath: mocks.getAdkPath,
	writeNaiaUiConfig: mocks.writeNaiaUiConfig,
}));
vi.mock("../config", () => ({
	loadConfig: mocks.loadConfig,
	saveConfig: mocks.saveConfig,
}));

import {
	UI_PREFERENCE_KEYS,
	getUiPreferencesSnapshot,
	hydrateUiPreferences,
	patchUiPreferences,
	resetUiPreferencesForTests,
	useUiPreference,
} from "../ui-preferences";

const ADK_ONE = "/tmp/adk-one";
const ADK_TWO = "/tmp/adk-two";

beforeEach(() => {
	localStorage.clear();
	resetUiPreferencesForTests();
	mocks.getAdkPath.mockReset();
	mocks.getAdkPath.mockReturnValue(ADK_ONE);
	mocks.writeNaiaUiConfig.mockReset();
	mocks.writeNaiaUiConfig.mockResolvedValue(true);
	mocks.loadConfig.mockReset();
	mocks.loadConfig.mockReturnValue({ provider: "ollama" });
	mocks.saveConfig.mockReset();
});

describe("ui preferences persistence", () => {
	it("migrates legacy values once and writes the render cache and ADK", async () => {
		localStorage.setItem("naia-chat-mode-v1", "workspace");
		localStorage.setItem("workspace-editor-zoom", "125");

		const result = await hydrateUiPreferences(null, {
			adkPath: ADK_ONE,
			canPersist: true,
		});

		expect(result).toEqual({ migrated: true, persisted: true });
		expect(getUiPreferencesSnapshot()).toEqual({
			[UI_PREFERENCE_KEYS.chatMode]: "workspace",
			[UI_PREFERENCE_KEYS.editorZoom]: 125,
		});
		expect(mocks.saveConfig).toHaveBeenCalledWith({
			provider: "ollama",
			uiPreferences: {
				[UI_PREFERENCE_KEYS.chatMode]: "workspace",
				[UI_PREFERENCE_KEYS.editorZoom]: 125,
			},
		});
		expect(mocks.writeNaiaUiConfig).toHaveBeenCalledWith(
			{
				uiPreferences: {
					[UI_PREFERENCE_KEYS.chatMode]: "workspace",
					[UI_PREFERENCE_KEYS.editorZoom]: 125,
				},
			},
			ADK_ONE,
		);
		expect(localStorage.getItem("naia-chat-mode-v1")).toBeNull();
		expect(localStorage.getItem("workspace-editor-zoom")).toBeNull();
	});

	it("migrates a valid update snooze and preserves it only in its ADK", async () => {
		const snooze = { version: "0.2.0", until: Date.UTC(2026, 8, 6) };
		localStorage.setItem("naia.updatePromptSnooze", JSON.stringify(snooze));

		const migrated = await hydrateUiPreferences(null, {
			adkPath: ADK_ONE,
			canPersist: true,
		});

		expect(migrated).toEqual({ migrated: true, persisted: true });
		expect(getUiPreferencesSnapshot()).toEqual({
			updatePromptSnooze: snooze,
		});
		expect(mocks.writeNaiaUiConfig).toHaveBeenCalledWith(
			{ uiPreferences: { updatePromptSnooze: snooze } },
			ADK_ONE,
		);
		expect(localStorage.getItem("naia.updatePromptSnooze")).toBeNull();

		resetUiPreferencesForTests();
		await hydrateUiPreferences(
			{ uiPreferences: { updatePromptSnooze: snooze } },
			{ adkPath: ADK_ONE, canPersist: true },
		);
		expect(getUiPreferencesSnapshot()).toEqual({
			updatePromptSnooze: snooze,
		});

		resetUiPreferencesForTests();
		await hydrateUiPreferences(
			{ uiPreferences: {} },
			{ adkPath: ADK_TWO, canPersist: true },
		);
		expect(getUiPreferencesSnapshot()).toEqual({});
	});

	it("does not migrate an invalid update snooze record", async () => {
		localStorage.setItem(
			"naia.updatePromptSnooze",
			JSON.stringify({ version: "0.2.0", until: "later" }),
		);

		const result = await hydrateUiPreferences(null, {
			adkPath: ADK_ONE,
			canPersist: true,
		});

		expect(result).toEqual({ migrated: false, persisted: false });
		expect(getUiPreferencesSnapshot()).toEqual({});
		expect(mocks.writeNaiaUiConfig).not.toHaveBeenCalled();
		expect(localStorage.getItem("naia.updatePromptSnooze")).not.toBeNull();
	});

	it("treats an existing empty ADK preference object as authoritative", async () => {
		localStorage.setItem("naia-chat-mode-v1", "workspace");

		const result = await hydrateUiPreferences(
			{ uiPreferences: {} },
			{ adkPath: ADK_ONE, canPersist: true },
		);

		expect(result).toEqual({ migrated: false, persisted: false });
		expect(getUiPreferencesSnapshot()).toEqual({});
		expect(mocks.writeNaiaUiConfig).not.toHaveBeenCalled();
		expect(localStorage.getItem("naia-chat-mode-v1")).toBeNull();
	});

	it("does not invent zero-valued numeric preferences from absent legacy keys", async () => {
		await hydrateUiPreferences(null, { adkPath: ADK_ONE, canPersist: false });

		expect(getUiPreferencesSnapshot()).toEqual({});
	});

	it("keeps object fallbacks stable before an ADK preference is hydrated", () => {
		const fallback = { x: 0, y: 0 };
		const { result, rerender } = renderHook(() =>
			useUiPreference("missing", fallback),
		);

		expect(result.current).toBe(fallback);
		rerender();
		expect(result.current).toBe(fallback);
	});

	it("updates the config render cache and keeps the approved ADK path", async () => {
		await hydrateUiPreferences(
			{ uiPreferences: { [UI_PREFERENCE_KEYS.chatMode]: "app" } },
			{ adkPath: ADK_ONE, canPersist: true },
		);
		mocks.saveConfig.mockClear();
		mocks.writeNaiaUiConfig.mockClear();

		const write = patchUiPreferences({
			[UI_PREFERENCE_KEYS.workspaceRailCollapsed]: true,
		});
		mocks.getAdkPath.mockReturnValue("/tmp/adk-two");
		await expect(write).resolves.toBe(true);

		expect(mocks.saveConfig).toHaveBeenCalledWith({
			provider: "ollama",
			uiPreferences: {
				[UI_PREFERENCE_KEYS.chatMode]: "app",
				[UI_PREFERENCE_KEYS.workspaceRailCollapsed]: true,
			},
		});
		expect(mocks.writeNaiaUiConfig).toHaveBeenCalledWith(
			{
				uiPreferences: {
					[UI_PREFERENCE_KEYS.chatMode]: "app",
					[UI_PREFERENCE_KEYS.workspaceRailCollapsed]: true,
				},
			},
			ADK_ONE,
		);
	});

	it("persists and reads workspaceLayout, workspaceSplitRatios, and opencodeCommand (#732)", async () => {
		expect(UI_PREFERENCE_KEYS.workspaceLayout).toBe("workspaceLayout");
		expect(UI_PREFERENCE_KEYS.workspaceSplitRatios).toBe("workspaceSplitRatios");
		expect(UI_PREFERENCE_KEYS.opencodeCommand).toBe("opencodeCommand");
		expect(UI_PREFERENCE_KEYS.workspaceQuadDocsUrl).toBe("workspaceQuadDocsUrl");
		expect(UI_PREFERENCE_KEYS.workspaceQuadBoardUrl).toBe("workspaceQuadBoardUrl");

		await hydrateUiPreferences(
			{
				uiPreferences: {
					[UI_PREFERENCE_KEYS.workspaceLayout]: "quad",
					[UI_PREFERENCE_KEYS.workspaceSplitRatios]: [0.4, 0.3, 0.3],
					[UI_PREFERENCE_KEYS.opencodeCommand]: "opencode --model sonnet",
					[UI_PREFERENCE_KEYS.workspaceQuadDocsUrl]: "http://localhost:3142/docs",
					[UI_PREFERENCE_KEYS.workspaceQuadBoardUrl]: "http://127.0.0.1:8896/",
				},
			},
			{ adkPath: ADK_ONE, canPersist: true },
		);

		const snapshot = getUiPreferencesSnapshot();
		expect(snapshot[UI_PREFERENCE_KEYS.workspaceLayout]).toBe("quad");
		expect(snapshot[UI_PREFERENCE_KEYS.workspaceSplitRatios]).toEqual([
			0.4, 0.3, 0.3,
		]);
		expect(snapshot[UI_PREFERENCE_KEYS.opencodeCommand]).toBe(
			"opencode --model sonnet",
		);
		expect(snapshot[UI_PREFERENCE_KEYS.workspaceQuadDocsUrl]).toBe(
			"http://localhost:3142/docs",
		);
		expect(snapshot[UI_PREFERENCE_KEYS.workspaceQuadBoardUrl]).toBe(
			"http://127.0.0.1:8896/",
		);

		// Patching updates snapshot and render cache
		await patchUiPreferences({
			[UI_PREFERENCE_KEYS.workspaceLayout]: "standard",
			[UI_PREFERENCE_KEYS.workspaceSplitRatios]: [0.34, 0.33, 0.33],
			[UI_PREFERENCE_KEYS.workspaceQuadBoardUrl]: "http://localhost:8896/",
		});

		const updated = getUiPreferencesSnapshot();
		expect(updated[UI_PREFERENCE_KEYS.workspaceLayout]).toBe("standard");
		expect(updated[UI_PREFERENCE_KEYS.workspaceSplitRatios]).toEqual([
			0.34, 0.33, 0.33,
		]);
		expect(updated[UI_PREFERENCE_KEYS.workspaceQuadBoardUrl]).toBe(
			"http://localhost:8896/",
		);
	});
});

