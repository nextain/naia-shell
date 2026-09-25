import type { TtsProviderId } from "../config";
/**
 * FR-VOICE.16 Phase 2b (#420): the per-sentence TTS orchestration, extracted
 * from ChatArea. The pipeline owns the request lifecycle (active-request set,
 * per-request AbortControllers, the one-time local-voice-unavailable notice,
 * the recent-utterance ring used by the STT self-echo filter) and the routing
 * policy:
 *
 *  - Shell TTS is the single owner of audio synthesis and playback. An NVA
 *    authored clip is the one exception: it carries its own recorded voice for
 *    an exact known phrase, so playing it replaces synthesis instead of racing
 *    it. The renderer only ever reacts to real playback via setSpeakingVisual.
 *  - Client-side providers speak through the browser's speechSynthesis.
 *  - Every other provider is synthesized in the Shell (the new-core agent has
 *    no TTS); the 6GB local path is admitted through LocalVoiceScheduler.
 *  - Failure policy: local engines never masquerade as the free browser voice
 *    (one clear notice, then silence); cloud failures fall back to browser TTS
 *    so the voice is never silently dropped.
 *
 * ChatArea remains a wiring adapter: it supplies environment (reveal/mask,
 * output stage, stores, renderer, queue, config, i18n, IPC) through
 * SentenceTtsPipelineDeps and calls the public interface only.
 */
import { Logger } from "../logger";
import {
	PcmStreamSource,
	decodeWavPcm16,
	wavDurationSeconds,
} from "../voice/audio-queue";
import { estimateTtsCost } from "./cost";
import { getTtsProviderMeta } from "./index";
import type { LocalVoiceScheduler } from "./local-voice-scheduler";
import { synthesizeTts } from "./synthesize";
import { ttsTextFilter } from "./text-filter";
import {
	type VoicePlaybackMode,
	VoicePlaybackRtfTracker,
	decidePlaybackMethod,
	estimateSentenceDurationSeconds,
} from "./voice-playback-mode";
import { isVoiceWarmingHold } from "./warming-hold";

const TAG = "tts-pipeline";

export interface PipelineVoiceConfig {
	voice?: string;
	ttsProvider?: string;
	/** #512 — 로컬 엔진 활성 여부(정체성 데스싱크 관측용). */
	localVoiceEnabled?: boolean;
	/** @deprecated #603 */
	ttsApiKey?: string;
	/** nextain provider: gateway credit key. */
	naiaKey?: string;
	/** nextain provider: gateway base URL. */
	gatewayUrl?: string;
	/** vllm provider: local OpenAI-compatible host. */
	vllmHost?: string;
	/** naia-local-voice provider: local cascade / VoxCPM2 voice host. */
	vllmTtsHost?: string;
	/** FR-VOICE.22 (2026-09-25): 음성 재생 방식. 생략하면 "auto". */
	voicePlaybackMode?: VoicePlaybackMode;
}

/** The renderer surface the pipeline is allowed to touch (FR-VOICE.16). */
export interface CascadeSpeechRenderer {
	hasAuthoredClip(text: string): boolean;
	playAuthoredClip(
		text: string,
		callbacks: { onPlaybackReady: () => void; onPlaybackFailure: () => void },
	): Promise<unknown>;
	setSpeakingVisual(on: boolean): void;
}

export interface OrderedTtsQueue {
	reserveSeq(): number;
	/** Streaming PCM slot (local voice hosts that stream `audio/pcm`). */
	enqueueOrderedStream?(
		seq: number,
		stream: PcmStreamSource,
		callbacks: {
			onPlaybackStart: () => void;
			onPlaybackUnavailable: () => void;
		},
	): void;
	enqueueOrdered(
		seq: number,
		audioBase64: string,
		callbacks: {
			onPlaybackStart: () => void;
			onPlaybackUnavailable: () => void;
		},
	): void;
	skipOrdered(seq: number): void;
}

export interface TtsCostEntry {
	inputTokens: number;
	outputTokens: number;
	cost: number;
	provider: string;
	model: string;
}

