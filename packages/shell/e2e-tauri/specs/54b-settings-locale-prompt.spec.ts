import { S } from "../helpers/selectors.js";
import {
	navigateToSettings,
	openSettingsSection,
	persistConfigPatch,
	resetOnboarding,
	safeRefresh,
} from "../helpers/settings.js";

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

/**
 * locale(그리고 필요하면 speechStyle)을 설정에 넣고 새로 고친다.
 *
 * 예전에는 `localStorage` 만 고쳤다. 그런데 설정의 정본은 워크스페이스의
 * `config.json` 이고 부팅 병합에서 파일이 이기므로(FR-CONFIG-SOT.1), 새로 고침
 * 직후 그 값이 사라졌다 — 이 파일의 단정 열다섯 개가 그 자리에서 죽었다(#564).
 * 이제 제품의 되쓰기 경로를 그대로 타 파일까지 저장한 뒤 새로 고친다.
 */
async function setLocale(locale: string, speechStyle?: string) {
	await persistConfigPatch(
		speechStyle ? { locale, speechStyle } : { locale },
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

/** Speech style lives in the Persona subtab, not the top-level Settings entry. */
async function openPersonaSettings() {
	await navigateToSettings();
	await openSettingsSection("persona");
	await browser.waitUntil(
		async () =>
			(await browser.execute(() =>
				Boolean(
					document.querySelector(
						'[data-settings-tab="persona"].settings-tab-btn--active',
					),
				),
			)) === true,
		{
			timeout: 10_000,
			timeoutMsg: "Persona settings subtab did not become active",
		},
	);
}

async function tauriInvoke<T>(
	command: string,
	args: Record<string, unknown> = {},
): Promise<T> {
	return (await browser.execute(
		async (cmd: string, input: Record<string, unknown>) => {
			const w = window as unknown as {
				__TAURI_INTERNALS__?: {
					invoke: (name: string, payload: unknown) => Promise<unknown>;
				};
				__TAURI__?: {
					core?: { invoke: (name: string, payload: unknown) => Promise<unknown> };
				};
			};
			const invoke =
				w.__TAURI_INTERNALS__?.invoke ?? w.__TAURI__?.core?.invoke;
			if (!invoke) throw new Error("Tauri invoke unavailable");
			return invoke(cmd, input);
		},
		command,
		args,
	)) as T;
}

/** Seed the legacy value in the selected ADK file, then let startup migrate it. */
async function seedLegacySpeechStyleInAdkFile(): Promise<void> {
	const adkPath = await browser.execute(
		() => localStorage.getItem("naia-adk-path") ?? "",
	);
	if (!adkPath) throw new Error("ADK pointer unavailable for legacy migration");
	const raw = await tauriInvoke<string>("read_naia_config", { adkPath });
	const config = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
	config.locale = "ko";
	config.speechStyle = "반말";
	await tauriInvoke("write_naia_config", {
		adkPath,
		json: JSON.stringify(config),
	});
	// Leave only the bootstrap pointer. This makes config.json the only legacy
	// input and prevents a stale render cache from making the migration pass.
	await browser.execute(() => localStorage.removeItem("naia-config"));
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
			await openPersonaSettings();
			const speechSelect = await findSpeechStyleSelect();
			expect(speechSelect).toBeUndefined();
		});
	}

	// Test: speechStyle fields VISIBLE for formality locales
	for (const locale of FORMALITY_LOCALES) {
		it(`speechStyle/honorific visible for formality locale '${locale}'`, async () => {
			await setLocale(locale, "casual");
			await openPersonaSettings();
			const speechSelect = await findSpeechStyleSelect();
			expect(speechSelect).toBeDefined();
		});
	}

	// Test: speechStyle stores "casual"/"formal" (not legacy Korean values)
	it("speechStyle stores normalized values", async () => {
		await setLocale("ja", "casual");
		await openPersonaSettings();

		const speechSelect = await findSpeechStyleSelect();
		expect(speechSelect).toBeDefined();
		const val = await speechSelect?.getValue();
		expect(val).toBe("casual");
	});

	// Test: legacy "반말" value is migrated on startup
	it("migrates legacy speechStyle values on startup", async () => {
		await seedLegacySpeechStyleInAdkFile();
		await safeRefresh();
		await browser.pause(2000);

		// After refresh (migration runs on startup), value should be normalized
		const speechStyle = await browser.execute(() => {
			const raw = localStorage.getItem("naia-config");
			const config = raw ? JSON.parse(raw) : {};
			return config.speechStyle;
		});
		expect(speechStyle).toBe("casual");
		const fileSpeechStyle = await browser.waitUntil(
			async () => {
				const adkPath = await browser.execute(
					() => localStorage.getItem("naia-adk-path") ?? "",
				);
				const raw = await tauriInvoke<string>("read_naia_config", { adkPath });
				const config = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
				return config.speechStyle === "casual" ? "casual" : undefined;
			},
			{
				timeout: 10_000,
				timeoutMsg: "ADK config.json did not receive normalized speechStyle",
			},
		);
		expect(fileSpeechStyle).toBe("casual");
	});
});

// ── Onboarding: speechStyle step locale-aware skip ──

describe("54b — Onboarding speechStyle step skip by locale", () => {
	const API_KEY =
		process.env.CAFE_E2E_API_KEY || process.env.GEMINI_API_KEY || "test-e2e";

	/**
	 * 그 locale 로 온보딩을 처음 상태에서 시작한다.
	 *
	 * 캐시만 비우는 것으로는 마법사가 돌아오지 않는다 — 자동 실행의 씨앗이
	 * 새로 고침 직후 `onboardingComplete: true` 를 되돌리고, 워크스페이스
	 * `config.json` 에도 값이 남는다(#564). 헬퍼가 둘 다 비우고, 되돌린 뒤에도
	 * 남길 값으로 locale 만 심는다.
	 */
	async function setupOnboarding(locale: string) {
		await resetOnboarding({ locale });
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
		// 뒤따르는 스펙이 마법사에 막히지 않게 되돌린다. 파일까지 저장해야
		// 새로 고침 뒤에도 남는다.
		await persistConfigPatch({ onboardingComplete: true });
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
