import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";

// 웹판 설정 NVA·배경 가져오기의 실제 브라우저 검증. 앱 전체가 아니라 탐색기
// 함수와 설정 자산 모듈을 dev 서버에서 직접 읽어 실제 OPFS·미디어 스택으로
// 파일 선택相当→검사→브라우저 저장→목록 갱신→읽기→삭제까지 확인한다.
// Web runtime only: NAIA_E2E_WEB=1 and a local dev server
// (`vite --port 1430 --cors`), reached through PLAYWRIGHT_BASE_URL.
test.skip(
	process.env.NAIA_E2E_WEB !== "1",
	"web settings import test only runs when NAIA_E2E_WEB=1",
);
test.setTimeout(240_000);

const PUBLIC = join("public");

/** 1x1 빨강 PNG. */
function tinyPng(): Buffer {
	return Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
		"base64",
	);
}

/** 합성 소형 NVA: 최소 매니페스트 + 번들 실측 idle.webm 한 클립. */
function syntheticNva(): Buffer {
	const idle = new Uint8Array(
		readFileSync(join(PUBLIC, "nva", "minho", "clips", "idle.webm")),
	);
	const manifest = {
		nva_version: "0.2",
		canvas: { width: 720, height: 1280 },
		animations: {
			idle: { clip: "clips/idle.webm", loop: true, can_talk: false },
		},
	};
	return Buffer.from(
		zipSync({
			"manifest.json": strToU8(JSON.stringify(manifest)),
			"clips/idle.webm": idle,
		}),
	);
}

const ORIGIN = (process.env.PLAYWRIGHT_BASE_URL || "http://localhost:1430").replace(
	/\/+$/,
	"",
);

const HARNESS = `(async () => {
const origin = ${JSON.stringify(ORIGIN)};
const webAssets = await import(origin + "/src/lib/web-runtime/web-assets.ts");
webAssets.setWebAssetsModeForTests(true);
// 같은 인스턴스 그래프로 묶기 위해 질의를 붙여 새로 읽는다.
const assets = await import(origin + "/src/lib/web-runtime/web-settings-assets.ts?harness=1");
const nvaArchive = await import(origin + "/src/lib/web-runtime/web-nva-archive.ts?harness=1");
let adkStore = null;
try {
	adkStore = await import(origin + "/src/lib/adk-store.ts?harness=1");
} catch (error) {
	adkStore = { __loadError: String(error) };
}
globalThis.__webImportHarness = { assets, nvaArchive, webAssets, adkStore };
return !!assets.importWebSettingsAsset;
})();`;

interface FlowReport {
	failures: string[];
	log: string[];
	userPng: string;
	userPngSecond: string;
	userMp4: string;
	userNva: string;
	events: number;
	restoredBlobReadable: boolean;
	videoReadyState: number;
	nvaClipBytes: number;
}