export interface TtsSynthesisResult {
	reqId: string;
	seq: number;
	text: string;
	provider: string;
	voice?: string;
	audioBase64: string;
	elapsedMs: number;
	audioDurationSeconds: number | null;
	localReferenceAudioPresent: boolean;
	vllmTtsHost?: string;
}

export interface SentenceTtsPipelineDeps {
	generateRequestId(): string;
	/** Mask/reveal reservation for this sentence (UI-owned ordering). */
	reserveReveal(sentence: string): () => void;
	getRenderer(): CascadeSpeechRenderer | null | undefined;
	/** Cascade playback bookkeeping for authored clips (generation-guarded). */
	beginCascadeJob(): () => void;
	setOutputStage(stage: "tts" | "render"): void;
	getQueue(): OrderedTtsQueue | null;
	getVoiceConfig(): PipelineVoiceConfig | null;
	getScheduler(): LocalVoiceScheduler | null;
	/** Current mask-generation — guards late browser speech callbacks. */
	getBrowserTurnGeneration(): number;
	/** Composite speaking state (playing ref + React state + avatar store). */
	setSpeaking(on: boolean): void;
	getLocalRefAudioB64(): string | null;
	addCostEntry(entry: TtsCostEntry): void;
	/** Receives an accepted, non-stale synthesis result for local diagnostics. */
	onSynthesisResult?(result: TtsSynthesisResult): void | Promise<void>;
	/**
	 * Surface the one-time local-voice-unavailable notice (runtime status +
	 * localized message). The once-per-session guard lives in the pipeline.
	 */
	notifyLocalVoiceUnavailable(): Promise<void>;
}

export interface SentenceTtsPipeline {
	sendSentence(sentence: string): void;
	/** Barge-in/new turn: drop pending requests and cancel in-flight synthesis. */
	interrupt(): void;
	/** Session teardown: interrupt + clear the recent-utterance ring. */
	dispose(): void;
	/** Re-arm the one-time local-voice-unavailable notice (new session/turn). */
	rearmLocalVoiceNotice(): void;
	hasActiveRequests(): boolean;
	/** Recent spoken sentences (ring of 6) for the STT self-echo filter. */
	recentTexts(): readonly string[];
}

