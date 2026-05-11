/**
 * Test: tauri.conf.json window.backgroundColor is set to dark navy (#254 Phase 1).
 *
 * Without backgroundColor, the OS window opens with a white (or transparent
 * showing the desktop) background until React mounts + paints. The dark
 * navy [6, 13, 20, 255] matches the body background in index.html, so even
 * if there's a gap between show() and React-paint, the user sees a coherent
 * dark frame instead of a white flash.
 *
 * Run:
 *   pnpm exec vitest run src/lib/__tests__/window-background-color.test.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function loadConfig(): any {
	const path = resolve(__dirname, "../../../src-tauri/tauri.conf.json");
	return JSON.parse(readFileSync(path, "utf-8"));
}

describe("window.backgroundColor (#254 Phase 1)", () => {
	it("main window has backgroundColor set", () => {
		const cfg = loadConfig();
		const win = cfg.app?.windows?.[0];
		expect(win).toBeTruthy();
		expect(win.backgroundColor).toBeTruthy();
	});

	it("backgroundColor is a 4-tuple of u8 values (RGBA)", () => {
		const cfg = loadConfig();
		const bg = cfg.app.windows[0].backgroundColor;
		expect(Array.isArray(bg)).toBe(true);
		expect(bg).toHaveLength(4);
		for (const channel of bg) {
			expect(channel).toBeGreaterThanOrEqual(0);
			expect(channel).toBeLessThanOrEqual(255);
		}
	});

	it("backgroundColor is dark (not white) — sum of RGB < 100", () => {
		const cfg = loadConfig();
		const [r, g, b] = cfg.app.windows[0].backgroundColor;
		expect(r + g + b).toBeLessThan(100);
	});

	it("alpha channel is opaque (255)", () => {
		const cfg = loadConfig();
		const bg = cfg.app.windows[0].backgroundColor;
		expect(bg[3]).toBe(255);
	});
});
