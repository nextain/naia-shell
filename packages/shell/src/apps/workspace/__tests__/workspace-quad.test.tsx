// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { createRef, forwardRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	UI_PREFERENCE_KEYS,
	getUiPreferencesSnapshot,
	hydrateUiPreferences,
	patchUiPreferences,
	resetUiPreferencesForTests,
} from "../../../lib/ui-preferences";
import {
	QuadIframePane,
	normalizeQuadPaneUrl,
	probeServerHealth,
} from "../QuadIframePane";
import { t } from "../../../lib/i18n";
import type { TerminalHandle } from "../Terminal";
import {
	DEFAULT_RATIOS,
	WorkspaceQuadView,
	validateRatios,
} from "../WorkspaceQuadView";
import type { TerminalSource } from "../terminal-source";
import {
	decidePtyAction,
	detectDefaultShell,
	isAbsolutePath,
	usePtyTerminalSource,
} from "../usePtyTerminalSource";

const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
	invoke: (...args: unknown[]) => mockInvoke(...args),
}));

const mockOpenUrl = vi.fn(async (_url: string) => {});
vi.mock("@tauri-apps/plugin-opener", () => ({
	openUrl: (url: string) => mockOpenUrl(url),
}));

const mockGetAdkPath = vi.fn(() => null as string | null);
const mockWriteNaiaUiConfig = vi.fn(
	async (_config: unknown, _path?: string | null) => true,
);
vi.mock("../../../lib/adk-store", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../lib/adk-store")>();
	return {
		...actual,
		getAdkPath: () => mockGetAdkPath(),
		writeNaiaUiConfig: (config: unknown, path?: string | null) =>
			mockWriteNaiaUiConfig(config, path),
	};
});

vi.mock("../Terminal", () => ({
	Terminal: forwardRef<TerminalHandle, { pty_id: string }>(
		function MockTerminal({ pty_id }, ref) {
			if (ref && typeof ref === "object" && "current" in ref) {
				(ref as { current: unknown }).current = {
					focus: vi.fn(),
					getBufferText: vi.fn((lines?: number) => `tail-${lines || 20}`),
				};
			}
			return (
				<div data-testid="mock-xterm" data-pty-id={pty_id}>
					xterm terminal content
				</div>
			);
		},
	),
}));

