// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(async (cmd: string, ...args: unknown[]) => {
		if (cmd === "frontend_log") return Promise.resolve();
		return invokeMock(cmd, ...args);
	}),
}));

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;

import {
	getSteamStatus,
	getSteamWebApiTicket,
	parseGatewayErrorCode,
	performSteamLogin,
	steamLinkIdentity,
} from "../steam-auth";

describe("steam-auth client (#729)", () => {
	beforeEach(() => {
		invokeMock.mockReset();
		fetchMock.mockReset();
	});

	describe("parseGatewayErrorCode", () => {
		it("extracts error code from { detail: { error: code } }", () => {
			expect(parseGatewayErrorCode({ detail: { error: "consent_required" } })).toBe(
				"consent_required",
			);
			expect(
				parseGatewayErrorCode({ detail: { error: "identity_linked_elsewhere" } }),
			).toBe("identity_linked_elsewhere");
		});

		it("returns null for malformed or top-level error structures", () => {
			expect(parseGatewayErrorCode({ error: "consent_required" })).toBeNull();
			expect(parseGatewayErrorCode(null)).toBeNull();
			expect(parseGatewayErrorCode("not json")).toBeNull();
			expect(parseGatewayErrorCode({})).toBeNull();
			expect(parseGatewayErrorCode({ detail: {} })).toBeNull();
			expect(parseGatewayErrorCode({ detail: { error: 123 } })).toBeNull();
		});
	});

	describe("getSteamStatus", () => {
		it("returns available status from tauri invoke", async () => {
			invokeMock.mockResolvedValueOnce({
				available: true,
				reason: undefined,
				steam_id_present: true,
			});
			const status = await getSteamStatus();
			expect(status.available).toBe(true);
			expect(status.steam_id_present).toBe(true);
			expect(invokeMock).toHaveBeenCalledWith("steam_status");
		});

		it("handles invoke failure gracefully", async () => {
			invokeMock.mockRejectedValueOnce(new Error("steam failed"));
			const status = await getSteamStatus();
			expect(status.available).toBe(false);
			expect(status.reason).toContain("steam failed");
		});
	});

	describe("getSteamWebApiTicket", () => {
		it("returns ticket_hex from tauri invoke", async () => {
			invokeMock.mockResolvedValueOnce({ ticket_hex: "deadbeef" });
			const ticket = await getSteamWebApiTicket();
			expect(ticket).toBe("deadbeef");
			expect(invokeMock).toHaveBeenCalledWith("steam_get_web_api_ticket");
		});
	});

	describe("performSteamLogin", () => {
		const defaultBoundary = {
			attemptId: "att-1",
			adkPath: "/home/user/naia-adk",
			secureStorePath: "/home/user/.secure-store",
		};

		it("logs in successfully on first attempt when terms already agreed", async () => {
			invokeMock
				.mockResolvedValueOnce({ available: true, steam_id_present: true }) // steam_status
				.mockResolvedValueOnce({ ticket_hex: "ticket123" }) // steam_get_web_api_ticket
				.mockResolvedValueOnce(undefined); // complete_naia_auth

			fetchMock.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({
					user_id: "user-1",
					is_new_user: false,
					api_key: "gw-validkey123",
				}),
			});

			const onConsentRequired = vi.fn().mockResolvedValue(true);
			const result = await performSteamLogin({
				gatewayUrl: "https://api.naia.test",
				boundary: { ...defaultBoundary },
				getCurrentBoundary: () => ({ ...defaultBoundary }),
				onConsentRequired,
			});

			expect(result.user_id).toBe("user-1");
			expect(result.api_key).toBe("gw-validkey123");
			expect(onConsentRequired).not.toHaveBeenCalled();

			expect(fetchMock).toHaveBeenCalledTimes(1);
			const [url, req] = fetchMock.mock.calls[0];
			expect(url).toBe("https://api.naia.test/v1/auth/steam/login");
			expect(JSON.parse(req.body)).toEqual({
				ticket_hex: "ticket123",
				terms_agreed: false,
			});

			expect(invokeMock).toHaveBeenCalledWith("complete_naia_auth", {
				naiaKey: "gw-validkey123",
				naiaUserId: "user-1",
			});
		});

		it("handles 409 consent_required flow by prompting consent and retrying with fresh ticket", async () => {
			invokeMock
				.mockResolvedValueOnce({ available: true, steam_id_present: true }) // steam_status
				.mockResolvedValueOnce({ ticket_hex: "ticket-attempt1" }) // first ticket
				.mockResolvedValueOnce({ ticket_hex: "ticket-attempt2" }) // fresh ticket after consent
				.mockResolvedValueOnce(undefined); // complete_naia_auth

			fetchMock
				// First request returns 409 consent_required
				.mockResolvedValueOnce({
					ok: false,
					status: 409,
					json: async () => ({
						detail: { error: "consent_required" },
					}),
				})
				// Second request returns 200 OK
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: async () => ({
						user_id: "user-new",
						is_new_user: true,
						api_key: "gw-newkey789",
					}),
				});

			const onConsentRequired = vi.fn().mockResolvedValue(true);
			const result = await performSteamLogin({
				gatewayUrl: "https://api.naia.test",
				boundary: { ...defaultBoundary },
				getCurrentBoundary: () => ({ ...defaultBoundary }),
				onConsentRequired,
			});

			expect(onConsentRequired).toHaveBeenCalledTimes(1);
			expect(fetchMock).toHaveBeenCalledTimes(2);

			// First request: terms_agreed false
			expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
				ticket_hex: "ticket-attempt1",
				terms_agreed: false,
			});

			// Second request: fresh ticket and terms_agreed true
			expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
				ticket_hex: "ticket-attempt2",
				terms_agreed: true,
			});

			expect(result.user_id).toBe("user-new");
			expect(invokeMock).toHaveBeenCalledWith("complete_naia_auth", {
				naiaKey: "gw-newkey789",
				naiaUserId: "user-new",
			});
		});

		it("aborts when user declines consent", async () => {
			invokeMock
				.mockResolvedValueOnce({ available: true, steam_id_present: true })
				.mockResolvedValueOnce({ ticket_hex: "ticket-attempt1" });

			fetchMock.mockResolvedValueOnce({
				ok: false,
				status: 409,
				json: async () => ({
					detail: { error: "consent_required" },
				}),
			});

			const onConsentRequired = vi.fn().mockResolvedValue(false);
			await expect(
				performSteamLogin({
					gatewayUrl: "https://api.naia.test",
					boundary: { ...defaultBoundary },
					getCurrentBoundary: () => ({ ...defaultBoundary }),
					onConsentRequired,
				}),
			).rejects.toThrow(/Consent declined/);

			expect(onConsentRequired).toHaveBeenCalledTimes(1);
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(invokeMock).not.toHaveBeenCalledWith(
				"complete_naia_auth",
				expect.anything(),
			);
		});

		it("fails if Steam is not available", async () => {
			invokeMock.mockResolvedValueOnce({
				available: false,
				reason: "Steam client is closed",
				steam_id_present: false,
			});

			await expect(
				performSteamLogin({
					boundary: { ...defaultBoundary },
					getCurrentBoundary: () => ({ ...defaultBoundary }),
					onConsentRequired: vi.fn(),
				}),
			).rejects.toThrow("Steam client is closed");

			expect(fetchMock).not.toHaveBeenCalled();
		});

		it("fails on 401 steam_ticket_invalid", async () => {
			invokeMock
				.mockResolvedValueOnce({ available: true, steam_id_present: true })
				.mockResolvedValueOnce({ ticket_hex: "badticket" });

			fetchMock.mockResolvedValueOnce({
				ok: false,
				status: 401,
				json: async () => ({
					detail: { error: "steam_ticket_invalid" },
				}),
			});

			await expect(
				performSteamLogin({
					boundary: { ...defaultBoundary },
					getCurrentBoundary: () => ({ ...defaultBoundary }),
					onConsentRequired: vi.fn(),
				}),
			).rejects.toThrow("Steam ticket invalid");

			expect(invokeMock).not.toHaveBeenCalledWith(
				"complete_naia_auth",
				expect.anything(),
			);
		});

		it("aborts and refuses to save/emit key if ADK path or attempt changes before completion", async () => {
			invokeMock
				.mockResolvedValueOnce({ available: true, steam_id_present: true })
				.mockResolvedValueOnce({ ticket_hex: "ticket123" });

			fetchMock.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({
					user_id: "user-1",
					is_new_user: false,
					api_key: "gw-validkey123",
				}),
			});

			let currentPath = defaultBoundary.adkPath;

			await expect(
				performSteamLogin({
					gatewayUrl: "https://api.naia.test",
					boundary: { ...defaultBoundary },
					getCurrentBoundary: () => {
						// Simulate ADK drift right before completion
						currentPath = "/different/adk/path";
						return {
							...defaultBoundary,
							adkPath: currentPath,
						};
					},
					onConsentRequired: vi.fn(),
				}),
			).rejects.toThrow("Login attempt aborted: boundary changed");

			expect(invokeMock).not.toHaveBeenCalledWith(
				"complete_naia_auth",
				expect.anything(),
			);
		});

		it("aborts if api_key does not start with gw-", async () => {
			invokeMock
				.mockResolvedValueOnce({ available: true, steam_id_present: true })
				.mockResolvedValueOnce({ ticket_hex: "ticket123" });

			fetchMock.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({
					user_id: "user-1",
					is_new_user: false,
					api_key: "bad-prefix-key",
				}),
			});

			await expect(
				performSteamLogin({
					boundary: { ...defaultBoundary },
					getCurrentBoundary: () => ({ ...defaultBoundary }),
					onConsentRequired: vi.fn(),
				}),
			).rejects.toThrow("Invalid API key format");

			expect(invokeMock).not.toHaveBeenCalledWith(
				"complete_naia_auth",
				expect.anything(),
			);
		});
	});

	describe("steamLinkIdentity", () => {
		it("links steam identity successfully", async () => {
			invokeMock
				.mockResolvedValueOnce({ available: true, steam_id_present: true })
				.mockResolvedValueOnce({ ticket_hex: "linkticket123" });

			fetchMock.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ status: "ok" }),
			});

			const res = await steamLinkIdentity("gw-testkey", {
				gatewayUrl: "https://api.naia.test",
			});
			expect(res.success).toBe(true);

			expect(fetchMock).toHaveBeenCalledWith(
				"https://api.naia.test/v1/auth/identities/steam/link",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-AnyLLM-Key": "Bearer gw-testkey",
					},
					body: JSON.stringify({ ticket_hex: "linkticket123" }),
				},
			);
		});

		it("returns identity_linked_elsewhere with user friendly error", async () => {
			invokeMock
				.mockResolvedValueOnce({ available: true, steam_id_present: true })
				.mockResolvedValueOnce({ ticket_hex: "linkticket123" });

			fetchMock.mockResolvedValueOnce({
				ok: false,
				status: 409,
				json: async () => ({
					detail: { error: "identity_linked_elsewhere" },
				}),
			});

			const res = await steamLinkIdentity("gw-testkey", {
				gatewayUrl: "https://api.naia.test",
			});
			expect(res.success).toBe(false);
			expect(res.errorCode).toBe("identity_linked_elsewhere");
			expect(res.error).toBe("이 Steam 계정은 다른 나이아 계정에 연결되어 있습니다");
		});

		it("returns failure when Steam is unavailable", async () => {
			invokeMock.mockResolvedValueOnce({
				available: false,
				reason: "Steam offline",
				steam_id_present: false,
			});

			const res = await steamLinkIdentity("gw-testkey");
			expect(res.success).toBe(false);
			expect(res.errorCode).toBe("steam_unavailable");
			expect(fetchMock).not.toHaveBeenCalled();
		});
	});
});
