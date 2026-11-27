import { describe, expect, it } from "vitest";
import { setLocale, t } from "../i18n";

/**
 * b1 묶음: 로케일 밖에서 언어로 분기하는 번역표 11개를 locales/ 로 옮긴다.
 * 이 시험은 새 키가 열네 로케일 모듈에 모두 있고 ko/en 런타임 문구가
 * 기존 표와 글자까지 같은지 본다. 고치기 전에는 실패한다(RED).
 */
const NEW_KEYS = [
	"appShell.characterCardApplied",
	"settings.loadFailed",
	"webLogin.signInFreeCredit",
	"kiosk.demoGreeting",
	"avatar.videoFailedNarrow",
	"webAppInstall.title",
	"webAppInstall.loading",
	"webAppInstall.checking",
	"webAppInstall.accept",
	"webAppInstall.cancel",
	"webAppInstall.shop",
	"webAppInstall.unavailable",
	"webAppInstall.notOwned",
	"webAppInstall.signIn",
	"webAppInstall.failed",
	"loginPrompt.badge",
	"loginPrompt.title",
	"loginPrompt.body",
	"loginPrompt.reasonCloudLlm",
	"loginPrompt.reasonDragonVoice",
	"loginPrompt.reasonStudio",
	"loginPrompt.reasonAppStore",
	"loginPrompt.reasonAccount",
	"loginPrompt.loginCta",
	"loginPrompt.continueLocal",
	"loginPrompt.later",
	"harnessBar.cloudBrain",
	"harnessBar.cloudBrainTitle",
	"harnessBar.localBrain",
	"harnessBar.localBrainTitle",
	"harnessBar.checkBrain",
	"harnessBar.checkBrainDefault",
	"harnessBar.initBrain",
	"harnessBar.initBrainTitle",
	"harnessBar.openHarnessTitle",
	"harnessBar.openHarness",
	"harnessBar.charCardTitle",
	"harnessBar.charCard",
	"slugGuard.titleLoginRequired",
	"slugGuard.bodyLoginRequired",
	"slugGuard.titleForbidden",
	"slugGuard.bodyForbidden",
	"slugGuard.titleNotFound",
	"slugGuard.bodyNotFound",
	"slugGuard.titleInvalid",
	"slugGuard.bodyInvalid",
	"slugGuard.loginAsOwner",
	"slugGuard.tryFree",
] as const;

const LOCALES = [
	"ko",
	"en",
	"ja",
	"zh",
	"fr",
	"de",
	"ru",
	"es",
	"ar",
	"hi",
	"bn",
	"pt",
	"id",
	"vi",
] as const;

type LooseT = (key: string, params?: Record<string, string | number>) => string;
const looseT = t as LooseT;

describe("b1 번역표 이관 키가 열네 로케일에 있다", () => {
	it("모든 로케일 모듈이 새 키 48개를 갖는다", async () => {
		for (const locale of LOCALES) {
			const mod = (await import(`../locales/${locale}.ts`)) as {
				default: Record<string, string | undefined>;
			};
			const table =
				locale === "en"
					? {
							...mod.default,
							...(
								(await import("../locales/ollama-en")) as {
									default: Record<string, string | undefined>;
								}
							).default,
						}
					: mod.default;
			for (const key of NEW_KEYS) {
				expect(table[key], `${locale} 에 ${key} 없음`).toBeTruthy();
			}
		}
	});

	it("ko/en 런타임 문구가 기존 표와 같다", async () => {
		await setLocale("ko");
		expect(looseT("appShell.characterCardApplied", { name: "X" })).toBe(
			"캐릭터 카드 적용됨: X",
		);
		expect(looseT("settings.loadFailed")).toBe(
			"설정 화면을 불러오지 못했습니다.",
		);
		expect(looseT("webLogin.signInFreeCredit")).toBe("로그인 · 무료 200 Cr");
		expect(looseT("loginPrompt.title")).toBe("로그인하고 무료 200 Cr 받기");
		expect(looseT("slugGuard.loginAsOwner")).toBe("주인 계정으로 로그인");
		await setLocale("en");
		expect(looseT("appShell.characterCardApplied", { name: "X" })).toBe(
			"Character card applied: X",
		);
		expect(looseT("settings.loadFailed")).toBe("Could not load settings.");
		expect(looseT("webLogin.signInFreeCredit")).toBe("Sign in · 200 Cr");
		expect(looseT("loginPrompt.title")).toBe("Sign in and get 200 Cr free");
		expect(looseT("slugGuard.loginAsOwner")).toBe("Sign in as Owner");
		await setLocale("ko");
	});
});
