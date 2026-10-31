// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Book, chapterDone, readErrors, readRequests } from "../Book";
import { APP_LOCALES } from "../i18n";
vi.mock("../library-dom-pagination", () => ({
	alignChapterStartsToSpreads: (pages: unknown[]) => pages,
	measureRenderedReaderPages: (source: HTMLElement) => [
		{
			chapterIndex: 0,
			chapterTitle: "First",
			pageInChapter: 0,
			html: source.querySelector("p[data-reader-paragraph]")?.outerHTML ?? "",
		},
	],
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
	async function setup() {
		const result = render(<Book locale="en" onBack={() => {}} />);
		await act(async () => {
			await Promise.resolve();
			vi.advanceTimersByTime(50);
		});
		return result;
	}
	async function click() {
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Naia reads" }));
			await Promise.resolve();
			vi.advanceTimersByTime(0);
		});
	}
	function reply(id: string, status: string, source = window.parent) {
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					source,
					data: { type: "naia-app:speech-result", id, status },
				}),
			),
		);
	}
	it("sends a speech request and permits retry after failure", async () => {
		await setup();
		await click();
		const m = post.mock.calls[0][0];
		expect(m).toMatchObject({
			type: "naia-app:speak",
			appId: "land.naia.cafelua-tarot",
			page: 1,
		});
		reply(m.id, "failed");
		expect(screen.getByRole("status").textContent).toBe(readErrors.en);
		await click();
		expect(post.mock.calls[1][0].text).toBe(m.text);
	});
	it("times out and allows retry", async () => {
		await setup();
		await click();
		act(() => vi.advanceTimersByTime(120001));
		expect(screen.getByRole("status").textContent).toBe(readErrors.en);
		await click();
		expect(
			post.mock.calls.filter(([m]) => m.type === "naia-app:speak"),
		).toHaveLength(2);
	});
	it("ignores late and mismatched results without disturbing a retry", async () => {
		await setup();
		await click();
		const first = post.mock.calls[0][0].id;
		await click();
		await click();
		const next = post.mock.calls.at(-1)![0].id;
		reply(first, "completed");
		reply(next, "completed", window);
		expect(post.mock.calls.at(-1)![0].id).toBe(next);
		reply(next, "completed");
		expect(screen.getByRole("status").textContent).toContain(
			"chapter is finished",
		);
	});
	it("cancels pending speech on unmount", async () => {
		const { unmount } = await setup();
		await click();
		const id = post.mock.calls[0][0].id;
		unmount();
		expect(post).toHaveBeenCalledWith(
			expect.objectContaining({ type: "naia-app:speak-cancel", id }),
			"*",
		);
		expect(vi.getTimerCount()).toBe(0);
	});
	it("shows the hint immediately in standalone mode", async () => {
		Object.defineProperty(window, "parent", {
			configurable: true,
			value: window,
		});
		await setup();
		await click();
		expect(screen.getByRole("status").textContent).toBe(
			"Ask Naia to read aloud.",
		);
		expect(post).not.toHaveBeenCalled();
	});
	it("provides requests, chapter completion and failure messages in all 14 languages", () => {
		for (const locale of APP_LOCALES) {
			expect(readRequests[locale].trim()).not.toBe("");
			expect(readErrors[locale].trim()).not.toBe("");
			expect(chapterDone[locale].trim()).not.toBe("");
		}
	});
});
