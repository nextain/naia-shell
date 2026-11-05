// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NaiaContextBridge } from "../../../lib/app-registry";
import { Logger } from "../../../lib/logger";
import { useAppStore } from "../../../stores/app";
import { createGenericInstalledApp } from "../GenericInstalledApp";
import { installInstalledAppContextBridge } from "../installed-app-context-bridge";

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
	it("UT-06 accepts context from active app iframe, ignores other sources, clears on null and unmount", () => {
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
					origin: "http://asset.localhost",
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
					origin: "http://asset.localhost",
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
					origin: "http://asset.localhost",
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

	it("IT-06 preserves context ownership across card-to-slides-to-card switches and closes", () => {
		const charcardEntry = "/home/user/.naia/apps/land.naia.charcard/index.html";
		const otherEntry = "/home/user/.naia/apps/land.naia.slides/index.html";
		const CharCardInstalled = createGenericInstalledApp(
			charcardEntry,
			[],
			"land.naia.charcard",
		);
		const OtherInstalled = createGenericInstalledApp(
			otherEntry,
			[],
			"land.naia.slides",
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
					origin: "http://asset.localhost",
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

		// Hidden keep-alive app (land.naia.slides) posts message -> ignored!
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					origin: "http://asset.localhost",
					source: otherIframe.contentWindow,
					data: {
						type: "naia-app:context",
						context: {
							type: "slides",
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

		// User switches activeApp to land.naia.slides -> clears context AND notifies charcard iframe with naia-app:context-cleared
		const charcardPostMessageSpy = vi.spyOn(
			charcardIframe.contentWindow as Window,
			"postMessage",
		);
		act(() => {
			useAppStore.getState().setActiveApp("land.naia.slides");
		});
		expect(useAppStore.getState().activeAppContext).toBeNull();
		expect(charcardPostMessageSpy).toHaveBeenCalledWith(
			{ type: "naia-app:context-cleared" },
			"http://asset.localhost",
		);

		// Previous app (land.naia.charcard) posts delayed message after switch -> ignored!
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					origin: "http://asset.localhost",
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

		// Now active app (land.naia.slides) posts context -> accepted
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					origin: "http://asset.localhost",
					source: otherIframe.contentWindow,
					data: {
						type: "naia-app:context",
						context: {
							type: "slides",
							data: { active: "other-context" },
						},
					},
				}),
			);
		});
		expect(useAppStore.getState().activeAppContext?.type).toBe("slides");

		// Both keep-alive frames remain mounted as the user switches back to the card.
		const slidesPostMessageSpy = vi.spyOn(otherIframe.contentWindow as Window, "postMessage");
		act(() => useAppStore.getState().setActiveApp("land.naia.charcard"));
		expect(useAppStore.getState().activeAppContext).toBeNull();
		expect(useAppStore.getState().activeAppContextOwnerId).toBeNull();
		expect(slidesPostMessageSpy).toHaveBeenCalledWith(
			{ type: "naia-app:context-cleared" }, "http://asset.localhost",
		);
		act(() => window.dispatchEvent(new MessageEvent("message", {
			origin: "http://asset.localhost", source: otherIframe.contentWindow,
			data: { type: "naia-app:context", context: { type: "slides", data: { stale: true } } },
		})));
		expect(useAppStore.getState().activeAppContext).toBeNull();
		act(() => window.dispatchEvent(new MessageEvent("message", {
			origin: "http://asset.localhost", source: charcardIframe.contentWindow,
			data: { type: "naia-app:context", context: { type: "charcard", data: { character: "온새미", roleplay: "돌아온 카드" } } },
		})));
		expect(useAppStore.getState().activeAppContext).toEqual({
			type: "charcard", data: { character: "온새미", roleplay: "돌아온 카드" },
		});
		expect(useAppStore.getState().activeAppContextOwnerId).toBe("land.naia.charcard");
		// Closing the inactive slides frame leaves the card context, closing its owner clears it.
		unmountOther();
		expect(useAppStore.getState().activeAppContextOwnerId).toBe("land.naia.charcard");
		unmountCharcard();
		expect(useAppStore.getState().activeAppContext).toBeNull();
		expect(useAppStore.getState().activeAppContextOwnerId).toBeNull();
	});

	it("UT-06 rejects persistent context types (e.g. bgm) and oversized payloads (>32,000 chars) and clears stale context of that app on rejection", () => {
		const warnSpy = vi.spyOn(Logger, "warn");
		const entry = "/home/user/.naia/apps/land.naia.charcard/index.html";
		const App = createGenericInstalledApp(entry, [], "land.naia.charcard");
		render(<App naia={{} as NaiaContextBridge} />);

		const iframe = screen.getByTitle("App") as HTMLIFrameElement;

		// Reject persistent type "bgm"
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					origin: "http://asset.localhost",
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
					origin: "http://asset.localhost",
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
					origin: "http://asset.localhost",
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
	it("UT-06 rejects a forged origin even from the app window", () => {
		const App = createGenericInstalledApp("/apps/land.naia.charcard/index.html", [], "land.naia.charcard");
		render(<App naia={{} as NaiaContextBridge} />);
		const iframe = screen.getByTitle("App") as HTMLIFrameElement;
		act(() => window.dispatchEvent(new MessageEvent("message", {
			source: iframe.contentWindow,
			origin: "https://evil.example",
			data: { type: "naia-app:context", context: { type: "charcard", data: { roleplay: "forged" } } },
		})));
		expect(useAppStore.getState().activeAppContext).toBeNull();
	});

	it("UT-06 rejects an unresolvable origin without a wildcard notification", () => {
		const frame = document.createElement("iframe");
		document.body.appendChild(frame);
		const send = vi.spyOn(frame.contentWindow!, "postMessage");
		const dispose = installInstalledAppContextBridge(frame, "land.naia.charcard", "not a valid URL");
		act(() => window.dispatchEvent(new MessageEvent("message", {
			source: frame.contentWindow, origin: "null",
			data: { type: "naia-app:context", context: { type: "charcard", data: { roleplay: "forged" } } },
		})));
		expect(useAppStore.getState().activeAppContext).toBeNull();
		act(() => useAppStore.getState().setActiveApp("land.naia.slides"));
		expect(send).not.toHaveBeenCalled();
		dispose();
		frame.remove();
	});

	it("IT-06 installs and removes both message bridges once per mount", () => {
		const add = vi.spyOn(window, "addEventListener");
		const remove = vi.spyOn(window, "removeEventListener");
		const App = createGenericInstalledApp("/apps/land.naia.charcard/index.html", [], "land.naia.charcard");
		const { unmount } = render(<App naia={{} as NaiaContextBridge} />);
		const listeners = add.mock.calls.filter(([type]) => type === "message").map(([, listener]) => listener);
		expect(listeners).toHaveLength(2);
		expect(new Set(listeners).size).toBe(2);
		unmount();
		for (const listener of listeners) {
			expect(remove.mock.calls.filter(([type, handler]) => type === "message" && handler === listener)).toHaveLength(1);
		}
	});

});
