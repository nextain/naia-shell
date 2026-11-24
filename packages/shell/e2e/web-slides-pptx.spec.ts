import { type Page, expect, test } from "@playwright/test";
import { strToU8, zipSync } from "fflate";
import { openAppFromStoreLink, prepareStoreWorkspace } from "./helpers/web-store";

// R27: the web Slides mini-app opens a PPTX again.  The browser reads the
// package, draws each slide and shows it as a PDF with the speaker notes as
// the script.  Web runtime only: NAIA_E2E_WEB=1 and `vite --mode web --cors`
// and Chrome --disable-features=LocalNetworkAccessChecks: the Slides frame is
// sandboxed (opaque origin), so its dev modules load cross-origin from loopback.
test.skip(
	process.env.NAIA_E2E_WEB !== "1",
	"web Slides PPTX test only runs when NAIA_E2E_WEB=1",
);
test.setTimeout(180_000);

const SHOTS = process.env.NAIA_E2E_SHOTS_DIR;
const CORS = { "Access-Control-Allow-Origin": "*" };
const NS =
	'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL =
	"http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function rels(entries: Array<[string, string, string]>) {
	return `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries
		.map(
			([id, type, target]) =>
				`<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`,
		)
		.join("")}</Relationships>`;
}

function textBox(id: number, y: number, size: number, text: string) {
	return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="T${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="609600" y="${y}"/><a:ext cx="10972800" cy="1200000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr anchor="ctr"/><a:p><a:pPr algn="ctr"/><a:r><a:rPr sz="${size}" b="1"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
}

