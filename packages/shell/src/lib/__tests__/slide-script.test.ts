import { describe, expect, it } from "vitest";
import {
	parseSlideScript,
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
		const original = "# Deck metadata\n\n## 2. Market title\nOld\n\n## 1. Cover\nFirst\n\n## Appendix\nKeep this";
		expect(replaceSlideScriptPage(original, 2, "New\nline")).toBe(
			"# Deck metadata\n\n## 2. Market title\nNew\nline\n\n## 1. Cover\nFirst\n\n## Appendix\nKeep this",
		);
		expect(replaceSlideScriptPage(original, 3, "")).toBe(
			"# Deck metadata\n\n## 2. Market title\nOld\n\n## 1. Cover\nFirst\n\n## Appendix\nKeep this\n\n## 3.",
		);
	});

	it("does not treat headings for another level as page sections", () => {
		const sections = parseSlideScript("## Intro\nignored\n\n### 3.\nsubheading");
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
});
