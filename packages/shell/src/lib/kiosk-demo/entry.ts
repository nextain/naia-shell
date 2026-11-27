import { type AppConfig, saveConfig } from "../config";
import { buildKioskDemoConfigSeed } from "../config-seed";
import { Logger } from "../logger";
import { webAdkOpfsPath } from "../web-runtime/web-adk-path";
import { getWebFs } from "../web-runtime/web-fs";
import {
	INITIAL_WEB_WORKSPACE_CONFIG,
	clearWebConversations,
} from "../web-runtime/web-workspace-commands";
import { WEB_LLM_MODEL_PREF_KEY } from "../web-runtime/webllm-model";
import { isKioskDemo } from "./flag";
import { restoreKioskAdkOriginals } from "../web-runtime/web-adk-edit";

export const KIOSK_VISIT_ACTIVE_SESSION_KEY = "naia-kiosk-visit-active";
export const KIOSK_VISIT_LAST_ACTIVE_KEY = "naia-kiosk-last-active-at";
export const KIOSK_VISIT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const KIOSK_DEMO_UNAVAILABLE_EVENT = "naia-kiosk-demo-unavailable";

const KIOSK_CREDIT_EXHAUSTED_RE =
	/\b402\b|payment\s+required|insufficient[_-\s]*(?:quota|credits?|balance|funds)|quota[_-\s]*(?:exceeded|blocked)|out\s+of\s+credits?|credit\s+balance|크레딧.*(?:부족|없|소진)|잔액.*(?:부족|없|소진)/i;

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
 * 새 탭이거나 무응답 기준 시간이 지났을 때만 초기화한다. 같은 탭 안의
 * 새로고침은 같은 방문으로 보고 손님의 선택(예: 직접 끈 능동 발화)을 살린다.
 * 앞 손님의 흔적은 새 탭·무응답 때의 초기화가 시드로 되돌린다.
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

export function isKioskCreditExhaustedError(
	code: unknown,
	message: string,
): boolean {
	if (code === "PROVIDER_AUTH_EXPIRED" || code === "PROVIDER_LOGIN_REQUIRED") {
		return true;
	}
	return KIOSK_CREDIT_EXHAUSTED_RE.test(message);
}

export function notifyKioskDemoUnavailable(): void {
	if (typeof window === "undefined") return;
	window.dispatchEvent(new CustomEvent(KIOSK_DEMO_UNAVAILABLE_EVENT));
}

async function resetKioskSettingsToSeed(): Promise<void> {
	if (!isKioskDemo()) return;
	const seed = await buildKioskDemoConfigSeed();
	try {
		if (typeof localStorage !== "undefined") {
			localStorage.removeItem("naia-web-nextain-model");
			localStorage.removeItem(WEB_LLM_MODEL_PREF_KEY);
			localStorage.removeItem("naia-kiosk-local-answer");
			saveConfig({
				...seed,
				apiKey: "",
				naiaKey: undefined,
				naiaUserId: undefined,
			} as AppConfig);
		}
	} catch {
		// ignore storage errors
	}
	try {
		const fs = getWebFs();
		const configPath = webAdkOpfsPath("naia-settings/config.json");
		const uiPath = webAdkOpfsPath("naia-settings/ui-config.json");
		const config = {
			...INITIAL_WEB_WORKSPACE_CONFIG,
			...seed,
		} as Record<string, unknown>;
		delete config.vrmModel;
		delete config.naiaKey;
		delete config.naiaUserId;
		delete config.apiKey;
		await fs.writeBytes(configPath, JSON.stringify(config));
		await fs.writeBytes(
			uiPath,
			JSON.stringify({
				onboardingComplete: true,
				ttsEnabled: true,
			}),
		);
		const { seedKioskAdkWorkspace } = await import("./knowledge");
		await seedKioskAdkWorkspace(fs);
		// 손님이 고친 ADK 파일(AGENTS.md·규칙·지식·.agents·.users)을 원본으로 되돌린다.
		await restoreKioskAdkOriginals(fs);
	} catch {
		// ignore OPFS errors when workspace is not mounted yet
	}
}

/** Wait for cancellation and durable memory/conversation reset before discarding the session. */
export async function resetKioskVisit(actions: {
	cancel: () => void | Promise<void>;
	resetMemory?: () => Promise<void>;
	clearConversations?: () => Promise<void>;
	newConversation: () => void;
	reload: () => void;
}): Promise<void> {
	Logger.debug("KioskDemo", "reset visit");
	await actions.cancel();
	if (actions.resetMemory) {
		await actions.resetMemory();
	}
	await (actions.clearConversations ?? clearWebConversations)();
	await resetKioskSettingsToSeed();
	// 시연 전용 열쇠(naia-remote-key)는 다음 방문자도 같은 시연 계정을 써야 하므로 지우지 않는다.
	clearKioskVisitActivity();
	actions.newConversation();
	actions.reload();
}
