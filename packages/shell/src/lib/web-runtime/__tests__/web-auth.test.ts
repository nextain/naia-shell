import { fireEvent, render, screen } from "@testing-library/react";
// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebLoginScreen } from "../../../components/WebLoginScreen";
import {
	getNaiaKey,
	getNaiaKeySecure,
	hasNaiaKey,
	loadConfig,
} from "../../config";
import { bootWebRuntimeAndModel } from "../auto-install";
import { setWebAssetsModeForTests } from "../web-assets";
import {
	WEB_OAUTH_STATE_STORAGE_KEY,
	buildWebLoginRedirectUrl,
	completeWebNaiaLogin,
	consumeWebAuthCallbackFromLocation,
	generateWebOAuthState,
	getWebAuthenticatedUserId,
	getWebLoginBaseUrl,
	isWebAuthenticated,
	isWebLoginRequired,
	logoutWebSession,
	setWebLoginRequiredForTests,
	startWebLoginRedirect,
} from "../web-auth";

describe("web-auth (item 5)", () => {
	beforeEach(() => {
		setWebAssetsModeForTests(true);
		localStorage.clear();
		sessionStorage.clear();
		setWebLoginRequiredForTests(null);
	});

	afterEach(() => {
		setWebAssetsModeForTests(null);
		setWebLoginRequiredForTests(null);
		vi.restoreAllMocks();
	});

	it("defaults login base URL to https://naia.land and honors VITE_NAIA_WEB_LOGIN_BASE / VITE_NAIA_WEB_BASE_URL / explicit overrides", () => {
		expect(getWebLoginBaseUrl()).toBe("https://naia.land");
		expect(getWebLoginBaseUrl("https://dev.naia.land/")).toBe(
			"https://dev.naia.land",
		);

		vi.stubEnv("VITE_NAIA_WEB_BASE_URL", "https://www.naia.land/");
		expect(getWebLoginBaseUrl()).toBe("https://www.naia.land");

		vi.stubEnv("VITE_NAIA_WEB_LOGIN_BASE", "https://dev.naia.land/");
		expect(getWebLoginBaseUrl()).toBe("https://dev.naia.land");
		vi.unstubAllEnvs();
	});

	it("defaults to non-login lightweight free start (pl-04) and allows enabling mandatory gate via VITE_NAIA_WEB_LOGIN_REQUIRED=1", () => {
		expect(isWebLoginRequired()).toBe(false);
		expect(isWebLoginRequired("0")).toBe(false);
		expect(isWebLoginRequired("false")).toBe(false);
		expect(isWebLoginRequired("1")).toBe(true);
		expect(isWebLoginRequired("true")).toBe(true);
		setWebLoginRequiredForTests(true);
		expect(isWebLoginRequired()).toBe(true);
		setWebLoginRequiredForTests(false);
		expect(isWebLoginRequired()).toBe(false);
	});

	it("builds same-tab login redirect URL with desktop-compatible query parameters and stores state", () => {
		const nav = vi.fn();
		const built = startWebLoginRedirect({
			origin: "https://web.naia.land",
			lang: "ko",
			state: "fixed-state-123",
			navigate: nav,
		});
		const parsed = new URL(built.url);
		expect(parsed.origin).toBe("https://naia.land");
		expect(parsed.pathname).toBe("/ko/login");
		expect(parsed.searchParams.get("redirect")).toBe("desktop");
		expect(parsed.searchParams.get("app")).toBe("naia-os");
		expect(parsed.searchParams.get("source")).toBe("web");
		expect(parsed.searchParams.get("redirect_uri")).toBe(
			"https://web.naia.land/auth/callback",
		);
		expect(parsed.searchParams.get("state")).toBe("fixed-state-123");
		expect(localStorage.getItem(WEB_OAUTH_STATE_STORAGE_KEY)).toBe(
			"fixed-state-123",
		);
		expect(nav).toHaveBeenCalledWith(built.url);
	});

	it("verifies state on /auth/callback, persists key & user_id, and cleans up URL", async () => {
		startWebLoginRedirect({
			origin: "https://web.naia.land",
			lang: "ko",
			state: "expected-state-abc",
			navigate: () => {},
		});
		const replaceUrl = vi.fn();

		const res = await consumeWebAuthCallbackFromLocation(
			{
				pathname: "/auth/callback",
				search:
					"?key=naia_live_test_key_999&user_id=usr_42&state=expected-state-abc",
				hash: "",
			},
			replaceUrl,
		);

		expect(res).toEqual({
			handled: true,
			ok: true,
			naiaKey: "naia_live_test_key_999",
			naiaUserId: "usr_42",
		});
		expect(isWebAuthenticated()).toBe(true);
		expect(getWebAuthenticatedUserId()).toBe("usr_42");
		expect(await hasNaiaKey()).toBe(true);
		expect(await getNaiaKey()).toBe("naia_live_test_key_999");
		expect(loadConfig()?.naiaUserId).toBe("usr_42");
		expect(replaceUrl).toHaveBeenCalledWith("/");
	});

	it("rejects /auth/callback when state does not match pending state", async () => {
		startWebLoginRedirect({
			origin: "https://web.naia.land",
			lang: "ko",
			state: "expected-state-abc",
			navigate: () => {},
		});
		const replaceUrl = vi.fn();

		const res = await consumeWebAuthCallbackFromLocation(
			{
				pathname: "/auth/callback",
				search:
					"?key=naia_live_test_key_999&user_id=usr_42&state=tampered-state",
				hash: "",
			},
			replaceUrl,
		);

		expect(res).toEqual({
			handled: true,
			ok: false,
			error: "state_mismatch",
		});
		expect(isWebAuthenticated()).toBe(false);
		expect(replaceUrl).toHaveBeenCalledWith("/");
	});

	it("clears stored login state only when logoutWebSession is called", async () => {
		const built = buildWebLoginRedirectUrl({
			origin: "https://web.naia.land",
			lang: "ko",
			state: "state-1",
		});
		localStorage.setItem(WEB_OAUTH_STATE_STORAGE_KEY, built.state);

		await consumeWebAuthCallbackFromLocation(
			{
				pathname: "/auth/callback",
				search: "?key=naia_live_persist_key&user_id=usr_1&state=state-1",
			},
			() => {},
		);
		expect(isWebAuthenticated()).toBe(true);

		logoutWebSession();
		expect(isWebAuthenticated()).toBe(false);
		expect(getWebAuthenticatedUserId()).toBeUndefined();
		expect(loadConfig()?.naiaUserId).toBeUndefined();
	});

	it("uses the server model on a fresh login and exposes the login key to balance requests", async () => {
		const { installWebRuntime } = await import("../install");
		installWebRuntime();
		await completeWebNaiaLogin("naia_test_key_for_login_123", "test-user");
		expect(loadConfig()).toMatchObject({
			provider: "nextain",
			model: "gpt-6.1-terra",
		});
		expect(await getNaiaKeySecure()).toBe("naia_test_key_for_login_123");
	});

	it("defers startWebModel until login completes when login gate is enabled, and starts immediately by default (pl-04)", async () => {
		const startModel = vi.fn(async () => {});

		// 1. Login required (explicit gate) and not authenticated -> does not start model at boot
		setWebLoginRequiredForTests(true);
		const bootRes = await bootWebRuntimeAndModel({
			installRuntime: () => {},
			consumeAuthCallback: async () => ({ handled: false, ok: false }),
			checkAdkStartup: async () => {},
			startModel,
		});
		expect(bootRes.startedImmediately).toBe(false);
		expect(startModel).not.toHaveBeenCalled();

		// 2. Completing login dispatches naia-web-auth-changed and starts model once
		await completeWebNaiaLogin("naia_live_after_login_key_123", "usr_boot");
		expect(startModel).toHaveBeenCalledTimes(1);

		// 3. Default Stage-1 non-login mode (pl-04) starts WebGPU model immediately even when logged out
		logoutWebSession();
		setWebLoginRequiredForTests(null);
		const startModelNoGate = vi.fn(async () => {});
		const noGateRes = await bootWebRuntimeAndModel({
			installRuntime: () => {},
			consumeAuthCallback: async () => ({ handled: false, ok: false }),
			checkAdkStartup: async () => {},
			startModel: startModelNoGate,
		});
		expect(noGateRes.startedImmediately).toBe(true);
		expect(startModelNoGate).toHaveBeenCalledTimes(1);
	});

	it("supports /app/auth/callback, /u/<slug>/auth/callback, and portal #key=gw-... handoff while upgrading WebGPU starter to Cloud + Dragon voice", async () => {
		// 1) /u/cafelua builds callback under /u/cafelua/auth/callback and cleans back to /u/cafelua
		const slugRedirect = startWebLoginRedirect({
			origin: "https://dev.naia.land",
			pathname: "/u/cafelua",
			lang: "ko",
			state: "slug-callback-state",
			navigate: () => {},
		});
		const parsedSlugUrl = new URL(slugRedirect.url);
		expect(parsedSlugUrl.searchParams.get("redirect_uri")).toBe(
			"https://dev.naia.land/u/cafelua/auth/callback",
		);

		// Simulate prior unauthenticated WebGPU starter with an active character card
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "webllm",
				model: "Qwen3-4B-q4f16_1-MLC",
				locale: "ko",
				webAutoDefaultModel: true,
				ttsEnabled: true,
				ttsProvider: "browser",
				onboardingComplete: true,
				uiPreferences: { b2cActiveCardId: "studio-lua-1" },
			}),
		);

		const replaceSlug = vi.fn();
		const slugRes = await consumeWebAuthCallbackFromLocation(
			{
				pathname: "/u/cafelua/auth/callback",
				search: "",
				hash: "#key=gw-slug-owner-token-777&user_id=usr_cafelua&state=slug-callback-state",
			},
			replaceSlug,
		);
		expect(slugRes.ok).toBe(true);
		expect(replaceSlug).toHaveBeenCalledWith("/u/cafelua");
		expect(loadConfig()).toMatchObject({
			provider: "nextain",
			ttsProvider: "nextain",
			ttsVoice: "ko-KR-SunHi:DragonHDLatestNeural",
			onboardingComplete: true,
		});

		// 2) Direct portal handoff `/app#key=gw-...` without prior OAuth state (same-origin portal button)
		logoutWebSession();
		const replaceApp = vi.fn();
		const handoffRes = await consumeWebAuthCallbackFromLocation(
			{
				pathname: "/app",
				search: "",
				hash: "#key=gw-portal-direct-handoff-888&user_id=usr_portal_8&onboarding_complete=1",
			},
			replaceApp,
		);
		expect(handoffRes).toEqual({
			handled: true,
			ok: true,
			naiaKey: "gw-portal-direct-handoff-888",
			naiaUserId: "usr_portal_8",
		});
		expect(replaceApp).toHaveBeenCalledWith("/app");
	});

	it("consumes key, state, and user_id from URL hash (#) on /auth/callback and cleans URL to '/'", async () => {
		startWebLoginRedirect({
			origin: "https://web.naia.land",
			lang: "ko",
			state: "hash-state-ok",
			navigate: () => {},
		});
		window.history.replaceState(
			{},
			"",
			"/auth/callback#key=naia_live_hash_key_777&user_id=usr_hash_7&state=hash-state-ok",
		);

		const res = await consumeWebAuthCallbackFromLocation();

		expect(res).toEqual({
			handled: true,
			ok: true,
			naiaKey: "naia_live_hash_key_777",
			naiaUserId: "usr_hash_7",
		});
		expect(isWebAuthenticated()).toBe(true);
		expect(getWebAuthenticatedUserId()).toBe("usr_hash_7");
		expect(await getNaiaKey()).toBe("naia_live_hash_key_777");
		expect(window.location.pathname).toBe("/");
		expect(window.location.search).toBe("");
		expect(window.location.hash).toBe("");
	});

	it("returns state_mismatch when URL hash (#) state does not match pending state and cleans URL to '/'", async () => {
		startWebLoginRedirect({
			origin: "https://web.naia.land",
			lang: "ko",
			state: "expected-hash-state",
			navigate: () => {},
		});
		window.history.replaceState(
			{},
			"",
			"/auth/callback#key=naia_live_hash_key_777&user_id=usr_hash_7&state=wrong-hash-state",
		);

		const res = await consumeWebAuthCallbackFromLocation();

		expect(res).toEqual({
			handled: true,
			ok: false,
			error: "state_mismatch",
		});
		expect(isWebAuthenticated()).toBe(false);
		expect(window.location.pathname).toBe("/");
		expect(window.location.search).toBe("");
		expect(window.location.hash).toBe("");
	});

	it("prefers URL hash (#) over query (?) when both contain callback parameters and cleans URL to '/'", async () => {
		startWebLoginRedirect({
			origin: "https://web.naia.land",
			lang: "ko",
			state: "hash-priority-state",
			navigate: () => {},
		});
		window.history.replaceState(
			{},
			"",
			"/auth/callback?key=naia_live_query_key_111&code=gw-query-code-111&user_id=usr_query_1&state=query-wrong-state#key=naia_live_hash_key_222&code=gw-hash-code-222&user_id=usr_hash_2&state=hash-priority-state",
		);

		const res = await consumeWebAuthCallbackFromLocation();

		expect(res).toEqual({
			handled: true,
			ok: true,
			naiaKey: "naia_live_hash_key_222",
			naiaUserId: "usr_hash_2",
		});
		expect(await getNaiaKey()).toBe("naia_live_hash_key_222");
		expect(getWebAuthenticatedUserId()).toBe("usr_hash_2");
		expect(window.location.pathname).toBe("/");
		expect(window.location.search).toBe("");
		expect(window.location.hash).toBe("");
	});

	it("returns invalid_key and does not fall back to query key when hash (#) has valid state and empty key=", async () => {
		startWebLoginRedirect({
			origin: "https://web.naia.land",
			lang: "ko",
			state: "hash-empty-key-state",
			navigate: () => {},
		});
		window.history.replaceState(
			{},
			"",
			"/auth/callback?key=naia_live_query_valid_key_888#state=hash-empty-key-state&key=",
		);

		const res = await consumeWebAuthCallbackFromLocation();

		expect(res).toEqual({
			handled: true,
			ok: false,
			error: "invalid_key",
		});
		expect(isWebAuthenticated()).toBe(false);
		expect(await getNaiaKey()).toBeUndefined();
		expect(window.location.pathname).toBe("/");
		expect(window.location.search).toBe("");
		expect(window.location.hash).toBe("");
	});

	it("returns invalid_key and does not read query key when hash (#) contains only state", async () => {
		startWebLoginRedirect({
			origin: "https://web.naia.land",
			lang: "ko",
			state: "hash-only-state",
			navigate: () => {},
		});
		window.history.replaceState(
			{},
			"",
			"/auth/callback?key=naia_live_query_valid_key_999&user_id=usr_query_9#state=hash-only-state",
		);

		const res = await consumeWebAuthCallbackFromLocation();

		expect(res).toEqual({
			handled: true,
			ok: false,
			error: "invalid_key",
		});
		expect(isWebAuthenticated()).toBe(false);
		expect(await getNaiaKey()).toBeUndefined();
		expect(window.location.pathname).toBe("/");
		expect(window.location.search).toBe("");
		expect(window.location.hash).toBe("");
	});

	it("succeeds when hash (#) contains code=gw-... without key and cleans URL to '/'", async () => {
		startWebLoginRedirect({
			origin: "https://web.naia.land",
			lang: "ko",
			state: "hash-code-only-state",
			navigate: () => {},
		});
		window.history.replaceState(
			{},
			"",
			"/auth/callback#code=gw-live-hash-token-55555&user_id=usr_code_5&state=hash-code-only-state",
		);

		const res = await consumeWebAuthCallbackFromLocation();

		expect(res).toEqual({
			handled: true,
			ok: true,
			naiaKey: "gw-live-hash-token-55555",
			naiaUserId: "usr_code_5",
		});
		expect(isWebAuthenticated()).toBe(true);
		expect(await getNaiaKey()).toBe("gw-live-hash-token-55555");
		expect(getWebAuthenticatedUserId()).toBe("usr_code_5");
		expect(window.location.pathname).toBe("/");
		expect(window.location.search).toBe("");
		expect(window.location.hash).toBe("");
	});

	it("cleans URL to '/' even when callback key format is invalid", async () => {
		startWebLoginRedirect({
			origin: "https://web.naia.land",
			lang: "ko",
			state: "invalid-key-state",
			navigate: () => {},
		});
		window.history.replaceState(
			{},
			"",
			"/auth/callback#key=bad!&state=invalid-key-state",
		);

		const res = await consumeWebAuthCallbackFromLocation();

		expect(res).toEqual({
			handled: true,
			ok: false,
			error: "invalid_key",
		});
		expect(isWebAuthenticated()).toBe(false);
		expect(window.location.pathname).toBe("/");
		expect(window.location.search).toBe("");
		expect(window.location.hash).toBe("");
	});

	it("generateWebOAuthState returns a 64-char lowercase hex string, differs across calls, and throws without getRandomValues (surfacing error on WebLoginScreen)", () => {
		const s1 = generateWebOAuthState();
		const s2 = generateWebOAuthState();
		expect(s1).toMatch(/^[0-9a-f]{64}$/);
		expect(s2).toMatch(/^[0-9a-f]{64}$/);
		expect(s1).not.toBe(s2);

		const origCrypto = globalThis.crypto;
		Object.defineProperty(globalThis, "crypto", {
			value: {},
			configurable: true,
		});
		try {
			expect(() => generateWebOAuthState()).toThrow(/crypto\.getRandomValues/);

			render(createElement(WebLoginScreen));
			fireEvent.click(screen.getByTestId("web-login-submit"));
			const errAlert = screen.getByTestId("web-login-error");
			expect(errAlert.textContent).toMatch(/crypto\.getRandomValues/);
		} finally {
			Object.defineProperty(globalThis, "crypto", {
				value: origCrypto,
				configurable: true,
			});
		}
	});
	it.each([
		["key", "#key=naia_live_hash_only_key_111"],
		["user_id", "#user_id=usr_hash_only"],
		["code", "#code=gw-hash-only-code"],
	])(
		"reads only the hash when hash (#) has just %s, ignoring a valid query callback",
		async (_name, hash) => {
			startWebLoginRedirect({
				origin: "https://web.naia.land",
				lang: "ko",
				state: "query-valid-state",
				navigate: () => {},
			});
			window.history.replaceState(
				{},
				"",
				`/auth/callback?state=query-valid-state&key=naia_live_query_valid_key_777&user_id=usr_query${hash}`,
			);

			const res = await consumeWebAuthCallbackFromLocation();

			expect(res).toEqual({
				handled: true,
				ok: false,
				error: "state_mismatch",
			});
			expect(isWebAuthenticated()).toBe(false);
			expect(await getNaiaKey()).toBeUndefined();
			expect(window.location.pathname).toBe("/");
			expect(window.location.search).toBe("");
			expect(window.location.hash).toBe("");
		},
	);

	it("generateWebOAuthState asks getRandomValues for exactly 32 bytes", () => {
		const spy = vi.spyOn(globalThis.crypto, "getRandomValues");
		try {
			const s = generateWebOAuthState();
			expect(s).toMatch(/^[0-9a-f]{64}$/);
			expect(spy).toHaveBeenCalledTimes(1);
			const arg = spy.mock.calls[0][0] as Uint8Array;
			expect(arg).toBeInstanceOf(Uint8Array);
			expect(arg.length).toBe(32);
		} finally {
			spy.mockRestore();
		}
	});

	it("keeps onboardingComplete=false for brand-new Official Web SaaS logins (including over unauthenticated OPFS auto-seeds), preserves returning users, and keeps Kiosk Demo at true", async () => {
		// 1) Fresh official web login with no prior config -> onboardingComplete: false
		await completeWebNaiaLogin("naia_fresh_saas_key_12345", "usr_new_1");
		expect(loadConfig()?.onboardingComplete).toBe(false);
		expect(loadConfig()?.naiaUserId).toBe("usr_new_1");

		// 2) Even if OPFS INITIAL_WEB_WORKSPACE_CONFIG seeded an unauthenticated placeholder before login,
		// first real user login still enters Official Web Onboarding (onboardingComplete: false)
		logoutWebSession();
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "nextain",
				model: "gpt-6.1-terra",
				webAutoDefaultModel: true,
				onboardingComplete: true,
			}),
		);
		await completeWebNaiaLogin("naia_fresh_saas_key_67890", "usr_new_2");
		expect(loadConfig()?.onboardingComplete).toBe(false);

		// 3) Once usr_new_2 completes onboarding, re-logging in as usr_new_2 preserves onboardingComplete: true
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				...loadConfig(),
				naiaUserId: "usr_new_2",
				userName: "루크",
				onboardingComplete: true,
			}),
		);
		await completeWebNaiaLogin("naia_returning_saas_key_222", "usr_new_2");
		expect(loadConfig()?.onboardingComplete).toBe(true);

		// 4) Switching directly to a different account without server onboarding_complete=true enters onboarding
		await completeWebNaiaLogin("naia_switched_user_key_333", "usr_new_3");
		expect(loadConfig()?.onboardingComplete).toBe(false);

		// 5) Server OAuth callback onboarding_complete=1 marks returning user complete on a fresh browser
		localStorage.clear();
		startWebLoginRedirect({
			origin: "https://app.naia.land",
			lang: "ko",
			state: "returning-callback-state",
			navigate: () => {},
		});
		await consumeWebAuthCallbackFromLocation(
			{
				pathname: "/auth/callback",
				search: "",
				hash: "#key=gw-returning-server-flag-999&user_id=usr_returning&onboarding_complete=1&state=returning-callback-state",
			},
			() => {},
		);
		expect(loadConfig()?.onboardingComplete).toBe(true);

		// 6) Kiosk Demo mode always preserves onboardingComplete: true
		localStorage.clear();
		vi.stubEnv("MODE", "web");
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "1");
		try {
			await completeWebNaiaLogin("gw-kiosk-demo-key-123456", undefined);
			expect(loadConfig()?.onboardingComplete).toBe(true);
		} finally {
			vi.unstubAllEnvs();
		}
	});
});

