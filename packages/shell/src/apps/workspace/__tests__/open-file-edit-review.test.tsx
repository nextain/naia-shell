// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { t } from "../../../lib/i18n";
import { OpenFileEditReview } from "../OpenFileEditReview";
import type { OpenFileEditProposal } from "../open-file-edit";

describe("OpenFileEditReview", () => {
	afterEach(() => {
		cleanup();
	});

	const sampleProposal: OpenFileEditProposal = {
		id: "prop-123",
		path: "/work/project/src/index.ts",
		added: 2,
		removed: 1,
		truncated: false,
		expiresAt: Date.now() + 50_000,
		timeoutMs: 50_000,
		lines: [
			{ kind: "context", text: "function hello() {" },
			{ kind: "del", text: '  console.log("old");' },
			{ kind: "add", text: '  console.log("new 1");' },
			{ kind: "add", text: '  console.log("new 2");' },
			{ kind: "context", text: "}" },
		],
		summary: "Update hello log messages",
	};

	it("renders filename, added count, and removed count", () => {
		render(
			<OpenFileEditReview
				proposal={sampleProposal}
				onApprove={vi.fn()}
				onReject={vi.fn()}
			/>,
		);

		expect(screen.getByText("index.ts")).toBeInTheDocument();
		expect(screen.getByText("+2 −1")).toBeInTheDocument();
		expect(screen.getByText("Update hello log messages")).toBeInTheDocument();
	});

	it("renders added, removed, and context lines with expected classes", () => {
		const { container } = render(
			<OpenFileEditReview
				proposal={sampleProposal}
				onApprove={vi.fn()}
				onReject={vi.fn()}
			/>,
		);

		const addLines = container.querySelectorAll(
			".open-file-edit-review-line-add, .open-file-edit-review__line--add",
		);
		const delLines = container.querySelectorAll(
			".open-file-edit-review-line-del, .open-file-edit-review__line--del",
		);
		const ctxLines = container.querySelectorAll(
			".open-file-edit-review-line-context, .open-file-edit-review__line--context",
		);

		expect(addLines.length).toBeGreaterThanOrEqual(2);
		expect(delLines.length).toBeGreaterThanOrEqual(1);
		expect(ctxLines.length).toBeGreaterThanOrEqual(2);

		const diffText = screen.getByTestId("open-file-edit-diff").textContent ?? "";
		expect(diffText).toContain('+   console.log("new 1");');
		expect(diffText).toContain('-   console.log("old");');
	});

	it("renders truncated notice when truncated is true", () => {
		const truncatedProposal: OpenFileEditProposal = {
			...sampleProposal,
			truncated: true,
		};
		render(
			<OpenFileEditReview
				proposal={truncatedProposal}
				onApprove={vi.fn()}
				onReject={vi.fn()}
			/>,
		);

		expect(
			screen.getByText(t("workspace.aiEdit.truncated")),
		).toBeInTheDocument();
	});

	it("does not render truncated notice when truncated is false", () => {
		render(
			<OpenFileEditReview
				proposal={sampleProposal}
				onApprove={vi.fn()}
				onReject={vi.fn()}
			/>,
		);

		expect(
			screen.queryByText(t("workspace.aiEdit.truncated")),
		).not.toBeInTheDocument();
	});

	it("calls onApprove once with proposal.id when clicking Approve button", () => {
		const onApprove = vi.fn();
		const onReject = vi.fn();
		render(
			<OpenFileEditReview
				proposal={sampleProposal}
				onApprove={onApprove}
				onReject={onReject}
			/>,
		);

		const approveBtn = screen.getByTestId("open-file-edit-approve");
		fireEvent.click(approveBtn);

		expect(onApprove).toHaveBeenCalledWith("prop-123");
		expect(onReject).not.toHaveBeenCalled();
	});

	it("calls onReject once with proposal.id when clicking Reject button", () => {
		const onApprove = vi.fn();
		const onReject = vi.fn();
		render(
			<OpenFileEditReview
				proposal={sampleProposal}
				onApprove={onApprove}
				onReject={onReject}
			/>,
		);

		const rejectBtn = screen.getByTestId("open-file-edit-reject");
		fireEvent.click(rejectBtn);

		expect(onReject).toHaveBeenCalledWith("prop-123");
		expect(onApprove).not.toHaveBeenCalled();
	});

	it("calls onReject once with proposal.id when pressing Escape key", () => {
		const onApprove = vi.fn();
		const onReject = vi.fn();
		render(
			<OpenFileEditReview
				proposal={sampleProposal}
				onApprove={onApprove}
				onReject={onReject}
			/>,
		);

		const region = screen.getByRole("region", {
			name: t("workspace.aiEdit.title"),
		});
		fireEvent.keyDown(region, { key: "Escape" });

		expect(onReject).toHaveBeenCalledWith("prop-123");
		expect(onApprove).not.toHaveBeenCalled();
	});

	it("gives initial focus to Reject button", () => {
		render(
			<OpenFileEditReview
				proposal={sampleProposal}
				onApprove={vi.fn()}
				onReject={vi.fn()}
			/>,
		);

		const rejectBtn = screen.getByTestId("open-file-edit-reject");
		expect(document.activeElement).toBe(rejectBtn);
	});

	it("has role='region' and aria-label matching workspace.aiEdit.title", () => {
		render(
			<OpenFileEditReview
				proposal={sampleProposal}
				onApprove={vi.fn()}
				onReject={vi.fn()}
			/>,
		);

		const region = screen.getByRole("region", {
			name: t("workspace.aiEdit.title"),
		});
		expect(region).toBeInTheDocument();
		expect(region).toHaveAttribute("aria-label", t("workspace.aiEdit.title"));
	});

	it("shows countdown and updates with timer", async () => {
		vi.useFakeTimers();
		try {
			const now = 1000000;
			vi.setSystemTime(now);
			const prop: OpenFileEditProposal = {
				...sampleProposal,
				expiresAt: now + 50_000,
				timeoutMs: 50_000,
			};
			render(
				<OpenFileEditReview
					proposal={prop}
					onApprove={vi.fn()}
					onReject={vi.fn()}
				/>,
			);
			const countdown = screen.getByTestId("open-file-edit-countdown");
			expect(countdown.textContent).toContain("50");

			act(() => {
				vi.advanceTimersByTime(1000);
			});
			expect(countdown.textContent).toContain("49");
		} finally {
			vi.useRealTimers();
		}
	});
});
