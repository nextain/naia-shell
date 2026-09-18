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

/**
 * Tauri WebView often delivers YouTube postMessage with `source=null`.
 * Dropping every null-source event makes audible playback look like
 * `iframe_playing_not_observed` (#671). Still drop a *different* window
 * (#557), and drop null-source error/ended so a detached track A cannot
 * fail track B.
 */
export function decideIframeMessageSource(input: {
	eventSource: MessageEventSource | null | undefined;
	activeContentWindow: Window | null;
	event?: string;
	info?: unknown;
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
		if (event === "onError") return "drop_null_terminal";
		if (event === "onStateChange" && Number(input.info) === 0) {
			return "drop_null_terminal";
		}
	}
	return "accept";
}
