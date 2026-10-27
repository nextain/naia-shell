import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { APP_LOCALES, contentLocale, copy, normalizeAppLocale } from "../i18n";
import { UI_KEYS, UI_TRANSLATIONS } from "../ui";
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
describe("Cafe Lua Tarot localization", () => {
	it("provides all screen and product copy in all 14 languages", () => {
		const manifest = JSON.parse(
			readFileSync(resolve(appRoot, "package-public/app.json"), "utf8"),
		);
		for (const locale of APP_LOCALES) {
			expect(Object.keys(copy(locale)).sort()).toEqual(
				Object.keys(copy("en")).sort(),
			);
			expect(UI_TRANSLATIONS[locale]).toHaveLength(UI_KEYS.length);
			for (const value of [
				...Object.values(copy(locale)),
				...UI_TRANSLATIONS[locale],
				manifest.names[locale],
				manifest.descriptions[locale],
				manifest.help[locale],
			])
				expect(value.trim()).not.toBe("");
		}
		for (const map of [manifest.names, manifest.descriptions, manifest.help])
			expect(Object.keys(map).sort()).toEqual([...APP_LOCALES].sort());
		expect(contentLocale("ko")).toBe("ko");
		expect(contentLocale("fr")).toBe("en");
		expect(normalizeAppLocale("ko-KR")).toBe("ko");
		expect(normalizeAppLocale("xx")).toBe("en");
	});
	it("keeps technical product terms out of every localized screen, description and help", () => {
		const manifest = JSON.parse(
			readFileSync(resolve(appRoot, "package-public/app.json"), "utf8"),
		);
		const forbidden =
			/\b(?:model|models|local|llm|modelo|modell|modèle|lokal)\b|모델|로컬|モデル|ローカル|模型|本地|मॉडल|स्थानीय|মডেল|স্থানীয়|модел|локальн|mô hình|cục bộ|نموذج|محلي/iu;
		for (const locale of APP_LOCALES)
			for (const value of [
				manifest.descriptions[locale],
				manifest.help[locale],
				...Object.values(copy(locale)),
				...UI_TRANSLATIONS[locale],
			])
				expect(value).not.toMatch(forbidden);
	});
});
