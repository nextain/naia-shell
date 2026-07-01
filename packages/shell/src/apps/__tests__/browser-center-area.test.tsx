// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	BehaviorEntry,
	NaiaContextBridge,
	AppContext,
	ShellResult,
	ToolHandler,
} from "../../lib/app-registry";
import {
	BrowserCenterArea,
	NAVIGATE_READ_DELAY_MS,
	NAVIGATE_TEXT_TIMEOUT_MS,
	browserTextExcerpt,
	decodeBrowserEvalString,
} from "../browser/BrowserCenterArea";

const invokeMock = vi.hoisted(() => vi.fn());
const listenMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
	invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: listenMock,
}));

vi.mock("../../lib/logger", () => ({
	Logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

vi.mock("../../lib/config", () => ({
	addAllowedTool: vi.fn(),
}));

vi.mock("../../lib/browser-prefs", () => ({
	addBrowserBookmark: vi.fn(),
	addBrowserShortcut: vi.fn(),
	loadBrowserBookmarks: vi.fn().mockResolvedValue([]),
	onBrowserPrefsChanged: vi.fn().mockReturnValue(() => {}),
	removeBrowserBookmark: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../lib/ai-interference", () => ({
	emitAiInterferenceEvent: vi.fn(),
}));

class MockBridge implements NaiaContextBridge {
	public contexts: AppContext[] = [];
	private handlers = new Map<string, ToolHandler>();

	pushContext(ctx: AppContext): void {
		this.contexts.push(ctx);
	}

	onToolCall(toolName: string, handler: ToolHandler): () => void {
		this.handlers.set(toolName, handler);
		return () => {
			this.handlers.delete(toolName);
		};
	}

	async callTool(
		toolName: string,
		args: Record<string, unknown>,
	): Promise<string> {
		const handler = this.handlers.get(toolName);
		if (!handler) return `No handler: ${toolName}`;
		const result = await handler(args);
		return result ?? "ok";
	}

	hasHandler(toolName: string): boolean {
		return this.handlers.has(toolName);
	}

	logBehavior(_event: string, _data?: Record<string, unknown>): Promise<void> {
		return Promise.resolve();
	}
	queryBehavior(): Promise<BehaviorEntry[]> {
		return Promise.resolve([]);
	}
	getSecret(_key: string): Promise<string | null> {
		return Promise.resolve(null);
	}
	setSecret(_key: string, _value: string): Promise<void> {
		return Promise.resolve();
	}
	readFile(_path: string): Promise<string> {
		return Promise.resolve("");
	}
	runShell(_cmd: string, _args?: string[]): Promise<ShellResult> {
		return Promise.resolve({ stdout: "", stderr: "", code: 0 });
	}
}

describe("BrowserCenterArea text helpers", () => {
	it("decodes browser eval JSON string results", () => {
		expect(decodeBrowserEvalString(JSON.stringify("AI news\nbody"))).toBe(
			"AI news\nbody",
		);
		expect(decodeBrowserEvalString("plain text")).toBe("plain text");
	});

	it("normalizes and limits navigation text excerpts", () => {
		const { text, truncated } = browserTextExcerpt(
			JSON.stringify("title\n\n\nbody   \n".repeat(200)),
			80,
		);
		expect(text.length).toBeLessThanOrEqual(80);
		expect(text).toContain("title");
		expect(truncated).toBe(true);
	});
});

describe("BrowserCenterArea AI browser tools", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		localStorage.clear();
		listenMock.mockResolvedValue(() => {});
		invokeMock.mockImplementation(async (cmd: string) => {
			if (cmd === "browser_wv_page_info") {
				return ["https://news.naver.com", "Naver News"];
			}
			if (cmd === "browser_wv_get_text") {
				return JSON.stringify("AI 뉴스 제목\nAI 뉴스 본문");
			}
			return undefined;
		});
		class ResizeObserverMock {
			observe() {}
			unobserve() {}
			disconnect() {}
		}
		globalThis.ResizeObserver = ResizeObserverMock as typeof ResizeObserver;
		window.requestAnimationFrame = (cb: FrameRequestCallback) =>
			window.setTimeout(() => cb(performance.now()), 0);
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it("returns visible page text after browser navigation", async () => {
		const bridge = new MockBridge();
		render(<BrowserCenterArea naia={bridge} />);

		expect(bridge.hasHandler("skill_browser_navigate")).toBe(true);

		const resultPromise = bridge.callTool("skill_browser_navigate", {
			url: "https://news.naver.com",
		});

		await act(async () => {
			await vi.advanceTimersByTimeAsync(NAVIGATE_READ_DELAY_MS + 100);
		});

		const result = await resultPromise;

		expect(invokeMock).toHaveBeenCalledWith("browser_wv_navigate", {
			url: "https://news.naver.com",
		});
		expect(invokeMock).toHaveBeenCalledWith("browser_wv_get_text", {
			selector: "",
			timeout_ms: NAVIGATE_TEXT_TIMEOUT_MS,
		});
		expect(result).toContain("Navigated to https://news.naver.com");
		expect(result).toContain("Page text");
		expect(result).toContain("AI 뉴스 제목");
		expect(result).toContain("AI 뉴스 본문");
	});

	it("does not fail navigation when automatic page text read times out", async () => {
		invokeMock.mockImplementation(async (cmd: string) => {
			if (cmd === "browser_wv_page_info") {
				return ["https://news.naver.com", "Naver News"];
			}
			if (cmd === "browser_wv_get_text") {
				throw new Error("eval timeout (3000 ms)");
			}
			return undefined;
		});
		const bridge = new MockBridge();
		render(<BrowserCenterArea naia={bridge} />);

		const resultPromise = bridge.callTool("skill_browser_navigate", {
			url: "https://news.naver.com",
		});

		await act(async () => {
			await vi.advanceTimersByTimeAsync(NAVIGATE_READ_DELAY_MS + 100);
		});

		const result = await resultPromise;

		expect(result).toContain("Navigated to https://news.naver.com");
		expect(result).toContain("Page text read failed");
		expect(result).not.toContain("Navigation failed");
	});
});