const FLOW = `(async () => {
const { assets, nvaArchive, adkStore } = globalThis.__webImportHarness;
const failures = [];
const log = [];
const check = (name, cond) => { log.push((cond ? "ok " : "FAIL ") + name); if (!cond) failures.push(name); };
const events = [];
globalThis.addEventListener(nvaArchive.WEB_SETTINGS_ASSETS_CHANGED_EVENT, () => events.push(1));

const pngBytes = new Uint8Array(${JSON.stringify(Array.from(tinyPng()))});
const mp4Bytes = new Uint8Array(${JSON.stringify(Array.from(readFileSync(join(PUBLIC, "backgrounds", "naia-autumn-office-live.mp4"))))});
const nvaBytes = new Uint8Array(${JSON.stringify(Array.from(syntheticNva()))});

// 1. PNG 배경: 검사→저장→목록→읽기→Blob URL 판독→재생 가능 판정.
const pngFile = new File([pngBytes], "e2e-photo.png", { type: "image/png" });
const userPng = await assets.importWebSettingsAsset("background", pngFile);
check("png stored identifier", userPng === "opfs://naia-adk/naia-settings/background/e2e-photo.png");
const bgList = await assets.listWebBackgroundPaths();
check("png listed", bgList.includes(userPng));
const readBack = await assets.readWebSettingsAssetBlob(userPng);
check("png bytes round-trip", readBack.size === pngBytes.length);
const pngUrl = await adkStore.toLocalBlobUrl(userPng);
check("png blob url", typeof pngUrl === "string" && pngUrl.startsWith("blob:"));
const pngFetched = new Uint8Array(await (await fetch(pngUrl)).arrayBuffer());
check("png blob readable", pngFetched.length === pngBytes.length);
check("png probe playable", await assets.probeWebBackgroundPlayable(pngFile));

// 2. 동일 파일명: 덮어쓰지 않고 (2)로 둔다.
const userPngSecond = await assets.importWebSettingsAsset("background", new File([pngBytes], "e2e-photo.png", { type: "image/png" }));
check("same name kept distinct", userPngSecond.endsWith("e2e-photo (2).png"));
check("two entries listed", (await assets.listWebBackgroundPaths()).length === 2);

// 3. MP4 배경: 부분 바이트로도 재생 가능 판정과 저장이 된다.
const mp4File = new File([mp4Bytes], "e2e-user-bg.mp4", { type: "video/mp4" });
const userMp4 = await assets.importWebSettingsAsset("background", mp4File);
check("mp4 stored", userMp4.endsWith("e2e-user-bg.mp4"));
check("mp4 probe playable", await assets.probeWebBackgroundPlayable(mp4File));
const mp4Url = await adkStore.toLocalBlobUrl(userMp4);
const videoReadyState = await new Promise((resolve) => {
	const video = document.createElement("video");
	video.muted = true;
	const timer = setTimeout(() => resolve(video.readyState), 8000);
	video.onloadeddata = () => { clearTimeout(timer); resolve(video.readyState); };
	video.onerror = () => { clearTimeout(timer); resolve(-1); };
	video.src = mp4Url;
});
check("mp4 loads metadata", videoReadyState >= 1);

// 4. 재생 불가 영상: 저장하지 않고 unplayable을 돌려준다.
let unplayableCode = "";
try {
	await assets.importWebSettingsAsset("background", new File(["not a video"], "bogus.mp4", { type: "video/mp4" }));
} catch (error) {
	unplayableCode = error?.code ?? String(error);
}
check("bogus mp4 rejected as unplayable", unplayableCode === "unplayable");

// 5. 형식 불일치: 배경 폴더에 .vrm 불가.
let unsupportedCode = "";
try {
	await assets.importWebSettingsAsset("background", new File(["x"], "avatar.vrm"));
} catch (error) {
	unsupportedCode = error?.code ?? String(error);
}
check("wrong extension rejected", unsupportedCode === "unsupported");

// 6. 합성 NVA: 검사(ZIP·매니페스트)→저장→목록→아카이브 재생.
const nvaFile = new File([nvaBytes], "e2e-nva.nva", { type: "application/zip" });
const userNva = await assets.importWebSettingsAsset("nva-files", nvaFile);
check("nva stored", userNva === "opfs://naia-adk/naia-settings/nva-files/e2e-nva.nva");
const uploaded = await nvaArchive.listWebUploadedNvaModels();
check("nva listed", uploaded.includes("e2e-nva.nva"));
const loaded = await nvaArchive.loadWebUploadedNvaArchive("e2e-nva.nva");
check("nva archive parses", !!loaded && loaded.manifest.canvas.width === 720);
const clipBlob = await loaded.loadAssetBlob("clips/idle.webm", false);
const nvaClipBytes = clipBlob.size;
check("nva clip readable", nvaClipBytes > 1000);
const resolved = assets.resolveWebNvaSelection(userNva, ["naia", "e2e-nva.nva"]);
check("nva full identifier resolves to entry", resolved === "e2e-nva.nva");

// 7. 손상 NVA·취소 상당: 저장 없이 invalid_nva, null相当 함수는 호출하지 않음.
let invalidCode = "";
try {
	await assets.importWebSettingsAsset("nva-files", new File(["not a zip"], "broken.nva"));
} catch (error) {
	invalidCode = error?.code ?? String(error);
}
check("corrupt nva rejected", invalidCode === "invalid_nva");

// 8. 식별자 해석: 전체 식별자 우선, bare는 번들, 끝부분 일치는 무시.
const selPaths = ["/backgrounds/my-photo.webp", "opfs://naia-adk/naia-settings/background/my-photo.webp", "/backgrounds/xmy-photo.webp"];
check("exact identifier wins", assets.resolveWebBackgroundSelection(selPaths[1], selPaths) === selPaths[1]);
check("bare name prefers bundle", assets.resolveWebBackgroundSelection("my-photo.webp", selPaths) === selPaths[0]);
check("no suffix confusion", assets.resolveWebBackgroundSelection("my-photo.webp", ["/backgrounds/xmy-photo.webp"]) === null);

// 9. 삭제: 사용자 파일이 목록에서 빠진다.
await assets.removeWebSettingsAsset(userPngSecond);
check("removed file unlisted", !(await assets.listWebBackgroundPaths()).includes(userPngSecond));

// 10. 새로고침相当: 같은 식별자로 Blob URL을 다시 만든다.
const againUrl = await adkStore.toLocalBlobUrl(userPng);
const restoredBlobReadable = (await (await fetch(againUrl)).arrayBuffer()).byteLength === pngBytes.length;
check("blob url regenerated and readable", restoredBlobReadable);

return {
	failures,
	log,
	userPng,
	userPngSecond,
	userMp4,
	userNva,
	events: events.length,
	restoredBlobReadable,
	videoReadyState,
	nvaClipBytes,
};
})();`;

test("web settings NVA/background import runs on real OPFS and media stack", async ({
	page,
}) => {
	await page.goto("/");
	const loaded = await page.evaluate(HARNESS);
	expect(loaded).toBe(true);

	const report = (await page.evaluate(FLOW)) as FlowReport;
	if (report.failures.length > 0) {
		throw new Error(`harness failures:\n${report.log.join("\n")}`);
	}
	expect(report.failures).toEqual([]);
	expect(report.userPng).toBe(
		"opfs://naia-adk/naia-settings/background/e2e-photo.png",
	);
	expect(report.userMp4).toBe(
		"opfs://naia-adk/naia-settings/background/e2e-user-bg.mp4",
	);
	expect(report.userNva).toBe("opfs://naia-adk/naia-settings/nva-files/e2e-nva.nva");
	// 저장 성공 때마다 변경 이벤트가 났다(PNG 2 + MP4 1 + NVA 1 + 삭제 1).
	expect(report.events).toBeGreaterThanOrEqual(5);
	expect(report.restoredBlobReadable).toBe(true);
	expect(report.videoReadyState).toBeGreaterThanOrEqual(1);
	expect(report.nvaClipBytes).toBeGreaterThan(1000);
});
