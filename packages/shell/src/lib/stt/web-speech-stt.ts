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

/** Create a Web Speech API STT session. */
export function createWebSpeechSttSession(language: string): SttSession {
	let resultCallbacks: ((result: SttResult) => void)[] = [];
	let errorCallbacks: ((error: { code: string; message: string }) => void)[] =
		[];
	let recognition: SpeechRecognition | null = null;

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

	return {
		async start() {
			if (!isWebSpeechAvailable()) {
				const msg = "Web Speech API not available in this environment";
				Logger.warn("web-speech-stt", msg);
				for (const cb of errorCallbacks)
					cb({ code: "NOT_AVAILABLE", message: msg });
				throw new Error(msg);
			}

			recognition = buildRecognition();

			recognition.onresult = (event: SpeechRecognitionEvent) => {
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
					for (const cb of resultCallbacks)
						cb({ transcript, isFinal, confidence });
				}
			};

			recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
				// "no-speech" is normal — not an error worth surfacing
				if (event.error === "no-speech") return;
				Logger.warn("web-speech-stt", "error", { error: event.error });
				for (const cb of errorCallbacks)
					cb({ code: event.error, message: event.message ?? event.error });
			};

			recognition.start();
			Logger.info("web-speech-stt", "started", { language });
		},

		async stop() {
			if (recognition) {
				recognition.stop();
				recognition = null;
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
