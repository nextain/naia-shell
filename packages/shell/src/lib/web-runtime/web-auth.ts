import { useChatStore } from "../../stores/chat";
import { loadConfig, saveConfig } from "../config";
import { getLocale } from "../i18n";
import { Logger } from "../logger";
import { makeOnboardingSession } from "../onboarding-core";
import { emitWebEvent } from "./event-bus";
import { WEB_ADK_PATH } from "./web-adk-path";
import { isWebMode } from "./web-assets";
import { WEB_LLM_MODEL_ID } from "./webllm-model";

export const WEB_OAUTH_STATE_STORAGE_KEY = "naia-web-oauth-state";
export const WEB_REMOTE_KEY_STORAGE_KEY = "naia-remote-key";
export const WEB_REMOTE_USER_ID_STORAGE_KEY = "naia-remote-user-id";
export const DEFAULT_WEB_LOGIN_BASE_URL = "https://dev.naia.land";

let webLoginRequiredOverride: boolean | null = null;

/** 단위 시험용 로그인 게이트 오버라이드. null이면 빌드/환경 변수 기본 동작으로 복귀. */
export function setWebLoginRequiredForTests(value: boolean | null): void {
	webLoginRequiredOverride = value;
}

/**
 * 웹판 로그인 기준 주소. 기본값은 개발 서버(`https://dev.naia.land`)이며
 * `VITE_NAIA_WEB_LOGIN_BASE` 빌드 변수로 덮어쓸 수 있다.
 */
export function getWebLoginBaseUrl(envOverride?: string): string {
	const raw =
		envOverride ??
		(import.meta.env.VITE_NAIA_WEB_LOGIN_BASE as string | undefined);
	const trimmed = raw?.trim().replace(/\/+$/, "");
	return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_WEB_LOGIN_BASE_URL;
}

/**
 * 빌드/테스트 설정상 로그인 문이 명시적으로 꺼져(`VITE_NAIA_WEB_LOGIN_REQUIRED=0`) 있는가.
 */
export function isWebLoginGateDisabled(envOverride?: string): boolean {
	if (webLoginRequiredOverride !== null) return !webLoginRequiredOverride;
	const raw =
		envOverride ??
		(import.meta.env.VITE_NAIA_WEB_LOGIN_REQUIRED as string | undefined);
	const trimmed = raw?.trim();
	return trimmed === "0" || trimmed === "false";
}

/**
 * 웹판 로그인 첫 화면 강제 여부.
 * 기본은 켬(`true`)이며, `VITE_NAIA_WEB_LOGIN_REQUIRED=0` 이면 로그인 문을 끈다.
 */
export function isWebLoginRequired(envOverride?: string): boolean {
	if (webLoginRequiredOverride !== null) return webLoginRequiredOverride;
	if (!isWebMode()) return false;
	return !isWebLoginGateDisabled(envOverride);
}

/** 데스크톱 Rust 콜백(`lib.rs:256-260`)과 동일한 키 형식 검증. */
export function isValidWebAuthKey(key: string): boolean {
	return (
		typeof key === "string" &&
		key.length >= 10 &&
		key.length <= 256 &&
		/^[a-zA-Z0-9._-]+$/.test(key)
	);
}

