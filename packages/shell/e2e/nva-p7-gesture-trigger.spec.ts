import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fx = (f: string) =>
	readFileSync(join(__dirname, "fixtures", f)).toString("base64");
// idle=빨강, speak=파랑, gesture(wave)=노랑, head=green+빨강.
const FIX = {
	idle: fx("base-alpha-200.webm"),
	speak: fx("speak-blue-200.webm"),
	wave: fx("gesture-yellow-200.webm"),
	head: fx("head-green-100.mp4"),
};
const TAURI_NOOP = `window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
window.__TAURI_INTERNALS__.invoke = window.__TAURI_INTERNALS__.invoke || (async () => undefined);`;

/**
 * ★NVA 레이어드 플레이어 P7 — LLM gesture 트리거 파서 → 플레이어 통합.
 *   게이트: LLM 응답 텍스트의 gesture 마커([[gesture:인사]] — trigger 어로 해석)를 파싱해 cleanText(마커 제거) +
 *   gesture key 를 얻고, driveGestures 로 player.gesture(key) 를 호출 → 상태 gesturing(노랑) → 종료 후 base 복귀.
 */
test.describe("NVA P7 — gesture LLM 트리거 파서 통합", () => {
	test("LLM 텍스트 마커 파싱 → player.gesture 트리거 → gesturing→복귀", async ({
		page,
	}) => {
		test.setTimeout(60_000);
		await page.addInitScript(TAURI_NOOP);
		await page.goto("/");

		const r = await page.evaluate(async (FIX: typeof FIX) => {
			const mk = (b64: string, t: string) => {
				const bin = atob(b64);
				const u = new Uint8Array(bin.length);
				for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
				return URL.createObjectURL(new Blob([u], { type: t }));
			};
			const clipMap: Record<string, string> = {
				"idle.webm": mk(FIX.idle, "video/webm"),
				"speak.webm": mk(FIX.speak, "video/webm"),
				"wave.webm": mk(FIX.wave, "video/webm"),
			};
			const manifest = {
				nva_version: "0.2",
				canvas: { width: 200, height: 200, fps: 25 },
				animations: {
					idle: { clip: "idle.webm", loop: true, can_talk: false },
					speak: {
						clip: "speak.webm",
						loop: true,
						can_talk: true,
						face_bbox: [0.25, 0.25, 0.5],
						head_chroma: "#00ff00",
						head_image: "h.png",
						head_time: 0,
					},
					wave: {
						clip: "wave.webm",
						loop: false,
						can_talk: false,
						label: "손흔들기",
						intent: "greeting",
						triggers: ["인사", "hi", "안녕"],
					},
				},
			};
			const canvas = document.createElement("canvas");
			canvas.width = 200;
			canvas.height = 200;
			document.body.appendChild(canvas);
			const ctx = canvas.getContext("2d", { alpha: true });
			if (!ctx) throw new Error("no ctx");
			const px = (x: number, y: number) =>
				Array.from(ctx.getImageData(x, y, 1, 1).data);

			const { NvaLayeredPlayer } = await import(
				"/src/lib/avatar/nva-layered-player.ts"
			);
			const { parseGestureTriggers, driveGestures } = await import(
				"/src/lib/avatar/nva-gesture-trigger.ts"
			);
			const player = new NvaLayeredPlayer(canvas, manifest, {
				resolveClip: (c: string) => clipMap[c],
			});
			await player.start();
			await new Promise((res) => setTimeout(res, 300));
			const idleP60 = px(60, 100); // 빨강

			// LLM 응답: trigger 어("인사")로 gesture 마커.
			const llm = "안녕하세요 [[gesture:인사]] 반가워요";
			const parsed = parseGestureTriggers(llm, manifest);
			const fired = await driveGestures(player, parsed.gestures);
			await new Promise((res) => setTimeout(res, 200));
			const gesturingState = player.state;
			const gestP60 = px(60, 100); // 노랑

			await new Promise((res) => setTimeout(res, 800)); // gesture(0.5s) 종료 후 복귀
			const afterState = player.state;
			const afterP60 = px(60, 100); // 빨강(idle 복귀)
			player.dispose();
			return {
				cleanText: parsed.cleanText,
				gestureKeys: parsed.gestures.map((g) => g.key),
				fired,
				idleP60,
				gesturingState,
				gestP60,
				afterState,
				afterP60,
			};
		}, FIX);

		// 파싱: 마커 제거 + trigger 해석.
		expect(r.cleanText).toBe("안녕하세요 반가워요");
		expect(r.gestureKeys).toEqual(["wave"]);
		expect(r.fired).toBe(1);
		// idle = 빨강.
		expect(r.idleP60[0], `idle=${r.idleP60}`).toBeGreaterThan(150);
		// gesture 트리거 → gesturing 상태 + 노랑(r+g 높음, b 낮음).
		expect(r.gesturingState).toBe("gesturing");
		expect(r.gestP60[0], `gest=${r.gestP60}`).toBeGreaterThan(150);
		expect(r.gestP60[1]).toBeGreaterThan(150);
		expect(r.gestP60[2]).toBeLessThan(120);
		// 종료 후 idle(빨강) 복귀.
		expect(r.afterState).toBe("idle");
		expect(r.afterP60[0], `after=${r.afterP60}`).toBeGreaterThan(150);
		expect(r.afterP60[2]).toBeLessThan(120);
	});
});
