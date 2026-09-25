import { S } from "../helpers/selectors.js";
import { resetOnboarding } from "../helpers/settings.js";

/**
 * 09 — 온보딩 마법사를 처음부터 끝까지 지난다.
 *
 * 지금의 순서: welcome → agentName → userName → speechStyle(로케일에 따라
 * 건너뜀) → character → background → provider → voice → complete.
 *
 * 예전 스펙은 공급자 카드와 API 키 입력, 웹훅 단계를 지났다. #447 이 키 입력을
 * 온보딩 밖으로 옮기고 #589·#602 가 타사 직결 공급자를 없애면서 그 화면은
 * 사라졌는데, 스펙은 Gemini 키를 요구한 채 남아 회귀에서 늘 "환경 없음" 으로
 * 빠졌다. 13(랩 카드)·35(보이면 버튼이 있다)·67(키 입력 후 저장)이 보던 것은
 * 여기 한 곳에서 지금 화면으로 잰다 — 나이아 로그인 입구가 공급자 단계에 있는지,
 * "나중에 설정" 으로 끝까지 갈 수 있는지, 끝낸 뒤 이름이 저장되는지.
 *
 * 워크스페이스 설정은 다음 스펙 전에 하네스가 다시 심는다(wdio.conf.ts
 * beforeSession). 그래서 여기서 되돌려 놓을 것이 없다.
 */

const AGENT_NAME = "E2E-Agent";
const USER_NAME = "E2E-User";

async function currentStep(): Promise<string> {
	return browser.execute(
		(sel: string) =>
			document.querySelector(sel)?.getAttribute("data-step") ?? "",
		S.onboardingStep,
	);
}

async function waitForStepChange(from: string): Promise<string> {
	let next = from;
	await browser.waitUntil(
		async () => {
			next = await currentStep();
			return next !== from;
		},
		{ timeout: 10_000, timeoutMsg: `onboarding stayed on step "${from}"` },
	);
	return next;
}

async function clickNext(): Promise<void> {
	const next = await $(S.onboardingNextBtn);
	await next.waitForEnabled({ timeout: 10_000 });
	await next.click();
}

async function typeInto(value: string): Promise<void> {
	const input = await $(S.onboardingInput);
	await input.waitForDisplayed({ timeout: 10_000 });
	await input.clearValue();
	await input.setValue(value);
}

describe("09 — Onboarding Wizard", () => {
	const visited: string[] = [];

	it("reset shows the wizard at the welcome step", async () => {
		await resetOnboarding();
		await browser.waitUntil(async () => (await currentStep()) === "welcome", {
			timeout: 15_000,
			timeoutMsg: "onboarding did not start at the welcome step",
		});
		// 첫 단계에는 뒤로 가기가 없다.
		const hasBack = await browser.execute(
			(sel: string) => !!document.querySelector(sel),
			S.onboardingBackBtn,
		);
		expect(hasBack).toBe(false);
	});

	it("walks every step to the provider step", async () => {
		let step = await currentStep();
		for (let guard = 0; guard < 12 && step !== "provider"; guard += 1) {
			visited.push(step);
			if (step === "agentName") await typeInto(AGENT_NAME);
			if (step === "userName") await typeInto(USER_NAME);
			if (step === "character") {
				// VRM 이 기본이면 하나를 골라야 다음으로 갈 수 있다.
				const next = await $(S.onboardingNextBtn);
				if (!(await next.isEnabled())) {
					const card = await $(S.onboardingVrmCard);
					await card.waitForDisplayed({ timeout: 10_000 });
					await card.click();
				}
			}
			await clickNext();
			step = await waitForStepChange(step);
		}
		expect(step).toBe("provider");
		for (const expected of [
			"welcome",
			"agentName",
			"userName",
			"character",
			"background",
		]) {
			expect(visited).toContain(expected);
		}
	});

	it("provider step offers the Naia login entry and a later path", async () => {
		const naiaLogin = await $(S.onboardingNaiaLoginBtn);
		await naiaLogin.waitForDisplayed({ timeout: 10_000 });
		const later = await $(S.onboardingProviderLater);
		await later.waitForDisplayed({ timeout: 10_000 });
		// 이 단계의 다음 버튼은 로그인한 뒤에만 나온다.
		const hasNext = await browser.execute(
			(sel: string) => !!document.querySelector(sel),
			S.onboardingNextBtn,
		);
		expect(hasNext).toBe(false);
		await later.click();
		const step = await waitForStepChange("provider");
		expect(["voice", "complete"]).toContain(step);
	});

	it("completes and closes the wizard with the entered names saved", async () => {
		let step = await currentStep();
		if (step === "voice") {
			await clickNext();
			step = await waitForStepChange("voice");
		}
		expect(step).toBe("complete");
		await clickNext();

		await browser.waitUntil(
			async () =>
				browser.execute(
					(sel: string) => !document.querySelector(sel),
					S.onboardingOverlay,
				),
			{
				timeout: 30_000,
				timeoutMsg: "Onboarding did not close after the start button",
			},
		);

		const config = await browser.execute(() => {
			const raw = localStorage.getItem("naia-config");
			return raw ? JSON.parse(raw) : null;
		});
		expect(config).not.toBeNull();
		expect(config.onboardingComplete).toBe(true);
		expect(config.agentName).toBe(AGENT_NAME);
		expect(config.userName).toBe(USER_NAME);
	});
});
