import { useChatStore } from "../../stores/chat";
import { LAB_GATEWAY_URL, loadConfig, saveConfig } from "../config";
import { getLocale } from "../i18n";
import { isKioskDemo } from "../kiosk-demo/flag";
import {
	fetchLabBalancePayload,
	parseLabCredits,
	primeLabCredits,
} from "../lab-balance";
import { getDefaultLlmModel } from "../llm/registry";
import { Logger } from "../logger";
import { makeOnboardingSession } from "../onboarding-core";
import { getDefaultDragonVoiceForLocale } from "../tts/registry";
import { emitWebEvent } from "./event-bus";
import { WEB_ADK_PATH } from "./web-adk-path";
import { getWebBasePath, isWebMode } from "./web-assets";

export const WEB_OAUTH_STATE_STORAGE_KEY = "naia-web-oauth-state";
export const WEB_REMOTE_KEY_STORAGE_KEY = "naia-remote-key";
export const WEB_REMOTE_USER_ID_STORAGE_KEY = "naia-remote-user-id";
export const DEFAULT_WEB_LOGIN_BASE_URL = "https://naia.land";

let webLoginRequiredOverride: boolean | null = null;

/** 단위 시험용 로그인 게이트 오버라이드. null이면 빌드/환경 변수 기본 동작으로 복귀. */
export function setWebLoginRequiredForTests(value: boolean | null): void {
	webLoginRequiredOverride = value;
}

/**
 * 웹판 로그인 기준 주소.
 * 우선순위: `envOverride` → `VITE_NAIA_WEB_LOGIN_BASE` → `VITE_NAIA_WEB_BASE_URL` → 정식 서비스 기본값(`https://naia.land`).
 */
