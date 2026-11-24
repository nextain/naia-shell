// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	installInstalledAppHostBridge,
	INSTALLED_APP_ASK_EVENT,
	INSTALLED_APP_RESPONSE_EVENT,
	INSTALLED_APP_SPEAK_EVENT,
	INSTALLED_APP_CANCEL_EVENT,
	INSTALLED_APP_SPEECH_RESULT_EVENT,
} from "../generic-installed/installed-app-host-bridge";
import {
	createMemoryAppStorage,
	setInstalledAppStorageForTests,
} from "../generic-installed/installed-app-storage";
vi.mock("../../lib/logger", () => ({ Logger: { debug: vi.fn(), warn: vi.fn() } }));
const locale = vi.hoisted(() => ({ current: "ko" }));
vi.mock("../../lib/i18n", () => ({ getLocale: () => locale.current }));
const disposers: (() => void)[] = [];
afterEach(() => {
	disposers.splice(0).forEach((dispose) => dispose());
	vi.useRealTimers();
	locale.current = "ko";
});
function frame(id: string, permissions: string[]) {
	const el = document.createElement("iframe");
	document.body.appendChild(el);
	const target = el.contentWindow!;
	const post = vi.spyOn(target, "postMessage").mockImplementation(() => {});
	disposers.push(
		installInstalledAppHostBridge(
			el,
			"https://asset.localhost/app",
			id,
			permissions,
		),
		() => el.remove(),
	);
	return { target, post };
}
function message(
	source: Window,
	data: object,
	origin = "https://asset.localhost",
) {
	window.dispatchEvent(new MessageEvent("message", { source, origin, data }));
}
describe("installed app host bridge", () => {
	it("scopes replies by app and request and checks the frame source and origin", () => {
		const a = frame("app.a", ["model.ask"]),
			b = frame("app.b", ["model.ask"]);
		const ask = vi.fn();
		window.addEventListener(INSTALLED_APP_ASK_EVENT, ask);
		disposers.push(() =>
			window.removeEventListener(INSTALLED_APP_ASK_EVENT, ask),
		);
		message(a.target, {
			type: "naia-app:ask",
			appId: "app.b",
			id: "same",
			prompt: "bad",
		});
		message(
			a.target,
			{ type: "naia-app:ask", appId: "app.a", id: "same", prompt: "bad" },
			"https://evil.invalid",
		);
		expect(ask).not.toHaveBeenCalled();
		message(a.target, {
			type: "naia-app:ask",
			appId: "app.a",
			id: "same",
			prompt: "question",
		});
		message(b.target, {
			type: "naia-app:ask",
			appId: "app.b",
			id: "same",
			prompt: "question",
		});
		expect(ask).toHaveBeenCalledTimes(2);
		expect((ask.mock.calls[0][0] as CustomEvent).detail).toMatchObject({
			appId: "app.a",
			requestId: "same",
			prompt: "question",
		});
		expect((ask.mock.calls[1][0] as CustomEvent).detail).toMatchObject({
			appId: "app.b",
			requestId: "same",
			prompt: "question",
		});
		window.dispatchEvent(
			new CustomEvent(INSTALLED_APP_RESPONSE_EVENT, {
				detail: { appId: "app.a", requestId: "same", text: "answer" },
			}),
		);
		expect(a.post).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "naia-app:response",
				id: "same",
				text: "answer",
			}),
			"https://asset.localhost",
		);
		expect(b.post).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: "naia-app:response" }),
			expect.anything(),
		);
	});
	it("rejects missing permission and invalid or oversized prompts", () => {
		const a = frame("app.a", []),
			b = frame("app.b", ["model.ask"]);
		message(a.target, {
			type: "naia-app:ask",
			appId: "app.a",
			id: "1",
			prompt: "hello",
		});
		expect(a.post).toHaveBeenCalledWith(
			expect.objectContaining({ error: "permission_denied", text: "" }),
			expect.anything(),
		);
		message(b.target, {
			type: "naia-app:ask",
			appId: "app.b",
			id: "2",
			prompt: "x".repeat(9001),
		});
		expect(b.post).toHaveBeenCalledWith(
			expect.objectContaining({ error: "invalid_prompt", text: "" }),
			expect.anything(),
		);
		message(a.target, {
			type: "naia-app:speak",
			appId: "app.a",
			id: "3",
			text: "hello",
		});
		expect(a.post).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "naia-app:speech-result",
				id: "3",
				status: "failed",
				error: "permission_denied",
			}),
			expect.anything(),
		);
		const c = frame("app.c", ["speech"]);
		message(c.target, {
			type: "naia-app:speak",
			appId: "app.c",
			id: "4",
			text: "x".repeat(2001),
		});
		expect(c.post).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "naia-app:speech-result",
				id: "4",
				status: "failed",
				error: "invalid_text",
			}),
			expect.anything(),
		);
	});
	it("delivers speech completion, cancellation, and locale updates", () => {
		const a = frame("app.a", ["speech", "locale"]);
		const speak = vi.fn(),
			cancel = vi.fn();
		window.addEventListener(INSTALLED_APP_SPEAK_EVENT, speak);
		window.addEventListener(INSTALLED_APP_CANCEL_EVENT, cancel);
		disposers.push(() => {
			window.removeEventListener(INSTALLED_APP_SPEAK_EVENT, speak);
			window.removeEventListener(INSTALLED_APP_CANCEL_EVENT, cancel);
		});
		expect(a.post).toHaveBeenCalledWith(
			{ type: "naia-app:locale", locale: "ko" },
			expect.anything(),
		);
		locale.current = "en";
		window.dispatchEvent(new Event("naia:locale-change"));
		expect(a.post).toHaveBeenLastCalledWith(
			{ type: "naia-app:locale", locale: "en" },
			expect.anything(),
		);
		message(a.target, {
			type: "naia-app:speak",
			appId: "app.a",
			id: "1",
			text: "hello",
		});
		expect(speak).toHaveBeenCalledOnce();
		expect((speak.mock.calls[0][0] as CustomEvent).detail).toMatchObject({
			appId: "app.a",
			requestId: "1",
			text: "hello",
		});
		message(a.target, {
			type: "naia-app:speak-cancel",
			appId: "app.a",
			id: "1",
		});
		expect(cancel).toHaveBeenCalledOnce();
		window.dispatchEvent(
			new CustomEvent(INSTALLED_APP_SPEECH_RESULT_EVENT, {
				detail: { appId: "app.a", requestId: "1", status: "cancelled" },
			}),
		);
		expect(a.post).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "naia-app:speech-result",
				id: "1",
				status: "cancelled",
			}),
			expect.anything(),
		);
	});
	it("rejects duplicate ids while allowing the original ask and speech to finish", () => {
		const a = frame("app.a", ["model.ask", "speech"]);
		const ask = vi.fn(),
			speak = vi.fn();
		window.addEventListener(INSTALLED_APP_ASK_EVENT, ask);
		window.addEventListener(INSTALLED_APP_SPEAK_EVENT, speak);
		disposers.push(() => {
			window.removeEventListener(INSTALLED_APP_ASK_EVENT, ask);
			window.removeEventListener(INSTALLED_APP_SPEAK_EVENT, speak);
		});
		const question = {
			type: "naia-app:ask",
			appId: "app.a",
			id: "same",
			prompt: "question",
		};
		const speech = {
			type: "naia-app:speak",
			appId: "app.a",
			id: "same",
			text: "hello",
		};
		message(a.target, question);
		message(a.target, question);
		message(a.target, speech);
		message(a.target, speech);
		expect(ask).toHaveBeenCalledOnce();
		expect(speak).toHaveBeenCalledOnce();
		expect(a.post).toHaveBeenCalledWith(
			{
				type: "naia-app:response",
				id: "same",
				text: "",
				error: "duplicate_id",
			},
			expect.anything(),
		);
		expect(a.post).toHaveBeenCalledWith(
			{
				type: "naia-app:speech-result",
				id: "same",
				status: "failed",
				error: "duplicate_id",
			},
			expect.anything(),
		);
		window.dispatchEvent(
			new CustomEvent(INSTALLED_APP_RESPONSE_EVENT, {
				detail: { appId: "app.a", requestId: "same", text: "answer" },
			}),
		);
		window.dispatchEvent(
			new CustomEvent(INSTALLED_APP_SPEECH_RESULT_EVENT, {
				detail: { appId: "app.a", requestId: "same", status: "finished" },
			}),
		);
		expect(a.post).toHaveBeenCalledWith(
			expect.objectContaining({ type: "naia-app:response", text: "answer" }),
			expect.anything(),
		);
		expect(a.post).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "naia-app:speech-result",
				status: "finished",
			}),
			expect.anything(),
		);
	});
	it("settles a missing consumer with an empty timeout response", () => {
		vi.useFakeTimers();
		const a = frame("app.a", ["model.ask"]);
		message(a.target, {
			type: "naia-app:ask",
			appId: "app.a",
			id: "1",
			prompt: "hello",
		});
		vi.advanceTimersByTime(120000);
		expect(a.post).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "naia-app:response",
				id: "1",
				text: "",
				error: "timeout",
			}),
			expect.anything(),
		);
	});
	describe("R11 web: shell-kept storage for sandboxed apps", () => {
		const flush = () => new Promise((r) => setTimeout(r, 0));
		afterEach(() => setInstalledAppStorageForTests(null));
		const results = (post: ReturnType<typeof vi.fn> | { mock: { calls: unknown[][] } }) =>
			post.mock.calls
				.map((c) => c[0] as { type?: string })
				.filter((m) => m?.type === "naia-app:storage-result");
		it("R11 saves, reads, lists and deletes values scoped to the calling app", async () => {
			setInstalledAppStorageForTests(createMemoryAppStorage());
			const a = frame("land.naia.charcard", ["storage"]);
			const b = frame("app.other", ["storage"]);
			message(a.target, { type: "naia-app:storage", appId: "land.naia.charcard", id: "s1", op: "set", key: "card:1", value: { name: "미나" } });
			await flush();
			message(a.target, { type: "naia-app:storage", appId: "land.naia.charcard", id: "s2", op: "get", key: "card:1" });
			message(a.target, { type: "naia-app:storage", appId: "land.naia.charcard", id: "s3", op: "keys" });
			message(b.target, { type: "naia-app:storage", appId: "app.other", id: "s4", op: "get", key: "card:1" });
			// A frame cannot speak for another app id.
			message(b.target, { type: "naia-app:storage", appId: "land.naia.charcard", id: "s5", op: "get", key: "card:1" });
			await flush();
			expect(results(a.post)).toEqual([
				{ type: "naia-app:storage-result", id: "s1", ok: true },
				{ type: "naia-app:storage-result", id: "s2", ok: true, value: { name: "미나" } },
				{ type: "naia-app:storage-result", id: "s3", ok: true, keys: ["card:1"] },
			]);
			expect(results(b.post)).toEqual([
				{ type: "naia-app:storage-result", id: "s4", ok: true, value: null },
			]);
			message(a.target, { type: "naia-app:storage", appId: "land.naia.charcard", id: "s6", op: "delete", key: "card:1" });
			await flush();
			message(a.target, { type: "naia-app:storage", appId: "land.naia.charcard", id: "s7", op: "keys" });
			await flush();
			expect(results(a.post).at(-1)).toEqual({ type: "naia-app:storage-result", id: "s7", ok: true, keys: [] });
		});
		it("R11 refuses apps without the storage permission and bad requests", async () => {
			setInstalledAppStorageForTests(createMemoryAppStorage());
			const denied = frame("app.nostore", ["model.ask"]);
			message(denied.target, { type: "naia-app:storage", appId: "app.nostore", id: "d1", op: "keys" });
			const ok = frame("app.store", ["storage"]);
			message(ok.target, { type: "naia-app:storage", appId: "app.store", id: "k1", op: "get", key: "" });
			message(ok.target, { type: "naia-app:storage", appId: "app.store", id: "k2", op: "set", key: "big", value: "x".repeat(8 * 1024 * 1024 + 1) });
			message(ok.target, { type: "naia-app:storage", appId: "app.store", id: "k3", op: "drop", key: "a" });
			await flush();
			expect(results(denied.post)).toEqual([
				{ type: "naia-app:storage-result", id: "d1", ok: false, error: "permission_denied" },
			]);
			expect(results(ok.post).map((m) => (m as { error?: string }).error)).toEqual([
				"invalid_key",
				"too_large",
				"invalid_op",
			]);
		});
		it("R11 reports unavailable storage instead of throwing", async () => {
			const broken = createMemoryAppStorage();
			broken.get = async () => {
				throw new Error("blocked");
			};
			setInstalledAppStorageForTests(broken);
			const a = frame("app.store", ["storage"]);
			message(a.target, { type: "naia-app:storage", appId: "app.store", id: "u1", op: "get", key: "a" });
			await flush();
			expect(results(a.post)).toEqual([
				{ type: "naia-app:storage-result", id: "u1", ok: false, error: "unavailable" },
			]);
		});
	});
});
