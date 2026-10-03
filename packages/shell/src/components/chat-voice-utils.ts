import { getDefaultVoiceForAvatar } from "../lib/avatar-presets";
import type { AppConfig } from "../lib/config";
import { IS_STEAM_BUILD } from "../lib/distribution";
import { t } from "../lib/i18n";
import type {
	VoiceCloseReason,
	VoiceConnectionStatus,
} from "../lib/voice/index";
import { getLocalRefAudioB64 } from "../lib/voice/ref-audio-api";

const DEFAULT_LOCAL_VOICE = "cc0-ko-female-01.wav";

/** Resolve a configured reference URL to a local voice palette id. */
export function naiaLocalVoiceId(voiceRefUrl?: string): string {
	if (!voiceRefUrl) return DEFAULT_LOCAL_VOICE;
	const noQuery = voiceRefUrl.split(/[?#]/)[0];
	const base = noQuery.split(/[/\\]/).pop()?.trim() ?? "";
	return /^[\w.-]+\.wav$/i.test(base) ? base : DEFAULT_LOCAL_VOICE;
}

/** Keep provider-specific voice selection in one place for live and pipeline TTS. */
export function resolveTtsVoiceId(config: AppConfig): string | undefined {
	if (config.ttsProvider === "nextain") {
		return (
			config.ttsVoice ||
			`ko-KR-Chirp3-HD-${config.voice ?? getDefaultVoiceForAvatar(config.vrmModel)}`
		);
	}
	if (config.ttsProvider === "naia-local-voice") {
		if (getLocalRefAudioB64()) return "naia-current";
		return naiaLocalVoiceId(config.voiceRefUrl);
	}
	if (config.ttsProvider === "vllm") return "default";
	return config.ttsVoice;
}

/** Out-of-credits notice; no top-up wording where payment links are hidden (Steam, #727). */
function creditsShortMessage(): string {
	return t(
		IS_STEAM_BUILD
			? "chat.voiceErrorCreditsNoTopup"
			: "chat.voiceErrorCredits",
	);
}

export function voiceFailureMessage(
	status: VoiceConnectionStatus | null,
	error: unknown,
): string {
	if (status?.phase === "sold-out") return t("chat.voiceSoldOut");
	if (status?.phase === "error" && status.reason === "credits")
		return creditsShortMessage();
	if (status?.phase === "error" && status.reason === "auth")
		return t("chat.voiceErrorAuth");
	if (status?.phase === "error" && status.reason === "superseded")
		return t("chat.voiceErrorSuperseded");
	if (status?.phase === "error" && status.reason === "consent")
		return t("chat.voiceErrorConsent");
	if (status?.phase === "error" && status.reason === "timeout")
		return t("chat.voiceErrorTimeout");
	return `${t("chat.voiceError")}: ${error}`;
}

export function voiceCloseMessage(reason: VoiceCloseReason): string | null {
	switch (reason) {
		case "superseded":
			return t("chat.voiceErrorSuperseded");
		case "consent":
			return t("chat.voiceErrorConsent");
		case "credits":
			return creditsShortMessage();
		case "auth":
			return t("chat.voiceErrorAuth");
		default:
			return null;
	}
}

export function phaseToMode(
	status: VoiceConnectionStatus | null,
): "off" | "connecting" | "active" {
	switch (status?.phase) {
		case "connecting":
		case "cold-start":
			return "connecting";
		case "active":
			return "active";
		default:
			return "off";
	}
}
