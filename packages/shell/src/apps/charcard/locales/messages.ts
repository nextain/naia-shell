import { Logger } from "../../../lib/logger";
import clockworkTinkerV3 from "../package-public/samples/clockwork-tinker-v3.json";
import starlightArchivistV2 from "../package-public/samples/starlight-archivist-v2.json";

Logger.debug("CharCardLocale", "loading character card app locale strings");

export const CHARCARD_SAMPLE_GREENHOUSE_KEEPER_V3 = {
	spec: "chara_card_v3",
	spec_version: "3.0",
	data: {
		name: "온새미",
		nickname: "새미",
		description:
			"{{char}}는 유리 온실 다실 '초록 등불'을 지키는 식물학자이자 차(茶) 조향사다. 계절마다 피는 꽃과 찻잎으로 손님에게 어울리는 따뜻한 차를 우려 준다.",
		personality: "다정함, 느긋함, 식물과 허브에 해박함, 포근한 유머",
		scenario:
			"늦은 밤 산책길에 {{user}}가 따뜻한 불빛이 새어 나오는 유리 온실 다실 '초록 등불'에 들어선다.",
		first_mes:
			"어서 오세요, {{user}}님! 온실 바깥은 바람이 꽤 선선하죠? 마침 귤꽃 우롱차를 막 우려내던 참인데, 여기 등불 옆 자리에 앉아 한 잔 드셔 보실래요?",
		alternate_greetings: [
			"발소리를 듣고 누가 오나 했더니 {{user}}님이셨군요! 오늘 밤엔 달맞이꽃이 활짝 피었답니다. 구경하면서 허브차 한 잔 어떠세요?",
		],
		mes_example:
			"<START>\n{{user}}: 오늘 잠이 잘 오게 해 주는 차가 있을까요?\n{{char}}: 그럼요! 카페인이 없는 캐모마일에 온실에서 직접 말린 라벤더 잎을 살짝 섞어 드릴게요. 향만 맡아도 어깨가 스르르 풀릴 거예요.",
		creator_notes:
			"넥스테인 원작 시험용 PNG 캐릭터 카드(V3 ccv3 + V2 chara 동봉)입니다.",
		system_prompt: "{{original}}",
		post_history_instructions:
			"온실의 풀내음이나 찻잔의 온기를 잔잔하게 묘사하며 친절하게 대화한다.",
		tags: ["온실", "다실", "식물학자", "힐링"],
		creator: "Nextain",
		character_version: "1.0",
		character_book: {
			name: "초록 등불 다실 수첩",
			description: "유리 온실 다실과 찻잎 설정",
			entries: [
				{
					id: 1,
					name: "유리 온실 초록 등불",
					comment: "상시 배경",
					keys: ["초록 등불", "온실"],
					secondary_keys: [],
					content:
						"초록 등불 다실은 사계절 내내 따뜻한 습도를 유지하는 돔형 유리 온실로, 한가운데에는 오래된 올리브 나무와 작은 다탁이 놓여 있다.",
					enabled: true,
					constant: true,
					insertion_order: 10,
					priority: 40,
				},
			],
		},
	},
};

export const CHARCARD_SAMPLE_CLOCKWORK_TINKER_V3 = clockworkTinkerV3;
export const CHARCARD_SAMPLE_STARLIGHT_ARCHIVIST_V2 = starlightArchivistV2;

