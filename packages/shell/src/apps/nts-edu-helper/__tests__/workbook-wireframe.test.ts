// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { getPresetWorkbookFields } from "../locales/messages";
import { resolveSlideImageUrl } from "../slide-url";
import {
	applyStage1AiReply,
	applyStage2AiReply,
	compileWorkbookMarkdown,
	cycleChecklistStatus,
	extractHtmlFromModelReply,
	generateInteractiveWireframeHtml,
} from "../workbook-domain";

describe("AX Lecture workbook synthesis, wireframe generator & slide URL anchor", () => {
	it("derives rewritten Tauri asset base URL from #naia-asset-anchor for slides s01..s97", () => {
		const doc = document.implementation.createHTMLDocument("test");
		const anchor = doc.createElement("img");
		anchor.id = "naia-asset-anchor";
		anchor.setAttribute(
			"src",
			"http://asset.localhost/apps/land.naia.nts-edu-helper/s01.webp?v=2",
		);
		doc.body.appendChild(anchor);

		expect(resolveSlideImageUrl(1, doc)).toBe(
			"http://asset.localhost/apps/land.naia.nts-edu-helper/s01.webp",
		);
		expect(resolveSlideImageUrl(77, doc)).toBe(
			"http://asset.localhost/apps/land.naia.nts-edu-helper/s77.webp",
		);
		expect(resolveSlideImageUrl(97, doc)).toBe(
			"http://asset.localhost/apps/land.naia.nts-edu-helper/s97.webp",
		);
	});

	it("compiles 2-page Markdown plan with citations, [[확인 필요]], and 6-category checklist", () => {
		const fields = getPresetWorkbookFields("nts_tax", "ko");
		const md = compileWorkbookMarkdown(fields, "ko");
		expect(md).toContain("교육자료 갱신 도우미");
		expect(md).toContain("[[확인 필요");
		expect(md).toContain("1. 개인정보");
		expect(md).toContain("5. 사람 개입");

		expect(cycleChecklistStatus("verified")).toBe("pending");
		expect(cycleChecklistStatus("pending")).toBe("unverified");
		expect(cycleChecklistStatus("unverified")).toBe("verified");
	});

	it("generates interactive ①-⑦ HTML wireframe and escapes untrusted user input", () => {
		const base = getPresetWorkbookFields("local_gov", "ko");
		const malicious = {
			...base,
			serviceName: '민원 도우미 <script>alert("xss")</script>',
		};
		const html = generateInteractiveWireframeHtml(malicious, "ko");
		expect(html).toContain("<!doctype html>");
		expect(html).toContain("①");
		expect(html).toContain("⑦");
		expect(html).toContain('id="btn-approve"');
		expect(html).toContain('id="btn-reject"');
		expect(html).toContain('id="audit-body"');
		expect(html).not.toContain('<script>alert("xss")</script>');
		expect(html).toContain("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
	});

	it("parses Stage 1, Stage 2, and Stage 3 HTML model replies cleanly", () => {
		const base = getPresetWorkbookFields("custom", "ko");
		const s1 = applyStage1AiReply(
			base,
			"병목위험: 조례 대조 지연\n개인정보원칙: 실명 배제\n한줄승인규칙: 주무관 원문 대조 후 승인",
		);
		expect(s1.bottleneckRisk).toBe("조례 대조 지연");
		expect(s1.approvalStopRule).toBe("주무관 원문 대조 후 승인");

		const s2 = applyStage2AiReply(
			s1,
			"업무목적: 신속 정확한 개정 반영\nAI역할: 출처 포함 초안 작성 후 정지",
		);
		expect(s2.purpose).toBe("신속 정확한 개정 반영");
		expect(s2.aiRole).toBe("출처 포함 초안 작성 후 정지");

		const extracted = extractHtmlFromModelReply(
			"Here is your wireframe:\n```html\n<!doctype html><html><body><h1>Custom</h1></body></html>\n```",
		);
		expect(extracted).toBe(
			"<!doctype html><html><body><h1>Custom</h1></body></html>",
		);
	});
});
