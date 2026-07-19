// Discord 설정의 순수 설치/preflight 정책만 소유한다.
// raw token 저장·IPC·UI 결선은 opaque native secret operation 계약 뒤에만 추가한다.

export const DISCORD_GATEWAY_INTENTS = [1, 512, 32_768] as const;
export const DISCORD_BOT_PERMISSIONS = 68_608;
export const DISCORD_PREFLIGHT_CODES = [
	"network_unavailable",
	"rate_limited",
	"token_invalid",
	"intent_missing",
	"guild_not_installed",
	"channel_not_visible",
	"permission_missing",
	"agent_offline",
] as const;

const MAX_U64 = 18_446_744_073_709_551_615n;

export function isCanonicalPositiveUint64Decimal(value: unknown): value is string {
	if (typeof value !== "string") return false;
	if (!/^[1-9][0-9]{0,19}$/.test(value)) return false;
	try {
		return BigInt(value) <= MAX_U64;
	} catch {
		return false;
	}
}

export function buildDiscordInstallUrl(clientId: string): string {
	if (!isCanonicalPositiveUint64Decimal(clientId)) throw new Error("invalid_discord_client_id_format");
	const url = new URL("https://discord.com/oauth2/authorize");
	url.searchParams.set("client_id", clientId);
	url.searchParams.set("scope", "bot");
	url.searchParams.set("permissions", String(DISCORD_BOT_PERMISSIONS));
	return url.toString();
}

export type DiscordPreflightCode = (typeof DISCORD_PREFLIGHT_CODES)[number];

export interface DiscordPreflightFacts {
	readonly networkReachable: boolean;
	readonly rateLimited: boolean;
	readonly tokenValid: boolean;
	readonly messageContentIntent: boolean;
	readonly guildInstalled: boolean;
	readonly channelBelongsToGuild: boolean;
	readonly channelVisibleToBot: boolean;
	readonly permissionsPresent: boolean;
	readonly agentReady: boolean | null;
}

export type DiscordPreflightResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly code: DiscordPreflightCode }
	| { readonly ok: false; readonly blocked: "BLOCKED_BY_CONTRACT" };

function isFacts(value: unknown): value is DiscordPreflightFacts {
	if (typeof value !== "object" || value === null) return false;
	const facts = value as Record<string, unknown>;
	return (
		typeof facts.networkReachable === "boolean"
		&& typeof facts.rateLimited === "boolean"
		&& typeof facts.tokenValid === "boolean"
		&& typeof facts.messageContentIntent === "boolean"
		&& typeof facts.guildInstalled === "boolean"
		&& typeof facts.channelBelongsToGuild === "boolean"
		&& typeof facts.channelVisibleToBot === "boolean"
		&& typeof facts.permissionsPresent === "boolean"
		&& (typeof facts.agentReady === "boolean" || facts.agentReady === null)
	);
}

export function evaluateDiscordPreflight(value: unknown): DiscordPreflightResult {
	if (!isFacts(value) || value.agentReady === null) {
		return { ok: false, blocked: "BLOCKED_BY_CONTRACT" };
	}
	if (!value.networkReachable) return { ok: false, code: "network_unavailable" };
	if (value.rateLimited) return { ok: false, code: "rate_limited" };
	if (!value.tokenValid) return { ok: false, code: "token_invalid" };
	if (!value.messageContentIntent) return { ok: false, code: "intent_missing" };
	if (!value.guildInstalled) return { ok: false, code: "guild_not_installed" };
	if (!value.channelBelongsToGuild || !value.channelVisibleToBot) {
		return { ok: false, code: "channel_not_visible" };
	}
	if (!value.permissionsPresent) return { ok: false, code: "permission_missing" };
	if (!value.agentReady) return { ok: false, code: "agent_offline" };
	return { ok: true };
}