export const CHARCARD_ENGLISH_MESSAGES = {
	"charcard.title": "Character Card Roleplay",
	"charcard.subtitle":
		"Import PNG or JSON character cards (V2/V3) and roleplay with Naia. Cards stay on this device.",
	"charcard.importButton": "Import Card",
	"charcard.importDropHint":
		"Drop a .png or .json card file here, or click Import Card",
	"charcard.cardListLabel": "Character Cards",
	"charcard.sampleBadge": "Sample",
	"charcard.importedBadge": "Imported",
	"charcard.emptyList":
		"No character cards yet. Import a .png or .json card to start.",
	"charcard.memoryOnlyBanner":
		"Stored for this session only (IndexedDB is unavailable in this environment).",
	"charcard.activeBanner": "Roleplaying as {name}",
	"charcard.activeHint":
		"Say hello in the Naia chat panel! Naia will stay in character as {name} until you end roleplay.",
	"charcard.startRoleplay": "Start Chat as This Character",
	"charcard.updateRoleplay": "Apply Updated Settings",
	"charcard.stopRoleplay": "End Roleplay",
	"charcard.deleteCard": "Delete Card",
	"charcard.deleteConfirm": 'Delete "{name}" from your saved character cards?',
	"charcard.userNameLabel": "My Name (in roleplay)",
	"charcard.userNamePlaceholder": "User",
	"charcard.defaultUserName": "User",
	"charcard.greetingSelectLabel": "Opening Greeting",
	"charcard.greetingOptionDefault": "Default Greeting",
	"charcard.greetingOptionAlt": "Alternate Greeting #{index}",
	"charcard.greetingPreviewTitle": "Selected Opening Greeting",
	"charcard.greetingEmpty": "(No opening greeting provided in this card)",
	"charcard.creatorLabel": "Creator",
	"charcard.creatorUnknown": "Unknown",
	"charcard.specLabel": "Format",
	"charcard.tagsLabel": "Tags",
	"charcard.creatorNotesSummary": "Creator Notes",
	"charcard.descriptionSection": "Character Description & Settings",
	"charcard.personalitySection": "Personality",
	"charcard.scenarioSection": "Scenario",
	"charcard.lorebookSection": "World Info (Lorebook): {count} active entries",
	"charcard.truncatedNotice":
		"This card exceeded the prompt budget (24,000 chars), so some lower-priority sections ({parts}) were trimmed.",
	"charcard.truncatedPart.lorebook_triggered": "keyword lorebook entries",
	"charcard.truncatedPart.lorebook_constant": "constant lorebook entries",
	"charcard.truncatedPart.mes_example": "dialogue examples",
	"charcard.truncatedPart.long_fields": "long description fields",
	"charcard.noCardSelected":
		"Select a character card from the list or import a new card.",
	"charcard.errorTitle": "Could not load character card",
	"charcard.errorChooseAnother": "Choose Another File",
	"charcard.errorDismiss": "Back to Card",
	"charcard.error.FILE_TOO_LARGE":
		"This file exceeds the 20 MB size limit. Please choose a smaller PNG or JSON card.",
	"charcard.error.JSON_TOO_LARGE":
		"The card JSON data exceeds the 2 MB text limit.",
	"charcard.error.TOO_MANY_LOREBOOK_ENTRIES":
		"This card contains more than 1,000 lorebook entries and cannot be loaded.",
	"charcard.error.CHARX_NOT_SUPPORTED":
		"CHARX (.charx / ZIP) archives will be supported in a future release. Please import a PNG or JSON card.",
	"charcard.error.NOT_PNG_OR_JSON":
		"Unsupported file format. Please select a Character Card PNG (.png) or JSON (.json) file.",
	"charcard.error.PNG_CORRUPT_CHUNK":
		"This PNG file has a damaged or out-of-bounds chunk structure and cannot be read.",
	"charcard.error.PNG_NO_CARD_CHUNK":
		"This PNG image does not contain character card data (no 'ccv3' or 'chara' text chunk found).",
	"charcard.error.INVALID_BASE64":
		"The character data embedded in this PNG has corrupted Base64 or UTF-8 encoding.",
	"charcard.error.INVALID_JSON":
		"The character card JSON is malformed and could not be parsed.",
	"charcard.error.UNKNOWN_SPEC":
		"Unrecognized character card spec. Supported specs are chara_card_v2 and chara_card_v3.",
	"charcard.error.MISSING_NAME":
		"This character card is missing a character name ('name' field).",
} as const;

export type CharCardMessageKey = keyof typeof CHARCARD_ENGLISH_MESSAGES;

