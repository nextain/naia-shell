import { describe, expect, it } from "vitest";
import {
	AZURE_DRAGON_HD_COST_PER_M_CHARS_USD,
	AZURE_NEURAL_COST_PER_M_CHARS_USD,
	AZURE_SPEECH_VOICE_PRESETS,
	DEFAULT_AZURE_SPEECH_VOICE_KO,
	buildAzureSpeechSsml,
	detectTextLocaleHint,
	escapeSsmlXml,
	estimateAzureSpeechCostUsd,
	getAzureSpeechVoicePreset,
	isDragonHdVoice,
	resolveAzureSpeechVoice,
} from "../azure-speech-voices";

describe("azure-speech-voices", () => {
	it("provides multilingual Neural, Multilingual, and DragonHD voice presets", () => {
		expect(AZURE_SPEECH_VOICE_PRESETS.length).toBeGreaterThanOrEqual(15);

		const sunhi = getAzureSpeechVoicePreset("ko-KR-SunHiNeural");
		expect(sunhi).toBeDefined();
		expect(sunhi?.supportsViseme).toBe(true);
		expect(sunhi?.tier).toBe("neural");

		const sunhiHd = getAzureSpeechVoicePreset(
			"ko-KR-SunHi:DragonHDLatestNeural",
		);
		expect(sunhiHd).toBeDefined();
		expect(sunhiHd?.tier).toBe("dragon-hd");
		expect(sunhiHd?.supportsViseme).toBe(false);
		expect(isDragonHdVoice(sunhiHd?.id ?? "")).toBe(true);

		const hyunsuMulti = getAzureSpeechVoicePreset(
			"ko-KR-HyunsuMultilingualNeural",
		);
		expect(hyunsuMulti?.tier).toBe("multilingual");
		expect(hyunsuMulti?.supportsViseme).toBe(true);
	});

	it("resolves aliases, locales, script hints, and custom Neural voice IDs", () => {
		expect(resolveAzureSpeechVoice().voiceId).toBe(
			DEFAULT_AZURE_SPEECH_VOICE_KO,
		);
		expect(resolveAzureSpeechVoice("naia-default").voiceId).toBe(
			"ko-KR-SunHiNeural",
		);
		expect(resolveAzureSpeechVoice("sunhi-hd").voiceId).toBe(
			"ko-KR-SunHi:DragonHDLatestNeural",
		);
		expect(resolveAzureSpeechVoice("nova").voiceId).toBe("ko-KR-SunHiNeural");
		expect(resolveAzureSpeechVoice("onyx").voiceId).toBe("ko-KR-InJoonNeural");
		expect(resolveAzureSpeechVoice("", "Hello world!").voiceId).toBe(
			"en-US-AriaNeural",
		);
		expect(resolveAzureSpeechVoice("", "こんにちは、世界").voiceId).toBe(
			"ja-JP-NanamiNeural",
		);
		expect(resolveAzureSpeechVoice("", "你好世界").voiceId).toBe(
			"zh-CN-XiaoxiaoNeural",
		);

		const custom = resolveAzureSpeechVoice("en-GB-RyanNeural");
		expect(custom.voiceId).toBe("en-GB-RyanNeural");
		expect(custom.language).toBe("en-GB");
		expect(custom.supportsViseme).toBe(true);
	});

	it("detects dominant script locale hints accurately", () => {
		expect(detectTextLocaleHint("안녕하세요 나이아입니다")).toBe("ko-KR");
		expect(detectTextLocaleHint("ひらがなとカタカナ")).toBe("ja-JP");
		expect(detectTextLocaleHint("今天天气很好")).toBe("zh-CN");
		expect(detectTextLocaleHint("Welcome to Naia OS")).toBe("en-US");
	});

	it("estimates standard Neural vs DragonHD character pricing accurately", () => {
		expect(estimateAzureSpeechCostUsd(0, "ko-KR-SunHiNeural")).toBe(0);
		expect(
			estimateAzureSpeechCostUsd(1_000_000, "ko-KR-SunHiNeural"),
		).toBeCloseTo(AZURE_NEURAL_COST_PER_M_CHARS_USD, 6);
		expect(
			estimateAzureSpeechCostUsd(1_000_000, "ko-KR-SunHi:DragonHDLatestNeural"),
		).toBeCloseTo(AZURE_DRAGON_HD_COST_PER_M_CHARS_USD, 6);
	});

	it("escapes XML special characters, strips illegal control chars, and preserves emoji", () => {
		const dirty = `안녕 <script>alert("x" & 'y')</script>\x00\x07 😊`;
		const escaped = escapeSsmlXml(dirty);
		expect(escaped).toBe(
			"안녕 &lt;script&gt;alert(&quot;x&quot; &amp; &apos;y&apos;)&lt;/script&gt; 😊",
		);
		expect(escaped).not.toContain("\x00");
		expect(escaped).not.toContain("\x07");
	});

	it("builds spec-compliant SSML with mstts:viseme for Neural and omits viseme tag for DragonHD", () => {
		const neural = buildAzureSpeechSsml({
			text: "반갑습니다 & 환영합니다!",
			voice: "ko-KR-SunHiNeural",
			rate: 1.15,
			pitch: "+3%",
			style: "cheerful",
			styleDegree: 1.25,
		});
		expect(neural.visemeRequested).toBe(true);
		expect(neural.ssml).toContain(
			'xmlns:mstts="https://www.w3.org/2001/mstts"',
		);
		expect(neural.ssml).toContain('<voice name="ko-KR-SunHiNeural">');
		expect(neural.ssml).toContain('<mstts:viseme type="Redlips_front"/>');
		expect(neural.ssml).toContain(
			'<mstts:express-as style="cheerful" styledegree="1.25">',
		);
		expect(neural.ssml).toContain('<prosody rate="+15%" pitch="+3%">');
		expect(neural.ssml).toContain("반갑습니다 &amp; 환영합니다!");

		const dragonHd = buildAzureSpeechSsml({
			text: "초자연 HD 음성입니다.",
			voice: "ko-KR-SunHi:DragonHDLatestNeural",
			style: "cheerful",
		});
		expect(dragonHd.visemeRequested).toBe(false);
		expect(dragonHd.ssml).not.toContain("mstts:viseme");
		expect(dragonHd.ssml).not.toContain("mstts:express-as");
	});
});
