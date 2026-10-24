// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getNaiaKey, hasNaiaKey, loadConfig } from "../../config";
import { bootWebRuntimeAndModel } from "../auto-install";
import { setWebAssetsModeForTests } from "../web-assets";
import {
	WEB_OAUTH_STATE_STORAGE_KEY,
	buildWebLoginRedirectUrl,
	completeWebNaiaLogin,
	consumeWebAuthCallbackFromLocation,
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

	it("defaults login base URL to https://dev.naia.land and allows env override", () => {
		expect(getWebLoginBaseUrl()).toBe("https://dev.naia.land");
		expect(getWebLoginBaseUrl("https://naia.land/")).toBe("https://naia.land");
	});

	it("requires login by default in web mode and allows disabling via VITE_NAIA_WEB_LOGIN_REQUIRED=0", () => {
		expect(isWebLoginRequired()).toBe(true);
		expect(isWebLoginRequired("0")).toBe(false);
		expect(isWebLoginRequired("false")).toBe(false);
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
		expect(parsed.origin).toBe("https://dev.naia.land");
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

	it("defers startWebModel until login completes when login gate is enabled, and starts immediately when disabled", async () => {
		const startModel = vi.fn(async () => {});

		// 1. Login required and not authenticated -> does not start model at boot
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

		// 3. When login gate is disabled (VITE_NAIA_WEB_LOGIN_REQUIRED=0), starts immediately even when logged out
		logoutWebSession();
		setWebLoginRequiredForTests(false);
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
});
