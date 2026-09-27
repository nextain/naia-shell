import { S } from "../helpers/selectors.js";
import {
	ensureAppReady,
	navigateToSettings,
	openSettingsSection,
} from "../helpers/settings.js";

/**
 * 02 — 설정 화면이 워크스페이스에 심긴 공급자를 그대로 보여 준다.
 *
 * 예전 스펙은 설정에서 Gemini 공급자와 키, 로컬 게이트웨이 주소를 손으로
 * 넣었다. #602 가 타사 직결 공급자를 없애 그 선택지가 사라졌고, 게이트웨이
 * 주소 칸도 이제 없다. 그래서 Gemini 키를 요구한 채 회귀에서 늘 빠졌다.
 *
 * 지금 공급자의 정본은 워크스페이스 config.json 이고 하네스가 거기에 나이아
 * 게이트웨이 공급자를 심는다(wdio.conf.ts). 이 스펙은 화면이 그 값을 읽어
 * 보여 주는지, 계정(나이아 로그인) 입구가 프로필 구역에 있는지, 설정을 닫은 뒤
 * 대화 입력이 살아 있는지를 잰다.
 */
describe("02 — Configure Settings", () => {
	before(async () => {
		await ensureAppReady();
	});

	it("brain section shows the provider seeded in the workspace", async () => {
		// #541: 설정은 앱 전환 + 내부 섹션 탭 구조. 공급자는 brain 섹션.
		await navigateToSettings();
		const settingsTab = await $(S.settingsTab);
		await settingsTab.waitForDisplayed({ timeout: 30_000 });
		await openSettingsSection("brain");

		const providerSelect = await $(S.providerSelect);
		await providerSelect.waitForDisplayed({ timeout: 10_000 });
		const expected = await browser.execute(() => {
			const raw = localStorage.getItem("naia-config");
			if (!raw) return "";
			const config = JSON.parse(raw) as {
				llmRoles?: { main?: { provider?: unknown } };
				provider?: unknown;
			};
			const provider = config.llmRoles?.main?.provider ?? config.provider;
			return typeof provider === "string" ? provider : "";
		});
		expect(expected).not.toBe("");
		await browser.waitUntil(
			async () =>
				(await browser.execute(
					(sel: string) =>
						(document.querySelector(sel) as HTMLSelectElement | null)
							?.value ?? "",
					S.providerSelect,
				)) === expected,
			{
				timeout: 10_000,
				timeoutMsg: `provider select did not show the seeded provider "${expected}"`,
			},
		);
	});

	it("profile section offers the Naia account entry", async () => {
		// #541: Naia 계정(Lab) UI 는 profile 섹션의 로그인/계정 필드로 옮겨졌다.
		await openSettingsSection("profile");
		await browser.waitUntil(
			async () =>
				browser.execute(
					() =>
						document.querySelector(
							'[data-testid="profile-naia-login"], [data-testid="profile-naia-account"]',
						) !== null,
				),
			{ timeout: 10_000, timeoutMsg: "Naia account entry not found in profile" },
		);
	});

	it("chat input is enabled after leaving settings", async () => {
		await browser.execute((sel: string) => {
			const el = document.querySelector(sel) as HTMLButtonElement | null;
			el?.click();
		}, S.chatTab);

		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 15_000 });
	});
});
