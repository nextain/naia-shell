import { S } from "../helpers/selectors.js";

/**
 * ★NVA 레이어드 플레이어 P0 — 실 WebView2 capability 검증 (codex P0 리뷰 CRITICAL C1 해소).
 *   Playwright(Chromium) 기준선만으론 실앱 런타임(Tauri = **WebView2**)을 못 보장한다.
 *   여기서 실 WebView2 세션에 레이어드 합성 필수 능력(rVFC/WebGL2/h264 MSE/canvas알파)을 직접 프로브해,
 *   layeredOk 를 실앱에서 확증한다. 하나라도 false 면 레이어드 플레이어 비활성→full-composite fallback(회귀 0).
 *   프로브 로직은 src/lib/avatar/nva-capability.ts 와 동일(자립 인라인 — 빌드 바이너리 모듈해석 비의존).
 */
describe("13 — NVA 레이어드 플레이어 capability (실 WebView2)", () => {
	it("레이어드 합성 필수 능력이 WebView2 에 있다", async () => {
		const appRoot = await $(S.appRoot);
		await appRoot.waitForDisplayed({ timeout: 30_000 });

		const caps = await browser.execute(() => {
			const reasons: string[] = [];
			const rvfc =
				typeof HTMLVideoElement !== "undefined" &&
				typeof (
					HTMLVideoElement.prototype as unknown as {
						requestVideoFrameCallback?: unknown;
					}
				).requestVideoFrameCallback === "function";
			if (!rvfc) reasons.push("requestVideoFrameCallback 미지원");

			let webgl2 = false;
			try {
				const c = document.createElement("canvas");
				const gl = c.getContext("webgl2");
				webgl2 = !!gl;
				(gl as WebGL2RenderingContext | null)
					?.getExtension("WEBGL_lose_context")
					?.loseContext();
			} catch {
				webgl2 = false;
			}
			if (!webgl2) reasons.push("WebGL2 컨텍스트 불가");

			const H264 = 'video/mp4; codecs="avc1.42E01F"';
			const mseH264 =
				typeof MediaSource !== "undefined" &&
				typeof MediaSource.isTypeSupported === "function" &&
				MediaSource.isTypeSupported(H264);
			if (!mseH264) reasons.push("MSE h264(avc1) 미지원");

			let canvasAlpha = false;
			try {
				const c = document.createElement("canvas");
				c.width = c.height = 2;
				const ctx = c.getContext("2d", { alpha: true });
				if (ctx) {
					ctx.clearRect(0, 0, 2, 2);
					canvasAlpha = ctx.getImageData(0, 0, 1, 1).data[3] === 0;
				}
			} catch {
				canvasAlpha = false;
			}
			if (!canvasAlpha) reasons.push("canvas 알파 합성 불가");

			const layeredOk = rvfc && webgl2 && mseH264 && canvasAlpha;
			const ua = navigator.userAgent;
			return { rvfc, webgl2, mseH264, canvasAlpha, layeredOk, reasons, ua };
		});

		// biome-ignore lint/suspicious/noConsole: e2e 진단 로그(실 WebView2 능력 가시화)
		console.log(
			`[P0 WebView2 capability] rvfc=${caps.rvfc} webgl2=${caps.webgl2} ` +
				`mseH264=${caps.mseH264} canvasAlpha=${caps.canvasAlpha} layeredOk=${caps.layeredOk} ` +
				`reasons=[${caps.reasons.join(",")}] ua=${caps.ua}`,
		);

		// 실 WebView2 에서 레이어드 플레이어가 가능해야 P1~ 진행 정당(아니면 설계를 fallback 우선으로 재검토).
		expect(caps.rvfc).toBe(true);
		expect(caps.webgl2).toBe(true);
		expect(caps.mseH264).toBe(true);
		expect(caps.canvasAlpha).toBe(true);
		expect(caps.layeredOk).toBe(true);
	});
});
