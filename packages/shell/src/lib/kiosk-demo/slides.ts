import { useAppStore } from "../../stores/app";
import { useChatStore } from "../../stores/chat";
import { webAdkOpfsPath } from "../web-runtime/web-adk-path";
import type { WebFs } from "../web-runtime/web-fs";
import { isKioskDemo } from "./flag";
import rawIrDeck from "./slides/ir-deck.json";
import presentationCopy from "./slides/presentation-copy.json";
import slideQuestionContext from "./slides/question-context.md?raw";
import slideReferenceContext from "./slides/reference-context.md?raw";
import {
	KIOSK_PRIVATE_IR_SLIDE_IMAGES,
	KIOSK_PRIVATE_IR_SLIDE_PAGES,
	getKioskPrivateIrSlides,
} from "./slides/private-deck";

export interface KioskIrSlide {
	page: number;
	/** `public/kiosk-slides/` 안 그림 파일 이름(비공개 장은 그 아래 `private/`). 짐작하기 어렵게 무작위 16진 글자로 짓는다. */
	image: string;
	title: string;
	script: string;
}

export interface KioskIrDeck {
	deckId: string;
	title: string;
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
export const KIOSK_IR_SLIDES_PDF_NAME = presentationCopy.pdfName;
export const KIOSK_IR_SLIDES_SCRIPT_PATH =
	"opfs://naia-adk/slides/nextain-ir-public.md";
export const KIOSK_IR_SLIDES_SCRIPT_NAME = presentationCopy.scriptName;
/** 발표 중 질문 답의 근거 칩에 쓰는 탐색기 경로(낭독 대본). */
export const KIOSK_IR_SLIDES_EVIDENCE_FILE = "slides/nextain-ir-public.md";
export const KIOSK_IR_SLIDE_IMAGE_DIR = "/kiosk-slides";
export const KIOSK_IR_PRIVATE_SLIDE_IMAGE_DIR = "/kiosk-slides/private";
const KIOSK_IR_SLIDE_IMAGE_NAME = /^[0-9a-f]{16}\.jpg$/;

// 시연 첫 화면에 비밀번호를 둔 뒤(2026-11-13)로 회사 소개 자료의 매출·가입·투자 숫자는 덱에 싣는다.
// 다만 숫자가 든 장의 그림·원고는 저장소 밖에 두고 시연판 웹 빌드 때만 합친다(slides/private-deck.ts).
// 덱 원고에 없는 지분·가치 평가·계약 조건과 개인 정보, 내부 경로는 계속 막는다.
export const FORBIDDEN_IR_SLIDE_WORDS: readonly string[] = presentationCopy.forbiddenWords;

const FORBIDDEN_IR_SLIDE_PATTERNS: readonly RegExp[] = [
	/\x2fhome\x2f|min\x68o|nextain\x2dadk/i,
];

let activeController: KioskSlidesController | null = null;
let pendingAction: KioskSlidesControlAction | null = null;
let cachedPdfBytes: number[] | null = null;
let cachedPdfSlideCount = 0;

/**
 * 공개 장에 빌드 때 들어온 비공개 장을 쪽 번호 순으로 합친다.
 * 비공개 장이 없는 빌드(개발·시험·일반 웹판)에서는 공개 장만 남는다.
 */
export function buildKioskIrDeck(
	privateSlides: readonly KioskIrSlide[] = getKioskPrivateIrSlides(),
): KioskIrDeck {
	const publicDeck = rawIrDeck as KioskIrDeck;
	return {
		...publicDeck,
		slides: [...publicDeck.slides, ...privateSlides]
			.map((slide) => ({ ...slide }))
			.sort((a, b) => a.page - b.page),
	};
}

export function assertPublicIrSlides(
	deck: KioskIrDeck = buildKioskIrDeck(),
	minSlides = 8,
): void {
	if (!deck || !Array.isArray(deck.slides)) {
		throw new Error("invalid_ir_deck:missing_slides");
	}
	if (deck.slides.length < minSlides || deck.slides.length > 10) {
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
		if (!KIOSK_IR_SLIDE_IMAGE_NAME.test(slide.image ?? "")) {
			throw new Error(`invalid_ir_deck:image_name_page_${expectedPage}`);
		}
		if (!slide.script || !slide.script.trim()) {
			throw new Error(`invalid_ir_deck:empty_script_page_${expectedPage}`);
		}
		const combinedText = [slide.title, slide.script].join(" ");
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
	const privateSlides = getKioskPrivateIrSlides();
	if (
		privateSlides.length > 0 &&
		privateSlides.map((slide) => slide.page).join() !==
			KIOSK_PRIVATE_IR_SLIDE_PAGES.join()
	) {
		throw new Error("invalid_ir_deck:private_pages_mismatch");
	}
	const deck = buildKioskIrDeck(privateSlides);
	// 비공개 장이 안 들어온 빌드는 공개 장만으로 돈다. 시연판 빌드는 비공개 장 없이는 만들어지지 않는다.
	assertPublicIrSlides(
		deck,
		privateSlides.length > 0 ? 8 : rawIrDeck.slides.length,
	);
	return deck.slides;
}

export function getKioskIrSlide(page: number): KioskIrSlide | null {
	if (!Number.isFinite(page) || page < 1) return null;
	const slides = getKioskIrSlides();
	return slides.find((item) => item.page === Math.trunc(page)) ?? null;
}

export function kioskIrSlideImageUrl(
	slide: Pick<KioskIrSlide, "image">,
): string {
	const dir = KIOSK_PRIVATE_IR_SLIDE_IMAGES.includes(slide.image)
		? KIOSK_IR_PRIVATE_SLIDE_IMAGE_DIR
		: KIOSK_IR_SLIDE_IMAGE_DIR;
	return `${dir}/${slide.image}`;
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
	if (cachedPdfBytes && slides.length === cachedPdfSlideCount) {
		return [...cachedPdfBytes];
	}
	const pageCount = Math.max(1, slides.length);
	const fontObjId = 3 + pageCount * 2;
	const objects = new Map<number, string>();
	objects.set(1, "<< /Type /Catalog /Pages 2 0 R >>");

	const kids: string[] = [];
	for (let index = 0; index < pageCount; index += 1) {
		const pageObjId = 3 + index * 2;
		const contentObjId = pageObjId + 1;
		kids.push(`${pageObjId} 0 R`);

		const badgeText = escapePdfAscii(
			`NEXTAIN  |  SLIDE ${String(index + 1).padStart(2, "0")} / ${String(pageCount).padStart(2, "0")}`,
		);
		const subText = escapePdfAscii(`Slide ${index + 1}`);
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
	cachedPdfBytes = bytes;
	cachedPdfSlideCount = slides.length;
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

function renderSlideContext(template: string, slide: KioskIrSlide, question?: string): string {
	const values: Readonly<Record<string, string>> = {
		page: String(slide.page),
		title: slide.title,
		script: slide.script,
		evidenceFile: KIOSK_IR_SLIDES_EVIDENCE_FILE,
	};
	const context = template.trimEnd().replace(/\{(page|title|script|evidenceFile)\}/g, (_, name) => values[name]);
	const userQuestion = question?.trim();
	return userQuestion ? context + "\n" + presentationCopy.questionLabel + userQuestion : context;
}

export const buildKioskSlideQuestionPrompt = (
	slide: KioskIrSlide,
	question?: string,
): string => {
	return renderSlideContext(slideQuestionContext, slide, question);
};

export const buildKioskSlideReferencePrompt = (
	slide: KioskIrSlide,
	question?: string,
): string => {
	return renderSlideContext(slideReferenceContext, slide, question);
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
