import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
	await page.route(/^https?:\/\//, (route) => {
		const host = new URL(route.request().url()).hostname;
		return host === "localhost" || host === "127.0.0.1"
			? route.continue()
			: route.abort();
	});
});

// Run with VITE_NAIA_KIOSK_DEMO=1 in web mode. Only synthetic credentials are used.
test("S3 missing build credential stops even with a previous login", async ({
	page,
}) => {
	await page.addInitScript(() => {
		localStorage.setItem("naia-remote-key", "test-personal-fixture-only");
	});
	await page.goto(process.env.S3_MISSING_KEY_URL || "http://localhost:1433");
	await expect(page.getByRole("alert")).toHaveText("시연 열쇠 없음");
	await expect(
		page.getByRole("button", { name: "들어가기", exact: true }),
	).toBeDisabled();
	await expect(page.locator(".chat-area")).toHaveCount(0);
});

test("S3 fresh browser prepares Jina, enters by keyboard and speaks once", async ({
	page,
}, testInfo) => {
	await page.setViewportSize({ width: 360, height: 780 });
	await page.addInitScript(() => {
		const spoken: string[] = [];
		Object.defineProperty(window, "__s3Spoken", { value: spoken });
		Object.defineProperty(window, "speechSynthesis", {
			value: {
				getVoices: () => [],
				cancel: () => {},
				pause: () => {},
				resume: () => {},
				addEventListener: () => {},
				removeEventListener: () => {},
				speak: (utterance: SpeechSynthesisUtterance) => {
					spoken.push(utterance.text);
					utterance.onstart?.(new Event("start") as SpeechSynthesisEvent);
					setTimeout(
						() => utterance.onend?.(new Event("end") as SpeechSynthesisEvent),
						20,
					);
				},
			},
		});
	});
	await page.goto("/");
	const enter = page.getByRole("button", { name: "들어가기", exact: true });
	await expect(enter).toBeEnabled();
	await expect(
		page.getByRole("heading", { name: "지나와 이야기해 보세요" }),
	).toBeVisible();
	await expect(page.getByRole("button", { name: "처음으로" })).toBeEnabled();
	expect(
		await page.evaluate(
			() => (window as unknown as { __s3Spoken: string[] }).__s3Spoken.length,
		),
	).toBe(0);
	const before = await page.evaluate(() =>
		JSON.parse(localStorage.getItem("naia-config") || "{}"),
	);
	expect(before).toMatchObject({
		agentName: "지나",
		userName: "게스트",
		honorific: "님",
		speechStyle: "formal",
		onboardingComplete: true,
		ttsProvider: "naia-local-voice",
		vllmTtsHost: "https://bc250-0-voice.nextain.io",
		ttsVoice: "naia-default",
	});
	const box = await enter.boundingBox();
	expect(box).toBeTruthy();
	expect(box!.x).toBeGreaterThanOrEqual(0);
	expect(box!.x + box!.width).toBeLessThanOrEqual(360);
	await page.screenshot({ path: testInfo.outputPath("entry-360.png") });
	await enter.focus();
	await page.keyboard.press("Enter");
	await expect(page.locator(".kiosk-entry")).toHaveCount(0);
	await expect
		.poll(
			() =>
				page.evaluate(
					() =>
						(window as unknown as { __s3Spoken: string[] }).__s3Spoken.filter(
							(text) => text.includes("게스트님, 안녕하세요"),
						).length,
				),
			{ timeout: 60_000 },
		)
		.toBe(1);
	await expect(page.getByText(/게스트님, 안녕하세요/).first()).toBeVisible();
	await expect(page.getByTestId("onboarding")).toHaveCount(0);
});

test("S3 preparation progress and failure are safe and retryable", async ({
	page,
}) => {
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	let first = true;
	await page.route("**/web-adk/*.json", async (route) => {
		if (!first) return route.continue();
		first = false;
		await pending;
		return route.fulfill({ status: 503, body: "unavailable" });
	});
	await page.goto("/");
	await expect(page.getByRole("status")).toContainText("준비");
	await expect(
		page.getByRole("button", { name: "들어가기", exact: true }),
	).toBeDisabled();
	release();
	await expect(page.getByRole("alert")).toContainText("다시 시도");
	await page.getByRole("button", { name: "다시 시도" }).click();
	await expect(
		page.getByRole("button", { name: "들어가기", exact: true }),
	).toBeEnabled();
	await expect(page.locator(".chat-area")).toHaveCount(0);
});

