import { beforeEach, describe, expect, it } from "vitest";
import { type Locale, setLocale, t } from "../i18n";

/**
 * 값이 끼어드는 문구가 로케일을 지나는지 본다.
 *
 * 왜 필요한가: t() 가 파라미터를 받지 못하던 동안, 값이 낀 문구는 전부
 * 코드에서 이어 붙여졌다. 그 문구들은 로케일 표에 들어갈 수 없었고,
 * 결과적으로 화면에 한국어가 박힌 채 남았다. 자리표시자 치환이 깨지면
 * 그 문구들이 조용히 `{name}` 을 그대로 보여 준다 — 사용자에게는 버그로
 * 보이지만 어떤 단정도 걸리지 않는다.
 */
describe("t() 자리표시자", () => {
	beforeEach(async () => {
		await setLocale("ko");
	});

	it("자리표시자를 값으로 채운다", async () => {
		await setLocale("ko");
		const filled = t("voice.ref.recording", { seconds: 7 });
		expect(filled).toContain("7");
		expect(filled).not.toContain("{seconds}");
	});

	it("로케일을 바꾸면 같은 값이 다른 문장에 들어간다", async () => {
		await setLocale("ko");
		const ko = t("voice.ref.recording", { seconds: 7 });
		await setLocale("en");
		const en = t("voice.ref.recording", { seconds: 7 });
		expect(ko).not.toBe(en);
		expect(en).toContain("7");
		expect(en).not.toContain("{seconds}");
	});

	it("값을 주지 않으면 자리표시자를 그대로 둔다 — 조용히 빈칸으로 만들지 않는다", () => {
		expect(t("voice.ref.recording")).toContain("{seconds}");
	});

	it("모르는 이름은 건드리지 않는다", () => {
		expect(t("voice.ref.recording", { other: 1 })).toContain("{seconds}");
	});
});


it("keeps the new UI parameters aligned in every supported locale", async () => {
	const locales: Locale[] = ["ar", "bn", "de", "en", "es", "fr", "hi", "id", "ja", "ko", "pt", "ru", "vi", "zh"];
	for (const locale of locales) {
		await setLocale(locale);
		for (const [key, parameter] of [["workspace.imageOpenFailed", "image"], ["workspace.externalLink", "label"]] as const) {
			const raw = t(key);
			expect([...raw.matchAll(/\{(\w+)\}/g)].map((m) => m[1]), `${locale} ${key}`).toEqual([parameter]);
			expect(t(key, { [parameter]: "TEST_VALUE" })).toContain("TEST_VALUE");
		}
	}
});
