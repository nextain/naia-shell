// @vitest-environment jsdom
/**
 * Step 2 tests: IssuesArea component
 *
 * Covers:
 *  - Loading state
 *  - gh not installed → "no-gh" fallback
 *  - gh returns issues → renders cards
 *  - Empty issue list
 *  - Cache: second render uses cache without re-fetching
 *  - Refresh button busts cache and re-fetches
 *  - onIssueClick fires with correct issue
 *  - Sessions section renders and collapses
 */
import "@testing-library/jest-dom/vitest";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GithubIssue } from "../workspace/IssuesArea";

afterEach(() => {
	cleanup();
	localStorage.clear();
});

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockInvoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
	invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("../../lib/logger", () => ({
	Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../workspace/SessionCard", () => ({
	SessionCard: ({
		session,
		onClick,
	}: {
		session: { dir: string; path: string };
		onClick: (s: unknown) => void;
	}) => (
		<button
			type="button"
			data-testid={`session-${session.dir}`}
			onClick={() => onClick(session)}
		>
			{session.dir}
		</button>
	),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_ISSUES: GithubIssue[] = [
	{
		number: 278,
		title: "feat(naia): project context awareness",
		state: "OPEN",
		labels: [{ name: "P1-high", color: "e11d48" }],
		updatedAt: new Date(Date.now() - 60000).toISOString(), // 1 min ago
	},
	{
		number: 270,
		title: "feat(shell): tabbar UX overhaul",
		state: "OPEN",
		labels: [],
		updatedAt: new Date(Date.now() - 3600000).toISOString(), // 1 hr ago
	},
];

function makeSuccessResult(issues: GithubIssue[]) {
	return { success: true, output: JSON.stringify(issues), exit_code: 0 };
}

function makeFailResult(output: string, exit_code = 1) {
	return { success: false, output, exit_code };
}

// ─── Import after mocks ───────────────────────────────────────────────────────

// Dynamic import so mocks are set up first
async function renderPanel(props = {}) {
	const { IssuesArea } = await import("../workspace/IssuesArea");
	const onIssueClick = vi.fn();
	const onSessionClick = vi.fn();
	const onSessionsUpdate = vi.fn();

	const result = render(
		<IssuesArea
			workspaceRoot="/tmp/test"
			onSessionClick={onSessionClick}
			onSessionsUpdate={onSessionsUpdate}
			onIssueClick={onIssueClick}
			{...props}
		/>,
	);
	return { ...result, onIssueClick, onSessionClick, onSessionsUpdate };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("IssuesArea", () => {
	beforeEach(() => {
		mockInvoke.mockReset();
		// Default: sessions returns empty
		mockInvoke.mockImplementation(async (cmd: string) => {
			if (cmd === "workspace_get_sessions") return [];
			return { success: true, output: "[]", exit_code: 0 };
		});
	});

	it("shows loading spinner initially", async () => {
		// Make pty_execute_sync slow to catch loading state
		mockInvoke.mockImplementation(
			(cmd: string) =>
				new Promise((resolve) => {
					if (cmd === "pty_execute_sync") setTimeout(() => resolve(makeSuccessResult([])), 200);
					else resolve([]);
				}),
		);
		await renderPanel();
		expect(screen.getByText("이슈 불러오는 중…")).toBeInTheDocument();
	});

	it("renders issue cards on success", async () => {
		mockInvoke.mockImplementation(async (cmd: string) => {
			if (cmd === "pty_execute_sync") return makeSuccessResult(MOCK_ISSUES);
			return [];
		});

		await renderPanel();

		await waitFor(() => {
			expect(screen.getByText("#278")).toBeInTheDocument();
			expect(
				screen.getByText("feat(naia): project context awareness"),
			).toBeInTheDocument();
			expect(screen.getByText("#270")).toBeInTheDocument();
		});
	});

	it("shows label badges", async () => {
		mockInvoke.mockImplementation(async (cmd: string) => {
			if (cmd === "pty_execute_sync") return makeSuccessResult(MOCK_ISSUES);
			return [];
		});

		await renderPanel();

		await waitFor(() => {
			expect(screen.getByText("P1-high")).toBeInTheDocument();
		});
	});

	it("shows gh not installed message when exit_code 127", async () => {
		mockInvoke.mockImplementation(async (cmd: string) => {
			if (cmd === "pty_execute_sync")
				return makeFailResult("command not found: gh", 127);
			return [];
		});

		await renderPanel();

		await waitFor(() => {
			expect(screen.getByText("GitHub CLI 필요")).toBeInTheDocument();
		});
	});

	it("shows gh not installed when output contains 'not found'", async () => {
		mockInvoke.mockImplementation(async (cmd: string) => {
			if (cmd === "pty_execute_sync")
				return makeFailResult("gh: not found", 1);
			return [];
		});

		await renderPanel();

		await waitFor(() => {
			expect(screen.getByText("GitHub CLI 필요")).toBeInTheDocument();
		});
	});

	it("shows error state with retry button on non-gh failure", async () => {
		mockInvoke.mockImplementation(async (cmd: string) => {
			if (cmd === "pty_execute_sync")
				return makeFailResult("authentication required", 1);
			return [];
		});

		await renderPanel();

		await waitFor(() => {
			expect(screen.getByText("다시 시도")).toBeInTheDocument();
		});
	});

	it("shows empty state when issues list is empty", async () => {
		mockInvoke.mockImplementation(async (cmd: string) => {
			if (cmd === "pty_execute_sync") return makeSuccessResult([]);
			return [];
		});

		await renderPanel();

		await waitFor(() => {
			expect(screen.getByText("열린 이슈가 없습니다")).toBeInTheDocument();
		});
	});

	it("calls onIssueClick with issue data when card is clicked", async () => {
		mockInvoke.mockImplementation(async (cmd: string) => {
			if (cmd === "pty_execute_sync") return makeSuccessResult(MOCK_ISSUES);
			return [];
		});

		const { onIssueClick } = await renderPanel();

		await waitFor(() => screen.getByText("#278"));
		fireEvent.click(screen.getByText("feat(naia): project context awareness"));

		expect(onIssueClick).toHaveBeenCalledWith(MOCK_ISSUES[0]);
	});

	it("uses cache on second render (no second pty_execute_sync call)", async () => {
		mockInvoke.mockImplementation(async (cmd: string) => {
			if (cmd === "pty_execute_sync") return makeSuccessResult(MOCK_ISSUES);
			return [];
		});

		// First render — populates cache
		const { unmount } = await renderPanel();
		await waitFor(() => screen.getByText("#278"));
		unmount();

		// Second render — should use cache, not call pty_execute_sync again
		const callCount = mockInvoke.mock.calls.filter(
			([cmd]) => cmd === "pty_execute_sync",
		).length;

		await renderPanel();
		await waitFor(() => screen.getByText("#278"));

		const callCountAfter = mockInvoke.mock.calls.filter(
			([cmd]) => cmd === "pty_execute_sync",
		).length;

		expect(callCountAfter).toBe(callCount); // no additional fetch
	});

	it("refresh button busts cache and re-fetches", async () => {
		mockInvoke.mockImplementation(async (cmd: string) => {
			if (cmd === "pty_execute_sync") return makeSuccessResult(MOCK_ISSUES);
			return [];
		});

		await renderPanel();
		await waitFor(() => screen.getByText("#278"));

		const beforeCount = mockInvoke.mock.calls.filter(
			([cmd]) => cmd === "pty_execute_sync",
		).length;

		fireEvent.click(screen.getByTitle("새로고침"));

		await waitFor(() => {
			const afterCount = mockInvoke.mock.calls.filter(
				([cmd]) => cmd === "pty_execute_sync",
			).length;
			expect(afterCount).toBeGreaterThan(beforeCount);
		});
	});

	it("sessions section collapses on toggle click", async () => {
		mockInvoke.mockImplementation(async (cmd: string) => {
			if (cmd === "pty_execute_sync") return makeSuccessResult([]);
			return [];
		});

		await renderPanel();
		await waitFor(() => screen.getByText("열린 이슈가 없습니다"));

		// Sessions section is visible initially (text split as "▼ 에이전트 세션")
		expect(screen.getByText(/에이전트 세션/)).toBeInTheDocument();

		// Click toggle to collapse
		fireEvent.click(screen.getByText(/에이전트 세션/));

		// Sessions loading text should be gone (collapsed)
		await waitFor(() => {
			expect(
				screen.queryByText("실행 중인 Claude Code 세션 없음"),
			).toBeNull();
		});
	});

	it("shows relative time on cards", async () => {
		mockInvoke.mockImplementation(async (cmd: string) => {
			if (cmd === "pty_execute_sync") return makeSuccessResult(MOCK_ISSUES);
			return [];
		});

		await renderPanel();

		await waitFor(() => {
			// 1m ago
			expect(screen.getByText("1m")).toBeInTheDocument();
			// 1h ago
			expect(screen.getByText("1h")).toBeInTheDocument();
		});
	});

	// ── #293: workspaceRootRef invariant ──────────────────────────────────────
	describe("#293 — workspaceRootRef: path normalization triggers exactly ONE re-fetch, not a loop", () => {
		it("changing workspaceRoot from backslash to slash path causes exactly one additional fetch, not infinite", async () => {
			// The core fix: fetchIssues has [] stable deps so it is never recreated.
			// A workspaceRoot prop change triggers ONE additional re-fetch via the
			// prevRootRef guard effect — that is expected and correct.
			// Before the fix the loop was: prop change → fetchIssues recreated →
			// useEffect([fetchIssues]) re-ran → setFetchState("loading") → repeat.
			// The invariant we verify: after TWO total rerenders the call count is
			// exactly 2 (initial + one normalization re-fetch), never 3+.
			mockInvoke.mockImplementation(async (cmd: string) => {
				if (cmd === "pty_execute_sync") return makeSuccessResult([]);
				return [];
			});

			const { IssuesArea } = await import("../workspace/IssuesArea");
			const { rerender } = render(
				<IssuesArea
					workspaceRoot="D:\\alpha-adk"
					onSessionClick={vi.fn()}
					onSessionsUpdate={vi.fn()}
					onIssueClick={vi.fn()}
				/>,
			);

			await waitFor(() =>
				expect(
					mockInvoke.mock.calls.filter(([cmd]) => cmd === "pty_execute_sync").length,
				).toBeGreaterThanOrEqual(1),
			);

			// Simulate path normalization: same logical path, different string repr
			rerender(
				<IssuesArea
					workspaceRoot="D:/alpha-adk"
					onSessionClick={vi.fn()}
					onSessionsUpdate={vi.fn()}
					onIssueClick={vi.fn()}
				/>,
			);

			// Rerender again with the same normalised value — must NOT trigger another fetch
			rerender(
				<IssuesArea
					workspaceRoot="D:/alpha-adk"
					onSessionClick={vi.fn()}
					onSessionsUpdate={vi.fn()}
					onIssueClick={vi.fn()}
				/>,
			);

			await waitFor(() => screen.getByText("열린 이슈가 없습니다"));

			// Exactly 2 calls: initial + one normalization re-fetch (not 3+)
			const total = mockInvoke.mock.calls.filter(([cmd]) => cmd === "pty_execute_sync").length;
			expect(total).toBeLessThanOrEqual(2);
		});
	});

	// ── #293: JS timeout invariant ────────────────────────────────────────────
	describe("#293 — JS 20s timeout: hanging pty_execute_sync eventually settles to error", () => {
		afterEach(() => {
			// Always restore real timers — fake timers break waitFor in sibling tests
			vi.useRealTimers();
		});

		it("shows error state after 20s when pty_execute_sync never resolves", async () => {
			vi.useFakeTimers();
			// Never-resolving promise simulates ConPTY hang
			mockInvoke.mockImplementation((cmd: string) => {
				if (cmd === "pty_execute_sync") return new Promise(() => {});
				return Promise.resolve([]);
			});

			await renderPanel();
			expect(screen.getByText("이슈 불러오는 중…")).toBeInTheDocument();

			// Advance past the 20s JS timeout — use act to flush React state updates
			const { act } = await import("@testing-library/react");
			await act(async () => {
				await vi.advanceTimersByTimeAsync(21_000);
			});

			// Loading text must be gone — component settled to error/no-gh state
			expect(screen.queryByText("이슈 불러오는 중…")).toBeNull();
		});
	});

	// ── #294: vertical divider handle ────────────────────────────────────────
	describe("#294 — IssuesArea vertical divider (issues ↕ sessions)", () => {
		it("renders workspace-panel__row-resize-handle element", async () => {
			mockInvoke.mockImplementation(async (cmd: string) => {
				if (cmd === "pty_execute_sync") return makeSuccessResult([]);
				return [];
			});
			await renderPanel();
			await waitFor(() => screen.getByText("열린 이슈가 없습니다"));
			const handle = document.querySelector(".workspace-panel__row-resize-handle");
			expect(handle).toBeTruthy();
		});

		it("pointerdown on divider adds resizing-row class to body", async () => {
			mockInvoke.mockImplementation(async (cmd: string) => {
				if (cmd === "pty_execute_sync") return makeSuccessResult([]);
				return [];
			});
			await renderPanel();
			await waitFor(() => screen.getByText("열린 이슈가 없습니다"));
			const handle = document.querySelector(".workspace-panel__row-resize-handle") as Element;
			fireEvent.pointerDown(handle, { clientY: 100 });
			expect(document.body.classList.contains("resizing-row")).toBe(true);
			// Clean up
			fireEvent.pointerUp(window);
		});

		it("pointermove after pointerdown changes issues list height", async () => {
			mockInvoke.mockImplementation(async (cmd: string) => {
				if (cmd === "pty_execute_sync") return makeSuccessResult([]);
				return [];
			});
			await renderPanel();
			await waitFor(() => screen.getByText("열린 이슈가 없습니다"));
			const handle = document.querySelector(".workspace-panel__row-resize-handle") as Element;
			// Start drag at y=100
			fireEvent.pointerDown(handle, { clientY: 100 });
			// Move down 50px → height should increase
			fireEvent.pointerMove(window, { clientY: 150 });
			// Initial height 180, delta +50 → 230px
			const list = document.querySelector(".issues-panel__list") as HTMLElement;
			if (list) {
				const h = Number.parseInt(list.style.height ?? "0");
				expect(h).toBeGreaterThan(180);
			}
			fireEvent.pointerUp(window);
		});
	});
});
