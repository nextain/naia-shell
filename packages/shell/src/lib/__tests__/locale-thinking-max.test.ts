import { describe, expect, it } from "vitest";
import ar from "../locales/ar";
import bn from "../locales/bn";
import de from "../locales/de";
import en from "../locales/en";
import enWeb from "../locales/en-web";
import es from "../locales/es";
import fr from "../locales/fr";
import hi from "../locales/hi";
import id from "../locales/id";
import ja from "../locales/ja";
import ko from "../locales/ko";
import pt from "../locales/pt";
import ru from "../locales/ru";
import vi from "../locales/vi";
import zh from "../locales/zh";

const FULL_LOCALES = {
	ko,
	en,
	ja,
	zh,
	fr,
	de,
	ru,
	es,
	ar,
	hi,
	bn,
	pt,
	id,
	vi,
} as const;

const EXPECTED_MAX_LABEL: Record<string, string> = {
	ko: "최대",
	en: "Max",
	ja: "最大",
	zh: "最大",
	fr: "Maximum",
	de: "Maximal",
	ru: "Максимум",
	es: "Máximo",
	ar: "الأقصى",
	hi: "अधिकतम",
	bn: "সর্বোচ্চ",
	pt: "Máximo",
	id: "Maksimum",
	vi: "Tối đa",
	"en-web": "Max",
};

describe("thinkingLevelMax locale parity (webgpu max level)", () => {
	it("exposes the same thinking-level key family in all 14 full locale modules", () => {
		const familyOf = (mod: Record<string, string>) =>
			Object.keys(mod)
				.filter((key) => key.startsWith("settings.thinkingLevel"))
				.sort();
		const reference = familyOf(ko as unknown as Record<string, string>);
		expect(reference).toContain("settings.thinkingLevelMax");
		expect(Object.keys(FULL_LOCALES).length).toBe(14);
		for (const [id, mod] of Object.entries(FULL_LOCALES)) {
			expect(familyOf(mod as unknown as Record<string, string>), id).toEqual(
				reference,
			);
		}
	});

	it("carries the approved max label in all 15 locale modules", () => {
		const all = { ...FULL_LOCALES, "en-web": enWeb } as Record<string, Record<string, string>>;
		expect(Object.keys(all).length).toBe(15);
		for (const [id, mod] of Object.entries(all)) {
			expect(mod["settings.thinkingLevelMax"], id).toBe(EXPECTED_MAX_LABEL[id]);
		}
	});
});
