import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
	SEED_ADK_PATH,
	TAURI_BASE_MOCK_FALLBACK,
} from "./helpers/tauri-base-mock";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIP_B64 = readFileSync(
	join(__dirname, "fixtures", "base-alpha-200.webm"),
).toString("base64");
const CAPTURES_DIR =
	"/var/home/luke/alpha-adk/.agents/work/naia-res/nva-live2d/captures";

const NVA_MOTION_MOCK = `
(function () {
  const manifest = {
    nva_version: "0.2",
    canvas: { width: 200, height: 200, fps: 25 },
    motion: {
      breath: 0.03,
      breath_period_s: 3.6,
      sway_deg: 3.0,
      sway_period_s: 7.0,
      chest_y: 0.72,
      pivot_y: 1.0
    },
    animations: {
      idle: { clip: "clips/idle.webm", loop: true },
      speak: { clip: "clips/idle.webm", loop: true }
    },
    vrm_slots: {
      profile: {
        generation_mode: "prebaked_webm_only",
        default_locale: "ko-KR",
        available_locales: ["ko-KR"]
      },
      motions: {
        idle: { clip: "clips/idle.webm", loop: true }
      }
    }
  };
  window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = window.__TAURI_EVENT_PLUGIN_INTERNALS__ || {};
  window.__TAURI_INTERNALS__.metadata = { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } };
  window.__TAURI_INTERNALS__.transformCallback = window.__TAURI_INTERNALS__.transformCallback || ((fn) => fn);
  window.__TAURI_INTERNALS__.convertFileSrc = (path) => "asset://localhost/" + encodeURIComponent(path);
  window.__TAURI_INTERNALS__.invoke = async function (cmd, args) {
    if (cmd === "plugin:event|listen" || cmd === "plugin:event|unlisten" || cmd === "plugin:event|emit") return null;
    if (cmd === "detect_gpu_vram") return null;
    if (cmd === "read_local_binary") {
      if (String(args && args.path).endsWith("manifest.json")) {
        return btoa(unescape(encodeURIComponent(JSON.stringify(manifest))));
      }
      return "${CLIP_B64}";
    }
    return undefined;
  };
})();
`;

function countPixelDiffs(p1: number[], p2: number[], threshold = 15): number {
	let diffs = 0;
	for (let i = 0; i < p1.length; i += 4) {
		const dr = Math.abs(p1[i] - p2[i]);
		const dg = Math.abs(p1[i + 1] - p2[i + 1]);
		const db = Math.abs(p1[i + 2] - p2[i + 2]);
		const da = Math.abs(p1[i + 3] - p2[i + 3]);
		if (dr > threshold || dg > threshold || db > threshold || da > threshold) {
			diffs++;
		}
	}
	return diffs;
}

