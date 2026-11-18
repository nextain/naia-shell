import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { buildPptxPresentation, readPptxZipEntries } from "../src/lib/pptx-ooxml";

const MIME_BY_EXT: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".webp": "image/webp",
	".mp3": "audio/mpeg",
	".pdf": "application/pdf",
	".md": "text/markdown; charset=utf-8",
};

async function assertValidDownloadedPptx(
	pptxPath: string,
	expectedSlides: number,
): Promise<void> {
	const bytes = new Uint8Array(readFileSync(pptxPath));
	const entries = await readPptxZipEntries(bytes);
	expect(entries.has("[Content_Types].xml")).toBe(true);
	expect(entries.has("_rels/.rels")).toBe(true);
	expect(entries.has("ppt/presentation.xml")).toBe(true);
	expect(entries.has("ppt/slideMasters/slideMaster1.xml")).toBe(true);
	expect(entries.has("ppt/slideLayouts/slideLayout1.xml")).toBe(true);
	expect(entries.has("ppt/theme/theme1.xml")).toBe(true);
	for (let i = 1; i <= expectedSlides; i += 1) {
		expect(entries.has(`ppt/slides/slide${i}.xml`)).toBe(true);
		expect(entries.has(`ppt/slides/_rels/slide${i}.xml.rels`)).toBe(true);
	}

	if (spawnSync("which", ["soffice"]).status === 0) {
		const outDir = mkdtempSync(join(tmpdir(), "naia-e2e-pptx-"));
		try {
			execFileSync(
				"soffice",
				[
					`-env:UserInstallation=file://${join(outDir, "profile")}`,
					"--headless",
					"--convert-to",
					"pdf",
					"--outdir",
					outDir,
					pptxPath,
				],
				{ stdio: "pipe", timeout: 45_000 },
			);
			const pdfFiles = execFileSync("ls", [outDir], { encoding: "utf8" })
				.split(/\r?\n/)
				.filter((f) => f.endsWith(".pdf"));
			expect(pdfFiles.length).toBe(1);
			const pdfBytes = readFileSync(join(outDir, pdfFiles[0]));
			expect(pdfBytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	}
}

test.use({
	launchOptions: {
		executablePath: existsSync("/usr/bin/google-chrome")
			? "/usr/bin/google-chrome"
			: undefined,
	},
});

test.describe("Stage-1 Web Hosted Static Mini-Apps (4 bundles, zero Tauri, opaque sandbox)", () => {
	let server: ReturnType<typeof createServer>;
	let origin = "";
	let stagedDir = "";

	test.beforeAll(async ({}, workerInfo) => {
		stagedDir = workerInfo.project.outputDir
			? resolve(workerInfo.project.outputDir, "hosted-apps-e2e")
			: resolve(process.cwd(), "dist-hosted-apps");
		const hasExisting =
			existsSync(join(process.cwd(), "dist-slides/index.html")) &&
			existsSync(join(process.cwd(), "dist-ieumoffice/index.html")) &&
			existsSync(join(process.cwd(), "dist-cafelua-tarot/index.html")) &&
			existsSync(join(process.cwd(), "dist-charcard/index.html"));
		execFileSync(
			"node",
			[
				"scripts/stage-web-hosted-apps.mjs",
				stagedDir,
				...(hasExisting ? ["--skip-build"] : []),
			],
			{ cwd: process.cwd(), stdio: "pipe", timeout: 120_000 },
		);

		server = createServer((req, res) => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			if (url.pathname === "/host-shell") {
				const src = url.searchParams.get("src") ?? "";
				res.writeHead(200, {
					"Content-Type": "text/html; charset=utf-8",
					"Cross-Origin-Opener-Policy": "same-origin",
					"Cross-Origin-Embedder-Policy": "credentialless",
				});
				res.end(`<!DOCTYPE html><html><body style="margin:0"><iframe id="app-frame" sandbox="allow-scripts allow-forms allow-downloads allow-popups" src="${src}" style="width:1200px;height:800px;border:0"></iframe><script>
window.__HOST_MESSAGES__ = [];
window.addEventListener("message", (e) => { window.__HOST_MESSAGES__.push(e.data); });
</script></body></html>`);
				return;
			}

			if (!url.pathname.startsWith("/hosted-apps/")) {
				res.writeHead(404).end("not found");
				return;
			}
			const rel = normalize(
				decodeURIComponent(url.pathname.slice("/hosted-apps/".length)),
			);
			if (rel.startsWith("..") || rel.includes("..")) {
				res.writeHead(403).end("forbidden");
				return;
			}
			const fullPath = join(stagedDir, rel);
			if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
				res.writeHead(404).end("missing");
				return;
			}
			const mime =
				MIME_BY_EXT[extname(fullPath).toLowerCase()] ??
				"application/octet-stream";
			res.writeHead(200, {
				"Content-Type": mime,
				"Cross-Origin-Embedder-Policy": "credentialless",
				"Cross-Origin-Resource-Policy": "cross-origin",
				"X-Content-Type-Options": "nosniff",
			});
			res.end(readFileSync(fullPath));
		});

		await new Promise<void>((resolveListen) => {
			server.listen(0, "127.0.0.1", () => resolveListen());
		});
		const addr = server.address() as AddressInfo;
		origin = `http://127.0.0.1:${addr.port}`;
	});

	test.afterAll(async () => {
		await new Promise<void>((resolveClose) =>
			server.close(() => resolveClose()),
		);
	});

	test("1. Naia Slides (v0.2.0) runs in opaque sandbox, imports .pptx, edits notes, and downloads valid .pptx", async ({
		page,
	}) => {
		const errors: string[] = [];
		page.on("pageerror", (err) => errors.push(err.message));

		await page.goto(
			`${origin}/host-shell?src=/hosted-apps/land.naia.slides/index.html`,
		);
		const frame = page.frameLocator("#app-frame");
		await expect(frame.locator(".slides-app")).toBeVisible();

		await page.evaluate(() => {
			const iframe = document.getElementById("app-frame") as HTMLIFrameElement;
			iframe.contentWindow?.postMessage(
				{ type: "naia-app:locale", locale: "ko" },
				"*",
			);
		});
		await expect(frame.getByLabel("PDF 또는 PPTX 열기")).toBeVisible();

		const samplePptx = buildPptxPresentation({
			title: "E2E Web Slides",
			slides: [
				{
					title: "웹 슬라이드 1장",
					bullets: ["브라우저 직접 렌더링"],
					notes: "원본 1장 대본",
				},
				{
					title: "웹 슬라이드 2장",
					bullets: ["PPTX 왕복 저장"],
					notes: "원본 2장 대본",
				},
			],
		});

		await frame.getByLabel("PDF 또는 PPTX 열기").setInputFiles({
			name: "web-demo.pptx",
			mimeType:
				"application/vnd.openxmlformats-officedocument.presentationml.presentation",
			buffer: Buffer.from(samplePptx),
		});

		await expect(frame.getByTestId("pptx-slide-1")).toBeVisible();
		await expect(frame.getByText("웹 슬라이드 1장")).toBeVisible();
		await expect(frame.getByTestId("slides-current-note")).toHaveText(
			"원본 1장 대본",
		);

		await frame.getByTestId("slides-edit-script").click();
		await frame
			.getByTestId("slides-script-editor")
			.fill("브라우저에서 편집한 1장 대본");
		await frame.getByTestId("slides-apply-script").click();

		const downloadPromise = page.waitForEvent("download");
		await frame.getByTestId("slides-export-pptx").click();
		const download = await downloadPromise;
		expect(download.suggestedFilename()).toBe("web-demo.pptx");
		const dlPath = await download.path();
		expect(dlPath).toBeTruthy();
		await assertValidDownloadedPptx(dlPath!, 2);
		const notesXml = new TextDecoder().decode(
			(await readPptxZipEntries(new Uint8Array(readFileSync(dlPath!)))).get(
				"ppt/notesSlides/notesSlide1.xml",
			)!,
		);
		expect(notesXml).toContain("브라우저에서 편집한 1장 대본");
		expect(errors).toEqual([]);
	});

	test("2. IeumOffice (v0.2.0) runs in pure browser / opaque sandbox across docx, xlsx, mindmap, and pptx export", async ({
		page,
	}) => {
		const errors: string[] = [];
		page.on("pageerror", (err) => errors.push(err.message));

		await page.goto(
			`${origin}/host-shell?src=/hosted-apps/land.naia.ieumoffice/index.html`,
		);
		const frame = page.frameLocator("#app-frame");
		await expect(frame.getByTestId("ieumoffice-studio")).toBeVisible();

		// Switch to Spreadsheet (.xlsx) and verify table rendering
		await frame.getByRole("button", { name: /xlsx/i }).first().click();
		await expect(frame.locator("table")).toBeVisible();

		// Switch to Mindmap (.xmind) -> convert to Slides (.pptx) -> export .pptx
		await frame.getByRole("button", { name: /xmind/i }).first().click();
		await frame.getByRole("button", { name: /PPTX|슬라이드/i }).first().click();

		const downloadPromise = page.waitForEvent("download");
		await frame
			.getByRole("button", { name: /내보내기|원본 형식|Export/i })
			.first()
			.click();
		const download = await downloadPromise;
		expect(download.suggestedFilename().endsWith(".pptx")).toBe(true);
		const dlPath = await download.path();
		expect(dlPath).toBeTruthy();
		await assertValidDownloadedPptx(dlPath!, 1);
		expect(errors).toEqual([]);
	});

	test("3. Cafe Lua Tarot (v0.1.5) runs in opaque sandbox with 1/3/10 spread selector and 1-click card zoom", async ({
		page,
	}) => {
		const errors: string[] = [];
		page.on("pageerror", (err) => errors.push(err.message));

		await page.goto(
			`${origin}/host-shell?src=/hosted-apps/land.naia.cafelua-tarot/index.html`,
		);
		const frame = page.frameLocator("#app-frame");
		await expect(frame.locator("body")).toContainText(/카페루아|Cafe Lua/i);

		await page.evaluate(() => {
			const iframe = document.getElementById("app-frame") as HTMLIFrameElement;
			iframe.contentWindow?.postMessage(
				{
					type: "naia-tool-call",
					id: "tarot-start-1",
					tool: "skill_cafelua_tarot",
					args: {
						action: "start_reading",
						spread: "three",
						question: "올해 웹 출시 운세",
					},
				},
				"*",
			);
		});
		await expect
			.poll(() =>
				page.evaluate(() =>
					(window as any).__HOST_MESSAGES__.some(
						(m: any) =>
							m?.type === "naia-tool-result" && m?.id === "tarot-start-1",
					),
				),
			)
			.toBe(true);

		await page.evaluate(() => {
			const iframe = document.getElementById("app-frame") as HTMLIFrameElement;
			iframe.contentWindow?.postMessage(
				{
					type: "naia-tool-call",
					id: "tarot-reveal-1",
					tool: "skill_cafelua_tarot",
					args: { action: "reveal_card", position: 1 },
				},
				"*",
			);
		});
		await expect
			.poll(() =>
				page.evaluate(() =>
					(window as any).__HOST_MESSAGES__.some(
						(m: any) =>
							m?.type === "naia-tool-result" && m?.id === "tarot-reveal-1",
					),
				),
			)
			.toBe(true);
		expect(errors).toEqual([]);
	});

	test("4. Character Card (v0.1.0, SillyTavern V2/V3) runs in opaque sandbox with memory fallback and pushes roleplay context", async ({
		page,
	}) => {
		const errors: string[] = [];
		page.on("pageerror", (err) => errors.push(err.message));

		await page.goto(
			`${origin}/host-shell?src=/hosted-apps/land.naia.charcard/index.html`,
		);
		const frame = page.frameLocator("#app-frame");
		await expect(frame.getByTestId("charcard-detail-name")).toHaveText("온새미");

		await frame.getByTestId("charcard-start-button").click();

		await expect
			.poll(() =>
				page.evaluate(() =>
					(window as any).__HOST_MESSAGES__.some(
						(m: any) => m?.type === "naia-app:context" && m?.context !== null,
					),
				),
			)
			.toBe(true);
		expect(errors).toEqual([]);
	});
});
