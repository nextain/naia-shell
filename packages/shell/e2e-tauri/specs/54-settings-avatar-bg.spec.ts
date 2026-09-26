import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { S } from "../helpers/selectors.js";
import {
	clickBySelector,
	ensureAppReady,
	navigateToSettings,
	openSettingsSection,
	openVrmAvatarPicker,
	scrollToSection,
} from "../helpers/settings.js";

// 1x1 PNG. 설정은 ADK 의 naia-settings/background 에 있는 파일을 그대로 고르게 한다.
// 바이트 배열로 적는다 — base64 한 줄은 OSS 공개 관문이 토큰으로 본다.
const PNG_1X1 = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
	0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
	0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
	0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0xfc, 0xcf, 0xc0, 0x50,
	0x0f, 0x00, 0x04, 0x85, 0x01, 0x80, 0x84, 0xa9, 0x8c, 0x21, 0x00, 0x00,
	0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

/** 격리 ADK 는 템플릿 자산을 복제하지 않아 배경이 비어 있다 — 고를 거리를 둘 심는다. */
function seedBackgrounds(): void {
	const adk = process.env.NAIA_E2E_ADK_PATH?.trim();
	if (!adk) throw new Error("NAIA_E2E_ADK_PATH is not set — run through wdio.conf.ts");
	const dir = join(adk, "naia-settings", "background");
	mkdirSync(dir, { recursive: true });
	if (readdirSync(dir).length >= 2) return;
	writeFileSync(join(dir, "e2e-bg-a.png"), PNG_1X1);
	writeFileSync(join(dir, "e2e-bg-b.png"), PNG_1X1);
}

/**
 * 54 — Settings: Avatar VRM & Background
 *
 * #541: VRM 선택은 아바타 섹션의 목록(vrm-list-item)이고, 배경은 General
 * 섹션의 select 위젯이다 — 옛 카드 그리드 화면을 기다리지 않는다.
 */
describe("54 — settings avatar & background", () => {
	before(async () => {
		seedBackgrounds();
		await ensureAppReady();
		// 아바타와 배경은 '아바타' 구역에 있고, VRM 카드는 공급자를 VRM 으로
		// 바꿔야 렌더된다 (#541).
		await openVrmAvatarPicker();
	});

	it("VRM 피커가 렌더된다 — 목록이거나 비었다는 표시", async () => {
		await scrollToSection(".vrm-list");
		const state = await browser.execute(() => ({
			list: !!document.querySelector(".vrm-list"),
			items: document.querySelectorAll(".vrm-list-item").length,
			empty: !!document.querySelector(".vrm-list-empty"),
		}));
		// 설치된 VRM 개수는 기계마다 다르다. 피커가 떴는지, 그리고 항목이
		// 없으면 없다고 말하는지를 본다 — 빈 화면을 통과로 세지 않는다.
		expect(state.list).toBe(true);
		expect(state.items > 0 || state.empty).toBe(true);
	});

	it("고른 VRM 이 하나만 활성으로 표시된다", async () => {
		const state = await browser.execute(() => ({
			items: document.querySelectorAll(".vrm-list-item").length,
			active: document.querySelectorAll(".vrm-list-item--active").length,
		}));
		if (state.items === 0) return; // 설치된 VRM 이 없는 기계
		expect(state.active).toBe(1);
	});

	it("should change the active VRM on click", async () => {
		const switched = await browser.execute((allSel: string) => {
			const all = document.querySelectorAll(allSel);
			for (let i = 0; i < all.length; i++) {
				// Skip the add card and already-active cards
				// 목록 항목은 onClick 으로 고른다 (#541 — 카드 시절의 길게누르기 아님).
				if (all[i].classList.contains("vrm-list-item--active")) continue;
				(all[i] as HTMLElement).click();
				return true;
			}
			return false;
		}, S.vrmCard);
		if (!switched) return; // 모델이 하나뿐이면 전환 검증은 건너뛴다
		await browser.pause(300);
		const activeCount = await browser.execute(
			(sel: string) => document.querySelectorAll(sel).length,
			S.vrmCardActive,
		);
		expect(activeCount).toBe(1);
	});

	it("should offer background choices in the general section", async () => {
		await openSettingsSection("general");
		const optionCount = await browser.execute((sel: string) => {
			const select = document.querySelector(sel) as HTMLSelectElement | null;
			return select ? select.options.length : 0;
		}, S.bgSelect);
		// "없음" + 심은 배경 둘.
		expect(optionCount).toBeGreaterThanOrEqual(3);
	});

	it("should switch the background selection", async () => {
		const changed = await browser.execute((sel: string) => {
			const select = document.querySelector(sel) as HTMLSelectElement | null;
			if (!select || select.options.length < 2) return null;
			const current = select.value;
			const next = Array.from(select.options)
				.map((option) => option.value)
				.find((value) => value !== current);
			if (next === undefined) return null;
			select.value = next;
			select.dispatchEvent(new Event("change", { bubbles: true }));
			return { from: current, to: next };
		}, S.bgSelect);
		expect(changed).not.toBeNull();
		if (!changed) return;
		await browser.pause(300);
		const value = await browser.execute(
			(sel: string) =>
				(document.querySelector(sel) as HTMLSelectElement | null)?.value ?? "",
			S.bgSelect,
		);
		expect(value).toBe(changed.to);
	});

	after(async () => {
		// 같은 실행의 뒤 스펙이 심은 배경을 물려받지 않게 "없음"으로 되돌리고 지운다.
		await openSettingsSection("general").catch(() => {});
		await browser
			.execute((sel: string) => {
				const select = document.querySelector(sel) as HTMLSelectElement | null;
				if (!select || select.value === "") return;
				select.value = "";
				select.dispatchEvent(new Event("change", { bubbles: true }));
			}, S.bgSelect)
			.catch(() => {});
		await browser.pause(300);
		const adk = process.env.NAIA_E2E_ADK_PATH?.trim();
		if (adk) {
			for (const name of ["e2e-bg-a.png", "e2e-bg-b.png"]) {
				rmSync(join(adk, "naia-settings", "background", name), { force: true });
			}
		}
		await clickBySelector(S.chatTab).catch(() => {});
	});

	it("should navigate back to chat tab", async () => {
		await clickBySelector(S.chatTab);
		const chatInput = await $(S.chatInput);
		await chatInput.waitForDisplayed({ timeout: 5_000 });
	});
});
