import { S } from "../helpers/selectors.js";
import { ensureAppReady, openSettingsSection } from "../helpers/settings.js";

/**
 * 77 — STT Provider Switching E2E
 *
 * 음성 구역의 STT 공급자 선택(`data-testid="stt-provider-section"`)을 잰다.
 *
 * #603 이 타사 클라우드 음성(google·elevenlabs)과 나이아 클라우드 STT 를 흔적
 * 없이 걷었다. 예전 이 스펙은 그 셋이 목록에 있고 API 키 칸이 뜨기를 기다려,
 * 공급자가 사라진 뒤로는 통과할 수 없었다. 지금 남은 것은 브라우저 내장
 * (web-speech), 오프라인 엔진(vosk·whisper), 로컬 vLLM ASR 이다.
 */
const EXPECTED_STT_PROVIDERS = ["web-speech", "vosk", "whisper", "vllm"];
const REMOVED_STT_PROVIDERS = ["nextain", "google", "elevenlabs"];
const STT_SELECT = '[data-testid="stt-provider-section"] select';

async function sttOptions(): Promise<string[]> {
	return browser.execute((sel: string) => {
		const select = document.querySelector(sel) as HTMLSelectElement | null;
		if (!select) return [];
		return Array.from(select.options)
			.map((o) => o.value)
			.filter((v) => v !== "");
	}, STT_SELECT);
}

async function chooseStt(value: string): Promise<void> {
	await browser.execute(
		(sel: string, next: string) => {
			const select = document.querySelector(sel) as HTMLSelectElement | null;
			if (!select) throw new Error("STT 공급자 선택이 없다");
			const setter = Object.getOwnPropertyDescriptor(
				HTMLSelectElement.prototype,
				"value",
			)?.set;
			setter?.call(select, next);
			select.dispatchEvent(new Event("change", { bubbles: true }));
		},
		STT_SELECT,
		value,
	);
	await browser.pause(500);
}

describe("77 — STT provider switching", () => {
	before(async () => {
		await ensureAppReady();
		// 설정은 활성 구역만 렌더한다 — 음성 구역을 열어야 STT 선택이 DOM 에 선다.
		await openSettingsSection("voice");
		await (await $(STT_SELECT)).waitForExist({ timeout: 10_000 });
	});

	it("STT 공급자 목록이 남은 공급자만 보여 준다", async () => {
		const ids = await sttOptions();
		for (const id of EXPECTED_STT_PROVIDERS) expect(ids).toContain(id);
		for (const id of REMOVED_STT_PROVIDERS) expect(ids).not.toContain(id);
	});

	it("무료 브라우저 내장이 오프라인 엔진보다 앞에 온다", async () => {
		const ids = await sttOptions();
		expect(ids.indexOf("web-speech")).toBeLessThan(ids.indexOf("vosk"));
		expect(ids.indexOf("vosk")).toBeLessThan(ids.indexOf("vllm"));
	});

	it("vosk 를 고르면 모델 관리 버튼이 뜬다", async () => {
		await chooseStt("vosk");
		const hasModelBtn = await browser.execute(
			(sel: string) =>
				!!document
					.querySelector(sel)
					?.closest(".settings-tab")
					?.querySelector(".onboarding-next-btn"),
			STT_SELECT,
		);
		expect(hasModelBtn).toBe(true);
	});

	it("vllm 을 고르면 ASR 호스트 칸이 뜬다", async () => {
		await chooseStt("vllm");
		const hasHost = await browser.execute(() =>
			Array.from(document.querySelectorAll(".settings-field label")).some(
				(label) => label.textContent?.trim() === "vLLM STT Host",
			),
		);
		expect(hasHost).toBe(true);
	});

	it("없음으로 되돌리면 딸린 칸이 사라진다", async () => {
		await chooseStt("");
		const extras = await browser.execute(() => ({
			host: Array.from(document.querySelectorAll(".settings-field label")).some(
				(label) => label.textContent?.trim() === "vLLM STT Host",
			),
			apiKey: !!document.querySelector("#stt-api-key"),
		}));
		expect(extras).toEqual({ host: false, apiKey: false });
	});

	it("should navigate back to chat tab", async () => {
		await browser.execute((sel: string) => {
			const el = document.querySelector(sel) as HTMLElement | null;
			if (el) el.click();
		}, S.chatTab);
		const chatInput = await $(S.chatInput);
		await chatInput.waitForDisplayed({ timeout: 5_000 });
	});
});
