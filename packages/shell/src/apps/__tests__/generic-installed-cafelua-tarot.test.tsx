// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { NaiaContextBridge } from "../../lib/app-registry";
import { useAppStore } from "../../stores/app";
import { createGenericInstalledApp } from "../generic-installed/GenericInstalledApp";
import {
	CAFE_LUA_TAROT_APP_ID,
	CAFE_LUA_TAROT_ASK_EVENT,
	CAFE_LUA_TAROT_RESPONSE_EVENT,
	installCafeLuaTarotHostBridge,
} from "../generic-installed/cafelua-tarot-host-bridge";

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(),
	convertFileSrc: (path: string) => `http://asset.localhost/${encodeURIComponent(path)}`,
}));

describe("installed Cafe Lua Tarot host bridge", () => {
	afterEach(() => {
		cleanup();
		document.body.replaceChildren();
		useAppStore.setState({ activeApp: null });
		vi.restoreAllMocks();
	});

	it("wires the bridge only for the installed tarot app", () => {
		const App = createGenericInstalledApp("/apps/tarot/index.html", [], CAFE_LUA_TAROT_APP_ID);
		useAppStore.setState({ activeApp: CAFE_LUA_TAROT_APP_ID });
		const { container } = render(<App naia={{} as NaiaContextBridge} />);
		const frame = container.querySelector("iframe")!;
		const forwarded = vi.fn();
		window.addEventListener(CAFE_LUA_TAROT_ASK_EVENT, forwarded);
		window.dispatchEvent(new MessageEvent("message", {
			source: frame.contentWindow, origin: new URL(frame.src).origin,
			data: { type: "naia-cafelua-tarot:ask", appId: CAFE_LUA_TAROT_APP_ID, id: "wired", prompt: "Interpret." },
		}));
		expect(forwarded).toHaveBeenCalledOnce();
		window.removeEventListener(CAFE_LUA_TAROT_ASK_EVENT, forwarded);
	});

	it("accepts only its active iframe and returns the Naia reply to that iframe", () => {
		const frame = document.createElement("iframe");
		frame.src = "http://asset.localhost/apps/cafelua-tarot/index.html";
		document.body.append(frame);
		const target = frame.contentWindow!;
		const origin = new URL(frame.src).origin;
		const posted: unknown[] = [];
		vi.spyOn(target, "postMessage").mockImplementation((message) => {
			posted.push(message);
		});
		useAppStore.setState({ activeApp: CAFE_LUA_TAROT_APP_ID });
		const dispose = installCafeLuaTarotHostBridge(frame, frame.src);
		const forwarded = vi.fn();
		window.addEventListener(CAFE_LUA_TAROT_ASK_EVENT, forwarded);
		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					type: "naia-cafelua-tarot:ask",
					appId: CAFE_LUA_TAROT_APP_ID,
					id: "reading-1",
					prompt: "Interpret the revealed card.",
				},
				origin,
				source: target,
			}),
		);
		expect(forwarded).toHaveBeenCalledOnce();
		expect((forwarded.mock.calls[0][0] as CustomEvent).detail).toEqual({
			requestId: "reading-1",
			prompt: "Interpret the revealed card.",
		});

		window.dispatchEvent(
			new CustomEvent(CAFE_LUA_TAROT_RESPONSE_EVENT, {
				detail: { requestId: "reading-1", text: "Naia's interpretation." },
			}),
		);
		expect(posted[posted.length - 1]).toEqual({
			type: "naia-cafelua-tarot:response",
			id: "reading-1",
			text: "Naia's interpretation.",
			error: undefined,
		});
		dispose();
		window.removeEventListener(CAFE_LUA_TAROT_ASK_EVENT, forwarded);
	});

	it("rejects wrong iframe, wrong origin, inactive app, and oversized prompt messages", () => {
		const frame = document.createElement("iframe");
		frame.src = "http://asset.localhost/apps/cafelua-tarot/index.html";
		const other = document.createElement("iframe");
		other.src = "http://asset.localhost/apps/other/index.html";
		document.body.append(frame, other);
		const origin = new URL(frame.src).origin;
		useAppStore.setState({ activeApp: "another-app" });
		const dispose = installCafeLuaTarotHostBridge(frame, frame.src);
		const forwarded = vi.fn();
		window.addEventListener(CAFE_LUA_TAROT_ASK_EVENT, forwarded);
		const ask = (source: Window, eventOrigin: string, prompt: string) =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "naia-cafelua-tarot:ask",
						appId: CAFE_LUA_TAROT_APP_ID,
						id: "reading-2",
						prompt,
					},
					origin: eventOrigin,
					source,
				}),
			);
		ask(frame.contentWindow!, origin, "valid but inactive");
		useAppStore.setState({ activeApp: CAFE_LUA_TAROT_APP_ID });
		ask(other.contentWindow!, origin, "wrong source");
		ask(frame.contentWindow!, "https://attacker.example", "wrong origin");
		ask(frame.contentWindow!, origin, "x".repeat(9_001));
		expect(forwarded).not.toHaveBeenCalled();
		dispose();
		window.removeEventListener(CAFE_LUA_TAROT_ASK_EVENT, forwarded);
	});
});
