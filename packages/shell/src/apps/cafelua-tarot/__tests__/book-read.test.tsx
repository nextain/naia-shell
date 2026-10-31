// @vitest-environment jsdom
import { createRef } from "react";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Book, type BookHandle } from "../Book";
import { createTarotToolHandler, type TarotToolState } from "../tools";

vi.mock("../data/library/tarotBook", () => {
	const chapters = [
		{
			path: "first",
			title: "First",
			markdown: [
				"A".repeat(240),
				"B".repeat(240),
				"C".repeat(240),
				"D".repeat(240),
			].join("\n\n"),
		},
		{
			path: "second",
			title: "Second",
			markdown: ["E", "F", "G", "H"].join("\n\n"),
		},
	];
	return {
		tarotLibraryBook: {
			editions: [
				{ lang: "en", title: "Fixture", sourceSlug: "fixture", chapters },
			],
		},
	};
});
vi.mock("../library-dom-pagination", () => ({
	measureRenderedReaderPages: (source: HTMLElement) => {
		const chapters = [
			...source.querySelectorAll("section[data-reader-chapter]"),
		];
		const page = (
			chapterIndex: number,
			pageInChapter: number,
			paragraphs: Element[],
		) => ({
			chapterIndex,
			chapterTitle: chapterIndex === 0 ? "First" : "Second",
			pageInChapter,
			html: paragraphs.map((p) => p.outerHTML).join(""),
			usedHeight: 0,
			availableHeight: 100,
		});
		const first = [...chapters[0].querySelectorAll("p")];
		const second = [...chapters[1].querySelectorAll("p")];
		return [
			page(0, 0, first.slice(0, 3)),
			page(0, 1, first.slice(3)),
			page(1, 0, second),
		];
	},
	alignChapterStartsToSpreads: (pages: unknown[]) => pages,
}));

describe("UT-02 book read-aloud progression", () => {
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
		const ref = createRef<BookHandle>();
		render(<Book ref={ref} locale="en" onBack={() => {}} />);
		await act(async () => {
			await Promise.resolve();
			vi.advanceTimersByTime(50);
		});
		const handler = createTarotToolHandler({
			readAloud: () =>
				ref.current!.read() as unknown as Record<string, unknown>,
			stopReading: () => ref.current!.stop(),
		} as TarotToolState);
		const read = async () => {
			let result: Record<string, unknown> = {};
			await act(async () => {
				result = await handler({ action: "read_aloud" });
			});
			return result;
		};
		return { read, ref };
	}
	function sent() {
		return post.mock.calls.filter(
			([m]) => m.type === "naia-app:speak",
		);
	}
	function reply(status: string) {
		const id = sent().at(-1)![0].id;
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					source: window.parent,
					data: { type: "naia-app:speech-result", id, status },
				}),
			),
		);
	}
	it("waits for completion, reads one paragraph at a time and stops at the chapter boundary", async () => {
		const { read, ref } = await setup();
		expect(await read()).toMatchObject({
			started: true,
			chapter_title: "First",
		});
		expect(await read()).toMatchObject({ already_reading: true });
		act(() => vi.advanceTimersByTime(0));
		expect(sent()).toHaveLength(1);
		expect(sent()[0][0].text).toBe("A".repeat(240));
		expect(document.querySelectorAll(".naia-reading-highlight")).toHaveLength(
			1,
		);
		reply("completed");
		expect(sent()).toHaveLength(2);
		expect(sent()[1][0].text).toBe("B".repeat(240));
		reply("completed");
		expect(sent()).toHaveLength(3);
		expect(sent()[2][0].text).toBe("C".repeat(240));
		reply("completed");
		expect(sent()).toHaveLength(4);
		expect(sent()[3][0].text).toBe("D".repeat(240));
		reply("completed");
		expect(sent()).toHaveLength(4);
		expect(screen.getByRole("status").textContent).toContain(
			"chapter is finished",
		);
		await act(async () => {
			await ref.current!.open(1);
		});
		expect(await read()).toMatchObject({
			started: true,
			chapter_title: "Second",
		});
		act(() => vi.advanceTimersByTime(0));
		for (const [index, value] of ["E", "F", "G", "H"].entries()) {
			expect(sent()[4 + index][0].text).toBe(value);
			reply("completed");
		}
		expect(await read()).toMatchObject({ book_end: true });
	});
	it("stops reading when the read button is pressed during playback and retries the same batch", async () => {
		const { read } = await setup();
		await read();
		act(() => vi.advanceTimersByTime(0));
		const first = sent()[0][0];
		fireEvent.click(screen.getByRole("button", { name: "Naia reads" }));
		expect(post).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "naia-app:speak-cancel",
				id: first.id,
			}),
			"*",
		);
		expect(document.querySelectorAll(".naia-reading-highlight")).toHaveLength(
			0,
		);
		await read();
		act(() => vi.advanceTimersByTime(0));
		expect(sent()[1][0].text).toBe(first.text);
		reply("failed");
		expect(screen.getByRole("status").textContent).toContain("Could not start");
		await read();
		act(() => vi.advanceTimersByTime(0));
		expect(sent()[2][0].text).toBe(first.text);
		act(() => {
			refStop();
		});
	});
	function refStop() {
		fireEvent.click(screen.getByRole("button", { name: "Naia reads" }));
	}
});
