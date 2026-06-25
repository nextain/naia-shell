/**
 * Edge TTS voice resolution (shell side, #363).
 *
 * Synthesis itself runs in the bgm/media sidecar (node `msedge-tts`): the in-app
 * webview can't perform the MS WebSocket handshake (the browser WebSocket API
 * can't set the headers/Origin MS requires → 400/reject — verified). The
 * browser-direct WS implementation was therefore removed; the shell fetches the
 * sidecar's `/edge-tts` (see synthesize.ts). This module only maps a possibly
 * non-edge voice to a valid edge neural voice for that request.
 */

const EDGE_DEFAULT_VOICES: Record<string, string> = {
	ko: "ko-KR-SunHiNeural",
	en: "en-US-AriaNeural",
	ja: "ja-JP-NanamiNeural",
	zh: "zh-CN-XiaoxiaoNeural",
	fr: "fr-FR-DeniseNeural",
	de: "de-DE-KatjaNeural",
	es: "es-ES-ElviraNeural",
	pt: "pt-BR-FranciscaNeural",
	ru: "ru-RU-SvetlanaNeural",
};

/**
 * Pick a valid edge neural voice: pass through real edge voices (end with
 * "Neural"), otherwise fall back to the language default. Google voices
 * (ko-KR-Neural2-A) end with "-A" / contain "Neural2" → treated as non-edge.
 */
export function resolveEdgeVoice(
	voice: string | undefined,
	lang: string,
): string {
	if (voice && /Neural$/.test(voice)) return voice;
	const short = (lang || "ko").slice(0, 2).toLowerCase();
	return EDGE_DEFAULT_VOICES[short] ?? EDGE_DEFAULT_VOICES.ko;
}
