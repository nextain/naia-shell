// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installInstalledAppContextBridge } from "../generic-installed/installed-app-context-bridge";
import { selectPromptAppContexts, useAppStore } from "../../stores/app";
vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../lib/logger", () => ({
	Logger: { debug: vi.fn(), warn: vi.fn() },
}));
let dispose: (() => void) | undefined;
let frame: HTMLIFrameElement;
beforeEach(() => {
	useAppStore.setState({
		activeApp: "land.naia.charcard",
		activeAppContext: null,
		activeAppContextOwnerId: null,
		persistentAppContexts: {},
	});
	frame = document.createElement("iframe");
	frame.src = "https://asset.localhost/apps/land.naia.charcard/index.html";
	document.body.appendChild(frame);
	dispose = installInstalledAppContextBridge(frame, "land.naia.charcard");
});
afterEach(() => {
	dispose?.();
	frame.remove();
});
function push(context: unknown, origin = "https://asset.localhost") {
	window.dispatchEvent(
		new MessageEvent("message", {
			source: frame.contentWindow,
			origin,
			data: { type: "naia-app:context", context },
		}),
	);
}
it("binds transient context to its frame, origin and active owner, preserving shell BGM", () => {
	useAppStore
		.getState()
		.setActiveAppContext({ type: "bgm", data: { title: "music" } });
	push({ type: "charcard", data: { name: "One" } }, "https://evil.invalid");
	expect(useAppStore.getState().activeAppContext).toBeNull();
	push({ type: "bgm", data: { title: "spoof" } });
	expect(useAppStore.getState().persistentAppContexts.bgm.data.title).toBe(
		"music",
	);
	push({ type: "charcard", data: { name: "One" } });
	expect(useAppStore.getState().activeAppContextOwnerId).toBe(
		"land.naia.charcard",
	);
	expect(
		selectPromptAppContexts(useAppStore.getState()).map((c) => c.type),
	).toEqual(["charcard", "bgm"]);
	expect(
		selectPromptAppContexts(useAppStore.getState(), true).map((c) => c.type),
	).toEqual(["bgm"]);
	useAppStore.getState().setActiveApp("workspace");
	push({ type: "charcard", data: { name: "hidden" } });
	expect(useAppStore.getState().activeAppContext).toBeNull();
	expect(
		selectPromptAppContexts(useAppStore.getState(), true).map((c) => c.type),
	).toEqual(["bgm"]);
});
it("does not clear another app's context when an old bridge unmounts", () => {
	push({ type: "charcard", data: { name: "One" } });
	useAppStore.getState().setActiveApp("other");
	useAppStore
		.getState()
		.setActiveAppContext({ type: "other", data: { value: 1 } }, "other");
	dispose?.();
	dispose = undefined;
	expect(useAppStore.getState().activeAppContext?.type).toBe("other");
});
it("removes rejected oversized context previously owned by this frame", () => {
	push({ type: "charcard", data: { name: "One" } });
	push({ type: "charcard", data: { text: "x".repeat(32000) } });
	expect(useAppStore.getState().activeAppContext).toBeNull();
});
