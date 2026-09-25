import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * FR-SLIDES-PDF-SOFTMASK.1 regression guard.
 *
 * pdf.js < 6.0.227 composes PDF soft masks (/SMask Luminosity, Alpha + /TR)
 * only through CanvasRenderingContext2D.filter = "url(#svg-filter)".
 * WebKitGTK — the Linux Tauri webview — has no canvas `filter`, so the mask
 * was silently skipped and every transparent gradient (gradient text,
 * radial glows, box-shadow) was painted as an opaque block. pdf.js 6.0.227
 * (mozilla/pdf.js#21236, #21264) added a pixel-buffer fallback.
 *
 * react-pdf 10 pins pdfjs-dist 5.4.296, so the workspace overrides it. This
 * test keeps the override and the app's own pdfjs-dist (whose worker URL the
 * Slides and Workspace viewers import) on one fixed version.
 */
const MIN_VERSION = [6, 0, 227];

const shellRequire = createRequire(join(process.cwd(), "package.json"));

function resolvePdfjsFrom(requireFn: NodeRequire) {
	const manifestPath = requireFn.resolve("pdfjs-dist/package.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
		version: string;
	};
	return { root: dirname(manifestPath), version: manifest.version };
}

function atLeast(version: string, minimum: number[]) {
	const parts = version.split(".").map(Number);
	for (let i = 0; i < minimum.length; i++) {
		if ((parts[i] ?? 0) !== minimum[i]) return (parts[i] ?? 0) > minimum[i];
	}
	return true;
}

describe("Slides/Workspace pdf.js soft-mask rendering on WebKitGTK", () => {
	const app = resolvePdfjsFrom(shellRequire);
	const reactPdf = resolvePdfjsFrom(
		createRequire(shellRequire.resolve("react-pdf")),
	);

	it("react-pdf renders with the same pdf.js the app ships as its worker", () => {
		expect(reactPdf.version).toBe(app.version);
		expect(reactPdf.root).toBe(app.root);
	});

	it("uses a pdf.js with the canvas-filter-free soft-mask fallback", () => {
		expect(atLeast(app.version, MIN_VERSION)).toBe(true);
		const displayLayer = readFileSync(
			join(app.root, "build", "pdf.mjs"),
			"utf8",
		);
		expect(displayLayer).toContain("isCanvasFilterSupported");
	});
});
