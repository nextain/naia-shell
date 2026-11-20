import {
	type NormalizedCharacterCard,
	parseCharacterCardBytes,
	parseCharacterCardJsonText,
} from "../../apps/charcard/card-parser";
import { useAppStore } from "../../stores/app";
import { useChatStore } from "../../stores/chat";
import { writeNaiaConfig } from "../adk-store";
import {
	type SavedCharacterCard,
	characterCardPatch,
	encodeUtf8Base64,
	mergeCharacterCard,
	readCharacterLibrary,
} from "../character-theme";
import { type AppConfig, loadConfig, saveConfig } from "../config";
import { getLocale } from "../i18n";
import { Logger } from "../logger";
import { WEB_NVA_ASSETS } from "./web-assets";

export const STUDIO_PENDING_CHARACTER_STORAGE_KEY =
	"naia-web-pending-character-card";

const STUDIO_CANONICAL_NVA_ALIASES: Readonly<Record<string, string>> = {
	naia: "naia",
	"naia-anime": "naia",
	"av-def-naia": "naia",
	jina: "jina",
	"jina-original": "jina",
	"av-def-jina-original": "jina",
	"jina-anime": "jina-anime",
	"av-def-jina-anime": "jina-anime",
	minho: "minho",
	"minho-original": "minho",
	"av-def-minho-original": "minho",
	"minho-anime": "minho-anime",
	"av-def-minho-anime": "minho-anime",
};

function isTrustedCharacterHandoffUrl(
	rawUrl: string,
	shellOrigin?: string,
): URL | null {
	try {
		const base =
			shellOrigin ||
			(typeof window !== "undefined"
				? window.location.origin
				: "https://dev.naia.land");
		const parsed = new URL(rawUrl, base);
		const isLoopback =
			parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
		if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
			return null;
		}
		if (shellOrigin && parsed.origin === shellOrigin) return parsed;
		if (
			parsed.hostname === "naia.land" ||
			parsed.hostname.endsWith(".naia.land") ||
			isLoopback
		) {
			return parsed;
		}
		return null;
	} catch {
		return null;
	}
}

export function decodeBase64UrlToBytes(input: string): Uint8Array | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	const standard = trimmed.replace(/-/g, "+").replace(/_/g, "/");
	const padLen = (4 - (standard.length % 4)) % 4;
	const padded = standard + "=".repeat(padLen);
	try {
		const binary = atob(padded);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) {
			bytes[i] = binary.charCodeAt(i);
		}
		return bytes;
	} catch {
		return null;
	}
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary);
}

function safeCardIdFromName(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	const suffix = Math.random().toString(36).slice(2, 8);
	return `studio-${slug || "card"}-${suffix}`;
}

export interface StudioCardAvatarHint {
	nvaModel?: string;
	ttsVoice?: string;
	/** 스튜디오가 보냈지만 셸 음성 합성이 못 쓰는 목소리(예: user-voice:). */
	unsupportedVoice?: string;
	backgroundVideo?: string;
}

/**
 * 스튜디오 목소리 이름을 게이트웨이 /v1/audio/speech 가 받는 형태로 맞춘다.
 * - Dragon/Azure·Google 이름(ko-KR-…)과 naia-voice:… 는 그대로.
 * - 맨 카탈로그 이름(cc0-ko-female-01 등)은 naia-voice: 를 붙인다 — 게이트웨이는
 *   이 머리말이 있어야 나이아 목소리로 보내고, 없으면 Google 목소리로 처리한다.
 * - user-voice:… 는 스튜디오 작업에서만 쓰여 동기 합성 경로가 받지 않으므로 undefined.
 */
export function normalizeStudioVoiceId(raw: string): string | undefined {
	const voice = raw.trim();
	if (!voice) return undefined;
	if (/^user-voice:/i.test(voice)) return undefined;
	if (/^naia-voice:[^\s]+$/.test(voice)) return voice;
	if (/^[a-z]{2,3}-[A-Z]{2,4}-/.test(voice)) return voice;
	if (/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(voice)) return `naia-voice:${voice}`;
	return undefined;
}

