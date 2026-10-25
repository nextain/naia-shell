// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CharCardApp } from "../CharCardApp";
import { parseCharacterCardJsonText } from "../card-parser";
import {
	type CardStorageAdapter,
	type StoredCardRecord,
	createMemoryCardStorage,
} from "../card-store";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("CharCardApp UI", () => {
	it("loads 4 bundled sample cards, imports JSON card, starts/stops roleplay, handles naia-app:context-cleared from parent, and moves focus after deletion", async () => {
		const postMessageSpy = vi.spyOn(window.parent, "postMessage");
		const storage = createMemoryCardStorage();

		render(<CharCardApp storage={storage} localeOverride="ko" />);

		await waitFor(() => {
			expect(screen.getByTestId("charcard-import-button")).not.toBeDisabled();
		});

		// Bundled sample PNG card (온새미) is selected initially and parsed as PNG with an <img> avatar
		expect(screen.getByTestId("charcard-detail-name")).toHaveTextContent(
			"온새미",
		);
		const sampleImg = screen.getByTestId("charcard-avatar-img");
		expect(sampleImg).toBeInTheDocument();
		expect(sampleImg).toHaveAttribute("alt", "온새미");
		expect(screen.getAllByText("V3 · PNG").length).toBeGreaterThanOrEqual(1);
		expect(screen.getByText("한도윤")).toBeInTheDocument();
		expect(screen.getByText("백하진")).toBeInTheDocument();
		expect(screen.getByText("서윤하")).toBeInTheDocument();

		// Selecting V3 JSON sample card (백하진) renders initial-letter avatar fallback
		fireEvent.click(
			screen.getByTestId("charcard-item-sample:clockwork-tinker-json-v3"),
		);
		expect(screen.getByTestId("charcard-detail-name")).toHaveTextContent(
			"백하진",
		);
		expect(screen.getByTestId("charcard-avatar-letter")).toHaveTextContent(
			"백",
		);

		// Selecting V2 JSON sample card (서윤하) renders initial-letter avatar fallback
		fireEvent.click(
			screen.getByTestId("charcard-item-sample:starlight-archivist-v2"),
		);
		expect(screen.getByTestId("charcard-detail-name")).toHaveTextContent(
			"서윤하",
		);
		expect(screen.getByTestId("charcard-avatar-letter")).toHaveTextContent(
			"서",
		);

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

		// Spoofed naia-app:context-cleared from another source is ignored
		const fakeSource = {} as Window;
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					source: fakeSource,
					data: { type: "naia-app:context-cleared" },
				}),
			);
		});
		expect(screen.getByTestId("charcard-active-banner")).toHaveTextContent(
			"강하늘 연기 중",
		);

		// Valid naia-app:context-cleared from window.parent ends roleplay UI state
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					source: window.parent,
					data: { type: "naia-app:context-cleared" },
				}),
			);
		});
		expect(screen.queryByTestId("charcard-active-banner")).toBeNull();

		// Start roleplay again, then stop manually -> posts context: null
		fireEvent.click(screen.getByTestId("charcard-start-button"));
		expect(screen.getByTestId("charcard-active-banner")).toBeInTheDocument();
		fireEvent.click(screen.getByTestId("charcard-stop-button"));
		expect(postMessageSpy).toHaveBeenCalledWith(
			{ type: "naia-app:context", context: null },
			"*",
		);
		expect(screen.queryByTestId("charcard-active-banner")).toBeNull();

		// Delete imported card -> opens in-app role="alertdialog" with initial focus on Cancel
		const deleteBtn = screen.getByTestId("charcard-delete-button");
		fireEvent.click(deleteBtn);

		const dialog = screen.getByRole("alertdialog");
		expect(dialog).toBeInTheDocument();
		expect(dialog).toHaveAttribute(
			"aria-labelledby",
			"charcard-delete-dialog-title",
		);
		expect(dialog).toHaveAttribute(
			"aria-describedby",
			"charcard-delete-dialog-desc",
		);
		expect(within(dialog).getByText("캐릭터 카드 지우기")).toBeInTheDocument();
		const cancelBtn = screen.getByTestId("charcard-delete-cancel");
		expect(document.activeElement).toBe(cancelBtn);

		// 1) Clicking Cancel closes dialog, keeps card, and returns focus to delete button
		fireEvent.click(cancelBtn);
		expect(screen.queryByRole("alertdialog")).toBeNull();
		expect(screen.getByTestId("charcard-detail-name")).toHaveTextContent(
			"강하늘",
		);
		expect(document.activeElement).toBe(deleteBtn);

		// 2) Pressing Escape also cancels and keeps the card
		fireEvent.click(deleteBtn);
		expect(screen.getByRole("alertdialog")).toBeInTheDocument();
		fireEvent.keyDown(window, { key: "Escape" });
		expect(screen.queryByRole("alertdialog")).toBeNull();
		expect(screen.getByTestId("charcard-detail-name")).toHaveTextContent(
			"강하늘",
		);
		expect(document.activeElement).toBe(deleteBtn);

		// 3) Clicking Confirm removes the card and moves focus to the next card in the list (온새미)
		fireEvent.click(deleteBtn);
		fireEvent.click(screen.getByTestId("charcard-delete-confirm"));

		await waitFor(() => {
			expect(screen.queryByText("강하늘")).toBeNull();
		});
		const nextCardBtn = screen.getByTestId(
			"charcard-item-sample:greenhouse-keeper-png",
		);
		await waitFor(() => {
			expect(document.activeElement).toBe(nextCardBtn);
		});
	});

	it("gates import button during initial storage load and merges cards without overwriting", async () => {
		let resolveListCards!: (records: StoredCardRecord[]) => void;
		const listCardsPromise = new Promise<StoredCardRecord[]>((resolve) => {
			resolveListCards = resolve;
		});
		const savedRecords: StoredCardRecord[] = [];

		const delayedStorage: CardStorageAdapter = {
			mode: "indexeddb",
			listCards: () => listCardsPromise,
			async saveCard(record) {
				savedRecords.push(record);
			},
			async removeCard() {},
		};

		render(<CharCardApp storage={delayedStorage} localeOverride="ko" />);

		// While listCards is pending, import button is disabled / aria-busy
		const importBtn = screen.getByTestId("charcard-import-button");
		expect(importBtn).toBeDisabled();
		expect(importBtn).toHaveAttribute("aria-busy", "true");
		expect(importBtn).toHaveTextContent("보관함 준비 중…");

		// If a file is queued on file input before listCards resolves, it waits for listCards and merges both
		const earlyCard = {
			spec: "chara_card_v3",
			spec_version: "3.0",
			data: { name: "초기합류캐릭터", description: "합류", first_mes: "안녕" },
		};
		const file = new File([JSON.stringify(earlyCard)], "early.json", {
			type: "application/json",
		});
		fireEvent.change(screen.getByTestId("charcard-file-input"), {
			target: { files: [file] },
		});

		const storedParsed = parseCharacterCardJsonText(
			JSON.stringify({
				spec: "chara_card_v3",
				spec_version: "3.0",
				data: {
					name: "기존보관함캐릭터",
					description: "기존",
					first_mes: "반가워",
				},
			}),
		);
		if (!storedParsed.ok) throw new Error("unexpected");

		await act(async () => {
			resolveListCards([
				{
					id: "stored-existing-1",
					fileName: "existing.json",
					importedAt: 1000,
					card: storedParsed.card,
					rawJson: storedParsed.card.rawJson,
					imageBlob: null,
				},
			]);
		});

		await waitFor(() => {
			expect(screen.getByTestId("charcard-import-button")).not.toBeDisabled();
			const listEl = screen.getByTestId("charcard-list");
			expect(within(listEl).getByText("기존보관함캐릭터")).toBeInTheDocument();
			expect(within(listEl).getByText("초기합류캐릭터")).toBeInTheDocument();
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

	it("handles storage save/delete failures without mutating card list until retry succeeds", async () => {
		let shouldFailSave = true;
		let shouldFailDelete = true;
		const savedMap = new Map<string, StoredCardRecord>();
		const flakyStorage: CardStorageAdapter = {
			mode: "indexeddb",
			async listCards() {
				return Array.from(savedMap.values());
			},
			async saveCard(record) {
				if (shouldFailSave) {
					throw new Error("IndexedDB QuotaExceededError");
				}
				savedMap.set(record.id, record);
			},
			async removeCard(id) {
				if (shouldFailDelete) {
					throw new Error("IndexedDB TransactionInactiveError");
				}
				savedMap.delete(id);
			},
		};

		render(<CharCardApp storage={flakyStorage} localeOverride="ko" />);

		const cardJson = {
			spec: "chara_card_v3",
			spec_version: "3.0",
			data: {
				name: "저장시험캐릭터",
				description: "설명",
				first_mes: "인사",
			},
		};
		const file = new File([JSON.stringify(cardJson)], "retry-card.json", {
			type: "application/json",
		});
		fireEvent.change(screen.getByTestId("charcard-file-input"), {
			target: { files: [file] },
		});

		// Save fails -> error banner shown, card NOT added to list
		const saveErrorBanner = await screen.findByTestId("charcard-storage-error");
		expect(saveErrorBanner).toHaveTextContent(
			"캐릭터 카드를 보관함에 저장하지 못했습니다.",
		);
		expect(screen.queryByText("저장시험캐릭터")).toBeNull();

		// Retry save -> succeeds and adds card to list
		shouldFailSave = false;
		fireEvent.click(screen.getByTestId("charcard-storage-retry"));
		await waitFor(() => {
			expect(screen.getByTestId("charcard-detail-name")).toHaveTextContent(
				"저장시험캐릭터",
			);
		});
		expect(screen.queryByTestId("charcard-storage-error")).toBeNull();

		// Now try deleting -> fails first, card stays in list
		fireEvent.click(screen.getByTestId("charcard-delete-button"));
		fireEvent.click(screen.getByTestId("charcard-delete-confirm"));

		const deleteErrorBanner = await screen.findByTestId(
			"charcard-storage-error",
		);
		expect(deleteErrorBanner).toHaveTextContent(
			"캐릭터 카드를 보관함에서 지우지 못했습니다.",
		);
		expect(screen.getByTestId("charcard-detail-name")).toHaveTextContent(
			"저장시험캐릭터",
		);

		// Retry delete -> succeeds and removes card from list
		shouldFailDelete = false;
		fireEvent.click(screen.getByTestId("charcard-storage-retry"));
		await waitFor(() => {
			expect(screen.queryByText("저장시험캐릭터")).toBeNull();
		});
	});
});
