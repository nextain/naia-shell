// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../lib/i18n";
import en from "../../lib/locales/en";
import {
	MarkdownPreview,
	resolveWorkspaceReference,
} from "../workspace/MarkdownPreview";

const mockInvoke = vi.fn();
const mockOpenUrl = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/api/core", () => ({
	invoke: (...args: unknown[]) => mockInvoke(...args),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
	openUrl: (...args: unknown[]) => mockOpenUrl(...args),
}));
vi.mock("../../lib/logger", () => ({ Logger: { warn: vi.fn() } }));

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("MarkdownPreview workspace boundary", () => {
	it("resolves document-relative and workspace-root references", () => {
		expect(
			resolveWorkspaceReference(
				"../guide.md",
				"/work/docs/nested/readme.md",
				"/work",
			),
		).toBe("/work/docs/guide.md");
		expect(
			resolveWorkspaceReference(
				"/assets/logo.png",
				"/work/docs/readme.md",
				"/work",
			),
		).toBe("/work/assets/logo.png");
	});

	it("blocks traversal, dangerous schemes, and malformed encoding", () => {
		expect(
			resolveWorkspaceReference(
				"../../../secret",
				"/work/docs/readme.md",
				"/work",
			),
		).toBeNull();
		expect(
			resolveWorkspaceReference(
				"javascript:alert(1)",
				"/work/docs/readme.md",
				"/work",
			),
		).toBeNull();
		expect(
			resolveWorkspaceReference("%E0%A4%A", "/work/docs/readme.md", "/work"),
		).toBeNull();
	});

	it("renders GFM structure without executing raw HTML", async () => {
		await setLocale("en");
		render(
			<MarkdownPreview
				content={
					'# Guide\n\n- [x] Done\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n~~old~~\n\n<script>alert("no")</script>'
				}
				filePath="/work/README.md"
				workspaceRoot="/work"
			/>,
		);
		expect(
			screen.getByRole("article", { name: en["g1b.mdPreviewLabel"] }),
		).toBeInTheDocument();
		expect(screen.getByRole("table")).toBeInTheDocument();
		expect(screen.getByRole("checkbox")).toBeChecked();
		expect(document.querySelector("script")).not.toBeInTheDocument();
	});

	it("opens external links explicitly and local links in the workspace viewer", async () => {
		await setLocale("en");
		const onOpenFile = vi.fn();
		render(
			<MarkdownPreview
				content="[site](https://example.com) [guide](guide.md) [bad](javascript:alert(1))"
				filePath="/work/docs/readme.md"
				workspaceRoot="/work"
				onOpenFile={onOpenFile}
			/>,
		);
		fireEvent.click(
			screen.getByRole("link", {
				name: en["g1b.mdExternalLink"].replace("{label}", "site"),
			}),
		);
		expect(mockOpenUrl).toHaveBeenCalledWith("https://example.com");
		fireEvent.click(screen.getByRole("link", { name: "guide" }));
		expect(onOpenFile).toHaveBeenCalledWith("/work/docs/guide.md");
		expect(screen.getByText("bad").closest("a")).toHaveAttribute("href", "");
	});

	it("names the unknown image when neither alt nor src is present", async () => {
		await setLocale("en");
		render(
			<MarkdownPreview
				content="![]( )"
				filePath="/work/docs/readme.md"
				workspaceRoot="/work"
			/>,
		);
		await waitFor(() =>
			expect(screen.getByRole("status")).toHaveTextContent(
				en["g1b.mdImageError"].replace(
					"{detail}",
					en["g1b.mdUnknownImage"],
				),
			),
		);
	});

	it("loads local images through the bounded workspace command and reports missing assets", async () => {
		await setLocale("en");
		mockInvoke.mockResolvedValueOnce([137, 80, 78, 71]);
		const { rerender } = render(
			<MarkdownPreview
				content="![logo](../assets/logo.png)"
				filePath="/work/docs/readme.md"
				workspaceRoot="/work"
			/>,
		);
		await waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith("workspace_read_file_bytes", {
				path: "/work/assets/logo.png",
			}),
		);
		await waitFor(() =>
			expect(screen.getByRole("img", { name: "logo" })).toBeInTheDocument(),
		);

		mockInvoke.mockRejectedValueOnce(new Error("missing"));
		rerender(
			<MarkdownPreview
				content="![missing](missing.png)"
				filePath="/work/docs/readme.md"
				workspaceRoot="/work"
			/>,
		);
		await waitFor(() =>
			expect(screen.getByRole("status")).toHaveTextContent(
				en["g1b.mdImageError"].replace("{detail}", "missing"),
			),
		);
	});
});
