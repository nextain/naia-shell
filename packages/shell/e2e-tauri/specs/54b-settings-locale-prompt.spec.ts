import { S } from "../helpers/selectors.js";
import { navigateToSettings, safeRefresh } from "../helpers/settings.js";

/** Locales with formal/informal distinction — must match FORMALITY_LOCALES in persona.ts */
const FORMALITY_LOCALES = [
	"ko",
	"ja",
	"de",
	"fr",
	"es",
	"hi",
	"vi",
	"ru",
	"pt",
	"id",
	"ar",
];
/** Locales WITHOUT formal/informal distinction */
const NON_FORMALITY_LOCALES = ["en", "zh", "bn"];

/** Helper: set locale (and optionally speechStyle) in config and refresh */
async function setLocale(locale: string, speechStyle?: string) {
	await browser.execute(
		(loc: string, ss?: string) => {
			const raw = localStorage.getItem("naia-config");
			const config = raw ? JSON.parse(raw) : {};
			config.locale = loc;
			if (ss) config.speechStyle = ss;
			localStorage.setItem("naia-config", JSON.stringify(config));
		},
		locale,
		speechStyle,
	);
	await safeRefresh();
	await browser.pause(2000);
}

/** Helper: check if speechStyle select is visible */
async function findSpeechStyleSelect() {
	const el = await $(S.speechStyleSelect);
	if (await el.isExisting()) return el;
	return undefined;
}

describe("54 — Locale affects system prompt config", () => {
	before(async () => {
		await safeRefresh();
		await browser.pause(2000);
	});

	it("stores locale 'en' in config correctly", async () => {
		await setLocale("en");
		const locale = await browser.execute(() => {
			const raw = localStorage.getItem("naia-config");
			const config = raw ? JSON.parse(raw) : {};
			return config.locale;
		});
		expect(locale).toBe("en");
	});

	it("stores locale 'ko' in config correctly", async () => {
		await setLocale("ko");
		const locale = await browser.execute(() => {
			const raw = localStorage.getItem("naia-config");
			const config = raw ? JSON.parse(raw) : {};
			return config.locale;
		});
		expect(locale).toBe("ko");
	});

	// Test: speechStyle fields HIDDEN for non-formality locales
	for (const locale of NON_FORMALITY_LOCALES) {
		it(`speechStyle/honorific hidden for non-formality locale '${locale}'`, async () => {
			await setLocale(locale);
			await navigateToSettings();
			const speechSelect = await findSpeechStyleSelect();
			expect(speechSelect).toBeUndefined();
		});
	}

	// Test: speechStyle fields VISIBLE for formality locales
	for (const locale of FORMALITY_LOCALES) {
		it(`speechStyle/honorific visible for formality locale '${locale}'`, async () => {
			await setLocale(locale, "casual");
			await navigateToSettings();
			const speechSelect = await findSpeechStyleSelect();
			expect(speechSelect).toBeDefined();
		});
	}

	// Test: speechStyle stores "casual"/"formal" (not legacy Korean values)
	it("speechStyle stores normalized values", async () => {
		await setLocale("ja", "casual");
		await navigateToSettings();

		const speechSelect = await findSpeechStyleSelect();
		expect(speechSelect).toBeDefined();
		const val = await speechSelect?.getValue();
		expect(val).toBe("casual");
	});

	// Test: legacy "반말" value is migrated on startup
	it("migrates legacy speechStyle values on startup", async () => {
		// Set legacy value directly
		await browser.execute(() => {
			const raw = localStorage.getItem("naia-config");
			const config = raw ? JSON.parse(raw) : {};
			config.speechStyle = "반말";
			config.locale = "ko";
			localStorage.setItem("naia-config", JSON.stringify(config));
		});
		await safeRefresh();
		await browser.pause(2000);

		// After refresh (migration runs on startup), value should be normalized
		const speechStyle = await browser.execute(() => {
			const raw = localStorage.getItem("naia-config");
			const config = raw ? JSON.parse(raw) : {};
			return config.speechStyle;
		});
		expect(speechStyle).toBe("casual");
	});
});

// ── Onboarding: speechStyle step locale-aware skip ──

