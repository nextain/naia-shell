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
import { CharCardApp } from "../CharCardApp";
import { createMemoryCardStorage } from "../card-store";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("CharCardApp UI", () => {
	it("imports a JSON card, sends naia-app:context on start, sends null on stop, and deletes after confirm", async () => {
		const postMessageSpy = vi.spyOn(window.parent, "postMessage");
		const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
		const storage = createMemoryCardStorage();

		render(<CharCardApp storage={storage} localeOverride="ko" />);

		// Bundled sample cards appear initially
		expect(screen.getAllByText("온새미").length).toBeGreaterThanOrEqual(1);
		expect(screen.getByText("한도윤")).toBeInTheDocument();
		expect(screen.getByText("서윤하")).toBeInTheDocument();

		// Import a new JSON card
		const customCard = {
			spec: "chara_card_v3",
			spec_version: "3.0",
			data: {
				name: "강하늘",
				description:
					"{{char}}는 은하 철도 기관사다. <script>window.__evil=1</script>",
				personality: "침착하고 든든함",
				scenario: "{{user}}가 첫 열차에 탑승한다.",
				first_mes: "탑승권을 보여 주세요, {{user}}님!",
				alternate_greetings: ["환영합니다, {{user}} 승객님!"],
				mes_example: "",
				creator: "NextainTest",
				creator_notes: "기관사 메모",
				tags: ["은하", "철도"],
			},
		};
		const file = new File([JSON.stringify(customCard)], "sky-conductor.json", {
			type: "application/json",
		});
		const fileInput = screen.getByTestId("charcard-file-input");
		fireEvent.change(fileInput, { target: { files: [file] } });

		await waitFor(() => {
			expect(screen.getByTestId("charcard-detail-name")).toHaveTextContent(
				"강하늘",
			);
		});

		// Script tag in description is rendered as literal text, never executed as HTML element
		const descEl = screen.getByTestId("charcard-description-text");
		expect(descEl.textContent).toContain("<script>window.__evil=1</script>");
		expect(descEl.querySelector("script")).toBeNull();

		// Enter user name
		const nameInput = screen.getByTestId("charcard-username-input");
		fireEvent.change(nameInput, { target: { value: "별손님" } });

		// Greeting bubble updates with user name macro
		expect(screen.getByTestId("charcard-greeting-bubble")).toHaveTextContent(
			"탑승권을 보여 주세요, 별손님님!",
		);

		// Start roleplay -> posts naia-app:context to window.parent
		fireEvent.click(screen.getByTestId("charcard-start-button"));
		expect(postMessageSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "naia-app:context",
				context: expect.objectContaining({
					type: "charcard",
					data: expect.objectContaining({
						character: "강하늘",
						user: "별손님",
						roleplay: expect.stringContaining("강하늘"),
					}),
				}),
			}),
			"*",
		);
		expect(screen.getByTestId("charcard-active-banner")).toHaveTextContent(
			"강하늘 연기 중",
		);

		// Stop roleplay -> posts context: null
		fireEvent.click(screen.getByTestId("charcard-stop-button"));
		expect(postMessageSpy).toHaveBeenCalledWith(
			{ type: "naia-app:context", context: null },
			"*",
		);
		expect(screen.queryByTestId("charcard-active-banner")).toBeNull();

		// Delete imported card -> asks confirmation, then removes from list
		const deleteBtn = screen.getByTestId("charcard-delete-button");
		fireEvent.click(deleteBtn);
		expect(confirmSpy).toHaveBeenCalled();

		await waitFor(() => {
			expect(screen.queryByText("강하늘")).toBeNull();
		});
	});

	it("shows human-readable error and recovery buttons when an invalid file is imported", async () => {
		const storage = createMemoryCardStorage();
		render(<CharCardApp storage={storage} localeOverride="ko" />);

		const badFile = new File(["not a valid json or png"], "broken.json", {
			type: "application/json",
		});
		const fileInput = screen.getByTestId("charcard-file-input");
		fireEvent.change(fileInput, { target: { files: [badFile] } });

		const alertPanel = await screen.findByTestId("charcard-error-panel");
		expect(alertPanel).toBeInTheDocument();
		expect(alertPanel).toHaveTextContent("캐릭터 카드를 불러오지 못했습니다");
		expect(screen.getByTestId("charcard-error-retry")).toHaveTextContent(
			"다른 파일 고르기",
		);

		// Dismissing returns cleanly
		fireEvent.click(screen.getByTestId("charcard-error-dismiss"));
		expect(screen.queryByTestId("charcard-error-panel")).toBeNull();
	});
});
