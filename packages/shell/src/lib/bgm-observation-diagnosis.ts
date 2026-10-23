/**
 * BGM 재생 관측 실패의 원인 판정 (#521).
 *
 * 설치본에서 음악이 실제로 들리는데도 재생 관측이 12초 뒤 timeout 으로
 * 끝난다. 원인 후보가 여럿인데 어느 것인지 가릴 근거가 없었다. 관측 경로가
 * 아무 로그도 남기지 않아, 재현될 때마다 처음부터 다시 추측해야 했다.
 *
 * 브리지 메시지가 관측에 이르기까지 관문은 셋이다. 창에 도착하고, 소스
 * 필터를 지나고, 재생 식별자가 맞아야 한다. 어느 관문에서 끊겼는지는 세는
 * 것만으로 갈린다. 이 모듈은 그 셈을 한 줄짜리 판정으로 바꾼다.
 */

export interface BgmObservationCounters {
	/** 창에 도착한 브리지 메시지 수(파싱 성공분). */
	received: number;
	/** 소스 필터에서 버린 수. */
	filteredOut: number;
	/** 필터는 지났으나 재생 식별자가 달라 무시된 수. */
	idMismatched: number;
	/** onStateChange 를 한 번이라도 봤는가. */
	stateChangeSeen: boolean;
	/** infoDelivery 를 한 번이라도 봤는가. */
	infoDeliverySeen: boolean;
	/** 관측 시점에 화면에 붙어 있던 iframe 의 재생 식별자. */
	activePlaybackId?: string;
	/** 타임아웃을 건 재생의 식별자. */
	expectedPlaybackId?: string;
}

export type BgmObservationCause =
	/** 브리지 메시지가 한 건도 도착하지 않았다. */
	| "no_bridge_messages"
	/** 메시지는 왔지만 소스 필터가 전부 버렸다. */
	| "source_filter_dropped"
	/** 필터는 지났지만 재생 식별자가 맞지 않았다. */
	| "playback_id_mismatch"
	/** 상태 메시지는 왔는데 재생 상태가 오지 않았다. */
	| "no_playing_state";

export interface BgmObservationDiagnosis {
	cause: BgmObservationCause;
	/** 로그 한 줄에 담을 사람 읽는 문장. */
	summary: string;
}

/**
 * 세 관문의 셈에서 끊긴 지점을 고른다. 앞쪽 관문이 먼저다 — 도착하지 않은
 * 메시지는 필터를 논할 수 없다.
 */
export function diagnoseBgmObservationFailure(
	counters: BgmObservationCounters,
): BgmObservationDiagnosis {
	if (counters.received === 0 && counters.filteredOut === 0) {
		return {
			cause: "no_bridge_messages",
			summary:
				"브리지 메시지가 한 건도 도착하지 않았다 — iframe 이 붙지 않았거나 핸드셰이크가 성립하지 않았다",
		};
	}
	if (counters.received === 0) {
		return {
			cause: "source_filter_dropped",
			summary: `소스 필터가 ${counters.filteredOut}건을 모두 버렸다 — 메시지를 보낸 창이 화면의 iframe 과 다르다`,
		};
	}
	if (counters.idMismatched > 0 && !counters.stateChangeSeen) {
		return {
			cause: "playback_id_mismatch",
			summary: `재생 식별자가 어긋났다 — 기대 ${counters.expectedPlaybackId ?? "(없음)"}, 화면 ${counters.activePlaybackId ?? "(없음)"}`,
		};
	}
	return {
		cause: "no_playing_state",
		summary: `메시지 ${counters.received}건은 도착했으나 재생 상태가 오지 않았다 — onStateChange ${counters.stateChangeSeen ? "있음" : "없음"}, infoDelivery ${counters.infoDeliverySeen ? "있음" : "없음"}`,
	};
}

