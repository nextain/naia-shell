import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { S } from "../helpers/selectors.js";
import { safeRefresh } from "../helpers/settings.js";

type PreparedAdkConfig = {
	llmRoles?: {
		main?: {
			provider?: unknown;
			model?: unknown;
			credentialRef?: unknown;
		};
	};
};

function readPreparedAdk(): {
	adkPath: string;
	provider: string;
	model: string;
} | null {
	const rawAdkPath = process.env.NAIA_E2E_ADK_PATH?.trim();
	if (!rawAdkPath) {
		return null;
	}

	const adkPath = resolve(rawAdkPath);
	const configPath = resolve(adkPath, "naia-settings", "config.json");
	const config = JSON.parse(
		readFileSync(configPath, "utf8"),
	) as PreparedAdkConfig;
	const main = config.llmRoles?.main;
	const provider = typeof main?.provider === "string" ? main.provider : "";
	const model = typeof main?.model === "string" ? main.model : "";
	const credentialRef =
		typeof main?.credentialRef === "string" ? main.credentialRef : "";
	if (!provider || !model || !credentialRef) {
		throw new Error(
			"selected ADK config must contain an LLM provider, model, and credential reference",
		);
	}

	return { adkPath, provider, model };
}

describe("01 — App Launch", () => {
	it("should display the app root", async () => {
		const appRoot = await $(S.appRoot);
		await appRoot.waitForDisplayed({ timeout: 30_000 });
	});

	it("should hydrate onboarding from the selected ADK fixture", async () => {
		const prepared = readPreparedAdk();
		// 하네스(wdio.conf.ts)가 늘 격리 ADK 를 만든다. 예전의 Gemini 직결
		// 대안은 그 공급자가 사라진 뒤(#602) 도달할 수 없는 분기였고, 그 키를
		// 요구한다는 이유로 이 스펙이 회귀에서 빠졌다.
		if (!prepared) {
			throw new Error("NAIA_E2E_ADK_PATH is not set — run through wdio.conf.ts");
		}
		await safeRefresh();

		await browser.waitUntil(
			async () => {
				return browser.execute(
					(expected: {
						adkPath: string;
						provider: string;
						model: string;
					}) => {
						const normalizePath = (value: string) =>
							value.replace(/\\/g, "/").replace(/\/+$/, "");
						if (
							normalizePath(localStorage.getItem("naia-adk-path") || "") !==
							normalizePath(expected.adkPath)
						) {
							return false;
						}
						const raw = localStorage.getItem("naia-config");
						if (!raw) return false;
						try {
							const config = JSON.parse(raw) as {
								onboardingComplete?: unknown;
								llmRoles?: {
									main?: {
										provider?: unknown;
										model?: unknown;
										credentialRef?: unknown;
									};
								};
							};
							const main = config.llmRoles?.main;
							return (
								config.onboardingComplete === true &&
								main?.provider === expected.provider &&
								main?.model === expected.model &&
								typeof main.credentialRef === "string" &&
								main.credentialRef.length > 0
							);
						} catch {
							return false;
						}
					},
					prepared,
				);
			},
			{
				timeout: 30_000,
				timeoutMsg: "selected ADK config did not hydrate into the app cache",
			},
		);

		await browser.waitUntil(
			async () =>
				browser.execute(
					(sel: string) => !document.querySelector(sel),
					S.onboardingOverlay,
				),
			{
				timeout: 15_000,
				timeoutMsg: "Onboarding still visible after ADK hydration",
			},
		);

		const appRoot = await $(S.appRoot);
		await appRoot.waitForDisplayed({ timeout: 10_000 });
		const chatInput = await $(S.chatInput);
		await chatInput.waitForDisplayed({ timeout: 10_000 });
	});
});
