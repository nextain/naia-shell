// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCachedLabCredits, readCachedLabCredits } from "../lab-balance";
import {
	WEB_REMOTE_KEY_STORAGE_KEY,
	WEB_REMOTE_USER_ID_STORAGE_KEY,
	seedKioskDemoWebAuth,
	verifyKioskDemoWebAuth,
} from "../web-runtime/web-auth";
import {
	KIOSK_DEMO_REFRESH_LEAD_MS,
	KIOSK_DEMO_SESSION_STORAGE_KEY,
	ensureKioskDemoSession,
	readActiveKioskDemoSession,
} from "./demo-session";
import { clearKioskVisitActivity } from "./entry";

const sendAuthUpdateMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../chat-service", () => ({
	sendAuthUpdate: sendAuthUpdateMock,
}));

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("keyless kiosk demo session channel", () => {
	beforeEach(() => {
		localStorage.clear();
		sessionStorage.clear();
		clearCachedLabCredits();
		sendAuthUpdateMock.mockClear();
		vi.stubEnv("MODE", "web");
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "1");
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it("mints a short-lived token via POST /v1/demo/session, stores it without user_id, and primes credits", async () => {
		localStorage.setItem(WEB_REMOTE_USER_ID_STORAGE_KEY, "personal-user-123");
		const now = 1_763_440_000_000;
		const expIso = new Date(now + 1_800_000).toISOString();
		const fetchSession = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe("https://api.example.test/v1/demo/session");
				expect(init?.method).toBe("POST");
				return jsonResponse(200, {
					token: "demo.short-lived-jwt-fixture.sig1",
					expires_at: expIso,
					ttl_seconds: 1800,
					max_chat_turns: 40,
					remaining_chat_turns: 40,
					credits: 40,
				});
			},
		) as unknown as typeof fetch;

		const res = await ensureKioskDemoSession({
			gatewayUrl: "https://api.example.test/",
			fetchSession,
			now,
		});
		expect(res).toEqual({
			ok: true,
			token: "demo.short-lived-jwt-fixture.sig1",
			expiresAtMs: Date.parse(expIso),
			credits: 40,
			refreshed: true,
		});
		expect(fetchSession).toHaveBeenCalledOnce();
		expect(localStorage.getItem(WEB_REMOTE_KEY_STORAGE_KEY)).toBe(
			"demo.short-lived-jwt-fixture.sig1",
		);
		expect(localStorage.getItem(WEB_REMOTE_USER_ID_STORAGE_KEY)).toBeNull();
		expect(readCachedLabCredits(60_000)?.value).toBe(40);

		// Subsequent call in the same tab reuses sessionStorage without extra HTTP round-trip
		const reused = await ensureKioskDemoSession({
			gatewayUrl: "https://api.example.test/",
			fetchSession,
			now: now + 60_000,
		});
		expect(reused.ok).toBe(true);
		if (reused.ok) {
			expect(reused.refreshed).toBe(false);
			expect(reused.token).toBe("demo.short-lived-jwt-fixture.sig1");
		}
		expect(fetchSession).toHaveBeenCalledOnce();

		// Near-expiry (within KIOSK_DEMO_REFRESH_LEAD_MS) triggers proactive renewal
		const nearExpiryFetch = vi.fn(async () =>
			jsonResponse(200, {
				token: "demo.short-lived-jwt-fixture.sig2",
				expires_at: new Date(now + 3_600_000).toISOString(),
				ttl_seconds: 1800,
				credits: 35,
			}),
		) as unknown as typeof fetch;
		const renewed = await ensureKioskDemoSession({
			gatewayUrl: "https://api.example.test",
			fetchSession: nearExpiryFetch,
			now: Date.parse(expIso) - KIOSK_DEMO_REFRESH_LEAD_MS + 1_000,
		});
		expect(renewed.ok).toBe(true);
		expect(localStorage.getItem(WEB_REMOTE_KEY_STORAGE_KEY)).toBe(
			"demo.short-lived-jwt-fixture.sig2",
		);
	});

	it("deduplicates concurrent default-gateway session requests into a single HTTP call", async () => {
		let resolveFetch!: (res: Response) => void;
		const globalFetch = vi.fn(
			() =>
				new Promise<Response>((r) => {
					resolveFetch = r;
				}),
		);
		vi.stubGlobal("fetch", globalFetch);

		const p1 = seedKioskDemoWebAuth();
		const p2 = ensureKioskDemoSession();
		expect(globalFetch).toHaveBeenCalledOnce();

		resolveFetch(
			jsonResponse(200, {
				token: "demo.singleflight-token-fixture.sig",
				ttl_seconds: 1800,
				credits: 40,
			}),
		);
		const [r1, r2] = await Promise.all([p1, p2]);
		expect(r1).toBe(true);
		expect(r2.ok).toBe(true);
		expect(globalFetch).toHaveBeenCalledOnce();
	});

	it("wipes pre-existing personal login keys and maps 503/403/429/network errors accurately", async () => {
		// 503 demo_not_configured -> missing-key & personal key wiped
		localStorage.setItem(
			WEB_REMOTE_KEY_STORAGE_KEY,
			"gw-personal-secret-key-do-not-reuse",
		);
		const res503 = await ensureKioskDemoSession({
			gatewayUrl: "https://api.example.test",
			fetchSession: (async () =>
				jsonResponse(503, {
					detail: { error_code: "demo_not_configured" },
				})) as unknown as typeof fetch,
		});
		expect(res503).toEqual({ ok: false, reason: "missing-key" });
		expect(localStorage.getItem(WEB_REMOTE_KEY_STORAGE_KEY)).toBeNull();

		// 403 origin_forbidden -> missing-key
		const resOrigin = await ensureKioskDemoSession({
			gatewayUrl: "https://api.example.test",
			fetchSession: (async () =>
				jsonResponse(403, {
					detail: { error_code: "origin_forbidden" },
				})) as unknown as typeof fetch,
		});
		expect(resOrigin).toEqual({ ok: false, reason: "missing-key" });

		// 403 demo_unavailable & 429 rate_limit_exceeded -> unavailable
		const resUnavail = await ensureKioskDemoSession({
			gatewayUrl: "https://api.example.test",
			fetchSession: (async () =>
				jsonResponse(403, {
					detail: { error_code: "demo_unavailable" },
				})) as unknown as typeof fetch,
		});
		expect(resUnavail).toEqual({ ok: false, reason: "unavailable" });

		const res429 = await ensureKioskDemoSession({
			gatewayUrl: "https://api.example.test",
			fetchSession: (async () =>
				jsonResponse(429, {
					detail: { error_code: "rate_limit_exceeded" },
				})) as unknown as typeof fetch,
		});
		expect(res429).toEqual({ ok: false, reason: "unavailable" });

		// Transient 502 retries once (2 attempts) -> lookup-failed
		let attempts = 0;
		const res502 = await ensureKioskDemoSession({
			gatewayUrl: "https://api.example.test",
			fetchSession: (async () => {
				attempts += 1;
				return jsonResponse(502, { error: "bad_gateway" });
			}) as unknown as typeof fetch,
		});
		expect(attempts).toBe(2);
		expect(res502).toEqual({ ok: false, reason: "lookup-failed" });
	});

	it("refreshes an expired demo token once on HTTP 401 from /v1/profile/balance and pushes sendAuthUpdate", async () => {
		sessionStorage.setItem(
			KIOSK_DEMO_SESSION_STORAGE_KEY,
			JSON.stringify({
				token: "demo.stale-cached-token.sig",
				expiresAtMs: Date.now() + 600_000,
			}),
		);
		localStorage.setItem(
			WEB_REMOTE_KEY_STORAGE_KEY,
			"demo.stale-cached-token.sig",
		);

		const fetchSession = vi.fn(async () =>
			jsonResponse(200, {
				token: "demo.fresh-rotated-token.sig",
				ttl_seconds: 1800,
				credits: 25,
			}),
		) as unknown as typeof fetch;

		const seenKeys: string[] = [];
		const verified = await verifyKioskDemoWebAuth({
			gatewayUrl: "https://api.example.test",
			fetchSession,
			fetchBalance: async (_url, key) => {
				seenKeys.push(key);
				if (key === "demo.stale-cached-token.sig") {
					throw new Error("HTTP 401");
				}
				return { credits: 25 };
			},
		});

		expect(verified).toEqual({ ok: true, credits: 25 });
		expect(seenKeys).toEqual([
			"demo.stale-cached-token.sig",
			"demo.fresh-rotated-token.sig",
		]);
		expect(fetchSession).toHaveBeenCalledOnce();
		await vi.waitFor(() =>
			expect(sendAuthUpdateMock).toHaveBeenCalledWith(
				"demo.fresh-rotated-token.sig",
			),
		);
	});

	it("clears tab demo session on clearKioskVisitActivity while vite.config.ts strips VITE_NAIA_KIOSK_DEMO_KEY", () => {
		sessionStorage.setItem(
			KIOSK_DEMO_SESSION_STORAGE_KEY,
			JSON.stringify({
				token: "demo.visitor-one-token.sig",
				expiresAtMs: Date.now() + 900_000,
			}),
		);
		expect(readActiveKioskDemoSession()).not.toBeNull();
		clearKioskVisitActivity();
		expect(readActiveKioskDemoSession()).toBeNull();

		const webAuthSource = readFileSync(
			resolve(__dirname, "../web-runtime/web-auth.ts"),
			"utf8",
		);
		expect(webAuthSource).not.toContain("VITE_NAIA_KIOSK_DEMO_KEY");

		const viteConfigSource = readFileSync(
			resolve(__dirname, "../../../vite.config.ts"),
			"utf8",
		);
		expect(viteConfigSource).toContain(
			'Reflect.deleteProperty(process.env, "VITE_NAIA_KIOSK_DEMO_KEY")',
		);
		expect(viteConfigSource).toContain(
			'"import.meta.env.VITE_NAIA_KIOSK_DEMO_KEY": "undefined"',
		);
	});
});
