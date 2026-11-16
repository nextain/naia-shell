import { Logger } from "../../lib/logger";
import type { AxWorkbookFields, ChecklistStatus } from "./locales/messages";
import {
	buildOfflineStage1Draft,
	buildOfflineStage2Draft,
	escapeAxHtml,
	parseLocalizedStage1Reply,
	parseLocalizedStage2Reply,
	renderLocalizedStarterProjectFiles,
	renderLocalizedWireframeHtml,
	renderLocalizedWorkbookMarkdown,
} from "./locales/wireframe-copy";

const TAG = "AxWorkbookDomain";

export const escapeHtml = escapeAxHtml;

export function cycleChecklistStatus(current: ChecklistStatus): ChecklistStatus {
	if (current === "verified") return "pending";
	if (current === "pending") return "unverified";
	return "verified";
}

export function applyStage1AiReply(
	current: AxWorkbookFields,
	replyText: string,
): AxWorkbookFields {
	Logger.debug(TAG, "applying Stage 1 AI reply to workbook");
	return parseLocalizedStage1Reply(current, replyText);
}

export function synthesizeStage1OfflineDraft(
	current: AxWorkbookFields,
	localeOverride?: string,
): AxWorkbookFields {
	Logger.debug(TAG, "synthesizing offline Stage 1 draft");
	return buildOfflineStage1Draft(current, localeOverride);
}

export function applyStage2AiReply(
	current: AxWorkbookFields,
	replyText: string,
): AxWorkbookFields {
	Logger.debug(TAG, "applying Stage 2 AI reply to workbook");
	return parseLocalizedStage2Reply(current, replyText);
}

export function synthesizeStage2OfflineDraft(
	current: AxWorkbookFields,
	localeOverride?: string,
): AxWorkbookFields {
	Logger.debug(TAG, "synthesizing offline Stage 2 draft");
	return buildOfflineStage2Draft(current, localeOverride);
}

export function compileWorkbookMarkdown(
	fields: AxWorkbookFields,
	localeOverride?: string,
): string {
	return renderLocalizedWorkbookMarkdown(fields, localeOverride);
}

export function extractHtmlFromModelReply(replyText: string): string | null {
	const fenced = /```html\s*([\s\S]*?)```/i.exec(replyText);
	if (fenced?.[1] && /<html|<body|<div/i.test(fenced[1])) {
		return fenced[1].trim();
	}
	const rawDoc = /(<!doctype html[\s\S]*?<\/html>)/i.exec(replyText);
	if (rawDoc?.[1]) {
		return rawDoc[1].trim();
	}
	return null;
}

export function generateInteractiveWireframeHtml(
	fields: AxWorkbookFields,
	localeOverride?: string,
): string {
	Logger.debug(TAG, "generating interactive AX wireframe HTML");
	return renderLocalizedWireframeHtml(fields, localeOverride);
}

export function buildAxStarterProjectFiles(
	fields: AxWorkbookFields,
	wireframeHtml: string,
	localeOverride?: string,
): Array<{ path: string; content: string }> {
	return renderLocalizedStarterProjectFiles(
		fields,
		wireframeHtml,
		localeOverride,
	);
}
