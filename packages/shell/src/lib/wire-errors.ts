import { t, type TranslationKey } from "./i18n";

export const WIRE_ERROR_CODES = [
	"PROVIDER_NOT_INSTALLED", "PROVIDER_LOGIN_REQUIRED", "PROVIDER_AUTH_EXPIRED", "PROVIDER_NETWORK",
	"DISCORD_TOKEN_MISSING", "DISCORD_INTENTS_MISSING", "DISCORD_NOT_INSTALLED",
	"DISCORD_PERMISSION_DENIED", "DISCORD_RATE_LIMITED",
	"ATTACHMENT_UNSUPPORTED_TYPE", "ATTACHMENT_TOO_LARGE", "ATTACHMENT_INVALID_REF",
	"KNOWLEDGE_UNCOMPILED", "KNOWLEDGE_UNAVAILABLE",
	"WIRE_INVALID_ARGUMENT", "WIRE_UNSUPPORTED_ENUM", "WIRE_SCOPE_FORBIDDEN",
	"PROVIDER_SESSION_MISMATCH", "PROVIDER_SESSION_EXPIRED", "PROVIDER_SESSION_CLOSED",
	"PROCESSING_PROFILE_REQUIRED", "PROCESSING_DESTINATION_UNKNOWN",
	"EXTERNAL_PROCESSING_FORBIDDEN", "EXTERNAL_PROCESSING_CONFIRMATION_REQUIRED",
] as const;

export type WireErrorCode = (typeof WIRE_ERROR_CODES)[number];

const KEYS: Record<WireErrorCode, TranslationKey> = {
	PROVIDER_NOT_INSTALLED: "chat.wireError.provider",
	PROVIDER_LOGIN_REQUIRED: "chat.wireError.provider",
	PROVIDER_AUTH_EXPIRED: "chat.wireError.provider",
	PROVIDER_NETWORK: "chat.wireError.provider",
	DISCORD_TOKEN_MISSING: "chat.wireError.discord",
	DISCORD_INTENTS_MISSING: "chat.wireError.discord",
	DISCORD_NOT_INSTALLED: "chat.wireError.discord",
	DISCORD_PERMISSION_DENIED: "chat.wireError.discord",
	DISCORD_RATE_LIMITED: "chat.wireError.discord",
	ATTACHMENT_UNSUPPORTED_TYPE: "chat.wireError.attachment",
	ATTACHMENT_TOO_LARGE: "chat.wireError.attachment",
	ATTACHMENT_INVALID_REF: "chat.wireError.attachment",
	KNOWLEDGE_UNCOMPILED: "chat.wireError.knowledge",
	KNOWLEDGE_UNAVAILABLE: "chat.wireError.knowledge",
	WIRE_INVALID_ARGUMENT: "chat.wireError.request",
	WIRE_UNSUPPORTED_ENUM: "chat.wireError.request",
	WIRE_SCOPE_FORBIDDEN: "chat.wireError.scope",
	PROVIDER_SESSION_MISMATCH: "chat.wireError.session",
	PROVIDER_SESSION_EXPIRED: "chat.wireError.session",
	PROVIDER_SESSION_CLOSED: "chat.wireError.session",
	PROCESSING_PROFILE_REQUIRED: "chat.wireError.processing",
	PROCESSING_DESTINATION_UNKNOWN: "chat.wireError.processing",
	EXTERNAL_PROCESSING_FORBIDDEN: "chat.wireError.processing",
	EXTERNAL_PROCESSING_CONFIRMATION_REQUIRED: "chat.wireError.processing",
};

export function isWireErrorCode(value: unknown): value is WireErrorCode {
	return typeof value === "string" && (WIRE_ERROR_CODES as readonly string[]).includes(value);
}

/** 안정 code는 현지화하고, 알 수 없는 legacy error만 안전한 기존 message로 표시한다. */
export function wireErrorMessage(code: unknown, legacyMessage: string): string {
	return isWireErrorCode(code) ? t(KEYS[code]) : legacyMessage;
}
