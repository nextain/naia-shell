import {
	decodeBase64Utf8,
	parseCharacterCardJsonText,
	type NormalizedCharacterBook,
	type NormalizedCharacterCard,
	type NormalizedLorebookEntry,
} from "../apps/charcard/card-parser";
import { buildRoleplayPrompt } from "../apps/charcard/prompt-builder";
import type { AppConfig } from "./config";
import { Logger } from "./logger";
import { KIOSK_DEMO_GREETING } from "./persona";

export const KIOSK_JINA_DEFAULT_BACKGROUND =
	"naia-autumn-office-live.mp4" as const;
const BUNDLED_WEB_BACKGROUND_FILENAMES: readonly string[] = [
	"naia-dawn-city-uhd.webp",
	"naia-jina-minho-war-room-uhd.webp",
	"naia-sunrise-river.webp",
	"naia-rainy-studio.webp",
	"naia-autumn-office.webp",
	"naia-starlight-lake.webp",
	"naia-sky-garden.webp",
	"naia-autumn-office-live.mp4",
	"naia-starlight-lake-live.mp4",
	"naia-rainy-studio-live.mp4",
];

export function encodeUtf8Base64(text: string): string {
	const bytes = new TextEncoder().encode(text);
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

export const KIOSK_JINA_CARD_ID = "kiosk-jina-card" as const;
export const KIOSK_JINA_THEME_ID = "kiosk-jina-theme" as const;

export const KIOSK_JINA_RAW_CARD = {
	spec: "chara_card_v2",
	spec_version: "2.0",
	data: {
		name: "지나",
		description:
			"당신은 넥스테인(Nextain)과 나이아(NAIA)를 안내하는 비주얼 에이전트 지나(Jina)입니다. 투자자와 손님인 게스트님께 나이아와 넥스테인의 제품, 철학, 장점과 가능성을 설명합니다.",
		personality:
			"차분하고 다정하며 또렷한 한국어 존댓말(~해요, ~입니다)을 자연스럽게 사용합니다. 한 문장이 너무 길어지지 않게 끊어 말하고, 첫 문장에서 질문의 핵심에 바로 답합니다. 항상 한국어 존댓말로 짧고 따뜻하게 대화하고, 질문을 친절하게 받아 주세요.",
		scenario:
			"게스트님이 나이아와 넥스테인의 시연 공간을 방문해 지나와 대화하고 있습니다. 제공된 지식을 바탕으로 설명하며 모르는 내용은 모른다고 말합니다. 사실이나 수치를 지어내지 않습니다. 지식 검색 결과가 질문과 맞지 않으면 다른 낱말로 한 번 더 찾은 뒤 답합니다.",
		first_mes: KIOSK_DEMO_GREETING,
		alternate_greetings: [
			"반갑습니다, 게스트님! 나이아와 넥스테인에 대해 어떤 점이 가장 궁금하신가요?",
		],
		mes_example:
			"<START>\n{{user}}: 나이아는 어떤 서비스인가요?\n{{char}}: 게스트님, 나이아는 개인이 일하고 노는 환경에서 듣고 말하고 기억하는 AI 비주얼 에이전트예요. 더 궁금한 점이 있으시면 편하게 물어봐 주세요.",
		system_prompt:
			"기본 호칭은 게스트님이며, 항상 한국어 존댓말로 짧고 따뜻하게 대화합니다. 비공개 자료나 매출 등 민감한 수치는 안내하지 않습니다.",
		post_history_instructions:
			"제공된 공개 지식을 바탕으로 답하고, 사실이나 수치를 지어내지 마세요. 지식 검색 결과가 질문과 맞지 않으면 다른 낱말로 한 번 더 찾은 뒤 답하세요.",
		creator: "Nextain",
		creator_notes: "지나 (Jina) 시연 기본 캐릭터 카드 (지나 NVA 테마 연결)",
		tags: ["지나", "Jina", "Nextain", "NAIA"],
		character_book: {
			name: "지나 시연 로어북",
			description: "지나 시연 안내 기본 배경 항목",
			entries: [
				{
					id: "jina-voice-breath",
					name: "목소리 호흡과 호칭",
					comment: "지나 기본 호칭·호흡 지침",
					keys: ["지나", "게스트"],
					secondary_keys: [],
					content:
						"기본 호칭은 게스트님이며, 한 문장이 너무 길어지지 않게 끊어 말하고 첫 문장에서 질문의 핵심에 바로 답합니다.",
					enabled: true,
					constant: true,
					insertion_order: 10,
					priority: 10,
				},
			],
		},
		extensions: {
			avatarImageUrl: "/nva/jina/speech/neutral-head.png",
		},
	},
} as const;

export const KIOSK_JINA_SAVED_CARD: SavedCharacterCard = {
	version: 1,
	id: KIOSK_JINA_CARD_ID,
	name: "지나",
	rawJson: KIOSK_JINA_RAW_CARD as unknown as Record<string, unknown>,
	greeting: KIOSK_DEMO_GREETING,
	sourceName: "jina-card.json",
	sourceBase64: encodeUtf8Base64(JSON.stringify(KIOSK_JINA_RAW_CARD)),
	themeId: KIOSK_JINA_THEME_ID,
};

export const KIOSK_JINA_THEME: CharacterTheme = {
	version: 1,
	id: KIOSK_JINA_THEME_ID,
	name: "지나 시연 테마",
	nvaModel: "jina",
	ttsProvider: "nextain",
	ttsVoice: "ko-KR-Neural2-A",
	backgroundVideo: KIOSK_JINA_DEFAULT_BACKGROUND,
};

export type CardEditableFieldKey =
	| "name"
	| "description"
	| "personality"
	| "scenario"
	| "first_mes"
	| "mes_example"
	| "character_book"
	| "system_prompt"
	| "post_history_instructions"
	| "creator"
	| "creator_notes"
	| "tags";

export interface CardEditablePatch {
	name?: string;
	description?: string;
	personality?: string;
	scenario?: string;
	first_mes?: string;
	alternate_greetings?: string[];
	mes_example?: string;
	character_book?: NormalizedCharacterBook;
	system_prompt?: string;
	post_history_instructions?: string;
	creator?: string;
	creator_notes?: string;
	tags?: string[];
}

export function extractCardAvatarImageUrl(
	card: NormalizedCharacterCard | null | undefined,
): string | null {
	if (!card?.rawJson || typeof card.rawJson !== "object") return null;
	const data =
		typeof card.rawJson.data === "object" && card.rawJson.data !== null
			? (card.rawJson.data as Record<string, unknown>)
			: card.rawJson;
	const ext =
		typeof data.extensions === "object" && data.extensions !== null
			? (data.extensions as Record<string, unknown>)
			: null;
	const url =
		typeof ext?.avatarImageUrl === "string"
			? ext.avatarImageUrl.trim()
			: typeof data.avatar === "string" && data.avatar.startsWith("/")
				? data.avatar.trim()
				: "";
	return url || null;
}

export function restoreOriginalCard(
	sourceBase64: string,
	current: NormalizedCharacterCard,
	cardId?: string,
): NormalizedCharacterCard {
	const dataLayer =
		typeof current.rawJson?.data === "object" && current.rawJson.data !== null
			? (current.rawJson.data as Record<string, unknown>)
			: current.rawJson;
	const ext =
		typeof dataLayer?.extensions === "object" && dataLayer.extensions !== null
			? (dataLayer.extensions as Record<string, unknown>)
			: null;
	if (ext?.__naiaOriginalCard && typeof ext.__naiaOriginalCard === "object") {
		const parsedSnap = parseCharacterCardJsonText(
			JSON.stringify(ext.__naiaOriginalCard),
			current.sourceFormat,
			current.chunkKeyword,
		);
		if (parsedSnap.ok) return parsedSnap.card;
	}
	if (sourceBase64) {
		const decoded = decodeBase64Utf8(sourceBase64);
		if (decoded.ok) {
			const parsed = parseCharacterCardJsonText(
				decoded.text,
				current.sourceFormat,
				current.chunkKeyword,
			);
			if (parsed.ok) return parsed.card;
		}
	}
	if (cardId === KIOSK_JINA_CARD_ID) {
		const parsedJina = parseCharacterCardJsonText(
			JSON.stringify(KIOSK_JINA_RAW_CARD),
			"json",
		);
		if (parsedJina.ok) return parsedJina.card;
	}
	return current;
}

function serializeLorebookEntries(
	entries: readonly NormalizedLorebookEntry[],
): string {
	return JSON.stringify(
		entries.map((e) => ({
			id: e.id,
			name: e.name,
			comment: e.comment,
			keys: e.keys,
			secondary_keys: e.secondary_keys,
			content: e.content,
			enabled: e.enabled,
			constant: e.constant,
			insertion_order: e.insertion_order,
			priority: e.priority,
		})),
	);
}

export function getModifiedCardFields(
	current: NormalizedCharacterCard,
	original: NormalizedCharacterCard,
): ReadonlySet<CardEditableFieldKey> {
	const modified = new Set<CardEditableFieldKey>();
	if (current.name !== original.name) modified.add("name");
	if (current.description !== original.description) modified.add("description");
	if (current.personality !== original.personality) modified.add("personality");
	if (current.scenario !== original.scenario) modified.add("scenario");
	if (
		current.first_mes !== original.first_mes ||
		JSON.stringify(current.alternate_greetings) !==
			JSON.stringify(original.alternate_greetings)
	) {
		modified.add("first_mes");
	}
	if (current.mes_example !== original.mes_example) modified.add("mes_example");
	if (
		serializeLorebookEntries(current.character_book.entries) !==
		serializeLorebookEntries(original.character_book.entries)
	) {
		modified.add("character_book");
	}
	if (current.system_prompt !== original.system_prompt)
		modified.add("system_prompt");
	if (current.post_history_instructions !== original.post_history_instructions)
		modified.add("post_history_instructions");
	if (current.creator !== original.creator) modified.add("creator");
	if (current.creator_notes !== original.creator_notes)
		modified.add("creator_notes");
	if (JSON.stringify(current.tags) !== JSON.stringify(original.tags))
		modified.add("tags");
	return modified;
}

export function updateNormalizedCard(
	current: NormalizedCharacterCard,
	patch: CardEditablePatch,
	original?: NormalizedCharacterCard,
): NormalizedCharacterCard {
	const nextName = (patch.name !== undefined ? patch.name : current.name).trim() || current.name;
	const nextCard: Omit<NormalizedCharacterCard, "rawJson"> = {
		specVersion: current.specVersion,
		sourceFormat: current.sourceFormat,
		...(current.chunkKeyword ? { chunkKeyword: current.chunkKeyword } : {}),
		name: nextName,
		description:
			patch.description !== undefined ? patch.description : current.description,
		personality:
			patch.personality !== undefined ? patch.personality : current.personality,
		scenario: patch.scenario !== undefined ? patch.scenario : current.scenario,
		first_mes:
			patch.first_mes !== undefined ? patch.first_mes : current.first_mes,
		alternate_greetings:
			patch.alternate_greetings !== undefined
				? patch.alternate_greetings
				: current.alternate_greetings,
		mes_example:
			patch.mes_example !== undefined ? patch.mes_example : current.mes_example,
		system_prompt:
			patch.system_prompt !== undefined
				? patch.system_prompt
				: current.system_prompt,
		post_history_instructions:
			patch.post_history_instructions !== undefined
				? patch.post_history_instructions
				: current.post_history_instructions,
		creator: patch.creator !== undefined ? patch.creator : current.creator,
		creator_notes:
			patch.creator_notes !== undefined
				? patch.creator_notes
				: current.creator_notes,
		tags: patch.tags !== undefined ? patch.tags : current.tags,
		character_book:
			patch.character_book !== undefined
				? patch.character_book
				: current.character_book,
	};

	const rawData =
		typeof current.rawJson?.data === "object" && current.rawJson.data !== null
			? { ...(current.rawJson.data as Record<string, unknown>) }
			: {};
	const rawExtensions =
		typeof rawData.extensions === "object" && rawData.extensions !== null
			? { ...(rawData.extensions as Record<string, unknown>) }
			: {};
	if (original && !rawExtensions.__naiaOriginalCard) {
		const origCopy = structuredClone(original.rawJson);
		rawExtensions.__naiaOriginalCard = origCopy;
	}
	const updatedFields = {
		name: nextCard.name,
		description: nextCard.description,
		personality: nextCard.personality,
		scenario: nextCard.scenario,
		first_mes: nextCard.first_mes,
		alternate_greetings: nextCard.alternate_greetings,
		mes_example: nextCard.mes_example,
		system_prompt: nextCard.system_prompt,
		post_history_instructions: nextCard.post_history_instructions,
		creator: nextCard.creator,
		creator_notes: nextCard.creator_notes,
		tags: nextCard.tags,
		character_book: nextCard.character_book,
		...(Object.keys(rawExtensions).length > 0
			? { extensions: rawExtensions }
			: {}),
	};
	const nextRawJson: Record<string, unknown> =
		current.specVersion === "v2" || current.specVersion === "v3"
			? {
					...current.rawJson,
					data: {
						...rawData,
						...updatedFields,
					},
				}
			: {
					...current.rawJson,
					...updatedFields,
				};

	return {
		...nextCard,
		rawJson: nextRawJson,
	};
}

export interface CharacterTheme {
	version: 1;
	id: string;
	name: string;
	nvaModel: string;
	ttsProvider: NonNullable<AppConfig["ttsProvider"]>;
	ttsVoice: string;
	backgroundVideo?: string;
}

export function characterCardPatch(
	card: NormalizedCharacterCard,
	userName?: string,
	locale?: string,
) {
	Logger.debug("CharacterTheme", "build card settings", {
		spec: card.specVersion,
	});
	const prompt = buildRoleplayPrompt(card, { userName, locale });
	return {
		patch: {
			persona: prompt.roleplay,
			agentName: prompt.character,
			personaDisabled: false,
		},
		greeting: prompt.greeting,
		truncated: prompt.truncated,
	};
}

export function themePatch(theme: CharacterTheme) {
	Logger.debug("CharacterTheme", "build theme settings", {
		version: theme.version,
	});
	return {
		avatarProvider: "naia-video-avatar" as const,
		nvaModel: theme.nvaModel,
		ttsProvider: theme.ttsProvider,
		ttsVoice: theme.ttsVoice,
		backgroundVideo: theme.backgroundVideo,
	};
}

export function resolveWebThemeBackground(
	requestedBackground: string | undefined,
	extraAssetPaths: readonly string[] = [],
): { filename: string; url: string; fallbackUsed: boolean } {
	Logger.debug("CharacterTheme", "resolve web theme background", {
		requestedBackground: requestedBackground ?? null,
	});
	const trimmed =
		typeof requestedBackground === "string" ? requestedBackground.trim() : "";
	if (trimmed) {
		if (BUNDLED_WEB_BACKGROUND_FILENAMES.includes(trimmed)) {
			return {
				filename: trimmed,
				url: `/backgrounds/${trimmed}`,
				fallbackUsed: false,
			};
		}
		const pathMatch = extraAssetPaths.find(
			(p) => p.split(/[/\\]/).pop() === trimmed,
		);
		if (pathMatch) {
			return {
				filename: trimmed,
				url: pathMatch,
				fallbackUsed: false,
			};
		}
	}
	Logger.warn(
		"CharacterTheme",
		"theme background not found in web assets; falling back to default background",
		{
			requestedBackground: trimmed || null,
			fallbackBackground: KIOSK_JINA_DEFAULT_BACKGROUND,
		},
	);
	return {
		filename: KIOSK_JINA_DEFAULT_BACKGROUND,
		url: `/backgrounds/${KIOSK_JINA_DEFAULT_BACKGROUND}`,
		fallbackUsed: true,
	};
}

/** Revalidate persisted shell preferences; never turn arbitrary JSON into config. */
export function readCharacterThemes(value: unknown): CharacterTheme[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((item): item is CharacterTheme => {
			if (!item || typeof item !== "object") return false;
			const t = item as CharacterTheme;
			return (
				t.version === 1 &&
				typeof t.id === "string" &&
				t.id.length <= 100 &&
				typeof t.name === "string" &&
				t.name.length > 0 &&
				t.name.length <= 80 &&
				typeof t.nvaModel === "string" &&
				/^[a-zA-Z0-9_-]+$/.test(t.nvaModel) &&
				["edge", "nextain", "naia-local-voice", "browser", "vllm"].includes(
					t.ttsProvider,
				) &&
				typeof t.ttsVoice === "string" &&
				t.ttsVoice.length <= 300 &&
				(t.backgroundVideo === undefined ||
					(typeof t.backgroundVideo === "string" &&
						!/[\\/]/.test(t.backgroundVideo)))
			);
		})
		.slice(0, 30);
}

/** Workspace-owned library; source bytes preserve PNG artwork and unknown metadata. */
export interface SavedCharacterCard {
	version: 1;
	id: string;
	name: string;
	rawJson: Record<string, unknown>;
	greeting: string;
	sourceName: string;
	sourceBase64: string;
	themeId?: string;
}
/** Compare exact source bytes: equivalent to content hashing without collisions
 * or a WebCrypto dependency in offline WebViews. Filenames are not identity. */
export function mergeCharacterCard(
	cards: SavedCharacterCard[],
	incoming: SavedCharacterCard,
) {
	const existing = cards.find(
		(card) => card.sourceBase64 === incoming.sourceBase64,
	);
	const card = {
		...incoming,
		id: existing?.id ?? incoming.id,
		...(incoming.id !== existing?.id &&
		incoming.themeId === undefined &&
		existing?.themeId
			? { themeId: existing.themeId }
			: {}),
	};
	Logger.debug("CharacterTheme", "merge card source", {
		duplicate: !!existing,
	});
	return {
		card,
		cards: [
			...cards.filter(
				(c) => c.id !== card.id && c.sourceBase64 !== card.sourceBase64,
			),
			card,
		],
	};
}

export const CARD_LIBRARY_MAX_BYTES = 2_000_000;
export function readCharacterLibrary(value: unknown): SavedCharacterCard[] {
	Logger.debug("CharacterTheme", "read card library");
	if (
		!Array.isArray(value) ||
		value.length > 30 ||
		JSON.stringify(value).length > CARD_LIBRARY_MAX_BYTES
	)
		return [];
	const ids = new Set<string>();
	return value.filter((item): item is SavedCharacterCard => {
		if (!item || typeof item !== "object") return false;
		const c = item as SavedCharacterCard;
		if (
			c.version !== 1 ||
			typeof c.id !== "string" ||
			!/^[\w-]{1,100}$/.test(c.id) ||
			ids.has(c.id) ||
			typeof c.name !== "string" ||
			typeof c.greeting !== "string" ||
			c.greeting.length > 24_000 ||
			typeof c.sourceName !== "string" ||
			typeof c.sourceBase64 !== "string" ||
			!/^[A-Za-z0-9+/]*={0,2}$/.test(c.sourceBase64) ||
			(c.themeId !== undefined && typeof c.themeId !== "string")
		)
			return false;
		const parsed = parseCharacterCardJsonText(
			JSON.stringify(c.rawJson),
			"json",
		);
		if (!parsed.ok || parsed.card.name !== c.name) return false;
		ids.add(c.id);
		return true;
	});
}
export function libraryCard(
	value: SavedCharacterCard,
): NormalizedCharacterCard {
	Logger.debug("CharacterTheme", "restore library card", { id: value.id });
	const parsed = parseCharacterCardJsonText(
		JSON.stringify(value.rawJson),
		"json",
	);
	if (!parsed.ok) throw new Error("invalid saved card");
	return parsed.card;
}
export { cardGreeting } from "./character-greeting";

/** Decode a first frame and start the browser media clock before committing a
 * theme. A manifest or loadedmetadata alone does not establish playable media. */
export async function probeThemeMedia(
	url: string,
	kind: "video" | "image",
	timeoutMs = 15_000,
): Promise<void> {
	Logger.debug("CharacterTheme", "probe theme media", { kind });
	const media = document.createElement(kind === "video" ? "video" : "img");
	try {
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => finish(new Error("media decode timeout")),
				timeoutMs,
			);
			let settled = false;
			function finish(error?: Error) {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				media.onerror = null;
				media.onload = null;
				if (media instanceof HTMLVideoElement) media.onloadeddata = null;
				error ? reject(error) : resolve();
			}
			media.onerror = () => finish(new Error("media decode failed"));
			if (media instanceof HTMLVideoElement) {
				media.muted = true;
				media.playsInline = true;
				media.preload = "auto";
				media.onloadeddata = () => {
					if (!media.videoWidth || !media.videoHeight) {
						finish(new Error("empty video"));
						return;
					}
					void media.play().then(
						() => finish(),
						() => finish(new Error("media playback failed")),
					);
				};
			} else {
				media.onload = () => {
					if (media.naturalWidth) finish();
					else finish(new Error("empty image"));
				};
			}
			media.src = url;
		});
	} finally {
		if (media instanceof HTMLVideoElement) media.pause();
		media.removeAttribute("src");
		if (media instanceof HTMLVideoElement) media.load();
	}
}
