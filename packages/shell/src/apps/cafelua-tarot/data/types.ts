// 타로 카드 타입 정의 (공개용)

export interface TarotCardMeta {
	id: number;
	nameEn: string;
	nameKr: string;
	character: "alpha" | "luke" | "both";
	imagePath: string;
	keywords: string[];
	objects: TarotObject[];
	upright: string[];
	reversed: string[];
}

export interface TarotObject {
	traditional: string;
	cafelua: string;
	meaning: string;
}

export interface SpreadPosition {
	index: number;
	nameKr: string;
	nameEn: string;
	description: string;
}

export interface DrawnCard {
	card: TarotCardMeta;
	position: SpreadPosition;
	isReversed: boolean;
	isFlipped: boolean;
}

export interface TarotReadingState {
	phase:
		| "welcome"
		| "topic"
		| "shuffle"
		| "spread"
		| "interpret"
		| "summary"
		| "end";
	topic: string;
	drawnCards: DrawnCard[];
	currentCardIndex: number;
	interpretations: string[];
}

// 켈틱 크로스 10장 스프레드 포지션
export const SPREAD_POSITIONS: SpreadPosition[] = [
	{
		index: 0,
		nameKr: "현재",
		nameEn: "Present",
		description: "현재 상황의 핵심",
	},
	{
		index: 1,
		nameKr: "도전",
		nameEn: "Challenge",
		description: "현재를 가로막는 장애물",
	},
	{
		index: 2,
		nameKr: "왕관",
		nameEn: "Crown",
		description: "의식적 목표, 최선의 가능성",
	},
	{
		index: 3,
		nameKr: "기반",
		nameEn: "Foundation",
		description: "무의식적 근원, 뿌리",
	},
	{ index: 4, nameKr: "과거", nameEn: "Past", description: "지나온 영향" },
	{ index: 5, nameKr: "미래", nameEn: "Future", description: "다가올 영향" },
	{
		index: 6,
		nameKr: "자신",
		nameEn: "Self",
		description: "질문자의 태도와 관점",
	},
	{
		index: 7,
		nameKr: "환경",
		nameEn: "Environment",
		description: "주변 상황과 타인의 영향",
	},
	{
		index: 8,
		nameKr: "희망/두려움",
		nameEn: "Hopes/Fears",
		description: "내면의 기대와 불안",
	},
	{ index: 9, nameKr: "결과", nameEn: "Outcome", description: "최종 결론" },
];
