export type WebLoginPromptReason =
	| "cloud-llm"
	| "dragon-voice"
	| "studio"
	| "app-store"
	| "account";

export interface WebLoginPromptDetail {
	reason: WebLoginPromptReason;
	reauthenticate?: boolean;
}

export const WEB_LOGIN_PROMPT_EVENT = "naia-open-web-login-prompt";
export const WEB_LOGIN_DISMISSED_DATE_KEY = "naia-web-login-prompt-dismissed";

function todayKey(): string {
	const d = new Date();
	return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export function markWebLoginPromptDismissedToday(): void {
	try {
		if (typeof localStorage !== "undefined") {
			localStorage.setItem(WEB_LOGIN_DISMISSED_DATE_KEY, todayKey());
		}
	} catch {
		// ignore storage errors
	}
}

export function wasWebLoginPromptDismissedToday(): boolean {
	try {
		if (typeof localStorage !== "undefined") {
			return localStorage.getItem(WEB_LOGIN_DISMISSED_DATE_KEY) === todayKey();
		}
	} catch {
		// ignore
	}
	return false;
}

/**
 * SP-04: 클라우드 LLM·드래곤 HD 음성·스튜디오·유료 미니앱 등 로그인이 필요한 기능을
 * 비로그인 상태에서 고를 때 로그인 유도 카드를 띄운다.
 */
export function openWebLoginPrompt(
	reason: WebLoginPromptReason = "account",
	opts?: { respectDailyDismiss?: boolean; reauthenticate?: boolean },
): void {
	if (typeof window === "undefined") return;
	if (opts?.respectDailyDismiss && wasWebLoginPromptDismissedToday()) {
		return;
	}
	window.dispatchEvent(
		new CustomEvent<WebLoginPromptDetail>(WEB_LOGIN_PROMPT_EVENT, {
			detail: { reason, ...(opts?.reauthenticate ? { reauthenticate: true } : {}) },
		}),
	);
}

export function onWebLoginPrompt(
	handler: (detail: WebLoginPromptDetail) => void,
): () => void {
	if (typeof window === "undefined") return () => {};
	const listener = (event: Event) => {
		const custom = event as CustomEvent<WebLoginPromptDetail>;
		handler(custom.detail ?? { reason: "account" });
	};
	window.addEventListener(WEB_LOGIN_PROMPT_EVENT, listener);
	return () => window.removeEventListener(WEB_LOGIN_PROMPT_EVENT, listener);
}