describe("web boot workspace selection", () => {
	it("reads the persisted local provider and model even if the cache is absent", async () => {
		const { readWebBootSelection } = await import("../auto-install");
		const readText = vi.fn(async () =>
			JSON.stringify({
				provider: "nextain",
				model: "server",
				llmRoles: {
					main: { provider: "webllm", model: "Qwen3-4B-q4f32_1-MLC" },
				},
			}),
		);
		expect(await readWebBootSelection({ readText })).toEqual({
			provider: "webllm",
			model: "Qwen3-4B-q4f32_1-MLC",
		});
		expect(readText).toHaveBeenCalledWith("naia-adk/naia-settings/config.json");
	});
});

describe("web workspace selection recovery", () => {
	it("retains the authenticated server selection after a cache mismatch", async () => {
		setWebAssetsModeForTests(true);
		const { createMemoryWebFs } = await import("../web-fs");
		const { handleWebWorkspaceCommand } = await import(
			"../web-workspace-commands"
		);
		const { readWebBootSelection } = await import("../auto-install");
		const fs = createMemoryWebFs();
		localStorage.setItem(
			"naia-config",
			JSON.stringify({ provider: "webllm", model: "Qwen3-4B-q4f16_1-MLC" }),
		);
		localStorage.setItem("naia-remote-key", "test-login-key-1234");
		await handleWebWorkspaceCommand(
			"write_naia_config",
			{
				adkPath: "opfs://naia-adk",
				json: JSON.stringify({
					provider: "nextain",
					model: "deepseek-v4-flash",
					llmRoles: {
						main: { provider: "nextain", model: "deepseek-v4-flash" },
					},
				}),
			},
			fs,
		);
		expect(await readWebBootSelection(fs)).toEqual({
			provider: "nextain",
			model: "deepseek-v4-flash",
		});
		expect(isWebAuthenticated()).toBe(true);
		expect(await getNaiaKeySecure()).toBe("test-login-key-1234");
		localStorage.clear();
		setWebAssetsModeForTests(null);
	});
	it("rejects unreadable or malformed workspace config rather than trusting a stale cache", async () => {
		const { readWebBootSelection } = await import("../auto-install");
		await expect(
			readWebBootSelection({
				readText: async () => {
					throw new Error("storage failure");
				},
			}),
		).rejects.toThrow("storage failure");
		await expect(
			readWebBootSelection({ readText: async () => "{" }),
		).rejects.toThrow();
		await expect(
			readWebBootSelection({ readText: async () => "{}" }),
		).rejects.toThrow("provider missing");
		expect(
			await readWebBootSelection({ readText: async () => null }),
		).toBeNull();
	});
});