describe("Workspace Quad Layout (3단 작업 화면) — #732", () => {
	beforeEach(() => {
		resetUiPreferencesForTests();
		mockGetAdkPath.mockReset();
		mockGetAdkPath.mockReturnValue(null);
		mockInvoke.mockReset();
		mockOpenUrl.mockReset();
		mockWriteNaiaUiConfig.mockReset();
		mockWriteNaiaUiConfig.mockResolvedValue(true);
		vi.restoreAllMocks();
	});

	afterEach(() => {
		cleanup();
		resetUiPreferencesForTests();
	});

	describe("WorkspaceQuadView 3-pane rendering, ratios, and resizing", () => {
		function createMockTerminalSource(
			overrides: Partial<TerminalSource> = {},
		): TerminalSource {
			return {
				kind: "pty",
				pty: { pty_id: "pty-quad-1", pid: 1234 },
				launching: false,
				launchError: "",
				terminalReady: true,
				terminalError: "",
				workingDir: "/work/test",
				launch: vi.fn(async () => {}),
				retry: vi.fn(async () => {}),
				onTerminalReady: vi.fn(),
				onPtyExit: vi.fn(),
				runOpencode: vi.fn(async () => {}),
				...overrides,
			};
		}

		it("renders terminal, docs, and dashboard simultaneously (3단 작업)", () => {
			const source = createMockTerminalSource();
			render(
				<WorkspaceQuadView
					terminalSource={source}
					terminalRef={createRef()}
					workspaceRoot="/work/test"
				/>,
			);

			expect(screen.getByTestId("workspace-quad")).toBeInTheDocument();
			expect(screen.getByTestId("quad-pane-terminal")).toBeInTheDocument();
			expect(screen.getByTestId("quad-pane-docs")).toBeInTheDocument();
			expect(screen.getByTestId("quad-pane-dashboard")).toBeInTheDocument();

			expect(screen.getByTestId("quad-handle-0")).toBeInTheDocument();
			expect(screen.getByTestId("quad-handle-1")).toBeInTheDocument();
		});

		it("exposes opencode execution button and source switcher", () => {
			const runOpencode = vi.fn(async () => {});
			const onSelectSourceKind = vi.fn();
			const source = createMockTerminalSource({ runOpencode });

			render(
				<WorkspaceQuadView
					terminalSource={source}
					terminalRef={createRef()}
					availableSources={["pty", "herdr"]}
					selectedSourceKind="pty"
					onSelectSourceKind={onSelectSourceKind}
					workspaceRoot="/work/test"
				/>,
			);

			const opencodeBtn = screen.getByTestId("quad-run-opencode");
			expect(opencodeBtn).toHaveTextContent("opencode");
			fireEvent.click(opencodeBtn);
			expect(runOpencode).toHaveBeenCalledTimes(1);

			const herdrSourceBtn = screen.getByTestId("quad-source-herdr");
			fireEvent.click(herdrSourceBtn);
			expect(onSelectSourceKind).toHaveBeenCalledWith("herdr");
		});

		it("validates split ratios and safely falls back on invalid values", () => {
			expect(validateRatios([0.4, 0.3, 0.3])).toEqual([0.4, 0.3, 0.3]);
			// Not an array or wrong length
			expect(validateRatios(null)).toEqual(DEFAULT_RATIOS);
			expect(validateRatios([0.5, 0.5])).toEqual(DEFAULT_RATIOS);
			// NaN or infinite
			expect(validateRatios([NaN, 0.33, 0.33])).toEqual(DEFAULT_RATIOS);
			// Below MIN_RATIO (0.15)
			expect(validateRatios([0.1, 0.45, 0.45])).toEqual(DEFAULT_RATIOS);
			// Sum is too far from 1.0
			expect(validateRatios([0.2, 0.2, 0.2])).toEqual(DEFAULT_RATIOS);
		});

		it("reflects split ratios updated after hydration", async () => {
			const source = createMockTerminalSource();
			const { rerender } = render(
				<WorkspaceQuadView
					terminalSource={source}
					terminalRef={createRef()}
					workspaceRoot="/work/test"
				/>,
			);

			// Initially uses default
			const terminalPane = screen.getByTestId("quad-pane-terminal");
			expect(terminalPane.style.flex).toContain("0.34");

			// Simulate hydration / preference patch after initial paint
			await patchUiPreferences({
				[UI_PREFERENCE_KEYS.workspaceSplitRatios]: [0.5, 0.25, 0.25],
			});

			rerender(
				<WorkspaceQuadView
					terminalSource={source}
					terminalRef={createRef()}
					workspaceRoot="/work/test"
				/>,
			);

			await waitFor(() => {
				expect(screen.getByTestId("quad-pane-terminal").style.flex).toContain(
					"0.5",
				);
			});
		});

		it("updates and persists ratios when dragging resize handles, handling pointercancel", () => {
			const source = createMockTerminalSource();
			const { container } = render(
				<WorkspaceQuadView
					terminalSource={source}
					terminalRef={createRef()}
					workspaceRoot="/work/test"
				/>,
			);

			const quadContainer = container.querySelector(
				".workspace-quad",
			) as HTMLElement;
			vi.spyOn(quadContainer, "getBoundingClientRect").mockReturnValue({
				width: 1000,
				height: 600,
				top: 0,
				left: 0,
				bottom: 600,
				right: 1000,
				x: 0,
				y: 0,
				toJSON: () => {},
			});

			const handle0 = screen.getByTestId("quad-handle-0");

			// Simulate pointer drag on handle 0
			fireEvent.pointerDown(handle0, { clientX: 340, pointerId: 1 });
			expect(document.body.classList.contains("resizing-col")).toBe(true);

			// Send pointerMove and pointerCancel consecutively in a single act before render
			act(() => {
				fireEvent.pointerMove(handle0, { clientX: 440, pointerId: 1 });
				fireEvent.pointerCancel(handle0, { pointerId: 1 });
			});

			expect(document.body.classList.contains("resizing-col")).toBe(false);

			const snapshot = getUiPreferencesSnapshot();
			const ratios = snapshot[
				UI_PREFERENCE_KEYS.workspaceSplitRatios
			] as number[];
			expect(ratios).toBeDefined();
			expect(ratios[0]).toBeCloseTo(0.44, 2);
			expect(ratios[1]).toBeCloseTo(0.23, 2);
		});
	});

	describe("QuadIframePane sandbox and offline notice separation", () => {
		it("applies strict sandbox attribute without allow-top-navigation", () => {
			vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(null, { status: 200 }),
			);
			render(
				<QuadIframePane
					title="문서"
					url="http://localhost:3142/docs"
					paneId="docs"
				/>,
			);

			const iframe = screen.getByTestId("quad-docs-iframe");
			expect(iframe).toBeInTheDocument();
			const sandbox = iframe.getAttribute("sandbox") || "";
			expect(sandbox).toContain("allow-scripts");
			expect(sandbox).toContain("allow-same-origin");
			expect(sandbox).not.toContain("allow-top-navigation");
		});

		it("separates offline titles between docs and dashboard panes", async () => {
			vi.spyOn(globalThis, "fetch").mockRejectedValue(
				new TypeError("Failed to fetch"),
			);

			const { unmount } = render(
				<QuadIframePane
					title="문서"
					url="http://localhost:3142/docs"
					paneId="docs"
				/>,
			);

			expect(await screen.findByTestId("quad-docs-offline")).toBeInTheDocument();
			expect(
				screen.getByText(t("workspace.quadOfflineTitle", { name: "문서" })),
			).toBeVisible();
			expect(
				screen.getByText(
					t("workspace.quadOfflineDesc", { url: "http://localhost:3142/docs" }),
				),
			).toBeVisible();

			unmount();

			render(
				<QuadIframePane
					title="대시보드"
					url="http://localhost:3142"
					paneId="dashboard"
				/>,
			);

			expect(
				await screen.findByTestId("quad-dashboard-offline"),
			).toBeInTheDocument();
			expect(
				screen.getByText(t("workspace.quadOfflineTitle", { name: "대시보드" })),
			).toBeVisible();
			expect(
				screen.getByText(
					t("workspace.quadOfflineDesc", { url: "http://localhost:3142" }),
				),
			).toBeVisible();
		});

		it("probes server health and recovers on retry", async () => {
			vi.spyOn(globalThis, "fetch")
				.mockRejectedValueOnce(new TypeError("Failed to fetch"))
				.mockResolvedValueOnce(new Response(null, { status: 200 }));

			render(
				<QuadIframePane
					title="대시보드"
					url="http://localhost:3142"
					paneId="dashboard"
				/>,
			);

			expect(
				await screen.findByTestId("quad-dashboard-offline"),
			).toBeInTheDocument();
			fireEvent.click(screen.getByTestId("quad-dashboard-retry"));

			await waitFor(() => {
				expect(screen.getByTestId("quad-dashboard-iframe")).toBeInTheDocument();
			});
		});

		it("returns false from probeServerHealth when fetch fails", async () => {
			vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
				new TypeError("Failed to fetch"),
			);
			const isUp = await probeServerHealth("http://localhost:3142", 500);
			expect(isUp).toBe(false);
		});


		it("marks pane as offline when iframe loads empty document", async () => {
			vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(null, { status: 200 }),
			);

			render(
				<QuadIframePane
					title="문서"
					url="http://localhost:3142/docs"
					paneId="docs"
				/>,
			);

			const iframe = await screen.findByTestId("quad-docs-iframe");
			fireEvent.load(iframe);

			expect(
				await screen.findByTestId("quad-docs-offline"),
			).toBeInTheDocument();
		});

		it("leaves pane online when cross-origin load has null contentDocument and throwing contentWindow.document", async () => {
			vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(null, { status: 200 }),
			);

			render(
				<QuadIframePane
					title="문서"
					url="http://localhost:3142/docs"
					paneId="docs"
				/>,
			);

			const iframe = (await screen.findByTestId("quad-docs-iframe")) as HTMLIFrameElement;

			Object.defineProperty(iframe, "contentDocument", {
				value: null,
				configurable: true,
			});
			Object.defineProperty(iframe, "contentWindow", {
				value: {
					get document() {
						throw new DOMException(
							"Blocked a frame with origin from accessing a cross-origin frame.",
							"SecurityError",
						);
					},
				},
				configurable: true,
			});

			fireEvent.load(iframe);

			expect(screen.getByTestId("quad-docs-iframe")).toBeInTheDocument();
			expect(screen.queryByTestId("quad-docs-offline")).not.toBeInTheDocument();
		});
	});

	describe("Task 2: QuadIframePane external open, health probing, and observation sequence race conditions", () => {
		it("calls openUrl with configured URL on header ↗ button and footer button, with window.open fallback", async () => {
			vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
			const windowOpenSpy = vi.spyOn(window, "open").mockImplementation(() => null);

			render(
				<QuadIframePane
					title="문서"
					url="http://localhost:3142/docs"
					paneId="docs"
				/>,
			);

			// 1. Header ↗ button
			const externalBtn = screen.getByTestId("quad-docs-external");
			fireEvent.click(externalBtn);
			expect(mockOpenUrl).toHaveBeenCalledWith("http://localhost:3142/docs");

			// 2. Footer button
			const footerBtn = screen.getByTestId("quad-docs-open-browser");
			fireEvent.click(footerBtn);
			expect(mockOpenUrl).toHaveBeenCalledTimes(2);

			// 3. Fallback to window.open when openUrl rejects
			mockOpenUrl.mockRejectedValueOnce(new Error("openUrl error"));
			fireEvent.click(footerBtn);
			await waitFor(() => {
				expect(windowOpenSpy).toHaveBeenCalledWith("http://localhost:3142/docs", "_blank");
			});
		});

		it("probes server health against the pane's actual configured URL", async () => {
			const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

			render(
				<QuadIframePane
					title="작업판"
					url="http://127.0.0.1:8896/custom/path"
					paneId="dashboard"
				/>,
			);

			await waitFor(() => {
				expect(fetchSpy).toHaveBeenCalledWith(
					"http://127.0.0.1:8896/custom/path",
					expect.objectContaining({ mode: "no-cors" }),
				);
			});
		});

		it("recovers to online when URL changes from offline to healthy, showing checking state and ignoring late prior probe", async () => {
			let resolveUrlA: ((res: Response) => void) | null = null;

			vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
				const urlStr = String(input);
				if (urlStr === "http://localhost:3142/docs") {
					return new Promise((res) => {
						resolveUrlA = res;
					});
				}
				// URL B (8896) resolves immediately
				return Promise.resolve(new Response(null, { status: 200 }));
			});

			const { rerender } = render(
				<QuadIframePane
					title="문서"
					url="http://localhost:3142/docs"
					paneId="docs"
				/>,
			);

			// Initially checking
			expect(screen.getByTestId("quad-docs-checking")).toBeInTheDocument();

			// Change to live URL B before probe A finishes
			rerender(
				<QuadIframePane
					title="문서"
					url="http://127.0.0.1:8896/"
					paneId="docs"
				/>,
			);

			// URL B should resolve and display iframe
			await waitFor(() => {
				const iframe = screen.getByTestId("quad-docs-iframe");
				expect(iframe).toHaveAttribute("src", "http://127.0.0.1:8896/");
			});

			// Now late probe A fails
			if (resolveUrlA) {
				(resolveUrlA as (res: Response) => void)(new Response(null, { status: 500 }));
			}
			await new Promise((r) => setTimeout(r, 50));

			// Must still be online with URL B iframe
			expect(screen.getByTestId("quad-docs-iframe")).toBeInTheDocument();
			expect(screen.queryByTestId("quad-docs-offline")).not.toBeInTheDocument();
		});

		it("preserves offline notice when iframe error occurs before server probe resolves, and recovers on retry", async () => {
			let resolveProbe: ((res: Response) => void) | null = null;
			vi.spyOn(globalThis, "fetch").mockImplementation(() => {
				return new Promise((res) => {
					resolveProbe = res;
				});
			});

			render(
				<QuadIframePane
					title="문서"
					url="http://localhost:3142/docs"
					paneId="docs"
				/>,
			);

			// While probe is pending, trigger iframe load with empty document
			const iframe = screen.getByTestId("quad-docs-iframe");
			fireEvent.load(iframe);

			// Offline notice should appear because empty doc load increments observationSeq and sets online=false
			expect(await screen.findByTestId("quad-docs-offline")).toBeInTheDocument();

			// Now the slow probe succeeds
			if (resolveProbe) {
				(resolveProbe as (res: Response) => void)(new Response(null, { status: 200 }));
			}
			await new Promise((r) => setTimeout(r, 50));

			// Offline notice MUST NOT be overwritten by the stale probe response
			expect(screen.getByTestId("quad-docs-offline")).toBeInTheDocument();
			expect(screen.queryByTestId("quad-docs-iframe")).not.toBeInTheDocument();

			// Click retry -> starts new observation seq and new probe
			vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 200 }));
			fireEvent.click(screen.getByTestId("quad-docs-retry"));

			await waitFor(() => {
				expect(screen.getByTestId("quad-docs-iframe")).toBeInTheDocument();
			});
		});

		it("handles A->B->A probe races: second A success is preserved against late first A failure", async () => {
			let rejectFirstA: ((err: any) => void) | null = null;
			let callCount = 0;

			vi.spyOn(globalThis, "fetch").mockImplementation(() => {
				callCount++;
				if (callCount === 1) {
					// First probe for A is deferred
					return new Promise((_res, rej) => {
						rejectFirstA = rej;
					});
				}
				// Subsequent probes resolve immediately (status 200)
				return Promise.resolve(new Response(null, { status: 200 }));
			});

			const { rerender } = render(
				<QuadIframePane
					title="문서"
					url="http://localhost:3142/docs"
					paneId="docs"
				/>,
			);

			// Switch to B
			rerender(
				<QuadIframePane
					title="문서"
					url="http://127.0.0.1:8896/"
					paneId="docs"
				/>,
			);

			// Switch back to A (second A)
			rerender(
				<QuadIframePane
					title="문서"
					url="http://localhost:3142/docs"
					paneId="docs"
				/>,
			);

			// Second A resolves immediately with success
			await waitFor(() => {
				expect(screen.getByTestId("quad-docs-iframe")).toBeInTheDocument();
			});

			// Now first A probe rejects (fails) late
			if (rejectFirstA) {
				(rejectFirstA as (err: any) => void)(new TypeError("Late failure from first A"));
			}
			await new Promise((r) => setTimeout(r, 50));

			// Final state remains online (iframe visible)
			expect(screen.getByTestId("quad-docs-iframe")).toBeInTheDocument();
			expect(screen.queryByTestId("quad-docs-offline")).not.toBeInTheDocument();
		});

		it("handles A->B->A probe races: second A failure is preserved against late first A success", async () => {
			let resolveFirstA: ((res: any) => void) | null = null;
			let callCount = 0;

			vi.spyOn(globalThis, "fetch").mockImplementation(() => {
				callCount++;
				if (callCount === 1) {
					// First probe for A is deferred
					return new Promise((res) => {
						resolveFirstA = res;
					});
				}
				if (callCount === 2) {
					// Probe for B
					return Promise.resolve(new Response(null, { status: 200 }));
				}
				// Second A fails
				return Promise.reject(new TypeError("Second A failed"));
			});

			const { rerender } = render(
				<QuadIframePane
					title="문서"
					url="http://localhost:3142/docs"
					paneId="docs"
				/>,
			);

			// Switch to B
			rerender(
				<QuadIframePane
					title="문서"
					url="http://127.0.0.1:8896/"
					paneId="docs"
				/>,
			);

			// Switch back to A (second A)
			rerender(
				<QuadIframePane
					title="문서"
					url="http://localhost:3142/docs"
					paneId="docs"
				/>,
			);

			// Second A fails -> offline notice appears
			await waitFor(() => {
				expect(screen.getByTestId("quad-docs-offline")).toBeInTheDocument();
			});

			// Now first A probe resolves with success late
			if (resolveFirstA) {
				(resolveFirstA as (res: any) => void)(new Response(null, { status: 200 }));
			}
			await new Promise((r) => setTimeout(r, 50));

			// Final state must remain offline
			expect(screen.getByTestId("quad-docs-offline")).toBeInTheDocument();
			expect(screen.queryByTestId("quad-docs-iframe")).not.toBeInTheDocument();
		});
	});

	describe("Task 3: Configurable quad pane URLs, validation, and persistence", () => {
		function createMockTerminalSource(): TerminalSource {
			return {
				kind: "pty",
				pty: { pty_id: "pty-quad-1", pid: 1234 },
				launching: false,
				launchError: "",
				terminalReady: true,
				terminalError: "",
				workingDir: "/work/test",
				launch: vi.fn(async () => {}),
				retry: vi.fn(async () => {}),
				onTerminalReady: vi.fn(),
				onPtyExit: vi.fn(),
				runOpencode: vi.fn(async () => {}),
			};
		}

		it("normalizes quad pane URLs and rejects non-local hosts and disallowed schemes", () => {
			// Valid inputs
			expect(normalizeQuadPaneUrl("http://localhost:3142/docs")).toEqual({
				ok: true,
				url: "http://localhost:3142/docs",
			});
			expect(normalizeQuadPaneUrl("http://127.0.0.1:8896")).toEqual({
				ok: true,
				url: "http://127.0.0.1:8896/",
			});
			expect(normalizeQuadPaneUrl("http://[::1]:8896/board")).toEqual({
				ok: true,
				url: "http://[::1]:8896/board",
			});
			expect(normalizeQuadPaneUrl("https://localhost:8443")).toEqual({
				ok: true,
				url: "https://localhost:8443/",
			});
			expect(normalizeQuadPaneUrl("http://::1:8896")).toEqual({
				ok: true,
				url: "http://[::1]:8896/",
			});

			// Invalid inputs: reject examples from spec
			expect(normalizeQuadPaneUrl("https://example.com/").ok).toBe(false);
			expect(normalizeQuadPaneUrl("file:///C:/x").ok).toBe(false);
			expect(normalizeQuadPaneUrl("javascript:alert(1)").ok).toBe(false);
			expect(normalizeQuadPaneUrl("http://localhost@evil.example/").ok).toBe(false);
			expect(normalizeQuadPaneUrl("http://user:pw@localhost:8896/").ok).toBe(false);
			expect(normalizeQuadPaneUrl("http://127.0.0.2:8896/").ok).toBe(false);
			expect(normalizeQuadPaneUrl("http://localhost.evil.example/").ok).toBe(false);
			expect(normalizeQuadPaneUrl("").ok).toBe(false);
			expect(normalizeQuadPaneUrl("   ").ok).toBe(false);
			expect(normalizeQuadPaneUrl(123).ok).toBe(false);
			expect(normalizeQuadPaneUrl(null).ok).toBe(false);
			expect(normalizeQuadPaneUrl(undefined).ok).toBe(false);
			expect(normalizeQuadPaneUrl("ftp://localhost:8896").ok).toBe(false);
			expect(normalizeQuadPaneUrl("http://192.168.1.5:8896/").ok).toBe(false);
			expect(normalizeQuadPaneUrl("not a url").ok).toBe(false);
		});

		it("uses default URLs when no preference is configured", async () => {
			vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

			render(<WorkspaceQuadView terminalSource={createMockTerminalSource()} />);

			await waitFor(() => {
				const docsIframe = screen.getByTestId("quad-docs-iframe");
				expect(docsIframe).toHaveAttribute("src", "http://localhost:3142/docs");

				const boardIframe = screen.getByTestId("quad-dashboard-iframe");
				expect(boardIframe).toHaveAttribute("src", "http://127.0.0.1:8896/");
			});
		});

		it("persists edited docs URL via UI to ui-preferences and naia config, and recovers across simulated restart", async () => {
			vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
			await hydrateUiPreferences(null, { adkPath: "/test/adk", canPersist: true });

			const { unmount } = render(<WorkspaceQuadView terminalSource={createMockTerminalSource()} />);

			// Change docs URL
			fireEvent.click(screen.getByTestId("quad-docs-change-url"));
			const input = screen.getByTestId("quad-docs-url-input");
			fireEvent.change(input, { target: { value: "http://localhost:5000/custom-docs" } });
			fireEvent.click(screen.getByTestId("quad-docs-url-save"));

			// Check preferences updated
			await waitFor(() => {
				expect(getUiPreferencesSnapshot().workspaceQuadDocsUrl).toBe("http://localhost:5000/custom-docs");
				expect(mockWriteNaiaUiConfig).toHaveBeenCalledWith(
					expect.objectContaining({
						uiPreferences: expect.objectContaining({
							workspaceQuadDocsUrl: "http://localhost:5000/custom-docs",
						}),
					}),
					"/test/adk",
				);
			});

			const writtenDocsConfig = mockWriteNaiaUiConfig.mock.calls.at(-1)?.[0] as
				| Record<string, unknown>
				| undefined;
			expect(writtenDocsConfig).toBeDefined();

			unmount();

			// Simulate restart: reset preferences and hydrate with captured config from mockWriteNaiaUiConfig
			resetUiPreferencesForTests();
			await hydrateUiPreferences(
				writtenDocsConfig ?? null,
				{ adkPath: "/test/adk", canPersist: true },
			);

			render(<WorkspaceQuadView terminalSource={createMockTerminalSource()} />);

			await waitFor(() => {
				const docsIframe = screen.getByTestId("quad-docs-iframe");
				expect(docsIframe).toHaveAttribute("src", "http://localhost:5000/custom-docs");
				expect(docsIframe.getAttribute("src")).toBe("http://localhost:5000/custom-docs");
			});
		});

		it("persists edited board URL via UI to ui-preferences and naia config, and recovers across simulated restart", async () => {
			vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
			await hydrateUiPreferences(null, { adkPath: "/test/adk", canPersist: true });

			const { unmount } = render(<WorkspaceQuadView terminalSource={createMockTerminalSource()} />);

			// Change board URL
			fireEvent.click(screen.getByTestId("quad-dashboard-change-url"));
			const input = screen.getByTestId("quad-dashboard-url-input");
			fireEvent.change(input, { target: { value: "http://localhost:8896/custom-board" } });
			fireEvent.click(screen.getByTestId("quad-dashboard-url-save"));

			// Check preferences updated
			await waitFor(() => {
				expect(getUiPreferencesSnapshot().workspaceQuadBoardUrl).toBe("http://localhost:8896/custom-board");
				expect(mockWriteNaiaUiConfig).toHaveBeenCalledWith(
					expect.objectContaining({
						uiPreferences: expect.objectContaining({
							workspaceQuadBoardUrl: "http://localhost:8896/custom-board",
						}),
					}),
					"/test/adk",
				);
			});

			const writtenBoardConfig = mockWriteNaiaUiConfig.mock.calls.at(-1)?.[0] as
				| Record<string, unknown>
				| undefined;
			expect(writtenBoardConfig).toBeDefined();

			unmount();

			// Simulate restart: reset preferences and hydrate with captured config from mockWriteNaiaUiConfig
			resetUiPreferencesForTests();
			await hydrateUiPreferences(
				writtenBoardConfig ?? null,
				{ adkPath: "/test/adk", canPersist: true },
			);

			render(<WorkspaceQuadView terminalSource={createMockTerminalSource()} />);

			await waitFor(() => {
				const boardIframe = screen.getByTestId("quad-dashboard-iframe");
				expect(boardIframe).toHaveAttribute("src", "http://localhost:8896/custom-board");
				expect(boardIframe.getAttribute("src")).toBe("http://localhost:8896/custom-board");
			});
		});

		it("rejects invalid URL with role=alert on edit, supports cancel, and falls back to default if stored config is invalid", async () => {
			vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

			const { unmount } = render(<WorkspaceQuadView terminalSource={createMockTerminalSource()} />);

			// 1. Try to set invalid URL
			fireEvent.click(screen.getByTestId("quad-docs-change-url"));
			const input = screen.getByTestId("quad-docs-url-input");
			fireEvent.change(input, { target: { value: "http://external.domain.com" } });
			fireEvent.click(screen.getByTestId("quad-docs-url-save"));

			// Error alert should be visible
			const alert = screen.getByTestId("quad-docs-url-error");
			expect(alert).toHaveAttribute("role", "alert");
			expect(alert).toBeVisible();

			// Canceling closes edit and reverts
			fireEvent.click(screen.getByTestId("quad-docs-url-cancel"));
			expect(screen.queryByTestId("quad-docs-url-input")).not.toBeInTheDocument();
			expect(screen.getByTestId("quad-docs-iframe")).toHaveAttribute("src", "http://localhost:3142/docs");

			unmount();

			// 2. Pre-existing invalid config value triggers fallback notice and uses default URL
			resetUiPreferencesForTests();
			await hydrateUiPreferences(
				{ uiPreferences: { workspaceQuadDocsUrl: "http://invalid-external.com" } },
				{ adkPath: "/test/adk", canPersist: true },
			);

			render(<WorkspaceQuadView terminalSource={createMockTerminalSource()} />);

			await waitFor(() => {
				expect(screen.getByTestId("quad-docs-fallback-notice")).toBeVisible();
				expect(screen.getByTestId("quad-docs-iframe")).toHaveAttribute("src", "http://localhost:3142/docs");
			});
		});
	});

	describe("usePtyTerminalSource platform shell and lifecycle", () => {
		it("detects powershell on Windows and bash on Unix", () => {
			const originalNav = globalThis.navigator;

			Object.defineProperty(globalThis, "navigator", {
				value: { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
				configurable: true,
			});
			expect(detectDefaultShell()).toBe("powershell");

			Object.defineProperty(globalThis, "navigator", {
				value: { userAgent: "Mozilla/5.0 (X11; Linux x86_64)" },
				configurable: true,
			});
			expect(detectDefaultShell()).toBe("bash");

			Object.defineProperty(globalThis, "navigator", {
				value: originalNav,
				configurable: true,
			});
		});

		it("identifies absolute paths on Windows and POSIX", () => {
			expect(isAbsolutePath("C:\\Users\\test")).toBe(true);
			expect(isAbsolutePath("D:/work/repo")).toBe(true);
			expect(isAbsolutePath("/home/user/project")).toBe(true);
			expect(isAbsolutePath("\\\\server\\share")).toBe(true);

			expect(isAbsolutePath(".")).toBe(false);
			expect(isAbsolutePath("relative/path")).toBe(false);
			expect(isAbsolutePath("")).toBe(false);
			expect(isAbsolutePath(undefined)).toBe(false);
		});

		it("does not call pty_create when absolute path is not available and does not loop detection", async () => {
			mockInvoke.mockImplementation(async (cmd) => {
				if (cmd === "workspace_detect_adk_root") return "";
				if (cmd === "pty_create") {
					return { pty_id: "pty-session-test", pid: 1234 };
				}
				return "";
			});

			const { result } = renderHook(() =>
				usePtyTerminalSource({
					workspaceRoot: "relative/dir",
					enabled: true,
				}),
			);

			// Flush invoke promises and any subsequent microtasks/effects
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 50));
			});

			const ptyCalls = mockInvoke.mock.calls.filter(
				(c) => c[0] === "pty_create",
			);
			expect(ptyCalls).toHaveLength(0);

			const detectCalls = mockInvoke.mock.calls.filter(
				(c) => c[0] === "workspace_detect_adk_root",
			);
			expect(detectCalls.length).toBeLessThanOrEqual(1);

			expect(result.current.launching).toBe(false);
			expect(result.current.launchError).toBe("Absolute workspace directory required");
		});

		it("spawns PTY with command and absolute dir, kills on unmount", async () => {
			mockInvoke.mockImplementation(async (cmd) => {
				if (cmd === "pty_create") {
					return { pty_id: "pty-session-99", pid: 9999 };
				}
				if (cmd === "pty_kill") {
					return;
				}
				return "";
			});

			const { unmount } = renderHook(() =>
				usePtyTerminalSource({
					workspaceRoot: "D:/work/test-repo",
					shellCommand: "powershell",
					enabled: true,
				}),
			);

			await waitFor(() => {
				const createCalls = mockInvoke.mock.calls.filter(
					(c) => c[0] === "pty_create",
				);
				expect(createCalls).toHaveLength(1);
				expect(createCalls[0][1]).toMatchObject({
					command: "powershell",
					dir: "D:/work/test-repo",
				});
			});

			// Unmount should kill the session
			unmount();

			await waitFor(() => {
				const killCalls = mockInvoke.mock.calls.filter(
					(c) => c[0] === "pty_kill",
				);
				expect(killCalls).toHaveLength(1);
				expect(killCalls[0][1]).toEqual({ ptyId: "pty-session-99" });
			});
		});

		it("kills previous session and respawns when workspaceRoot changes", async () => {
			let idCounter = 1;
			mockInvoke.mockImplementation(async (cmd) => {
				if (cmd === "pty_create") {
					return { pty_id: `pty-session-${idCounter++}`, pid: 1000 };
				}
				if (cmd === "pty_kill") return;
				return "";
			});

			const { rerender } = renderHook(
				({ root }) =>
					usePtyTerminalSource({
						workspaceRoot: root,
						enabled: true,
					}),
				{ initialProps: { root: "C:/work/first" } },
			);

			await waitFor(() => {
				const createCalls = mockInvoke.mock.calls.filter(
					(c) => c[0] === "pty_create",
				);
				expect(createCalls).toHaveLength(1);
				expect(createCalls[0][1].dir).toBe("C:/work/first");
			});

			// Update workspace root
			rerender({ root: "C:/work/second" });

			await waitFor(() => {
				const killCalls = mockInvoke.mock.calls.filter(
					(c) => c[0] === "pty_kill",
				);
				expect(killCalls.length).toBeGreaterThanOrEqual(1);
				expect(killCalls[0][1]).toEqual({ ptyId: "pty-session-1" });

				const createCalls = mockInvoke.mock.calls.filter(
					(c) => c[0] === "pty_create",
				);
				expect(createCalls).toHaveLength(2);
				expect(createCalls[1][1].dir).toBe("C:/work/second");
			});
		});

		it("only writes initialCommand onTerminalReady once without newlines", async () => {
			vi.useFakeTimers();
			try {
				mockInvoke.mockImplementation(async (cmd) => {
					if (cmd === "pty_create") {
						return { pty_id: "pty-cmd-test", pid: 5555 };
					}
					return "";
				});

				const { result } = renderHook(() =>
					usePtyTerminalSource({
						workspaceRoot: "/work/safe",
						initialCommand: "opencode\nrm -rf", // Contains newline -> must reject
						enabled: true,
					}),
				);

				// Wait for launch to finish
				await vi.advanceTimersByTimeAsync(50);
				result.current.onTerminalReady();
				await vi.advanceTimersByTimeAsync(200);

				const writeCallsRejected = mockInvoke.mock.calls.filter(
					(c) => c[0] === "pty_write",
				);
				expect(writeCallsRejected).toHaveLength(0);
			} finally {
				vi.useRealTimers();
			}
		});

		describe("decidePtyAction decision table (Task 1 4-2)", () => {
			it("covers line 1: enabled=false stops if live pty exists, otherwise none", () => {
				expect(
					decidePtyAction({
						enabled: false,
						rootIsAbsolute: true,
						rootChangedSinceLastEnabled: true,
						hasLivePty: true,
						launching: false,
						errorKind: null,
						initialLaunchStarted: true,
					}),
				).toBe("stop");

				expect(
					decidePtyAction({
						enabled: false,
						rootIsAbsolute: true,
						rootChangedSinceLastEnabled: true,
						hasLivePty: false,
						launching: false,
						errorKind: null,
						initialLaunchStarted: true,
					}),
				).toBe("none");
			});

			it("covers line 2: launching=true and root changed to absolute yields invalidate", () => {
				expect(
					decidePtyAction({
						enabled: true,
						rootIsAbsolute: true,
						rootChangedSinceLastEnabled: true,
						hasLivePty: false,
						launching: true,
						errorKind: null,
						initialLaunchStarted: true,
					}),
				).toBe("invalidate");
			});

			it("covers line 3: launching=true without valid root change yields none", () => {
				expect(
					decidePtyAction({
						enabled: true,
						rootIsAbsolute: false,
						rootChangedSinceLastEnabled: true,
						hasLivePty: false,
						launching: true,
						errorKind: null,
						initialLaunchStarted: true,
					}),
				).toBe("none");

				expect(
					decidePtyAction({
						enabled: true,
						rootIsAbsolute: true,
						rootChangedSinceLastEnabled: false,
						hasLivePty: false,
						launching: true,
						errorKind: null,
						initialLaunchStarted: true,
					}),
				).toBe("none");
			});

			it("covers line 4: hasLivePty=true and root changed to absolute yields restart", () => {
				expect(
					decidePtyAction({
						enabled: true,
						rootIsAbsolute: true,
						rootChangedSinceLastEnabled: true,
						hasLivePty: true,
						launching: false,
						errorKind: null,
						initialLaunchStarted: true,
					}),
				).toBe("restart");
			});

			it("covers line 5: hasLivePty=true without valid root change yields none", () => {
				expect(
					decidePtyAction({
						enabled: true,
						rootIsAbsolute: true,
						rootChangedSinceLastEnabled: false,
						hasLivePty: true,
						launching: false,
						errorKind: null,
						initialLaunchStarted: true,
					}),
				).toBe("none");

				expect(
					decidePtyAction({
						enabled: true,
						rootIsAbsolute: false,
						rootChangedSinceLastEnabled: true,
						hasLivePty: true,
						launching: false,
						errorKind: null,
						initialLaunchStarted: true,
					}),
				).toBe("none");
			});

			it("covers line 6: errorKind other than missing-root and null yields none", () => {
				expect(
					decidePtyAction({
						enabled: true,
						rootIsAbsolute: true,
						rootChangedSinceLastEnabled: true,
						hasLivePty: false,
						launching: false,
						errorKind: "pty-create",
						initialLaunchStarted: true,
					}),
				).toBe("none");

				expect(
					decidePtyAction({
						enabled: true,
						rootIsAbsolute: true,
						rootChangedSinceLastEnabled: true,
						hasLivePty: false,
						launching: false,
						errorKind: "pty-exit",
						initialLaunchStarted: true,
					}),
				).toBe("none");
			});

			it("covers line 7: initialLaunchStarted=false yields launch", () => {
				expect(
					decidePtyAction({
						enabled: true,
						rootIsAbsolute: false,
						rootChangedSinceLastEnabled: false,
						hasLivePty: false,
						launching: false,
						errorKind: null,
						initialLaunchStarted: false,
					}),
				).toBe("launch");
			});

			it("covers line 8: errorKind=missing-root and root is absolute yields launch", () => {
				expect(
					decidePtyAction({
						enabled: true,
						rootIsAbsolute: true,
						rootChangedSinceLastEnabled: true,
						hasLivePty: false,
						launching: false,
						errorKind: "missing-root",
						initialLaunchStarted: true,
					}),
				).toBe("launch");
			});

			it("covers line 9: errorKind=null and root is absolute yields launch", () => {
				expect(
					decidePtyAction({
						enabled: true,
						rootIsAbsolute: true,
						rootChangedSinceLastEnabled: false,
						hasLivePty: false,
						launching: false,
						errorKind: null,
						initialLaunchStarted: true,
					}),
				).toBe("launch");
			});

			it("covers line 10: all other cases yield none", () => {
				expect(
					decidePtyAction({
						enabled: true,
						rootIsAbsolute: false,
						rootChangedSinceLastEnabled: true,
						hasLivePty: false,
						launching: false,
						errorKind: "missing-root",
						initialLaunchStarted: true,
					}),
				).toBe("none");

				expect(
					decidePtyAction({
						enabled: true,
						rootIsAbsolute: false,
						rootChangedSinceLastEnabled: false,
						hasLivePty: false,
						launching: false,
						errorKind: null,
						initialLaunchStarted: true,
					}),
				).toBe("none");
			});
		});

		it("Task 1 (1): spawns pty exactly once when enabled transitions from false to true with absolute root after missing-root error", async () => {
			mockInvoke.mockImplementation(async (cmd) => {
				if (cmd === "workspace_detect_adk_root") return "";
				if (cmd === "pty_create") return { pty_id: "pty-1", pid: 101 };
				return "";
			});

			const { result, rerender } = renderHook(
				({ root, enabled }: { root: string; enabled: boolean }) =>
					usePtyTerminalSource({
						workspaceRoot: root,
						enabled,
					}),
				{ initialProps: { root: "", enabled: true } },
			);

			await waitFor(() => {
				expect(result.current.launchError).toBe(
					"Absolute workspace directory required",
				);
			});
			expect(
				mockInvoke.mock.calls.filter((c) => c[0] === "pty_create"),
			).toHaveLength(0);

			// enabled=false 로 다시 렌더
			rerender({ root: "", enabled: false });

			// 그 상태에서 루트를 절대 경로로 다시 렌더
			rerender({ root: "/work/absolute-dir", enabled: false });

			// enabled=true 로 다시 렌더
			rerender({ root: "/work/absolute-dir", enabled: true });

			await waitFor(() => {
				const ptyCalls = mockInvoke.mock.calls.filter(
					(c) => c[0] === "pty_create",
				);
				expect(ptyCalls).toHaveLength(1);
				expect(ptyCalls[0][1].dir).toBe("/work/absolute-dir");
			});
		});

		it("Task 1 (2): retains single pty_create call without infinite retries when pty_create rejects", async () => {
			mockInvoke.mockImplementation(async (cmd) => {
				if (cmd === "pty_create") {
					throw new Error("pty_create failed: access denied");
				}
				return "";
			});

			const { result, rerender } = renderHook(
				({ root }: { root: string }) =>
					usePtyTerminalSource({
						workspaceRoot: root,
						enabled: true,
					}),
				{ initialProps: { root: "/work/valid" } },
			);

			await waitFor(() => {
				expect(result.current.launchError).toContain(
					"pty_create failed: access denied",
				);
			});
			expect(
				mockInvoke.mock.calls.filter((c) => c[0] === "pty_create"),
			).toHaveLength(1);

			// Rerender multiple times with same props
			rerender({ root: "/work/valid" });
			rerender({ root: "/work/valid" });
			rerender({ root: "/work/valid" });

			await new Promise((r) => setTimeout(r, 50));
			expect(
				mockInvoke.mock.calls.filter((c) => c[0] === "pty_create"),
			).toHaveLength(1);
		});

		it("Task 1 (3): does not auto-retry on root changes after pty-create failure, retries only via relaunch", async () => {
			mockInvoke.mockImplementation(async (cmd) => {
				if (cmd === "pty_create") {
					throw new Error("pty creation error");
				}
				return "";
			});

			const { result, rerender } = renderHook(
				({ root, enabled }: { root: string; enabled: boolean }) =>
					usePtyTerminalSource({
						workspaceRoot: root,
						enabled,
					}),
				{ initialProps: { root: "/work/first", enabled: true } },
			);

			await waitFor(() => {
				expect(result.current.launchError).toContain("pty creation error");
			});
			expect(
				mockInvoke.mock.calls.filter((c) => c[0] === "pty_create"),
			).toHaveLength(1);

			// (a) 켜진 채 루트를 다른 절대 경로로 변경 -> pty_create 호출 수 유지
			rerender({ root: "/work/second", enabled: true });
			await new Promise((r) => setTimeout(r, 50));
			expect(
				mockInvoke.mock.calls.filter((c) => c[0] === "pty_create"),
			).toHaveLength(1);

			// (b) 꺼진 동안 루트를 바꾼 뒤 다시 켬 -> pty_create 호출 수 유지
			rerender({ root: "/work/third", enabled: false });
			rerender({ root: "/work/third", enabled: true });
			await new Promise((r) => setTimeout(r, 50));
			expect(
				mockInvoke.mock.calls.filter((c) => c[0] === "pty_create"),
			).toHaveLength(1);

			// relaunch(retry) 호출 시 1회 증가
			await act(async () => {
				await result.current.retry();
			});
			expect(
				mockInvoke.mock.calls.filter((c) => c[0] === "pty_create"),
			).toHaveLength(2);
		});

		it("Task 1 (4): kills previous pty and spawns new pty when workspaceRoot changes, including after recovered pty-create error", async () => {
			let idCounter = 1;
			mockInvoke.mockImplementation(async (cmd) => {
				if (cmd === "pty_create") {
					return { pty_id: `pty-${idCounter++}`, pid: 200 };
				}
				if (cmd === "pty_kill") return;
				return "";
			});

			const { result, rerender } = renderHook(
				({ root }: { root: string }) =>
					usePtyTerminalSource({
						workspaceRoot: root,
						enabled: true,
					}),
				{ initialProps: { root: "/work/initial" } },
			);

			await waitFor(() => {
				expect(result.current.pty?.pty_id).toBe("pty-1");
			});

			// 루트 변경 -> pty_kill 1회, pty_create 2번째 호출
			rerender({ root: "/work/changed" });

			await waitFor(() => {
				expect(result.current.pty?.pty_id).toBe("pty-2");
			});
			const killCalls = mockInvoke.mock.calls.filter((c) => c[0] === "pty_kill");
			expect(killCalls).toHaveLength(1);
			expect(killCalls[0][1]).toEqual({ ptyId: "pty-1" });

			// pty-create 오류 후 relaunch 로 회복된 상태 검증
			mockInvoke.mockImplementation(async (cmd) => {
				if (cmd === "pty_create") {
					if (idCounter === 3) {
						idCounter++;
						throw new Error("temporary failure");
					}
					return { pty_id: `pty-${idCounter++}`, pid: 300 };
				}
				if (cmd === "pty_kill") return;
				return "";
			});

			await act(async () => {
				await result.current.retry();
			});
			expect(result.current.launchError).toContain("temporary failure");

			await act(async () => {
				await result.current.retry();
			});
			expect(result.current.pty?.pty_id).toBe("pty-4");

			// 이 상태에서 루트를 다른 절대 경로로 변경 -> 정상 재시작
			rerender({ root: "/work/final" });

			await waitFor(() => {
				expect(result.current.pty?.pty_id).toBe("pty-5");
			});
			const finalKills = mockInvoke.mock.calls.filter((c) => c[0] === "pty_kill");
			expect(finalKills.some((c) => c[1].ptyId === "pty-4")).toBe(true);
		});

		it("Task 1 (4-3): does not respawn pty after onPtyExit until user triggers relaunch", async () => {
			let idCounter = 1;
			mockInvoke.mockImplementation(async (cmd) => {
				if (cmd === "pty_create") {
					return { pty_id: `pty-${idCounter++}`, pid: 1234 };
				}
				if (cmd === "pty_kill") return;
				return "";
			});

			const { result, rerender } = renderHook(
				({ root, enabled }: { root: string; enabled: boolean }) =>
					usePtyTerminalSource({
						workspaceRoot: root,
						enabled,
					}),
				{ initialProps: { root: "/work/exit-test", enabled: true } },
			);

			await waitFor(() => {
				expect(result.current.pty?.pty_id).toBe("pty-1");
			});
			expect(
				mockInvoke.mock.calls.filter((c) => c[0] === "pty_create"),
			).toHaveLength(1);

			// PTY가 스스로 끝남 (onPtyExit 호출)
			act(() => {
				result.current.onPtyExit("pty-1");
			});

			expect(result.current.pty).toBeNull();
			expect(result.current.launchError).toBe(t("workspace.herdrExited"));

			// 다시 렌더, 루트 변경, 꺼졌다 켜기 해도 pty_create 호출 수 증가 없음
			rerender({ root: "/work/exit-test", enabled: true });
			rerender({ root: "/work/exit-test-2", enabled: true });
			rerender({ root: "/work/exit-test-2", enabled: false });
			rerender({ root: "/work/exit-test-2", enabled: true });

			await new Promise((r) => setTimeout(r, 50));
			expect(
				mockInvoke.mock.calls.filter((c) => c[0] === "pty_create"),
			).toHaveLength(1);

			// relaunch(retry) 호출 시 1회 증가
			await act(async () => {
				await result.current.retry();
			});
			await waitFor(() => {
				expect(result.current.pty?.pty_id).toBe("pty-2");
			});
			expect(
				mockInvoke.mock.calls.filter((c) => c[0] === "pty_create"),
			).toHaveLength(2);
		});

		describe("launch generation and cancellation race conditions (Task 1 4-4)", () => {
			it("(a) kills late pty and does not attach when disabled during slow pty_create, launching resets", async () => {
				let resolvePty1!: (val: unknown) => void;
				const pty1Promise = new Promise((resolve) => {
					resolvePty1 = resolve;
				});

				mockInvoke.mockImplementation(async (cmd) => {
					if (cmd === "pty_create") {
						await pty1Promise;
						return { pty_id: "pty-late-1", pid: 901 };
					}
					if (cmd === "pty_kill") return;
					return "";
				});

				const { result, rerender } = renderHook(
					({ enabled }: { enabled: boolean }) =>
						usePtyTerminalSource({
							workspaceRoot: "/work/race-a",
							enabled,
						}),
					{ initialProps: { enabled: true } },
				);

				// pty_create가 호출되어 응답 대기 중인 상태를 확인
				await waitFor(() => {
					expect(mockInvoke).toHaveBeenCalledWith("pty_create", expect.anything());
				});
				expect(result.current.launching).toBe(true);

				// pty_create 대기 중 꺼짐
				rerender({ enabled: false });
				expect(result.current.launching).toBe(false);

				// 늦게 온 PTY 응답 도착
				await act(async () => {
					resolvePty1(null);
					await new Promise((r) => setTimeout(r, 20));
				});

				// (d) finally 종료 후 launching 확인
				expect(result.current.launching).toBe(false);
				expect(result.current.pty).toBeNull();
				const killCalls = mockInvoke.mock.calls.filter(
					(c) => c[0] === "pty_kill",
				);
				expect(killCalls.some((c) => c[1].ptyId === "pty-late-1")).toBe(true);
			});

			it("(b) kills late pty and spawns exactly once for new root when workspaceRoot changes during slow pty_create", async () => {
				let resolvePty1!: (val: unknown) => void;
				const pty1Promise = new Promise((resolve) => {
					resolvePty1 = resolve;
				});

				let createCount = 0;
				mockInvoke.mockImplementation(async (cmd) => {
					if (cmd === "pty_create") {
						createCount++;
						if (createCount === 1) {
							await pty1Promise;
							return { pty_id: "pty-slow-root-1", pid: 902 };
						}
						return { pty_id: "pty-fast-root-2", pid: 903 };
					}
					if (cmd === "pty_kill") return;
					return "";
				});

				const { result, rerender } = renderHook(
					({ root }: { root: string }) =>
						usePtyTerminalSource({
							workspaceRoot: root,
							enabled: true,
						}),
					{ initialProps: { root: "/work/root-1" } },
				);

				// 1차 pty_create가 호출되어 응답 대기 중인 상태 확인
				await waitFor(() => {
					expect(createCount).toBe(1);
				});

				// pty_create 1차 호출 대기 중 루트를 다른 절대 경로로 변경
				rerender({ root: "/work/root-2" });

				// 1차 늦은 응답 해제
				await act(async () => {
					resolvePty1(null);
					await new Promise((r) => setTimeout(r, 50));
				});

				await waitFor(() => {
					expect(result.current.pty?.pty_id).toBe("pty-fast-root-2");
				});
				expect(result.current.launching).toBe(false);

				const killCalls = mockInvoke.mock.calls.filter(
					(c) => c[0] === "pty_kill",
				);
				expect(killCalls.some((c) => c[1].ptyId === "pty-slow-root-1")).toBe(true);

				const creates = mockInvoke.mock.calls.filter(
					(c) => c[0] === "pty_create",
				);
				expect(creates).toHaveLength(2);
				expect(creates[1][1].dir).toBe("/work/root-2");
			});

			it("(c) attaches only the final pty when cycled disabled->enabled during slow pty_create", async () => {
				let resolvePty1!: (val: unknown) => void;
				const pty1Promise = new Promise((resolve) => {
					resolvePty1 = resolve;
				});

				let createCount = 0;
				mockInvoke.mockImplementation(async (cmd) => {
					if (cmd === "pty_create") {
						createCount++;
						if (createCount === 1) {
							await pty1Promise;
							return { pty_id: "pty-cycle-1", pid: 904 };
						}
						return { pty_id: "pty-cycle-2", pid: 905 };
					}
					if (cmd === "pty_kill") return;
					return "";
				});

				const { result, rerender } = renderHook(
					({ enabled }: { enabled: boolean }) =>
						usePtyTerminalSource({
							workspaceRoot: "/work/cycle",
							enabled,
						}),
					{ initialProps: { enabled: true } },
				);

				// 1차 pty_create가 호출되어 응답 대기 중인 상태 확인
				await waitFor(() => {
					expect(createCount).toBe(1);
				});

				// 꺼짐 -> 켜짐
				rerender({ enabled: false });
				rerender({ enabled: true });

				// 1차 늦은 응답 해제
				await act(async () => {
					resolvePty1(null);
					await new Promise((r) => setTimeout(r, 50));
				});

				await waitFor(() => {
					expect(result.current.pty?.pty_id).toBe("pty-cycle-2");
				});
				expect(result.current.launching).toBe(false);

				const killCalls = mockInvoke.mock.calls.filter(
					(c) => c[0] === "pty_kill",
				);
				expect(killCalls.some((c) => c[1].ptyId === "pty-cycle-1")).toBe(true);
			});

			it("(e) late onPtyExit from stopped or restarted session does not corrupt state or delete new pty", async () => {
				let idCounter = 1;
				mockInvoke.mockImplementation(async (cmd) => {
					if (cmd === "pty_create") {
						return { pty_id: `pty-lateexit-${idCounter++}`, pid: 906 };
					}
					if (cmd === "pty_kill") return;
					return "";
				});

				const { result, rerender } = renderHook(
					({ root, enabled }: { root: string; enabled: boolean }) =>
						usePtyTerminalSource({
							workspaceRoot: root,
							enabled,
						}),
					{ initialProps: { root: "/work/exit-race", enabled: true } },
				);

				await waitFor(() => {
					expect(result.current.pty?.pty_id).toBe("pty-lateexit-1");
				});

				// 꺼짐으로 정리
				rerender({ root: "/work/exit-race", enabled: false });
				expect(result.current.pty).toBeNull();

				// 이전 PTY-1의 종료 콜백이 늦게 도착
				act(() => {
					result.current.onPtyExit("pty-lateexit-1");
				});
				expect(result.current.launchError).toBe("");

				// 다시 켜면 pty_create 1회 정상 호출
				rerender({ root: "/work/exit-race", enabled: true });
				await waitFor(() => {
					expect(result.current.pty?.pty_id).toBe("pty-lateexit-2");
				});

				// 재시작으로 PTY-2 -> PTY-3 변경
				rerender({ root: "/work/exit-race-2", enabled: true });
				await waitFor(() => {
					expect(result.current.pty?.pty_id).toBe("pty-lateexit-3");
				});

				// 이전 PTY-2의 늦은 종료 콜백 도착
				act(() => {
					result.current.onPtyExit("pty-lateexit-2");
				});
				// 새 PTY-3이 삭제되지 않고 유지됨
				expect(result.current.pty?.pty_id).toBe("pty-lateexit-3");
				expect(result.current.launchError).toBe("");
			});
		});

		describe("representative race condition tests (Task 1 4-5)", () => {
			it("(f) ignores late workspace_detect_adk_root completion after invalidation, preventing stale workingDir and extra pty_create", async () => {
				let resolveDetect!: (val: string) => void;
				const detectPromise = new Promise<string>((resolve) => {
					resolveDetect = resolve;
				});

				const createCalls: string[] = [];
				mockInvoke.mockImplementation(async (cmd, args: any) => {
					if (cmd === "workspace_detect_adk_root") {
						return await detectPromise;
					}
					if (cmd === "pty_create") {
						createCalls.push(args.dir);
						return { pty_id: `pty-${createCalls.length}`, pid: 910 };
					}
					if (cmd === "pty_kill") return;
					return "";
				});

				// 빈 루트로 초기 실행 -> detect 시작
				const { result, rerender } = renderHook(
					({ root, enabled }: { root: string; enabled: boolean }) =>
						usePtyTerminalSource({
							workspaceRoot: root,
							enabled,
						}),
					{ initialProps: { root: "", enabled: true } },
				);

				// detect 대기 중 루트를 다른 절대 경로로 변경
				rerender({ root: "/work/new-absolute", enabled: true });

				// 새 실행으로 pty 생성 완료 대기
				await waitFor(() => {
					expect(result.current.workingDir).toBe("/work/new-absolute");
					expect(result.current.pty?.pty_id).toBe("pty-1");
				});

				// 이전 탐지 결과 도착
				await act(async () => {
					resolveDetect("/work/stale-detected");
					await new Promise((r) => setTimeout(r, 50));
				});

				// workingDir가 바뀌지 않고, 이전 탐지에 의한 추가 pty_create 없음
				expect(result.current.workingDir).toBe("/work/new-absolute");
				expect(createCalls).toEqual(["/work/new-absolute"]);
			});

			it("(g) ignores stale onTerminalReady from superseded pty and maintains null pty intermediate render order", async () => {
				let ptyCount = 0;
				mockInvoke.mockImplementation(async (cmd) => {
					if (cmd === "pty_create") {
						ptyCount++;
						return { pty_id: `pty-ready-${ptyCount}`, pid: 920 + ptyCount };
					}
					if (cmd === "pty_write") return;
					if (cmd === "pty_kill") return;
					return "";
				});

				const renderHistory: Array<{ pty: string | null; ready: boolean }> = [];

				const { result, rerender } = renderHook(
					({ root }: { root: string }) => {
						const res = usePtyTerminalSource({
							workspaceRoot: root,
							initialCommand: "opencode-init",
							enabled: true,
						});
						renderHistory.push({
							pty: res.pty?.pty_id ?? null,
							ready: res.terminalReady,
						});
						return res;
					},
					{ initialProps: { root: "/work/pty-a" } },
				);

				await waitFor(() => {
					expect(result.current.pty?.pty_id).toBe("pty-ready-1");
				});

				// PTY-1의 onTerminalReady 콜백을 따로 캡처
				const pty1OnTerminalReady = result.current.onTerminalReady;

				// 루트 변경으로 PTY-2 부착 (재시작)
				rerender({ root: "/work/pty-b" });

				await waitFor(() => {
					expect(result.current.pty?.pty_id).toBe("pty-ready-2");
				});

				// 재시작 중 pty 가 null 인 렌더가 새 PTY 연결보다 먼저 커밋됨을 단정
				const nullPtyIndex = renderHistory.findIndex(
					(snap, i) => i > 0 && snap.pty === null,
				);
				const pty2Index = renderHistory.findIndex(
					(snap) => snap.pty === "pty-ready-2",
				);
				expect(nullPtyIndex).toBeGreaterThan(-1);
				expect(nullPtyIndex).toBeLessThan(pty2Index);

				// PTY-1의 준비 콜백 호출 -> 무시되어야 함
				act(() => {
					pty1OnTerminalReady();
				});

				await new Promise((r) => setTimeout(r, 150));
				expect(
					mockInvoke.mock.calls.filter((c) => c[0] === "pty_write"),
				).toHaveLength(0);

				// PTY-2의 준비 콜백 호출 -> 정상 동작
				act(() => {
					result.current.onTerminalReady();
				});

				await waitFor(() => {
					const writes = mockInvoke.mock.calls.filter(
						(c) => c[0] === "pty_write",
					);
					expect(writes).toHaveLength(1);
					expect(writes[0][1]).toEqual({
						ptyId: "pty-ready-2",
						data: "opencode-init\r",
					});
				});
			});

			it("(i) discards superseded retry when root changes during killPty, resulting in single pty for the latest root", async () => {
				let resolveKill!: () => void;
				const killPromise = new Promise<void>((resolve) => {
					resolveKill = resolve;
				});

				const createCalls: string[] = [];
				mockInvoke.mockImplementation(async (cmd, args: any) => {
					if (cmd === "pty_create") {
						createCalls.push(args.dir);
						return { pty_id: `pty-retry-${createCalls.length}`, pid: 930 };
					}
					if (cmd === "pty_kill") {
						await killPromise;
						return;
					}
					return "";
				});

				const { result, rerender } = renderHook(
					({ root }: { root: string }) =>
						usePtyTerminalSource({
							workspaceRoot: root,
							enabled: true,
						}),
					{ initialProps: { root: "/work/retry-1" } },
				);

				await waitFor(() => {
					expect(result.current.pty?.pty_id).toBe("pty-retry-1");
				});

				// retry 호출 시작 (killPty 대기)
				const retryPromise = act(async () => {
					void result.current.retry();
				});

				// killPty 대기 도중 루트를 다른 절대 경로로 변경
				rerender({ root: "/work/retry-2" });

				// killPty 완료
				await act(async () => {
					resolveKill();
					await retryPromise;
					await new Promise((r) => setTimeout(r, 50));
				});

				await waitFor(() => {
					expect(result.current.pty?.pty_id).toBe("pty-retry-2");
				});

				// 이전 재시도는 pty_create를 추가로 부르지 않고, 최종 pty는 retry-2에 대한 것 1개
				const creates = mockInvoke.mock.calls.filter(
					(c) => c[0] === "pty_create",
				);
				expect(creates).toHaveLength(2);
				expect(creates[1][1].dir).toBe("/work/retry-2");
			});
		});
	});
});
