import type { TtsProviderMeta, TtsVoiceMeta } from "./types";

const providers = new Map<string, TtsProviderMeta>();

export function registerTtsProviderMeta(meta: TtsProviderMeta): void {
	providers.set(meta.id, meta);
}

export function getTtsProviderMeta(id: string): TtsProviderMeta | undefined {
	return providers.get(id);
}

export function listTtsProviderMetas(): TtsProviderMeta[] {
	return Array.from(providers.values());
}

// ── Shared: Google TTS voice fetcher (used by both Naia Cloud and Google direct) ──

async function fetchGoogleVoices(
	apiKey: string,
): Promise<TtsVoiceMeta[] | null> {
	try {
		const locale =
			document.documentElement.lang || navigator.language || "ko-KR";
		const langCode = locale.slice(0, 5);
		const resp = await fetch(
			`https://texttospeech.googleapis.com/v1/voices?languageCode=${langCode}&key=${apiKey}`,
		);
		if (!resp.ok) return null;
		const data = await resp.json();
		const genderLabel = (g?: string) =>
			g === "FEMALE" ? "여성" : g === "MALE" ? "남성" : "";
		const shortName = (name: string) =>
			name
				.replace(new RegExp(`^${langCode}-`), "")
				.replace(/^(Chirp3-HD-|Neural2-)/, "");
		return (data.voices ?? [])
			.filter(
				(v: { name?: string }) =>
					v.name?.includes("Neural2") ||
					v.name?.includes("Chirp") ||
					v.name?.includes("Wavenet"),
			)
			.map((v: { name: string; ssmlGender?: string }) => ({
				id: v.name,
				label: `${shortName(v.name)}${genderLabel(v.ssmlGender) ? ` (${genderLabel(v.ssmlGender)})` : ""}`,
				language: langCode,
				gender:
					v.ssmlGender === "FEMALE"
						? ("female" as const)
						: v.ssmlGender === "MALE"
							? ("male" as const)
							: ("neutral" as const),
			}));
	} catch {
		return null;
	}
}

// ── Shared: Google TTS static voice list (fallback when API unavailable) ──

const GOOGLE_TTS_VOICES: TtsVoiceMeta[] = [
	{ id: "ko-KR-Chirp3-HD-Kore", label: "Kore (여성, 차분)", gender: "female" },
	{ id: "ko-KR-Chirp3-HD-Puck", label: "Puck (남성, 활발)", gender: "male" },
	{ id: "ko-KR-Chirp3-HD-Charon", label: "Charon (남성)", gender: "male" },
	{ id: "ko-KR-Chirp3-HD-Aoede", label: "Aoede (여성)", gender: "female" },
	{ id: "ko-KR-Chirp3-HD-Fenrir", label: "Fenrir (남성)", gender: "male" },
	{ id: "ko-KR-Chirp3-HD-Leda", label: "Leda (여성)", gender: "female" },
	{ id: "ko-KR-Chirp3-HD-Orus", label: "Orus (남성)", gender: "male" },
	{ id: "ko-KR-Chirp3-HD-Zephyr", label: "Zephyr (중성)", gender: "neutral" },
	{ id: "ko-KR-Neural2-A", label: "Neural2-A (여성)", gender: "female" },
	{ id: "ko-KR-Neural2-B", label: "Neural2-B (여성)", gender: "female" },
	{ id: "ko-KR-Neural2-C", label: "Neural2-C (남성)", gender: "male" },
];

// ── Providers (order: free → Naia → paid) ──

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
	description:
		"Free, no API key needed. Good quality voices for 14+ languages.",
	requiresApiKey: false,
	isFree: true,
	pricing: "Free",
});

registerTtsProviderMeta({
	id: "nextain",
	name: "Naia Cloud TTS",
	description:
		"Cloud TTS without API key. Currently Google Chirp 3 HD + Neural2.",
	requiresApiKey: false,
	requiresNaiaKey: true,
	pricing: "Naia credit",
	voices: GOOGLE_TTS_VOICES,
});

registerTtsProviderMeta({
	id: "google",
	name: "Google Cloud TTS",
	description:
		"High-quality Neural2 + Chirp 3 HD voices. Requires Google API key.",
	requiresApiKey: true,
	apiKeyConfigField: "googleApiKey",
	pricing: "$0.016/1K 글자",
	voices: GOOGLE_TTS_VOICES,
	fetchVoices: fetchGoogleVoices,
});

registerTtsProviderMeta({
	id: "openai",
	name: "OpenAI TTS",
	description: "OpenAI text-to-speech. All languages supported.",
	requiresApiKey: true,
	apiKeyConfigField: "openaiTtsApiKey",
	pricing: "$0.015/1K 글자",
	voices: [
		{ id: "alloy", label: "Alloy", gender: "neutral" },
		{ id: "ash", label: "Ash", gender: "male" },
		{ id: "coral", label: "Coral", gender: "female" },
		{ id: "echo", label: "Echo", gender: "male" },
		{ id: "fable", label: "Fable", gender: "male" },
		{ id: "nova", label: "Nova", gender: "female" },
		{ id: "onyx", label: "Onyx", gender: "male" },
		{ id: "sage", label: "Sage", gender: "female" },
		{ id: "shimmer", label: "Shimmer", gender: "female" },
		{ id: "ballad", label: "Ballad (gpt-4o-mini-tts)", gender: "male" },
		{ id: "verse", label: "Verse (gpt-4o-mini-tts)", gender: "male" },
		{ id: "marin", label: "Marin (gpt-4o-mini-tts)", gender: "female" },
		{ id: "cedar", label: "Cedar (gpt-4o-mini-tts)", gender: "male" },
	],
});

registerTtsProviderMeta({
	id: "elevenlabs",
	name: "ElevenLabs",
	description: "Premium AI voices. All languages supported.",
	requiresApiKey: true,
	apiKeyConfigField: "elevenlabsApiKey",
	pricing: "$0.30/1K 글자",
	async fetchVoices(apiKey) {
		try {
			const resp = await fetch(
				"https://api.elevenlabs.io/v1/voices?page_size=50",
				{
					headers: { "xi-api-key": apiKey },
				},
			);
			if (!resp.ok) return null;
			const data = await resp.json();
			return (data.voices ?? []).map(
				(v: {
					voice_id: string;
					name: string;
					labels?: { gender?: string };
				}) => ({
					id: v.voice_id,
					label: v.name,
					gender:
						v.labels?.gender === "female"
							? ("female" as const)
							: v.labels?.gender === "male"
								? ("male" as const)
								: ("neutral" as const),
				}),
			);
		} catch {
			return null;
		}
	},
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
