import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { openWebShellWithBgm, WEB_BGM_VIEWPORTS } from "./helpers/web-bgm";
import { captureWebRequirement } from "./helpers/web-settings";

test.skip(process.env.NAIA_E2E_WEB !== "1", "requires the web runtime");

const modelPath = "/avatars/01-Sendagaya-Shino-uniform.vrm";
const answer =
	"Ah ee oo, your avatar is speaking and you can listen to ah, ee, and oo.";
const audio = readFileSync(
	new URL("./fixtures/vrm-speech-r43.mp3", import.meta.url),
);
const cors = {
	"access-control-allow-origin": "*",
	"access-control-allow-headers": "content-type,x-anyllm-key,authorization",
	"access-control-allow-methods": "GET,POST,OPTIONS",
};

declare global {
	interface Window {
		r43Media: HTMLAudioElement[];
		r43Mouth: {
			weight: number;
			opening: number;
			peak: number;
			audioTime: number;
		};
		r43NvaStarted: boolean;
		r43NvaClock: (() => number) | undefined;
	}
}

async function openSpeakingAvatar(page: Page, nva: boolean) {
	await page.context().route(/^https?:\/\//, (route) => {
		const url = new URL(route.request().url());
		if (url.hostname === "127.0.0.1" || url.hostname === "localhost")
			return route.continue();
		if (route.request().method() === "OPTIONS")
			return route.fulfill({ status: 204, headers: cors });
		if (url.pathname === "/v1/profile/balance")
			return route.fulfill({ headers: cors, json: { credits: 1234 } });
		if (url.pathname === "/v1/audio/speech")
			return route.fulfill({
				headers: cors,
				contentType: "audio/mpeg",
				body: audio,
			});
		if (url.pathname === "/v1/chat/completions") {
			const model = route.request().postDataJSON().model;
			const chunk = (delta: object, finish_reason: string | null) =>
				`data: ${JSON.stringify({ model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
			return route.fulfill({
				headers: cors,
				contentType: "text/event-stream",
				body:
					chunk({ content: answer }, null) +
					chunk({}, "stop") +
					"data: [DONE]\n\n",
			});
		}
		return route.fulfill({ status: 404, headers: cors, json: {} });
	});
	await page.addInitScript(() => {
		localStorage.setItem("naia-remote-key", "fixture-r43-local-key");
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: "nextain",
				model: "gpt-5.6-luna",
				locale: "en",
			}),
		);
		performance.setResourceTimingBufferSize(5000);
		window.r43Media = [];
		window.r43Mouth = { weight: 0, opening: 0, peak: 0, audioTime: 0 };
		const NativeAudio = window.Audio;
		window.Audio = class extends NativeAudio {
			constructor(src?: string) {
				super(src);
				if (src?.startsWith("data:audio/")) window.r43Media.push(this);
			}
		};
	});
	await openWebShellWithBgm(page, { openBgm: false });
	await page.evaluate(
		async ({ modelPath, nva }) => {
			const configPath = "/src/lib/config.ts";
			const appStorePath = "/src/stores/app.ts";
			const { loadConfig, saveConfig } = await import(configPath);
			const { useAppStore } = await import(appStorePath);
			saveConfig({
				...loadConfig(),
				provider: "nextain",
				model: "gpt-5.6-luna",
				ttsProvider: "nextain",
				ttsEnabled: true,
				avatarProvider: nva ? "naia-video-avatar" : "vrm",
				nvaModel: nva ? "jina" : undefined,
				vrmModel: modelPath,
			});
			useAppStore.getState().setTtsEnabled(true);
		},
		{ modelPath, nva },
	);
}

async function sendSpeechPrompt(page: Page) {
	const input = page.locator(".naia-chat-area .chat-input");
	await input.fill("Please speak so I can see the avatar.");
	await input.press("Enter");
}

for (const viewport of WEB_BGM_VIEWPORTS) {
	test(`R43 renders a VRM mouth while decoded web TTS plays at ${viewport.width}px`, async ({
		page,
	}) => {
		await page.setViewportSize(viewport);
		await openSpeakingAvatar(page, false);
		const avatar = page.locator('[data-avatar-load-stage="ready"]');
		await expect(avatar).toBeVisible();
		if (viewport.width === 1280) {
			await avatar
				.locator("canvas")
				.dispatchEvent("wheel", { deltaY: -575, cancelable: true });
		}
		await page.evaluate(async (modelPath) => {
			const moduleUrl = performance
				.getEntriesByType("resource")
				.find(({ name }) => /three-vrm\.js(?:\?|$)/.test(name))?.name;
			const corePath = "/src/lib/vrm/core.ts";
			const expressions = moduleUrl
				? (await import(moduleUrl)).VRMExpressionManager.prototype
				: Object.getPrototypeOf(
						(await (await import(corePath)).loadVrm(modelPath))._vrm
							.expressionManager,
					);
			const originalUpdate = expressions.update;
			expressions.update = function () {
				const tracking = window.r43Mouth;
				tracking.opening = this.getValue("aa") ?? 0;
				tracking.weight = Math.max(
					0,
					...["aa", "ee", "ih", "oh", "ou"].map(
						(name) => this.getValue(name) ?? 0,
					),
				);
				const playing = window.r43Media.find(
					(clip) => !clip.paused && !clip.ended,
				);
				tracking.audioTime = playing?.currentTime ?? 0;
				if (tracking.audioTime > 0.1)
					tracking.peak = Math.max(tracking.peak, tracking.weight);
				return originalUpdate.call(this);
			};
		}, modelPath);
		await expect
			.poll(() => page.evaluate(() => window.r43Mouth.weight))
			.toBe(0);
		await sendSpeechPrompt(page);
		await page.waitForFunction(
			() => window.r43Mouth.audioTime > 0.1 && window.r43Mouth.opening > 0.55,
		);
		await captureWebRequirement(page, "R43");
		await expect(page.locator(".chat-messages")).toContainText(answer);
		await expect
			.poll(() => page.evaluate(() => window.r43Mouth.peak))
			.toBeGreaterThan(0.4);
		await expect
			.poll(() =>
				page.evaluate(() => window.r43Media.some((clip) => clip.ended)),
			)
			.toBe(true);
		await expect
			.poll(() => page.evaluate(() => window.r43Mouth.weight))
			.toBe(0);

		await page.evaluate(() => {
			window.r43Media.length = 0;
		});
		await sendSpeechPrompt(page);
		await page.waitForFunction(
			() => window.r43Mouth.audioTime > 0.1 && window.r43Mouth.weight > 0.4,
		);
		await page.keyboard.press("Escape");
		await expect
			.poll(() =>
				page.evaluate(() => ({
					stopped: window.r43Media.some((clip) => clip.paused && !clip.ended),
					weight: window.r43Mouth.weight,
				})),
			)
			.toEqual({ stopped: true, weight: 0 });
	});

	test(`R43 compares NVA playback using the same voice at ${viewport.width}px`, async ({
		page,
	}) => {
		await page.setViewportSize(viewport);
		await openSpeakingAvatar(page, true);
		const avatar = page.locator(
			'[data-nva-model="jina"][data-video-avatar-loaded="true"]',
		);
		await expect(avatar).toBeVisible();
		if (viewport.width === 1280) {
			await expect
				.poll(() =>
					page.evaluate(async () => {
						const storePath = "/src/stores/cascade-avatar.ts";
						const { useCascadeAvatarStore } = await import(storePath);
						return useCascadeAvatarStore.getState().renderer?.modelId;
					}),
				)
				.toBe("jina");
			await page.evaluate(async () => {
				const storePath = "/src/stores/cascade-avatar.ts";
				const { useCascadeAvatarStore } = await import(storePath);
				const renderer = useCascadeAvatarStore.getState().renderer;
				await renderer.warmSpeechAssets();
				const prepare = renderer.prepareSpeechTiming.bind(renderer);
				renderer.prepareSpeechTiming = async (plan: unknown) => {
					const prepared = await prepare(plan);
					if (!prepared) return prepared;
					return {
						play: async (clock: () => number) => {
							window.r43NvaStarted = await prepared.play(clock);
							if (window.r43NvaStarted) window.r43NvaClock = clock;
							return window.r43NvaStarted;
						},
					};
				};
			});
		}
		await sendSpeechPrompt(page);
		await expect
			.poll(() =>
				page.evaluate(() =>
					window.r43Media.some((clip) => clip.currentTime > 0.15),
				),
			)
			.toBe(true);
		if (viewport.width === 1280) {
			await expect
				.poll(() => page.evaluate(() => window.r43NvaClock?.() ?? 0))
				.toBeGreaterThan(0.15);
		} else {
			await expect
				.poll(() =>
					avatar.locator("video").evaluateAll((videos) =>
						videos.some((el) => {
							const video = el as HTMLVideoElement;
							return (
								/talking/.test(
									video.currentSrc || video.dataset.naiaClipUrl || "",
								) && video.currentTime > 0
							);
						}),
					),
				)
				.toBe(true);
		}
	});
}
