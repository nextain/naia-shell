import type { TtsProviderMeta } from "./types";

const providers = new Map<string, TtsProviderMeta>();

export function registerTtsProviderMeta(meta: TtsProviderMeta): void {
	providers.set(meta.id, meta);
}

export function getTtsProviderMeta(id: string): TtsProviderMeta | undefined {
	return providers.get(id);
}

export function listTtsProviderMetas(): TtsProviderMeta[] {
	const providerOrder = ["edge", "naia-local-voice", "nextain"];
	return Array.from(providers.values()).sort((left, right) => {
		const leftPriority = providerOrder.indexOf(left.id);
		const rightPriority = providerOrder.indexOf(right.id);
		if (leftPriority >= 0 || rightPriority >= 0) {
			if (leftPriority < 0) return 1;
			if (rightPriority < 0) return -1;
			return leftPriority - rightPriority;
		}
		return 0;
	});
}

// ── Providers (order: free → local → Naia managed) ──

registerTtsProviderMeta({
	id: "browser",
	name: "Browser TTS",
	description:
		"Browser built-in speech synthesis. No API key, no cost. Voice quality varies by OS.",
	requiresApiKey: false,
	isFree: true,
	isClientSide: true,
	pricing: "Free",
});

registerTtsProviderMeta({
	id: "edge",
	name: "Microsoft Edge TTS",
	// Real MS neural voices, keyless — synthesized in the bgm/media sidecar
	// (node msedge-tts), since the in-app webview can't do the MS WS handshake
	// (can't set the required headers/Origin). Shell → sidecar /edge-tts (#363).
	description:
		"Free, no API key. Neural voices for 14+ languages (via local sidecar).",
	requiresApiKey: false,
	isFree: true,
	pricing: "Free",
	voices: [
		{ id: "ko-KR-SunHiNeural", label: "SunHi (여성)", gender: "female" },
		{ id: "ko-KR-InJoonNeural", label: "InJoon (남성)", gender: "male" },
		{
			id: "ko-KR-HyunsuMultilingualNeural",
			label: "Hyunsu (남성, 다국어)",
			gender: "male",
		},
		{ id: "en-US-AriaNeural", label: "Aria (영어, 여성)", gender: "female" },
		{ id: "en-US-GuyNeural", label: "Guy (영어, 남성)", gender: "male" },
		{
			id: "ja-JP-NanamiNeural",
			label: "Nanami (일본어, 여성)",
			gender: "female",
		},
		{
			id: "zh-CN-XiaoxiaoNeural",
			label: "Xiaoxiao (중국어, 여성)",
			gender: "female",
		},
	],
});

registerTtsProviderMeta({
	id: "nextain",
	name: "Naia Cloud TTS",
	description:
		"Azure Neural HD (SunHi / Hyunsu). Credits = API cost × 1.1 via the gateway.",
	requiresApiKey: false,
	requiresNaiaKey: true,
	pricing: "Naia credit (API × 1.1)",
	voices: [
		{
			id: "ko-KR-SunHi:DragonHDLatestNeural",
			label: "SunHi HD (여성)",
			gender: "female",
		},
		{
			id: "ko-KR-Hyunsu:DragonHDLatestNeural",
			label: "Hyunsu HD (남성)",
			gender: "male",
		},
	],
});

// ── Local vLLM TTS (OpenAI-compatible /v1/audio/speech) ──

registerTtsProviderMeta({
	id: "vllm",
	name: "vLLM TTS",
	description:
		"Local vLLM TTS server — supports Kokoro and other TTS models via /v1/audio/speech.",
	requiresApiKey: false,
	isFree: true,
	pricing: "Free (local)",
	isLocal: true,
});

// ── Naia Local Voice (VoxCPM2 GPU TTS) ──

registerTtsProviderMeta({
	id: "naia-local-voice",
	name: "Naia Host Voice (GPU)",
	description:
		"GPU voice synthesis on a host you choose — this PC's engine or a remote Voice Host URL. Supports voice cloning (음성 참조 / 내 목소리 만들기).",
	requiresApiKey: false,
	requiresNaiaKey: true,
	isFree: true,
	pricing: "Free (local GPU)",
	isLocal: true,
	// 고정 voice 목록 없음(의도) — 로컬 음성은 **ref-audio 클로닝**(음성 참조 / 내 목소리
	// 만들기 = RefAudioSection)으로 음색을 정한다. 그래서 클라우드 TTS용 일반 voice 드롭다운
	// ("기본음색 + 미리듣기")을 띄우지 않는다. ttsVoice 는 SettingsTab 이 "default" 로 설정
	// (synthVllm 이 voice 미지정 시 "default" 사용 — VoxCPM2 가 ref audio 로 음색 결정).
});
