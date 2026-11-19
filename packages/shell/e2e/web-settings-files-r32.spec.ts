import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { zipSync } from "fflate";
import {
	openBgmApp,
	openWebShellWithBgm,
	silentWav,
	WEB_BGM_VIEWPORTS,
} from "./helpers/web-bgm";

test.skip(
	process.env.NAIA_E2E_WEB !== "1" || process.env.VITE_NAIA_WEB_LLM !== "fake",
	"requires web runtime and fake model",
);
test.setTimeout(150_000);
test.beforeEach(async ({ context, baseURL }) => {
	await context.route(/^https?:\/\//, (route) =>
		new URL(route.request().url()).origin ===
		new URL(baseURL ?? "http://localhost").origin
			? route.continue()
			: route.abort(),
	);
});

const shots = process.env.NAIA_E2E_SHOTS_DIR;
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aUukAAAAASUVORK5CYII=",
	"base64",
);

async function openWorkspace(page: Page) {
	const shortcut = page.getByRole("button", { name: "작업공간", exact: true });
	if (await shortcut.isVisible()) {
		await shortcut.click();
	} else {
		await page.getByRole("button", { name: "Menu", exact: true }).click();
		await page
			.locator(".web-mobile-menu-list")
			.getByRole("button", { name: /작업공간/ })
			.click();
	}
	const tree = page.getByTestId("web-workspace-tree");
	await expect(tree).toBeVisible();
	return tree;
}

async function openFolder(scope: Locator, name: string) {
	const summary = scope.getByText("📁 " + name, { exact: true });
	const details = summary.locator("..");
	await expect(summary).toBeVisible();
	if ((await details.getAttribute("open")) === null) {
		await summary.click();
	}
	await expect(details).toHaveAttribute("open", "");
	return details;
}

async function chooseFile(
	page: Page,
	button: Locator,
	file: {
		name: string;
		mimeType: string;
		buffer: Buffer;
	},
) {
	const [picker] = await Promise.all([
		page.waitForEvent("filechooser"),
		button.click(),
	]);
	await picker.setFiles(file);
}

async function showTree(page: Page, tree: Locator) {
	if (!(await tree.isVisible())) {
		await page.getByTestId("web-workspace-tree-toggle").click();
	}
	await expect(tree).toBeVisible();
}