describe("54b — Onboarding speechStyle step skip by locale", () => {
	const API_KEY =
		process.env.CAFE_E2E_API_KEY || process.env.GEMINI_API_KEY || "test-e2e";

	/** Set up onboarding with given locale and refresh */
	async function setupOnboarding(locale: string) {
		await browser.execute((loc: string) => {
			localStorage.removeItem("naia-config");
			const config = {
				locale: loc,
			};
			localStorage.setItem("naia-config", JSON.stringify(config));
		}, locale);
		await safeRefresh();
		await browser.pause(2000);
	}

	/** JS click helper (WebDriver click fails with "unsupported operation" in WebKitGTK) */
	async function jsClick(selector: string) {
		await browser.execute((sel: string) => {
			const el = document.querySelector(sel) as HTMLElement | null;
			if (el) el.click();
		}, selector);
		await browser.pause(800);
	}

	/** Set input value using React-compatible native setter */
	async function jsSetValue(selector: string, value: string) {
		await browser.execute(
			(sel: string, val: string) => {
				const el = document.querySelector(sel) as HTMLInputElement | null;
				if (!el) return;
				const proto = HTMLInputElement.prototype;
				const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
				if (setter) setter.call(el, val);
				else el.value = val;
				el.dispatchEvent(new Event("input", { bubbles: true }));
			},
			selector,
			value,
		);
	}

	/**
	 * Navigate through onboarding until speechStyle or complete step.
	 * All interactions use JS click/setValue (WebKitGTK compat).
	 * Returns "speechStyle" | "complete" | "unknown".
	 */
	async function navigateToSpeechStyleOrComplete(): Promise<string> {
		const overlay = await $(S.onboardingOverlay);
		await overlay.waitForDisplayed({ timeout: 15_000 });

		// Step: provider — select first available card, click Next
		await browser.execute(() => {
			const card = document.querySelector(
				".onboarding-provider-cards .onboarding-provider-card:not(.disabled)",
			) as HTMLButtonElement | null;
			card?.click();
		});
		await browser.pause(300);
		await jsClick(S.onboardingNextBtn);

		// Step: apiKey — fill and advance
		await jsSetValue(S.onboardingInput, API_KEY);
		await jsClick(S.onboardingNextBtn);

		// Step: agentName
		await jsSetValue(S.onboardingInput, "E2E-Agent");
		await jsClick(S.onboardingNextBtn);

		// Step: userName
		await jsSetValue(S.onboardingInput, "E2E-User");
		await jsClick(S.onboardingNextBtn);

		// Step: character — click first VRM card, advance
		await jsClick(S.onboardingVrmCard);
		await jsClick(S.onboardingNextBtn);

		// Step: personality — click first card, advance
		await jsClick(S.onboardingPersonalityCard);
		await jsClick(S.onboardingNextBtn);

		// Now we're on speechStyle OR complete (if skipped)
		await browser.pause(500);
		const discordBtn = await $(
			'[data-testid="onboarding-discord-connect-btn"]',
		);
		if (await discordBtn.isExisting()) return "complete";

		const settingsField = await $(".onboarding-content .settings-field");
		if (await settingsField.isExisting()) return "speechStyle";

		return "unknown";
	}

	// Restore normal config after all onboarding tests
	after(async () => {
		await browser.execute(() => {
			const raw = localStorage.getItem("naia-config");
			const config = raw ? JSON.parse(raw) : {};
			config.onboardingComplete = true;
			localStorage.setItem("naia-config", JSON.stringify(config));
		});
		await safeRefresh();
		await browser.pause(2000);
	});

	// Non-formality locales: speechStyle step should be SKIPPED → land on complete
	for (const locale of NON_FORMALITY_LOCALES) {
		it(`onboarding skips speechStyle for '${locale}'`, async () => {
			await setupOnboarding(locale);
			const step = await navigateToSpeechStyleOrComplete();
			expect(step).toBe("complete");
		});
	}

	// Formality locales: speechStyle step should be SHOWN
	for (const locale of FORMALITY_LOCALES) {
		it(`onboarding shows speechStyle for '${locale}'`, async () => {
			await setupOnboarding(locale);
			const step = await navigateToSpeechStyleOrComplete();
			expect(step).toBe("speechStyle");
		});
	}
});
