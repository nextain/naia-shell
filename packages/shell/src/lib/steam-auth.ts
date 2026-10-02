import { invoke } from "@tauri-apps/api/core";
import { LAB_GATEWAY_URL } from "./config";
import { Logger } from "./logger";

export interface SteamStatus {
	available: boolean;
	reason?: string;
	steam_id_present: boolean;
}

export interface SteamLoginResponse {
	user_id: string;
	is_new_user: boolean;
	api_key: string;
	tokens?: Record<string, unknown>;
}

export interface SteamLoginAttemptBoundary {
	adkPath: string | null;
	secureStorePath: string | null;
	attemptId: string;
}

export interface SteamLoginOptions {
	gatewayUrl?: string;
	deviceId?: string;
	appVersion?: string;
	boundary: SteamLoginAttemptBoundary;
	getCurrentBoundary: () => SteamLoginAttemptBoundary;
	onConsentRequired: () => Promise<boolean>;
}

export interface SteamLinkIdentityResult {
	success: boolean;
	errorCode?: string;
	error?: string;
}

export interface GatewayErrorDetail {
	error?: string;
	[key: string]: unknown;
}

export interface GatewayErrorResponse {
	detail?: GatewayErrorDetail;
	[key: string]: unknown;
}

/**
 * Extracts error code from gateway response structure {"detail": {"error": "<CODE>"}}.
 * Returns null if the structure cannot be parsed.
 */
export function parseGatewayErrorCode(data: unknown): string | null {
	if (
		typeof data === "object" &&
		data !== null &&
		"detail" in data &&
		typeof (data as GatewayErrorResponse).detail === "object" &&
		(data as GatewayErrorResponse).detail !== null &&
		typeof (data as GatewayErrorResponse).detail?.error === "string"
	) {
		return (data as GatewayErrorResponse).detail!.error!;
	}
	return null;
}

export async function getSteamStatus(): Promise<SteamStatus> {
	try {
		return await invoke<SteamStatus>("steam_status");
	} catch (err) {
		return {
			available: false,
			reason: String(err),
			steam_id_present: false,
		};
	}
}

export async function getSteamWebApiTicket(): Promise<string> {
	const res = await invoke<{ ticket_hex: string }>("steam_get_web_api_ticket");
	return res.ticket_hex;
}

/**
 * Executes the Steam login flow against the Naia Gateway:
 * 1. Checks Steam availability.
 * 2. Gets Web API auth ticket for "naia-gateway".
 * 3. Sends POST /v1/auth/steam/login with terms_agreed: false.
 * 4. If 409 consent_required, prompts user for consent; on consent, requests fresh ticket and retries with terms_agreed: true.
 * 5. Verifies API key starts with "gw-".
 * 6. Asserts attempt boundary (same attemptId, same adkPath, same secureStorePath) before emitting auth event.
 * 7. Invokes complete_naia_auth to trigger naia_auth_complete event across shell listeners.
 */
