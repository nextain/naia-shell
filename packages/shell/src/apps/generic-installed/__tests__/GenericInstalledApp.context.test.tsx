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
		activeAppContextOwnerId: null,
		persistentAppContexts: {},
	});
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("GenericInstalledApp naia-app:context bridge", () => {
	it("accepts context from active app iframe, ignores other sources, clears on null and unmount", () => {
		const entry = "/home/user/.naia/apps/land.naia.charcard/index.html";
		const App = createGenericInstalledApp(entry, [], "land.naia.charcard");
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
		expect(useAppStore.getState().activeAppContextOwnerId).toBe(
			"land.naia.charcard",
		);

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

	it("ignores messages from hidden keep-alive apps, ignores previous app after switch, and unmounts without clearing another app's context", () => {
		const charcardEntry = "/home/user/.naia/apps/land.naia.charcard/index.html";
		const otherEntry = "/home/user/.naia/apps/land.naia.other/index.html";
		const CharCardInstalled = createGenericInstalledApp(
			charcardEntry,
			[],
			"land.naia.charcard",
		);
		const OtherInstalled = createGenericInstalledApp(
			otherEntry,
			[],
			"land.naia.other",
		);

		const { unmount: unmountCharcard } = render(
			<CharCardInstalled naia={{} as NaiaContextBridge} />,
		);
		const { unmount: unmountOther } = render(
			<OtherInstalled naia={{} as NaiaContextBridge} />,
		);

		const iframes = screen.getAllByTitle("App") as HTMLIFrameElement[];
		const charcardIframe = iframes[0];
		const otherIframe = iframes[1];

		// Active app is land.naia.charcard -> message from charcard is accepted
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					source: charcardIframe.contentWindow,
					data: {
						type: "naia-app:context",
						context: {
							type: "charcard",
							data: { character: "온새미", roleplay: "활성 앱 문맥" },
						},
					},
				}),
			);
		});
		expect(useAppStore.getState().activeAppContext?.data).toEqual({
			character: "온새미",
			roleplay: "활성 앱 문맥",
		});

		// Hidden keep-alive app (land.naia.other) posts message -> ignored!
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					source: otherIframe.contentWindow,
					data: {
						type: "naia-app:context",
						context: {
							type: "other",
							data: { hijack: true },
						},
					},
				}),
			);
		});
		expect(useAppStore.getState().activeAppContext?.type).toBe("charcard");
		expect(useAppStore.getState().activeAppContextOwnerId).toBe(
			"land.naia.charcard",
		);

		// User switches activeApp to land.naia.other
		act(() => {
			useAppStore.getState().setActiveApp("land.naia.other");
		});
		expect(useAppStore.getState().activeAppContext).toBeNull();

		// Previous app (land.naia.charcard) posts delayed message after switch -> ignored!
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					source: charcardIframe.contentWindow,
					data: {
						type: "naia-app:context",
						context: {
							type: "charcard",
							data: { character: "온새미", roleplay: "이전 앱 지연 문맥" },
						},
					},
				}),
			);
		});
		expect(useAppStore.getState().activeAppContext).toBeNull();

		// Now active app (land.naia.other) posts context -> accepted
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					source: otherIframe.contentWindow,
					data: {
						type: "naia-app:context",
						context: {
							type: "other",
							data: { active: "other-context" },
						},
					},
				}),
			);
		});
		expect(useAppStore.getState().activeAppContext?.type).toBe("other");

		// Unmounting charcard does NOT clear other's active context
		unmountCharcard();
		expect(useAppStore.getState().activeAppContext?.type).toBe("other");

		// Unmounting other clears its own context
		unmountOther();
		expect(useAppStore.getState().activeAppContext).toBeNull();
	});

	it("rejects persistent context types (e.g. bgm) and oversized payloads (>32,000 chars) and clears stale context of that app on rejection", () => {
		const warnSpy = vi.spyOn(Logger, "warn");
		const entry = "/home/user/.naia/apps/land.naia.charcard/index.html";
		const App = createGenericInstalledApp(entry, [], "land.naia.charcard");
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

		// First push a valid context from charcard
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					source: iframe.contentWindow,
					data: {
						type: "naia-app:context",
						context: {
							type: "charcard",
							data: { roleplay: "이전 정상 문맥" },
						},
					},
				}),
			);
		});
		expect(useAppStore.getState().activeAppContext?.data).toEqual({
			roleplay: "이전 정상 문맥",
		});

		// Reject oversized context (>32,000 JSON chars) and verify previous stale context is cleared
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