/** CSRF 방어용 무작위 OAuth state 생성. */
export function generateWebOAuthState(): string {
	if (
		typeof crypto !== "undefined" &&
		typeof crypto.randomUUID === "function"
	) {
		return crypto.randomUUID().replace(/-/g, "");
	}
	return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`;
}

/**
 * 데스크톱과 동일한 매개변수(`redirect=desktop&app=naia-os&source=web&redirect_uri=<웹판 주소>/auth/callback&state=<무작위>`)로
 * 같은 탭 이동용 로그인 주소를 조립한다.
 */
export function buildWebLoginRedirectUrl(opts?: {
	lang?: string;
	origin?: string;
	state?: string;
	baseUrl?: string;
}): { url: string; state: string; redirectUri: string } {
	const lang = (opts?.lang || getLocale() || "ko").trim();
	const origin = (
		opts?.origin ||
		(typeof window !== "undefined"
			? window.location.origin
			: "http://localhost:5173")
	).replace(/\/+$/, "");
	const state = (opts?.state || generateWebOAuthState()).trim();
	const baseUrl = getWebLoginBaseUrl(opts?.baseUrl);
	const redirectUri = `${origin}/auth/callback`;
	const params = new URLSearchParams({
		redirect: "desktop",
		app: "naia-os",
		source: "web",
		redirect_uri: redirectUri,
		state,
	});
	return {
		url: `${baseUrl}/${lang}/login?${params.toString()}`,
		state,
		redirectUri,
	};
}

/** state를 브라우저 저장소에 기록하고 같은 탭에서 로그인 페이지로 이동한다. */
export function startWebLoginRedirect(opts?: {
	lang?: string;
	origin?: string;
	state?: string;
	baseUrl?: string;
	navigate?: (url: string) => void;
}): { url: string; state: string; redirectUri: string } {
	const built = buildWebLoginRedirectUrl(opts);
	try {
		if (typeof sessionStorage !== "undefined") {
			sessionStorage.setItem(WEB_OAUTH_STATE_STORAGE_KEY, built.state);
		}
	} catch {
		// ignore sessionStorage failure
	}
	try {
		if (typeof localStorage !== "undefined") {
			localStorage.setItem(WEB_OAUTH_STATE_STORAGE_KEY, built.state);
		}
	} catch {
		// ignore localStorage failure
	}
	const navigate =
		opts?.navigate ??
		((targetUrl: string) => {
			if (typeof window !== "undefined") {
				window.location.assign(targetUrl);
			}
		});
	navigate(built.url);
	return built;
}

/**
 * 데스크톱 `AdkSetupScreen.tsx` / `OnboardingWizard.tsx` 와 동일하게
 * `onboarding-core` 의 `onNaiaAuthCallback` 을 거쳐 키를 저장하고 로그인 상태를 확정한다.
 */
export async function completeWebNaiaLogin(
	naiaKey: string,
	naiaUserId?: string,
): Promise<void> {
	if (!isValidWebAuthKey(naiaKey)) {
		throw new Error("invalid_naia_key");
	}
	try {
		const session = makeOnboardingSession();
		await session.onNaiaAuthCallback(naiaKey, WEB_ADK_PATH);
	} catch {
		// 웹판에서는 write_agent_key가 desktop-only이므로 실패를 무시하고 브라우저 저장소에 보관한다.
	}

	const previousUserId = getWebAuthenticatedUserId();
	const nextUserId = naiaUserId?.trim() || undefined;
	if (typeof localStorage !== "undefined") {
		localStorage.setItem(WEB_REMOTE_KEY_STORAGE_KEY, naiaKey);
		if (nextUserId) {
			localStorage.setItem(WEB_REMOTE_USER_ID_STORAGE_KEY, nextUserId);
		} else {
			localStorage.removeItem(WEB_REMOTE_USER_ID_STORAGE_KEY);
		}
	}

	const existing = loadConfig();
	saveConfig({
		provider: existing?.provider || "webllm",
		model: existing?.model || WEB_LLM_MODEL_ID,
		apiKey: existing?.apiKey ?? "",
		...(existing ?? {}),
		naiaUserId: nextUserId,
		onboardingComplete: true,
	});

	if (previousUserId !== nextUserId) {
		useChatStore.getState().newConversation();
	}

	emitWebEvent("naia_auth_complete", {
		naiaKey,
		...(naiaUserId ? { naiaUserId } : {}),
	});
	if (typeof window !== "undefined") {
		window.dispatchEvent(new CustomEvent("naia-web-auth-changed"));
	}
}

export interface WebAuthCallbackResult {
	handled: boolean;
	ok: boolean;
	error?: "state_mismatch" | "invalid_key";
	naiaKey?: string;
	naiaUserId?: string;
}

/**
 * `/auth/callback` 으로 돌아왔을 때 `state` 확인 뒤 `key`(`code=gw-*` 폴백)·`user_id`를 받아
 * 브라우저 저장소에 저장하고 주소창을 `/` 로 정리한다.
 */
export async function consumeWebAuthCallbackFromLocation(
	loc?: { pathname: string; search: string; hash?: string },
	replaceUrl?: (cleanUrl: string) => void,
): Promise<WebAuthCallbackResult> {
	const currentLoc =
		loc ??
		(typeof window !== "undefined"
			? {
					pathname: window.location.pathname,
					search: window.location.search,
					hash: window.location.hash,
				}
			: null);
	if (!currentLoc) return { handled: false, ok: false };

	const normalizedPath = currentLoc.pathname.replace(/\/+$/, "") || "/";
	if (
		normalizedPath !== "/auth/callback" &&
		!normalizedPath.endsWith("/auth/callback")
	) {
		return { handled: false, ok: false };
	}

	const params = new URLSearchParams(currentLoc.search);
	const returnedState = (params.get("state") ?? "").trim();

	let expectedState = "";
	try {
		if (typeof sessionStorage !== "undefined") {
			expectedState =
				sessionStorage.getItem(WEB_OAUTH_STATE_STORAGE_KEY)?.trim() ?? "";
			sessionStorage.removeItem(WEB_OAUTH_STATE_STORAGE_KEY);
		}
	} catch {
		// ignore
	}
	try {
		if (typeof localStorage !== "undefined") {
			if (!expectedState) {
				expectedState =
					localStorage.getItem(WEB_OAUTH_STATE_STORAGE_KEY)?.trim() ?? "";
			}
			localStorage.removeItem(WEB_OAUTH_STATE_STORAGE_KEY);
		}
	} catch {
		// ignore
	}

	const cleanAddress =
		replaceUrl ??
		((cleanUrl: string) => {
			if (
				typeof window !== "undefined" &&
				typeof window.history?.replaceState === "function"
			) {
				window.history.replaceState({}, "", cleanUrl);
			}
		});
	cleanAddress("/");

	if (!expectedState || returnedState !== expectedState) {
		Logger.warn("WebAuth", "OAuth callback state mismatch");
		return { handled: true, ok: false, error: "state_mismatch" };
	}

	const codeParam = params.get("code")?.trim() ?? "";
	const rawKey = (
		params.get("key")?.trim() || (codeParam.startsWith("gw-") ? codeParam : "")
	).trim();
	if (!isValidWebAuthKey(rawKey)) {
		Logger.warn("WebAuth", "OAuth callback invalid key format");
		return { handled: true, ok: false, error: "invalid_key" };
	}

	const userId = params.get("user_id")?.trim() || undefined;
	await completeWebNaiaLogin(rawKey, userId);
	return {
		handled: true,
		ok: true,
		naiaKey: rawKey,
		naiaUserId: userId,
	};
}

/** 브라우저 저장소에 유효한 나이아 로그인 키가 보관되어 있는가. */
export function isWebAuthenticated(): boolean {
	if (typeof localStorage === "undefined") return false;
	const remoteKey = localStorage.getItem(WEB_REMOTE_KEY_STORAGE_KEY)?.trim();
	if (remoteKey && isValidWebAuthKey(remoteKey)) return true;
	const cfgKey = loadConfig()?.naiaKey?.trim();
	if (cfgKey && isValidWebAuthKey(cfgKey)) return true;
	return false;
}

export function getWebAuthenticatedUserId(): string | undefined {
	if (typeof localStorage === "undefined") return undefined;
	const remoteUser = localStorage
		.getItem(WEB_REMOTE_USER_ID_STORAGE_KEY)
		?.trim();
	if (remoteUser) return remoteUser;
	return loadConfig()?.naiaUserId?.trim() || undefined;
}

/** 로그아웃 단추로만 브라우저 저장소의 로그인 키를 지우고 첫 로그인 화면으로 되돌린다. */
export function logoutWebSession(): void {
	try {
		if (typeof localStorage !== "undefined") {
			localStorage.removeItem(WEB_REMOTE_KEY_STORAGE_KEY);
			localStorage.removeItem(WEB_REMOTE_USER_ID_STORAGE_KEY);
			localStorage.removeItem(WEB_OAUTH_STATE_STORAGE_KEY);
		}
	} catch {
		// ignore
	}
	try {
		if (typeof sessionStorage !== "undefined") {
			sessionStorage.removeItem(WEB_OAUTH_STATE_STORAGE_KEY);
		}
	} catch {
		// ignore
	}
	const existing = loadConfig();
	if (existing) {
		saveConfig({
			...existing,
			naiaKey: undefined,
			naiaUserId: undefined,
		});
	}
	useChatStore.getState().newConversation();
	if (typeof window !== "undefined") {
		window.dispatchEvent(new CustomEvent("naia-web-auth-changed"));
	}
}
