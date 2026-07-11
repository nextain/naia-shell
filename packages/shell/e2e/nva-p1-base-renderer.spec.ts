import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const __dirname = dirname(fileURLToPath(import.meta.url));
// 200x200 알파 VP9: 빨강 100x100 중앙 + 투명 여백. (base 렌더러가 알파를 보존하는지 픽셀로 검증.)
const CLIP = readFileSync(join(__dirname, "fixtures", "base-alpha-200.webm"));
const TAURI_NOOP = `window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
window.__TAURI_INTERNALS__.invoke = window.__TAURI_INTERNALS__.invoke || (async () => undefined);`;

/**
 * ★NVA 레이어드 플레이어 P1 — Layer 0(base) 렌더러.
 *   게이트: base 클립(알파 webm)이 canvas 에 실제로 그려지고(중앙 콘텐츠 픽셀), 알파가 보존되는가
 *   (투명 여백 = canvas 알파 0 → 앱 배경 위 투명 합성 성립). 캔버스 픽셀로 직접 검증.
 */
test.describe("NVA P1 — base 렌더러(canvas 픽셀)", () => {
	test("base 알파 클립이 canvas 에 그려지고 알파 보존", async ({ page }) => {
		await page.addInitScript(TAURI_NOOP);
		await page.goto("/");

		const b64 = CLIP.toString("base64");
		const result = await page.evaluate(async (data: string) => {
			const { NvaBaseRenderer } = await import(
				"/src/lib/avatar/nva-base-renderer.ts"
			);
			const bin = atob(data);
			const bytes = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
			const url = URL.createObjectURL(
				new Blob([bytes], { type: "video/webm" }),
			);

			const canvas = document.createElement("canvas");
			canvas.width = 200;
			canvas.height = 200;
			document.body.appendChild(canvas);

			const renderer = new NvaBaseRenderer(canvas);
			await renderer.play(url, { loop: true });
			// 몇 프레임 렌더될 시간.
			await new Promise((r) => setTimeout(r, 700));

			const ctx = canvas.getContext("2d", { alpha: true });
			if (!ctx) throw new Error("no ctx");
			const center = Array.from(ctx.getImageData(100, 100, 1, 1).data); // 콘텐츠(빨강)
			const corner = Array.from(ctx.getImageData(3, 3, 1, 1).data); // 투명 여백
			const st = renderer.state();
			const rect = renderer.drawRect;
			renderer.stop();
			URL.revokeObjectURL(url);
			return { center, corner, framesDrawn: st.framesDrawn, rect };
		}, b64);

		// 프레임이 실제로 그려졌다.
		expect(result.framesDrawn).toBeGreaterThan(0);
		// contain-fit: 200x200 클립 → 200x200 canvas = 전체(dx=dy=0, dw=dh=200).
		expect(result.rect.dw).toBeCloseTo(200, 0);
		expect(result.rect.dh).toBeCloseTo(200, 0);
		// 중앙 = 빨강 불투명(디코딩/색공간 여유로 임계 완화).
		const [r, g, b, a] = result.center;
		expect(r, `center=${result.center}`).toBeGreaterThan(150);
		expect(g).toBeLessThan(90);
		expect(b).toBeLessThan(90);
		expect(a).toBeGreaterThan(200); // 콘텐츠 = 불투명
		// 모서리 여백 = 투명 보존(clearRect + 클립 알파 0).
		expect(result.corner[3], `corner=${result.corner}`).toBeLessThan(40);
	});
});