/** 새 재생마다 셈을 처음부터 시작한다. */
export function emptyBgmObservationCounters(): BgmObservationCounters {
	return {
		received: 0,
		filteredOut: 0,
		idMismatched: 0,
		stateChangeSeen: false,
		infoDeliverySeen: false,
	};
}

export type IframeMessageSourceDecision =
	| "accept"
	| "drop_foreign_window"
	| "drop_null_terminal";

export function extractYoutubeIframeVideoId(
	src: string | null | undefined,
): string | undefined {
	const raw = src?.trim();
	if (!raw) return undefined;
	try {
		const url = new URL(raw, "http://localhost");
		const queryVideoId = url.searchParams.get("videoId")?.trim();
		if (queryVideoId) return queryVideoId;
		const embedMatch = /\/embed\/([^/?#]+)/i.exec(url.pathname);
		if (embedMatch?.[1]?.trim()) {
			return decodeURIComponent(embedMatch[1].trim());
		}
	} catch {
		const embedMatch = /\/embed\/([^/?#]+)/i.exec(raw);
		if (embedMatch?.[1]?.trim()) {
			return embedMatch[1].trim();
		}
	}
	return undefined;
}

function extractMessageVideoId(info: unknown): string | undefined {
	if (!info || typeof info !== "object") return undefined;
	const record = info as Record<string, unknown>;
	if (typeof record.video_id === "string" && record.video_id.trim()) {
		return record.video_id.trim();
	}
	if (typeof record.videoId === "string" && record.videoId.trim()) {
		return record.videoId.trim();
	}
	if (record.videoData && typeof record.videoData === "object") {
		const vd = record.videoData as Record<string, unknown>;
		if (typeof vd.video_id === "string" && vd.video_id.trim()) {
			return vd.video_id.trim();
		}
		if (typeof vd.videoId === "string" && vd.videoId.trim()) {
			return vd.videoId.trim();
		}
	}
	return undefined;
}

/**
 * Tauri WebView often delivers YouTube postMessage with `source=null` (FR-BGM.18).
 * Dropping every null-source event makes audible playback look like
 * `iframe_playing_not_observed` (#671) and hides real track end/error events.
 * Still drop a *different* window (#557), and for null-source terminal events
 * (`onError`, `onStateChange(0)`), accept only when the videoId matches the
 * currently expected playback (via message `videoData.video_id`, observed
 * iframe videoId, or active iframe URL videoId) and drop detached-frame events
 * for a different video (FR-RADIO-DJ.16 + FR-BGM.18).
 */
export function decideIframeMessageSource(input: {
	eventSource: MessageEventSource | null | undefined;
	activeContentWindow: Window | null;
	event?: string;
	info?: unknown;
	expectedVideoId?: string | null;
	observedVideoId?: string | null;
	iframeVideoId?: string | null;
	expectedPlaybackId?: string | null;
	iframePlaybackId?: string | null;
}): IframeMessageSourceDecision {
	if (
		input.eventSource &&
		input.activeContentWindow &&
		input.eventSource !== input.activeContentWindow
	) {
		return "drop_foreign_window";
	}
	if (!input.eventSource) {
		const event = String(input.event ?? "");
		const isTerminal =
			event === "onError" ||
			(event === "onStateChange" && Number(input.info) === 0);
		if (isTerminal) {
			const expectedVideoId = input.expectedVideoId?.trim() || "";
			if (!expectedVideoId) {
				return "drop_null_terminal";
			}
			const expectedPlaybackId = input.expectedPlaybackId?.trim() || "";
			const iframePlaybackId = input.iframePlaybackId?.trim() || "";
			if (
				expectedPlaybackId &&
				iframePlaybackId &&
				expectedPlaybackId !== iframePlaybackId
			) {
				return "drop_null_terminal";
			}
			const msgVideoId = extractMessageVideoId(input.info);
			if (msgVideoId) {
				return msgVideoId === expectedVideoId
					? "accept"
					: "drop_null_terminal";
			}
			const observedVideoId = input.observedVideoId?.trim() || "";
			if (observedVideoId && observedVideoId !== expectedVideoId) {
				return "drop_null_terminal";
			}
			const candidateVideoId =
				observedVideoId || (input.iframeVideoId?.trim() || "");
			if (!candidateVideoId || candidateVideoId !== expectedVideoId) {
				return "drop_null_terminal";
			}
		}
	}
	return "accept";
}

export const YOUTUBE_WIDGET_LISTENING_MESSAGE = JSON.stringify({
	event: "listening",
	id: 1,
	channel: "widget",
});

export const YOUTUBE_WIDGET_SUBSCRIBE_MESSAGES: readonly string[] = [
	JSON.stringify({
		event: "command",
		func: "addEventListener",
		args: ["onStateChange"],
		id: 1,
		channel: "widget",
	}),
	JSON.stringify({
		event: "command",
		func: "addEventListener",
		args: ["onError"],
		id: 1,
		channel: "widget",
	}),
];

export interface YoutubeIframeBridgeHandshakeOptions {
	intervalMs?: number;
	maxAttempts?: number;
	setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
	clearTimer?: (id: ReturnType<typeof setInterval>) => void;
}

export interface YoutubeIframeBridgeHandshake {
	/** Send `listening` immediately and poll until first message or maxAttempts. */
	start: () => void;
	/** Call when the first valid message from the iframe arrives; stops `listening` polling and sends `addEventListener` subscriptions once. */
	onFirstMessage: () => boolean;
	/** Stop any active polling timer. */
	stop: () => void;
	/** Whether the first message has been acknowledged and subscriptions sent. */
	isSubscribed: () => boolean;
	/** Number of `listening` messages sent so far. */
	attempts: () => number;
}

/**
 * YouTube IFrame Player API bridge handshake (#521).
 *
 * The embedded player will not emit `initialDelivery`, `onReady`, `infoDelivery`,
 * `onStateChange`, or `onError` until the host window first posts
 * `{"event":"listening","id":1,"channel":"widget"}`. Once the player replies,
 * the host stops polling `listening` and registers `onStateChange` and `onError`
 * via `addEventListener`.
 */
export function createYoutubeIframeBridgeHandshake(
	postToIframe: (payload: string) => boolean,
	options: YoutubeIframeBridgeHandshakeOptions = {},
): YoutubeIframeBridgeHandshake {
	const intervalMs = options.intervalMs ?? 250;
	const maxAttempts = options.maxAttempts ?? 48;
	const setTimer = options.setTimer ?? ((fn, ms) => setInterval(fn, ms));
	const clearTimer = options.clearTimer ?? ((id) => clearInterval(id));

	let timer: ReturnType<typeof setInterval> | null = null;
	let attemptCount = 0;
	let subscribed = false;

	const stop = () => {
		if (timer !== null) {
			clearTimer(timer);
			timer = null;
		}
	};

	const sendListeningTick = () => {
		if (subscribed) {
			stop();
			return;
		}
		if (attemptCount >= maxAttempts) {
			stop();
			return;
		}
		attemptCount += 1;
		postToIframe(YOUTUBE_WIDGET_LISTENING_MESSAGE);
		if (attemptCount >= maxAttempts) {
			stop();
		}
	};

	const start = () => {
		stop();
		attemptCount = 0;
		subscribed = false;
		sendListeningTick();
		if (!subscribed && attemptCount < maxAttempts) {
			timer = setTimer(sendListeningTick, intervalMs);
		}
	};

	const onFirstMessage = () => {
		stop();
		if (subscribed) return false;
		subscribed = true;
		for (const msg of YOUTUBE_WIDGET_SUBSCRIBE_MESSAGES) {
			postToIframe(msg);
		}
		return true;
	};

	return {
		start,
		onFirstMessage,
		stop,
		isSubscribed: () => subscribed,
		attempts: () => attemptCount,
	};
}

