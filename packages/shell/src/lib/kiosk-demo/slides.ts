import { useAppStore } from "../../stores/app";
import { useChatStore } from "../../stores/chat";
import { webAdkOpfsPath } from "../web-runtime/web-adk-path";
import type { WebFs } from "../web-runtime/web-fs";
import { isKioskDemo } from "./flag";
import rawIrPublicDeck from "./slides/ir-public.json";

export interface KioskIrSlide {
	page: number;
	id: string;
	source: string;
	subtitle: string;
	title: string;
	bullets: string[];
	script: string;
}

export interface KioskIrDeck {
	deckId: string;
	title: string;
	version: string;
	slides: KioskIrSlide[];
}

export type KioskSlidesControlAction =
	| "start"
	| "pause"
	| "resume"
	| "next"
	| "previous"
	| "stop"
	| "question";

export interface KioskSlidesIntent {
	kind: Exclude<KioskSlidesControlAction, "question">;
}

export interface KioskSlidesController {
	isPresenting: () => boolean;
	isAnsweringQuestion: () => boolean;
	getCurrentPage?: () => number;
	performAction: (action: KioskSlidesControlAction) => void | Promise<void>;
	onTurnSettled: () => void;
}

export const KIOSK_IR_SLIDES_PDF_PATH =
	"opfs://naia-adk/slides/nextain-ir-public.pdf";
export const KIOSK_IR_SLIDES_PDF_NAME = "넥스테인 공개 IR 발표.pdf";
export const KIOSK_IR_SLIDES_SCRIPT_PATH =
	"opfs://naia-adk/slides/nextain-ir-public.md";
export const KIOSK_IR_SLIDES_SCRIPT_NAME = "넥스테인 공개 IR 발표.md";

export const FORBIDDEN_IR_SLIDE_WORDS = [
	"매출",
	"투자",
	"억",
	"밸류",
	"계약금",
	"계약 금액",
	"영업이익",
	"순이익",
	"지분",
	"기업가치",
	"개인 정보",
	"개인정보",
] as const;

const FORBIDDEN_IR_SLIDE_PATTERNS: readonly RegExp[] = [
	/\d[\d,.]*\s*(?:원|달러|불|만원|천만원|억원|조원|usd|krw)\b/i,
	/\x2fhome\x2f|min\x68o|nextain\x2dadk/i,
];

let activeController: KioskSlidesController | null = null;
let pendingAction: KioskSlidesControlAction | null = null;
let cachedPdfBytes: number[] | null = null;

export function assertPublicIrSlides(
	deck: KioskIrDeck = rawIrPublicDeck as KioskIrDeck,
): void {
	if (!deck || !Array.isArray(deck.slides)) {
		throw new Error("invalid_ir_deck:missing_slides");
	}
	if (deck.slides.length < 8 || deck.slides.length > 10) {
		throw new Error(
			`invalid_ir_deck:slide_count_${deck.slides.length}_out_of_range_8_10`,
		);
	}
	for (let idx = 0; idx < deck.slides.length; idx += 1) {
		const slide = deck.slides[idx];
		const expectedPage = idx + 1;
		if (!slide || slide.page !== expectedPage) {
			throw new Error(`invalid_ir_deck:page_mismatch_at_${expectedPage}`);
		}
		if (!slide.title || !slide.title.trim()) {
			throw new Error(`invalid_ir_deck:empty_title_page_${expectedPage}`);
		}
		if (
			!Array.isArray(slide.bullets) ||
			slide.bullets.length === 0 ||
			slide.bullets.length > 3
		) {
			throw new Error(`invalid_ir_deck:bullets_count_page_${expectedPage}`);
		}
		for (const bullet of slide.bullets) {
			if (!bullet || !bullet.trim() || bullet.includes("\n")) {
				throw new Error(`invalid_ir_deck:invalid_bullet_page_${expectedPage}`);
			}
		}
		if (!slide.script || !slide.script.trim()) {
			throw new Error(`invalid_ir_deck:empty_script_page_${expectedPage}`);
		}
		const combinedText = [
			slide.subtitle ?? "",
			slide.title,
			...slide.bullets,
			slide.script,
		].join(" ");
		for (const word of FORBIDDEN_IR_SLIDE_WORDS) {
			if (combinedText.includes(word)) {
				throw new Error(
					`forbidden_ir_slide_word:${word}:page_${expectedPage}`,
				);
			}
		}
		for (const pattern of FORBIDDEN_IR_SLIDE_PATTERNS) {
			if (pattern.test(combinedText)) {
				throw new Error(
					`forbidden_ir_slide_pattern:${pattern.source}:page_${expectedPage}`,
				);
			}
		}
	}
}

