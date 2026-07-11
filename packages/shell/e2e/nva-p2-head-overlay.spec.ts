import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const __dirname = dirname(fileURLToPath(import.meta.url));
// head 테스트 클립: 100x100 green bg(#00ff00) + 빨강 40x40 중앙(30,30). h264(프로덕션 head 포맷).
const HEAD = readFileSync(join(__dirname, "fixtures", "head-green-100.mp4"));
const TAURI_NOOP = `window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
window.__TAURI_INTERNALS__.invoke = window.__TAURI_INTERNALS__.invoke || (async () => undefined);`;

// head 비디오를 만들어 첫 프레임 디코드까지 대기하는 브라우저측 헬퍼(문자열 주입).
const MAKE_HEAD = `async function makeHead(b64){
  const bin = atob(b64); const bytes = new Uint8Array(bin.length);
  for (let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }));
  const v = document.createElement("video");
  v.muted = true; v.playsInline = true; v.loop = true; v.src = url;
  await new Promise((res,rej)=>{ v.addEventListener("loadeddata",res,{once:true}); v.addEventListener("error",()=>rej(new Error("head load")),{once:true}); });
  await v.play().catch(()=>{});
  await new Promise(r=>setTimeout(r,200)); // 프레임 안정화
  return { v, url };
}`;

/**
 * ★NVA 레이어드 플레이어 P2 — Layer 1 head 오버레이 + WebGL chromakey.
 *   게이트: (1) chromakey 가 green 을 알파 0 으로 제거하고 콘텐츠(red)를 보존, (2) base draw rect + face_bbox
 *   기준 픽셀 위치에 head 를 정합 합성(green 제거로 base 가 노출). 캔버스 픽셀로 직접 검증.
 */
test.describe("NVA P2 — head 오버레이 + chromakey(canvas 픽셀)", () => {
	test("chromakey: green 제거(알파0) + 콘텐츠(red) 보존", async ({ page }) => {
		await page.addInitScript(TAURI_NOOP);
		await page.goto("/");

		const result = await page.evaluate(
			async ({ b64, makeHeadSrc }: { b64: string; makeHeadSrc: string }) => {
				// biome-ignore lint/security/noGlobalEval: 테스트 헬퍼 주입(브라우저측)
				const makeHead = (0, eval)(`(${makeHeadSrc})`) as (
					b: string,
				) => Promise<{ v: HTMLVideoElement; url: string }>;
				const { NvaChromakeyGL } = await import(
					"/src/lib/avatar/nva-chromakey-gl.ts"
				);
				const { v, url } = await makeHead(b64);

				const key = new NvaChromakeyGL({ keyColor: "#00ff00" });
				const keyed = key.process(v, v.videoWidth, v.videoHeight);

				// WebGL 결과를 2D 캔버스로 읽어 픽셀 확인(같은 tick — drawing buffer 유효).
				const rc = document.createElement("canvas");
				rc.width = 100;
				rc.height = 100;
				const rctx = rc.getContext("2d", { alpha: true });
				if (!rctx) throw new Error("no rctx");
				rctx.clearRect(0, 0, 100, 100);
				rctx.drawImage(keyed, 0, 0);
				const center = Array.from(rctx.getImageData(50, 50, 1, 1).data); // red 사각 중앙
				const corner = Array.from(rctx.getImageData(5, 5, 1, 1).data); // green 영역
				key.dispose();
				URL.revokeObjectURL(url);
				return { center, corner };
			},
			{ b64: HEAD.toString("base64"), makeHeadSrc: MAKE_HEAD },
		);

		// red 콘텐츠 보존(불투명).
		const [r, g, b, a] = result.center;
		expect(r, `center=${result.center}`).toBeGreaterThan(150);
		expect(g).toBeLessThan(100);
		expect(b).toBeLessThan(100);
		expect(a).toBeGreaterThan(200);
		// green 영역 = 알파 0(제거).
		expect(result.corner[3], `corner=${result.corner}`).toBeLessThan(40);
	});

	test("합성 정합: base 위 face_bbox 위치에 head, green 제거로 base 노출", async ({
		page,
	}) => {
		await page.addInitScript(TAURI_NOOP);
		await page.goto("/");

		const result = await page.evaluate(
			async ({ b64, makeHeadSrc }: { b64: string; makeHeadSrc: string }) => {
				// biome-ignore lint/security/noGlobalEval: 테스트 헬퍼 주입(브라우저측)
				const makeHead = (0, eval)(`(${makeHeadSrc})`) as (
					b: string,
				) => Promise<{ v: HTMLVideoElement; url: string }>;
				const { NvaHeadOverlay } = await import(
					"/src/lib/avatar/nva-head-overlay.ts"
				);
				const { v, url } = await makeHead(b64);

				const canvas = document.createElement("canvas");
				canvas.width = 200;
				canvas.height = 200;
				const ctx = canvas.getContext("2d", { alpha: true });
				if (!ctx) throw new Error("no ctx");
				// stand-in base = 불투명 파랑(head green 이 제거되면 이 파랑이 노출되어야 함).
				ctx.fillStyle = "rgb(0,0,255)";
				ctx.fillRect(0, 0, 200, 200);

				const overlay = new NvaHeadOverlay({ keyColor: "#00ff00" });
				const drawRect = { dx: 0, dy: 0, dw: 200, dh: 200 };
				// face_bbox [0.25,0.25,0.5] → head rect (50,50,100,100). red 사각(head 30~70) → canvas 80~120.
				const rect = overlay.draw(ctx, v, [0.25, 0.25, 0.5], drawRect);

				const center = Array.from(ctx.getImageData(100, 100, 1, 1).data); // red 사각 중앙
				const greenArea = Array.from(ctx.getImageData(55, 55, 1, 1).data); // head green→base 파랑 노출
				const outside = Array.from(ctx.getImageData(20, 20, 1, 1).data); // head 밖=base 파랑
				overlay.dispose();
				URL.revokeObjectURL(url);
				return { rect, center, greenArea, outside };
			},
			{ b64: HEAD.toString("base64"), makeHeadSrc: MAKE_HEAD },
		);

		// face_bbox → head rect 정합(50,50,100,100).
		expect(result.rect?.x).toBeCloseTo(50, 0);
		expect(result.rect?.y).toBeCloseTo(50, 0);
		expect(result.rect?.w).toBeCloseTo(100, 0);
		// 중앙 = head red 합성.
		expect(result.center[0], `center=${result.center}`).toBeGreaterThan(150);
		expect(result.center[2]).toBeLessThan(120);
		// head 의 green 영역 = 제거되어 base 파랑 노출(chromakey 성립 증거).
		expect(
			result.greenArea[2],
			`greenArea=${result.greenArea}`,
		).toBeGreaterThan(150);
		expect(result.greenArea[1]).toBeLessThan(120); // 초록 아님
		// head 밖 = base 파랑 그대로.
		expect(result.outside[2]).toBeGreaterThan(150);
	});
});
