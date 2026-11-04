// @vitest-environment jsdom
/**
 * UC-UI-FONT-SCALE-20261105 / FR-UI-FONT-SCALE.1~2 — 앱 전체 글자 크기.
 *
 * Run:
 *   pnpm exec vitest run src/lib/__tests__/ui-font-scale.test.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_UI_FONT_SCALE,
	UI_FONT_SCALES,
	UI_FONT_SCALE_EVENT,
	UI_FONT_SCALE_IDS,
	applyUiFontScale,
	normalizeUiFontScale,
	scaledFontSize,
	uiFontScaleFactor,
} from "../ui-font-scale";

afterEach(() => {
	document.documentElement.style.removeProperty("--ui-font-scale");
	delete document.documentElement.dataset.uiFontScale;
});

describe("ui font scale values", () => {
	it("defaults to normal (1.0) and offers four ordered choices", () => {
		expect(DEFAULT_UI_FONT_SCALE).toBe("normal");
		expect(UI_FONT_SCALE_IDS).toEqual(["small", "normal", "large", "xlarge"]);
		expect(UI_FONT_SCALES).toEqual({
			small: 0.9,
			normal: 1,
			large: 1.25,
			xlarge: 1.5,
		});
	});

	it("normalizes missing or unknown persisted values to normal", () => {
		expect(normalizeUiFontScale(undefined)).toBe("normal");
		expect(normalizeUiFontScale(null)).toBe("normal");
		expect(normalizeUiFontScale("huge")).toBe("normal");
		expect(normalizeUiFontScale(1.5)).toBe("normal");
		expect(normalizeUiFontScale("toString")).toBe("normal");
		expect(normalizeUiFontScale("xlarge")).toBe("xlarge");
		expect(uiFontScaleFactor("large")).toBe(1.25);
		expect(uiFontScaleFactor("bogus")).toBe(1);
	});

	it("builds inline font sizes from the same CSS variable", () => {
		expect(scaledFontSize(13)).toBe("calc(13px * var(--ui-font-scale, 1))");
	});
});

describe("applyUiFontScale", () => {
	it("sets the root CSS variable and data attribute", () => {
		expect(applyUiFontScale("xlarge")).toBe("xlarge");
		const root = document.documentElement;
		expect(root.style.getPropertyValue("--ui-font-scale")).toBe("1.5");
		expect(root.dataset.uiFontScale).toBe("xlarge");

		applyUiFontScale("small");
		expect(root.style.getPropertyValue("--ui-font-scale")).toBe("0.9");
		expect(root.dataset.uiFontScale).toBe("small");
	});

	it("falls back to normal for an unknown stored value", () => {
		expect(applyUiFontScale("giant")).toBe("normal");
		expect(
			document.documentElement.style.getPropertyValue("--ui-font-scale"),
		).toBe("1");
	});

	it("notifies px-positioned popovers only when the scale actually changes", () => {
		const listener = vi.fn();
		window.addEventListener(UI_FONT_SCALE_EVENT, listener);
		try {
			applyUiFontScale("large");
			applyUiFontScale("large");
			applyUiFontScale("normal");
			expect(listener).toHaveBeenCalledTimes(2);
			expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({
				id: "large",
				factor: 1.25,
			});
		} finally {
			window.removeEventListener(UI_FONT_SCALE_EVENT, listener);
		}
	});

	it("can target a detached root (no global side effects)", () => {
		const root = document.createElement("div");
		applyUiFontScale("large", root);
		expect(root.style.getPropertyValue("--ui-font-scale")).toBe("1.25");
		expect(
			document.documentElement.style.getPropertyValue("--ui-font-scale"),
		).toBe("");
	});
});

/**
 * 글자 배율은 스타일시트의 font-size 가 변수를 곱할 때만 닿는다. 새 규칙이
 * 맨 px/rem 을 쓰면 그 글자만 배율을 무시한다 — 여기서 막는다. em·% 는
 * 부모를 따라 한 번만 커지므로 허용한다.
 */
describe("stylesheet font-size contract (FR-UI-FONT-SCALE.2)", () => {
	const stylesheets = [
		"src/styles/global.css",
		"src/apps/projects/projects.css",
		"src/apps/slides/slides.css",
	];

	it.each(stylesheets)("%s scales every px/rem font-size", (path) => {
		const css = readFileSync(resolve(__dirname, "../../..", path), "utf-8");
		const declarations = [...css.matchAll(/font-size\s*:\s*([^;}]+)/g)].map(
			(m) => m[1].trim(),
		);
		expect(declarations.length).toBeGreaterThan(0);
		const unscaled = declarations.filter(
			(value) =>
				/\d(px|rem)\b/.test(value) && !value.includes("var(--ui-font-scale"),
		);
		expect(unscaled).toEqual([]);
	});

	it("defines the default scale on :root", () => {
		const css = readFileSync(
			resolve(__dirname, "../../..", "src/styles/global.css"),
			"utf-8",
		);
		expect(css).toMatch(/:root\s*\{\s*--ui-font-scale:\s*1;/);
	});
});