test("integrated kiosk searches knowledge, recalls after reload and resets the visitor", async ({
	page,
}) => {
	const question = "넥스테인은 뭘 하는 회사예요?";
	const requests: {
		messages: { role: string; content: string }[];
		tools?: { function: { name: string } }[];
	}[] = [];
	let toolSeen = false;
	await page.route("**/chat/completions", async (route) => {
		const req = route.request().postDataJSON();
		requests.push(req);
		const last = req.messages.at(-1);
		let delta: unknown;
		let finish = "stop";
		if (last.role === "tool") {
			const result = JSON.parse(last.content);
			expect(result.hits.length).toBeGreaterThan(0);
			toolSeen = true;
			delta = {
				content:
					"게스트님, 넥스테인은 나이아를 만드는 AI 회사입니다. 공개 지식을 검색해 안내해 드렸어요.",
			};
		} else if (last.role === "user" && last.content.includes(question)) {
			expect(
				req.tools.some(
					(t: { function: { name: string } }) =>
						t.function.name === "skill_knowledge_search",
				),
			).toBe(true);
			delta = {
				tool_calls: [
					{
						index: 0,
						id: "int-knowledge",
						type: "function",
						function: {
							name: "skill_knowledge_search",
							arguments: JSON.stringify({ query: question }),
						},
					},
				],
			};
			finish = "tool_calls";
		} else {
			delta = { content: "게스트님, 앞 대화를 기억하고 있어요." };
		}
		await route.fulfill({
			contentType: "text/event-stream",
			body: `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`,
		});
	});
	await page.goto("/");
	await expect(
		page.getByRole("button", { name: "들어가기", exact: true }),
	).toBeEnabled();
	await page.screenshot({
		path: "/home/nextain/work/codex-runs/kiosk-demo/tmp/int-entry.png",
	});
	await page.getByRole("button", { name: "들어가기", exact: true }).click();
	await expect(page.getByText(/게스트님, 안녕하세요/).first()).toBeVisible();
	await page.locator("textarea.chat-input").fill(question);
	await page.locator("textarea.chat-input").press("Enter");
	await expect(
		page.getByText(/공개 지식을 검색해 안내해 드렸어요/).first(),
	).toBeVisible();
	expect(toolSeen).toBe(true);
	await expect(page.locator(".splash-screen")).toHaveCount(0);
	await page.screenshot({
		path: "/home/nextain/work/codex-runs/kiosk-demo/tmp/int-knowledge.png",
	});
	await page.reload();
	await page.getByRole("button", { name: "들어가기", exact: true }).click();
	await expect(page.locator("textarea.chat-input")).toBeEnabled();
	await page.locator("textarea.chat-input").fill("앞 대화를 기억하나요?");
	await page.locator("textarea.chat-input").press("Enter");
	await expect(
		page.getByText("게스트님, 앞 대화를 기억하고 있어요.").first(),
	).toBeVisible();
	const recalled = requests
		.at(-1)!
		.messages.filter((m) => m.role === "system")
		.map((m) => m.content)
		.join("\n");
	expect(recalled).toContain("게스트님");
	expect(recalled).toContain(question);
	await page.getByRole("button", { name: "처음으로", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "지나와 이야기해 보세요" }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "들어가기", exact: true }),
	).toBeEnabled();
	await page.screenshot({
		path: "/home/nextain/work/codex-runs/kiosk-demo/tmp/int-reset.png",
	});
	await Promise.all([
		page.waitForEvent("load"),
		page.getByRole("button", { name: "처음으로", exact: true }).click(),
	]);
	await page.getByRole("button", { name: "들어가기", exact: true }).click();
	await page.locator("textarea.chat-input").fill("새 방문자예요");
	await page.locator("textarea.chat-input").press("Enter");
	await expect.poll(() => requests.length).toBeGreaterThan(3);
	const fresh = requests
		.at(-1)!
		.messages.filter((m) => m.role === "system")
		.map((m) => m.content)
		.join("\n");
	expect(fresh).toContain("게스트님");
	expect(fresh).not.toContain(question);
});

