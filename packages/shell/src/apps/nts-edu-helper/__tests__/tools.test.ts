import { describe, expect, it } from "vitest";
import { getPresetWorkbookFields } from "../locales/messages";
import {
	type AxStudioSnapshot,
	buildAxContextPayload,
	handleAxStudioToolCall,
} from "../tools";
import { generateInteractiveWireframeHtml } from "../workbook-domain";

function makeSnapshot(overrides?: Partial<AxStudioSnapshot>): AxStudioSnapshot {
	const wb = getPresetWorkbookFields("nts_tax", "ko");
	return {
		currentSlide: 1,
		openCodeOnly: false,
		activeStage: "stage1",
		workbook: wb,
		wireframeHtml: generateInteractiveWireframeHtml(wb, "ko"),
		locale: "ko",
		...overrides,
	};
}

describe("skill_ax_lecture_studio tool handler", () => {
	it("supports status, goto_slide, get_workbook, update_workbook, and generate_wireframe", () => {
		let slide = 1;
		let workbook = getPresetWorkbookFields("nts_tax", "ko");
		let html = generateInteractiveWireframeHtml(workbook, "ko");

		const controller = {
			getSnapshot: () =>
				makeSnapshot({ currentSlide: slide, workbook, wireframeHtml: html }),
			gotoSlide: (next: number) => {
				slide = next;
			},
			patchWorkbook: (patch: Partial<typeof workbook>) => {
				workbook = { ...workbook, ...patch };
				return workbook;
			},
			regenerateWireframe: () => {
				html = generateInteractiveWireframeHtml(workbook, "ko");
				return html;
			},
		};

		const status = handleAxStudioToolCall({ action: "status" }, controller);
		expect(status.ok).toBe(true);

		const moved = handleAxStudioToolCall(
			{ action: "goto_slide", slide: 65 },
			controller,
		);
		expect(moved.ok).toBe(true);
		expect(slide).toBe(65);

		const badSlide = handleAxStudioToolCall(
			{ action: "goto_slide", slide: 120 },
			controller,
		);
		expect(badSlide.ok).toBe(false);

		const patched = handleAxStudioToolCall(
			{
				action: "update_workbook",
				patch: {
					agencyName: "서울특별시 민원담당관",
					serviceName: "민원 편람 개정 도우미",
				},
			},
			controller,
		);
		expect(patched.ok).toBe(true);
		expect(workbook.agencyName).toBe("서울특별시 민원담당관");

		const fetched = handleAxStudioToolCall(
			{ action: "get_workbook" },
			controller,
		);
		expect(fetched.ok).toBe(true);
		if (fetched.ok) {
			expect(String(fetched.result.markdown)).toContain("서울특별시 민원담당관");
		}

		const gen = handleAxStudioToolCall(
			{ action: "generate_wireframe" },
			controller,
		);
		expect(gen.ok).toBe(true);
		expect(html).toContain("민원 편람 개정 도우미");

		const ctx = buildAxContextPayload(controller.getSnapshot());
		expect(ctx.type).toBe("ax_lecture_studio");
		expect(ctx.data.slide).toBe(65);
	});
});
