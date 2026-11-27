// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	BehaviorEntry,
	NaiaContextBridge,
	AppContext,
	ShellResult,
	ToolHandler,
} from "../../lib/app-registry";
import { bgmPlayback } from "../../lib/bgm-playback";
import { t } from "../../lib/i18n";
import en from "../../lib/locales/en";
import {
	patchUiPreferences,
	resetUiPreferencesForTests,
	UI_PREFERENCE_KEYS,
} from "../../lib/ui-preferences";
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
	loadConfig: vi.fn(() => null),
	saveConfig: vi.fn(),
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
		bgmPlayback.reset();
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
		bgmPlayback.reset();
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
	it("blocks a matching YouTube URL while the internal BGM request owns it", async () => {
		bgmPlayback.request({ videoId: "Td4G5MyLyNA", title: "Internal BGM" });
		const bridge = new MockBridge();
		render(<BrowserCenterArea naia={bridge} />);

		const result = await bridge.callTool("skill_browser_navigate", {
			url: "https://www.youtube.com/watch?v=Td4G5MyLyNA",
		});

		expect(result).toContain("Blocked");
		expect(invokeMock).not.toHaveBeenCalledWith("browser_wv_navigate", {
			url: "https://www.youtube.com/watch?v=Td4G5MyLyNA",
		});
	});

	it("does not block an unrelated YouTube video", async () => {
		bgmPlayback.request({ videoId: "owned", title: "Internal BGM" });
		expect(
			(await import("../../lib/bgm-playback")).isCurrentBgmYoutubeUrl(
				"https://www.youtube.com/watch?v=other",
			),
		).toBe(false);
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

// ── 권한이 꺼진 도구의 거부가 호출자에게 실패로 가는가 (S2) ──────────────────
//
// 왜 이 묶음이 있는가: 브라우저 앱 하단의 AI 도구 설정에서 어떤 도구를 끄면
// 핸들러가 거부 문장을 "반환" 했다. 브리지는 반환값을 성공으로 전달하므로
// 호출자(채팅)에는 거부가 성공 결과로 보였다. 거부는 거부 사유를 담은 실패
// (reject)로 전달되어야 한다.
const ALL_TOOL_PERMS = {
	navigate: true,
	back: true,
	forward: true,
	reload: true,
	click: true,
	fill: true,
	scroll: true,
	press: true,
	snapshot: true,
	getText: true,
	eval: true,
};

const DENIAL_CASES: Array<
	[string, string, string, Record<string, unknown>, string]
> = [
	[
		"skill_browser_navigate",
		"navigate",
		"탐색",
		{ url: "https://example.com" },
		"browser_wv_navigate",
	],
	["skill_browser_back", "back", "뒤로", {}, "browser_wv_back"],
	["skill_browser_forward", "forward", "앞으로", {}, "browser_wv_forward"],
	["skill_browser_reload", "reload", "새로고침", {}, "browser_wv_reload"],
	["skill_browser_snapshot", "snapshot", "스냅샷", {}, "browser_wv_snapshot"],
	["skill_browser_click", "click", "클릭", { ref: "@e1" }, "browser_wv_click"],
	[
		"skill_browser_fill",
		"fill",
		"입력",
		{ ref: "@e1", text: "hello" },
		"browser_wv_fill",
	],
	["skill_browser_get_text", "getText", "읽기", {}, "browser_wv_get_text"],
	["skill_browser_scroll", "scroll", "스크롤", {}, "browser_wv_scroll"],
	[
		"skill_browser_press",
		"press",
		"키보드",
		{ key: "Enter" },
		"browser_wv_press",
	],
	["skill_browser_eval", "eval", "JS실행", { js: "1+1" }, "browser_wv_eval"],
];

describe("BrowserCenterArea AI tool permission denial", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		localStorage.clear();
		resetUiPreferencesForTests();
		bgmPlayback.reset();
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
		resetUiPreferencesForTests();
		bgmPlayback.reset();
	});

	async function mountWithPerms(
		perms: Record<string, boolean>,
	): Promise<MockBridge> {
		void patchUiPreferences({ [UI_PREFERENCE_KEYS.browserToolPerms]: perms });
		const bridge = new MockBridge();
		render(<BrowserCenterArea naia={bridge} />);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(500);
		});
		return bridge;
	}

	it.each(DENIAL_CASES)(
		"%s rejects with the denial reason when %s is off",
		async (tool, flag, label, args, command) => {
			const bridge = await mountWithPerms({ ...ALL_TOOL_PERMS, [flag]: false });

			const settled = bridge.callTool(tool, args).then(
				(value) => ({ ok: true as const, value }),
				(error: unknown) => ({ ok: false as const, error }),
			);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(NAVIGATE_READ_DELAY_MS + 100);
			});
			const outcome = await settled;

			expect(outcome.ok).toBe(false);
			if (!outcome.ok) {
				const message = String(
					(outcome.error as Error)?.message ?? outcome.error,
				);
				expect(message).toContain("비활성화");
				expect(message).toContain(`'${label}'`);
			}
			expect(invokeMock.mock.calls.map((call) => call[0])).not.toContain(
				command,
			);
		},
	);

	it("still resolves a permitted click as success", async () => {
		const bridge = await mountWithPerms({ ...ALL_TOOL_PERMS });

		const result = await bridge.callTool("skill_browser_click", {
			ref: "@e1",
		});

		expect(result).toContain("Clicked");
		expect(invokeMock.mock.calls.map((call) => call[0])).toContain(
			"browser_wv_click",
		);
	});
});

