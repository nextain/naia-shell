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
	});
});