export function getWebLoginBaseUrl(envOverride?: string): string {
	const candidates = [
		envOverride,
		import.meta.env.VITE_NAIA_WEB_LOGIN_BASE as string | undefined,
		import.meta.env.VITE_NAIA_WEB_BASE_URL as string | undefined,
	];
	for (const candidate of candidates) {
		const trimmed = candidate?.trim().replace(/\/+$/, "");
		if (trimmed && trimmed.length > 0) {
			return trimmed;
		}
	}
	return DEFAULT_WEB_LOGIN_BASE_URL;
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
 * 웹판 로그인 첫 화면 강제 여부 (pl-04).
 * 정식 웹 1차에서는 비로그인 방문자가 브라우저 로컬 WebGPU 모델 + 무료 브라우저 음성으로
 * 즉시 체험할 수 있도록 기본값은 끔(`false`)이며, `VITE_NAIA_WEB_LOGIN_REQUIRED=1` 일 때만 강제한다.
 */
export function isWebLoginRequired(envOverride?: string): boolean {
	if (webLoginRequiredOverride !== null) return webLoginRequiredOverride;
	if (!isWebMode()) return false;
	const raw =
		envOverride ??
		(import.meta.env.VITE_NAIA_WEB_LOGIN_REQUIRED as string | undefined);
	const trimmed = raw?.trim().toLowerCase();
	return trimmed === "1" || trimmed === "true";
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

/** CSRF 방어용 무작위 OAuth state 생성 (소문자 16진수 64자리 `/^[0-9a-f]{64}$/`). */
export function generateWebOAuthState(): string {
	if (
		typeof crypto === "undefined" ||
		typeof crypto.getRandomValues !== "function"
	) {
		throw new Error("crypto.getRandomValues is required for OAuth state");
	}
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
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
	basePath?: string;
	pathname?: string;
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
	const currentPathname =
		opts?.pathname ??
		(typeof window !== "undefined" ? window.location.pathname : "/");
	const slugMatch = /^\/u\/([a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9]))(?:\/|$)/i.exec(
		currentPathname,
	);
	const basePath = getWebBasePath(opts?.basePath);
	const redirectUri =
		slugMatch && !opts?.basePath
			? `${origin}/u/${slugMatch[1].toLowerCase()}/auth/callback`
			: `${origin}${basePath}auth/callback`;
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
	pathname?: string;
	basePath?: string;
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

export interface CompleteWebNaiaLoginOptions {
	/**
	 * 서버 OAuth 콜백(`onboarding_complete` / `new_user`)이나 호출자가 명시한 온보딩 완료 여부.
	 * 생략되면 기존 사용자 설정 및 키오스크 모드를 바탕으로 판정한다.
	 */
	onboardingComplete?: boolean;
}

function parseCallbackBooleanFlag(raw: string): boolean | undefined {
	const normalized = raw.trim().toLowerCase();
	if (normalized === "1" || normalized === "true") return true;
	if (normalized === "0" || normalized === "false") return false;
	return undefined;
}

/**
 * 정식 웹 로그인 완료 시 `onboardingComplete` 값을 결정한다.
 * - 키오스크 시연(`isKioskDemo()`)에서는 항상 `true`를 유지한다.
 * - 서버/호출자가 `onboardingComplete` 불리언을 명시하면 그 값을 따른다.
 * - 동일 사용자가 재로그인했고, 미로그인 초기 OPFS 자동 시드(`webAutoDefaultModel && !naiaUserId && !userName`)가 아닌
 *   실제 사용자 설정(`onboardingComplete: boolean`)이 이미 저장되어 있으면 그 값을 보존한다.
 * - 그 외 신규 가입자 첫 로그인 또는 다른 계정으로 전환된 경우에는 `false`를 반환해 정식 웹 온보딩 플로우로 진입시킨다.
 */
export function resolveWebLoginOnboardingComplete(input: {
	existing?: {
		onboardingComplete?: boolean;
		naiaUserId?: string;
		userName?: string;
		webAutoDefaultModel?: boolean;
	} | null;
	previousUserId?: string;
	nextUserId?: string;
	explicitOnboardingComplete?: boolean;
}): boolean {
	if (isKioskDemo()) {
		return true;
	}
	if (typeof input.explicitOnboardingComplete === "boolean") {
		return input.explicitOnboardingComplete;
	}
	const existing = input.existing;
	const effectivePrevUser =
		input.previousUserId?.trim() || existing?.naiaUserId?.trim() || undefined;
	const effectiveNextUser = input.nextUserId?.trim() || undefined;
	const switchedAccount = Boolean(
		effectivePrevUser &&
			effectiveNextUser &&
			effectivePrevUser !== effectiveNextUser,
	);
	if (switchedAccount) {
		return false;
	}
	if (typeof existing?.onboardingComplete === "boolean") {
		const isUnauthenticatedAutoSeed =
			existing.onboardingComplete === true &&
			existing.webAutoDefaultModel === true &&
			!existing.naiaUserId &&
			!existing.userName;
		if (!isUnauthenticatedAutoSeed) {
			return existing.onboardingComplete;
		}
	}
	return false;
}

/**
 * 데스크톱 `AdkSetupScreen.tsx` / `OnboardingWizard.tsx` 와 동일하게
 * `onboarding-core` 의 `onNaiaAuthCallback` 을 거쳐 키를 저장하고 로그인 상태를 확정한다.
 */
export async function completeWebNaiaLogin(
	naiaKey: string,
	naiaUserId?: string,
	opts?: CompleteWebNaiaLoginOptions,
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
	const hasActiveCardBeforeLogin =
		typeof existing?.uiPreferences?.b2cActiveCardId === "string" &&
		existing.uiPreferences.b2cActiveCardId.trim().length > 0;
	const onboardingComplete = hasActiveCardBeforeLogin
		? true
		: resolveWebLoginOnboardingComplete({
				existing,
				previousUserId,
				nextUserId,
				explicitOnboardingComplete: opts?.onboardingComplete,
			});
	const shouldUpgradeAutoSeedToCloud =
		!existing ||
		(existing.webAutoDefaultModel === true && existing.provider === "webllm");
	const nextProvider = shouldUpgradeAutoSeedToCloud
		? "nextain"
		: existing?.provider || "nextain";
	const nextModel = shouldUpgradeAutoSeedToCloud
		? getDefaultLlmModel("nextain")
		: existing?.model || getDefaultLlmModel("nextain");
	const shouldUpgradeToDragonVoice =
		!isKioskDemo() &&
		!existing?.ttsVoice &&
		(!existing?.ttsProvider || existing.ttsProvider === "browser");
	const dragonDefaultVoice = getDefaultDragonVoiceForLocale(
		existing?.locale || getLocale(),
	);
	saveConfig({
		...(existing ?? {}),
		provider: nextProvider,
		model: nextModel,
		apiKey: existing?.apiKey ?? "",
		...(shouldUpgradeAutoSeedToCloud
			? {
					llmRoles: {
						...(existing?.llmRoles ?? {}),
						main: { provider: nextProvider, model: nextModel },
					},
				}
			: {}),
		...(shouldUpgradeToDragonVoice
			? {
					ttsEnabled: existing?.ttsEnabled ?? true,
					ttsProvider: "nextain" as const,
					ttsVoice: dragonDefaultVoice,
				}
			: {}),
		naiaUserId: nextUserId,
		onboardingComplete,
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
 * `/auth/callback` 으로 돌아왔을 때 `#`(hash) 우선·쿼리 폴백으로 `state` 확인 뒤
 * `key`(`code=gw-*` 폴백)·`user_id`를 받아 브라우저 저장소에 저장하고 주소창을 `/` 로 정리한다.
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
	const isAuthCallbackPath =
		normalizedPath === "/auth/callback" ||
		normalizedPath.endsWith("/auth/callback");

	const hashParams = new URLSearchParams(
		(currentLoc.hash ?? "").replace(/^#/, ""),
	);
	const queryParams = new URLSearchParams(currentLoc.search);
	const isDirectHashKeyHandoff =
		!isAuthCallbackPath &&
		(hashParams.has("key") ||
			(hashParams.get("code")?.trim().startsWith("gw-") ?? false));

	if (!isAuthCallbackPath && !isDirectHashKeyHandoff) {
		return { handled: false, ok: false };
	}

	const callbackParamNames = [
		"state",
		"key",
		"code",
		"user_id",
		"onboarding_complete",
		"new_user",
	] as const;
	const hasAnyHashParam = callbackParamNames.some((name) =>
		hashParams.has(name),
	);
	const sourceParams =
		isDirectHashKeyHandoff || hasAnyHashParam ? hashParams : queryParams;
	const getCallbackParam = (
		name: (typeof callbackParamNames)[number],
	): string => sourceParams.get(name)?.trim() ?? "";

	const returnedState = getCallbackParam("state");

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
	let cleanTargetPath = "/";
	if (isAuthCallbackPath) {
		const prefix = normalizedPath.slice(0, -"/auth/callback".length);
		cleanTargetPath = !prefix
			? "/"
			: prefix.startsWith("/u/")
				? prefix
				: `${prefix}/`;
	} else {
		cleanTargetPath = currentLoc.pathname || "/";
	}
	const preservedQuery = new URLSearchParams(currentLoc.search);
	for (const authKey of callbackParamNames) {
		preservedQuery.delete(authKey);
	}
	const preservedSearch = preservedQuery.toString();
	cleanAddress(
		preservedSearch ? `${cleanTargetPath}?${preservedSearch}` : cleanTargetPath,
	);

	const requireStateValidation =
		isAuthCallbackPath || Boolean(expectedState) || Boolean(returnedState);
	if (
		requireStateValidation &&
		(!expectedState || returnedState !== expectedState)
	) {
		Logger.warn("WebAuth", "OAuth callback state mismatch");
		return { handled: true, ok: false, error: "state_mismatch" };
	}

	const codeParam = getCallbackParam("code");
	const rawKey = (
		getCallbackParam("key") || (codeParam.startsWith("gw-") ? codeParam : "")
	).trim();
	if (!isValidWebAuthKey(rawKey)) {
		Logger.warn("WebAuth", "OAuth callback invalid key format");
		return { handled: true, ok: false, error: "invalid_key" };
	}

	const userId = getCallbackParam("user_id") || undefined;
	const explicitOnboardingFlag = parseCallbackBooleanFlag(
		getCallbackParam("onboarding_complete"),
	);
	const explicitNewUserFlag = parseCallbackBooleanFlag(
		getCallbackParam("new_user"),
	);
	const onboardingComplete =
		explicitOnboardingFlag !== undefined
			? explicitOnboardingFlag
			: explicitNewUserFlag !== undefined
				? !explicitNewUserFlag
				: undefined;
	await completeWebNaiaLogin(rawKey, userId, { onboardingComplete });
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

/** No OAuth event or credential-bearing result/log: the demo key stays in auth storage. */
export function seedKioskDemoWebAuth(): boolean {
	if (!isKioskDemo()) return false;
	const key = (
		import.meta.env.VITE_NAIA_KIOSK_DEMO_KEY as string | undefined
	)?.trim();
	Logger.debug("WebAuth", "kiosk credential seed requested");
	if (!key || !isValidWebAuthKey(key)) return false;
	localStorage.setItem(WEB_REMOTE_KEY_STORAGE_KEY, key);
	localStorage.removeItem(WEB_REMOTE_USER_ID_STORAGE_KEY);
	return true;
}

export type KioskDemoAuthVerification =
	| { ok: true; credits: number }
	| { ok: false; reason: "missing-key" | "unavailable" | "lookup-failed" };

/**
 * 시연 전용 열쇠로 게이트웨이 잔액(`/v1/profile/balance`)을 확인해
 * 크레딧이 0 이하임이 확인될 때만 시연 불가(`unavailable`)를 반환한다.
 * 잔액 조회가 실패하면 1회 다시 시도하고, 그래도 실패하면 `lookup-failed`를 반환한다.
 */
export async function verifyKioskDemoWebAuth(opts?: {
	gatewayUrl?: string;
	fetchBalance?: (gatewayUrl: string, naiaKey: string) => Promise<unknown>;
}): Promise<KioskDemoAuthVerification> {
	const envKey = import.meta.env.VITE_NAIA_KIOSK_DEMO_KEY as string | undefined;
	if (envKey !== undefined && !seedKioskDemoWebAuth()) {
		return { ok: false, reason: "missing-key" };
	}
	if (envKey === undefined) {
		seedKioskDemoWebAuth();
	}
	const key =
		typeof localStorage !== "undefined"
			? (localStorage.getItem(WEB_REMOTE_KEY_STORAGE_KEY)?.trim() ?? "")
			: "";
	if (!key || !isValidWebAuthKey(key)) {
		return { ok: false, reason: "missing-key" };
	}
	const gatewayUrl = (opts?.gatewayUrl || LAB_GATEWAY_URL).trim();
	const fetchBalance = opts?.fetchBalance ?? fetchLabBalancePayload;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const payload = await fetchBalance(gatewayUrl, key);
			const credits = parseLabCredits(payload);
			if (credits !== null) {
				if (credits <= 0) {
					return { ok: false, reason: "unavailable" };
				}
				primeLabCredits(credits);
				return { ok: true, credits };
			}
		} catch {
			// retry once on transient balance lookup failure
		}
	}
	return { ok: false, reason: "lookup-failed" };
}