// ── 화면이 비었을 때 그 사실을 말하는가 (#576) ──────────────────────────────
//
// 왜 이 묶음이 있는가: 2026-09-06 실기 탐색에서 브라우저 앱으로 example.com 을
// 열고 6초를 기다려도 화면은 검은 채였고 주소창에는 example.com 이 그대로
// 있었다. 성공한 것처럼 보이는데 아무것도 없었다. 원인은 두 가지였고 둘 다
// 침묵이었다 — 이 실행에는 자식 웹뷰가 아예 없었는데 화면이 "준비됨" 이었고,
// 이동 실패는 `.catch(() => {})` 가 삼켰다.
//
// 페이지를 그리는 것은 HTML 이 아니라 네이티브 자식 웹뷰다. 그러니 그 표면이
// 없을 수 있다는 것 자체는 정상이다. 결함은 그 상태를 말하지 않는 것이다.
describe("BrowserCenterArea 빈 화면 안내", () => {
	let rectSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.useFakeTimers();
		localStorage.clear();
		bgmPlayback.reset();
		listenMock.mockResolvedValue(() => {});
		class ResizeObserverMock {
			observe() {}
			unobserve() {}
			disconnect() {}
		}
		globalThis.ResizeObserver = ResizeObserverMock as typeof ResizeObserver;
		window.requestAnimationFrame = (cb: FrameRequestCallback) =>
			window.setTimeout(() => cb(performance.now()), 0);
		// jsdom 은 모든 요소를 0×0 으로 잰다. 그러면 컴포넌트가 자리를 못 잡았다고
		// 보고 웹뷰를 만들지 않는다 — 이 묶음이 재려는 자리에 닿지 못한다.
		rectSpy = vi
			.spyOn(Element.prototype, "getBoundingClientRect")
			.mockReturnValue({
				x: 0,
				y: 0,
				top: 0,
				left: 0,
				right: 800,
				bottom: 600,
				width: 800,
				height: 600,
				toJSON: () => ({}),
			} as DOMRect);
	});

	afterEach(() => {
		rectSpy.mockRestore();
		cleanup();
		vi.useRealTimers();
		vi.clearAllMocks();
		bgmPlayback.reset();
	});

	/** 웹뷰 생성이 무엇을 돌려주는지만 바꾼 기본 목. */
	function mockInvoke(created: boolean, navigateFails = false) {
		invokeMock.mockImplementation(async (cmd: string) => {
			if (cmd === "browser_wv_create") return created;
			if (cmd === "browser_wv_page_info") return ["", ""];
			if (cmd === "browser_wv_navigate") {
				if (navigateFails) throw new Error("No browser webview");
				return undefined;
			}
			return undefined;
		});
	}

	async function settle() {
		await act(async () => {
			await vi.advanceTimersByTimeAsync(500);
		});
	}

	it("자식 웹뷰가 없는 실행이면 그 사실을 화면에 적는다", async () => {
		mockInvoke(false);
		const bridge = new MockBridge();
		const { queryByTestId } = render(<BrowserCenterArea naia={bridge} />);
		await settle();

		// 예전에는 여기가 아무 표시 없는 검은 자리였다. 스크린샷만 보면 제품이
		// 깨진 것과 구별되지 않아, 사람이 없는 결함을 찾았다.
		const notice = queryByTestId("browser-surface-notice");
		expect(notice).not.toBeNull();
		// 글자로 견주지 않는다 — 로케일이 열넷이라 문구로 재면 한 언어에서만
		// 참인 단정이 된다. 표에서 읽은 값과 견주어 배선을 잰다.
		expect(notice?.textContent ?? "").toBe(en["browser.noSurface"]);
	});

	it("자식 웹뷰가 있으면 안내를 적지 않는다", async () => {
		mockInvoke(true);
		const bridge = new MockBridge();
		const { queryByTestId } = render(<BrowserCenterArea naia={bridge} />);
		await settle();

		// 이 반대 방향이 없으면 안내가 늘 떠 있어도 통과한다. 그러면 정상
		// 실행에서 페이지 위에 안내가 겹친다.
		expect(queryByTestId("browser-surface-notice")).toBeNull();
	});

	it("주소창으로 이동하다 실패하면 삼키지 않고 말한다", async () => {
		mockInvoke(true, true);
		const bridge = new MockBridge();
		const { queryByTestId, container } = render(
			<BrowserCenterArea naia={bridge} />,
		);
		await settle();
		expect(queryByTestId("browser-surface-notice")).toBeNull();

		const input = container.querySelector(
			".browser-app__url-form input",
		) as HTMLInputElement;
		const form = container.querySelector(
			".browser-app__url-form",
		) as HTMLFormElement;
		expect(input).not.toBeNull();
		expect(form).not.toBeNull();
		await act(async () => {
			fireEvent.change(input, { target: { value: "example.com" } });
			fireEvent.submit(form);
			await vi.advanceTimersByTimeAsync(200);
		});

		// 실패를 삼키면 주소창만 바뀌고 화면은 검은 채로 남는다 — 사용자는
		// 자기가 무엇을 잘못했는지조차 알 수 없다. 실측한 그 화면이 그것이다.
		const notice = queryByTestId("browser-surface-notice");
		expect(notice).not.toBeNull();
		const text = notice?.textContent ?? "";
		// 주소와 이유는 값이라 번역되지 않는다. 둘 다 없으면 사용자는 무엇이
		// 왜 안 됐는지 알 수 없다.
		expect(text).toContain("https://example.com");
		expect(text).toContain("No browser webview");
		expect(text).toBe(
			t("browser.navigateFailed", {
				url: "https://example.com",
				error: "Error: No browser webview",
			}),
		);
	});
});
