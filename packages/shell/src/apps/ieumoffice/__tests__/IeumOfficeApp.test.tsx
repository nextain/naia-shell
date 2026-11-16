// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IeumOfficeApp } from "../IeumOfficeApp";
import { SKILL_IEUMOFFICE_STUDIO } from "../tools";

describe("IeumOfficeApp v0.2.0 studio & MCP hub", () => {
	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it("renders built-in web document studio, switches formats, and converts mindmap to slides", async () => {
		render(<IeumOfficeApp />);
		expect(screen.getByTestId("ieumoffice-studio")).toBeDefined();
		expect(screen.getByTestId("editor-docx")).toBeDefined();

		fireEvent.click(screen.getByTestId("format-xlsx"));
		expect(screen.getByTestId("editor-xlsx")).toBeDefined();
		expect(screen.getAllByText("= 270").length).toBeGreaterThan(0);

		fireEvent.click(screen.getByTestId("format-xmind"));
		expect(screen.getByTestId("editor-xmind")).toBeDefined();
		fireEvent.click(screen.getByTestId("mindmap-to-pptx-btn"));
		expect(screen.getByTestId("editor-pptx")).toBeDefined();
	});

	it("supports AI co-editing proposal review, apply, and undo", async () => {
		render(<IeumOfficeApp />);
		const promptBox = screen.getByPlaceholderText(/문서 수정을 요청|Tell Naia/i);
		fireEvent.change(promptBox, {
			target: { value: "핵심 기대효과를 추가해 줘" },
		});
		fireEvent.click(screen.getByTestId("ask-naia-edit-btn"));

		await waitFor(() => {
			expect(screen.getByTestId("ai-diff-box")).toBeDefined();
		});
		fireEvent.click(screen.getByTestId("apply-ai-edit-btn"));
		expect(screen.queryByTestId("ai-diff-box")).toBeNull();
		expect(screen.getByTestId("undo-ai-edit-btn")).toBeDefined();

		fireEvent.click(screen.getByTestId("undo-ai-edit-btn"));
		expect(screen.queryByTestId("undo-ai-edit-btn")).toBeNull();
	});

	it("exposes official pblsketch/ieumoffice repository & release URLs (never openoffice)", () => {
		render(<IeumOfficeApp />);
		const tabs = screen.getAllByRole("tab");
		fireEvent.click(tabs[2]);

		const releasesInput = screen.getByTestId(
			"official-releases-input",
		) as HTMLInputElement;
		const repoInput = screen.getByTestId(
			"official-repo-input",
		) as HTMLInputElement;
		expect(releasesInput.value).toBe(
			"https://github.com/pblsketch/ieumoffice/releases",
		);
		expect(repoInput.value).toBe("https://github.com/pblsketch/ieumoffice");
		expect(document.body.innerHTML).not.toContain("pblsketch/openoffice");
	});

	it("answers skill_ieumoffice_studio tool calls and updates locale via postMessage", async () => {
		const postSpy = vi.spyOn(window.parent, "postMessage");
		render(<IeumOfficeApp />);

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "naia-app:locale", locale: "en" },
				}),
			);
		});
		expect(screen.getByText("Web Document Studio")).toBeDefined();

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "naia-tool-call",
						id: "tool-req-1",
						tool: SKILL_IEUMOFFICE_STUDIO,
						args: {
							action: "propose_edit",
							summary: "Refined intro",
							content: "# Updated Heading\nClean body paragraph",
						},
					},
				}),
			);
		});

		await waitFor(() => {
			expect(screen.getByTestId("ai-diff-box")).toBeDefined();
		});
		expect(
			postSpy.mock.calls.some(([payload]) => {
				const p = payload as Record<string, unknown>;
				return p.type === "naia-tool-result" && p.id === "tool-req-1";
			}),
		).toBe(true);
	});
});