test.describe("UC-NVA-MOTION — Live2D motion and head follow (P04)", () => {
	test("verifies motion at 1.5s interval, reducedMotion zero-diff, and narrow viewport responsiveness", async ({
		page,
	}) => {
		test.setTimeout(60_000);

		await page.addInitScript(NVA_MOTION_MOCK);
		await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
		await page.addInitScript({ content: SEED_ADK_PATH });
		await page.addInitScript(() => {
			localStorage.setItem(
				"naia-config",
				JSON.stringify({
					provider: "gemini",
					model: "gemini-3.5-flash",
					locale: "ko",
					onboardingComplete: true,
					avatarProvider: "naia-video-avatar",
					nvaModel: "naia-motion",
				}),
			);
		});

		await page.goto("/");

		const avatar = page.locator("[data-video-avatar]");
		await expect(avatar).toHaveAttribute("data-video-avatar-mode", "prebaked", {
			timeout: 15_000,
		});
		await expect(avatar).toHaveAttribute("data-video-avatar-loaded", "true");

		const canvas = page.locator("[data-video-avatar-prebaked]");
		await expect(canvas).toBeVisible();

		// 비디오 디코딩 및 첫 프레임 실제 렌더 완료 대기 (중앙 픽셀이 빨강)
		await page.waitForFunction(
			() => {
				const c = document.querySelector<HTMLCanvasElement>(
					"[data-video-avatar-prebaked]",
				);
				if (!c) return false;
				const ctx = c.getContext("2d");
				if (!ctx) return false;
				const center = ctx.getImageData(100, 100, 1, 1).data;
				return center[0] > 150;
			},
			{ timeout: 10_000 },
		);
		await expect(page.locator(".splash-screen")).toHaveCount(0, {
			timeout: 20_000,
		});
		await page.waitForTimeout(300);

		// (a) 기본값에서 약 1.5초 간격 두 캡처의 머리 영역 픽셀이 다르다.
		await canvas.screenshot({
			path: `${CAPTURES_DIR}/motion-t0.png`,
		});

		const headPixelsT0 = await page.evaluate(() => {
			const c = document.querySelector<HTMLCanvasElement>(
				"[data-video-avatar-prebaked]",
			);
			if (!c) return null;
			const ctx = c.getContext("2d");
			if (!ctx) return null;
			// 머리/상체 영역 (200x200 중 x: 30..170, y: 40..120)
			return Array.from(ctx.getImageData(30, 40, 140, 80).data);
		});
		expect(headPixelsT0).not.toBeNull();
		const t0Max = Math.max(...headPixelsT0!);
		console.log("t0Max:", t0Max);

		await page.waitForTimeout(1500);

		await canvas.screenshot({
			path: `${CAPTURES_DIR}/motion-t1500.png`,
		});

		const headPixelsT1500 = await page.evaluate(() => {
			const c = document.querySelector<HTMLCanvasElement>(
				"[data-video-avatar-prebaked]",
			);
			if (!c) return null;
			const ctx = c.getContext("2d");
			if (!ctx) return null;
			return Array.from(ctx.getImageData(30, 40, 140, 80).data);
		});
		expect(headPixelsT1500).not.toBeNull();

		const motionDiffs = countPixelDiffs(headPixelsT0!, headPixelsT1500!);
		// 움직임(숨쉬기+흔들림)으로 인해 머리 경계 픽셀에 유의미한 차이가 존재해야 함
		expect(motionDiffs).toBeGreaterThan(30);

		// (b) page.emulateMedia({ reducedMotion: 'reduce' })이면 움직임에 의한 차이가 없다.
		// 클립 자체의 영상 압축 노이즈/반복 재생 영향을 분리하기 위해 비디오를 정지하여 순수 절차적 움직임 효과만 격리.
		await page.emulateMedia({ reducedMotion: "reduce" });
		await page.evaluate(() => {
			const v = document.querySelector("video");
			if (v) v.pause();
		});
		await page.waitForTimeout(400);

		await canvas.screenshot({
			path: `${CAPTURES_DIR}/reduced-motion-t0.png`,
		});

		const redPixelsT0 = await page.evaluate(() => {
			const c = document.querySelector<HTMLCanvasElement>(
				"[data-video-avatar-prebaked]",
			);
			if (!c) return null;
			const ctx = c.getContext("2d");
			if (!ctx) return null;
			return Array.from(ctx.getImageData(30, 40, 140, 80).data);
		});
		expect(redPixelsT0).not.toBeNull();

		await page.waitForTimeout(1500);

		await canvas.screenshot({
			path: `${CAPTURES_DIR}/reduced-motion-t1500.png`,
		});

		const redPixelsT1500 = await page.evaluate(() => {
			const c = document.querySelector<HTMLCanvasElement>(
				"[data-video-avatar-prebaked]",
			);
			if (!c) return null;
			const ctx = c.getContext("2d");
			if (!ctx) return null;
			return Array.from(ctx.getImageData(30, 40, 140, 80).data);
		});
		expect(redPixelsT1500).not.toBeNull();

		const reducedDiffs = countPixelDiffs(redPixelsT0!, redPixelsT1500!);
		// 정지 클립에서 움직임 줄이기 적용 시 1.5초 간격에도 픽셀 차이가 0이어야 함
		expect(reducedDiffs).toBe(0);

		// (c) 좁은 창에서도 캐릭터가 잘리지 않는다.
		await page.emulateMedia({ reducedMotion: "no-preference" });
		await page.setViewportSize({ width: 360, height: 640 });
		await page.waitForTimeout(400);

		await page.screenshot({
			path: `${CAPTURES_DIR}/narrow-window.png`,
		});
		await canvas.screenshot({
			path: `${CAPTURES_DIR}/narrow-avatar.png`,
		});

		const box = await canvas.boundingBox();
		expect(box).not.toBeNull();
		expect(box!.x).toBeGreaterThanOrEqual(0);
		expect(box!.x + box!.width).toBeLessThanOrEqual(360);
		expect(box!.width).toBeGreaterThan(0);
		expect(box!.height).toBeGreaterThan(0);
	});
});
