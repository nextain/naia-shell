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
 *  - Mouth motion (naia-shell#760, SoT 8): the canonical NVA player only.
 *    Shell TTS sentences get an "aligned" plan driven by that sentence's
 *    audio clock; browser speech gets a "browser-timed" plan driven by time
 *    since onstart and revised on boundary events. Plan sources are ports
 *    (speech-timing.ts); with no source the avatar stays idle.
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
import { createGatewayAlignedPlanSource } from "../avatar/nva-speech/gateway-aligned-plan";
import {
	type AlignedSpeechPlanSource,
	type AudioPlaybackClock,
	type AvatarSpeechTiming,
	type BrowserSpeechPlanSource,
	type PreparedSpeech,
	type SpeechPlan,
	getAlignedSpeechPlanSource,
	getBrowserSpeechPlanSource,
	isAlignedPlan,
	isBrowserTimedPlan,
} from "../avatar/nva-speech/speech-timing";
import type { TtsProviderId } from "../config";
import { Logger } from "../logger";
import { PcmStreamSource } from "../voice/audio-queue";
import { wavDurationSeconds } from "../voice/audio-queue";
import { estimateTtsCost } from "./cost";
import { getTtsProviderMeta } from "./index";
import type { LocalVoiceScheduler } from "./local-voice-scheduler";
import { synthesizeTts } from "./synthesize";
import { ttsTextFilter } from "./text-filter";
import { isVoiceWarmingHold } from "./warming-hold";

const TAG = "tts-pipeline";

/**
 * Longest a sentence's sound waits for its aligned plan to load before it
 * plays anyway (idle mouth, never a late or guessed start). Later
 * sentences usually have their plan ready while the previous one plays.
 */
export const ALIGNED_PLAN_WAIT_MS = 3000;

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
}

/** The renderer surface the pipeline is allowed to touch (FR-VOICE.16). */
export interface CascadeSpeechRenderer {
	hasAuthoredClip(text: string): boolean;
	playAuthoredClip(
		text: string,
		callbacks: { onPlaybackReady: () => void; onPlaybackFailure: () => void },
	): Promise<unknown>;
	setSpeakingVisual(on: boolean): void;
	/** Canonical NVA player entry (optional: non-NVA renderers omit it). */
	playSpeechTiming?(timing: AvatarSpeechTiming): Promise<boolean>;
	/** Load an aligned plan before its sound starts (sound waits for it). */
	prepareSpeechTiming?(plan: SpeechPlan): Promise<PreparedSpeech | null>;
	/** True when the loaded avatar carries the canonical speech set. */
	canPlaySpeechPlans?(): boolean;
	updateSpeechPlan?(plan: SpeechPlan): boolean;
}

