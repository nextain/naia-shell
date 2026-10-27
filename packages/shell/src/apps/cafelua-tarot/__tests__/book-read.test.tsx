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

describe("book read-aloud progression", () => {
	beforeEach(() => {
		vi.useFakeTimers();
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
		return { read };
	}
	it("continues across chapters, enforces batch limits, and returns book_end", async () => {
		const { read } = await setup();
		const first = await read();
		expect(first.text).toBe(`${"A".repeat(240)}\n\n${"B".repeat(240)}`);
		expect((first.text as string).length).toBeLessThanOrEqual(600);
		expect(first.chapter_end).toBe(false);
		expect(await read()).toMatchObject({
			text: "C".repeat(240),
			chapter_end: false,
		});
		expect(await read()).toMatchObject({
			text: "D".repeat(240),
			chapter_end: true,
		});
		const next = await read();
		expect(next).toMatchObject({
			text: "E\n\nF\n\nG",
			chapter_title: "Second",
			chapter_end: false,
		});
		expect((next.text as string).split("\n\n")).toHaveLength(3);
		expect(await read()).toMatchObject({ text: "H", chapter_end: true });
		expect(await read()).toEqual({ book_end: true, total_pages: 3 });
		expect(document.querySelectorAll(".naia-reading-highlight")).toHaveLength(
			0,
		);
	});
	it("stops reading when the read button is pressed during playback", async () => {
		const { read } = await setup();
		await read();
		expect(
			document.querySelectorAll(".naia-reading-highlight").length,
		).toBeGreaterThan(0);
		fireEvent.click(screen.getByRole("button", { name: "Naia reads" }));
		expect(await read()).toEqual({ stopped: true });
		expect(document.querySelectorAll(".naia-reading-highlight")).toHaveLength(
			0,
		);
	});
});
