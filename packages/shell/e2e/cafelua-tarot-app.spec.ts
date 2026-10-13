import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

declare global {
	interface Window {
		__tarotAllowAudio?: boolean;
		__tarotReplyMode?: "hold" | "success" | "error";
		__tarotLastAsk?: { id: string; prompt: string };
		__tarotAudioEvents?: Array<{
			kind: string;
			at: number;
			bgmPlaying?: boolean;
			volume?: number;
			value?: number;
			scheduledFor?: number;
		}>;
		__tarotBgmPlaying?: boolean;
	}
}

const shotsDir = process.env.CAFELUA_TAROT_SHOTS
	? resolve(process.env.CAFELUA_TAROT_SHOTS)
	: resolve("test-results/cafelua-tarot");

test("Cafe Lua Tarot reading, sound, library, stories, and narrow layout", async ({
	page,
}) => {
	mkdirSync(shotsDir, { recursive: true });
	await page.addInitScript(() => {
		window.__tarotAllowAudio = false;
		window.__tarotReplyMode = "success";
		window.__tarotAudioEvents = [];
		window.__tarotBgmPlaying = false;
		const events = window.__tarotAudioEvents!;
		const originalPlay = HTMLMediaElement.prototype.play;
		const originalPause = HTMLMediaElement.prototype.pause;
		HTMLMediaElement.prototype.play = function () {
			if (!(this.currentSrc || this.src).includes("taro-bgm.mp3"))
				return originalPlay.call(this);
			if (!window.__tarotAllowAudio) {
				events.push({ kind: "bgm-autoplay-blocked", at: performance.now() });
				return Promise.reject(
					new DOMException("user gesture required", "NotAllowedError"),
				);
			}
			return originalPlay.call(this).then(() => {
				window.__tarotBgmPlaying = true;
				events.push({
					kind: "bgm-play",
					at: performance.now(),
					volume: this.volume,
				});
			});
		};
		HTMLMediaElement.prototype.pause = function () {
			if ((this.currentSrc || this.src).includes("taro-bgm.mp3")) {
				window.__tarotBgmPlaying = false;
				events.push({ kind: "bgm-pause", at: performance.now() });
			}
			return originalPause.call(this);
		};
		const audioContext = window.AudioContext;
		if (audioContext) {
			const createOscillator = audioContext.prototype.createOscillator;
			const createGain = audioContext.prototype.createGain;
			audioContext.prototype.createOscillator = function () {
				const oscillator = createOscillator.call(this);
				const start = oscillator.start.bind(oscillator);
				const stop = oscillator.stop.bind(oscillator);
				oscillator.start = (when?: number) => {
					events.push({
						kind: "flip-start",
						at: performance.now(),
						bgmPlaying: window.__tarotBgmPlaying,
					});
					start(when);
				};
				oscillator.stop = (when?: number) => {
					events.push({
						kind: when === undefined ? "flip-stop-now" : "flip-stop-scheduled",
						at: performance.now(),
						scheduledFor: when,
					});
					stop(when);
				};
				return oscillator;
			};
			audioContext.prototype.createGain = function () {
				const node = createGain.call(this);
				const ramp = node.gain.exponentialRampToValueAtTime.bind(node.gain);
				node.gain.exponentialRampToValueAtTime = (
					value: number,
					time: number,
				) => {
					events.push({ kind: "flip-gain", at: performance.now(), value });
					return ramp(value, time);
				};
				return node;
			};
		}
		window.addEventListener("message", (event) => {
			if (
				event.source !== window.parent ||
				event.data?.type !== "naia-cafelua-tarot:ask"
			)
				return;
			window.__tarotLastAsk = event.data;
			const mode = window.__tarotReplyMode;
			if (mode === "hold") return;
			setTimeout(
				() =>
					window.parent.postMessage(
						{
							type: "naia-cafelua-tarot:response",
							id: event.data.id,
							text:
								mode === "error"
									? ""
									: "Naia sees a new path opening. Consider what you are ready to begin.",
							error:
								mode === "error"
									? "The test provider is unavailable."
									: undefined,
						},
						window.location.origin,
					),
				20,
			);
		});
	});

	await page.goto("/cafelua-tarot.html");
	await expect(
		page.getByRole("heading", { name: "Cafe Lua Tarot" }),
	).toBeVisible();
	await page.evaluate(() =>
		window.parent.postMessage(
			{ type: "naia-app:locale", locale: "ko" },
			window.location.origin,
		),
	);
	await expect(
		page.getByRole("heading", { name: "카페루아 타로" }),
	).toBeVisible();
	const readingTab = page.getByRole("tab", { name: "타로점" });
	await readingTab.focus();
	await page.keyboard.press("ArrowRight");
	const cardsTab = page.getByRole("tab", { name: "카드 보기" });
	await expect(cardsTab).toBeFocused();
	await expect(cardsTab).toHaveAttribute("aria-selected", "true");
	await page.keyboard.press("Home");
	await expect(readingTab).toBeFocused();
	await expect(page.getByRole("tabpanel")).toHaveAttribute(
		"aria-labelledby",
		"reading-heading",
	);
	await expect(page.getByRole("status")).toContainText(
		"자동 재생을 막았습니다",
	);
	await page.screenshot({
		path: resolve(shotsDir, "reading-empty-ko.png"),
		fullPage: true,
	});

	await page.evaluate(() => {
		window.__tarotAllowAudio = true;
	});
	await page.getByRole("button", { name: "열 장 펼치기" }).click();
	const revealButton = page.locator(".tarot-reading-actions .tarot-primary");
	await expect(revealButton).toBeEnabled();
	await expect(page.getByRole("status")).toHaveCount(0);
	await page.screenshot({
		path: resolve(shotsDir, "reading-basic-ko.png"),
		fullPage: true,
	});

	await page.evaluate(() => {
		window.__tarotReplyMode = "hold";
	});
	await revealButton.click();
	await expect(page.getByRole("status")).toContainText(
		"이 카드를 살펴보고 있어요",
	);
	await expect
		.poll(() => page.evaluate(() => window.__tarotLastAsk?.prompt ?? ""))
		.toContain("You are Naia");
	await page.screenshot({
		path: resolve(shotsDir, "reading-progress-ko.png"),
		fullPage: true,
	});
	await page.evaluate(() => {
		const ask = window.__tarotLastAsk!;
		window.parent.postMessage(
			{
				type: "naia-cafelua-tarot:response",
				id: ask.id,
				text: "나이아가 카페루아의 첫걸음을 읽습니다.",
			},
			window.location.origin,
		);
	});
	await expect(page.locator(".tarot-naia-reply")).toContainText(
		"나이아가 카페루아의 첫걸음을 읽습니다",
	);
	await page.screenshot({
		path: resolve(shotsDir, "reading-success-ko.png"),
		fullPage: true,
	});

	await revealButton.click();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					window.__tarotAudioEvents?.some(
						(event) => event.kind === "flip-start",
					) ?? false,
			),
		)
		.toBe(true);
	const soundButton = page.getByRole("button", {
		name: "배경음악과 카드 소리 끄기",
	});
	await soundButton.click();
	const audio = await page.evaluate(() => window.__tarotAudioEvents ?? []);
	const flipStart = audio.find((event) => event.kind === "flip-start");
	expect(flipStart?.bgmPlaying).toBe(true);
	expect(audio.some((event) => event.kind === "bgm-autoplay-blocked")).toBe(
		true,
	);
	expect(
		audio.some((event) => event.kind === "bgm-play" && event.volume === 0.42),
	).toBe(true);
	expect(audio.some((event) => event.kind === "bgm-pause")).toBe(true);
	expect(audio.some((event) => event.kind === "flip-stop-now")).toBe(true);
	await page.evaluate(() => {
		const ask = window.__tarotLastAsk!;
		window.parent.postMessage(
			{
				type: "naia-cafelua-tarot:response",
				id: ask.id,
				text: "",
				error: "The test provider is unavailable.",
			},
			window.location.origin,
		);
	});
	await expect(page.getByRole("alert")).toContainText(
		"나이아의 답이 도착하지 않았어요",
	);
	await page.screenshot({
		path: resolve(shotsDir, "reading-error-ko.png"),
		fullPage: true,
	});
	await page.evaluate(() => {
		window.__tarotReplyMode = "success";
	});
	await page.getByRole("button", { name: "다시 요청" }).click();
	await expect(page.locator(".tarot-naia-reply")).toContainText(
		"Naia sees a new path opening",
	);
	await page.screenshot({
		path: resolve(shotsDir, "reading-retry-ko.png"),
		fullPage: true,
	});

	await page.getByRole("tab", { name: "카드 보기" }).click();
	await page.locator(".tarot-card-index button").first().click();
	await expect(page.getByRole("heading", { name: "광대" })).toBeVisible();
	await page.screenshot({
		path: resolve(shotsDir, "card-gallery-ko.png"),
		fullPage: true,
	});
	await page.getByRole("tab", { name: "소설" }).click();
	await expect(
		page.getByRole("heading", { name: "《알파의 첫 해》" }),
	).toBeVisible();
	await expect(
		page.getByText("Claude Fable 5.1", { exact: true }),
	).toBeVisible();
	await page.getByRole("button", { name: "Astra의 이야기" }).click();
	await expect(
		page.getByRole("heading", { name: "《아직 쓰지 않은 날들》" }),
	).toBeVisible();
	await page.screenshot({
		path: resolve(shotsDir, "stories-astra-ko.png"),
		fullPage: true,
	});

	await page.evaluate(() =>
		window.parent.postMessage(
			{ type: "naia-app:locale", locale: "fr" },
			window.location.origin,
		),
	);
	await expect(page.getByText(/affichés en anglais/)).toBeVisible();
	await page.setViewportSize({ width: 390, height: 844 });
	await expect
		.poll(() => page.evaluate(() => document.documentElement.scrollWidth))
		.toBeLessThanOrEqual(390);
	await page.screenshot({
		path: resolve(shotsDir, "stories-narrow-fr.png"),
		fullPage: true,
	});
	const audioEvents = await page.evaluate(
		() => window.__tarotAudioEvents ?? [],
	);
	writeFileSync(
		resolve(shotsDir, "audio-events.json"),
		JSON.stringify(audioEvents, null, 2),
	);
	const bgmStart = audioEvents.find((event) => event.kind === "bgm-play");
	const recordedFlipStart = audioEvents.find(
		(event) => event.kind === "flip-start",
	);
	const bgmPause = audioEvents.find((event) => event.kind === "bgm-pause");
	const flipStop = audioEvents.find(
		(event) =>
			event.kind === "flip-stop-now" &&
			event.at >= (bgmPause?.at ?? Number.POSITIVE_INFINITY),
	);
	writeFileSync(
		resolve(shotsDir, "audio-verification.md"),
		[
			"# Tarot sound check",
			"",
			"Browser instrumentation recorded the actual app media and Web Audio calls (times are milliseconds from page navigation).",
			"",
			`- Autoplay was blocked before a user gesture: ${audioEvents.some((event) => event.kind === "bgm-autoplay-blocked") ? "yes" : "no"}.`,
			`- BGM started at ${bgmStart?.at ?? "not recorded"} ms, with volume ${bgmStart?.volume ?? "not recorded"}.`,
			`- Card cue started at ${recordedFlipStart?.at ?? "not recorded"} ms while BGM was ${recordedFlipStart?.bgmPlaying ? "playing" : "not confirmed playing"}.`,
			`- Shared mute paused BGM at ${bgmPause?.at ?? "not recorded"} ms and stopped the card cue at ${flipStop?.at ?? "not recorded"} ms.`,
			"- Raw event sequence: audio-events.json.",
			"",
		].join("\n"),
	);
});
