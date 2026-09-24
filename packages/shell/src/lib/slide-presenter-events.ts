export const SLIDE_PRESENTER_SPEAK_EVENT = "naia:slide-presenter-speak";
export const SLIDE_PRESENTER_CANCEL_EVENT = "naia:slide-presenter-cancel";
export const SLIDE_PRESENTER_SPEECH_RESULT_EVENT =
	"naia:slide-presenter-speech-result";
/**
 * Ask the Shell to synthesize the opening of the NEXT page while the current
 * page is still being read, so a page turn does not wait for synthesis.
 * `text: null` discards any prefetched audio (pause, stop, previous page,
 * script edit, leaving the presentation).
 */
export const SLIDE_PRESENTER_PREFETCH_EVENT = "naia:slide-presenter-prefetch";

export interface SlidePresenterSpeechRequest {
	requestId: string;
	generation: number;
	page: number;
	text: string;
}

export interface SlidePresenterPrefetchRequest {
	/** Generation of the page currently being read; the prefetch waits behind it. */
	generation: number;
	/** Page whose opening is prefetched (null when discarding). */
	page: number | null;
	text: string | null;
}

export interface SlidePresenterSpeechResult {
	requestId: string;
	generation: number;
	page: number;
	status: "finished" | "cancelled" | "failed";
	error?: string;
}

let bufferedSpeechRequest: SlidePresenterSpeechRequest | null = null;
let presenterConsumerActive = false;
let bufferInstalledOn: Window | null = null;
let consumerUnavailableError: string | null = null;

function settleSpeechRequestAsCancelled(
	request: SlidePresenterSpeechRequest,
): void {
	const { requestId, generation, page } = request;
	window.dispatchEvent(
		new CustomEvent<SlidePresenterSpeechResult>(
			SLIDE_PRESENTER_SPEECH_RESULT_EVENT,
			{
				detail: { requestId, generation, page, status: "cancelled" },
			},
		),
	);
}

export function failBufferedSlidePresenterSpeech(error: string): void {
	consumerUnavailableError = error;
	if (!bufferedSpeechRequest) return;
	const { requestId, generation, page } = bufferedSpeechRequest;
	bufferedSpeechRequest = null;
	window.dispatchEvent(
		new CustomEvent<SlidePresenterSpeechResult>(
			SLIDE_PRESENTER_SPEECH_RESULT_EVENT,
			{
				detail: {
					requestId,
					generation,
					page,
					status: "failed",
					error,
				},
			},
		),
	);
}

function bufferSpeechRequest(event: Event): void {
	const detail = (event as CustomEvent<SlidePresenterSpeechRequest>).detail;
	if (!detail?.requestId) return;
	if (presenterConsumerActive) {
		if (bufferedSpeechRequest) {
			const supersededRequest = bufferedSpeechRequest;
			bufferedSpeechRequest = null;
			if (supersededRequest.requestId !== detail.requestId) {
				settleSpeechRequestAsCancelled(supersededRequest);
			}
		}
		return;
	}
	if (consumerUnavailableError) {
		const { requestId, generation, page } = detail;
		window.dispatchEvent(
			new CustomEvent<SlidePresenterSpeechResult>(
				SLIDE_PRESENTER_SPEECH_RESULT_EVENT,
				{
					detail: {
						requestId,
						generation,
						page,
						status: "failed",
						error: consumerUnavailableError,
					},
				},
			),
		);
		return;
	}
	if (
		bufferedSpeechRequest &&
		bufferedSpeechRequest.requestId !== detail.requestId
	) {
		settleSpeechRequestAsCancelled(bufferedSpeechRequest);
	}
	bufferedSpeechRequest = detail;
}

function cancelBufferedSpeechRequest(event: Event): void {
	if (!bufferedSpeechRequest) return;
	const detail = (
		event as CustomEvent<{ requestId?: string; generation?: number }>
	).detail;
	if (detail?.requestId && detail.requestId !== bufferedSpeechRequest.requestId)
		return;
	if (
		detail?.generation != null &&
		detail.generation !== bufferedSpeechRequest.generation
	)
		return;
	const cancelledRequest = bufferedSpeechRequest;
	bufferedSpeechRequest = null;
	settleSpeechRequestAsCancelled(cancelledRequest);
}

/**
 * Preserve narration requests dispatched while the deferred ChatArea runtime is
 * still loading. This module is part of the eager shell; actual TTS remains in
 * ChatArea so there is still only one media runtime.
 */
export function ensureSlidePresenterSpeechBuffer(): () => void {
	if (typeof window === "undefined") return () => undefined;
	if (bufferInstalledOn !== window) {
		bufferInstalledOn = window;
		window.addEventListener(SLIDE_PRESENTER_SPEAK_EVENT, bufferSpeechRequest);
		window.addEventListener(
			SLIDE_PRESENTER_CANCEL_EVENT,
			cancelBufferedSpeechRequest,
		);
	}
	return function stopSlidePresenterSpeechBuffer() {
		if (bufferInstalledOn !== window) return;
		window.removeEventListener(
			SLIDE_PRESENTER_SPEAK_EVENT,
			bufferSpeechRequest,
		);
		window.removeEventListener(
			SLIDE_PRESENTER_CANCEL_EVENT,
			cancelBufferedSpeechRequest,
		);
		if (bufferedSpeechRequest) {
			settleSpeechRequestAsCancelled(bufferedSpeechRequest);
			bufferedSpeechRequest = null;
		}
		consumerUnavailableError = null;
		bufferInstalledOn = null;
	};
}

export function prepareSlidePresenterSpeechConsumer(): void {
	consumerUnavailableError = null;
}

export function activateSlidePresenterSpeechConsumer(): SlidePresenterSpeechRequest | null {
	consumerUnavailableError = null;
	presenterConsumerActive = true;
	return bufferedSpeechRequest;
}

export function consumeBufferedSlidePresenterSpeech(
	requestId: string,
): SlidePresenterSpeechRequest | null {
	if (bufferedSpeechRequest?.requestId !== requestId) return null;
	const request = bufferedSpeechRequest;
	bufferedSpeechRequest = null;
	return request;
}

export function deactivateSlidePresenterSpeechConsumer(): void {
	presenterConsumerActive = false;
}

export function requestSlidePresenterSpeech(
	detail: SlidePresenterSpeechRequest,
): void {
	if (window.parent !== window) {
		window.parent.postMessage({ type: "naia-slides:speak", detail }, "*");
		return;
	}
	window.dispatchEvent(
		new CustomEvent<SlidePresenterSpeechRequest>(SLIDE_PRESENTER_SPEAK_EVENT, {
			detail,
		}),
	);
}

export function cancelSlidePresenterSpeech(
	detail: {
		requestId?: string;
		generation?: number;
	} = {},
): void {
	if (window.parent !== window) {
		window.parent.postMessage({ type: "naia-slides:cancel", detail }, "*");
		return;
	}
	window.dispatchEvent(
		new CustomEvent(SLIDE_PRESENTER_CANCEL_EVENT, { detail }),
	);
}

export function requestSlidePresenterPrefetch(
	detail: SlidePresenterPrefetchRequest,
): void {
	if (window.parent !== window) {
		window.parent.postMessage({ type: "naia-slides:prefetch", detail }, "*");
		return;
	}
	window.dispatchEvent(
		new CustomEvent<SlidePresenterPrefetchRequest>(
			SLIDE_PRESENTER_PREFETCH_EVENT,
			{ detail },
		),
	);
}
