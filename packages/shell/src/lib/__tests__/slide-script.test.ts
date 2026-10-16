import { describe, expect, it } from "vitest";
import {
	parseSlideScript,
	parseSlideVideoDirectives,
	replaceSlideScriptPage,
	serializeSlideScript,
} from "../slide-script";

describe("slide script sections", () => {
	it("retains authored-empty pages and their physical indexes", () => {
		const sections = parseSlideScript(
			"# Deck\n\n## 01.\n\n## 02.\nSecond narration\n\n## 04.\n",
		);

		expect([...sections.entries()]).toEqual([
			[1, ""],
			[2, "Second narration"],
			[4, ""],
		]);
		expect(serializeSlideScript(sections)).toBe(
			"## 1.\n\n## 2.\nSecond narration\n\n## 4.",
		);
	});

	it("updates an existing page and appends a missing page deterministically", () => {
		const original =
			"# Deck metadata\n\n## 2. Market title\nOld\n\n## 1. Cover\nFirst\n\n## Appendix\nKeep this";
		expect(replaceSlideScriptPage(original, 2, "New\nline")).toBe(
			"# Deck metadata\n\n## 2. Market title\nNew\nline\n\n## 1. Cover\nFirst\n\n## Appendix\nKeep this",
		);
		expect(replaceSlideScriptPage(original, 3, "")).toBe(
			"# Deck metadata\n\n## 2. Market title\nOld\n\n## 1. Cover\nFirst\n\n## Appendix\nKeep this\n\n## 3.",
		);
	});

	it("does not treat headings for another level as page sections", () => {
		const sections = parseSlideScript(
			"## Intro\nignored\n\n### 3.\nsubheading",
		);
		expect(sections.size).toBe(0);
	});

	it("replaces zero-padded headings without adding a duplicate page", () => {
		const original = "# Deck\n\n## 01. Main\nOld\n\n## 2. Next\nKeep";
		expect(replaceSlideScriptPage(original, 1, "New")).toBe(
			"# Deck\n\n## 01. Main\nNew\n\n## 2. Next\nKeep",
		);
	});

	it("keeps a raw level-two heading in edited body text", () => {
		const edited = replaceSlideScriptPage(
			"## 1. Main\nOld\n\n## 2. Next\nKeep",
			1,
			"Intro\n## raw heading\nTail",
		);
		const sections = parseSlideScript(edited);
		expect(sections.get(1)).toBe("Intro\n## raw heading\nTail");
		expect(sections.get(2)).toBe("Keep");
	});

	it("parses video heads separately in M order and excludes their body from narration", () => {
		const markdown =
			"## 7. Page seven\nNarration.\n\n## 7-2. [video] second.mp4\nDo not narrate this.\n\n## 7-1. [영상] demo.webm\nAlso not narration.\n\n## 8. Next\nNext narration.";
		const sections = parseSlideScript(markdown);
		expect(sections.get(7)).toBe("Narration.");
		expect(sections.get(8)).toBe("Next narration.");
		expect(parseSlideVideoDirectives(markdown)).toMatchObject([
			{ page: 7, order: 1, fileName: "demo.webm", validName: true },
			{ page: 7, order: 2, fileName: "second.mp4", validName: true },
		]);
	});

	it("rejects path-like, hidden and unsupported video filenames", () => {
		const headings = [
			"../escape.mp4",
			"/absolute.mp4",
			".hidden.webm",
			"nested\\clip.mp4",
			'quoted"name.mp4',
			"clip.mov",
			"control\u0001name.mp4",
		].map((name, index) => `## 1-${index + 1}. [video] ${name}`);
		expect(parseSlideVideoDirectives(headings.join("\n"))).toEqual(
			expect.arrayContaining(
				headings.map((_, index) =>
					expect.objectContaining({ order: index + 1, validName: false }),
				),
			),
		);
	});

	it("preserves video heads and opaque bodies through page editing and serialization", () => {
		const original =
			"## 7. Main\nOld narration\n\n## 7-1. [영상] demo.mp4\nPreserved metadata\n\n## 8. Next\nKeep";
		const edited = replaceSlideScriptPage(original, 7, "New narration");
		expect(edited).toContain("## 7-1. [영상] demo.mp4\nPreserved metadata");
		const sections = parseSlideScript(edited);
		expect(serializeSlideScript(sections)).toContain(
			"## 7-1. [영상] demo.mp4\nPreserved metadata",
		);
		expect(parseSlideVideoDirectives(edited)).toHaveLength(1);
	});
});
