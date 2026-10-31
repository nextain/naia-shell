import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("i18n web strings", () => {
	beforeEach(() => {
		vi.unstubAllEnvs();
		vi.resetModules();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.resetModules();
	});

	it("(가) translates web keys in test mode and has same key count as ko.ts", async () => {
		const { setLocale, t } = await import("../i18n");
		await setLocale("en");
		expect(t("webWorkspace.startDefault")).toBe("Start with default workspace");
		expect(t("webModel.retry")).toBe("Retry");

		const enMod = await import("../locales/en");
		const koMod = await import("../locales/ko");
		const ollamaEn = await import("../locales/ollama-en");
		expect(Object.keys({ ...enMod.default, ...ollamaEn.default }).sort()).toEqual(
			Object.keys(koMod.default).sort(),
		);
	});

	it("(나) omits web keys in production mode and falls back to key string", async () => {
		vi.stubEnv("MODE", "production");
		vi.resetModules();

		const enMod = await import("../locales/en");
		const { t } = await import("../i18n");

		expect("webWorkspace.startDefault" in enMod.default).toBe(false);
		expect(t("webWorkspace.startDefault")).toBe("webWorkspace.startDefault");
		expect(t("chat.outputStage.thinking")).toBe("Thinking…");
	});

	it("(다) en-web.ts has 20 keys matching en test mode values", async () => {
		vi.unstubAllEnvs();
		vi.resetModules();

		const enWebMod = await import("../locales/en-web");
		const enMod = await import("../locales/en");

		const webKeys = Object.keys(enWebMod.default);
		expect(webKeys.length).toBe(20);

		for (const [key, value] of Object.entries(enWebMod.default)) {
			expect(key in enMod.default).toBe(true);
			expect(Reflect.get(enMod.default, key)).toBe(value);
		}
	});
});
