import { deflateRawSync, deflateSync } from "node:zlib";
import { expect, test } from "@playwright/test";

function buildSingleEntryCharxZip(cardJsonText: string): Buffer {
	const nameBytes = Buffer.from("card.json", "utf8");
	const rawData = Buffer.from(cardJsonText, "utf8");
	const compressedData = deflateRawSync(rawData);

	// Compute IEEE 802.3 CRC32
	let crc = 0xffffffff;
	for (let i = 0; i < rawData.length; i++) {
		crc ^= rawData[i] ?? 0;
		for (let bit = 0; bit < 8; bit++) {
			crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
		}
	}
	crc = (crc ^ 0xffffffff) >>> 0;

	const lfh = Buffer.alloc(30 + nameBytes.length);
	lfh.writeUInt32LE(0x04034b50, 0);
	lfh.writeUInt16LE(20, 4);
	lfh.writeUInt16LE(0, 6);
	lfh.writeUInt16LE(8, 8);
	lfh.writeUInt32LE(crc, 14);
	lfh.writeUInt32LE(compressedData.length, 18);
	lfh.writeUInt32LE(rawData.length, 22);
	lfh.writeUInt16LE(nameBytes.length, 26);
	nameBytes.copy(lfh, 30);

	const cdh = Buffer.alloc(46 + nameBytes.length);
	cdh.writeUInt32LE(0x02014b50, 0);
	cdh.writeUInt16LE(20, 4);
	cdh.writeUInt16LE(20, 6);
	cdh.writeUInt16LE(0, 8);
	cdh.writeUInt16LE(8, 10);
	cdh.writeUInt32LE(crc, 16);
	cdh.writeUInt32LE(compressedData.length, 20);
	cdh.writeUInt32LE(rawData.length, 24);
	cdh.writeUInt16LE(nameBytes.length, 28);
	cdh.writeUInt32LE(0, 42);
	nameBytes.copy(cdh, 46);

	const cdOffset = lfh.length + compressedData.length;
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(1, 8);
	eocd.writeUInt16LE(1, 10);
	eocd.writeUInt32LE(cdh.length, 12);
	eocd.writeUInt32LE(cdOffset, 16);

	return Buffer.concat([lfh, compressedData, cdh, eocd]);
}

function cardPng(width: number, height: number): Buffer {
	const chunk = (type: string, data: Buffer) => {
		const body = Buffer.concat([Buffer.from(type), data]);
		let crc = 0xffffffff;
		for (const byte of body) {
			crc ^= byte;
			for (let i = 0; i < 8; i++)
				crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
		}
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const checksum = Buffer.alloc(4);
		checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
		return Buffer.concat([length, body, checksum]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	const text = Buffer.from(
		`chara\0${Buffer.from(JSON.stringify({ name: "큰 그림 카드", first_mes: "안녕하세요" })).toString("base64")}`,
	);
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk("IHDR", ihdr),
		chunk("tEXt", text),
		chunk("IDAT", deflateSync(Buffer.from([0, 0, 0, 0, 0]))),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

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

		// 1. Initial 4 sample cards list & PNG sample card avatar + name
		await expect(page.getByTestId("charcard-detail-name")).toHaveText("온새미");
		const avatarImg = page.getByTestId("charcard-avatar-img");
		await expect(avatarImg).toBeVisible();
		await expect(avatarImg).toHaveAttribute("alt", "온새미");
		await expect(
			page.getByTestId("charcard-item-sample:clockwork-tinker-v3"),
		).toContainText("한도윤");
		await expect(
			page.getByTestId("charcard-item-sample:clockwork-tinker-json-v3"),
		).toContainText("백하진");
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

		// 3b. Shell context-cleared postMessage ends active roleplay banner
		await page.evaluate(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					source: window.parent,
					data: { type: "naia-app:context-cleared" },
				}),
			);
		});
		await expect(page.getByTestId("charcard-active-banner")).toHaveCount(0);

		// 4. Start again and manually end roleplay -> verify parent receives context: null
		await page.getByTestId("charcard-start-button").click();
		await expect(page.getByTestId("charcard-active-banner")).toContainText(
			"한도윤 연기 중",
		);
		await page.getByTestId("charcard-stop-button").click();
		await expect(page.getByTestId("charcard-active-banner")).toHaveCount(0);
		const stopMsg = await page.evaluate(
			() => window.__charcardParentMessages?.at(-1) ?? null,
		);
		expect(stopMsg).toEqual({
			type: "naia-app:context",
			context: null,
		});

		// 5. Upload CHARX (.charx) archive card file
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
			name: "navigator.charx",
			mimeType: "application/zip",
			buffer: buildSingleEntryCharxZip(JSON.stringify(uploadedCard)),
		});
		await expect(page.getByTestId("charcard-detail-name")).toHaveText(
			"별빛항해사",
		);

		// 6. Delete confirmation dialog: Cancel keeps card, Confirm removes card and focuses next card
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
		await expect(
			page.getByTestId("charcard-item-sample:greenhouse-keeper-png"),
		).toBeFocused();

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

	test("saves and roleplays an oversized image card with a persistent warning at narrow width", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto("/charcard.html");
		await expect(page.getByTestId("charcard-import-button")).toBeEnabled();
		await page.getByTestId("charcard-file-input").setInputFiles({
			name: "large.png",
			mimeType: "image/png",
			buffer: cardPng(100000, 100000),
		});
		await expect(page.getByTestId("charcard-detail-name")).toHaveText(
			"큰 그림 카드",
		);
		await expect(page.getByTestId("charcard-image-warning")).toHaveText(
			"그림이 너무 커서 표시하지 않음",
		);
		await expect(
			page
				.getByRole("status")
				.filter({ hasText: "그림이 너무 커서 표시하지 않음" }),
		).toBeVisible();
		await expect(page.getByTestId("charcard-avatar-img")).toHaveCount(0);
		await page.getByTestId("charcard-start-button").click();
		await expect(page.getByTestId("charcard-active-banner")).toContainText(
			"큰 그림 카드",
		);
		await page.reload();
		await expect(page.getByTestId("charcard-detail-name")).toHaveText("온새미");
		await page.getByText("큰 그림 카드", { exact: true }).first().click();
		await expect(page.getByTestId("charcard-image-warning")).toBeVisible();
		expect(
			await page.evaluate(
				() =>
					document.documentElement.scrollWidth -
					document.documentElement.clientWidth,
			),
		).toBeLessThanOrEqual(1);
	});

	test("creates images only inside PNG dimension limits", async ({ page }) => {
		await page.goto("/charcard.html");
		await expect(page.getByTestId("charcard-import-button")).toBeEnabled();
		for (const [width, height, omitted] of [
			[8192, 4096, false],
			[8193, 1, true],
		] as const) {
			await page.getByTestId("charcard-file-input").setInputFiles({
				name: `${width}.png`,
				mimeType: "image/png",
				buffer: cardPng(width, height),
			});
			await expect(page.getByTestId("charcard-detail-name")).toHaveText(
				"큰 그림 카드",
			);
			await expect(page.getByTestId("charcard-image-warning")).toHaveCount(
				omitted ? 1 : 0,
			);
			await expect(page.getByTestId("charcard-avatar-img")).toHaveCount(
				omitted ? 0 : 1,
			);
		}
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