export function extractStudioCardExtensions(
	card: NormalizedCharacterCard,
): StudioCardAvatarHint {
	const raw = card.rawJson ?? {};
	const data =
		typeof raw.data === "object" && raw.data !== null
			? (raw.data as Record<string, unknown>)
			: raw;
	const extensions =
		typeof data.extensions === "object" && data.extensions !== null
			? (data.extensions as Record<string, unknown>)
			: {};
	const studio =
		typeof extensions.naia_studio === "object" &&
		extensions.naia_studio !== null
			? (extensions.naia_studio as Record<string, unknown>)
			: {};

	const hint: StudioCardAvatarHint = {};

	const nvaCandidates = [
		studio.nva_url,
		studio.nvaUrl,
		studio.avatar_url,
		studio.avatarUrl,
		studio.nva_model,
		studio.nvaModel,
		studio.canonical_key,
		studio.canonicalKey,
		studio.avatar_id,
		studio.avatarId,
		extensions.nvaModel,
	];
	for (const candidate of nvaCandidates) {
		if (typeof candidate !== "string" || !candidate.trim()) continue;
		const val = candidate.trim();
		const alias = STUDIO_CANONICAL_NVA_ALIASES[val.toLowerCase()];
		if (alias) {
			hint.nvaModel = alias;
			break;
		}
		if ((WEB_NVA_ASSETS as readonly string[]).includes(val)) {
			hint.nvaModel = val;
			break;
		}
		if (
			val.startsWith("/nva/") ||
			val.startsWith("/api/nva-preview/") ||
			/^https:\/\/([a-z0-9-]+\.)?naia\.land\//i.test(val)
		) {
			hint.nvaModel = val.replace(/\/manifest\.json$/i, "").replace(/\/+$/, "");
			break;
		}
	}

	const voiceCandidates = [
		studio.tts_voice,
		studio.ttsVoice,
		studio.voice_id,
		studio.voiceId,
		extensions.ttsVoice,
	];
	for (const v of voiceCandidates) {
		if (typeof v !== "string" || v.trim().length === 0) continue;
		const voice = normalizeStudioVoiceId(v);
		if (voice) hint.ttsVoice = voice;
		else hint.unsupportedVoice = v.trim();
		break;
	}

	const bgCandidates = [
		studio.background_video,
		studio.backgroundVideo,
		extensions.backgroundVideo,
	];
	for (const b of bgCandidates) {
		if (typeof b === "string" && b.trim().length > 0) {
			hint.backgroundVideo = b.trim();
			break;
		}
	}

	return hint;
}

export async function applyNormalizedCharacterCardToWebShell(
	card: NormalizedCharacterCard,
	sourceBase64?: string,
	sourceName = "studio-character.json",
): Promise<{ cardId: string; name: string; greeting: string }> {
	const existing = loadConfig();
	const locale = getLocale();
	const { patch, greeting } = characterCardPatch(
		card,
		existing?.userName,
		locale,
	);
	const studioHint = extractStudioCardExtensions(card);
	const currentLibrary = readCharacterLibrary(
		existing?.uiPreferences?.b2cCardLibrary,
	);
	const incomingSaved: SavedCharacterCard = {
		version: 1,
		id: safeCardIdFromName(card.name),
		name: card.name,
		rawJson: card.rawJson,
		greeting,
		sourceName,
		sourceBase64:
			sourceBase64 || encodeUtf8Base64(JSON.stringify(card.rawJson)),
	};
	const merged = mergeCharacterCard(currentLibrary, incomingSaved);

	const nextConfig: AppConfig = {
		provider: existing?.provider || "webllm",
		model: existing?.model || "Qwen3-4B-q4f16_1-MLC",
		apiKey: existing?.apiKey ?? "",
		...(existing ?? {}),
		...patch,
		onboardingComplete: true,
		...(studioHint.nvaModel
			? {
					avatarProvider: "naia-video-avatar" as const,
					nvaModel: studioHint.nvaModel,
				}
			: {}),
		...(studioHint.ttsVoice
			? {
					ttsProvider: "nextain" as const,
					ttsVoice: studioHint.ttsVoice,
					ttsEnabled: existing?.ttsEnabled ?? true,
				}
			: {}),
		...(studioHint.backgroundVideo
			? { backgroundVideo: studioHint.backgroundVideo }
			: {}),
		uiPreferences: {
			...(existing?.uiPreferences ?? {}),
			b2cCardLibrary: merged.cards,
			b2cActiveCardId: merged.card.id,
		},
	};

	// 캐릭터는 바뀌는데 카드에 쓸 수 있는 목소리가 없으면 앞 캐릭터 목소리를 남기지
	// 않는다 — 기본 목소리(언어·캐릭터 기준)로 돌아간다.
	if (!studioHint.ttsVoice && (studioHint.nvaModel || studioHint.unsupportedVoice)) {
		delete nextConfig.ttsVoice;
	}
	if (studioHint.unsupportedVoice) {
		Logger.warn("StudioHandoff", "studio voice not usable for shell TTS", {
			voice: studioHint.unsupportedVoice,
		});
	}

	saveConfig(nextConfig);
	if (nextConfig.ttsEnabled !== undefined) {
		useAppStore.getState().setTtsEnabled(nextConfig.ttsEnabled);
	}
	try {
		await writeNaiaConfig(nextConfig as unknown as Record<string, unknown>);
	} catch (err) {
		Logger.warn("StudioHandoff", "OPFS config write skipped", {
			error: String(err),
		});
	}

	const chat = useChatStore.getState();
	chat.newConversation();
	if (greeting.trim().length > 0) {
		chat.addMessage({
			role: "assistant",
			content: greeting,
		});
	}

	if (typeof window !== "undefined") {
		window.dispatchEvent(new CustomEvent("naia-config-changed"));
	}

	return { cardId: merged.card.id, name: card.name, greeting };
}