test("S5 kiosk routes Jina speech to BC250 voice host, syncs mouth on WAV playback, and falls back to browser TTS on failure", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.addInitScript(() => {
		const state = {
			audioContextResumedOnGesture: false,
			wavPlayCount: 0,
			browserSpoken: [] as string[],
		};
		Object.defineProperty(window, "__s5VoiceState", { value: state });
		const OrigAudioContext =
			window.AudioContext ||
			(window as unknown as { webkitAudioContext: typeof AudioContext })
				.webkitAudioContext;
		if (OrigAudioContext) {
			const origResume = OrigAudioContext.prototype.resume;
			OrigAudioContext.prototype.resume = function () {
				state.audioContextResumedOnGesture = true;
				return origResume ? origResume.call(this) : Promise.resolve();
			};
		}
		const OrigAudio = window.Audio;
		window.Audio = class extends OrigAudio {
			constructor(src?: string) {
				super(src);
				if (src?.startsWith("data:audio/wav;base64,")) {
					this.play = async () => {
						state.wavPlayCount += 1;
						this.onplay?.(new Event("play"));
						setTimeout(() => this.onended?.(new Event("ended")), 120);
					};
				}
			}
		} as typeof Audio;
		Object.defineProperty(window, "speechSynthesis", {
			value: {
				getVoices: () => [],
				cancel: () => {},
				pause: () => {},
				resume: () => {},
				addEventListener: () => {},
				removeEventListener: () => {},
				speak: (utterance: SpeechSynthesisUtterance) => {
					state.browserSpoken.push(utterance.text);
					utterance.onstart?.(new Event("start") as SpeechSynthesisEvent);
					setTimeout(
						() => utterance.onend?.(new Event("end") as SpeechSynthesisEvent),
						50,
					);
				},
			},
		});
	});

	// Build a minimal valid 24kHz mono 16-bit RIFF/WAVE buffer (2400 samples = 0.1s)
	const sampleRate = 24000;
	const numSamples = 2400;
	const wavBuf = Buffer.alloc(44 + numSamples * 2);
	wavBuf.write("RIFF", 0);
	wavBuf.writeUInt32LE(36 + numSamples * 2, 4);
	wavBuf.write("WAVE", 8);
	wavBuf.write("fmt ", 12);
	wavBuf.writeUInt32LE(16, 16);
	wavBuf.writeUInt16LE(1, 20);
	wavBuf.writeUInt16LE(1, 22);
	wavBuf.writeUInt32LE(sampleRate, 24);
	wavBuf.writeUInt32LE(sampleRate * 2, 28);
	wavBuf.writeUInt16LE(2, 32);
	wavBuf.writeUInt16LE(16, 34);
	wavBuf.write("data", 36);
	wavBuf.writeUInt32LE(numSamples * 2, 40);

	const bc250Calls: { url: string; body: Record<string, unknown> }[] = [];
	let shouldFailBc250 = false;
	await page.route("https://bc250-0-voice.nextain.io/v1/audio/speech", async (route) => {
		const body = route.request().postDataJSON();
		bc250Calls.push({ url: route.request().url(), body });
		if (shouldFailBc250) {
			await route.fulfill({
				status: 401,
				contentType: "application/json",
				body: JSON.stringify({ error: "local_access_denied" }),
			});
			return;
		}
		await route.fulfill({
			status: 200,
			contentType: "audio/wav",
			body: wavBuf,
		});
	});

	await page.route("**/chat/completions", async (route) => {
		await route.fulfill({
			contentType: "text/event-stream",
			body: `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "게스트님, 반갑습니다. 무엇이든 물어보세요." }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
		});
	});

	await page.goto("/");
	const enter = page.getByRole("button", { name: "들어가기", exact: true });
	await expect(enter).toBeEnabled();
	await enter.click();

	await expect
		.poll(() => bc250Calls.length, { timeout: 15_000 })
		.toBeGreaterThanOrEqual(1);
	expect(bc250Calls[0].body).toMatchObject({
		model: "voxcpm2",
		voice: "default",
	});

	await expect
		.poll(
			() =>
				page.evaluate(
					() =>
						(
							window as unknown as {
								__s5VoiceState: {
									audioContextResumedOnGesture: boolean;
									wavPlayCount: number;
								};
							}
						).__s5VoiceState,
				),
			{ timeout: 15_000 },
		)
		.toMatchObject({
			audioContextResumedOnGesture: true,
			wavPlayCount: 1,
		});

	// Now simulate BC250 returning an error/unavailable and verify fallback to browser TTS without freezing
	shouldFailBc250 = true;
	await page.locator("textarea.chat-input").fill("안녕하세요");
	await page.locator("textarea.chat-input").press("Enter");
	await expect(
		page.getByText(/게스트님, 반갑습니다. 무엇이든 물어보세요\./).first(),
	).toBeVisible();
	await expect
		.poll(
			() =>
				page.evaluate(
					() =>
						(
							window as unknown as {
								__s5VoiceState: { browserSpoken: string[] };
							}
						).__s5VoiceState.browserSpoken.some((t) =>
							t.includes("게스트님, 반갑습니다"),
						),
				),
			{ timeout: 15_000 },
		)
		.toBe(true);
});
