import { expect, test } from "@playwright/test";

declare global {
	interface Window {
		__charcardParentMessages?: Array<{
			type?: string;
			context?: {
				type: string;
				data: {
					roleplay: string;
					character: string;
					user: string;
					specVersion: string;
				};
			} | null;
		}>;
	}
}

test.describe("Character Card Roleplay app (charcard.html)", () => {
	test.beforeEach(async ({ page }) => {
		await page.addInitScript(() => {
			Object.defineProperty(navigator, "language", {
				value: "ko-KR",
				configurable: true,
			});
			window.__charcardParentMessages = [];
			const origPostMessage = window.parent.postMessage.bind(window.parent);
			window.parent.postMessage = (
				message: unknown,
				targetOriginOrOptions?: string | WindowPostMessageOptions,
			) => {
				if (
					typeof message === "object" &&
					message !== null &&
					(message as { type?: string }).type === "naia-app:context"
				) {
					window.__charcardParentMessages?.push(
						message as {
							type?: string;
							context?: {
								type: string;
								data: {
									roleplay: string;
									character: string;
									user: string;
									specVersion: string;
								};
							} | null;
						},
					);
				}
				if (typeof targetOriginOrOptions === "string") {
					origPostMessage(message, targetOriginOrOptions);
				} else {
					origPostMessage(message, "*");
				}
			};
		});
	});

	test("lists sample PNG/JSON cards, selects card, starts and ends roleplay via parent postMessage, uploads JSON card, confirms delete, and recovers from invalid file", async ({
		page,
	}) => {
		await page.goto("/charcard.html");

		// 1. Initial sample cards list & PNG sample card avatar + name
		await expect(page.getByTestId("charcard-detail-name")).toHaveText("온새미");
		const avatarImg = page.getByTestId("charcard-avatar-img");
		await expect(avatarImg).toBeVisible();
		await expect(avatarImg).toHaveAttribute("alt", "온새미");
		await expect(
			page.getByTestId("charcard-item-sample:clockwork-tinker-v3"),
		).toContainText("한도윤");
		await expect(
			page.getByTestId("charcard-item-sample:starlight-archivist-v2"),
		).toContainText("서윤하");

		// 2. Select another sample card (한도윤)
		await page.getByTestId("charcard-item-sample:clockwork-tinker-v3").click();
		await expect(page.getByTestId("charcard-detail-name")).toHaveText("한도윤");
		await expect(page.getByTestId("charcard-avatar-img")).toHaveAttribute(
			"alt",
			"한도윤",
		);

		// 3. Start roleplay -> verify parent receives naia-app:context with type: "charcard"
		await page.getByTestId("charcard-username-input").fill("다정");
		await page.getByTestId("charcard-start-button").click();
		await expect(page.getByTestId("charcard-active-banner")).toContainText(
			"한도윤 연기 중",
		);

		const startMsg = await page.evaluate(
			() => window.__charcardParentMessages?.at(-1) ?? null,
		);
		expect(startMsg).not.toBeNull();
		expect(startMsg?.type).toBe("naia-app:context");
		expect(startMsg?.context?.type).toBe("charcard");
		expect(startMsg?.context?.data.character).toBe("한도윤");
		expect(startMsg?.context?.data.user).toBe("다정");
		expect(startMsg?.context?.data.roleplay).toContain("한도윤");

		// 4. End roleplay -> verify parent receives context: null
		await page.getByTestId("charcard-stop-button").click();
		await expect(page.getByTestId("charcard-active-banner")).toHaveCount(0);
		const stopMsg = await page.evaluate(
			() => window.__charcardParentMessages?.at(-1) ?? null,
		);
		expect(stopMsg).toEqual({
			type: "naia-app:context",
			context: null,
		});

		// 5. Upload JSON card file
		const uploadedCard = {
			spec: "chara_card_v3",
			spec_version: "3.0",
			data: {
				name: "별빛항해사",
				description: "{{char}}는 은하 항로를 그리는 항해사다.",
				personality: "차분하고 호기심이 많음",
				scenario: "{{user}}가 전망대에 오른다.",
				first_mes: "별자리가 잘 보이는 밤이네요, {{user}}님!",
				alternate_greetings: [],
				mes_example: "",
				creator: "NextainE2E",
				creator_notes: "",
				tags: ["항해", "별빛"],
			},
		};
		await page.getByTestId("charcard-file-input").setInputFiles({
			name: "navigator.json",
			mimeType: "application/json",
			buffer: Buffer.from(JSON.stringify(uploadedCard), "utf8"),
		});
		await expect(page.getByTestId("charcard-detail-name")).toHaveText(
			"별빛항해사",
		);

		// 6. Delete confirmation dialog: Cancel keeps card, Confirm removes card
		await page.getByTestId("charcard-delete-button").click();
		const dialog = page.getByRole("alertdialog");
		await expect(dialog).toBeVisible();
		await expect(page.getByTestId("charcard-delete-cancel")).toBeFocused();

		await page.getByTestId("charcard-delete-cancel").click();
		await expect(dialog).toHaveCount(0);
		await expect(page.getByTestId("charcard-detail-name")).toHaveText(
			"별빛항해사",
		);

		await page.getByTestId("charcard-delete-button").click();
		await expect(dialog).toBeVisible();
		await page.getByTestId("charcard-delete-confirm").click();
		await expect(dialog).toHaveCount(0);
		await expect(page.getByTestId("charcard-detail-name")).toHaveText("온새미");

		// 7. Invalid file -> error message + recovery button returns cleanly
		await page.getByTestId("charcard-file-input").setInputFiles({
			name: "corrupted.json",
			mimeType: "application/json",
			buffer: Buffer.from("not-valid-json-content", "utf8"),
		});
		const errorPanel = page.getByTestId("charcard-error-panel");
		await expect(errorPanel).toBeVisible();
		await expect(errorPanel).toContainText("캐릭터 카드를 불러오지 못했습니다");
		await page.getByTestId("charcard-error-dismiss").click();
		await expect(errorPanel).toHaveCount(0);
		await expect(page.getByTestId("charcard-detail-name")).toHaveText("온새미");
	});

	test("has no horizontal overflow at narrow width (390px) and reaches Start Roleplay button via keyboard", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto("/charcard.html");

		await expect(page.getByTestId("charcard-detail-name")).toHaveText("온새미");

		const overflow = await page.evaluate(() => {
			const root = document.querySelector(
				".charcard-app",
			) as HTMLElement | null;
			const docOverflow =
				document.documentElement.scrollWidth -
				document.documentElement.clientWidth;
			const rootOverflow = root ? root.scrollWidth - root.clientWidth : 0;
			return { docOverflow, rootOverflow };
		});
		expect(overflow.docOverflow).toBeLessThanOrEqual(1);
		expect(overflow.rootOverflow).toBeLessThanOrEqual(1);

		// Keyboard-only Tab navigation reaches the Start Roleplay button
		let reachedStartButton = false;
		for (let step = 0; step < 20; step++) {
			await page.keyboard.press("Tab");
			const focusedTestId = await page.evaluate(
				() => document.activeElement?.getAttribute("data-testid") ?? "",
			);
			if (focusedTestId === "charcard-start-button") {
				reachedStartButton = true;
				break;
			}
		}
		expect(reachedStartButton).toBe(true);
		await expect(page.getByTestId("charcard-start-button")).toBeFocused();
	});
});
