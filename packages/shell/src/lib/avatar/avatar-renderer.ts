import type {
	AvatarSpeechTiming,
	SpeechPlan,
} from "./nva-speech/speech-timing";

export interface AvatarPlaybackOptions {
	muted?: boolean;
	onPlaybackReady?: () => void;
	onPlaybackFailure?: () => void;
}

/**
 * ChatArea가 사용하는 아바타 발화 포트.
 *
 * Shell TTS(선택된 provider)가 오디오 합성·재생의 단일 소유자다. 렌더러는
 * (a) 정확히 일치하는 문구의 저작 클립(자체 녹음 음성 포함) 재생, (b) 발화 상태
 * 표시, (c) 정본 SpeechPlayer 로 aligned/browser-timed 계획 재생만 담당한다.
 * 렌더러는 텍스트를 스스로 합성하지 않는다(browser TTS 자동 폴백 없음).
 */
export interface AvatarSpeechRenderer {
	/** True if an authored clip (own recorded voice) exists for this exact phrase. */
	hasAuthoredClip(text: string): boolean;
	/** Play that authored clip. Only call after hasAuthoredClip returned true. */
	playAuthoredClip(text: string, opts?: AvatarPlaybackOptions): Promise<void>;
	/** Speaking state only; false returns to idle. Never loops a talking clip. */
	setSpeakingVisual(active: boolean): void;
	/** Canonical player: aligned plan + audio clock, or browser-timed plan + utterance clock. */
	playSpeechTiming?(timing: AvatarSpeechTiming): Promise<boolean>;
	/** Revise a running browser-timed plan (speechSynthesis boundary). */
	updateSpeechPlan?(plan: SpeechPlan): boolean;
	setVoice(refUrl: string | null | undefined): Promise<boolean>;
	interrupt(): void;
	stop(): void;
}
