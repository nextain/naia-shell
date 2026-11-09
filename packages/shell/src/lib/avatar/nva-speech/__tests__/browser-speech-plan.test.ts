// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { parseNvaManifest } from "../../../nva";
import { PrebakedAvatarRenderer } from "../../prebaked-renderer";
import {
	buildBrowserTimedSpeechPlan,
	createAudioTimedBrowserSpeechPlan,
	createGatewayBrowserTimedSpeech,
	fetchGatewaySpeechPlanUnits,
	fetchSpeechPlanUnits,
	replaceLatinWithHangulForSpeechUnits,
	speechUnitsLanguage,
	synthesizePronunciationWordsFromText,
	updateBrowserTimedSpeechPlanForWordBoundary,
} from "../browser-speech-plan";
import { validateSpeechPlan } from "../vendor/speech-plan.js";

describe("browser-speech-plan (Studio pronunciation lip-sync port)", () => {
	it("builds a browser-timed speech plan from phoneme units and re-anchors on word boundary", () => {
		const words = [
			{
				word: "안녕하세요",
				char_start: 0,
				char_end: 5,
				units: ["vowel-open", "alveolar", "palatal", "vowel-mid", "glottal", "vowel-open", "alveolar", "vowel-mid", "palatal", "vowel-round"],
			},
			{
				word: "지나입니다",
				char_start: 6,
				char_end: 11,
				units: ["postalveolar", "vowel-spread", "alveolar", "vowel-open", "vowel-spread", "closed", "alveolar", "vowel-spread", "alveolar", "vowel-open"],
			},
		];

		const initial = buildBrowserTimedSpeechPlan({
			text: "안녕하세요 지나입니다",
			locale: "ko-KR",
			words,
			durationSeconds: 2.1,
		});
		expect(initial.quality_mode).toBe("browser-timed");
		expect(initial.audio.duration_us).toBe(2_100_000);
		expect(initial.events.some((s) => s.unit === "postalveolar")).toBe(true);
		expect(validateSpeechPlan(initial)).toEqual({ ok: true, errors: [] });

		const updated = updateBrowserTimedSpeechPlanForWordBoundary({
			text: "안녕하세요 지나입니다",
			locale: "ko-KR",
			words,
			charIndex: 6,
			elapsedSeconds: 0.92,
		});
		expect(updated).not.toBeNull();
		expect(validateSpeechPlan(updated!)).toEqual({ ok: true, errors: [] });
	});

	it("fetches pronunciation units from gateway /v1/studio/speech-plan/units with Bearer key", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			headers: new Headers({ "Content-Type": "application/json" }),
			json: async () => ({
				words: [
					{
						word: "넥스테인",
						char_start: 0,
						char_end: 4,
						units: ["alveolar", "vowel-mid", "velar", "alveolar", "vowel-mid", "vowel-spread", "alveolar"],
					},
					{
						word: "안내",
						char_start: 5,
						char_end: 7,
						units: ["vowel-open", "alveolar", "alveolar", "vowel-mid"],
					},
				],
			}),
		} as unknown as Response);

		const words = await fetchGatewaySpeechPlanUnits("넥스테인 안내", "ko-KR", {
			getConfig: () => ({ gatewayUrl: "https://api.nextain.io", locale: "ko-KR" }),
			getNaiaKey: async () => "test-synth-key",
			fetchImpl: fetchMock,
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe("https://api.nextain.io/v1/studio/speech-plan/units");
		expect((init?.headers as Record<string, string>)["X-AnyLLM-Key"]).toBe(
			"Bearer test-synth-key",
		);
		expect(JSON.parse(init?.body as string)).toEqual({
			text: "넥스테인 안내",
			language: "ko",
		});
		expect(words).toHaveLength(2);
		expect(words[0]?.word).toBe("넥스테인");

		expect(speechUnitsLanguage("ko-KR")).toBe("ko");
		expect(speechUnitsLanguage("en-US")).toBe("en");
		expect(speechUnitsLanguage("cmn-Hans")).toBe("zh");
		expect(speechUnitsLanguage("")).toBe("ko");

		vi.stubGlobal("fetch", fetchMock);
		await fetchSpeechPlanUnits("넥스테인 안내", "ko-KR");
		const [localUrl, localInit] = fetchMock.mock.calls[1]!;
		expect(localUrl).toBe("/api/studio/speech-plan/units");
		expect(JSON.parse(localInit?.body as string)).toEqual({
			text: "넥스테인 안내",
			language: "ko",
		});
		vi.unstubAllGlobals();
	});

	it("transliterates Latin letters to Hangul readings in speech-plan/units requests only when language is 'ko'", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			headers: new Headers({ "Content-Type": "application/json" }),
			json: async () => ({
				words: [
					{
						word: "에이아이",
						char_start: 0,
						char_end: 4,
						units: ["vowel-mid", "vowel-spread", "vowel-open", "vowel-spread"],
					},
				],
			}),
		} as unknown as Response);

		const deps = {
			getConfig: () => ({ gatewayUrl: "https://api.nextain.io", locale: "ko-KR" }),
			getNaiaKey: async () => "test-synth-key",
			fetchImpl: fetchMock,
		};

		// 1. Mixed Korean-English ("AI를") & full sentence in ko
		await fetchGatewaySpeechPlanUnits(
			"…엔터테인먼트와 AI를 결합해 2026년 XYZ 시연을 합니다!",
			"ko-KR",
			deps,
		);
		const gatewayBodyKo = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
		expect(gatewayBodyKo.language).toBe("ko");
		expect(gatewayBodyKo.text).toContain("에이아이를");
		expect(gatewayBodyKo.text).toContain("엑스와이지");
		expect(gatewayBodyKo.text).toBe(
			"…엔터테인먼트와 에이아이를 결합해 2026년 엑스와이지 시연을 합니다!",
		);
		expect(gatewayBodyKo.text).not.toMatch(/[A-Za-z]/);

		// 2. Table words (case-insensitive) + non-table chunk ("XYZ") + mixed ("AI를") via fetchSpeechPlanUnits
		vi.stubGlobal("fetch", fetchMock);
		await fetchSpeechPlanUnits(
			"Nextain Naia AI IR GPU WebGPU Web PC PDF TTS API App XYZ AI를",
			"ko",
		);
		const localBodyKo = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string);
		expect(localBodyKo).toEqual({
			text: "넥스테인 나이아 에이아이 아이알 지피유 웹지피유 웹 피씨 피디에프 티티에스 에이피아이 앱 엑스와이지 에이아이를",
			language: "ko",
		});
		expect(localBodyKo.text).not.toMatch(/[A-Za-z]/);

		// 3. When language is "en", Latin text is preserved as-is
		await fetchGatewaySpeechPlanUnits("Nextain AI and XYZ", "en-US", deps);
		const gatewayBodyEn = JSON.parse(fetchMock.mock.calls[2]?.[1]?.body as string);
		expect(gatewayBodyEn).toEqual({
			text: "Nextain AI and XYZ",
			language: "en",
		});

		await fetchSpeechPlanUnits("Nextain AI and XYZ", "en");
		const localBodyEn = JSON.parse(fetchMock.mock.calls[3]?.[1]?.body as string);
		expect(localBodyEn).toEqual({
			text: "Nextain AI and XYZ",
			language: "en",
		});
		vi.unstubAllGlobals();

		// 4. Direct helper checks: case-insensitivity and all A-Z letter names
		expect(
			replaceLatinWithHangulForSpeechUnits(
				"nextain naia ai ir gpu webgpu web pc pdf tts api app",
			),
		).toBe(
			"넥스테인 나이아 에이아이 아이알 지피유 웹지피유 웹 피씨 피디에프 티티에스 에이피아이 앱",
		);
		expect(replaceLatinWithHangulForSpeechUnits("XYZ")).toBe("엑스와이지");
		expect(replaceLatinWithHangulForSpeechUnits("AI를")).toBe("에이아이를");
		const allLetters = replaceLatinWithHangulForSpeechUnits(
			"ABCDEFGHIJKLMNOPQRSTUVWXYZ",
		);
		expect(allLetters).toBe(
			"에이비씨디이에프지에이치아이제이케이엘엠엔오피큐알에스티유브이더블유엑스와이지",
		);
		expect(allLetters).not.toMatch(/[A-Za-z]/);
	});

	it("decomposes Korean and English text into canonical pronunciation units when gateway is offline", async () => {
		const words = synthesizePronunciationWordsFromText("안녕하세요 Jina 안내해 드릴게요");
		expect(words.map((w) => w.word)).toEqual([
			"안녕하세요",
			"Jina",
			"안내해",
			"드릴게요",
		]);
		// "안녕하세요" starts with ㅏ (vowel-open) + ㄴ (alveolar)
		expect(words[0]?.units[0]).toBe("vowel-open");
		expect(words[0]?.units).toContain("alveolar");
		// "Jina" starts with j (postalveolar) + i (vowel-spread)
		expect(words[1]?.units[0]).toBe("postalveolar");
		expect(words[1]?.units[1]).toBe("vowel-spread");

		const plan = await createAudioTimedBrowserSpeechPlan(
			{
				text: "안녕하세요 지나입니다 반갑습니다",
				locale: "ko-KR",
				durationSeconds: 2.4,
			},
			{
				getConfig: () => ({ gatewayUrl: "https://api.nextain.io", locale: "ko-KR" }),
				getNaiaKey: async () => "test-synth-key",
				fetchImpl: vi.fn().mockRejectedValue(new Error("offline")),
			},
		);
		expect(plan).not.toBeNull();
		expect(plan?.quality_mode).toBe("browser-timed");
		expect(validateSpeechPlan(plan!)).toEqual({ ok: true, errors: [] });

		const controller = await createGatewayBrowserTimedSpeech(
			"안녕하세요 지나입니다",
			"ko-KR",
			{
				getConfig: () => ({ gatewayUrl: "https://api.nextain.io", locale: "ko-KR" }),
				getNaiaKey: async () => "",
			},
		);
		expect(controller).not.toBeNull();
		controller?.markStarted();
		const boundaryPlan = controller?.updateForBoundary(6, 0.85);
		expect(boundaryPlan).not.toBeNull();
		expect(validateSpeechPlan(boundaryPlan!)).toEqual({ ok: true, errors: [] });
	});

	it("defers speech/atlas.bin fetch until after initial greeting via warmSpeechAssets()", async () => {
		vi.stubGlobal(
			"createImageBitmap",
			vi.fn(async () => ({ width: 512, height: 512, close: vi.fn() })),
		);
		vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
		vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
			clearRect: vi.fn(),
			drawImage: vi.fn(),
			save: vi.fn(),
			restore: vi.fn(),
		} as never);
		const manifest = parseNvaManifest(
			JSON.stringify({
				nva_version: "0.2",
				canvas: { width: 720, height: 1280, fps: 24 },
				animations: {
					idle: { clip: "clips/idle.webm", loop: true, can_talk: false },
					talking: { clip: "clips/talking-ko.webm", loop: true, can_talk: true },
					greeting: {
						clip: "clips/greeting.webm",
						loop: false,
						can_talk: false,
						label: "손 흔들며 인사",
					},
				},
				speech_motion: {
					version: "1",
					representation: "whole-head-layer",
					region: [104, 0, 512, 512],
					inventory_version: "1.0.0",
					inventory: [
						"sil",
						"closed",
						"labiodental",
						"dental",
						"alveolar",
						"postalveolar",
						"palatal",
						"velar",
						"glottal",
						"vowel-open",
						"vowel-mid",
						"vowel-spread",
						"vowel-round",
					],
					neutral_head: "speech/neutral-head.png",
					atlas: "speech/atlas.bin",
					atlas_index: "speech/atlas-index.json",
					validation_report: "speech/validation-report.json",
					quality_report: "speech/quality-report.json",
					provenance: "speech/generation-result.json",
				},
			}),
		);

		const loadAssetBlob = vi.fn(async (path: string) => new Blob([path]));
		const renderer = new PrebakedAvatarRenderer({
			manifest,
			locale: "ko-KR",
			resolveAssetUrl: async (path) => `blob:${path}`,
			loadAssetBlob,
		});
		const video = document.createElement("video");
		document.body.appendChild(video);
		renderer.start(video, document.createElement("canvas"));
		await Promise.resolve();
		await Promise.resolve();

		// 1. On initial mount & greeting clip playback, speech/atlas.bin is NOT fetched
		await renderer.playGreetingAction();
		expect(loadAssetBlob).not.toHaveBeenCalled();

		// 2. After greeting, warmSpeechAssets() fetches speech/atlas.bin in background
		await renderer.warmSpeechAssets();
		const loadedPaths = loadAssetBlob.mock.calls.map(([p]) => p);
		expect(loadedPaths).toContain("speech/atlas.bin");
		expect(loadedPaths).toContain("speech/atlas-index.json");
		expect(loadedPaths).toContain("speech/neutral-head.png");

		// 3. Subsequent warmSpeechAssets() reuses the cached promise without re-fetching
		const countAfterWarm = loadAssetBlob.mock.calls.length;
		await renderer.warmSpeechAssets();
		expect(loadAssetBlob).toHaveBeenCalledTimes(countAfterWarm);

		renderer.stop();
		video.remove();
	});
});
