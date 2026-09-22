// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { extractExpression } from "../../lib/vrm/expression";
import { ChatMarkdown } from "../ChatMarkdown";

describe("ChatMarkdown", () => {
	afterEach(cleanup);

	it("renders GFM content while excluding raw HTML", () => {
		const { container } = render(
			<ChatMarkdown>{"**ready**\n\n<script>unsafe()</script>"}</ChatMarkdown>,
		);

		expect(screen.getByText("ready").tagName).toBe("STRONG");
		expect(container.querySelector("script")).toBeNull();
	});

	it("preserves workspace file deep links", () => {
		render(<ChatMarkdown>{"Open /tmp/result.json"}</ChatMarkdown>);

		expect(
			screen.getByRole("button", { name: "/tmp/result.json" }),
		).toBeDefined();
	});

	it("renders bold spans and every list item after emotion cleanup (#683)", () => {
		const raw =
			'[HAPPY] 네, 마스터 루크. **넥스테인(Nextain)** 은 기술 회사입니다.\n\n1. **"흠.. 기억을 못하네."** — 첫째.\n2. **"안녕"** — 둘째.\n3. **"넥스테인이 뭐하는 회사 인줄 알아?"** — 셋째.';
		const { container } = render(
			<ChatMarkdown>{extractExpression(raw).cleanText}</ChatMarkdown>,
		);

		const strongTexts = Array.from(container.querySelectorAll("strong")).map(
			(el) => el.textContent,
		);
		expect(strongTexts).toEqual([
			"넥스테인(Nextain)",
			'"흠.. 기억을 못하네."',
			'"안녕"',
			'"넥스테인이 뭐하는 회사 인줄 알아?"',
		]);
		expect(container.querySelectorAll("ol > li")).toHaveLength(3);
		expect(container.textContent).not.toContain("**");
	});
});
