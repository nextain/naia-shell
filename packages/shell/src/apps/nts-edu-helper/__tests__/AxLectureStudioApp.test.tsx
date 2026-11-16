// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AxLectureStudioApp } from "../AxLectureStudioApp";
import type { AxStudioBridge } from "../studio-bridge";

afterEach(() => {
	cleanup();
});

function createMockAxBridge() {
	const spoken: Array<{ text: string; onDone?: (status: string) => void }> = [];
	const cancelled: string[] = [];
	const prompts: string[] = [];
	const provisions: Array<{ path: string; content: string }[]> = [];

	const bridge: AxStudioBridge = {
		pushContext() {},
		speak(text, onDone) {
			spoken.push({ text, onDone });
			return { requestId: `ax-speak-${spoken.length}` };
		},
		cancelSpeak(id) {
			cancelled.push(id);
		},
		async askModel(prompt) {
			prompts.push(prompt);
			if (prompt.includes("HTML")) {
				return {
					ok: true,
					text: "```html\n<!doctype html><html lang='ko'><body><h1>AI Enhanced Wireframe</h1></body></html>\n```",
				};
			}
			return {
				ok: true,
				text: "병목위험: 개정 대조 시간 과다\n개인정보원칙: 개인정보 완전 배제\n한줄승인규칙: 담당자 원문 대조 후 승인\n업무목적: 근거 중심 초안 자동화",
			};
		},
		async provisionProject(files) {
			provisions.push(files);
			return {
				ok: true,
				data: {
					projectDir: "/work/naia-adk/projects/nts-ax-planning-studio",
					projectSlug: "nts-ax-planning-studio",
					writtenFiles: files.map((f) => f.path),
					skippedFiles: [],
				},
			};
		},
		async openProjectsApp() {
			return { ok: true };
		},
		subscribeHostEvents() {
			return () => {};
		},
	};

	return { bridge, spoken, cancelled, prompts, provisions };
}

describe("AxLectureStudioApp split-screen studio", () => {
	it("navigates 97 slides, filters OpenCode scenes, guards Arrow keys in inputs, and supports continuous voice narration", () => {
		const mock = createMockAxBridge();
		render(<AxLectureStudioApp bridge={mock.bridge} localeOverride="ko" />);

		expect(screen.getByTestId("ax-slide-counter").textContent).toBe("1 / 97");

		// Jump to Session 5 (Slide 65)
		fireEvent.click(screen.getByTestId("ax-chapter-s5"));
		expect(screen.getByTestId("ax-slide-counter").textContent).toBe("65 / 97");

		// Keyboard ArrowRight advances to 66, unless focused inside an input!
		fireEvent.keyDown(window, { key: "ArrowRight" });
		expect(screen.getByTestId("ax-slide-counter").textContent).toBe("66 / 97");

		const agencyInput = screen.getByTestId("ax-input-agency");
		fireEvent.keyDown(agencyInput, { key: "ArrowRight" });
		expect(screen.getByTestId("ax-slide-counter").textContent).toBe("66 / 97");

		// OpenCode scenes filter ([2, 8, 14, 32, 70, 71, 77])
		fireEvent.click(screen.getByTestId("ax-opencode-filter-btn"));
		expect(screen.getByTestId("ax-slide-counter").textContent).toContain("(2쪽)");
		fireEvent.click(screen.getByTestId("ax-slide-next"));
		expect(screen.getByTestId("ax-slide-counter").textContent).toContain("(8쪽)");

		// Continuous voice narration advances automatically on 'finished'
		fireEvent.click(screen.getByTestId("ax-continuous-toggle"));
		fireEvent.click(screen.getByTestId("ax-speak-btn"));
		expect(mock.spoken).toHaveLength(1);
		act(() => {
			mock.spoken[0]?.onDone?.("finished");
		});
		expect(screen.getByTestId("ax-slide-counter").textContent).toContain("(14쪽)");
		expect(mock.spoken).toHaveLength(2);

		fireEvent.click(screen.getByTestId("ax-speak-stop-btn"));
		expect(mock.cancelled).toContain("ax-speak-2");
	});

	it("generates Stage 1, Stage 2, and Stage 3 HTML wireframes with Undo and provisions local package", async () => {
		const mock = createMockAxBridge();
		render(<AxLectureStudioApp bridge={mock.bridge} localeOverride="ko" />);

		// Switch preset & toggle checklist item
		fireEvent.click(screen.getByTestId("ax-preset-local_gov"));
		expect(
			(screen.getByTestId("ax-input-service") as HTMLInputElement).value,
		).toContain("자치법규 민원안내문");

		fireEvent.click(screen.getByTestId("ax-checklist-toggle-privacy"));
		expect(
			screen.getByTestId("ax-checklist-toggle-privacy").textContent,
		).toBe("보류");

		// Stage 1 AI generation via naia-app:ask
		fireEvent.click(screen.getByTestId("ax-ask-stage1-btn"));
		await waitFor(() => {
			expect(
				(screen.getByTestId("ax-input-bottleneck") as HTMLTextAreaElement)
					.value,
			).toBe("개정 대조 시간 과다");
		});

		// Stage 2 AI generation & Markdown preview
		fireEvent.click(screen.getByTestId("ax-tab-stage2"));
		fireEvent.click(screen.getByTestId("ax-ask-stage2-btn"));
		await waitFor(() => {
			expect(
				(screen.getByTestId("ax-input-purpose") as HTMLTextAreaElement).value,
			).toBe("근거 중심 초안 자동화");
		});
		fireEvent.click(screen.getByTestId("ax-toggle-md-preview-btn"));
		expect(screen.getByTestId("ax-markdown-preview").textContent).toContain(
			"근거 중심 초안 자동화",
		);

		// Stage 3 deterministic HTML wireframe + AI wireframe enhancement + Undo
		fireEvent.click(screen.getByTestId("ax-tab-stage3"));
		fireEvent.click(screen.getByTestId("ax-synth-wireframe-btn"));
		const iframeBefore = screen.getByTestId(
			"ax-wireframe-iframe",
		) as HTMLIFrameElement;
		expect(iframeBefore.srcdoc).toContain("자치법규 민원안내문");

		fireEvent.click(screen.getByTestId("ax-ask-wireframe-btn"));
		await waitFor(() => {
			expect(
				(screen.getByTestId("ax-wireframe-iframe") as HTMLIFrameElement).srcdoc,
			).toContain("AI Enhanced Wireframe");
		});

		fireEvent.click(screen.getByTestId("ax-undo-wireframe-btn"));
		expect(
			(screen.getByTestId("ax-wireframe-iframe") as HTMLIFrameElement).srcdoc,
		).toContain("자치법규 민원안내문");

		// Provision full starter package to local ADK project
		fireEvent.click(screen.getByTestId("ax-provision-local-btn"));
		await waitFor(() => {
			expect(mock.provisions).toHaveLength(1);
			expect(mock.provisions[0]?.map((f) => f.path)).toContain(
				"04-wireframe.html",
			);
		});
	});
});
