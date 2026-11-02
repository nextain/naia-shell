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

	it("(다) en-web.ts has 66 keys matching en test mode values", async () => {
		vi.unstubAllEnvs();
		vi.resetModules();

		const enWebMod = await import("../locales/en-web");
		const enMod = await import("../locales/en");

		const webKeys = Object.keys(enWebMod.default);
		expect(webKeys.length).toBe(66);

		for (const [key, value] of Object.entries(enWebMod.default)) {
			expect(key in enMod.default).toBe(true);
			expect(Reflect.get(enMod.default, key)).toBe(value);
		}
	});
	it("resolves extracted UI messages and interpolated storage values in every locale", async () => {
		const { setLocale, t } = await import("../i18n");
		const { WEB_BACKGROUND_ASSETS } = await import("../web-runtime/web-assets");
		const { formatWebStorageSummaryLine } = await import("../web-runtime/web-storage-persist");
		for (const locale of ["ko", "en", "ja", "zh", "fr", "de", "ru", "es", "ar", "hi", "bn", "pt", "id", "vi"] as const) {
			await setLocale(locale);
			expect(t("webExplorer.title")).toBe(locale === "ko" ? "파일 탐색기" : "File explorer");
			expect(t("webPush.permissionDenied")).toBe(locale === "ko" ? "알림 권한이 허용되지 않았습니다." : "Notification permission was not granted.");
			expect(t("appBar.closeSettings")).toBe(locale === "ko" ? "설정 닫기" : "Close settings");
			expect(WEB_BACKGROUND_ASSETS[0].label).toBe(locale === "ko" ? "새벽 도시" : "Dawn city");
			expect(formatWebStorageSummaryLine({ phase: "persisted", usageBytes: 1024, quotaBytes: 2048 })).toBe(
				locale === "ko" ? "영구 보존 허용됨 · 사용량 1.0 KB / 2.0 KB" : "Persistent storage allowed · Usage 1.0 KB / 2.0 KB",
			);
		}
	});

});
