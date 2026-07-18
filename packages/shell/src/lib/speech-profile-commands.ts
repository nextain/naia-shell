import type { SpeechActivityControl } from "./chat-service";
import type { SpeechActivityResume } from "./chat-service";

export type SpeechProfileCommand =
	| { kind: "configure"; profile: "disabled" | "personal_radio_dj" | "exhibition_intro" }
	| { kind: "control"; action: SpeechActivityControl };

export function resolveSpeechProfileSession(
	localSessionId: string | undefined,
	resume: SpeechActivityResume | undefined,
): string | undefined {
	return resume?.sessionId ?? localSessionId;
}

export function shouldBlockDirectLiveForSpeechActivity(
	hasActiveSpeechActivity: boolean,
	isOmni: boolean,
): boolean {
	return hasActiveSpeechActivity && isOmni;
}

export function canSpeakProactiveText(input: {
	currentRequestId: string | null;
	activeActivityId: string | undefined;
	eventActivityId: string;
	ttsEnabled: boolean;
}): boolean {
	return input.currentRequestId == null
		&& input.ttsEnabled
		&& input.activeActivityId === input.eventActivityId;
}

export function shouldQueueBeforeSpeechYield(hasActiveChatRequest: boolean): boolean {
	return hasActiveChatRequest;
}

export function shouldAbortLiveConnectForSpeechActivity(
	hasActiveSpeechActivity: boolean,
): boolean {
	return hasActiveSpeechActivity;
}

export function activateMicUnlessSpeechActivityOwnsVoice(
	mic: { start(): void; stop(): void },
	hasActiveSpeechActivity: boolean,
	connectionCancelled: boolean,
): boolean {
	if (hasActiveSpeechActivity || connectionCancelled) {
		mic.stop();
		return false;
	}
	mic.start();
	return true;
}

/** Narrow, deterministic spoken-command vocabulary; ordinary conversation is not intercepted. */
export function parseSpeechProfileCommand(text: string): SpeechProfileCommand | undefined {
	const phrase = text.toLowerCase().replace(/[\s,.!?]+/g, "");
	const matches = (...commands: string[]) => commands.includes(phrase);
	if (matches("개인라디오시작", "개인라디오시작해", "개인라디오시작해줘", "라디오dj시작", "라디오dj시작해", "라디오시작해", "라디오시작해줘", "radiodjstart")) {
		return { kind: "configure", profile: "personal_radio_dj" };
	}
	if (matches("행사소개시작", "행사소개시작해", "전시소개시작", "전시소개시작해", "도슨트시작", "도슨트시작해", "exhibitionstart")) {
		return { kind: "configure", profile: "exhibition_intro" };
	}
	if (matches("라디오종료", "행사소개종료", "전시소개종료", "발화모드종료")) {
		return { kind: "configure", profile: "disabled" };
	}
	if (matches("음악만", "음악만틀어줘", "음악만재생해줘", "말하지마", "말없이해줘")) return { kind: "control", action: "music_only" };
	if (matches("덜말해", "덜말해줘", "말줄여", "말을줄여줘")) return { kind: "control", action: "talk_less" };
	if (matches("계속이야기해", "계속이야기해줘", "더말해", "더말해줘", "말을더해줘")) return { kind: "control", action: "talk_more" };
	if (matches("분위기바꿔", "분위기바꿔줘", "다른분위기로바꿔줘")) return { kind: "control", action: "change_vibe" };
	if (matches("다음곡", "다음곡틀어줘", "다음노래", "다음노래틀어줘")) return { kind: "control", action: "next" };
	if (matches("조용히", "조용히해줘", "잠깐멈춰")) return { kind: "control", action: "quiet" };
	if (matches("소개계속", "소개계속해줘", "계속소개해줘")) return { kind: "control", action: "resume" };
	if (matches("처음부터소개", "처음부터소개해줘", "다시소개해", "다시소개해줘")) return { kind: "control", action: "restart" };
	if (matches("그만해", "이제그만", "활동종료", "활동종료해줘")) return { kind: "control", action: "stop" };
	return undefined;
}
