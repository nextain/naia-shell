// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../stores/app";
import {
	CAFE_LUA_TAROT_APP_ID,
	CAFE_LUA_TAROT_ASK_EVENT,
	CAFE_LUA_TAROT_RESPONSE_EVENT,
	installCafeLuaTarotHostBridge,
} from "../generic-installed/cafelua-tarot-host-bridge";

describe("installed Cafe Lua Tarot host bridge", () => {
	afterEach(() => {
		document.body.replaceChildren();
		useAppStore.setState({ activeApp: null });
		vi.restoreAllMocks();
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
		expect(posted[posted.length - 1]).toEqual({
			type: "naia-cafelua-tarot:accepted",
			id: "reading-1",
		});
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
		const posted = vi.spyOn(frame.contentWindow!, "postMessage");
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
		expect(
			posted.mock.calls.some(
				([message]) => message.type === "naia-cafelua-tarot:accepted",
			),
		).toBe(false);
		dispose();
		window.removeEventListener(CAFE_LUA_TAROT_ASK_EVENT, forwarded);
	});
});