export function createSentenceTtsPipeline(
	deps: SentenceTtsPipelineDeps,
): SentenceTtsPipeline {
	const activeRequests = new Set<string>();
	const abortControllers = new Map<string, AbortController>();
	const recentTexts: string[] = [];
	let localVoiceUnavailableNoticed = false;
	// FR-VOICE.22 — "auto" 재생 방식의 RTF 폴백: 이 파이프라인 인스턴스가
	// 살아있는 동안(세션) 마지막으로 측정한 로컬 음성 RTF 를 기억해, 다음
	// 문장의 스트리밍/문장 판정에 다시 쓴다. 첫 문장은 항상 모름(문장 방식)
	// 으로 시작한다 — 바지인으로는 리셋하지 않는다(엔진 warm 상태는 턴과
	// 무관하다, LocalVoiceScheduler 의 admission tail 과 같은 이유).
	const voicePlaybackRtfTracker = new VoicePlaybackRtfTracker();

	function sendSentence(sentence: string): void {
		// Preserve the original Markdown in chat, but send only natural speech
		// text to the selected voice engine.
		const voiceCfg = deps.getVoiceConfig();
		const clean = ttsTextFilter.filter(
			sentence,
			voiceCfg?.voice ||
				(typeof document !== "undefined"
					? document.documentElement.lang
					: undefined),
		);
		if (!clean) return;
		const revealText = deps.reserveReveal(sentence);

		const cascadeAvatar = deps.getRenderer();

		// 자기발화 텍스트 필터용 — 이 턴에 말한 문장을 기록 (최근 6문장 링버퍼).
		recentTexts.push(clean);
		if (recentTexts.length > 6) recentTexts.shift();

		// Authored NVA clip: the one path that replaces synthesis (module doc).
		if (cascadeAvatar?.hasAuthoredClip(clean)) {
			Logger.info(TAG, "Playing NVA authored clip", {
				sentence: clean.slice(0, 50),
			});
			deps.setOutputStage("render");
			const endCascadeJob = deps.beginCascadeJob();
			void cascadeAvatar
				.playAuthoredClip(clean, {
					onPlaybackReady: revealText,
					onPlaybackFailure: revealText,
				})
				.finally(endCascadeJob);
			return;
		}

		const reqId = deps.generateRequestId();
		// Reserve sequence number BEFORE async request to guarantee order.
		const seq = deps.getQueue()?.reserveSeq() ?? 0;
		// (2026-08-18) The 2-sentence local-voice cap is GONE. It shielded the
		// mixed-precision TRT engine whose runaway generation made one sentence
		// take 30-100s; the pure-FP32 engine measures 2-6s/sentence (0/36
		// runaway), so full replies stream fine and the cap only truncated
		// speech ("첫 문장만 나와" — user report).
		activeRequests.add(reqId);
		const ttsProviderForCost = voiceCfg?.ttsProvider ?? "edge";
		const localVoiceScheduler = deps.getScheduler();
		const localVoiceGeneration = localVoiceScheduler?.generation ?? 0;
		if (ttsProviderForCost === "naia-local-voice") {
			localVoiceScheduler?.noteSentence(seq);
		}
		const ttsVoiceForCost = voiceCfg?.voice;
		// Local GPU synthesis can take ~20-60s per sentence — playback-synced
		// reveal would hide the ALREADY-STREAMED reply text that whole time and
		// the conversation looks frozen ("생각중"). Cap the hold: after 5s the
		// text shows even though the audio is still being synthesized; playback
		// still starts whenever the WAV lands (reveal is idempotent).
		if (ttsProviderForCost === "naia-local-voice") {
			// #520 — 다만 엔진이 아직 기동 중이면 그 지연은 합성이 느린 것이
			// 아니라 재생을 일부러 멈춘 것이다(#519). 이때 시한이 그대로
			// 지나면 음성이 한 번도 나오지 않은 채 텍스트가 먼저 나온다.
			// 기동이 끝날 때까지 시한을 다시 건다. 재시도 예산이 정해져 있어
			// 무기한 미뤄지지 않는다.
			const capReveal = () => {
				if (isVoiceWarmingHold()) {
					setTimeout(capReveal, 1_000);
					return;
				}
				revealText();
			};
			setTimeout(capReveal, 5_000);
		}
		// #512 — 음성 정체성 데스싱크 관측: 로컬 엔진이 켜져 있는데 다른 provider 로 발화하면
		//        사용자가 고른 목소리가 조용히 바뀐다(실사용 2026-08-29: Host 자동기동 중
		//        browser/SunHiNeural 발화). 발생 순간을 남겨 원인 경로를 특정한다.
		if (
			voiceCfg?.localVoiceEnabled &&
			ttsProviderForCost !== "naia-local-voice"
		) {
			Logger.warn(
				TAG,
				"voice identity mismatch — local engine enabled but speaking via other provider",
				{
					provider: ttsProviderForCost,
					voice: ttsVoiceForCost,
				},
			);
		}
		Logger.info(TAG, "Sending TTS request", {
			reqId,
			seq,
			sentence: clean.slice(0, 50),
			provider: ttsProviderForCost,
			voice: ttsVoiceForCost,
		});

		// Speak via the browser's built-in speechSynthesis (free, client-side).
		// Manages the avatar speaking state + clears the request on end/error.
		const speakViaBrowser = (): void => {
			if (typeof window !== "undefined" && "speechSynthesis" in window) {
				const browserGeneration = deps.getBrowserTurnGeneration();
				const isCurrentBrowserTurn = () =>
					browserGeneration === deps.getBrowserTurnGeneration();
				const utter = new SpeechSynthesisUtterance(clean);
				utter.lang =
					voiceCfg?.voice || document.documentElement.lang || "ko-KR";
				utter.onstart = () => {
					if (!isCurrentBrowserTurn()) return;
					revealText();
					deps.setSpeaking(true);
					cascadeAvatar?.setSpeakingVisual(true);
				};
				utter.onend = () => {
					if (!isCurrentBrowserTurn()) return;
					// Settle hooks behind setSpeaking(false) consult hasActiveRequests —
					// this request must not count itself as still active (#423).
					activeRequests.delete(reqId);
					deps.setSpeaking(false);
					cascadeAvatar?.setSpeakingVisual(false);
				};
				// onerror too, else a failure after onstart leaves the avatar stuck
				// in the speaking state (#363 review).
				utter.onerror = () => {
					if (!isCurrentBrowserTurn()) return;
					activeRequests.delete(reqId);
					revealText();
					deps.setSpeaking(false);
					cascadeAvatar?.setSpeakingVisual(false);
				};
				window.speechSynthesis.speak(utter);
			} else {
				Logger.warn(TAG, "Browser TTS not available");
				activeRequests.delete(reqId);
				revealText();
			}
		};

		// Browser provider → client-side speechSynthesis (skip shell synthesis).
		const ttsMeta = getTtsProviderMeta(ttsProviderForCost);
		if (ttsMeta?.isClientSide) {
			speakViaBrowser();
			return;
		}

		// Shell-direct synthesis (#363): the new-core agent has no TTS, so every
		// non-browser provider is synthesized here (gateway / direct API / edge
		// WS). The AbortController lets interrupt/cleanup cancel the in-flight
		// fetch/WS (and stop paid TTS).
		const abort = new AbortController();
		abortControllers.set(reqId, abort);
		let synthesisStartedAt = 0;
		// 2026-09-11 streaming contract: for the local voice host, reserve the
		// ordered slot as a PCM stream and feed chunks as they arrive, so
		// playback starts on the first chunk instead of after the whole WAV.
		//
		// FR-VOICE.22 (2026-09-25): whether that slot is even opened as a stream
		// depends on the "음성 재생 방식" decision — "sentence" (forced, or
		// auto with an unknown/slow RTF) never streams; it always waits for the
		// whole WAV (the existing no-stream-support fallback below already
		// handles that: pcmStream stays null → the WAV branch runs). "streaming"
		// always streams. "auto" streams when the last measured RTF says the
		// engine keeps up (pre-roll for the borderline band); the very first
		// local-voice sentence of the session has no RTF yet and safely falls
		// back to sentence.
		//
		// gap-review-2 (2026-09-25): the decision itself is made INSIDE
		// `synthesize()`, not here at `sendSentence` call time. A whole AI turn
		// dispatches all of its sentences in a burst (as the reply streams in),
		// well before the FIRST one's synthesis even starts — reading
		// `voicePlaybackRtfTracker.get()` here would see "unknown" for every
		// sentence in the turn and never stream until the NEXT turn. Deciding
		// inside `synthesize()` means the decision runs exactly when this
		// sentence's OWN synthesis is about to start, which for local voice is
		// exactly when the half-duplex scheduler admits it — i.e. after the
		// previous sentence's synthesis has already settled and recorded its
		// RTF (`LocalVoiceScheduler.schedule` only invokes the job once the
		// previous one's tail resolves).
		const streamQueue = deps.getQueue();
		let playbackDecision: ReturnType<typeof decidePlaybackMethod> | null = null;
		let pcmStream: PcmStreamSource | null = null;
		const synthesize = () => {
			if (!activeRequests.has(reqId)) {
				return Promise.reject(
					new DOMException("TTS request superseded", "AbortError"),
				);
			}
			deps.setOutputStage("tts");
			synthesisStartedAt = performance.now();
			const estimatedDurationSeconds = estimateSentenceDurationSeconds(clean);
			// gap-review-6 (2026-09-25): note the CURRENT synthesis target
			// (the local voice host address) before reading the tracked RTF.
			// A host swap mid-session (config now points sendSentence's own
			// requests at a different, unmeasured vllmTtsHost) must not let
			// this sentence read the OLD host's RTF as if it still applied —
			// that stale, likely-fast reading would decide "streaming, zero
			// pre-roll" against a host that has never actually been timed.
			voicePlaybackRtfTracker.noteTarget(voiceCfg?.vllmTtsHost ?? null);
			playbackDecision =
				ttsProviderForCost === "naia-local-voice"
					? decidePlaybackMethod({
							mode: voiceCfg?.voicePlaybackMode ?? "auto",
							// 2026-09-25 기준 어떤 로컬 음성 런타임도 /health 에 실시간 신호를
							// 내보내지 않는다(voice-playback-mode.ts 상단 참고) — 신호가
							// 생기면 여기서 readRuntimeRealtimeHint(...) 로 채운다. 지금은
							// RTF 실측 폴백만 쓴다.
							explicitRealtime: null,
							rtf: voicePlaybackRtfTracker.get(),
							estimatedDurationSeconds,
						})
					: null;
			const stream =
				ttsProviderForCost === "naia-local-voice" &&
				streamQueue?.enqueueOrderedStream &&
				playbackDecision?.method === "streaming"
					? new PcmStreamSource(24000)
					: null;
			if (stream) {
				stream.startDelaySeconds = playbackDecision?.preRollSeconds ?? 0;
				stream.expectedDurationSeconds = estimatedDurationSeconds;
			}
			pcmStream = stream;
			if (stream && streamQueue?.enqueueOrderedStream) {
				streamQueue.enqueueOrderedStream(seq, stream, {
					onPlaybackStart: revealText,
					onPlaybackUnavailable: revealText,
				});
			}
			if (playbackDecision) {
				Logger.info(TAG, "Voice playback mode decision", {
					seq,
					mode: voiceCfg?.voicePlaybackMode ?? "auto",
					method: playbackDecision.method,
					reason: playbackDecision.reason,
					preRollSeconds: Number(playbackDecision.preRollSeconds.toFixed(2)),
				});
			}
			return synthesizeTts({
				text: clean,
				voice: voiceCfg?.voice,
				provider: ttsProviderForCost as TtsProviderId,
				naiaKey: voiceCfg?.naiaKey,
				gatewayUrl: voiceCfg?.gatewayUrl,
				vllmHost: voiceCfg?.vllmHost,
				vllmTtsHost: voiceCfg?.vllmTtsHost,
				localRefAudioBase64:
					ttsProviderForCost === "naia-local-voice"
						? (deps.getLocalRefAudioB64() ?? undefined)
						: undefined,
				signal: abort.signal,
				streamPcm: !!stream,
				onPcmChunk: stream
					? (chunk, rate) => {
							if (!activeRequests.has(reqId)) return;
							stream.sampleRate = rate;
							const firstChunk = stream.chunks.length === 0;
							stream.push(chunk);
							if (firstChunk) {
								const elapsed =
									Math.max(0, performance.now() - synthesisStartedAt) / 1000;
								Logger.info(TAG, "Local voice first chunk", {
									seq,
									firstChunkMs: Math.round(elapsed * 1000),
									rate,
								});
								localVoiceScheduler?.onFirstChunk(
									localVoiceGeneration,
									elapsed,
								);
							}
						}
					: undefined,
			});
		};
		// The Windows 8GB path shares one GPU between VoxCPM2 and Ditto. Keep it
		// strictly half-duplex; cloud TTS providers retain parallel synthesis.
		let synthesis: ReturnType<typeof synthesize>;
		if (ttsProviderForCost === "naia-local-voice" && localVoiceScheduler) {
			synthesis = localVoiceScheduler.schedule(() => synthesize());
		} else {
			synthesis = synthesize();
		}
		synthesis
			.then(async ({ audioBase64, costUsd }) => {
				// Drop stale audio AND skip billing for a superseded/aborted turn:
				// interrupt() cleared activeRequests and reset the AudioQueue
				// sequence, so a late response must NOT enqueue (would replay as
				// the new turn's first audio) nor record cost.
				if (!activeRequests.has(reqId)) return;
				const elapsedMs = Math.max(
					0,
					Math.round(performance.now() - synthesisStartedAt),
				);
				const audioDurationSeconds = wavDurationSeconds(audioBase64);
				void Promise.resolve()
					.then(() =>
						deps.onSynthesisResult?.({
							reqId,
							seq,
							text: clean,
							provider: ttsProviderForCost,
							voice: ttsVoiceForCost,
							audioBase64,
							elapsedMs,
							audioDurationSeconds,
							localReferenceAudioPresent:
								ttsProviderForCost === "naia-local-voice" &&
								Boolean(deps.getLocalRefAudioB64()),
							vllmTtsHost: voiceCfg?.vllmTtsHost,
						}),
					)
					.catch((error) =>
						Logger.warn(TAG, "TTS diagnostic capture failed", {
							reqId,
							error: String(error),
						}),
					);

				// FR-VOICE.19 (#519): measure every local sentence, not only the
				// first — a later RTF<1 is the "engine warmed" release signal.
				// FR-VOICE.22 (2026-09-25): the same measurement also feeds
				// voicePlaybackRtfTracker, which the NEXT sentence's "auto"
				// playback-mode decision reads (independent of whether the
				// warming-hold scheduler is present).
				if (ttsProviderForCost === "naia-local-voice") {
					const duration = wavDurationSeconds(audioBase64);
					const elapsed =
						Math.max(0, performance.now() - synthesisStartedAt) / 1000;
					voicePlaybackRtfTracker.record(
						elapsed,
						duration ?? null,
						voiceCfg?.vllmTtsHost ?? null,
					);
					const verdict = localVoiceScheduler?.onSentenceResult(
						localVoiceGeneration,
						{ elapsedSeconds: elapsed, durationSeconds: duration ?? null },
					);
					if (verdict) {
						Logger.info(TAG, "Local voice RTF verdict", {
							seq,
							rtf: Number(verdict.rtf.toFixed(2)),
							duration: verdict.durationSeconds
								? Number(verdict.durationSeconds.toFixed(2))
								: null,
							warmingHold: verdict.warmingHold,
						});
					}
				}
				activeRequests.delete(reqId);
				const openedStream = pcmStream;
				if (openedStream) {
					if (openedStream.chunks.length === 0) {
						// Host answered a whole WAV (no streaming support). Feed it into
						// the SAME already-reserved stream slot — gap-review-2
						// (2026-09-25): re-enqueueing at this seq through
						// AudioQueue.enqueueOrdered is silently dropped. The moment
						// this seq's turn came, the stream slot was flushed straight
						// into the play queue regardless of whether any chunk had
						// arrived yet, so the ordered flush cursor has already moved
						// past `seq` by the time this WAV lands; a fresh
						// enqueueOrdered(seq, ...) call sits in pendingOrdered forever
						// (Audio 0회) instead of playing. Decoding the WAV into the
						// stream's own PCM buffer plays through the slot regardless of
						// where the cursor is — the stream is already wired into the
						// ordered queue either way (subscribed if its turn already
						// came, still pending otherwise).
						const decoded = decodeWavPcm16(audioBase64);
						if (decoded) {
							openedStream.sampleRate = decoded.sampleRate;
							// gap-review-4 (2026-09-25): pushFinal(), not
							// push()+end() — this single chunk IS the whole
							// sentence, already finished. push() invokes
							// AudioQueue's onChunk synchronously and only
							// afterward would end() run, so the live
							// `stream.ended` read inside that callback would
							// still see `false` and apply the full pre-roll
							// wait to audio that has nothing left to wait
							// for. pushFinal() sets `ended` first.
							openedStream.pushFinal(decoded.samples);
							// The eager "streaming" decision logged above never fired
							// for this sentence — log what actually played.
							Logger.info(TAG, "Voice playback mode decision", {
								seq,
								mode: voiceCfg?.voicePlaybackMode ?? "auto",
								method: "sentence",
								reason: "host-returned-whole-wav",
								preRollSeconds: 0,
							});
						} else {
							openedStream.fail();
							Logger.warn(
								TAG,
								"Local voice host returned an undecodable WAV for a reserved stream slot — sentence dropped",
								{ seq },
							);
						}
					} else {
						openedStream.end();
					}
				} else {
					deps.getQueue()?.enqueueOrdered(seq, audioBase64, {
						onPlaybackStart: revealText,
						onPlaybackUnavailable: revealText,
					});
				}
				if (ttsProviderForCost === "naia-local-voice") {
					localVoiceScheduler?.onEnqueued(localVoiceGeneration, seq);
				}
				// Track TTS cost: server cost for Naia Cloud, estimate for others.
				// Gateway already charges API × 1.1. Do not markup server costUsd again.
				const NAIA_TTS_MARKUP = 1.1;
				const isNaiaTts = ttsProviderForCost === "nextain";
				const ttsCost =
					costUsd != null
						? costUsd
						: estimateTtsCost(
								ttsProviderForCost,
								clean.length,
								ttsVoiceForCost,
							) * (isNaiaTts ? NAIA_TTS_MARKUP : 1);
				if (ttsCost > 0) {
					// addCostEntry keeps TTS in a separate CostDashboard row.
					deps.addCostEntry({
						inputTokens: 0,
						outputTokens: 0,
						cost: ttsCost,
						provider: ttsProviderForCost,
						model: isNaiaTts
							? "tts:nextain (+10%)"
							: `tts:${ttsProviderForCost}`,
					});
				}
			})
			.catch(async (err) => {
				// Superseded / aborted turn (interrupt cleared the set) — don't
				// fall back or bill; the queue was already reset.
				if (!activeRequests.has(reqId)) return;
				// Release the reserved ordered slot so later sentences don't stall
				// behind this seq (enqueueOrdered waits for contiguous numbers).
				if (pcmStream) pcmStream.fail();
				else deps.getQueue()?.skipOrdered(seq);
				if (ttsProviderForCost === "naia-local-voice") {
					localVoiceScheduler?.releaseOnFailure(localVoiceGeneration);
				}
				// LOCAL voice engines (naia-local-voice / vllm): the user chose a
				// local engine explicitly. Do NOT substitute the browser's free
				// TTS — surface one clear notice and stay silent (FR-VOICE.2).
				// Cloud providers keep the free fallback below.
				const isLocalVoiceProvider =
					ttsProviderForCost === "naia-local-voice" ||
					ttsProviderForCost === "vllm";
				if (isLocalVoiceProvider) {
					// Delete before reveal: the reveal wrapper settles the held
					// expression only when no request is still counted active (#423).
					activeRequests.delete(reqId);
					revealText();
					Logger.warn(
						TAG,
						"Local voice engine unavailable — no free fallback",
						{
							reqId,
							provider: ttsProviderForCost,
							error: String(err),
						},
					);
					if (!localVoiceUnavailableNoticed) {
						localVoiceUnavailableNoticed = true;
						await deps.notifyLocalVoiceUnavailable();
					}
					return;
				}
				// Cloud synthesis failed (missing key/login, network, quota). Fall
				// back to the browser's built-in TTS so the voice is never
				// silently dropped — better a basic voice than nothing.
				Logger.warn(TAG, "TTS synthesis failed — browser TTS fallback", {
					reqId,
					provider: ttsProviderForCost,
					error: String(err),
				});
				speakViaBrowser();
			})
			.finally(() => {
				abortControllers.delete(reqId);
			});
	}

	function clearRequests(): void {
		activeRequests.clear();
		for (const ac of abortControllers.values()) ac.abort();
		abortControllers.clear();
	}

	function interrupt(): void {
		clearRequests();
		// The pipeline created any live browser utterance (speakViaBrowser), so
		// cancelling it on barge-in is its lifecycle too — AudioQueue.clear()
		// cannot stop client-side speech (FR-VOICE.16 Phase 3).
		if (typeof window !== "undefined" && "speechSynthesis" in window) {
			try {
				window.speechSynthesis.cancel();
			} catch {
				// best-effort — some webviews throw if no utterance is active
			}
		}
	}

	return {
		sendSentence,
		interrupt,
		dispose(): void {
			// Session teardown drops the pipeline's own requests but deliberately
			// does NOT cancel browser speech: only a barge-in (interrupt) cuts a
			// live utterance. Voice-pipeline cleanup must not silence an ongoing
			// chat-mode browser reply — original ChatArea behavior preserved.
			clearRequests();
			recentTexts.length = 0;
			// gap-review-6 (2026-09-25): a fresh session must not carry over a
			// stale RTF measurement — this pipeline instance's `record()` calls
			// are the only writer, so nothing else resets it.
			voicePlaybackRtfTracker.reset();
		},
		rearmLocalVoiceNotice(): void {
			localVoiceUnavailableNoticed = false;
		},
		hasActiveRequests(): boolean {
			return activeRequests.size > 0;
		},
		recentTexts(): readonly string[] {
			return recentTexts;
		},
	};
}
