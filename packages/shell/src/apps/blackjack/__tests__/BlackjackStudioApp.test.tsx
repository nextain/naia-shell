// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BlackjackStudioApp } from "../BlackjackStudioApp";
import { REFERENCE_SOLUTION_CODE } from "../locales/messages";
import type { BlackjackStudioBridge } from "../studio-bridge";

afterEach(() => {
	cleanup();
});

function createMockBridge(overrides?: Partial<BlackjackStudioBridge>) {
	const contexts: Array<{
		type: "blackjack_studio";
		data: Record<string, unknown>;
	} | null> = [];
	const spoken: string[] = [];
	const cancelled: string[] = [];
	const askedPrompts: string[] = [];
	let hostHandlers: Parameters<
		BlackjackStudioBridge["subscribeHostEvents"]
	>[0] = {};

	const bridge: BlackjackStudioBridge = {
		pushContext(ctx) {
			contexts.push(ctx);
		},
		speak(text) {
			spoken.push(text);
			return { requestId: `req-${spoken.length}` };
		},
		cancelSpeak(id) {
			cancelled.push(id);
		},
		async askTutor(prompt) {
			askedPrompts.push(prompt);
			return {
				text: "에이스가 2장일 때 합계가 21을 넘으면 몇 점을 빼야 할지 먼저 생각해 볼까요?",
				fromFallback: false,
			};
		},
		async provisionProject() {
			return {
				ok: true,
				data: {
					projectDir: "/work/naia-adk/projects/naia-blackjack-studio",
					projectSlug: "naia-blackjack-studio",
					writtenFiles: ["AGENTS.md", "blackjack-rules.js"],
					skippedFiles: [],
				},
			};
		},
		async syncFiles() {
			return {
				ok: true,
				data: {
					projectDir: "/work/naia-adk/projects/naia-blackjack-studio",
					projectSlug: "naia-blackjack-studio",
					writtenFiles: ["blackjack-rules.js"],
					skippedFiles: [],
				},
			};
		},
		async readFiles() {
			return {
				ok: true,
				files: [
					{
						path: "blackjack-rules.js",
						content: REFERENCE_SOLUTION_CODE,
					},
				],
			};
		},
		async openProjectsApp() {
			return { ok: true };
		},
		subscribeHostEvents(handlers) {
			hostHandlers = handlers;
			return () => {};
		},
		...overrides,
	};

	return {
		bridge,
		contexts,
		spoken,
		cancelled,
		askedPrompts,
		getHostHandlers: () => hostHandlers,
	};
}

describe("BlackjackStudioApp interactive 3-column studio", () => {
	it("renders CodeMirror 6 editor, opens Socratic hints one by one, speaks & cancels voice, and asks Naia tutor", async () => {
		const mock = createMockBridge();
		render(<BlackjackStudioApp bridge={mock.bridge} localeOverride="ko" />);

		expect(screen.getByTestId("blackjack-codemirror-host")).toBeTruthy();
		expect(screen.getByTestId("blackjack-cm-content")).toBeTruthy();
		expect(screen.getByTestId("blackjack-grader-summary").textContent).toContain(
			"미션 0/5 단계 완료",
		);

		// Open 3-level Hint Ladder incrementally
		fireEvent.click(screen.getByTestId("blackjack-open-hint-btn"));
		expect(screen.getByTestId("blackjack-hint-list").children).toHaveLength(1);
		fireEvent.click(screen.getByTestId("blackjack-open-hint-btn"));
		expect(screen.getByTestId("blackjack-hint-list").children).toHaveLength(2);

		// Speak & stop voice via naia-app:speak / naia-app:speak-cancel
		fireEvent.click(screen.getByTestId("blackjack-speak-btn"));
		expect(mock.spoken).toHaveLength(1);
		fireEvent.click(screen.getByTestId("blackjack-speak-stop-btn"));
		expect(mock.cancelled).toEqual(["req-1"]);

		// One-click preset tutor question via naia-app:ask
		fireEvent.click(screen.getByTestId("blackjack-ask-preset-ace"));
		await waitFor(() => {
			expect(mock.askedPrompts).toHaveLength(1);
			expect(screen.getByTestId("blackjack-tutor-reply").textContent).toContain(
				"에이스가 2장일 때",
			);
		});
	});

	it("grades edited code to 5/5 passed, plays a live hand hiding dealer hole card, and syncs with local project", async () => {
		const mock = createMockBridge();
		render(
			<BlackjackStudioApp
				bridge={mock.bridge}
				localeOverride="en"
				random={() => 0.35}
			/>,
		);

		// Switch to plain text mode to paste full solution and click Run & Auto-Grade
		fireEvent.click(screen.getByTestId("blackjack-editor-mode-toggle"));
		const textarea = screen.getByTestId(
			"blackjack-plain-textarea",
		) as HTMLTextAreaElement;
		fireEvent.change(textarea, { target: { value: REFERENCE_SOLUTION_CODE } });
		fireEvent.click(screen.getByTestId("blackjack-run-grade-btn"));

		expect(screen.getByTestId("blackjack-grader-summary").textContent).toContain(
			"5/5 steps complete",
		);

		// Deal a live hand and verify hidden dealer hole card if in player_turn
		fireEvent.click(screen.getByTestId("blackjack-deal-btn"));
		const latestCtx = mock.contexts[mock.contexts.length - 1];
		expect(latestCtx?.type).toBe("blackjack_studio");

		if (screen.queryByTestId("blackjack-stand-btn")) {
			expect(screen.getByTestId("blackjack-hidden-dealer-card")).toBeTruthy();
			fireEvent.click(screen.getByTestId("blackjack-stand-btn"));
		}
		expect(screen.queryByTestId("blackjack-hidden-dealer-card")).toBeNull();

		// Local workspace provision & open ProjectsApp
		fireEvent.click(screen.getByTestId("blackjack-provision-btn"));
		await waitFor(() => {
			expect(
				screen.getByText(/Provisioned local project at/i),
			).toBeTruthy();
		});

		// Restore starter code via inline 2-click confirmation, then reload reference from local file
		fireEvent.click(screen.getByTestId("blackjack-reset-starter-btn"));
		fireEvent.click(screen.getByTestId("blackjack-reset-confirm-yes"));
		expect(screen.getByTestId("blackjack-grader-summary").textContent).toContain(
			"0/5 steps complete",
		);

		fireEvent.click(screen.getByTestId("blackjack-read-local-btn"));
		await waitFor(() => {
			expect(
				screen.getByTestId("blackjack-grader-summary").textContent,
			).toContain("5/5 steps complete");
		});

		// Verify host locale switch & tool call dispatch
		mock.getHostHandlers().onLocale?.("ko");
		await waitFor(() => {
			expect(screen.getByText("나이아 블랙잭 실습 스튜디오")).toBeTruthy();
		});
		const toolOut = mock.getHostHandlers().onToolCall?.(
			"skill_blackjack_tutor",
			{ action: "goto", step: 3 },
		);
		expect(toolOut?.ok).toBe(true);
	});
});