for (const viewport of WEB_BGM_VIEWPORTS) {
	test.describe(viewport.width + "×" + viewport.height, () => {
		test.use({ viewport, locale: "ko-KR" });

		test("R32 shows and opens default media alongside files imported into naia-settings", async ({
			page,
		}) => {
			await openWebShellWithBgm(page, { openBgm: false });
			const tree = await openWorkspace(page);
			const settings = await openFolder(tree, "naia-settings");
			const background = await openFolder(settings, "background");
			const bundledImage = background.getByRole("button", {
				name: /naia-sunrise-river\.webp.*앱 기본/,
			});
			await expect(
				background.getByRole("button", {
					name: /naia-autumn-office-live\.mp4.*앱 기본/,
				}),
			).toBeVisible();
			const vrm = await openFolder(settings, "vrm-files");
			await expect(
				vrm.getByRole("button", { name: /03-OL_Woman\.vrm.*앱 기본/ }),
			).toBeVisible();
			const nva = await openFolder(settings, "nva-files");
			const bundledAvatar = await openFolder(nva, "naia");
			await expect(
				bundledAvatar.getByRole("button", { name: /manifest\.json.*앱 기본/ }),
			).toBeVisible();

			await bundledImage.click();
			const viewer = page.getByTestId("web-workspace-viewer");
			await expect(viewer.locator(".web-workspace-viewer-bar code")).toHaveText(
				"naia-sunrise-river.webp",
			);
			await expect
				.poll(() =>
					viewer
						.locator("img")
						.evaluate((img: HTMLImageElement) => img.naturalWidth),
				)
				.toBeGreaterThan(0);
			expect(
				await page.evaluate(async () => {
					const root = await navigator.storage.getDirectory();
					const adk = await root.getDirectoryHandle("naia-adk");
					const settingsDir = await adk.getDirectoryHandle("naia-settings");
					return await Promise.all(
						["background", "vrm-files", "nva-files"].map((name) =>
							settingsDir.getDirectoryHandle(name).then(
								() => name,
								() => null,
							),
						),
					);
				}),
			).toEqual([null, null, null]);
			await showTree(page, tree);

			const upload = tree.getByRole("button", {
				name: "파일 가져오기",
				exact: true,
			});
			const selectFolder = background.getByRole("button", {
				name: "background에 가져오기",
			});
			await selectFolder.focus();
			await page.keyboard.press("Enter");
			await expect(selectFolder).toHaveAttribute("aria-pressed", "true");
			await expect(
				tree.getByTestId("web-workspace-import-destination"),
			).toContainText("naia-settings/background");
			await chooseFile(page, upload, {
				name: "메모.txt",
				mimeType: "text/plain",
				buffer: Buffer.from("memo"),
			});
			await expect(tree.getByRole("alert")).toContainText("지원 파일 형식");
			await expect(
				background.getByRole("button", { name: /메모\.txt/ }),
			).toHaveCount(0);

			// Hold the real browser write so the saving state is observable before OPFS commits.
			await page.evaluate(() => {
				const prototype = FileSystemFileHandle.prototype;
				const createWritable = prototype.createWritable;
				const resume = new Promise<void>((resolve) => {
					window.addEventListener("r32-resume-import", () => resolve(), {
						once: true,
					});
				});
				prototype.createWritable = async function (options) {
					await resume;
					prototype.createWritable = createWritable;
					return createWritable.call(this, options);
				};
			});
			await chooseFile(page, upload, {
				name: "내 배경.png",
				mimeType: "image/png",
				buffer: PNG,
			});
			await expect(tree.getByRole("status")).toHaveText(
				"이 브라우저에 저장 중",
			);
			await expect(upload).toBeDisabled();
			await page.evaluate(() =>
				window.dispatchEvent(new Event("r32-resume-import")),
			);
			await expect(tree.getByRole("status")).toContainText(
				"naia-settings/background/내 배경.png",
			);
			await expect(
				background.getByRole("button", { name: /내 배경\.png/ }),
			).toBeVisible();

			await openFolder(settings, "vrm-files");
			await vrm.getByRole("button", { name: "vrm-files에 가져오기" }).click();
			const vrmBytes = Buffer.from("glTF avatar fixture");
			await chooseFile(page, upload, {
				name: "내 아바타.vrm",
				mimeType: "model/gltf-binary",
				buffer: vrmBytes,
			});
			const importedAvatar = vrm.getByRole("button", {
				name: /내 아바타\.vrm/,
			});
			await expect(importedAvatar).toBeVisible();

			await openFolder(settings, "nva-files");
			await nva.getByRole("button", { name: "nva-files에 가져오기" }).click();
			const nvaBytes = Buffer.from(
				zipSync({ "manifest.json": new Uint8Array(Buffer.from("{}")) }),
			);
			await chooseFile(page, upload, {
				name: "내 아바타.nva",
				mimeType: "application/zip",
				buffer: nvaBytes,
			});
			await expect(
				nva.getByRole("button", { name: /내 아바타\.nva/ }),
			).toBeVisible();

			await importedAvatar.click();
			await expect(viewer.getByRole("status")).toContainText("내려받기");
			const [download] = await Promise.all([
				page.waitForEvent("download"),
				viewer.getByRole("button", { name: "내려받기" }).click(),
			]);
			expect(download.suggestedFilename()).toBe("내 아바타.vrm");
			expect(await readFile(await download.path())).toEqual(vrmBytes);
			// Clear the expanded background files so all four folder headings and the avatar list fit.
			await showTree(page, tree);
			await background.getByText("📁 background", { exact: true }).click();
			await openFolder(settings, "vrm-files");
			await importedAvatar.scrollIntoViewIfNeeded();
			if (shots)
				await page.screenshot({
					path: shots + "/R32-" + viewport.width + ".png",
				});
		});

		test("R34 refreshes the open ADK music folder after upload and removal", async ({
			page,
		}) => {
			await openWebShellWithBgm(page, { openBgm: false });
			const tree = await openWorkspace(page);
			const music = await openFolder(
				await openFolder(tree, "naia-settings"),
				"bgm-musics",
			);
			await expect(music).toContainText("아직 음악이 없습니다");

			// Both widths use the music app's real picker and OPFS import path.
			await openBgmApp(page);
			await page.locator(".bgm-app-tab").nth(1).click();
			const wav = silentWav();
			await page.getByTestId("bgm-local-file-input").setInputFiles([
				{ name: "내 노래.wav", mimeType: "audio/wav", buffer: wav },
				{
					name: "메모.txt",
					mimeType: "text/plain",
					buffer: Buffer.from("memo"),
				},
			]);
			const rows = page.locator(".bgm-local-row");
			await expect(rows).toHaveCount(1);
			await expect(
				page.getByTestId("bgm-local-import-message"),
			).toHaveAttribute("role", "alert");
			await expect(page.getByTestId("bgm-local-import-message")).toContainText(
				"음악 파일",
			);
			await page
				.locator(".bgm-icon")
				.evaluate((element: HTMLElement) => element.click());

			const song = music.getByRole("button", { name: /내 노래\.wav/ });
			await expect(song).toBeVisible();
			await expect(
				music.getByRole("button", { name: /메모\.txt/ }),
			).toHaveCount(0);
			if (shots && viewport.width === 390)
				await page.screenshot({ path: shots + "/R34-390.png" });

			await song.click();
			const viewer = page.getByTestId("web-workspace-viewer");
			await expect(viewer.locator(".web-workspace-viewer-bar code")).toHaveText(
				"내 노래.wav",
			);
			const audio = viewer.locator("audio");
			await expect(viewer.locator(".workspace-editor__media-rate select")).toBeVisible();
			await expect
				.poll(() =>
					audio.evaluate((element: HTMLAudioElement) => element.readyState),
				)
				.toBeGreaterThan(0);
			const bytes = await audio.evaluate(async (element: HTMLAudioElement) =>
				Array.from(
					new Uint8Array(await (await fetch(element.src)).arrayBuffer()),
				),
			);
			expect(Buffer.from(bytes)).toEqual(wav);
			if (shots) {
				const name =
					viewport.width === 390 ? "R34-playback-390.png" : "R34-1280.png";
				await page.screenshot({ path: shots + "/" + name });
			}

			await showTree(page, tree);
			await openFolder(await openFolder(tree, "naia-settings"), "bgm-musics");
			await openBgmApp(page);
			await page.getByTestId("bgm-local-remove").click();
			await expect(rows).toHaveCount(0);
			await page
				.locator(".bgm-icon")
				.evaluate((element: HTMLElement) => element.click());
			await expect(song).toHaveCount(0);
			await expect(music).toContainText("아직 음악이 없습니다");
		});
	});
}
