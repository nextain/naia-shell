// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
import { WorkspaceQuadView } from "../WorkspaceQuadView";
import type { TerminalSource } from "../terminal-source";
import { detectDefaultShell } from "../usePtyTerminalSource";

const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
	invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock("../Terminal", () => ({
	Terminal: forwardRef<TerminalHandle, { pty_id: string }>(
		function MockTerminal({ pty_id }, ref) {
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

	describe("WorkspaceQuadView 3-pane rendering and resizing", () => {
		function createMockTerminalSource(overrides: Partial<TerminalSource> = {}): TerminalSource {
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

			// Both resize handles exist
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

		it("applies saved split ratios from UI_PREFERENCE_KEYS", () => {
			void patchUiPreferences({
				[UI_PREFERENCE_KEYS.workspaceSplitRatios]: [0.4, 0.3, 0.3],
			});

			const source = createMockTerminalSource();
			render(
				<WorkspaceQuadView
					terminalSource={source}
					terminalRef={createRef()}
					workspaceRoot="/work/test"
				/>,
			);

			const terminalPane = screen.getByTestId("quad-pane-terminal");
			expect(terminalPane.style.flex).toContain("0.4");
		});

		it("updates and persists ratios when dragging resize handles", () => {
			const source = createMockTerminalSource();
			const { container } = render(
				<WorkspaceQuadView
					terminalSource={source}
					terminalRef={createRef()}
					workspaceRoot="/work/test"
				/>,
			);

			const quadContainer = container.querySelector(".workspace-quad") as HTMLElement;
			// Mock getBoundingClientRect
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

			// Simulate pointer drag on handle 0 (move 100px right = +0.1 ratio)
			fireEvent.pointerDown(handle0, { clientX: 340, pointerId: 1 });
			fireEvent.pointerMove(handle0, { clientX: 440, pointerId: 1 });
			fireEvent.pointerUp(handle0, { pointerId: 1 });

			const snapshot = getUiPreferencesSnapshot();
			const ratios = snapshot[UI_PREFERENCE_KEYS.workspaceSplitRatios] as number[];
			expect(ratios).toBeDefined();
			expect(ratios[0]).toBeCloseTo(0.44, 2);
			expect(ratios[1]).toBeCloseTo(0.23, 2);
		});
	});

	describe("QuadIframePane & 3142 health check probe", () => {
		it("probes server health and returns true when server responds", async () => {
			vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 200 }));
			const isUp = await probeServerHealth("http://localhost:3142", 500);
			expect(isUp).toBe(true);
		});

		it("probes server health and returns false when fetch rejects (connection refused)", async () => {
			vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("Failed to fetch"));
			const isUp = await probeServerHealth("http://localhost:3142", 500);
			expect(isUp).toBe(false);
		});

		it("renders offline banner when 3142 is not responding, then recovers on retry", async () => {
			// Initially fetch rejects
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

			// Should show offline notice
			expect(await screen.findByTestId("quad-dashboard-offline")).toBeInTheDocument();
			expect(screen.getByText("대시보드가 꺼져 있습니다")).toBeVisible();
			expect(screen.getByTestId("quad-dashboard-retry")).toBeVisible();

			// Click retry button
			fireEvent.click(screen.getByTestId("quad-dashboard-retry"));

			// After retry succeeds, iframe should appear
			await waitFor(() => {
				expect(screen.getByTestId("quad-dashboard-iframe")).toBeInTheDocument();
			});
			expect(screen.getByTestId("quad-dashboard-iframe")).toHaveAttribute(
				"src",
				"http://localhost:3142",
			);
		});
	});

	describe("usePtyTerminalSource default shell detection", () => {
		it("detects default shell based on platform", () => {
			const shell = detectDefaultShell();
			expect(["powershell", "bash"]).toContain(shell);
		});
	});
});
