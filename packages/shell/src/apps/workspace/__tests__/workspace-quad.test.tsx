// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { createRef, forwardRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	UI_PREFERENCE_KEYS,
	getUiPreferencesSnapshot,
	patchUiPreferences,
	resetUiPreferencesForTests,
} from "../../../lib/ui-preferences";
import { QuadIframePane, probeServerHealth } from "../QuadIframePane";
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
		mockInvoke.mockReset();
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
			expect(screen.getByText("문서 서버가 꺼져 있습니다")).toBeVisible();
			expect(
				screen.getByText(
					"3142 포트에서 문서 서버를 기동한 후 다시 시도해 주세요.",
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
			expect(screen.getByText("대시보드가 꺼져 있습니다")).toBeVisible();
			expect(
				screen.getByText("3142 포트에서 ADK 서버를 기동한 후 다시 시도해 주세요."),
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
