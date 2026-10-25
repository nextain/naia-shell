// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NaiaContextBridge } from "../../../lib/app-registry";
import { Logger } from "../../../lib/logger";
import { useAppStore } from "../../../stores/app";
import { createGenericInstalledApp } from "../GenericInstalledApp";

vi.mock("../../../lib/slides-host-bridge", () => ({
	installSlidesHostBridge: vi.fn(() => vi.fn()),
}));

vi.mock("../../../lib/slides-files-bridge", () => ({
	installSlidesFilesBridge: vi.fn(() => vi.fn()),
}));

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(() => Promise.resolve()),
	convertFileSrc: (path: string) =>
		`asset://localhost/${encodeURIComponent(path)}`,
}));

beforeEach(() => {
	useAppStore.setState({
		activeApp: "land.naia.charcard",
		activeAppContext: null,
		persistentAppContexts: {},
	});
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("GenericInstalledApp naia-app:context bridge", () => {
	it("accepts context from matching iframe contentWindow, ignores other sources, clears on null and unmount", () => {
		const entry = "/home/user/.naia/apps/land.naia.charcard/index.html";
		const App = createGenericInstalledApp(entry);
		const { unmount } = render(<App naia={{} as NaiaContextBridge} />);

		const iframe = screen.getByTitle("App") as HTMLIFrameElement;
		expect(iframe.contentWindow).not.toBeNull();

		// 1. Message from another source (e.g. window itself) is ignored
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					source: window,
					data: {
						type: "naia-app:context",
						context: { type: "charcard", data: { roleplay: "spoofed" } },
					},
				}),
			);
		});
		expect(useAppStore.getState().activeAppContext).toBeNull();

		// 2. Valid message from iframe.contentWindow updates store
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					source: iframe.contentWindow,
					data: {
						type: "naia-app:context",
						context: {
							type: "charcard",
							data: { character: "온새미", roleplay: "온실의 식물학자" },
						},
					},
				}),
			);
		});
		expect(useAppStore.getState().activeAppContext).toEqual({
			type: "charcard",
			data: { character: "온새미", roleplay: "온실의 식물학자" },
		});

		// 3. Null context clears activeAppContext
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					source: iframe.contentWindow,
					data: {
						type: "naia-app:context",
						context: null,
					},
				}),
			);
		});
		expect(useAppStore.getState().activeAppContext).toBeNull();

		// 4. Re-push and unmount clears context pushed by this app
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					source: iframe.contentWindow,
					data: {
						type: "naia-app:context",
						context: {
							type: "charcard",
							data: { character: "한도윤", roleplay: "시계공" },
						},
					},
				}),
			);
		});
		expect(useAppStore.getState().activeAppContext?.type).toBe("charcard");

		unmount();
		expect(useAppStore.getState().activeAppContext).toBeNull();
	});

	it("rejects persistent context types (e.g. bgm) and oversized payloads (>32,000 chars) with Logger.warn", () => {
		const warnSpy = vi.spyOn(Logger, "warn");
		const entry = "/home/user/.naia/apps/land.naia.charcard/index.html";
		const App = createGenericInstalledApp(entry);
		render(<App naia={{} as NaiaContextBridge} />);

		const iframe = screen.getByTitle("App") as HTMLIFrameElement;

		// Reject persistent type "bgm"
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					source: iframe.contentWindow,
					data: {
						type: "naia-app:context",
						context: {
							type: "bgm",
							data: { track: "hijack" },
						},
					},
				}),
			);
		});
		expect(useAppStore.getState().activeAppContext).toBeNull();
		expect(useAppStore.getState().persistentAppContexts).toEqual({});
		expect(warnSpy).toHaveBeenCalledWith(
			"InstalledAppContextBridge",
			"rejected installed app context",
			expect.objectContaining({
				reason: expect.stringContaining("bgm"),
			}),
		);

		// Reject oversized context (>32,000 JSON chars)
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					source: iframe.contentWindow,
					data: {
						type: "naia-app:context",
						context: {
							type: "charcard",
							data: { roleplay: "가".repeat(33_000) },
						},
					},
				}),
			);
		});
		expect(useAppStore.getState().activeAppContext).toBeNull();
		expect(warnSpy).toHaveBeenCalledWith(
			"InstalledAppContextBridge",
			"rejected installed app context",
			expect.objectContaining({
				reason: expect.stringContaining("32000"),
			}),
		);
	});
});