export async function performSteamLogin(
	options: SteamLoginOptions,
): Promise<SteamLoginResponse> {
	const baseUrl = (options.gatewayUrl || LAB_GATEWAY_URL).replace(/\/+$/, "");

	// Step 1: Steam status check
	const status = await getSteamStatus();
	if (!status.available) {
		const msg = status.reason || "Steam is not running or unavailable";
		Logger.warn("SteamAuth", "Steam status unavailable", { reason: status.reason });
		throw new Error(msg);
	}

	// Boundary check before starting network requests
	const checkBoundary = () => {
		const current = options.getCurrentBoundary();
		if (
			current.attemptId !== options.boundary.attemptId ||
			current.adkPath !== options.boundary.adkPath ||
			current.secureStorePath !== options.boundary.secureStorePath
		) {
			throw new Error("Login attempt aborted: boundary changed");
		}
	};
	checkBoundary();

	// Step 2: Request Web API ticket
	Logger.debug("SteamAuth", "Requesting Steam Web API ticket");
	const ticketHex = await getSteamWebApiTicket();
	checkBoundary();

	const sendLogin = async (ticket: string, termsAgreed: boolean): Promise<Response> => {
		const body: Record<string, unknown> = {
			ticket_hex: ticket,
			terms_agreed: termsAgreed,
		};
		if (options.deviceId) body.device_id = options.deviceId;
		if (options.appVersion) body.app_version = options.appVersion;

		return await fetch(`${baseUrl}/v1/auth/steam/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	};

	let response = await sendLogin(ticketHex, false);

	if (response.status === 409) {
		let errorData: unknown;
		try {
			errorData = await response.json();
		} catch {
			throw new Error("Steam login failed: invalid error response from gateway");
		}
		const errorCode = parseGatewayErrorCode(errorData);

		if (errorCode === "consent_required") {
			Logger.info("SteamAuth", "Terms consent required for new Steam user");
			const consented = await options.onConsentRequired();
			if (!consented) {
				throw new Error("Consent declined");
			}
			checkBoundary();

			// Request a fresh ticket for the second attempt
			Logger.debug("SteamAuth", "Requesting fresh ticket after consent");
			const freshTicket = await getSteamWebApiTicket();
			checkBoundary();

			response = await sendLogin(freshTicket, true);
		} else {
			throw new Error(
				errorCode ? `Steam login failed: ${errorCode}` : "Steam login failed (409)",
			);
		}
	}

	if (!response.ok) {
		let errorData: unknown;
		try {
			errorData = await response.json();
		} catch {
			throw new Error(`Steam login failed: HTTP ${response.status}`);
		}
		const errorCode = parseGatewayErrorCode(errorData);
		if (response.status === 401 && errorCode === "steam_ticket_invalid") {
			throw new Error("Steam ticket invalid");
		}
		throw new Error(
			errorCode
				? `Steam login failed: ${errorCode}`
				: `Steam login failed: HTTP ${response.status}`,
		);
	}

	let data: SteamLoginResponse;
	try {
		data = (await response.json()) as SteamLoginResponse;
	} catch {
		throw new Error("Steam login failed: invalid JSON response");
	}

	if (!data.api_key || typeof data.api_key !== "string") {
		throw new Error("Steam login failed: missing api_key");
	}

	if (!data.api_key.startsWith("gw-")) {
		throw new Error("Invalid API key format: missing gw- prefix");
	}

	// Final boundary check right before emitting naia_auth_complete
	checkBoundary();

	Logger.info("SteamAuth", "Steam login successful, completing naia auth", {
		userId: data.user_id,
		isNewUser: data.is_new_user,
	});

	await invoke("complete_naia_auth", {
		naiaKey: data.api_key,
		naiaUserId: data.user_id,
	});

	return data;
}

/**
 * Links the current Steam account to an already-authenticated Naia account.
 * Endpoint: POST /v1/auth/identities/steam/link
 */
export async function steamLinkIdentity(
	naiaKey: string,
	options?: { gatewayUrl?: string },
): Promise<SteamLinkIdentityResult> {
	const baseUrl = (options?.gatewayUrl || LAB_GATEWAY_URL).replace(/\/+$/, "");

	const status = await getSteamStatus();
	if (!status.available) {
		return {
			success: false,
			errorCode: "steam_unavailable",
			error: status.reason || "Steam is not running or unavailable",
		};
	}

	let ticketHex: string;
	try {
		ticketHex = await getSteamWebApiTicket();
	} catch (err) {
		return {
			success: false,
			errorCode: "ticket_failed",
			error: String(err),
		};
	}

	let response: Response;
	try {
		response = await fetch(`${baseUrl}/v1/auth/identities/steam/link`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-AnyLLM-Key": `Bearer ${naiaKey}`,
			},
			body: JSON.stringify({ ticket_hex: ticketHex }),
		});
	} catch (err) {
		return {
			success: false,
			errorCode: "network_error",
			error: String(err),
		};
	}

	if (!response.ok) {
		let errorData: unknown;
		try {
			errorData = await response.json();
		} catch {
			return {
				success: false,
				errorCode: `http_${response.status}`,
				error: `Identity link failed: HTTP ${response.status}`,
			};
		}

		const errorCode = parseGatewayErrorCode(errorData);
		if (response.status === 409 && errorCode === "identity_linked_elsewhere") {
			return {
				success: false,
				errorCode: "identity_linked_elsewhere",
				error: "이 Steam 계정은 다른 나이아 계정에 연결되어 있습니다",
			};
		}

		return {
			success: false,
			errorCode: errorCode || `http_${response.status}`,
			error: errorCode ? `Identity link failed: ${errorCode}` : `HTTP ${response.status}`,
		};
	}

	return { success: true };
}
