/**
 * 시연판(키오스크) 게이트웨이 목소리 요청 상한과 상태 알림.
 *
 * 13판 실측: 긴 답 하나에 /v1/audio/speech 가 48~68건 한꺼번에 나가
 * 지나 목소리 호스트가 503(naia_voice_busy)을 내고 구글 목소리로 바뀌었으며,
 * 그 뒤 연 페이지의 잔액·답이 1~2분 늦었다. 문장 합성을 동시에
 * KIOSK_VOICE_MAX_IN_FLIGHT 건까지만 내고, 바쁨·대체 상태를 화면에 알린다.
 */

export const KIOSK_VOICE_MAX_IN_FLIGHT = 2;

export type KioskVoiceState = "ok" | "busy" | "fallback";
export const KIOSK_VOICE_STATE_EVENT = "naia:kiosk-voice-state";

let inFlight = 0;
const waiters: Array<() => void> = [];

function release(): void {
	inFlight = Math.max(0, inFlight - 1);
	const next = waiters.shift();
	if (next) next();
}

/** Run `task` once a slot is free; a waiter aborted before its turn never runs. */
export function runKioskVoiceSlot<T>(
	task: () => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	const start = (): Promise<T> => {
		inFlight += 1;
		let settled: Promise<T>;
		try {
			settled = task();
		} catch (err) {
			release();
			return Promise.reject(err);
		}
		return settled.finally(release);
	};
	if (signal?.aborted) {
		return Promise.reject(new DOMException("Aborted", "AbortError"));
	}
	if (inFlight < KIOSK_VOICE_MAX_IN_FLIGHT) return start();
	return new Promise<T>((resolve, reject) => {
		const turn = () => {
			signal?.removeEventListener("abort", onAbort);
			start().then(resolve, reject);
		};
		const onAbort = () => {
			const i = waiters.indexOf(turn);
			if (i >= 0) waiters.splice(i, 1);
			reject(new DOMException("Aborted", "AbortError"));
		};
		waiters.push(turn);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export function emitKioskVoiceState(state: KioskVoiceState): void {
	if (typeof window === "undefined") return;
	window.dispatchEvent(
		new CustomEvent(KIOSK_VOICE_STATE_EVENT, { detail: { state } }),
	);
}

/** Test-only reset. */
export function resetKioskVoiceGateForTest(): void {
	inFlight = 0;
	waiters.length = 0;
}
