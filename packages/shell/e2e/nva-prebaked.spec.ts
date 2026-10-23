import { expect, test } from "@playwright/test";
import {
	SEED_ADK_PATH,
	TAURI_BASE_MOCK_FALLBACK,
} from "./helpers/tauri-base-mock";

const NVA_MOCK = `
(function () {
  const query = new URLSearchParams(window.location.search);
  const animations = {
    idle: { clip: "clips/idle.webm", loop: true },
    speak: { clip: "clips/talk.webm", loop: true },
  };
  if (!query.has("nvaNoGesture")) {
    animations.wave = { clip: "clips/wave.webm", loop: false, can_talk: false, label: "Wave" };
  }
  const manifest = {
    nva_version: "0.2",
    canvas: { width: 406, height: 720, fps: 25 },
    animations,
    vrm_slots: {
      profile: {
        generation_mode: "prebaked_webm_only",
        default_locale: "en-US",
        available_locales: ["en-US"]
      },
      motions: {
        idle: { clip: "clips/idle.webm", loop: true },
        talking: { clip: "clips/talk.webm", loop: true }
      },
      speech: {
        greeting: {
          text: "Hello. I am Naia.",
          clip: "clips/en-US/greeting.webm",
          by_locale: {
            "en-US": { text: "Hello. I am Naia.", clip: "clips/en-US/greeting.webm" }
          }
        }
      }
    }
  };
  window.__nvaInvokes = [];
  window.__nvaPlayedClips = [];
  window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = window.__TAURI_EVENT_PLUGIN_INTERNALS__ || {};
  window.__TAURI_INTERNALS__.metadata = { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } };
  window.__TAURI_INTERNALS__.transformCallback = window.__TAURI_INTERNALS__.transformCallback || ((fn) => fn);
  window.__TAURI_INTERNALS__.convertFileSrc = (path) => "asset://localhost/" + encodeURIComponent(path);
  window.__TAURI_INTERNALS__.invoke = async function (cmd, args) {
    window.__nvaInvokes.push({ cmd, args });
    if (cmd === "plugin:event|listen" || cmd === "plugin:event|unlisten" || cmd === "plugin:event|emit") return null;
    if (cmd === "detect_gpu_vram") return null;
    if (cmd === "read_local_binary") {
      if (String(args && args.path).endsWith("manifest.json")) {
        if (query.has("nvaManifestError")) throw new Error("Fixture manifest unavailable");
        const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(manifest))));
        if (query.has("holdNvaManifest")) {
          return new Promise((resolve) => { window.__releaseNvaManifest = () => resolve(encoded); });
        }
        return encoded;
      }
      return "AA==";
    }
    return undefined;
  };
  Object.defineProperty(HTMLMediaElement.prototype, "play", {
    configurable: true,
    value: function () {
      window.__nvaPlayedClips.push(this.dataset.naiaClipUrl || "");
      return Promise.resolve();
    }
  });
  HTMLMediaElement.prototype.pause = function () {};
})();
`;

