/**
 * Web Speech API STT session — uses browser's built-in SpeechRecognition.
 * Free, no API key needed, no model download.
 * Streaming with interim results supported.
 *
 * Note: availability depends on browser/WebKit version.
 * WebKitGTK (Tauri Linux) may have limited support.
 */
import { Logger } from "../logger";
import type { SttResult, SttSession } from "./types";

// Web Speech API types (not in standard DOM lib)
interface SpeechRecognitionResult {
	readonly isFinal: boolean;
	readonly length: number;
	item(index: number): SpeechRecognitionAlternative;
	[index: number]: SpeechRecognitionAlternative;
}
interface SpeechRecognitionAlternative {
	readonly transcript: string;
	readonly confidence: number;
}
interface SpeechRecognitionResultList {
	readonly length: number;
	item(index: number): SpeechRecognitionResult;
	[index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionEvent extends Event {
	readonly resultIndex: number;
	readonly results: SpeechRecognitionResultList;
}
interface SpeechRecognitionErrorEvent extends Event {
	readonly error: string;
	readonly message: string;
}
interface SpeechRecognition extends EventTarget {
	lang: string;
	continuous: boolean;
	interimResults: boolean;
	maxAlternatives: number;
	onresult: ((event: SpeechRecognitionEvent) => void) | null;
	onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
	onend: (() => void) | null;
	start(): void;
	stop(): void;
	abort(): void;
}
declare let SpeechRecognition: {
	new (): SpeechRecognition;
	prototype: SpeechRecognition;
};

/** Whether Web Speech API is available in the current environment. */
export function isWebSpeechAvailable(): boolean {
	return (
		typeof window !== "undefined" &&
		("SpeechRecognition" in window || "webkitSpeechRecognition" in window)
	);
}

/**
 * Some WebView2/Chromium builds (notably WebView2 without Google's private
 * speech-service key, e.g. #615) never surface a proper "no speech backend"
 * error. Instead every final result comes back as an empty transcript with
 * confidence 1 — indistinguishable from "successful recognition of silence"
 * unless we watch for the pattern ourselves. This many consecutive empty
 * finals in a row means the backend isn't actually transcribing.
 */
const EMPTY_FINAL_ERROR_THRESHOLD = 2;

export interface WebSpeechSttOptions {
	/**
	 * Report `empty-transcript` after consecutive empty finals (WebView2 with
	 * no speech backend, #615). Real browsers in the web build also emit empty
	 * finals for non-speech sound (music, a stop() flush), so the web build
	 * turns this off and only drops the empty results.
	 */
	detectEmptyBackend?: boolean;
	/**
	 * Automatically recover and restart capture on Web Speech `no-speech`,
	 * `aborted`, transient `audio-capture`, or browser-initiated `onend` while
	 * the session has not been stopped by the caller (web continuous voice mode).
	 */
	continuousRecovery?: boolean;
	/** Max consecutive `audio-capture` hiccups to auto-recover before surfacing error. */
	maxAudioCaptureRetries?: number;
	/** Base delay (ms) before restarting SpeechRecognition after transient end/error. */
	recoveryDelayMs?: number;
}

/**
 * Session options per build. Desktop (WebView2) keeps the #615 empty-result
 * check so a dead speech backend still turns the mic off; the web build drops
 * empty results and enables silent continuous recovery across silence/echo pauses.
 */
export function webSpeechSttOptions(webMode: boolean): WebSpeechSttOptions {
	return {
		detectEmptyBackend: !webMode,
		continuousRecovery: webMode,
	};
}

export type WebSpeechErrorMessageKey =
	| "chat.webSpeechErrorNotAllowed"
	| "chat.webSpeechErrorAudioCapture"
	| "chat.webSpeechErrorNetwork"
	| "chat.webSpeechErrorLanguage"
	| "chat.webSpeechErrorUnsupported";

/**
 * R26: Web Speech 오류 코드를 사용자가 고칠 수 있게 알려 주는 문구 키로 바꾼다.
 * 모르는 코드는 null — 부르는 쪽이 원래 코드를 그대로 보인다.
 */
export function webSpeechErrorMessageKey(
	code: string,
): WebSpeechErrorMessageKey | null {
	switch (code) {
		case "not-allowed":
		case "service-not-allowed":
			return "chat.webSpeechErrorNotAllowed";
		case "audio-capture":
			return "chat.webSpeechErrorAudioCapture";
		case "network":
			return "chat.webSpeechErrorNetwork";
		case "language-not-supported":
			return "chat.webSpeechErrorLanguage";
		case "NOT_AVAILABLE":
			return "chat.webSpeechErrorUnsupported";
		default:
			return null;
	}
}

const DEFAULT_MAX_AUDIO_CAPTURE_RETRIES = 3;
const DEFAULT_RECOVERY_DELAY_MS = 150;

/** Create a Web Speech API STT session. */
export function createWebSpeechSttSession(
	language: string,
	options: WebSpeechSttOptions = {},
): SttSession {
	const detectEmptyBackend = options.detectEmptyBackend ?? true;
	const continuousRecovery = options.continuousRecovery ?? false;
	const maxAudioCaptureRetries =
		options.maxAudioCaptureRetries ?? DEFAULT_MAX_AUDIO_CAPTURE_RETRIES;
	const recoveryDelayMs = options.recoveryDelayMs ?? DEFAULT_RECOVERY_DELAY_MS;
	let resultCallbacks: ((result: SttResult) => void)[] = [];
	let errorCallbacks: ((error: { code: string; message: string }) => void)[] =
		[];
	let recognition: SpeechRecognition | null = null;
	let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
	let consecutiveEmptyFinals = 0;
	let consecutiveAudioCaptureErrors = 0;
	let emptyTranscriptErrorReported = false;
	let stopped = true;

	function clearRecoveryTimer(): void {
		if (recoveryTimer !== null) {
			clearTimeout(recoveryTimer);
			recoveryTimer = null;
		}
	}

	/**
	 * Detach handlers and kill the native recognition object outright.
	 *
	 * `continuous: true` combined with a WebView2/Chromium build that has no
	 * working speech backend (#623) makes some implementations restart
	 * capture internally on every "network" error — `recognition.stop()`
	 * alone does not stop that loop, so onerror keeps firing forever on the
	 * same instance. `abort()` plus detaching the handlers ensures no more
	 * events from this instance ever reach our callbacks.
	 */
	function killRecognition(r: SpeechRecognition): void {
		r.onresult = null;
		r.onerror = null;
		r.onend = null;
		try {
			r.abort();
		} catch {
			/* already stopped/aborted — nothing to clean up */
		}
	}

	function stopRecognitionCleanly(r: SpeechRecognition): void {
		r.onresult = null;
		r.onerror = null;
		r.onend = null;
		try {
			r.stop();
		} catch {
			/* already stopped — nothing to clean up */
		}
	}

	function failRecognition(code: string, message: string): void {
		stopped = true;
		clearRecoveryTimer();
		const instance = recognition;
		recognition = null;
		if (instance) killRecognition(instance);
		Logger.warn("web-speech-stt", "error", { error: code });
		for (const cb of errorCallbacks) cb({ code, message });
	}

	function failStart(error: unknown, fallbackCode: string): void {
		const name = error instanceof Error || error instanceof DOMException
			? error.name
			: "";
		let code = fallbackCode;
		switch (name) {
			case "NotAllowedError":
			case "PermissionDeniedError":
			case "SecurityError":
				code = "not-allowed";
				break;
			case "NotFoundError":
			case "NotReadableError":
			case "OverconstrainedError":
				code = "audio-capture";
				break;
		}
		failRecognition(code, String(error));
	}

	function buildRecognition(): SpeechRecognition {
		const w = window as Window & {
			SpeechRecognition?: new () => SpeechRecognition;
			webkitSpeechRecognition?: new () => SpeechRecognition;
		};
		const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
		if (!Ctor) throw new Error("Web Speech API not available");
		const r = new Ctor();
		r.lang = language;
		r.continuous = true;
		r.interimResults = true;
		r.maxAlternatives = 1;
		return r;
	}

	function mountAndStartInstance(): void {
		clearRecoveryTimer();
		if (recognition) {
			const prev = recognition;
			recognition = null;
			killRecognition(prev);
		}
		const instance = buildRecognition();
		recognition = instance;
		consecutiveEmptyFinals = 0;
		emptyTranscriptErrorReported = false;
		stopped = false;

		const scheduleRecoveryRestart = (delayMs: number, reason: string) => {
			if (stopped) return;
			clearRecoveryTimer();
			Logger.debug("web-speech-stt", "scheduling continuous STT recovery", {
				reason,
				delayMs,
			});
			recoveryTimer = setTimeout(() => {
				recoveryTimer = null;
				if (stopped || recognition !== null) return;
				try {
					mountAndStartInstance();
				} catch (err) {
					if (stopped) return;
					failStart(err, "restart-failed");
				}
			}, delayMs);
		};

		instance.onresult = (event: SpeechRecognitionEvent) => {
			// Browsers still flush results after stop() (and the TTS self-echo
			// pause restarts with a new instance). Only the live instance may
			// forward results; late ones from a stopped instance are dropped.
			if (stopped || recognition !== instance) return;
			for (let i = event.resultIndex; i < event.results.length; i++) {
				const res = event.results[i];
				const transcript = res[0].transcript;
				const confidence = res[0].confidence;
				const isFinal = res.isFinal;
				Logger.info("web-speech-stt", "result", {
					transcript: transcript.slice(0, 50),
					isFinal,
					confidence,
				});

				if (isFinal && transcript.trim() === "") {
					consecutiveEmptyFinals++;
					if (
						detectEmptyBackend &&
						consecutiveEmptyFinals >= EMPTY_FINAL_ERROR_THRESHOLD &&
						!emptyTranscriptErrorReported
					) {
						emptyTranscriptErrorReported = true;
						const msg =
							"Web Speech API returned only empty transcripts — the " +
							"speech recognition backend in this browser/WebView2 build " +
							"is not actually transcribing audio";
						Logger.warn("web-speech-stt", msg, {
							consecutiveEmptyFinals,
						});
						for (const cb of errorCallbacks)
							cb({ code: "empty-transcript", message: msg });
					}
					// Not real data — do not forward as a successful result.
					continue;
				}

				consecutiveEmptyFinals = 0;
				consecutiveAudioCaptureErrors = 0;
				for (const cb of resultCallbacks)
					cb({ transcript, isFinal, confidence });
			}
		};

		instance.onerror = (event: SpeechRecognitionErrorEvent) => {
			// Guard against stale recognizer instances (e.g. a paused recognizer
			// flushing "aborted" after TTS finished and resumed with a new instance).
			if (stopped || recognition !== instance) return;

			if (event.error === "no-speech") {
				if (continuousRecovery) {
					recognition = null;
					killRecognition(instance);
					scheduleRecoveryRestart(recoveryDelayMs, "no-speech");
				}
				return;
			}

			if (
				continuousRecovery &&
				(event.error === "aborted" || event.error === "audio-capture")
			) {
				if (event.error === "audio-capture") {
					consecutiveAudioCaptureErrors += 1;
				}
				if (
					event.error === "aborted" ||
					consecutiveAudioCaptureErrors <= maxAudioCaptureRetries
				) {
					recognition = null;
					killRecognition(instance);
					const backoffMs =
						event.error === "audio-capture"
							? Math.min(1_200, recoveryDelayMs * 2 * consecutiveAudioCaptureErrors)
							: recoveryDelayMs;
					scheduleRecoveryRestart(backoffMs, event.error);
					return;
				}
			}

			failRecognition(event.error, event.message ?? event.error);
		};

		instance.onend = () => {
			if (stopped || recognition !== instance) return;
			if (!continuousRecovery) return;
			recognition = null;
			killRecognition(instance);
			scheduleRecoveryRestart(recoveryDelayMs, "ended");
		};

		instance.start();
		Logger.info("web-speech-stt", "started", { language });
	}

	return {
		async start() {
			if (!isWebSpeechAvailable()) {
				const msg = "Web Speech API not available in this environment";
				if (continuousRecovery) {
					failRecognition("NOT_AVAILABLE", msg);
					return;
				}
				Logger.warn("web-speech-stt", msg);
				for (const cb of errorCallbacks)
					cb({ code: "NOT_AVAILABLE", message: msg });
				throw new Error(msg);
			}
			consecutiveAudioCaptureErrors = 0;
			try {
				mountAndStartInstance();
			} catch (err) {
				if (!continuousRecovery) throw err;
				failStart(err, "start-failed");
			}
		},

		async stop() {
			stopped = true;
			clearRecoveryTimer();
			if (recognition) {
				const current = recognition;
				recognition = null;
				stopRecognitionCleanly(current);
			}
			Logger.info("web-speech-stt", "stopped");
		},

		onResult(callback) {
			resultCallbacks.push(callback);
			return () => {
				resultCallbacks = resultCallbacks.filter((cb) => cb !== callback);
			};
		},

		onError(callback) {
			errorCallbacks.push(callback);
			return () => {
				errorCallbacks = errorCallbacks.filter((cb) => cb !== callback);
			};
		},
		// No onCost — Web Speech API is free
	};
}