export interface ConsumeStudioHandoffOptions {
	fetchImpl?: typeof fetch;
	location?: { pathname: string; search: string; hash: string; origin?: string };
	replaceUrl?: (cleanUrl: string) => void;
}

export interface ConsumeStudioHandoffResult {
	handled: boolean;
	ok: boolean;
	characterName?: string;
	error?: string;
}

/**
 * Consume pending character card handoff from Naia Studio (`/ko/studio` -> `/app`):
 * 1) `localStorage["naia-web-pending-character-card"]` (V2/V3 JSON string)
 * 2) URL query `?character=<base64url_or_handoff_url>` or `?applyCard=<...>`
 */
export async function consumePendingStudioCharacterCard(
	opts?: ConsumeStudioHandoffOptions,
): Promise<ConsumeStudioHandoffResult> {
	const fetchFn = opts?.fetchImpl ?? ((input, init) => fetch(input, init));
	const loc =
		opts?.location ??
		(typeof window !== "undefined"
			? {
					pathname: window.location.pathname,
					search: window.location.search,
					hash: window.location.hash,
					origin: window.location.origin,
				}
			: null);

	let pendingJsonText: string | null = null;
	try {
		if (typeof localStorage !== "undefined") {
			pendingJsonText = localStorage.getItem(
				STUDIO_PENDING_CHARACTER_STORAGE_KEY,
			);
			if (pendingJsonText !== null) {
				localStorage.removeItem(STUDIO_PENDING_CHARACTER_STORAGE_KEY);
			}
		}
	} catch {
		pendingJsonText = null;
	}

	let queryParamValue = "";
	if (loc?.search) {
		const params = new URLSearchParams(loc.search);
		const rawParam =
			params.get("character")?.trim() || params.get("applyCard")?.trim() || "";
		if (rawParam) {
			queryParamValue = rawParam;
			params.delete("character");
			params.delete("applyCard");
			const nextSearch = params.toString();
			const cleanUrl = `${loc.pathname}${nextSearch ? `?${nextSearch}` : ""}${loc.hash || ""}`;
			const replace =
				opts?.replaceUrl ??
				((u: string) => {
					if (
						typeof window !== "undefined" &&
						typeof window.history?.replaceState === "function"
					) {
						window.history.replaceState({}, "", u);
					}
				});
			replace(cleanUrl);
		}
	}

	if (!pendingJsonText?.trim() && !queryParamValue) {
		return { handled: false, ok: false };
	}

	// 1. Prefer same-origin localStorage payload written directly by Studio
	if (pendingJsonText?.trim()) {
		const parsed = parseCharacterCardJsonText(pendingJsonText, "json");
		if (parsed.ok) {
			const applied = await applyNormalizedCharacterCardToWebShell(
				parsed.card,
				encodeUtf8Base64(pendingJsonText),
				"studio-handoff.json",
			);
			return { handled: true, ok: true, characterName: applied.name };
		}
		Logger.warn("StudioHandoff", "localStorage card parse failed; trying URL param", {
			error: parsed.code,
		});
	}

	// 2. Fallback / standalone URL parameter (`?character=<url_or_base64url>`)
	if (queryParamValue) {
		const looksLikeUrl =
			queryParamValue.startsWith("/") ||
			/^https?:\/\//i.test(queryParamValue);
		if (looksLikeUrl) {
			const trustedUrl = isTrustedCharacterHandoffUrl(
				queryParamValue,
				loc?.origin,
			);
			if (!trustedUrl) {
				return {
					handled: true,
					ok: false,
					error: "untrusted_character_handoff_url",
				};
			}
			try {
				const res = await fetchFn(trustedUrl.toString(), {
					credentials:
						trustedUrl.origin === loc?.origin ? "include" : "omit",
				});
				if (!res.ok) {
					return {
						handled: true,
						ok: false,
						error: `handoff_http_${res.status}`,
					};
				}
				const contentType =
					res.headers?.get?.("content-type")?.toLowerCase() ?? "";
				if (contentType.includes("image/png")) {
					const bytes = new Uint8Array(await res.arrayBuffer());
					const parsedPng = await parseCharacterCardBytes(
						bytes,
						"studio-card.png",
					);
					if (!parsedPng.ok) {
						return { handled: true, ok: false, error: parsedPng.code };
					}
					const applied = await applyNormalizedCharacterCardToWebShell(
						parsedPng.card,
						bytesToBase64(bytes),
						"studio-card.png",
					);
					return { handled: true, ok: true, characterName: applied.name };
				}
				const rawBody = await res.text();
				// Support either raw card JSON or `{ card: {...} }` / `{ data: {...} }` envelope
				let candidateJson = rawBody;
				try {
					const envelope = JSON.parse(rawBody) as Record<string, unknown>;
					if (
						envelope &&
						typeof envelope === "object" &&
						!envelope.spec &&
						typeof envelope.card === "object" &&
						envelope.card !== null
					) {
						candidateJson = JSON.stringify(envelope.card);
					}
				} catch {
					// let card parser surface syntax error
				}
				const parsedJson = parseCharacterCardJsonText(candidateJson, "json");
				if (!parsedJson.ok) {
					return { handled: true, ok: false, error: parsedJson.code };
				}
				const applied = await applyNormalizedCharacterCardToWebShell(
					parsedJson.card,
					encodeUtf8Base64(candidateJson),
					"studio-handoff.json",
				);
				return { handled: true, ok: true, characterName: applied.name };
			} catch (err) {
				return {
					handled: true,
					ok: false,
					error: err instanceof Error ? err.message : String(err),
				};
			}
		}

		// Base64url-encoded JSON or PNG bytes
		const decodedBytes = decodeBase64UrlToBytes(queryParamValue);
		if (!decodedBytes) {
			return { handled: true, ok: false, error: "invalid_base64url_character" };
		}
		const isPng =
			decodedBytes.length > 8 &&
			decodedBytes[0] === 0x89 &&
			decodedBytes[1] === 0x50 &&
			decodedBytes[2] === 0x4e &&
			decodedBytes[3] === 0x47;
		const parsed = await parseCharacterCardBytes(
			decodedBytes,
			isPng ? "character.png" : "character.json",
		);
		if (!parsed.ok) {
			return { handled: true, ok: false, error: parsed.code };
		}
		const applied = await applyNormalizedCharacterCardToWebShell(
			parsed.card,
			bytesToBase64(decodedBytes),
			isPng ? "character.png" : "character.json",
		);
		return { handled: true, ok: true, characterName: applied.name };
	}

	return { handled: true, ok: false, error: "invalid_pending_character_card" };
}
