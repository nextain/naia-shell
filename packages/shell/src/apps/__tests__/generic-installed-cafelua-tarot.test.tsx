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

it("routes authorized tarot speech, cancellation and matching results without slide leaks", () => {
	const frame = document.createElement("iframe");
	const other = document.createElement("iframe");
	frame.src = "http://asset.localhost/apps/tarot";
	other.src = "http://asset.localhost/apps/other";
	document.body.append(frame, other);
	const target = frame.contentWindow!;
	const origin = new URL(frame.src).origin;
	const post = vi.spyOn(target, "postMessage");
	const otherPost = vi.spyOn(other.contentWindow!, "postMessage");
	const speak = vi.fn();
	const cancel = vi.fn();
	window.addEventListener("naia:cafelua-tarot:speak", speak);
	window.addEventListener("naia:cafelua-tarot:cancel", cancel);
	useAppStore.setState({ activeApp: CAFE_LUA_TAROT_APP_ID });
	const dispose = installCafeLuaTarotHostBridge(frame, frame.src);
	const send = (source: Window, eventOrigin: string, data: object) =>
		window.dispatchEvent(
			new MessageEvent("message", { source, origin: eventOrigin, data }),
		);
	const data = {
		type: "naia-cafelua-tarot:speak",
		appId: CAFE_LUA_TAROT_APP_ID,
		id: "book-1",
		page: 1,
		text: "Original",
	};
	send(other.contentWindow!, origin, data);
	send(target, "https://wrong.example", data);
	send(target, origin, { ...data, text: "x".repeat(2001) });
	useAppStore.setState({ activeApp: "other" });
	send(target, origin, data);
	expect(speak).not.toHaveBeenCalled();
	useAppStore.setState({ activeApp: CAFE_LUA_TAROT_APP_ID });
	send(target, origin, data);
	expect(speak).toHaveBeenCalledOnce();
	expect((speak.mock.calls[0][0] as CustomEvent).detail).toMatchObject({
		requestId: "book-1",
		text: "Original",
	});
	window.dispatchEvent(
		new CustomEvent("naia:slide-presenter-speech-result", {
			detail: { requestId: "book-1", status: "finished" },
		}),
	);
	window.dispatchEvent(
		new CustomEvent("naia:cafelua-tarot:speech-result", {
			detail: { requestId: "other", status: "finished" },
		}),
	);
	expect(
		post.mock.calls.some(
			([m]) => m.type === "naia-cafelua-tarot:speech-result",
		),
	).toBe(false);
	send(target, origin, { ...data, type: "naia-cafelua-tarot:cancel" });
	expect(cancel).toHaveBeenCalledOnce();
	window.dispatchEvent(
		new CustomEvent("naia:cafelua-tarot:speech-result", {
			detail: { requestId: "book-1", status: "cancelled" },
		}),
	);
	expect(post).toHaveBeenCalledWith(
		{
			type: "naia-cafelua-tarot:speech-result",
			id: "book-1",
			status: "cancelled",
		},
		origin,
	);
	expect(otherPost).not.toHaveBeenCalled();
	dispose();
	window.removeEventListener("naia:cafelua-tarot:speak", speak);
	window.removeEventListener("naia:cafelua-tarot:cancel", cancel);
	document.body.replaceChildren();
	useAppStore.setState({ activeApp: null });
	vi.restoreAllMocks();
});