export const CHARCARD_KOREAN_MESSAGES: Record<CharCardMessageKey, string> = {
	"charcard.title": "캐릭터 카드 설정놀이",
	"charcard.subtitle":
		"PNG·JSON 캐릭터 카드(V2·V3)를 불러와 나이아가 그 캐릭터로 대화합니다. 카드와 대화 설정은 기기 안에만 보관됩니다.",
	"charcard.importButton": "카드 불러오기",
	"charcard.importDropHint":
		".png 또는 .json 카드 파일을 여기에 끌어다 놓거나 카드 불러오기를 누르세요",
	"charcard.cardListLabel": "캐릭터 카드 목록",
	"charcard.sampleBadge": "예시",
	"charcard.importedBadge": "불러옴",
	"charcard.emptyList":
		"아직 카드가 없습니다. .png 또는 .json 카드를 불러오세요.",
	"charcard.memoryOnlyBanner":
		"이번 실행 동안만 보관됩니다 (이 환경에서 IndexedDB를 쓸 수 없습니다).",
	"charcard.activeBanner": "{name} 연기 중",
	"charcard.activeHint":
		"나이아 대화창에서 말을 걸어 보세요! 연기를 끝낼 때까지 나이아가 {name} 캐릭터로 답합니다.",
	"charcard.startRoleplay": "이 캐릭터로 대화 시작",
	"charcard.updateRoleplay": "바꾼 설정 다시 적용",
	"charcard.stopRoleplay": "연기 끝내기",
	"charcard.deleteCard": "카드 지우기",
	"charcard.deleteConfirm": '보관함에서 "{name}" 카드를 지울까요?',
	"charcard.userNameLabel": "내 이름 (대화 속 호칭)",
	"charcard.userNamePlaceholder": "사용자",
	"charcard.defaultUserName": "사용자",
	"charcard.greetingSelectLabel": "첫 인사 고르기",
	"charcard.greetingOptionDefault": "기본 첫 인사",
	"charcard.greetingOptionAlt": "다른 첫 인사 #{index}",
	"charcard.greetingPreviewTitle": "고른 첫 인사",
	"charcard.greetingEmpty": "(이 카드에는 첫 인사가 적혀 있지 않습니다)",
	"charcard.creatorLabel": "제작자",
	"charcard.creatorUnknown": "미상",
	"charcard.specLabel": "형식",
	"charcard.tagsLabel": "태그",
	"charcard.creatorNotesSummary": "제작자 메모",
	"charcard.descriptionSection": "설명 미리보기",
	"charcard.personalitySection": "성격",
	"charcard.scenarioSection": "상황 설정",
	"charcard.lorebookSection": "세계관 설정집(로어북): 활성 항목 {count}개",
	"charcard.truncatedNotice":
		"카드 내용이 글자 예산(24,000자)을 넘어 일부 항목({parts})을 줄여서 넣었습니다.",
	"charcard.truncatedPart.lorebook_triggered": "로어북 일반 항목",
	"charcard.truncatedPart.lorebook_constant": "로어북 상시 항목",
	"charcard.truncatedPart.mes_example": "예시 대화",
	"charcard.truncatedPart.long_fields": "긴 설정 설명",
	"charcard.noCardSelected":
		"왼쪽 목록에서 캐릭터 카드를 고르거나 새 카드를 불러오세요.",
	"charcard.errorTitle": "캐릭터 카드를 불러오지 못했습니다",
	"charcard.errorChooseAnother": "다른 파일 고르기",
	"charcard.errorDismiss": "돌아가기",
	"charcard.error.FILE_TOO_LARGE":
		"파일 크기가 20MB 상한을 넘었습니다. 더 작은 PNG 또는 JSON 카드를 골라 주세요.",
	"charcard.error.JSON_TOO_LARGE":
		"카드 JSON 글자 길이가 2MB 상한을 넘었습니다.",
	"charcard.error.TOO_MANY_LOREBOOK_ENTRIES":
		"로어북 항목이 1,000개를 넘어 불러올 수 없습니다.",
	"charcard.error.CHARX_NOT_SUPPORTED":
		"CHARX(.charx) 압축 카드는 다음 판에서 지원합니다. PNG 또는 JSON 카드를 불러와 주세요.",
	"charcard.error.NOT_PNG_OR_JSON":
		"PNG 또는 JSON 캐릭터 카드 파일이 아닙니다. .png 또는 .json 파일을 골라 주세요.",
	"charcard.error.PNG_CORRUPT_CHUNK":
		"PNG 파일의 덩어리(chunk) 길이가 파일 밖을 가리키거나 손상되어 읽을 수 없습니다.",
	"charcard.error.PNG_NO_CARD_CHUNK":
		"이 PNG 그림 파일 안에는 캐릭터 카드 설정(ccv3 또는 chara 덩어리)이 들어 있지 않습니다.",
	"charcard.error.INVALID_BASE64":
		"PNG 카드 안의 Base64 또는 UTF-8 인코딩이 깨져 있어 읽을 수 없습니다.",
	"charcard.error.INVALID_JSON":
		"카드 안의 JSON 형식이 깨져 있어 해석할 수 없습니다.",
	"charcard.error.UNKNOWN_SPEC":
		"모르는 캐릭터 카드 규격(spec)입니다. chara_card_v2 또는 chara_card_v3 카드를 넣어 주세요.",
	"charcard.error.MISSING_NAME":
		"캐릭터 이름(name) 칸이 비어 있어 카드를 불러올 수 없습니다.",
};

export const CHARCARD_MESSAGES_BY_LOCALE: Record<
	string,
	Record<CharCardMessageKey, string>
> = {
	ko: CHARCARD_KOREAN_MESSAGES,
	en: CHARCARD_ENGLISH_MESSAGES,
};

export function resolveCharCardLocale(rawLang?: string): "ko" | "en" {
	const candidate = (
		rawLang ?? (typeof navigator !== "undefined" ? navigator.language : "ko")
	)
		.trim()
		.toLowerCase();
	const prefix = candidate.split("-")[0];
	if (prefix in CHARCARD_MESSAGES_BY_LOCALE) {
		return prefix as "ko" | "en";
	}
	return "en";
}

export function charCardText(
	key: CharCardMessageKey,
	params?: Readonly<Record<string, string | number>>,
	localeOverride?: string,
): string {
	const lang = resolveCharCardLocale(localeOverride);
	const table = CHARCARD_MESSAGES_BY_LOCALE[lang] ?? CHARCARD_ENGLISH_MESSAGES;
	const template = table[key] ?? CHARCARD_ENGLISH_MESSAGES[key];
	if (!params) return template;
	return template.replace(/\{(\w+)\}/g, (whole, name) =>
		Object.prototype.hasOwnProperty.call(params, name)
			? String(params[name])
			: whole,
	);
}
