// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TarotApp } from "../index";

vi.mock("../library-dom-pagination", () => ({
	alignChapterStartsToSpreads: (pages: unknown[]) => pages,
	measureRenderedReaderPages: () => [
		{
			chapterIndex: 0,
			chapterTitle: "First",
			pageInChapter: 0,
			html: "<p>Page</p>",
		},
	],
}));

describe("Cafe Lua Tarot v0.1.5 spread selector and card spotlight", () => {
	beforeEach(() => {
		vi.stubGlobal("matchMedia", () => ({
			matches: false,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		}));
		vi.stubGlobal(
			"ResizeObserver",
			class {
				observe() {}
				unobserve() {}
				disconnect() {}
			},
		);
		vi.stubGlobal(
			"Audio",
			class {
				loop = false;
				volume = 1;
				muted = false;
				currentTime = 0;
				play = vi.fn().mockResolvedValue(undefined);
				pause = vi.fn();
				load = vi.fn();
			},
		);
		Object.defineProperty(document, "fonts", {
			configurable: true,
			value: { ready: Promise.resolve() },
		});
		Object.defineProperty(window, "innerWidth", {
			configurable: true,
			writable: true,
			value: 1024,
		});
		Object.defineProperty(window.navigator, "language", {
			configurable: true,
			value: "ko-KR",
		});
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	function sendToolCall(id: string, args: Record<string, unknown>) {
		window.dispatchEvent(
			new MessageEvent("message", {
				source: window.parent,
				origin: "http://localhost",
				data: {
					type: "naia-tool-call",
					id,
					tool: "skill_cafelua_tarot",
					args,
				},
			}),
		);
	}

	it("shows 1-card, 3-card, and 10-card Celtic Cross selector first with Celtic Cross active by default", () => {
		render(<TarotApp />);
		expect(screen.getByText("어떤 방식으로 타로를 볼까요?")).toBeTruthy();

		const oneBtn = screen.getByRole("button", { name: /1장 원카드/ });
		const threeBtn = screen.getByRole("button", { name: /3장 과거·현재·미래/ });
		const celticBtn = screen.getByRole("button", { name: /10장 캘틱 크로스/ });

		expect(celticBtn.getAttribute("aria-pressed")).toBe("true");
		expect(oneBtn.getAttribute("aria-pressed")).toBe("false");
		expect(threeBtn.getAttribute("aria-pressed")).toBe("false");

		fireEvent.click(threeBtn);
		expect(threeBtn.getAttribute("aria-pressed")).toBe("true");
		expect(celticBtn.getAttribute("aria-pressed")).toBe("false");
	});

	it("auto-opens the large card spotlight on desktop when cards are revealed and supports zoom, navigation, close, and reopen", async () => {
		render(<TarotApp />);

		await act(async () => {
			sendToolCall("t1", {
				action: "start_reading",
				spread: "celtic",
				question: "진로 고민",
			});
		});

		await act(async () => {
			sendToolCall("t2", { action: "reveal_next" });
		});

		const dialog1 = screen.getByRole("dialog");
		expect(dialog1.className).toContain("tarot-spotlight");
		expect(dialog1.textContent).toContain("1 / 1");

		await act(async () => {
			sendToolCall("t3", { action: "reveal_next" });
		});

		const dialog2 = screen.getByRole("dialog");
		expect(dialog2.textContent).toContain("2 / 2");

		fireEvent.click(screen.getByRole("button", { name: /이전 카드/ }));
		expect(screen.getByRole("dialog").textContent).toContain("1 / 2");

		fireEvent.click(screen.getByRole("button", { name: "카드 크게 보기" }));
		expect(screen.getByRole("dialog").className).toContain("zoomed");

		fireEvent.click(screen.getByRole("button", { name: "닫기" }));
		expect(screen.queryByRole("dialog")).toBeNull();

		const reopenButtons = screen.getAllByRole("button", {
			name: /카드 크게 보기/,
		});
		fireEvent.click(reopenButtons[0]!);
		expect(screen.getByRole("dialog")).toBeTruthy();
	});
});
