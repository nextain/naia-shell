import { expect, test } from "@playwright/test";
import {
	SEED_ADK_PATH,
	TAURI_BASE_MOCK_FALLBACK,
} from "./helpers/tauri-base-mock";

const CASCADE_URL = process.env.NAIA_E2E_CASCADE_URL?.replace(/\/$/, "");

const TAURI_MOCK = `
(function() {
	window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
	window.__TAURI_EVENT_PLUGIN_INTERNALS__ = window.__TAURI_EVENT_PLUGIN_INTERNALS__ || {};
	window.__TAURI_INTERNALS__.metadata = { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } };
	var callbacks = new Map(); var nextCbId = 1;
	window.__TAURI_INTERNALS__.transformCallback = function(fn, once) { var id = nextCbId++; callbacks.set(id, function(d){ if(once) callbacks.delete(id); return fn && fn(d); }); return id; };
	window.__TAURI_INTERNALS__.unregisterCallback = function(id){ callbacks.delete(id); };
	window.__TAURI_INTERNALS__.runCallback = function(id, d){ var cb = callbacks.get(id); if (cb) cb(d); };
	window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = function() {};
	window.__TAURI_INTERNALS__.convertFileSrc = function(p, proto){ return (proto || "asset") + "://localhost/" + encodeURIComponent(p); };
	window.__TAURI_INTERNALS__.invoke = async function(cmd, args) {
		if (cmd === "plugin:event|listen") return args.handler;
		if (cmd === "plugin:event|emit" || cmd === "plugin:event|unlisten") return null;
		if (cmd === "detect_gpu_vram") return null;
		if (cmd === "cascade_status") return false;
		return undefined;
	};
})();
`;

test.describe("NVA remote cascade stage 1", () => {
	test.skip(!CASCADE_URL, "Set NAIA_E2E_CASCADE_URL to run the live cascade check.");

	test("Shell loads and plays the remote idle MP4 without remote load_nva", async ({
		page,
	}, testInfo) => {
		const requests: string[] = [];
		const requestFailures: string[] = [];
		page.on("request", (request) => {
			if (request.url().startsWith(CASCADE_URL as string)) {
				requests.push(request.url());
			}
		});
		page.on("requestfailed", (request) => {
			if (request.url().startsWith(CASCADE_URL as string)) {
				requestFailures.push(
					`${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "unknown"}`,
				);
			}
		});

		await page.addInitScript(TAURI_MOCK);
		await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
		await page.addInitScript({ content: SEED_ADK_PATH });
		await page.addInitScript(
			([cascadeRuntimeUrl]) => {
				localStorage.setItem(
					"naia-config",
					JSON.stringify({
						provider: "nextain",
						model: "gemini-3.5-flash",
						naiaKey: "e2e-live-cascade",
						onboardingComplete: true,
						avatarProvider: "naia-video-avatar",
						nvaModel: "naia.nva",
						cascadeRuntimeUrl,
					}),
				);
			},
			[CASCADE_URL as string],
		);

		await page.goto("/");
		await expect(page.locator("[data-video-avatar]")).toBeVisible({
			timeout: 10_000,
		});
		const canvas = page.locator('[data-video-avatar-mode="cascade"]');
		try {
			await expect(canvas).toBeVisible({ timeout: 20_000 });
		} catch {
			const currentMode = await page
				.locator("[data-video-avatar-mode]")
				.first()
				.getAttribute("data-video-avatar-mode");
			throw new Error(
				`remote NVA did not enter cascade mode (mode=${currentMode ?? "missing"}; failures=${requestFailures.join(" | ") || "none"})`,
			);
		}
		const video = canvas.locator("video").first();
		await expect
			.poll(
				() =>
					video.evaluate((element: HTMLVideoElement) => ({
						width: element.videoWidth,
						height: element.videoHeight,
						readyState: element.readyState,
						currentTime: element.currentTime,
					})),
				{ timeout: 25_000 },
			)
			.toMatchObject({ width: 720, height: 1280, readyState: 4 });

		const firstTime = await video.evaluate(
			(element: HTMLVideoElement) => element.currentTime,
		);
		await page.waitForTimeout(500);
		const secondTime = await video.evaluate(
			(element: HTMLVideoElement) => element.currentTime,
		);
		expect(secondTime).toBeGreaterThan(firstTime);
		await expect(page.locator(".splash-screen")).toHaveCount(0, {
			timeout: 10_000,
		});
		await expect(video).toBeInViewport();
		expect(requests.some((url) => new URL(url).pathname === "/health")).toBe(
			true,
		);
		expect(requests.some((url) => new URL(url).pathname === "/idle")).toBe(true);
		expect(requests.some((url) => new URL(url).pathname === "/load_nva")).toBe(
			false,
		);
		expect(
			requests.some(
				(url) =>
					new URL(url).pathname === "/idle" && new URL(url).search.length > 0,
			),
		).toBe(false);

		await page.screenshot({
			path: testInfo.outputPath("nva-remote-idle.png"),
			fullPage: true,
		});
	});

	test("Shell renderer receives a playable first frame from remote /stream", async ({
		page,
	}, testInfo) => {
		await page.addInitScript(TAURI_MOCK);
		await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
		await page.addInitScript({ content: SEED_ADK_PATH });
		await page.goto("/");

		const result = await page.evaluate(async (runtimeUrl) => {
			const { CascadeAvatarRenderer } = await import(
				"/src/lib/avatar/cascade-renderer.ts"
			);
			const container = document.createElement("div");
			const host = document.createElement("video");
			container.appendChild(host);
			document.body.appendChild(container);
			const renderer = new CascadeAvatarRenderer({ runtimeUrl });
			renderer.start(host);

			const sampleRate = 24_000;
			const pcm = new Uint8Array(sampleRate * 2);
			const view = new DataView(pcm.buffer);
			for (let i = 0; i < sampleRate; i++) {
				const sample = Math.round(Math.sin((2 * Math.PI * 220 * i) / sampleRate) * 4000);
				view.setInt16(i * 2, sample, true);
			}
			let binary = "";
			for (let i = 0; i < pcm.length; i += 0x8000) {
				binary += String.fromCharCode(...pcm.subarray(i, i + 0x8000));
			}

			const startedAt = performance.now();
			const firstFrameMs = await Promise.race([
				new Promise<number>((resolve) => {
					void renderer.speakAudio(btoa(binary), sampleRate, {
						muted: true,
						onPlaybackReady: () => resolve(performance.now() - startedAt),
					});
				}),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("remote first-frame timeout")), 30_000),
				),
			]);
			const overlay = container.querySelectorAll("video")[1];
			const opacity = overlay?.style.opacity;
			renderer.stop();
			container.remove();
			return { firstFrameMs, opacity };
		}, CASCADE_URL as string);

		expect(result.firstFrameMs).toBeGreaterThan(0);
		expect(result.firstFrameMs).toBeLessThan(30_000);
		expect(result.opacity).toBe("1");
		await testInfo.attach("remote-stream-timing.json", {
			body: JSON.stringify(result, null, 2),
			contentType: "application/json",
		});
	});
});
