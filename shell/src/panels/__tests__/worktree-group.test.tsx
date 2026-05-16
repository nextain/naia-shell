// @vitest-environment jsdom
/**
 * WorktreeGroup unit tests
 *
 * verify-worktree-grouping 불변식:
 *  1. useState(false) — 초기 상태는 expanded (collapsed=false)
 *  2. 헤더 클릭 → collapsed 토글
 *  3. collapsed 시 카드 숨김, expanded 시 표시
 *  4. highlightedDir 전달 정확성
 *  5. repoName / count 헤더 표시
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../workspace/SessionCard";

// WorktreeGroup uses SessionCard which has no heavy dependencies — no mocks needed.

const SESSION_A: SessionInfo = {
	dir: "naia-os-issue-79",
	path: "/dev/naia-os-issue-79",
	status: "active",
	origin_path: "/dev/naia-os",
	branch: "issue-79-feature",
	progress: { issue: "#79", phase: "build" },
};
const SESSION_B: SessionInfo = {
	dir: "naia-os-issue-80",
	path: "/dev/naia-os-issue-80",
	status: "idle",
	origin_path: "/dev/naia-os",
	branch: "issue-80-fix",
};
const SESSION_C: SessionInfo = {
	dir: "naia-os",
	path: "/dev/naia-os",
	status: "stopped",
	origin_path: "/dev/naia-os",
};

describe("WorktreeGroup", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("is expanded by default (useState(false) invariant)", async () => {
		const { WorktreeGroup } = await import("../workspace/WorktreeGroup");

		render(
			<WorktreeGroup
				repoName="naia-os"
				sessions={[SESSION_A, SESSION_B]}
				onSessionClick={() => {}}
			/>,
		);

		// ▼ = expanded, ▶ = collapsed
		expect(screen.getByText("▼")).toBeDefined();
		expect(screen.queryByText("▶")).toBeNull();
	});

	it("collapses on first header click (▶ arrow appears)", async () => {
		const { WorktreeGroup } = await import("../workspace/WorktreeGroup");

		render(
			<WorktreeGroup
				repoName="naia-os"
				sessions={[SESSION_A, SESSION_B]}
				onSessionClick={() => {}}
			/>,
		);

		const header = screen.getByTitle("naia-os") as HTMLButtonElement;
		fireEvent.click(header);

		expect(screen.getByText("▶")).toBeDefined();
		expect(screen.queryByText("▼")).toBeNull();
	});

	it("re-expands on second header click (▼ arrow returns)", async () => {
		const { WorktreeGroup } = await import("../workspace/WorktreeGroup");

		render(
			<WorktreeGroup
				repoName="naia-os"
				sessions={[SESSION_A, SESSION_B]}
				onSessionClick={() => {}}
			/>,
		);

		const header = screen.getByTitle("naia-os") as HTMLButtonElement;
		fireEvent.click(header); // collapse
		fireEvent.click(header); // re-expand

		expect(screen.getByText("▼")).toBeDefined();
	});

	it("shows repoName in header", async () => {
		const { WorktreeGroup } = await import("../workspace/WorktreeGroup");

		render(
			<WorktreeGroup
				repoName="my-special-repo"
				sessions={[SESSION_A]}
				onSessionClick={() => {}}
			/>,
		);

		expect(screen.getByText("my-special-repo")).toBeDefined();
	});

	it("shows session count in header", async () => {
		const { WorktreeGroup } = await import("../workspace/WorktreeGroup");

		render(
			<WorktreeGroup
				repoName="naia-os"
				sessions={[SESSION_A, SESSION_B, SESSION_C]}
				onSessionClick={() => {}}
			/>,
		);

		// Count span contains 3
		expect(screen.getByText("3")).toBeDefined();
	});

	it("session cards are visible when expanded", async () => {
		const { WorktreeGroup } = await import("../workspace/WorktreeGroup");

		render(
			<WorktreeGroup
				repoName="naia-os"
				sessions={[SESSION_A, SESSION_B]}
				onSessionClick={() => {}}
			/>,
		);

		// Both session dirs should appear as card text
		expect(screen.getByText("naia-os-issue-79")).toBeDefined();
		expect(screen.getByText("naia-os-issue-80")).toBeDefined();
	});

	it("session cards are hidden when collapsed", async () => {
		const { WorktreeGroup } = await import("../workspace/WorktreeGroup");

		render(
			<WorktreeGroup
				repoName="naia-os"
				sessions={[SESSION_A, SESSION_B]}
				onSessionClick={() => {}}
			/>,
		);

		fireEvent.click(screen.getByTitle("naia-os") as HTMLButtonElement);

		// Cards should not be in the DOM
		expect(screen.queryByText("naia-os-issue-79")).toBeNull();
		expect(screen.queryByText("naia-os-issue-80")).toBeNull();
	});

	it("calls onSessionClick when a session card is clicked", async () => {
		const { WorktreeGroup } = await import("../workspace/WorktreeGroup");
		const onClick = vi.fn();

		render(
			<WorktreeGroup
				repoName="naia-os"
				sessions={[SESSION_A, SESSION_B]}
				onSessionClick={onClick}
			/>,
		);

		const card = screen.getByRole("button", { name: /naia-os-issue-79/ });
		fireEvent.click(card);

		expect(onClick).toHaveBeenCalledOnce();
		expect(onClick).toHaveBeenCalledWith(SESSION_A);
	});

	it("passes highlightedDir to session cards (matching card is highlighted)", async () => {
		const { WorktreeGroup } = await import("../workspace/WorktreeGroup");

		const { container } = render(
			<WorktreeGroup
				repoName="naia-os"
				sessions={[SESSION_A, SESSION_B]}
				onSessionClick={() => {}}
				highlightedDir="naia-os-issue-79"
			/>,
		);

		// SessionCard renders data-dir attribute for the highlighted check
		// Check that the highlighted card element has the correct dir
		const highlightedCard = container.querySelector(
			'[data-dir="naia-os-issue-79"]',
		);
		expect(highlightedCard).not.toBeNull();
	});

	it("single session still renders inside the group", async () => {
		const { WorktreeGroup } = await import("../workspace/WorktreeGroup");

		render(
			<WorktreeGroup
				repoName="naia-os"
				sessions={[SESSION_A]}
				onSessionClick={() => {}}
			/>,
		);

		expect(screen.getByText("naia-os-issue-79")).toBeDefined();
		expect(screen.getByText("1")).toBeDefined(); // count = 1
	});

	it("header title attribute equals repoName", async () => {
		const { WorktreeGroup } = await import("../workspace/WorktreeGroup");

		render(
			<WorktreeGroup
				repoName="naia-os"
				sessions={[SESSION_A]}
				onSessionClick={() => {}}
			/>,
		);

		const header = screen.getByTitle("naia-os") as HTMLButtonElement;
		expect(header.getAttribute("title")).toBe("naia-os");
	});
});