export function getKioskIrSlides(): KioskIrSlide[] {
	const deck = rawIrPublicDeck as KioskIrDeck;
	assertPublicIrSlides(deck);
	return deck.slides.map((slide) => ({
		...slide,
		bullets: [...slide.bullets],
	}));
}

export function getKioskIrSlide(page: number): KioskIrSlide | null {
	if (!Number.isFinite(page) || page < 1) return null;
	const slides = getKioskIrSlides();
	return slides.find((item) => item.page === Math.trunc(page)) ?? null;
}

export function buildKioskIrScriptMarkdown(
	slides: readonly KioskIrSlide[] = getKioskIrSlides(),
): string {
	return slides
		.map(
			(slide) => `## ${slide.page}. ${slide.title}\n\n${slide.script.trim()}`,
		)
		.join("\n\n");
}

/** 탐색기의 slides 폴더에 낭독 대본을 둔다. 번들 대본이 바뀌면 새 글로 덮어쓴다. */
export async function seedKioskSlidesWorkspace(fs: WebFs): Promise<void> {
	if (!isKioskDemo()) return;
	const path = webAdkOpfsPath(KIOSK_IR_SLIDES_SCRIPT_PATH);
	const text = `# ${KIOSK_IR_SLIDES_SCRIPT_NAME.replace(/\.md$/, "")}\n\n${buildKioskIrScriptMarkdown()}\n`;
	if ((await fs.readText(path)) !== text) await fs.writeBytes(path, text);
}

function escapePdfAscii(value: string): string {
	return value
		.replace(/[^\x20-\x7e]/g, " ")
		.replace(/\\/g, "\\\\")
		.replace(/\(/g, "\\(")
		.replace(/\)/g, "\\)");
}

