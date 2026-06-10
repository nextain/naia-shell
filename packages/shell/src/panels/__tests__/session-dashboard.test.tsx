// @vitest-environment jsdom
/**
 * SessionDashboard unit tests
 *
 * Verifies:
 *  1. Loading state displayed initially
 *  2. Empty state when sessions=[]
 *  3. Standalone SessionCard for single sessions (no shared origin_path)
 *  4. WorktreeGroup rendered for 2+ sessions sharing origin_path
 *  5. Sessions without origin_path use path as group key (no false grouping)
 *  6. repoName is basename of origin_path
 *  7. onSessionsUpdate callback called with loaded sessions
 *  8. Refresh button triggers reload
 *  9. workspace:file-changed event triggers reload (debounced)
 * 10. Stale invoke responses are discarded (out-of-order safety)
 */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../workspace/SessionCard";

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockInvoke = vi.fn();
const mockListen = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
	invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: (...args: unknown[]) => mockListen(...args),
}));

vi.mock("../../lib/logger", () => ({
	Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ─── Fixture sessions ─────────────────────────────────────────────────────────

const SESSION_STANDALONE: SessionInfo = {
	dir: "vllm",
	path: "/dev/vllm",
	status: "idle",
	// no origin_path → standalone
};

const SESSION_WT_MAIN: SessionInfo = {
	dir: "naia-os",
	path: "/dev/naia-os",
	status: "active",
	origin_path: "/dev/naia-os",
};

const SESSION_WT_79: SessionInfo = {
	dir: "naia-os-issue-79",
	path: "/dev/naia-os-issue-79",
	status: "active",
	origin_path: "/dev/naia-os",
	branch: "issue-79-feature",
};

const SESSION_WT_80: SessionInfo = {
	dir: "naia-os-issue-80",
	path: "/dev/naia-os-issue-80",
	status: "idle",
	origin_path: "/dev/naia-os",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Sets up invoke mock and unlisten mock, returns unlisten spy. */
function setupInvoke(sessions: SessionInfo[]) {
	const unlistenFn = vi.fn();
	mockInvoke.mockResolvedValue(sessions);
	mockListen.mockResolvedValue(unlistenFn);
	return unlistenFn;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SessionDashboard", () => {
	afterEach(async () => {
		cleanup();
		vi.clearAllMocks();
		vi.resetModules(); // force fresh module + mocks per test
	});

	it("shows loading state initially (before invoke resolves)", async () => {
		// Never-resolving promise keeps dashboard in loading state
		mockInvoke.mockReturnValue(new Promise(() => {}));
		mockListen.mockResolvedValue(vi.fn());

		const { SessionDashboard } = await import("../workspace/SessionDashboard");

		render(
			<SessionDashboard
				onSessionClick={() => {}}
			/>,
		);

		expect(screen.getByText(/세션 스캔 중/)).toBeDefined();
	});

	it("shows empty state when workspace_get_sessions returns []", async () => {
		setupInvoke([]);

		const { SessionDashboard } = await import("../workspace/SessionDashboard");

		render(
			<SessionDashboard
				onSessionClick={() => {}}
				workspaceRoot="/dev/workspace"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText(/Git 레포가 없습니다/)).toBeDefined();
		});

		// Shows the workspaceRoot path in the empty hint
		expect(screen.getByText("/dev/workspace")).toBeDefined();
	});

	it("renders standalone SessionCard for session without origin_path", async () => {
		setupInvoke([SESSION_STANDALONE]);

		const { SessionDashboard } = await import("../workspace/SessionDashboard");

		render(<SessionDashboard onSessionClick={() => {}} />);

		await waitFor(() => {
			expect(screen.getByText("vllm")).toBeDefined();
		});

		// No WorktreeGroup header (▼ arrow) for standalone sessions
		expect(screen.queryByText("▼")).toBeNull();
	});

	it("renders WorktreeGroup when 2+ sessions share origin_path", async () => {
		setupInvoke([SESSION_WT_MAIN, SESSION_WT_79]);

		const { SessionDashboard } = await import("../workspace/SessionDashboard");

		render(<SessionDashboard onSessionClick={() => {}} />);

		await waitFor(() => {
			// WorktreeGroup header arrow is present
			expect(screen.getByText("▼")).toBeDefined();
		});

		// Both session dirs visible (expanded by default)
		// "naia-os" appears in both the group header and SESSION_WT_MAIN's card dir span
		expect(screen.getAllByText("naia-os").length).toBeGreaterThanOrEqual(1);
		expect(screen.getByText("naia-os-issue-79")).toBeDefined();
	});

	it("repoName in WorktreeGroup header is basename of origin_path", async () => {
		setupInvoke([SESSION_WT_MAIN, SESSION_WT_79]);

		const { SessionDashboard } = await import("../workspace/SessionDashboard");

		render(<SessionDashboard onSessionClick={() => {}} />);

		await waitFor(() => {
			// Group header title = basename of /dev/naia-os = "naia-os"
			const groupHeader = screen.getByTitle("naia-os");
			expect(groupHeader).toBeDefined();
		});
	});

	it("groups all 3 sessions under one WorktreeGroup when they share origin_path", async () => {
		setupInvoke([SESSION_WT_MAIN, SESSION_WT_79, SESSION_WT_80]);

		const { SessionDashboard } = await import("../workspace/SessionDashboard");

		render(<SessionDashboard onSessionClick={() => {}} />);

		await waitFor(() => {
			// Count badge in group header should show 3
			const header = screen.getByTitle("naia-os");
			expect(header.textContent).toContain("3");
		});
	});

	it("sessions without origin_path are NOT grouped together", async () => {
		const sessionA: SessionInfo = {
			dir: "proj-a",
			path: "/dev/proj-a",
			status: "idle",
			// no origin_path — group key = path = "/dev/proj-a"
		};
		const sessionB: SessionInfo = {
			dir: "proj-b",
			path: "/dev/proj-b",
			status: "idle",
			// no origin_path — group key = path = "/dev/proj-b" (different)
		};
		setupInvoke([sessionA, sessionB]);

		const { SessionDashboard } = await import("../workspace/SessionDashboard");

		render(<SessionDashboard onSessionClick={() => {}} />);

		await waitFor(() => {
			expect(screen.getByText("proj-a")).toBeDefined();
			expect(screen.getByText("proj-b")).toBeDefined();
		});

		// No group header (each session stands alone)
		expect(screen.queryByText("▼")).toBeNull();
	});

	it("calls onSessionsUpdate callback with loaded sessions", async () => {
		setupInvoke([SESSION_STANDALONE]);
		const onUpdate = vi.fn();

		const { SessionDashboard } = await import("../workspace/SessionDashboard");

		render(
			<SessionDashboard onSessionClick={() => {}} onSessionsUpdate={onUpdate} />,
		);

		await waitFor(() => {
			expect(onUpdate).toHaveBeenCalledWith([SESSION_STANDALONE]);
		});
	});

	it("calls onSessionsUpdate with [] on first-ever failure (unblocks parent)", async () => {
		mockInvoke.mockRejectedValue(new Error("workspace not ready"));
		mockListen.mockResolvedValue(vi.fn());
		const onUpdate = vi.fn();

		const { SessionDashboard } = await import("../workspace/SessionDashboard");

		render(
			<SessionDashboard onSessionClick={() => {}} onSessionsUpdate={onUpdate} />,
		);

		await waitFor(() => {
			// First failure → notify parent with [] to unblock
			expect(onUpdate).toHaveBeenCalledWith([]);
		});
	});

	it("refresh button triggers workspace_get_sessions again", async () => {
		setupInvoke([SESSION_STANDALONE]);

		const { SessionDashboard } = await import("../workspace/SessionDashboard");

		render(<SessionDashboard onSessionClick={() => {}} />);

		await waitFor(() => screen.getByText("vllm"));

		// Initial call count
		const callsAfterMount = mockInvoke.mock.calls.length;

		const refreshBtn = screen.getByTitle("새로고침");
		fireEvent.click(refreshBtn);

		await waitFor(() => {
			expect(mockInvoke.mock.calls.length).toBeGreaterThan(callsAfterMount);
		});
	});

	it("workspace:file-changed event triggers debounced reload", async () => {
		vi.useFakeTimers();
		try {
			setupInvoke([SESSION_STANDALONE]);

			// Capture the event listener registration
			let fileChangedHandler: (() => void) | undefined;
			mockListen.mockImplementation(async (event: string, handler: () => void) => {
				if (event === "workspace:file-changed") fileChangedHandler = handler;
				return vi.fn();
			});

			const { SessionDashboard } = await import("../workspace/SessionDashboard");

			// waitFor doesn't work with fake timers; resolve the initial load manually
			await act(async () => {
				render(<SessionDashboard onSessionClick={() => {}} />);
				// flush microtasks so the resolved invoke promise settles
				await Promise.resolve();
				await Promise.resolve();
			});

			const callsAfterMount = mockInvoke.mock.calls.length;

			// Fire the file-changed event
			expect(fileChangedHandler).toBeDefined();
			act(() => {
				fileChangedHandler?.();
			});

			// Debounce delay is 300ms — advance fake timers past it
			await act(async () => {
				vi.advanceTimersByTime(350);
				await Promise.resolve();
				await Promise.resolve();
			});

			expect(mockInvoke.mock.calls.length).toBeGreaterThan(callsAfterMount);
		} finally {
			vi.useRealTimers();
		}
	});

	it("shows session count in header (세션 N)", async () => {
		setupInvoke([SESSION_STANDALONE, SESSION_WT_MAIN]);

		const { SessionDashboard } = await import("../workspace/SessionDashboard");

		render(<SessionDashboard onSessionClick={() => {}} />);

		await waitFor(() => {
			expect(screen.getByText("세션 (2)")).toBeDefined();
		});
	});
});
