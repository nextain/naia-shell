export interface AvatarPlaybackOptions {
	muted?: boolean;
	onPlaybackReady?: () => void;
	onPlaybackFailure?: () => void;
}

/**
 * ChatArea가 사용하는 아바타 발화 포트.
 *
 * Shell TTS(선택된 provider)가 오디오 합성·재생의 단일 소유자다. 렌더러는
 * (a) 정확히 일치하는 문구의 저작 클립(자체 녹음 음성 포함) 재생, (b) Shell의
 * 실제 재생 시작/종료에 맞춘 idle/talking 비주얼 전환만 담당한다. 렌더러는
 * 텍스트를 스스로 합성하지 않는다(browser TTS 자동 폴백 없음).
 */
export interface AvatarSpeechRenderer {
	/** Installed bundle identity, used to fence speech during theme changes. */
	readonly modelId?: string;
	/** True if an authored clip (own recorded voice) exists for this exact phrase. */
	hasAuthoredClip(text: string): boolean;
	/** Play that authored clip. Only call after hasAuthoredClip returned true. */
	playAuthoredClip(text: string, opts?: AvatarPlaybackOptions): Promise<void>;
	/** Switch idle/talking visual only, in sync with Shell's real audio playback. */
	setSpeakingVisual(active: boolean): void;
	setVoice(refUrl: string | null | undefined): Promise<boolean>;
	interrupt(): void;
	stop(): void;
}
