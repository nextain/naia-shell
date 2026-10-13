import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	APP_LOCALES,
	UI_LABELS,
	appText,
	contentLocale,
	copy,
	normalizeAppLocale,
} from "../i18n";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("Cafe Lua Tarot localization", () => {
	it("provides the same non-empty screen labels in all 14 Shell languages", () => {
		const keys = Object.keys(copy("en")).sort();
		for (const locale of APP_LOCALES) {
			const translated = copy(locale) as Record<string, string>;
			expect(Object.keys(translated).sort()).toEqual(keys);
			for (const value of Object.values(translated))
				expect(value.trim().length).toBeGreaterThan(0);
		}
	});

	it("localizes compact deck headings and the BGM license note in all locales", () => {
		expect(Object.keys(UI_LABELS).sort()).toEqual([...APP_LOCALES].sort());
		for (const labels of Object.values(UI_LABELS)) {
			for (const value of Object.values(labels))
				expect(value.trim().length).toBeGreaterThan(0);
		}
	});

	it("uses Korean or authored English content and discloses other-language fallback", () => {
		expect(contentLocale("ko")).toBe("ko");
		expect(contentLocale("fr")).toBe("en");
		expect(appText("fr", "englishOnly")).toMatch(/anglais/);
		expect(normalizeAppLocale("vi")).toBe("vi");
		expect(normalizeAppLocale("xx")).toBe("en");
	});

	it("declares names, descriptions, and help for every Shell locale", () => {
		const manifest = JSON.parse(
			readFileSync(resolve(appRoot, "package-public/app.json"), "utf8"),
		) as Record<string, Record<string, string>>;
		for (const map of [manifest.names, manifest.descriptions, manifest.help]) {
			expect(Object.keys(map).sort()).toEqual([...APP_LOCALES].sort());
		}
	});
});
