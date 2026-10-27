// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Book, readErrors, readRequests } from "../Book";
import { APP_LOCALES } from "../i18n";
vi.mock("../library-dom-pagination", () => ({
	alignChapterStartsToSpreads: () => [],
	measureRenderedReaderPages: () => [],
}));
describe("book read button bridge", () => {
	let parent: Window;
	let post: ReturnType<typeof vi.fn>;
	beforeEach(() => {
		vi.useFakeTimers();
		parent = window.parent;
		post = vi.fn();
		Object.defineProperty(window, "parent", {
			configurable: true,
			value: { postMessage: post },
		});
		vi.stubGlobal("matchMedia", () => ({
			matches: false,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		}));
		vi.stubGlobal(
			"ResizeObserver",
			class {
				observe() {}
				disconnect() {}
			},
		);
		Object.defineProperty(document, "fonts", {
			configurable: true,
			value: { ready: Promise.resolve() },
		});
	});
	afterEach(() => {
		cleanup();
		Object.defineProperty(window, "parent", {
			configurable: true,
			value: parent,
		});
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});
	function reply(type: string, id: string, error?: string) {
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					source: window.parent,
					data: { type, id, error },
				}),
			),
		);
	}
	it("sends one request, waits for acceptance and response, reports failure and permits retry", () => {
		render(<Book locale="ko" onBack={() => {}} />);
		const button = screen.getByRole("button", { name: "나이아 낭독" });
		fireEvent.click(button);
		fireEvent.click(button);
		expect(post).toHaveBeenCalledTimes(1);
		const ask = post.mock.calls[0][0];
		expect(ask).toMatchObject({
			type: "naia-cafelua-tarot:ask",
			appId: "land.naia.cafelua-tarot",
			prompt: readRequests.ko,
		});
		expect(ask.id).toMatch(/^[\w-]{1,100}$/);
		reply("naia-cafelua-tarot:accepted", ask.id);
		act(() => vi.advanceTimersByTime(4000));
		fireEvent.click(button);
		expect(post).toHaveBeenCalledTimes(1);
		reply("naia-cafelua-tarot:response", ask.id, "failure");
		expect(screen.getByRole("status").textContent).toBe(readErrors.ko);
		fireEvent.click(button);
		expect(post).toHaveBeenCalledTimes(2);
	});
	it("falls back after an unaccepted request and allows retry", () => {
		render(<Book locale="en" onBack={() => {}} />);
		const button = screen.getByRole("button", { name: "Naia reads" });
		fireEvent.click(button);
		reply("naia-cafelua-tarot:accepted", "different-id");
		act(() => vi.advanceTimersByTime(3000));
		expect(screen.getByRole("status").textContent).toBe(
			"Ask Naia to read aloud.",
		);
		fireEvent.click(button);
		expect(post).toHaveBeenCalledTimes(2);
	});
	it("ignores late and mismatched acceptance without disturbing a retry", () => {
		render(<Book locale="en" onBack={() => {}} />);
		const button = screen.getByRole("button", { name: "Naia reads" });
		fireEvent.click(button);
		const firstId = post.mock.calls[0][0].id;
		act(() => vi.advanceTimersByTime(3000));
		expect(screen.getByRole("status").textContent).toBe(
			"Ask Naia to read aloud.",
		);
		reply("naia-cafelua-tarot:accepted", firstId);
		expect(screen.getByRole("status").textContent).toBe(
			"Ask Naia to read aloud.",
		);
		fireEvent.click(button);
		const nextId = post.mock.calls[1][0].id;
		reply("naia-cafelua-tarot:accepted", firstId);
		reply("naia-cafelua-tarot:accepted", "different-id");
		act(() => vi.advanceTimersByTime(3000));
		expect(screen.getByRole("status").textContent).toBe(
			"Ask Naia to read aloud.",
		);
		fireEvent.click(button);
		expect(post).toHaveBeenCalledTimes(3);
		expect(nextId).not.toBe(firstId);
	});
	it("clears the pending acceptance timer on unmount", () => {
		const { unmount } = render(<Book locale="en" onBack={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: "Naia reads" }));
		const id = post.mock.calls[0][0].id;
		unmount();
		expect(vi.getTimerCount()).toBe(0);
		act(() => vi.advanceTimersByTime(4000));
		reply("naia-cafelua-tarot:accepted", id);
		reply("naia-cafelua-tarot:response", id, "failure");
		expect(screen.queryByRole("status")).toBeNull();
		expect(vi.getTimerCount()).toBe(0);
	});
	it("shows the hint immediately in standalone mode", () => {
		Object.defineProperty(window, "parent", {
			configurable: true,
			value: window,
		});
		render(<Book locale="en" onBack={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: "Naia reads" }));
		expect(screen.getByRole("status").textContent).toBe(
			"Ask Naia to read aloud.",
		);
		expect(post).not.toHaveBeenCalled();
	});
	it("provides requests and failure messages in all 14 languages", () => {
		for (const locale of APP_LOCALES) {
			// The request is shown in chat as the user's message: no tool names.
			expect(readRequests[locale].trim()).not.toBe("");
			expect(readRequests[locale]).not.toMatch(/skill_|read_aloud|_/);
			expect(readErrors[locale].trim()).not.toBe("");
		}
	});
});
