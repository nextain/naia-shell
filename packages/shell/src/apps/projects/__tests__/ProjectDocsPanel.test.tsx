// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../../lib/i18n";
import { ProjectDocsPanel } from "../ProjectDocsPanel";
import { listProjectDocs, readProjectDoc } from "../project-catalog";

vi.mock("../project-catalog", () => ({
	listProjectDocs: vi.fn(),
	readProjectDoc: vi.fn(),
	parseProjectCommandError: (error: unknown) => ({
		code: error instanceof Error ? error.message : String(error),
		relativePathDetail: null,
	}),
}));
vi.mock("../../workspace/MarkdownPreview", () => ({
	MarkdownPreview: () => <div>Markdown preview</div>,
}));
vi.mock("../ProjectWebViewPanel", () => ({ ProjectWebViewPanel: () => null }));

const docsEntry = {
	dir: "domain",
	relativePath: "domain/guide.md",
	sizeBytes: 12,
};

describe("ProjectDocsPanel request timeouts", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		setLocale("en");
	});
	afterEach(() => {
		cleanup();
		vi.useRealTimers();
	});

	it("shows a recoverable list error and re-enables Refresh after ten seconds", async () => {
		let rejectLateRequest: ((reason?: unknown) => void) | undefined;
		vi.mocked(listProjectDocs)
			.mockImplementationOnce(
				() =>
					new Promise((_, reject) => {
						rejectLateRequest = reject;
					}),
			)
			.mockResolvedValueOnce([]);
		render(
			<ProjectDocsPanel
				adapterRoot="/fixture/adapter"
				projectPath="/fixture/adapter/projects/demo"
				dashboardUrl={null}
				docsDirs={["domain"]}
			/>,
		);

		const refresh = screen.getByRole("button", { name: "Refreshing…" });
		expect(refresh).toBeDisabled();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_001);
		});
		expect(screen.getByRole("alert")).toHaveTextContent(
			"Loading project documents took too long",
		);
		await act(async () => {
			rejectLateRequest?.(new Error("late IPC rejection"));
			await Promise.resolve();
		});
		expect(screen.getByRole("alert")).toHaveTextContent(
			"Loading project documents took too long",
		);
		const retry = screen.getByRole("button", { name: "Refresh" });
		expect(retry).toBeEnabled();
		fireEvent.click(retry);
		await act(async () => {});
		expect(listProjectDocs).toHaveBeenCalledTimes(2);
	});

	it("shows a recoverable file error when reading a selected document times out", async () => {
		vi.mocked(listProjectDocs).mockResolvedValue([docsEntry]);
		vi.mocked(readProjectDoc).mockImplementation(() => new Promise(() => {}));
		render(
			<ProjectDocsPanel
				adapterRoot="/fixture/adapter"
				projectPath="/fixture/adapter/projects/demo"
				dashboardUrl={null}
				docsDirs={["domain"]}
			/>,
		);

		await act(async () => {});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_001);
		});
		expect(screen.getByRole("alert")).toHaveTextContent(
			"Loading project documents took too long",
		);
		expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
	});
});