export function buildKioskIrPdfBytes(
	slides: readonly KioskIrSlide[] = getKioskIrSlides(),
): number[] {
	if (cachedPdfBytes && slides.length === rawIrPublicDeck.slides.length) {
		return [...cachedPdfBytes];
	}
	const pageCount = Math.max(1, slides.length);
	const fontObjId = 3 + pageCount * 2;
	const objects = new Map<number, string>();
	objects.set(1, "<< /Type /Catalog /Pages 2 0 R >>");

	const kids: string[] = [];
	for (let index = 0; index < pageCount; index += 1) {
		const slide = slides[index];
		const pageObjId = 3 + index * 2;
		const contentObjId = pageObjId + 1;
		kids.push(`${pageObjId} 0 R`);

		const badgeText = escapePdfAscii(
			`NEXTAIN PUBLIC IR  |  SLIDE ${String(index + 1).padStart(2, "0")} / ${String(pageCount).padStart(2, "0")}`,
		);
		const subText = escapePdfAscii(slide?.subtitle ?? `Slide ${index + 1}`);
		const stream = [
			"q",
			"0.055 0.075 0.135 rg",
			"0 0 960 540 re f",
			"0.09 0.125 0.215 rg",
			"36 36 888 468 re f",
			"0.22 0.56 0.96 rg",
			"36 496 888 8 re f",
			"BT",
			"/F1 13 Tf",
			"0.58 0.76 0.98 rg",
			`64 462 Td (${badgeText}) Tj`,
			"0 -22 Td",
			"/F1 11 Tf",
			"0.45 0.56 0.74 rg",
			`(${subText}) Tj`,
			"ET",
			"Q",
		].join("\n");

		objects.set(
			pageObjId,
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 960 540] /Resources << /Font << /F1 ${fontObjId} 0 R >> >> /Contents ${contentObjId} 0 R >>`,
		);
		objects.set(
			contentObjId,
			`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
		);
	}

	objects.set(
		2,
		`<< /Type /Pages /Count ${pageCount} /Kids [${kids.join(" ")}] >>`,
	);
	objects.set(
		fontObjId,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
	);

	let pdf = "%PDF-1.4\n";
	const offsets: number[] = [0];
	for (let id = 1; id <= fontObjId; id += 1) {
		offsets[id] = pdf.length;
		const body = objects.get(id) ?? "<<>>";
		pdf += `${id} 0 obj\n${body}\nendobj\n`;
	}
	const xrefOffset = pdf.length;
	pdf += `xref\n0 ${fontObjId + 1}\n`;
	pdf += "0000000000 65535 f \n";
	for (let id = 1; id <= fontObjId; id += 1) {
		pdf += `${String(offsets[id] ?? 0).padStart(10, "0")} 00000 n \n`;
	}
	pdf += `trailer\n<< /Size ${fontObjId + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

	const bytes = Array.from(new TextEncoder().encode(pdf));
	if (slides.length === rawIrPublicDeck.slides.length) {
		cachedPdfBytes = bytes;
	}
	return [...bytes];
}

function bytesToBase64(bytes: readonly number[]): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 1) {
		binary += String.fromCharCode((bytes[i] ?? 0) & 0xff);
	}
	return btoa(binary);
}

export async function handleKioskSlidesCommand(
	cmd: string,
	_args?: Record<string, unknown>,
): Promise<unknown> {
	if (!isKioskDemo()) {
		throw new Error(`desktop_only:${cmd}`);
	}
	if (cmd === "slides_open_document" || cmd === "slides_open_pdf") {
		const slides = getKioskIrSlides();
		const bytes = buildKioskIrPdfBytes(slides);
		const scriptText = buildKioskIrScriptMarkdown(slides);
		return {
			path: KIOSK_IR_SLIDES_PDF_PATH,
			name: KIOSK_IR_SLIDES_PDF_NAME,
			pdfName: KIOSK_IR_SLIDES_PDF_NAME,
			pdfBase64: bytesToBase64(bytes),
			sourceFormat: "pdf" as const,
			bytes,
			scriptPath: KIOSK_IR_SLIDES_SCRIPT_PATH,
			scriptName: KIOSK_IR_SLIDES_SCRIPT_NAME,
			scriptText,
			scriptContent: scriptText,
			scriptReadFailed: false,
		};
	}
	if (cmd === "slides_cancel_open") {
		return false;
	}
	throw new Error(`desktop_only:${cmd}`);
}

export function classifyKioskSlidesIntent(
	rawText: string,
): KioskSlidesIntent | null {
	const text = rawText.trim();
	if (!text) return null;

	const normalized = text.replace(/[.!?~]+$/g, "").trim();

	if (
		/^(?:발표\s*)?(?:끝내기|끝내\s*줘|끝내줘|발표\s*끝|발표\s*종료|슬라이드\s*닫기|슬라이드\s*종료|그만\s*발표해)$/i.test(
			normalized,
		)
	) {
		return { kind: "stop" };
	}
	if (
		/^(?:발표\s*)?(?:멈춤|일시\s*정지|잠깐\s*멈춰|멈춰\s*줘|멈춰줘|멈춰)$/i.test(
			normalized,
		)
	) {
		return { kind: "pause" };
	}
	if (
		/^(?:발표\s*)?(?:이어\s*가기|이어가기|이어서\s*발표해\s*줘|이어서\s*해\s*줘|계속\s*발표해\s*줘|계속\s*발표해|발표\s*재개|다시\s*발표해\s*줘)$/i.test(
			normalized,
		)
	) {
		return { kind: "resume" };
	}
	if (
		/^(?:다음\s*장(?:으로)?|다음\s*슬라이드(?:로)?|다음\s*페이지(?:로)?|다음으로\s*넘어가)(?:\s*줘)?$/i.test(
			normalized,
		)
	) {
		return { kind: "next" };
	}
	if (
		/^(?:이전\s*장(?:으로)?|이전\s*슬라이드(?:로)?|이전\s*페이지(?:로)?|앞\s*장(?:으로)?)(?:\s*줘)?$/i.test(
			normalized,
		)
	) {
		return { kind: "previous" };
	}

	const isQuestionLike =
		/[?？]$/.test(text) ||
		/(?:뭐야|뭔가요|무엇인가요|무엇이야|어떻게|왜\s|차이가|알려\s*줘|설명해\s*줄래|궁금)/i.test(
			normalized,
		);

	if (
		/\bir\b.*(?:발표|슬라이드|브리핑|자료\s*설명|소개\s*발표)/i.test(
			normalized,
		) ||
		/(?:발표\s*자료|슬라이드\s*자료|회사\s*소개\s*자료|공개\s*ir).*(?:발표|보여|열어|시작|설명)/i.test(
			normalized,
		) ||
		/^(?:ir\s*)?(?:슬라이드\s*)?발표(?:\s*시작)?(?:해\s*줘|해줘|해\s*주세요|해주세요|부탁해|부탁해요)?$/i.test(
			normalized,
		) ||
		(!isQuestionLike &&
			/(?:슬라이드(?:로)?\s*발표|ir\s*설명해\s*줘|ir\s*소개해\s*줘)/i.test(
				normalized,
			))
	) {
		return { kind: "start" };
	}

	return null;
}

export function registerKioskSlidesController(
	controller: KioskSlidesController | null,
): () => void {
	activeController = controller;
	if (controller && pendingAction) {
		const action = pendingAction;
		pendingAction = null;
		void controller.performAction(action);
	}
	return () => {
		if (activeController === controller) {
			activeController = null;
		}
	};
}

export function requestKioskSlidesAction(
	action: KioskSlidesControlAction,
): void {
	if (activeController) {
		pendingAction = null;
		void activeController.performAction(action);
		return;
	}
	pendingAction = action;
}

export function isKioskSlidesPresentationActive(): boolean {
	return Boolean(
		activeController &&
			(activeController.isPresenting() ||
				activeController.isAnsweringQuestion()),
	);
}

export function pauseKioskSlidesForQuestion(): boolean {
	if (!activeController || !isKioskSlidesPresentationActive()) {
		return false;
	}
	void activeController.performAction("question");
	return true;
}

export function notifyKioskSlidesTurnSettled(): void {
	if (!isKioskDemo() || !activeController) return;
	if (activeController.isAnsweringQuestion()) {
		activeController.onTurnSettled();
	}
}

export function isKioskSlideQuestionTurnActive(): boolean {
	if (!isKioskDemo()) return false;
	return isKioskSlidesPresentationActive();
}

export const getActiveKioskIrSlide = (): KioskIrSlide | null => {
	if (!isKioskDemo()) return null;
	const activeAppId = useAppStore.getState().activeApp;
	const slidesOpen =
		activeAppId === "land.naia.slides" || activeAppId === "slides";
	if (activeController && (slidesOpen || isKioskSlidesPresentationActive())) {
		const page = activeController.getCurrentPage?.() ?? 1;
		return getKioskIrSlide(page);
	}
	if (slidesOpen) {
		return getKioskIrSlide(1);
	}
	return null;
};

export const buildKioskSlideQuestionPrompt = (
	slide: KioskIrSlide,
	question?: string,
): string => {
	const bullets = slide.bullets.map((b) => `- ${b}`).join("\n");
	const lines = [
		`[현재 발표 중인 슬라이드: ${slide.page}장 — ${slide.title}${slide.subtitle ? ` (${slide.subtitle})` : ""}]`,
		`장 원고 파일: knowledge/${slide.source}`,
		`장 본문 요점:\n${bullets}`,
		`장 발표문:\n${slide.script}`,
		`규칙:`,
		`1. 발표 중간 질문에는 반드시 지금 보고 있는 ${slide.page}장('${slide.title}')의 장 본문 요점과 장 발표문에 적힌 내용만으로 답하세요.`,
		`2. 다른 슬라이드 장이나 다른 지식 카드(marketing.md, growth.md 등)를 검색하거나 끌어오지 말고, 이 장에 없는 고유명사·별자리 이름·수치를 절대 지어내지 마세요.`,
		`3. 질문한 항목(예: 핵심 지표, 수치, 통계, 실적, 가격 등)이 이 장의 본문·발표문에 없으면 "이 장에는 지표가 없어요"(또는 "이 장에는 핵심 지표가 없어요"·"이 장에는 가격 내용이 없어요")라고 먼저 분명하게 말한 뒤, 지금 ${slide.page}장에 실제로 적힌 핵심 내용만 짧게 안내하세요.`,
		`4. 질문한 항목(예: 이 장에 나오는 용어 설명, 방금 장 요약 등)이 이 장의 본문·발표문에 있으면 이 장에 적힌 내용만 사용해 정확히 답하세요.`,
		`5. 근거 파일은 오직 knowledge/${slide.source} 하나만 사용하세요.`,
	];
	if (question?.trim()) {
		lines.push(`사용자 질문: ${question.trim()}`);
	}
	return lines.join("\n");
};

export const buildKioskSlideReferencePrompt = (
	slide: KioskIrSlide,
	question?: string,
): string => {
	const bullets = slide.bullets.map((b) => `- ${b}`).join("\n");
	const lines = [
		`[현재 열려 있는 슬라이드 참고: ${slide.page}장 — ${slide.title}${slide.subtitle ? ` (${slide.subtitle})` : ""}]`,
		`장 원고 파일: knowledge/${slide.source}`,
		`장 본문 요점:\n${bullets}`,
		`장 발표문:\n${slide.script}`,
		`참고 안내:`,
		`1. 현재 슬라이드 발표는 진행 중이 아니라 멈춤·대기 또는 완료 상태입니다.`,
		`2. 지금 열려 있는 ${slide.page}장('${slide.title}')에 대한 질문이면 위 장 본문 요점과 발표문(knowledge/${slide.source})을 참고해 답하세요.`,
		`3. 다른 슬라이드 장이나 회사·제품·기억·성장 등 다른 주제에 대한 질문이면 이 장에만 가두지 말고 skill_knowledge_search 또는 skill_knowledge_ask로 공개 지식 카드를 검색해 답하세요.`,
	];
	if (question?.trim()) {
		lines.push(`사용자 질문: ${question.trim()}`);
	}
	return lines.join("\n");
};

export async function handleKioskSlidesChatTurn(
	rawText: string,
): Promise<boolean> {
	if (!isKioskDemo()) return false;
	const text = rawText.trim();
	if (!text) return false;

	const intent = classifyKioskSlidesIntent(text);
	const activeAppId = useAppStore.getState().activeApp;
	const slidesOpen =
		activeAppId === "land.naia.slides" || activeAppId === "slides";

	if (intent?.kind === "start") {
		const { syncKioskSlidesAppRegistration } = await import(
			"../../apps/slides/index"
		);
		syncKioskSlidesAppRegistration();
		useChatStore.getState().addMessage({
			role: "user",
			content: text,
		});
		useAppStore.getState().setActiveApp("land.naia.slides");
		requestKioskSlidesAction("start");
		return true;
	}

	if (slidesOpen && intent) {
		useChatStore.getState().addMessage({
			role: "user",
			content: text,
		});
		requestKioskSlidesAction(intent.kind);
		if (intent.kind === "stop") {
			useAppStore.getState().setActiveApp(null);
		}
		return true;
	}

	if (slidesOpen && isKioskSlidesPresentationActive()) {
		pauseKioskSlidesForQuestion();
		return false;
	}

	return false;
}