export interface OrderedTtsQueue {
	reserveSeq(): number;
	/** Streaming PCM slot (local voice hosts that stream `audio/pcm`). */
	enqueueOrderedStream?(
		seq: number,
		stream: PcmStreamSource,
		callbacks: {
			onPlaybackStart: (playback?: AudioPlaybackClock) => void;
			onPlaybackUnavailable: () => void;
		},
	): void;
	enqueueOrdered(
		seq: number,
		audioBase64: string,
		callbacks: {
			onPlaybackStart: (playback?: AudioPlaybackClock) => void;
			onPlaybackUnavailable: () => void;
			beforePlayback?: () => Promise<unknown>;
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
	/** Aligned plan port for Shell TTS audio (defaults to the speech-timing registry). */
	getAlignedSpeechPlanSource?(): AlignedSpeechPlanSource | null;
	/** Browser-timed plan port for speechSynthesis (defaults to the registry). */
	getBrowserSpeechPlanSource?(): BrowserSpeechPlanSource | null;
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
	/** Bumped by interrupt(): late plans from a superseded turn never start. */
	let speechEpoch = 0;

	// Default aligned source: the gateway shell_audio route, using the same
	// login key and gateway URL as Naia TTS. A registered port wins.
	const gatewayAlignedSource = createGatewayAlignedPlanSource({
		getConfig: () => deps.getVoiceConfig(),
	});
	const alignedSource = () =>
		deps.getAlignedSpeechPlanSource
			? deps.getAlignedSpeechPlanSource()
			: (getAlignedSpeechPlanSource() ??
				(deps.getVoiceConfig()?.naiaKey ? gatewayAlignedSource : null));
	const browserSource = () =>
		deps.getBrowserSpeechPlanSource
			? deps.getBrowserSpeechPlanSource()
			: getBrowserSpeechPlanSource();

	/**
	 * Ask the aligned plan port for this exact sound. `beforePlayback` (whole
	 * sound only) holds the sound until the plan is loaded into the player, so
	 * mouth and sound start together; `start` then plays it on the sound's own
	 * clock. Without a plan in time the avatar stays idle (no late start).
	 */
	function requestAlignedPlan(
		renderer: CascadeSpeechRenderer | null | undefined,
		request: Parameters<AlignedSpeechPlanSource>[0],
	): {
		beforePlayback?: () => Promise<unknown>;
		start: (playback?: AudioPlaybackClock) => void;
	} | null {
		const source = alignedSource();
		if (!renderer?.playSpeechTiming || !source) return null;
		const epoch = speechEpoch;
		const plan = source(request)
			.catch((error) => {
				Logger.warn(TAG, "aligned speech plan failed", {
					error: String(error),
				});
				return null;
			})
			.then((resolved) => {
				// SoT 8: an aligned plan runs only on the audio clock of its sound.
				if (resolved && !isAlignedPlan(resolved)) {
					Logger.warn(TAG, "aligned port returned a non-aligned plan", {
						quality_mode: resolved.quality_mode,
					});
					return null;
				}
				return resolved;
			});

		const prepareSpeech = renderer.prepareSpeechTiming?.bind(renderer);
		if (prepareSpeech && request.audio.kind === "whole") {
			let prepared: Promise<PreparedSpeech | null> | null = null;
			let timedOut = false;
			const prepare = () => {
				if (!prepared) {
					const loaded = plan.then((resolved) =>
						epoch === speechEpoch && resolved && !timedOut
							? prepareSpeech(resolved)
							: null,
					);
					prepared = Promise.race([
						loaded,
						new Promise<null>((resolve) =>
							setTimeout(() => {
								timedOut = true;
								resolve(null);
							}, ALIGNED_PLAN_WAIT_MS),
						),
					]);
				}
				return prepared;
			};
			return {
				beforePlayback: prepare,
				start: (playback) => {
					if (!playback) return;
					void prepare().then((ready) => {
						if (epoch !== speechEpoch || !ready) return;
						void ready.play(playback.clock);
					});
				},
			};
		}

		return {
			start: (playback) => {
				if (!playback) return;
				void plan.then((resolved) => {
					if (epoch !== speechEpoch || !resolved) return;
					void renderer.playSpeechTiming?.({
						plan: resolved,
						clock: playback.clock,
					});
				});
			},
		};
	}

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
		const reserved = deps.reserveReveal(sentence);
		let revealed = false;
		const revealText = () => {
			revealed = true;
			reserved();
		};

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
				const planSource = browserSource();
				const session =
					cascadeAvatar?.playSpeechTiming && planSource
						? planSource({ text: clean, lang: utter.lang })
						: null;
				const epoch = speechEpoch;
				let startedAt = 0;
				// browser-timed only: speechSynthesis exposes no readable sound,
				// so its clock is time since onstart, corrected by boundaries.
				const elapsedSeconds = () =>
					startedAt > 0 ? (performance.now() - startedAt) / 1000 : 0;
				const revise = (plan: SpeechPlan | null) => {
					if (plan && isBrowserTimedPlan(plan))
						cascadeAvatar?.updateSpeechPlan?.(plan);
				};
				utter.onstart = () => {
					if (!isCurrentBrowserTurn()) return;
					startedAt = performance.now();
					revealText();
					deps.setSpeaking(true);
					cascadeAvatar?.setSpeakingVisual(true);
					void session?.ready
						.then((plan) => {
							if (epoch !== speechEpoch || !isCurrentBrowserTurn()) return;
							if (!plan || !isBrowserTimedPlan(plan)) return;
							void cascadeAvatar?.playSpeechTiming?.({
								plan,
								clock: elapsedSeconds,
							});
						})
						.catch(() => {});
				};
				utter.onboundary = (event) => {
					if (!session || !isCurrentBrowserTurn()) return;
					revise(
						session.boundary(
							event.charIndex,
							Math.round(elapsedSeconds() * 1_000_000),
						),
					);
				};
				utter.onend = () => {
					if (!isCurrentBrowserTurn()) return;
					if (session)
						revise(session.end(Math.round(elapsedSeconds() * 1_000_000)));
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
		// ordered slot as a PCM stream *now* and feed chunks as they arrive, so
		// playback starts on the first chunk instead of after the whole WAV.
		const streamQueue = deps.getQueue();
		// An aligned plan needs the whole sound before it plays (MFA aligns the
		// finished bytes), so while an NVA speech avatar and a plan source are
		// active the local voice is fetched whole instead of streamed.
		const planBeforeSound = Boolean(
			cascadeAvatar?.prepareSpeechTiming &&
				cascadeAvatar.canPlaySpeechPlans?.() &&
				alignedSource(),
		);
		const pcmStream =
			ttsProviderForCost === "naia-local-voice" &&
			streamQueue?.enqueueOrderedStream &&
			!planBeforeSound
				? new PcmStreamSource(24000)
				: null;
		const speechLang =
			typeof document !== "undefined" ? document.documentElement.lang : "";
		if (pcmStream && streamQueue?.enqueueOrderedStream) {
			const alignedPlan = requestAlignedPlan(cascadeAvatar, {
				text: clean,
				lang: speechLang,
				audio: { kind: "pcm-stream", stream: pcmStream },
				signal: abort.signal,
			});
			streamQueue.enqueueOrderedStream(seq, pcmStream, {
				onPlaybackStart: (playback) => {
					revealText();
					alignedPlan?.start(playback);
				},
				onPlaybackUnavailable: revealText,
			});
		}
		const synthesize = () => {
			if (!activeRequests.has(reqId)) {
				return Promise.reject(
					new DOMException("TTS request superseded", "AbortError"),
				);
			}
			// #688: a serial local job that starts after its sentence already settled
			// must not re-raise the chip, because nothing would clear it.
			if (!revealed) deps.setOutputStage("tts");
			synthesisStartedAt = performance.now();
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
				streamPcm: !!pcmStream,
				onPcmChunk: pcmStream
					? (chunk, rate) => {
							if (!activeRequests.has(reqId)) return;
							pcmStream.sampleRate = rate;
							const firstChunk = pcmStream.chunks.length === 0;
							pcmStream.push(chunk);
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
				if (ttsProviderForCost === "naia-local-voice" && localVoiceScheduler) {
					const duration = wavDurationSeconds(audioBase64);
					const elapsed =
						Math.max(0, performance.now() - synthesisStartedAt) / 1000;
					const verdict = localVoiceScheduler.onSentenceResult(
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
							graceMs: verdict.graceMs,
						});
					}
				}
				activeRequests.delete(reqId);
				if (pcmStream) {
					if (pcmStream.chunks.length === 0) {
						// #688: the whole WAV plays in the reserved slot, because
						// re-enqueueing by seq is impossible once the stream slot has been flushed.
						pcmStream.endWithAudio(audioBase64);
					} else {
						pcmStream.end();
					}
				} else {
					const alignedPlan = requestAlignedPlan(cascadeAvatar, {
						text: clean,
						lang: speechLang,
						audio: {
							kind: "whole",
							audioBase64,
							durationSeconds: audioDurationSeconds,
						},
					});
					deps.getQueue()?.enqueueOrdered(seq, audioBase64, {
						onPlaybackStart: (playback) => {
							revealText();
							alignedPlan?.start(playback);
						},
						onPlaybackUnavailable: revealText,
						beforePlayback: alignedPlan?.beforePlayback,
					});
				}
				if (ttsProviderForCost === "naia-local-voice") {
					localVoiceScheduler?.onEnqueued(localVoiceGeneration, seq);
				}
				// Track TTS cost: server cost for Naia Cloud, estimate for others.
				// The shell applies no markup of its own; any multiplier lives in the
				// gateway (#727). Naia usage is shown in credits (USD x 1000).
				const isNaiaTts = ttsProviderForCost === "nextain";
				const ttsCost =
					costUsd != null
						? costUsd
						: estimateTtsCost(
								ttsProviderForCost,
								clean.length,
								ttsVoiceForCost,
							);
				if (ttsCost > 0) {
					// addCostEntry keeps TTS in a separate CostDashboard row.
					deps.addCostEntry({
						inputTokens: 0,
						outputTokens: 0,
						cost: ttsCost,
						provider: ttsProviderForCost,
						model: isNaiaTts ? "tts:nextain" : `tts:${ttsProviderForCost}`,
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
		speechEpoch++;
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
