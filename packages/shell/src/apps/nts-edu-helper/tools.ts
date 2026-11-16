import { Logger } from "../../lib/logger";
import {
	type AxWorkbookFields,
	OPENCODE_SCENE_SLIDES,
	TOTAL_SLIDES,
	getChapterForSlide,
} from "./locales/messages";
import { compileWorkbookMarkdown } from "./workbook-domain";

const TAG = "AxLectureTools";

export type AxStudioToolAction =
	| "status"
	| "goto_slide"
	| "get_workbook"
	| "update_workbook"
	| "generate_wireframe";

export type WorkbookStageTab = "stage1" | "stage2" | "stage3";

export interface AxStudioSnapshot {
	currentSlide: number;
	openCodeOnly: boolean;
	activeStage: WorkbookStageTab;
	workbook: AxWorkbookFields;
	wireframeHtml: string;
	locale: string;
}

export interface AxStudioToolController {
	getSnapshot: () => AxStudioSnapshot;
	gotoSlide: (slide: number) => void;
	patchWorkbook: (patch: Partial<AxWorkbookFields>) => AxWorkbookFields;
	regenerateWireframe: () => string;
}

const PATCHABLE_STRING_KEYS: ReadonlyArray<
	keyof Omit<AxWorkbookFields, "presetId" | "checklist">
> = [
	"agencyName",
	"serviceName",
	"targetUser",
	"sourceDocs",
	"bottleneckRisk",
	"noPiiPrinciple",
	"approvalStopRule",
	"purpose",
	"aiRole",
	"humanRole",
	"approvalGate",
	"screenAreas",
];

export function buildAxContextPayload(snapshot: AxStudioSnapshot): {
	type: "ax_lecture_studio";
	data: Record<string, unknown>;
} {
	const chapter = getChapterForSlide(snapshot.currentSlide, snapshot.locale);
	const verifiedCount = snapshot.workbook.checklist.filter(
		(c) => c.status === "verified",
	).length;
	return {
		type: "ax_lecture_studio",
		data: {
			slide: snapshot.currentSlide,
			totalSlides: TOTAL_SLIDES,
			chapterId: chapter.id,
			chapterLabel: chapter.label,
			openCodeScene: OPENCODE_SCENE_SLIDES.includes(snapshot.currentSlide),
			activeStage: snapshot.activeStage,
			agencyName: snapshot.workbook.agencyName,
			serviceName: snapshot.workbook.serviceName,
			checklistVerified: `${verifiedCount}/${snapshot.workbook.checklist.length}`,
		},
	};
}

export function handleAxStudioToolCall(
	rawArgs: unknown,
	controller: AxStudioToolController,
): { ok: true; result: Record<string, unknown> } | { ok: false; error: string } {
	if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
		return { ok: false, error: "Invalid arguments: expected an object" };
	}
	const args = rawArgs as Record<string, unknown>;
	const action = args.action;
	if (
		action !== "status" &&
		action !== "goto_slide" &&
		action !== "get_workbook" &&
		action !== "update_workbook" &&
		action !== "generate_wireframe"
	) {
		return {
			ok: false,
			error: `Unsupported skill_ax_lecture_studio action: ${String(action)}`,
		};
	}

	Logger.debug(TAG, "handling skill_ax_lecture_studio tool call", { action });
	const snapshot = controller.getSnapshot();

	if (action === "status") {
		const chapter = getChapterForSlide(snapshot.currentSlide, snapshot.locale);
		return {
			ok: true,
			result: {
				action: "status",
				slide: snapshot.currentSlide,
				totalSlides: TOTAL_SLIDES,
				openCodeOnly: snapshot.openCodeOnly,
				chapter: {
					id: chapter.id,
					label: chapter.label,
					summary: chapter.sessionSummary,
				},
				activeStage: snapshot.activeStage,
				agencyName: snapshot.workbook.agencyName,
				serviceName: snapshot.workbook.serviceName,
				checklist: snapshot.workbook.checklist,
			},
		};
	}

	if (action === "goto_slide") {
		const slide = Number(args.slide);
		if (!Number.isInteger(slide) || slide < 1 || slide > TOTAL_SLIDES) {
			return {
				ok: false,
				error: `Parameter 'slide' must be an integer between 1 and ${TOTAL_SLIDES}`,
			};
		}
		controller.gotoSlide(slide);
		const chapter = getChapterForSlide(slide, snapshot.locale);
		return {
			ok: true,
			result: {
				action: "goto_slide",
				slide,
				chapterLabel: chapter.label,
			},
		};
	}

	if (action === "get_workbook") {
		return {
			ok: true,
			result: {
				action: "get_workbook",
				workbook: snapshot.workbook,
				markdown: compileWorkbookMarkdown(snapshot.workbook, snapshot.locale),
			},
		};
	}

	if (action === "update_workbook") {
		const rawPatch = args.patch;
		if (
			typeof rawPatch !== "object" ||
			rawPatch === null ||
			Array.isArray(rawPatch)
		) {
			return {
				ok: false,
				error: "Parameter 'patch' must be a plain object",
			};
		}
		const patchRecord = rawPatch as Record<string, unknown>;
		const safePatch: Partial<AxWorkbookFields> = {};
		for (const key of PATCHABLE_STRING_KEYS) {
			const val = patchRecord[key];
			if (typeof val === "string" && val.trim().length > 0) {
				safePatch[key] = val.trim().slice(0, 2000);
			}
		}
		const updated = controller.patchWorkbook(safePatch);
		return {
			ok: true,
			result: {
				action: "update_workbook",
				updatedKeys: Object.keys(safePatch),
				agencyName: updated.agencyName,
				serviceName: updated.serviceName,
			},
		};
	}

	const html = controller.regenerateWireframe();
	return {
		ok: true,
		result: {
			action: "generate_wireframe",
			htmlLength: html.length,
			serviceName: snapshot.workbook.serviceName,
		},
	};
}