test.describe("UC-NVA-PREBAKED - GPU-free Shell video avatar", () => {
	test("loads pre-baked NVA without exposing or starting the retired server runtime", async ({
		page,
	}) => {
		await page.addInitScript(NVA_MOCK);
		await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
		await page.addInitScript({ content: SEED_ADK_PATH });
		await page.addInitScript(() => {
			localStorage.setItem(
				"naia-config",
				JSON.stringify({
					provider: "gemini",
					model: "gemini-3.5-flash",
					locale: "en",
					onboardingComplete: true,
					avatarProvider: "naia-video-avatar",
					nvaModel: "naia-prebaked",
					cascadeRuntimeUrl: "https://stale-avatar.invalid:8910",
					local8gFocus: "avatar",
					localAvatarVoiceFocus: "both",
				}),
			);
		});

		await page.goto("/");
		const avatar = page.locator("[data-video-avatar]");
		await expect(avatar).toHaveAttribute("data-video-avatar-mode", "prebaked");
		await expect(avatar).toHaveAttribute("data-video-avatar-loaded", "true");
		const video = page.locator("[data-video-avatar-prebaked]");
		await expect(video).toHaveCount(1);
		await expect(video).toBeVisible();
		const videoBox = await video.boundingBox();
		expect(videoBox?.width).toBeGreaterThan(0);
		expect(videoBox?.height).toBeGreaterThan(0);
		await expect(page.locator("[data-video-avatar-status]")).toHaveCount(0);
		const zoomIn = page.getByRole("button", { name: "Zoom in" });
		const zoomOut = page.getByRole("button", { name: "Zoom out" });
		const wave = page.getByRole("button", { name: "Wave" });
		await expect(zoomIn).toBeVisible();
		await expect(zoomOut).toBeVisible();
		await expect(wave).toBeVisible();
		if (process.env.NVA_CAPTURE_BEFORE)
			await page.screenshot({ path: process.env.NVA_CAPTURE_BEFORE });
		await zoomIn.click();
		await expect(video).toHaveAttribute("style", /scale\(1\.1\)/);
		if (process.env.NVA_CAPTURE_AFTER)
			await page.screenshot({ path: process.env.NVA_CAPTURE_AFTER });
		const initialPlayCount = await page.evaluate(
			() => (window as any).__nvaPlayedClips.length,
		);
		await wave.click();
		await expect
			.poll(() => page.evaluate(() => (window as any).__nvaPlayedClips.length))
			.toBeGreaterThan(initialPlayCount);
		await zoomOut.click();
		await expect(video).toHaveAttribute("style", /scale\(1\)/);

		await page.locator(".app-bar-settings").click();
		await page.locator('[data-settings-tab="avatar"]').click();
		const videoOption = page.locator(
			'#avatar-provider option[value="naia-video-avatar"]',
		);
		await expect(videoOption).toBeEnabled();
		await expect(page.locator("#cascade-runtime-url")).toHaveCount(0);
		await expect(
			page.locator('[data-testid="avatar-cascade-required"]'),
		).toHaveCount(0);
		await expect(
			page.locator('[data-testid="nva-vram-requirement"]'),
		).toHaveCount(0);
		await expect(
			page.locator('[data-testid="cloud-cascade-coming-soon"]'),
		).toHaveCount(0);

		const result = await page.evaluate(() => ({
			commands: (window as any).__nvaInvokes.map((entry) => entry.cmd),
			playedClips: (window as any).__nvaPlayedClips,
			config: JSON.parse(localStorage.getItem("naia-config") || "{}"),
		}));
		expect(result.commands).not.toContain("start_voxcpm2");
		expect(result.commands).not.toContain("probe_cascade_health");
		expect(result.config.cascadeRuntimeUrl).toBeUndefined();
		expect(result.config.local8gFocus).toBeUndefined();
		expect(result.config.localAvatarVoiceFocus).toBeUndefined();
		expect(result.config.avatarProvider).toBe("naia-video-avatar");
		expect(result.playedClips.length).toBeGreaterThan(1);
	});

	test("keeps loading, empty gesture, error, and narrow controls understandable", async ({
		page,
	}) => {
		await page.addInitScript(NVA_MOCK);
		await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
		await page.addInitScript({ content: SEED_ADK_PATH });
		await page.addInitScript(() => {
			localStorage.setItem(
				"naia-config",
				JSON.stringify({
					provider: "gemini",
					model: "gemini-3.5-flash",
					locale: "en",
					onboardingComplete: true,
					avatarProvider: "naia-video-avatar",
					nvaModel: "naia-prebaked",
				}),
			);
		});

		await page.goto("/?holdNvaManifest=1&nvaNoGesture=1");
		const avatar = page.locator("[data-video-avatar]");
		await expect(avatar).toHaveAttribute("data-video-avatar-mode", "loading");
		await expect(page.getByRole("button", { name: "Zoom in" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Wave" })).toHaveCount(0);
		await page.evaluate(() => (window as any).__releaseNvaManifest?.());
		await expect(avatar).toHaveAttribute("data-video-avatar-mode", "prebaked");
		await expect(page.getByRole("button", { name: "Wave" })).toHaveCount(0);

		await page.setViewportSize({ width: 360, height: 800 });
		for (const name of ["Zoom in", "Zoom out", "Reset avatar view"]) {
			const button = page.getByRole("button", { name });
			await expect(button).toBeVisible();
			const box = await button.boundingBox();
			expect(box?.x).toBeGreaterThanOrEqual(0);
			expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(360);
		}
		const zoomIn = page.getByRole("button", { name: "Zoom in" });
		await zoomIn.focus();
		await expect(zoomIn).toBeFocused();
		await page.keyboard.press("Enter");
		await expect(page.locator("[data-video-avatar-prebaked]")).toHaveAttribute(
			"style",
			/scale\(1\.1\)/,
		);

		await page.goto("/?nvaManifestError=1");
		await expect(page.locator("[data-video-avatar]")).toHaveAttribute(
			"data-video-avatar-mode",
			"error",
		);
		await expect(page.locator("[data-video-avatar-status]")).toContainText(
			/Unable to|failed/i,
		);
	});
});
