import { Logger } from "../logger";
import { clearWebConversations } from "../web-runtime/web-workspace-commands";

export const KIOSK_VISIT_ACTIVE_SESSION_KEY = "naia-kiosk-visit-active";
export const KIOSK_VISIT_LAST_ACTIVE_KEY = "naia-kiosk-last-active-at";
export const KIOSK_VISIT_IDLE_TIMEOUT_MS = 3 * 60 * 1000;

let greetingPending = false;

export function getKioskIdleTimeoutMs(): number {
	const override = (
		globalThis as { __NAIA_KIOSK_IDLE_TIMEOUT_MS__?: unknown }
	).__NAIA_KIOSK_IDLE_TIMEOUT_MS__;
	return typeof override === "number" &&
		Number.isFinite(override) &&
		override > 0
		? override
		: KIOSK_VISIT_IDLE_TIMEOUT_MS;
}

export function recordKioskVisitActivity(now: number = Date.now()): void {
	try {
		if (typeof sessionStorage !== "undefined") {
			sessionStorage.setItem(KIOSK_VISIT_ACTIVE_SESSION_KEY, "1");
		}
	} catch {
		// ignore storage errors
	}
	try {
		if (typeof localStorage !== "undefined") {
			localStorage.setItem(KIOSK_VISIT_LAST_ACTIVE_KEY, String(now));
		}
	} catch {
		// ignore storage errors
	}
}

export function clearKioskVisitActivity(): void {
	try {
		if (typeof sessionStorage !== "undefined") {
			sessionStorage.removeItem(KIOSK_VISIT_ACTIVE_SESSION_KEY);
		}
	} catch {
		// ignore storage errors
	}
	try {
		if (typeof localStorage !== "undefined") {
			localStorage.removeItem(KIOSK_VISIT_LAST_ACTIVE_KEY);
		}
	} catch {
		// ignore storage errors
	}
}

export function isKioskVisitExpired(
	now: number = Date.now(),
	timeoutMs: number = getKioskIdleTimeoutMs(),
): boolean {
	try {
		if (typeof localStorage === "undefined") return false;
		const raw = localStorage.getItem(KIOSK_VISIT_LAST_ACTIVE_KEY);
		if (!raw) return false;
		const lastActive = Number(raw);
		if (!Number.isFinite(lastActive) || lastActive <= 0) return true;
		return now - lastActive >= timeoutMs;
	} catch {
		return false;
	}
}

/**
 * 앞 방문자가 ‘처음으로’를 누르지 않고 떠난 뒤 새 탭이 열렸거나 무응답 기준 시간이 지났으면
 * 다음 입장 전에 이전 방문 기록을 지워야 한다. 같은 탭의 활성 방문 중 새로고침(F5)은 유지한다.
 */
export function shouldResetKioskVisitOnEnter(
	now: number = Date.now(),
	timeoutMs: number = getKioskIdleTimeoutMs(),
): boolean {
	try {
		if (typeof localStorage === "undefined") return false;
		const raw = localStorage.getItem(KIOSK_VISIT_LAST_ACTIVE_KEY);
		if (!raw) return false;
		const sameTabActive =
			typeof sessionStorage !== "undefined" &&
			sessionStorage.getItem(KIOSK_VISIT_ACTIVE_SESSION_KEY) === "1";
		if (!sameTabActive) return true;
		return isKioskVisitExpired(now, timeoutMs);
	} catch {
		return false;
	}
}

export function requestKioskGreeting(): void {
	Logger.debug("KioskDemo", "entry accepted");
	greetingPending = true;
}

/** Destructive read prevents duplicate greeting on React StrictMode remounts. */
export function consumeKioskGreeting(): boolean {
	const pending = greetingPending;
	greetingPending = false;
	return pending;
}

/** Wait for cancellation and durable memory/conversation reset before discarding the session. */
export async function resetKioskVisit(actions: {
	cancel: () => void | Promise<void>;
	resetMemory: () => Promise<void>;
	clearConversations?: () => Promise<void>;
	newConversation: () => void;
	reload: () => void;
}): Promise<void> {
	Logger.debug("KioskDemo", "reset visit");
	await actions.cancel();
	await actions.resetMemory();
	await (actions.clearConversations ?? clearWebConversations)();
	// 시연 전용 열쇠(naia-remote-key)는 다음 방문자도 같은 시연 계정을 써야 하므로 지우지 않는다.
	clearKioskVisitActivity();
	actions.newConversation();
	actions.reload();
}
