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
import { installInstalledAppHostBridge, INSTALLED_APP_SPEAK_EVENT, INSTALLED_APP_CANCEL_EVENT, INSTALLED_APP_SPEECH_RESULT_EVENT } from "../../generic-installed/installed-app-host-bridge";
import manifest from "../package-public/app.json";
const sizes = vi.hoisted(() => ({ first: 240 }));

vi.mock("../data/library/tarotBook", () => {
	const chapters = [
		{
			path: "first",
			title: "First",
			get markdown() { return [
				"A".repeat(sizes.first),
				"B".repeat(240),
				"C".repeat(240),
				"D".repeat(240),
			].join("\n\n"); },
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

describe("IT-02 Book with installed app host bridge", () => {
 let originalParent: Window, frame: HTMLIFrameElement, target: Window, dispose: () => void;
 let provider: ReturnType<typeof vi.fn<(event: Event) => void>>, cancel: ReturnType<typeof vi.fn<(event: Event) => void>>, delivered: any[], requested: any[];
 let parentProxy: { postMessage: (message: any) => void };
 beforeEach(() => {
  vi.useFakeTimers(); sizes.first = 240; originalParent = window.parent; delivered = []; requested = [];
  frame = document.createElement("iframe"); document.body.appendChild(frame); target = frame.contentWindow!;
  parentProxy = { postMessage: (data) => { requested.push(data); window.dispatchEvent(new MessageEvent("message", { source: target, origin: "https://asset.localhost", data })); } };
  Object.defineProperty(window, "parent", { configurable: true, value: parentProxy });
  vi.spyOn(target, "postMessage").mockImplementation((data) => { delivered.push(data); window.dispatchEvent(new MessageEvent("message", { source: parentProxy as unknown as Window, data })); });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  Object.defineProperty(document, "fonts", { configurable: true, value: { ready: Promise.resolve() } });
  provider = vi.fn<(event: Event) => void>(); cancel = vi.fn<(event: Event) => void>(); window.addEventListener(INSTALLED_APP_SPEAK_EVENT, provider); window.addEventListener(INSTALLED_APP_CANCEL_EVENT, cancel);
 });
 afterEach(() => {
  cleanup(); dispose?.(); frame.remove(); window.removeEventListener(INSTALLED_APP_SPEAK_EVENT, provider); window.removeEventListener(INSTALLED_APP_CANCEL_EVENT, cancel);
  Object.defineProperty(window, "parent", { configurable: true, value: originalParent }); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
 });
 async function setup(permissions: string[] = manifest.permissions) {
  dispose = installInstalledAppHostBridge(frame, "https://asset.localhost/app", manifest.id, permissions);
  const ref = createRef<BookHandle>(); render(<Book ref={ref} locale="en" onBack={() => {}} />);
  await act(async () => { await Promise.resolve(); vi.advanceTimersByTime(50); });
  return async () => { await act(async () => { await ref.current!.read(); vi.advanceTimersByTime(0); }); };
 }
 function settle(status: string, error?: string) {
  const detail = (provider.mock.calls.at(-1)![0] as CustomEvent).detail;
  act(() => window.dispatchEvent(new CustomEvent(INSTALLED_APP_SPEECH_RESULT_EVENT, { detail: { ...detail, status, error } })));
 }
 it("IT-02 advances only on completed and retries failure and cancellation", async () => {
  const read = await setup(); await read(); expect(provider).toHaveBeenCalledTimes(1);
  expect((provider.mock.calls[0][0] as CustomEvent).detail.text).toBe("A".repeat(240));
  settle("failed", "tts_failed"); expect(provider).toHaveBeenCalledTimes(1); await read();
  expect((provider.mock.calls[1][0] as CustomEvent).detail.text).toBe("A".repeat(240));
  settle("cancelled"); expect(provider).toHaveBeenCalledTimes(2); await read();
  expect((provider.mock.calls[2][0] as CustomEvent).detail.text).toBe("A".repeat(240));
  settle("finished"); expect(delivered.at(-1)).toMatchObject({ status: "completed" });
  expect((provider.mock.calls[3][0] as CustomEvent).detail.text).toBe("B".repeat(240));
  fireEvent.click(screen.getByRole("button", { name: "Naia reads" })); expect(cancel).toHaveBeenCalled();
  await read(); expect((provider.mock.calls[4][0] as CustomEvent).detail.text).toBe("B".repeat(240));
 });
 it("IT-02 rejects absent permission without consuming the paragraph", async () => {
  const read = await setup([]); await read(); expect(provider).not.toHaveBeenCalled();
  expect(delivered.at(-1)).toMatchObject({ status: "failed", error: "permission_denied" });
  await read(); expect(requested.filter(m => m.type === "naia-app:speak").map(m => m.text)).toEqual(["A".repeat(240), "A".repeat(240)]);
 });
 it("IT-02 reports bridge timeout and retries the same paragraph", async () => {
  const read = await setup(); await read(); act(() => vi.advanceTimersByTime(120000));
  expect(delivered.at(-1)).toMatchObject({ status: "failed", error: "timeout" }); expect(cancel).toHaveBeenCalled();
  await read(); expect((provider.mock.calls[1][0] as CustomEvent).detail.text).toBe("A".repeat(240));
 });
 it("IT-02 accepts 2000 and rejects 2001 without consuming", async () => {
  sizes.first = 2000; const read = await setup(); await read(); expect((provider.mock.calls[0][0] as CustomEvent).detail.text).toHaveLength(2000);
  settle("finished"); expect((provider.mock.calls[1][0] as CustomEvent).detail.text).toBe("B".repeat(240));
  act(() => parentProxy.postMessage({ type: "naia-app:speak", appId: manifest.id, id: "oversize", text: "x".repeat(2001) }));
  expect(delivered.at(-1)).toMatchObject({ id: "oversize", status: "failed", error: "invalid_text" });
 });
 it("IT-02 leaves a 2001 character Book paragraph unread", async () => {
  sizes.first = 2001; const read = await setup(); await read(); expect(provider).not.toHaveBeenCalled();
  expect(screen.getByRole("status").textContent).toContain("Could not start"); await read(); expect(provider).not.toHaveBeenCalled();
 });
});