function deckPptx(): Buffer {
	const slides = [
		{
			bg: "1E3A8A",
			title: "R27 웹 PPTX 발표",
			sub: "브라우저에서 바로 엽니다",
			note: "첫 장 대본입니다.",
		},
		{
			bg: "065F46",
			title: "두 번째 장",
			sub: "Second slide",
			note: "둘째 장 대본입니다.",
		},
	];
	const files: Record<string, Uint8Array> = {
		"ppt/presentation.xml": strToU8(
			`<p:presentation ${NS}><p:sldIdLst>${slides
				.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`)
				.join(
					"",
				)}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`,
		),
		"ppt/_rels/presentation.xml.rels": strToU8(
			rels(
				slides.map((_, i) => [
					`rId${i + 1}`,
					"slide",
					`slides/slide${i + 1}.xml`,
				]),
			),
		),
	};
	slides.forEach((slide, i) => {
		const n = i + 1;
		files[`ppt/slides/slide${n}.xml`] = strToU8(
			`<p:sld ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="${slide.bg}"/></a:solidFill></p:bgPr></p:bg><p:spTree>${textBox(2, 2000000, 6000, slide.title)}${textBox(3, 3400000, 3200, slide.sub)}</p:spTree></p:cSld></p:sld>`,
		);
		files[`ppt/slides/_rels/slide${n}.xml.rels`] = strToU8(
			rels([["rId9", "notesSlide", `../notesSlides/notesSlide${n}.xml`]]),
		);
		files[`ppt/notesSlides/notesSlide${n}.xml`] = strToU8(
			`<p:notes ${NS}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="N"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>${slide.note}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`,
		);
	});
	return Buffer.from(zipSync(files));
}

async function bootWeb(page: Page) {
	await page.route("**/v1/apps/purchases", (route) => route.abort());
	await page.route("**/v1/apps/products", (route) =>
		route.fulfill({ status: 503, headers: CORS, json: { error: "down" } }),
	);
	await page.route("**/api/apps", (route) =>
		route.fulfill({ status: 200, headers: CORS, json: { apps: [] } }),
	);
	// The dev server has no built dist-slides; serve the Slides entry instead.
	await page.route("**/hosted-apps/naia-slides/index.html", async (route) => {
		const url = new URL("../../slides.html", route.request().url());
		const response = await route.fetch({ url: url.href });
		await route.fulfill({ response });
	});
	await page.addInitScript(() => {
		// Also runs inside the sandboxed (opaque-origin) Slides frame: no storage.
		if (window.top !== window) return;
		if (!localStorage.getItem("naia-config")) {
			localStorage.setItem(
				"naia-config",
				JSON.stringify({
					provider: "webllm",
					model: "Qwen3-4B-q4f32_1-MLC",
					ttsEnabled: false,
					locale: "ko",
				}),
			);
		}
	});
	await page.goto("./");
	await prepareStoreWorkspace(page);
	await expect(page.locator("html")).toHaveAttribute("data-naia-web", "true");
	await expect(page.locator('[data-app-ready="true"]')).toBeAttached({
		timeout: 60_000,
	});
}

async function openSlidesFromStore(page: Page) {
	await openAppFromStoreLink(page, "land.naia.slides");
	return page.frameLocator('iframe[src*="/hosted-apps/naia-slides/"]');
}

for (const viewport of [
	{ name: "desktop", width: 1280, height: 720 },
	{ name: "mobile", width: 390, height: 844 },
]) {
	test(`R27 web Slides opens a PPTX with its speaker notes (${viewport.name} ${viewport.width}x${viewport.height})`, async ({
		browser,
	}) => {
		const context = await browser.newContext({ viewport, locale: "ko-KR" });
		const page = await context.newPage();
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await bootWeb(page);
		const frame = await openSlidesFromStore(page);
		const input = frame.getByLabel(/PDF 또는 PPTX 열기|Open PDF or PPTX/);
		// The dev server compiles the Slides entry on first load; allow for it.
		await expect(input).toHaveAttribute("accept", /\.pptx/, {
			timeout: 90_000,
		});
		await input.setInputFiles({
			name: "r27-deck.pptx",
			mimeType:
				"application/vnd.openxmlformats-officedocument.presentationml.presentation",
			buffer: deckPptx(),
		});
		await expect(frame.locator(".slides-app__status")).toContainText(
			"r27-deck.pdf",
			{ timeout: 30_000 },
		);
		await expect(frame.locator(".slides-app__status")).toContainText(
			"r27-deck.md",
		);
		await expect(frame.locator(".slides-app__page canvas")).toBeVisible({
			timeout: 30_000,
		});
		await expect(frame.getByTestId("slides-current-note")).toContainText(
			"첫 장 대본입니다.",
		);
		// The rendered page is the slide picture: sample its background colour.
		const bg = await frame
			.locator(".slides-app__page canvas")
			.evaluate((canvas: HTMLCanvasElement) => {
				const ctx = canvas.getContext("2d");
				const d = ctx?.getImageData(4, 4, 1, 1).data;
				return d ? [d[0], d[1], d[2]] : null;
			});
		expect(bg).not.toBeNull();
		const [r, g, b] = bg as number[];
		expect(
			Math.abs(r - 0x1e) + Math.abs(g - 0x3a) + Math.abs(b - 0x8a),
		).toBeLessThan(40);
		await expect(frame.getByRole("alert")).toHaveCount(0);
		if (SHOTS)
			await page.screenshot({ path: `${SHOTS}/R27-${viewport.width}.png` });
		expect(errors).toEqual([]);
		await context.close();
	});
}

test("R27 web Slides reports an unreadable PPTX and keeps the input usable", async ({
	browser,
}) => {
	const context = await browser.newContext({
		viewport: { width: 1280, height: 720 },
		locale: "ko-KR",
	});
	const page = await context.newPage();
	await bootWeb(page);
	const frame = await openSlidesFromStore(page);
	const input = frame.getByLabel(/PDF 또는 PPTX 열기|Open PDF or PPTX/);
	await expect(input).toBeAttached({ timeout: 90_000 });
	await input.setInputFiles({
		name: "broken.pptx",
		mimeType:
			"application/vnd.openxmlformats-officedocument.presentationml.presentation",
		buffer: Buffer.from("not a zip"),
	});
	await expect(frame.getByText(/PPTX를 읽을 수 없거나/)).toBeVisible();
	await expect(input).toBeEnabled();
	await context.close();
});
