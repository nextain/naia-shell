import {
	getLastAssistantMessage,
	sendMessage,
	waitForToolSuccess,
} from "../helpers/chat.js";
import { S } from "../helpers/selectors.js";
import { assertSemantic } from "../helpers/semantic.js";

const SHOT = "/tmp/panel-system-screenshots";

/** Click a panel tab by its panel id (data-panel-id attribute) */
async function clickPanelTab(panelId: string): Promise<boolean> {
	return browser.execute((id: string) => {
		const btn = document.querySelector(
			`.mode-bar-tab[data-panel-id="${id}"]`,
		) as HTMLButtonElement | null;
		if (btn) {
			btn.click();
			return true;
		}
		return false;
	}, panelId);
}

/** Click the remove button of a panel by its panel id */
async function clickPanelRemove(panelId: string): Promise<boolean> {
	return browser.execute((id: string) => {
		const wrapper = document.querySelector(
			`.mode-bar-tab-wrapper[data-panel-id="${id}"]`,
		);
		const btn = wrapper?.querySelector(
			".mode-bar-tab-remove",
		) as HTMLButtonElement | null;
		if (btn) {
			btn.click();
			return true;
		}
		return false;
	}, panelId);
}

describe("90 — Panel System (ModeBar + sample-note AI interaction)", () => {
	before(async () => {
		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 15_000 });
		await $(S.appRoot).waitForDisplayed({ timeout: 15_000 });
		await browser.pause(500);
	});

	it("01 — ModeBar is visible", async () => {
		const modeBar = await $(S.modeBar);
		await modeBar.waitForDisplayed({ timeout: 10_000 });
		await browser.saveScreenshot(`${SHOT}/01-modebar.png`);
	});

	it("02 — built-in panels appear in ModeBar (browser, workspace)", async () => {
		const panelIds = await browser.execute(() => {
			return Array.from(
				document.querySelectorAll(".mode-bar-tab[data-panel-id]"),
			).map((el) => el.getAttribute("data-panel-id") ?? "");
		});
		expect(panelIds).toContain("browser");
		expect(panelIds).toContain("workspace");
	});

	it("03 — sample-note panel appears in ModeBar", async () => {
		const panelIds = await browser.execute(() => {
			return Array.from(
				document.querySelectorAll(".mode-bar-tab[data-panel-id]"),
			).map((el) => el.getAttribute("data-panel-id") ?? "");
		});
		expect(panelIds).toContain("sample-note");
		await browser.saveScreenshot(`${SHOT}/03-sample-note-in-modebar.png`);
	});

	it("04 — clicking sample-note tab opens SampleNotePanel", async () => {
		const clicked = await clickPanelTab("sample-note");
		expect(clicked).toBe(true);
		await browser.pause(500);

		const panel = await $(S.sampleNotePanel);
		await panel.waitForDisplayed({ timeout: 5_000 });
		await browser.saveScreenshot(`${SHOT}/04-sample-note-panel-open.png`);
	});

	it("05 — AI can write to sample-note panel", async () => {
		await sendMessage(
			"지금 열려있는 sample-note 메모장에 'E2E test note content' 라고 적어줘.",
		);
		await waitForToolSuccess();

		const lastTool = await browser.execute(() => {
			const items = document.querySelectorAll(".tool-activity[data-tool-name]");
			if (items.length > 0) {
				return items[items.length - 1]?.getAttribute("data-tool-name") ?? "";
			}
			const labels = document.querySelectorAll(".tool-activity .tool-name");
			return labels[labels.length - 1]?.textContent?.trim() ?? "";
		});
		expect(lastTool).toMatch(/skill_note_write/i);

		await browser.saveScreenshot(`${SHOT}/05-note-write.png`);
	});

	it("06 — note textarea reflects the written content", async () => {
		const value = await browser.execute(() => {
			const ta = document.querySelector(
				".sample-note-panel__editor",
			) as HTMLTextAreaElement | null;
			return ta?.value ?? ta?.textContent ?? "";
		});
		expect(value).toMatch(/E2E test note content/i);
	});

	it("07 — AI can read note from sample-note panel", async () => {
		await sendMessage("방금 sample-note 메모장에 뭐가 적혀있어?");
		await waitForToolSuccess();

		const text = await getLastAssistantMessage();
		await assertSemantic(
			text,
			"메모장에 뭐가 적혀있는지 물어봤다",
			"AI가 'E2E test note content'를 포함한 노트 내용을 알려줬으면 PASS. 도구 오류나 내용 없음이면 FAIL",
		);
		await browser.saveScreenshot(`${SHOT}/07-note-read.png`);
	});

	it("08 — built-in panels have no remove button", async () => {
		const builtInHasRemove = await browser.execute(() => {
			for (const panelId of ["browser", "workspace"]) {
				const wrapper = document.querySelector(
					`.mode-bar-tab-wrapper[data-panel-id="${panelId}"]`,
				);
				if (wrapper?.querySelector(".mode-bar-tab-remove")) return true;
			}
			return false;
		});
		expect(builtInHasRemove).toBe(false);
	});

	it("09 — sample-note has a remove button", async () => {
		const hasRemove = await browser.execute(() => {
			const wrapper = document.querySelector(
				`.mode-bar-tab-wrapper[data-panel-id="sample-note"]`,
			);
			return !!wrapper?.querySelector(".mode-bar-tab-remove");
		});
		expect(hasRemove).toBe(true);
	});

	it("10 — removing sample-note tab removes it from ModeBar", async () => {
		const tabsBefore = await browser.execute(() => {
			return document.querySelectorAll(".mode-bar-tab[data-panel-id]").length;
		});

		const removed = await clickPanelRemove("sample-note");
		expect(removed).toBe(true);

		await browser.pause(500);

		const tabsAfter = await browser.execute(() => {
			return document.querySelectorAll(".mode-bar-tab[data-panel-id]").length;
		});
		expect(tabsAfter).toBe(tabsBefore - 1);

		const stillPresent = await browser.execute(() => {
			return !!document.querySelector(
				`.mode-bar-tab[data-panel-id="sample-note"]`,
			);
		});
		expect(stillPresent).toBe(false);

		await browser.saveScreenshot(`${SHOT}/10-sample-note-removed.png`);
	});
});
