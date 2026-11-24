import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";

// 웹판 설정 NVA·배경 가져오기의 실제 브라우저 검증. 실제 파일 input 선택→
// 생산 파이프(검사→브라우저 저장→목록 갱신→선택 해석→복원→Blob 재생성)→
// 새로고침 뒤 복원→저장 파일 소실 시 기본 배경 복구를 실제 OPFS·미디어
// 스택으로 확인한다. 데스크톱 계약은 단위 시험(정확 basename 해석)이 맡는다.
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
	return Buffer.from([
		137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0,
		0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73,
		68, 65, 84, 120, 218, 99, 252, 207, 192, 80, 15, 0, 4, 133, 1, 128,
		132, 169, 140, 33, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
	]);
}

/** 매니페스트는 있으나 클립이 빠진 불량 NVA. */
function missingClipNva(): Buffer {
	const manifest = {
		nva_version: "0.2",
		canvas: { width: 720, height: 1280 },
		animations: {
			idle: { clip: "clips/idle.webm", loop: true },
		},
	};
	return Buffer.from(
		zipSync({ "manifest.json": strToU8(JSON.stringify(manifest)) }),
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
	nvaVideoReadyState: number;
	nvaClipBytes: number;
}

const FLOW = `(async () => {
const { assets, nvaArchive, webAssets, adkStore } = globalThis.__webImportHarness;
const failures = [];
const log = [];
const check = (name, cond) => { log.push((cond ? "ok " : "FAIL ") + name); if (!cond) failures.push(name); };
const events = [];
globalThis.addEventListener(nvaArchive.WEB_SETTINGS_ASSETS_CHANGED_EVENT, () => events.push(1));

const pngBytes = new Uint8Array(${JSON.stringify(Array.from(tinyPng()))});
const mp4Bytes = new Uint8Array(${JSON.stringify(Array.from(readFileSync(join(PUBLIC, "backgrounds", "naia-autumn-office-live.mp4"))))});
const nvaBytes = new Uint8Array(${JSON.stringify(Array.from(syntheticNva()))});
const missingClipNvaBytes = new Uint8Array(${JSON.stringify(Array.from(missingClipNva()))});

// 실제 파일 input을 통한 선택. File 객체를 직접 만들지 않고 브라우저의
// 파일 선택 계약(DataTransfer→input.files)을 거쳐 생산 파이프에 넣는다.
const fileInput = document.createElement("input");
fileInput.type = "file";
document.body.appendChild(fileInput);
const pickFile = (bytes, name, type) => {
	const transfer = new DataTransfer();
	transfer.items.add(new File([bytes], name, { type }));
	fileInput.files = transfer.files;
	return fileInput.files[0];
};

// 1. PNG 배경: 검사→저장→목록→읽기→Blob URL 판독→재생 가능 판정.
const pngFile = pickFile(pngBytes, "e2e-photo.png", "image/png");
check("real file input selection", pngFile instanceof File && pngFile.size === pngBytes.length && pngFile.name === "e2e-photo.png");
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
const userPngSecond = await assets.importWebSettingsAsset("background", pickFile(pngBytes, "e2e-photo.png", "image/png"));
check("same name kept distinct", userPngSecond.endsWith("e2e-photo (2).png"));
check("two entries listed", (await assets.listWebBackgroundPaths()).length === 2);

// 3. MP4 배경: 부분 바이트로도 재생 가능 판정과 저장이 된다.
const mp4File = pickFile(mp4Bytes, "e2e-user-bg.mp4", "video/mp4");
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
	await assets.importWebSettingsAsset("background", pickFile(new Uint8Array([0, 1, 2, 3]), "bogus.mp4", "video/mp4"));
} catch (error) {
	unplayableCode = error?.code ?? String(error);
}
check("bogus mp4 rejected as unplayable", unplayableCode === "unplayable");

// 5. 형식 불일치: 배경 폴더에 .vrm 불가.
let unsupportedCode = "";
try {
	await assets.importWebSettingsAsset("background", pickFile(new Uint8Array([120]), "avatar.vrm", "model/vrm"));
} catch (error) {
	unsupportedCode = error?.code ?? String(error);
}
check("wrong extension rejected", unsupportedCode === "unsupported");

// 5b. 형식 불일치 이미지: PNG 이름을 달고 내용은 텍스트.
let mismatchCode = "";
try {
	await assets.importWebSettingsAsset("background", pickFile(new TextEncoder().encode("not an image"), "fake.png", "image/png"));
} catch (error) {
	mismatchCode = error?.code ?? String(error);
}
check("mismatched png rejected as unplayable", mismatchCode === "unplayable");

// 6. 합성 NVA: 검사(ZIP·매니페스트·클립 존재·디코드)→저장→목록→아카이브 재생.
const nvaFile = pickFile(nvaBytes, "e2e-nva.nva", "application/zip");
const userNva = await assets.importWebSettingsAsset("nva-files", nvaFile);
check("nva stored", userNva === "opfs://naia-adk/naia-settings/nva-files/e2e-nva.nva");
const uploaded = await nvaArchive.listWebUploadedNvaModels();
check("nva listed", uploaded.includes("e2e-nva.nva"));
const loaded = await nvaArchive.loadWebUploadedNvaArchive("e2e-nva.nva");
check("nva archive parses", !!loaded && loaded.manifest.canvas.width === 720);
const clipBlob = await loaded.loadAssetBlob("clips/idle.webm", false);
const nvaClipBytes = clipBlob.size;
check("nva clip readable", nvaClipBytes > 1000);
// NVA 클립을 실제 <video>에서 디코드한다. 렌더러가 재생할 수 있는 바이트인지 확인.
const nvaVideoReadyState = await new Promise((resolve) => {
	const url = URL.createObjectURL(clipBlob);
	const video = document.createElement("video");
	video.muted = true;
	const timer = setTimeout(() => { URL.revokeObjectURL(url); resolve(video.readyState); }, 8000);
	video.onloadeddata = () => { clearTimeout(timer); URL.revokeObjectURL(url); resolve(video.readyState); };
	video.onerror = () => { clearTimeout(timer); URL.revokeObjectURL(url); resolve(-1); };
	video.src = url;
});
check("nva clip decodes in video element", nvaVideoReadyState >= 1);
const resolved = assets.resolveWebNvaSelection(userNva, ["naia", "e2e-nva.nva"]);
check("nva full identifier resolves to entry", resolved === "e2e-nva.nva");

// 6b. 매니페스트 클립이 빠진 NVA: 저장 없이 invalid_nva.
let missingClipCode = "";
try {
	await assets.importWebSettingsAsset("nva-files", pickFile(missingClipNvaBytes, "missing-clip.nva", "application/zip"));
} catch (error) {
	missingClipCode = error?.code ?? String(error);
}
check("nva with missing clip rejected", missingClipCode === "invalid_nva");

// 7. 손상 NVA·취소 상당: 저장 없이 invalid_nva, null相当 함수는 호출하지 않음.
let invalidCode = "";
try {
	await assets.importWebSettingsAsset("nva-files", pickFile(new TextEncoder().encode("not a zip"), "broken.nva", "application/zip"));
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

// 10. 저장 파일 소실: 사용자 PNG를 OPFS에서 직접 지우면 식별자 해석이
// null이 되고, 번들 기본 배경으로 복구·원인 확인이 된다(동명 번들로 위장 금지).
const opfsRoot = await navigator.storage.getDirectory();
const goneDir = await (await (await opfsRoot.getDirectoryHandle("naia-adk")).getDirectoryHandle("naia-settings")).getDirectoryHandle("background");
await goneDir.removeEntry("e2e-photo.png");
const afterDeleteList = await assets.listWebBackgroundPaths();
check("deleted user file unlisted", !afterDeleteList.includes(userPng));
const goneResolved = assets.resolveWebBackgroundSelection(userPng, [...webAssets.WEB_BACKGROUND_ASSETS.map((a) => a.url), ...afterDeleteList]);
check("missing full identifier resolves to null, never a same-name bundle", goneResolved === null);
let goneReadError = "";
try {
	await adkStore.toLocalBlobUrl(userPng);
} catch (error) {
	goneReadError = error instanceof Error ? error.message : String(error);
}
check("missing user file read fails (no bundled masquerade)", goneReadError.length > 0);
const defaultCandidate = assets.resolveWebBackgroundSelection(webAssets.WEB_DEFAULT_BACKGROUND, [...webAssets.WEB_BACKGROUND_ASSETS.map((a) => a.url), ...afterDeleteList]);
check("default background still resolves", typeof defaultCandidate === "string" && defaultCandidate.length > 0);
const defaultUrl = await adkStore.toLocalBlobUrl(defaultCandidate);
const defaultReadable = (await (await fetch(defaultUrl)).arrayBuffer()).byteLength > 0;
check("default background blob readable after fallback", defaultReadable);

return {
	failures,
	log,
	userPng,
	userPngSecond,
	userMp4,
	userNva,
	events: events.length,
	restoredBlobReadable: defaultReadable,
	videoReadyState,
	nvaVideoReadyState,
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
	expect(report.nvaVideoReadyState).toBeGreaterThanOrEqual(1);
	expect(report.nvaClipBytes).toBeGreaterThan(1000);

	// 새로고침: 같은 식별자로 Blob URL을 다시 만들고 읽을 수 있다.
	// (FLOW 10단계에서 지운 e2e-photo.png는 사라진 채로, MP4는 남는다.)
	await page.reload();
	const RELOAD = `(async () => {
const origin = ${JSON.stringify(ORIGIN)};
const userMp4 = ${JSON.stringify(report.userMp4)};
const webAssets = await import(origin + "/src/lib/web-runtime/web-assets.ts");
webAssets.setWebAssetsModeForTests(true);
const assets = await import(origin + "/src/lib/web-runtime/web-settings-assets.ts?reloaded=1");
const adkStore = await import(origin + "/src/lib/adk-store.ts?reloaded=1");
const failed = [];
const list = await assets.listWebBackgroundPaths();
if (!list.includes(userMp4)) failed.push("mp4 survived reload");
const allPaths = [...webAssets.WEB_BACKGROUND_ASSETS.map((a) => a.url), ...list];
if (assets.resolveWebBackgroundSelection(userMp4, allPaths) !== userMp4) failed.push("identifier resolves after reload");
const url = await adkStore.toLocalBlobUrl(userMp4);
if (typeof url !== "string" || !url.startsWith("blob:")) failed.push("blob url regenerated after reload");
const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
if (bytes.length === 0) failed.push("regenerated blob readable");
return { failed, list };
})();`;
	const reloaded = (await page.evaluate(RELOAD)) as {
		failed: string[];
		list: string[];
	};
	if (reloaded.failed.length > 0) {
		throw new Error(`reload failures:\n${reloaded.failed.join("\n")}`);
	}
	expect(reloaded.failed).toEqual([]);
	expect(reloaded.list).toContain(report.userMp4);
});
