// ── new-naia 이식 코어 결선 (UC2 V2 음성 graft seam) ──
// onboarding-core.ts(UC12)·chat-service(UC1) 와 동일 패턴: isNewCore() 일 때 voice 출력(PCM 재생)을
// 새 core V2 ExpressionPort 경유. 미설정(기본)=기존 createAudioPlayer 직접 경로 보존(비파괴).
//
// ⚠️ 범위 = **표현(음성 재생) 포트만**. mic 캡처(SensoryPort.startMicCapture)는 셸 createMicStream 의
//    create-then-start + try/catch 에러 시맨틱과 V2 포트의 create+start+swallow 가 불일치(behavior 변경 위험),
//    STT 는 스트리밍(tauri-plugin-stt) vs V2 one-shot transcribe 불일치, WS provider 는 external →
//    포트 설계 결정/루크-머신 잔여. 본 seam = ExpressionPort.play/clearAudio 를 live 셸에 연결(non-dormant).
import {
	makeV2Expression,
	type V2LiveDeps,
} from "@nextain/naia-os-core/shell-compat";
import {
	type AudioPlayer,
	type AudioPlayerOptions,
	createAudioPlayer,
} from "./audio-player";

// makeV2Expression(d: V2LiveDeps) 는 createMicStream 을 참조하지 않음(표현 전용) — 타입 충족용 미사용 stub.
const UNUSED_MIC: V2LiveDeps["createMicStream"] = async () => {
	throw new Error("voice-core: createMicStream 미사용(표현 전용 seam)");
};

/**
 * AudioPlayer-shape 래퍼 — enqueue/clear 를 새 core V2 ExpressionPort(play/clearAudio) 경유로 라우팅.
 * destroy/isPlaying 은 포트 추상화 밖(lifecycle/state) → 내부 player 직결. onPlaybackStart/End 등 opts 보존.
 * 셸 ChatArea 의 createAudioPlayer 호출 지점을 isNewCore 시 이걸로 교체 = drop-in(호출처 무변경).
 * @param _createPlayer 테스트 주입용(기본=실 createAudioPlayer).
 */
export function makeCoreAudioPlayer(
	opts: AudioPlayerOptions = {},
	_createPlayer: (o: AudioPlayerOptions) => AudioPlayer = createAudioPlayer,
): AudioPlayer {
	const player = _createPlayer(opts);
	const expr = makeV2Expression({
		createAudioPlayer: () => player, // 이미 생성된 실 player 주입(lazy ensure 가 이걸 반환)
		createMicStream: UNUSED_MIC,
	});
	return {
		enqueue: (pcm: string) => expr.play(pcm), // → ExpressionPort.play
		clear: () => expr.clearAudio(), // → ExpressionPort.clearAudio (barge-in)
		destroy: () => player.destroy(),
		get isPlaying() {
			return player.isPlaying;
		},
	};
}
