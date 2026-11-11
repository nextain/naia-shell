import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import ts from "typescript";

const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));
const CHROMAKEY_GL_PATH = path.resolve(
	E2E_DIR,
	"../src/lib/avatar/nva-chromakey-gl.ts",
);
const STACKED_ALPHA_GL_PATH = path.resolve(
	E2E_DIR,
	"../src/lib/avatar/nva-stacked-alpha-gl.ts",
);

function transpileAvatarModule(filePath: string): string {
	const source = fs.readFileSync(filePath, "utf8");
	return ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2020,
		},
	}).outputText;
}

test.beforeEach(async ({ page }) => {
	await page.route(
		/^https?:\/\/(?!(?:localhost|127\.0\.0\.1)(?::|\/|$))/,
		(route) => route.abort(),
	);
	await page.route("**/v1/profile/balance", async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ credits: 100 }),
		});
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

test("S3 gateway key rejected or exhausted credits shows unavailable notice", async ({
	page,
}) => {
	await page.route("**/v1/profile/balance", async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ credits: 0 }),
		});
	});
	await page.goto("/");
	await expect(
		page.getByRole("heading", { name: "지금은 시연을 잠시 쉬고 있어요" }),
	).toBeVisible();
	await expect(page.getByRole("alert")).toContainText(
		"오늘 준비한 시연 사용량을 다 썼어요.",
	);
	await expect(page.getByRole("alert")).toContainText(
		"잠시 뒤 다시 들어와 주세요.",
	);
	await expect(page.getByRole("alert")).not.toContainText("부스 직원");
	await expect(
		page.getByRole("button", { name: "들어가기", exact: true }),
	).toHaveCount(0);
	await expect(page.locator(".chat-area")).toHaveCount(0);
});

// speechSynthesis is mocked here to deterministically verify utterance invocation;
// real browser audio autoplay verification belongs to S5.
test("S3 fresh browser prepares Jina, enters by keyboard and speaks once (mock speechSynthesis)", async ({
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
		ttsProvider: "nextain",
		ttsVoice: "ko-KR-Neural2-A",
		avatarProvider: "naia-video-avatar",
		nvaModel: "jina",
	});
	const box = await enter.boundingBox();
	expect(box).toBeTruthy();
	expect(box!.x).toBeGreaterThanOrEqual(0);
	expect(box!.x + box!.width).toBeLessThanOrEqual(360);
	await page.screenshot({ path: testInfo.outputPath("entry-360.png") });
	await enter.focus();
	await page.keyboard.press("Enter");
	await expect(page.locator(".kiosk-entry")).toHaveCount(0);
	await expect(page.locator('[data-video-avatar][data-nva-model="jina"]')).toBeVisible();
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
}, testInfo) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	const question = "넥스테인은 뭘 하는 회사예요?";
	const longAnswer =
		"게스트님, 넥스테인은 나이아를 만드는 AI 회사입니다. 공개 지식을 검색해 안내해 드렸어요. 나이아는 비주얼 에이전트 데스크톱 셸과 웹 시연 환경을 함께 제공하며, 방문자께서 궁금하신 제품 철학과 성장 지표를 출처 기반으로 친절하게 설명해 드립니다.";
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
				content: longAnswer,
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
		path: testInfo.outputPath("s4-entry.png"),
	});
	await page.getByRole("button", { name: "들어가기", exact: true }).click();
	await expect(page.getByText(/게스트님, 안녕하세요/).first()).toBeVisible();
	const avatarEl = page.locator('[data-video-avatar][data-nva-model="jina"]');
	await expect(avatarEl).toBeVisible();
	await expect(avatarEl).toHaveAttribute("data-video-avatar-loaded", "true");
	await page.locator("textarea.chat-input").fill(question);
	await page.locator("textarea.chat-input").press("Enter");
	const answerLocator = page.getByText(/공개 지식을 검색해 안내해 드렸어요/).first();
	await expect(answerLocator).toBeVisible();
	expect(toolSeen).toBe(true);
	await expect(page.locator(".splash-screen")).toHaveCount(0);
	await expect(page.locator(".cost-badge")).toHaveCount(0);

	// Verify widened chat window and unclipped long answer
	const chatWrapperBox = await page.locator(".naia-chat-wrapper").boundingBox();
	const messagesBox = await page.locator(".chat-messages").boundingBox();
	const answerBox = await answerLocator.boundingBox();
	expect(chatWrapperBox).toBeTruthy();
	expect(messagesBox).toBeTruthy();
	expect(answerBox).toBeTruthy();
	expect(chatWrapperBox!.width).toBeGreaterThanOrEqual(480);
	expect(chatWrapperBox!.height).toBeGreaterThanOrEqual(450);
	expect(answerBox!.y).toBeGreaterThanOrEqual(messagesBox!.y);
	expect(answerBox!.y + answerBox!.height).toBeLessThanOrEqual(
		messagesBox!.y + messagesBox!.height + 2,
	);
	const overflowY = await page
		.locator(".chat-messages")
		.evaluate((el) => getComputedStyle(el).overflowY);
	expect(overflowY).toBe("auto");

	// Wait briefly for video avatar canvas to paint non-empty frame
	await expect
		.poll(() =>
			page.evaluate(() => {
				const c = document.querySelector<HTMLCanvasElement>(
					"[data-video-avatar-prebaked]",
				);
				if (!c || c.width === 0 || c.height === 0) return false;
				const ctx = c.getContext("2d");
				if (!ctx) return true;
				const data = ctx.getImageData(
					Math.floor(c.width / 2),
					Math.floor(c.height / 3),
					1,
					1,
				).data;
				return data[3] > 0;
			}),
		)
		.toBe(true);

	await page.screenshot({
		path: testInfo.outputPath("s4-chat.png"),
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
	expect(recalled).toContain("공개 지식을 검색해 안내해 드렸어요");
	await page.getByRole("button", { name: "처음으로", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "지나와 이야기해 보세요" }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "들어가기", exact: true }),
	).toBeEnabled();
	const afterReset = await page.evaluate(async () => {
		const key = localStorage.getItem("naia-remote-key");
		let jsonlCount = 0;
		try {
			const root = await navigator.storage.getDirectory();
			const ws = await root.getDirectoryHandle("naia-workspace");
			const conv = await ws.getDirectoryHandle("conversations-guest");
			for await (const [name] of (
				conv as unknown as {
					entries: () => AsyncIterable<[string, FileSystemHandle]>;
				}
			).entries()) {
				if (name.endsWith(".jsonl")) jsonlCount++;
			}
		} catch {
			jsonlCount = 0;
		}
		return { hasRemoteKey: Boolean(key), jsonlCount };
	});
	expect(afterReset.hasRemoteKey).toBe(true);
	expect(afterReset.jsonlCount).toBe(0);
	await page.screenshot({
		path: testInfo.outputPath("int-reset.png"),
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

test("S5 kiosk routes Jina speech to gateway voice (ko-KR-Neural2-A), syncs mouth on WAV playback, and falls back to browser TTS on failure", async ({
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

	const gatewaySpeechCalls: {
		url: string;
		authHeader: string | undefined;
		body: Record<string, unknown>;
	}[] = [];
	let shouldFailGatewaySpeech = false;
	await page.route("**/v1/audio/speech", async (route) => {
		const body = route.request().postDataJSON();
		gatewaySpeechCalls.push({
			url: route.request().url(),
			authHeader: route.request().headers()["x-anyllm-key"],
			body,
		});
		if (shouldFailGatewaySpeech) {
			await route.fulfill({
				status: 401,
				contentType: "application/json",
				body: JSON.stringify({ error: "gateway_speech_unavailable" }),
			});
			return;
		}
		if (body && typeof body === "object" && "audio_encoding" in body) {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					audio_content: wavBuf.toString("base64"),
				}),
			});
			return;
		}
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ audio_content: wavBuf.toString("base64") }),
		});
	});

	const unitsCalls: Record<string, unknown>[] = [];
	await page.route("**/v1/studio/speech-plan/units", async (route) => {
		const body = route.request().postDataJSON();
		unitsCalls.push(body);
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				words: [
					{
						word: "게스트님",
						char_start: 0,
						char_end: 4,
						units: ["velar", "vowel-mid", "alveolar", "vowel-spread", "alveolar"],
					},
					{
						word: "안녕하세요",
						char_start: 5,
						char_end: 10,
						units: ["vowel-open", "alveolar", "palatal", "vowel-mid", "vowel-round"],
					},
				],
			}),
		});
	});

	const loadedClipUrls: string[] = [];
	const loadedSpeechAssets: string[] = [];
	page.on("request", (req) => {
		const u = req.url();
		if (u.includes("/nva/jina/clips/")) loadedClipUrls.push(u);
		if (u.includes("/nva/jina/speech/")) loadedSpeechAssets.push(u);
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
		.poll(() => gatewaySpeechCalls.length, { timeout: 15_000 })
		.toBeGreaterThanOrEqual(1);
	expect(gatewaySpeechCalls[0].authHeader).toMatch(/^Bearer /);
	expect(gatewaySpeechCalls[0].body).toMatchObject({
		voice: "ko-KR-Neural2-A",
	});
	expect(String(gatewaySpeechCalls[0].body.input ?? "")).toContain(
		"게스트님, 안녕하세요",
	);

	// Verify initial greeting clip was loaded and played; with stacked_alpha the
	// renderer fetches clips/greeting.stacked.mp4 in place of clips/greeting.webm.
	await expect
		.poll(
			() =>
				loadedClipUrls.some((u) =>
					/\/nva\/jina\/clips\/greeting\.(webm|stacked\.mp4)$/.test(u),
				),
			{ timeout: 15_000 },
		)
		.toBe(true);

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

	// Verify background warmup of speech/atlas.bin and speech/atlas-index.json after greeting
	await expect
		.poll(
			() =>
				loadedSpeechAssets.some((u) => u.endsWith("/nva/jina/speech/atlas.bin")) &&
				loadedSpeechAssets.some((u) =>
					u.endsWith("/nva/jina/speech/atlas-index.json"),
				),
			{ timeout: 20_000 },
		)
		.toBe(true);

	// Now simulate gateway TTS returning an error/unavailable and verify fallback to browser TTS without freezing
	shouldFailGatewaySpeech = true;
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
	await expect
		.poll(() => unitsCalls.length, { timeout: 10_000 })
		.toBeGreaterThanOrEqual(1);
});

test("ADK explorer shows AGENTS.md at top & auto-opens once after entry, shows evidence line under replies, and exposes local PC answer toggle with 8GB notice", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	const question = "나이아는 어떤 서비스인가요?";
	const answer =
		"게스트님, 나이아는 개인이 일하고 노는 환경에서 듣고 말하고 기억하는 비주얼 에이전트입니다.\n\n근거: naia.md (기준일 2026-10-31)";
	const systemPrompts: string[] = [];

	await page.route("**/chat/completions", async (route) => {
		const req = route.request().postDataJSON();
		const sys = (req.messages ?? [])
			.filter((m: { role: string }) => m.role === "system")
			.map((m: { content: string }) => m.content)
			.join("\n");
		systemPrompts.push(sys);
		const last = req.messages.at(-1);
		let delta: unknown;
		let finish = "stop";
		if (last.role === "tool") {
			delta = { content: answer };
		} else if (last.role === "user" && last.content.includes(question)) {
			delta = {
				tool_calls: [
					{
						index: 0,
						id: "adk-tc-1",
						type: "function",
						function: {
							name: "skill_knowledge_ask",
							arguments: JSON.stringify({ query: question }),
						},
					},
				],
			};
			finish = "tool_calls";
		} else {
			delta = { content: answer };
		}
		await route.fulfill({
			contentType: "text/event-stream",
			body: `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`,
		});
	});

	await page.goto("/");
	const enter = page.getByRole("button", { name: "들어가기", exact: true });
	await expect(enter).toBeEnabled();
	await enter.click();

	await expect(page.getByText(/게스트님, 안녕하세요/).first()).toBeVisible();
	await expect(page.locator(".splash-screen")).toHaveCount(0);

	// 1. Explorer opens once after entry with AGENTS.md at top of tree and open in viewer
	const viewer = page.getByTestId("web-workspace-viewer");
	await expect(viewer).toBeVisible();
	await expect(viewer.locator(".web-workspace-viewer-bar code")).toHaveText(
		"AGENTS.md",
	);
	await expect(viewer).toContainText("AGENTS.md — 지나 (Jina) ADK 하네스 지침");

	const rootTreeItems = page.locator(
		".web-workspace-tree > .web-workspace-list > li",
	);
	await expect(rootTreeItems.first()).toContainText("AGENTS.md");
	await expect(page.locator(".web-workspace-tree")).toContainText("persona");
	await expect(page.locator(".web-workspace-tree")).toContainText("memory");
	await expect(page.locator(".web-workspace-tree")).toContainText("knowledge");
	await expect(page.locator(".web-workspace-tree")).toContainText("rules");

	// Wait for avatar canvas to paint non-empty frame
	await expect
		.poll(() =>
			page.evaluate(() => {
				const c = document.querySelector<HTMLCanvasElement>(
					"[data-video-avatar-prebaked]",
				);
				if (!c || c.width === 0 || c.height === 0) return false;
				const ctx = c.getContext("2d");
				if (!ctx) return true;
				const data = ctx.getImageData(
					Math.floor(c.width / 2),
					Math.floor(c.height / 3),
					1,
					1,
				).data;
				return data[3] > 0;
			}),
		)
		.toBe(true);

	const captureDir = process.env.KIOSK_ADK_CAPTURE_DIR;
	if (captureDir) {
		await page.screenshot({ path: `${captureDir}/a-explorer.png` });
	}

	// 2. Ask a question -> verify AGENTS.md + persona + rules are in the actual system prompt, and evidence line is rendered below reply
	await page.locator("textarea.chat-input").fill(question);
	await page.locator("textarea.chat-input").press("Enter");
	await expect(
		page.getByText(/듣고 말하고 기억하는 비주얼 에이전트입니다/).first(),
	).toBeVisible();
	await expect(page.locator(".tool-activity-kiosk").last()).toContainText(
		"자료 찾음",
	);
	await expect(page.locator(".tool-activity-kiosk").last()).toContainText(
		"knowledge/naia.md",
	);

	expect(systemPrompts.at(-1)).toContain(
		"AGENTS.md — 지나 (Jina) ADK 하네스 지침",
	);
	expect(systemPrompts.at(-1)).toContain("지나 (Jina) — 페르소나 지침");
	expect(systemPrompts.at(-1)).toContain("대답 및 근거 규칙 (Response Rules)");

	const evidenceLines = page.getByTestId("chat-kiosk-evidence");
	const lastEvidence = evidenceLines.last();
	await expect(lastEvidence).toBeVisible();
	await expect(lastEvidence).toContainText("AGENTS.md");
	await expect(lastEvidence).toContainText("knowledge/naia.md");
	await expect(lastEvidence).toContainText("memory/guest-memory.md");

	// Clicking knowledge/naia.md chip opens knowledge/naia.md in the explorer viewer
	await lastEvidence
		.getByRole("button", { name: "knowledge/naia.md" })
		.click();
	await expect(viewer.locator(".web-workspace-viewer-bar code")).toHaveText(
		"naia.md",
	);
	await expect(viewer).toContainText("나이아 서비스 소개");

	if (captureDir) {
		await page.screenshot({ path: `${captureDir}/a-evidence.png` });
	}

	// 3. Local PC answer toggle: default OFF, shows 8GB hint, clicking without WebGPU shows notice
	const localToggle = page.getByTestId("kiosk-local-answer-toggle");
	await expect(localToggle).toBeVisible();
	await expect(localToggle).toHaveAttribute("aria-pressed", "false");
	await expect(page.getByTestId("kiosk-local-answer-hint")).toContainText(
		"그래픽 메모리 8GB 이상 기기에서만 됩니다",
	);
	await localToggle.click();
	await expect(page.getByTestId("kiosk-local-answer-notice")).toContainText(
		"그래픽 메모리 8GB 이상 기기에서만 됩니다",
	);

	if (captureDir) {
		await page.screenshot({ path: `${captureDir}/a-local.png` });
	}
});

test("S6 kiosk opens public IR slides on request, advances after narration, pauses for a mid-presentation question, and closes on stop", async ({
	page,
}, testInfo) => {
	test.setTimeout(120_000);
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.route("**/nva/*/speech/atlas.bin", (route) => route.abort());
	await page.addInitScript(() => {
		const spoken: string[] = [];
		const pendingSlide1Ends: Array<() => void> = [];
		const pendingSlide2Ends: Array<() => void> = [];
		const pendingQuestionEnds: Array<() => void> = [];
		let releaseSlide1 = false;
		let releaseSlide2 = false;

		const isSlide1Sentence = (text: string) =>
			text.includes("넥스테인 공개 발표를 시작할게요") ||
			text.includes("첫 장은 넥스테인의 출발과 비전이에요") ||
			text.includes("다음 세대 엔터테인먼트와 AI를 결합해");

		const isSlide2Sentence = (text: string) =>
			text.includes("두 번째 장은 브랜드와 모델 이름 체계예요") ||
			text.includes("나이아는 흐르는 물처럼");

		const isQuestionSentence = (text: string) =>
			text.includes("이어 가기를 누르시면 발표를 계속 들으실 수 있어요");

		Object.defineProperty(window, "__s6Spoken", { value: spoken });
		Object.defineProperty(window, "__s6ReleaseSlide1", {
			value: () => {
				releaseSlide1 = true;
				while (pendingSlide1Ends.length > 0) {
					const fn = pendingSlide1Ends.shift();
					fn?.();
				}
			},
		});
		Object.defineProperty(window, "__s6ReleaseSlide2", {
			value: () => {
				releaseSlide2 = true;
				while (pendingSlide2Ends.length > 0) {
					const fn = pendingSlide2Ends.shift();
					fn?.();
				}
			},
		});

		Object.defineProperty(window, "speechSynthesis", {
			value: {
				getVoices: () => [],
				cancel: () => {
					pendingSlide1Ends.length = 0;
					pendingSlide2Ends.length = 0;
					pendingQuestionEnds.length = 0;
				},
				pause: () => {},
				resume: () => {},
				addEventListener: () => {},
				removeEventListener: () => {},
				speak: (utterance: SpeechSynthesisUtterance) => {
					spoken.push(utterance.text);
					utterance.onstart?.(new Event("start") as SpeechSynthesisEvent);
					if (isSlide1Sentence(utterance.text) && !releaseSlide1) {
						pendingSlide1Ends.push(() => {
							setTimeout(
								() =>
									utterance.onend?.(new Event("end") as SpeechSynthesisEvent),
								15,
							);
						});
						return;
					}
					if (isSlide2Sentence(utterance.text) && !releaseSlide2) {
						pendingSlide2Ends.push(() => {
							setTimeout(
								() =>
									utterance.onend?.(new Event("end") as SpeechSynthesisEvent),
								15,
							);
						});
						return;
					}
					if (isQuestionSentence(utterance.text)) {
						pendingQuestionEnds.push(() => {
							setTimeout(
								() =>
									utterance.onend?.(new Event("end") as SpeechSynthesisEvent),
								15,
							);
						});
						return;
					}
					setTimeout(
						() => utterance.onend?.(new Event("end") as SpeechSynthesisEvent),
						20,
					);
				},
			},
		});
	});

	await page.route("**/chat/completions", async (route) => {
		const req = route.request().postDataJSON();
		const last = req.messages.at(-1);
		const content =
			typeof last?.content === "string" && last.content.includes("넥스테인")
				? "게스트님, 넥스테인은 비주얼 에이전트 데스크톱 셸 나이아를 만드는 AI 기술 기업입니다. 이어 가기를 누르시면 발표를 계속 들으실 수 있어요."
				: "게스트님, 질문에 답변드렸습니다.";
		await route.fulfill({
			contentType: "text/event-stream",
			body: `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
		});
	});

	await page.goto("/");
	const enter = page.getByRole("button", { name: "들어가기", exact: true });
	await expect(enter).toBeEnabled();
	await enter.click();
	await expect(page.getByText(/게스트님, 안녕하세요/).first()).toBeVisible();
	await expect(page.locator(".splash-screen")).toHaveCount(0);

	// Wait briefly for video avatar canvas to paint non-empty frame
	await expect
		.poll(() =>
			page.evaluate(() => {
				const c = document.querySelector<HTMLCanvasElement>(
					"[data-video-avatar-prebaked]",
				);
				if (!c || c.width === 0 || c.height === 0) return false;
				const ctx = c.getContext("2d");
				if (!ctx) return true;
				const data = ctx.getImageData(
					Math.floor(c.width / 2),
					Math.floor(c.height / 3),
					1,
					1,
				).data;
				return data[3] > 0;
			}),
		)
		.toBe(true);

	// 1. User requests IR presentation
	await page.locator("textarea.chat-input").fill("IR 발표해 줘");
	await page.locator("textarea.chat-input").press("Enter");

	const slidesApp = page.locator(".content-app__slot--active .slides-app");
	await expect(slidesApp).toBeVisible();
	const cardOverlay = slidesApp.getByTestId("slides-card-overlay");
	await expect(cardOverlay).toBeVisible();
	await expect(slidesApp.getByTestId("slides-card-title")).toHaveText(
		"넥스테인(Nextain)과 나이아의 출발",
	);
	await expect(slidesApp.locator(".slides-app__card-badge")).toHaveText(
		"IR 01 / 09",
	);
	await expect(slidesApp).toHaveAttribute("data-state", "presenting");

	// Verify 4 kiosk transport buttons are visible
	await expect(
		slidesApp.getByRole("button", { name: "이전", exact: true }),
	).toBeVisible();
	await expect(
		slidesApp.getByRole("button", { name: "멈춤", exact: true }),
	).toBeVisible();
	await expect(
		slidesApp.getByRole("button", { name: "다음", exact: true }),
	).toBeVisible();
	await expect(
		slidesApp.getByRole("button", { name: "끝내기", exact: true }),
	).toBeVisible();

	// Verify 2-column layout (Jina in normal spot on left above chat, slides filling right workspace) at 1280x800 and no text clipping
	const chatBox = await page.locator(".naia-chat-wrapper").boundingBox();
	const slidesBox = await slidesApp.boundingBox();
	const avatarBox = await page
		.locator("[data-video-avatar-prebaked]")
		.boundingBox();
	expect(chatBox).toBeTruthy();
	expect(slidesBox).toBeTruthy();
	expect(avatarBox).toBeTruthy();
	expect(chatBox!.x + chatBox!.width).toBeLessThanOrEqual(slidesBox!.x + 4);
	expect(slidesBox!.width).toBeGreaterThanOrEqual(700);
	expect(avatarBox!.x).toBeLessThan(slidesBox!.x);

	const cardClipCheck = await cardOverlay.evaluate((el) => ({
		overflowY: el.scrollHeight > el.clientHeight + 2,
		overflowX: el.scrollWidth > el.clientWidth + 2,
	}));
	expect(cardClipCheck).toEqual({ overflowY: false, overflowX: false });

	// Wait for Slide 1 narration to start speaking
	await expect
		.poll(
			() =>
				page.evaluate(() => {
					const s = (window as unknown as { __s6Spoken: string[] }).__s6Spoken;
					return (
						s.some((t) => t.includes("넥스테인 공개 발표를 시작할게요")) &&
						s.some((t) => t.includes("비주얼 AI 동반자 나이아를 만들고 있어요"))
					);
				}),
			{ timeout: 15_000 },
		)
		.toBe(true);

	const captureDir = process.env.KIOSK_SLIDES_CAPTURE_DIR;
	await page.screenshot({
		path: captureDir ? `${captureDir}/s-open.png` : testInfo.outputPath("s-open.png"),
	});

	// 2. Finish Slide 1 speech and verify automatic advance to Slide 2
	await page.evaluate(() => {
		(window as unknown as { __s6ReleaseSlide1: () => void }).__s6ReleaseSlide1();
	});

	await expect(slidesApp.locator(".slides-app__card-badge")).toHaveText(
		"IR 02 / 09",
		{ timeout: 15_000 },
	);
	await expect(slidesApp.getByTestId("slides-card-title")).toHaveText(
		"브랜드 체계: 나이아와 별자리 모델 이름",
	);
	await expect(slidesApp).toHaveAttribute("data-state", "presenting");
	await expect
		.poll(
			() =>
				page.evaluate(() =>
					(window as unknown as { __s6Spoken: string[] }).__s6Spoken.some((t) =>
						t.includes("두 번째 장은 브랜드와 모델 이름 체계예요"),
					),
				),
			{ timeout: 15_000 },
		)
		.toBe(true);

	await page.screenshot({
		path: captureDir ? `${captureDir}/s-next.png` : testInfo.outputPath("s-next.png"),
	});

	// 3. Ask a mid-presentation question -> pauses presentation in "answering" state, answers, then resumes
	await page.locator("textarea.chat-input").fill("넥스테인은 어떤 회사야?");
	await page.locator("textarea.chat-input").press("Enter");

	await expect(slidesApp).toHaveAttribute("data-state", "answering");
	await expect(
		slidesApp.getByRole("button", { name: "이어 가기", exact: true }),
	).toBeVisible();
	await expect(
		page
			.getByText(/넥스테인은 비주얼 에이전트 데스크톱 셸 나이아를 만드는 AI 기술 기업입니다/)
			.first(),
	).toBeVisible();
	await page.locator(".chat-messages").evaluate((el) => {
		el.scrollTop = el.scrollHeight;
	});

	await page.screenshot({
		path: captureDir
			? `${captureDir}/s-question.png`
			: testInfo.outputPath("s-question.png"),
	});

	// Resume presentation
	await slidesApp.getByRole("button", { name: "이어 가기", exact: true }).click();
	await expect(slidesApp).toHaveAttribute("data-state", "presenting");

	// 4. End presentation -> closes Slides app
	await slidesApp.getByRole("button", { name: "끝내기", exact: true }).click();
	await expect(page.locator(".content-app__slot--active .slides-app")).toHaveCount(0);
});

test("mobile portrait (390x844) keeps Jina head visible, compact header toggles, and stationary avatar when dragging sheet", async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.addInitScript(() => {
		Object.defineProperty(window, "speechSynthesis", {
			value: {
				getVoices: () => [],
				cancel: () => {},
				pause: () => {},
				resume: () => {},
				addEventListener: () => {},
				removeEventListener: () => {},
				speak: (utterance: SpeechSynthesisUtterance) => {
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
	await enter.click();
	await expect(page.getByText(/게스트님, 안녕하세요/).first()).toBeVisible();

	const avatarCanvas = page.locator("[data-video-avatar-prebaked]");
	await expect(avatarCanvas).toBeVisible();

	// Wait for canvas to render non-empty avatar pixels
	await expect
		.poll(() =>
			page.evaluate(() => {
				const c = document.querySelector<HTMLCanvasElement>(
					"[data-video-avatar-prebaked]",
				);
				if (!c || c.width === 0 || c.height === 0) return false;
				const ctx = c.getContext("2d");
				if (!ctx) return true;
				const data = ctx.getImageData(
					Math.floor(c.width / 2),
					Math.floor(c.height / 5),
					1,
					1,
				).data;
				return data[3] > 0;
			}),
		)
		.toBe(true);

	const avatarBefore = await avatarCanvas.boundingBox();
	const layerBefore = await page.locator(".avatar-canvas-layer").boundingBox();
	expect(avatarBefore).toBeTruthy();
	expect(layerBefore).toBeTruthy();
	// Top of avatar canvas must be inside upper screen area (>= 0), not clipped at negative y
	expect(avatarBefore!.y).toBeGreaterThanOrEqual(0);
	expect(avatarBefore!.y).toBeLessThanOrEqual(60);

	// Compact chat header & gesture toggles on mobile portrait
	const headerBox = await page.locator(".chat-header").boundingBox();
	expect(headerBox).toBeTruthy();
	expect(headerBox!.height).toBeLessThanOrEqual(40);

	// Drag mobile conversation sheet handle up and verify avatar stays completely stationary
	const handle = page.locator(".web-mobile-sheet-handle");
	await expect(handle).toBeVisible();
	const handleBox = await handle.boundingBox();
	expect(handleBox).toBeTruthy();

	const startX = handleBox!.x + handleBox!.width / 2;
	const startY = handleBox!.y + handleBox!.height / 2;
	await page.mouse.move(startX, startY);
	await page.mouse.down();
	await page.mouse.move(startX, startY - 180, { steps: 5 });

	const avatarDuringDrag = await avatarCanvas.boundingBox();
	expect(avatarDuringDrag).toEqual(avatarBefore);

	await page.mouse.up();
	await expect(page.locator(".naia-chat-area")).toHaveAttribute(
		"data-mobile-sheet",
		"expanded",
	);

	const avatarAfterDrag = await avatarCanvas.boundingBox();
	const layerAfterDrag = await page
		.locator(".avatar-canvas-layer")
		.boundingBox();
	expect(avatarAfterDrag).toEqual(avatarBefore);
	expect(layerAfterDrag).toEqual(layerBefore);
});

test("fix7g GPU WebGL shaders: preserves connected 2x20 thin lines, removes detached islands, restores holes position-invariantly, preserves baked stacked alpha and 2px lines at 128/720/1440, and retains fix7f crown/anime/skirt fixes", async ({
	page,
}) => {
	const chromakeyCjs = transpileAvatarModule(CHROMAKEY_GL_PATH);
	const stackedAlphaCjs = transpileAvatarModule(STACKED_ALPHA_GL_PATH);

	await page.goto("about:blank");

	const gpuResults = await page.evaluate(
		({ chromakeyCode, stackedCode }) => {
			function loadCjs<T>(code: string): T {
				const exportsObj: Record<string, unknown> = {};
				const moduleObj = { exports: exportsObj };
				const fn = new Function("exports", "module", code);
				fn(exportsObj, moduleObj);
				return moduleObj.exports as T;
			}

			const { NvaChromakeyGL } = loadCjs<{
				NvaChromakeyGL: new (opts?: {
					mode?: "chromakey" | "alpha-repair";
					keyColor?: string;
					threshold?: number;
					smoothness?: number;
					despill?: number;
				}) => {
					process: (
						source: TexImageSource,
						width: number,
						height: number,
					) => HTMLCanvasElement;
					dispose: () => void;
				};
			}>(chromakeyCode);

			const { NvaStackedAlphaGL } = loadCjs<{
				NvaStackedAlphaGL: new (canvas: HTMLCanvasElement) => {
					draw: (
						video: HTMLVideoElement | HTMLCanvasElement,
						videoWidth: number,
						videoHeight: number,
					) => void;
					dispose: () => void;
				};
			}>(stackedCode);

			const defaultParams = {
				mode: "alpha-repair" as const,
				keyColor: "#00b8e6",
				threshold: 0.16,
				smoothness: 0.08,
				despill: 0.14,
			};

			const sharedKeyer = new NvaChromakeyGL(defaultParams);

			function runChromakey(
				width: number,
				height: number,
				paint: (ctx: CanvasRenderingContext2D) => void,
			) {
				const src = document.createElement("canvas");
				src.width = width;
				src.height = height;
				const sctx = src.getContext("2d")!;
				paint(sctx);

				const glCanvas = sharedKeyer.process(src, width, height);
				const gl = glCanvas.getContext("webgl2")!;
				const glBuf = new Uint8Array(width * height * 4);
				gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, glBuf);

				const out = document.createElement("canvas");
				out.width = width;
				out.height = height;
				const octx = out.getContext("2d")!;
				octx.drawImage(glCanvas, 0, 0);

				return {
					pixel(x: number, y: number): [number, number, number, number] {
						const d = octx.getImageData(x, y, 1, 1).data;
						return [d[0], d[1], d[2], d[3]];
					},
					glPixel(x: number, y: number): [number, number, number, number] {
						const row = height - 1 - y;
						const idx = (row * width + x) * 4;
						return [
							glBuf[idx],
							glBuf[idx + 1],
							glBuf[idx + 2],
							glBuf[idx + 3],
						];
					},
				};
			}

			// 1. Connected 2x20px thin vertical lines attached to 22x10px opaque blocks
			// tested at y=10, y=45, y=100, y=170 + detached 2x2 islands at y=45, y=140
			const lineScene = runChromakey(128, 256, (ctx) => {
				ctx.clearRect(0, 0, 128, 256);
				ctx.fillStyle = "rgba(20, 20, 25, 1)";
				const blockTops = [0, 30, 85, 155];
				for (const topY of blockTops) {
					// 22x10 opaque block
					ctx.fillRect(53, topY, 22, 10);
					// 2x20 connected vertical line below block
					ctx.fillRect(63, topY + 10, 2, 20);
				}
				// Detached 2x2 small islands far from subject
				ctx.fillRect(18, 44, 2, 2);
				ctx.fillRect(108, 139, 2, 2);
			});

			const connectedLineAlpha = {
				y10: lineScene.pixel(63, 10)[3],
				y45: lineScene.pixel(63, 45)[3],
				y100: lineScene.pixel(63, 100)[3],
				y170: lineScene.pixel(63, 170)[3],
			};
			const detachedIslandAlpha = {
				y45: lineScene.pixel(18, 45)[3],
				y140: lineScene.pixel(108, 140)[3],
			};

			// 2. Position-invariant interior hole restoration: 48x48 dark patch with 4x4 hole at y=50 vs y=90 vs y=160
			function measureHoleAtCenterY(centerY: number) {
				const patchTop = centerY - 24;
				const holeTop = centerY - 2;
				const scene = runChromakey(128, 256, (ctx) => {
					ctx.clearRect(0, 0, 128, 256);
					ctx.fillStyle = "rgba(20, 20, 25, 1)";
					ctx.fillRect(40, patchTop, 48, 48);
					ctx.clearRect(62, holeTop, 4, 4);
				});
				return scene.pixel(64, centerY);
			}

			const holeY50 = measureHoleAtCenterY(50);
			const holeY90 = measureHoleAtCenterY(90);
			const holeY160 = measureHoleAtCenterY(160);

			// 3. NvaStackedAlphaGL 2px vertical line across widths 128, 720, 1440 (height = 512)
			function runStacked2pxLine(videoWidth: number) {
				const videoHeight = 512;
				const halfH = videoHeight / 2;
				const src = document.createElement("canvas");
				src.width = videoWidth;
				src.height = videoHeight;
				Object.assign(src, { videoWidth, videoHeight });
				const sctx = src.getContext("2d")!;
				// Top half: RGB(40, 35, 50)
				sctx.fillStyle = "rgb(40, 35, 50)";
				sctx.fillRect(0, 0, videoWidth, halfH);
				// Bottom half: black (alpha = 0), with a 2px vertical white line (alpha = 255)
				sctx.fillStyle = "rgb(0, 0, 0)";
				sctx.fillRect(0, halfH, videoWidth, halfH);
				const lineX = Math.floor(videoWidth / 2);
				sctx.fillStyle = "rgb(255, 255, 255)";
				sctx.fillRect(lineX, halfH + 20, 2, 180);
				// Baked isolated decoration must retain its authored alpha (180), without runtime matting.
				sctx.fillStyle = "rgb(180, 180, 180)";
				sctx.fillRect(12, halfH + 100, 1, 1);

				const glCanvas = document.createElement("canvas");
				glCanvas.width = videoWidth;
				glCanvas.height = halfH;
				const renderer = new NvaStackedAlphaGL(glCanvas);
				renderer.draw(src, videoWidth, videoHeight);

				const out = document.createElement("canvas");
				out.width = videoWidth;
				out.height = halfH;
				const octx = out.getContext("2d")!;
				octx.drawImage(glCanvas, 0, 0);
				renderer.dispose();

				const linePx = octx.getImageData(lineX, 100, 1, 1).data;
				const speckPx = octx.getImageData(12, 100, 1, 1).data;
				return {
					lineAlpha: linePx[3],
					speckAlpha: speckPx[3],
				};
			}

			const stackedWidths = {
				w128: runStacked2pxLine(128),
				w720: runStacked2pxLine(720),
				w1440: runStacked2pxLine(1440),
			};

			// 4. Synthetic patches verifying fix7f visual fixes remain intact
			// 4a. Jina crown top semi-transparent cyan fringe (stripped) + 1px scanline dropout (restored)
			const crownScene = runChromakey(128, 256, (ctx) => {
				ctx.clearRect(0, 0, 128, 256);
				// Main dark hair body y=67..120
				ctx.fillStyle = "rgba(22, 18, 16, 1)";
				ctx.fillRect(36, 67, 56, 54);
				// Top cyan-spill semi-transparent row at y=66: RGBA(25, 39, 49, 193)
				const row = ctx.createImageData(40, 1);
				for (let i = 0; i < 40; i++) {
					row.data[i * 4 + 0] = 25;
					row.data[i * 4 + 1] = 39;
					row.data[i * 4 + 2] = 49;
					row.data[i * 4 + 3] = 193;
				}
				ctx.putImageData(row, 44, 66);
				// 1px scanline dropout inside crown at y=70, x=58..68
				ctx.clearRect(58, 70, 10, 1);
			});

			// 4b. jina-anime 1px detached dark dotted island separated by 1px transparent trench from hair mass
			const animeTrenchScene = runChromakey(128, 256, (ctx) => {
				ctx.clearRect(0, 0, 128, 256);
				// Hair mass x=40..92, y=20..90
				ctx.fillStyle = "rgba(32, 24, 38, 1)";
				ctx.fillRect(40, 20, 52, 70);
				// x=39 is 1px transparent trench (alpha=0)
				// x=38 is 1px detached dark island strip: RGBA(12, 10, 16, 210)
				const island = ctx.createImageData(1, 30);
				for (let i = 0; i < 30; i++) {
					island.data[i * 4 + 0] = 12;
					island.data[i * 4 + 1] = 10;
					island.data[i * 4 + 2] = 16;
					island.data[i * 4 + 3] = 210;
				}
				ctx.putImageData(island, 38, 35);
			});

			// 4c. Jina burgundy skirt edge decontamination and outer gray border erosion
			const skirtScene = runChromakey(128, 256, (ctx) => {
				ctx.clearRect(0, 0, 128, 256);
				// Burgundy skirt interior x=28..63, y=120..185: RGBA(72, 9, 16, 255)
				ctx.fillStyle = "rgba(72, 9, 16, 1)";
				ctx.fillRect(28, 120, 36, 65);
				// Dark contaminated edge at x=64: RGBA(8, 9, 14, 240)
				const darkEdge = ctx.createImageData(1, 65);
				// Outer semi-transparent gray border at x=65: RGBA(59, 60, 65, 160)
				const grayBorder = ctx.createImageData(1, 65);
				for (let i = 0; i < 65; i++) {
					darkEdge.data[i * 4 + 0] = 8;
					darkEdge.data[i * 4 + 1] = 9;
					darkEdge.data[i * 4 + 2] = 14;
					darkEdge.data[i * 4 + 3] = 240;

					grayBorder.data[i * 4 + 0] = 59;
					grayBorder.data[i * 4 + 1] = 60;
					grayBorder.data[i * 4 + 2] = 65;
					grayBorder.data[i * 4 + 3] = 160;
				}
				ctx.putImageData(darkEdge, 64, 120);
				ctx.putImageData(grayBorder, 65, 120);
			});

			const fix7fPatches = {
				crownTopCyanFringeAlpha: crownScene.pixel(64, 66)[3],
				crownScanlineDropout: crownScene.pixel(64, 70),
				animeDetachedIslandAlpha: animeTrenchScene.pixel(38, 50)[3],
				animeTrenchAlpha: animeTrenchScene.pixel(39, 50)[3],
				skirtDarkEdge: skirtScene.glPixel(64, 150),
				skirtOuterGrayBorderAlpha: skirtScene.pixel(65, 150)[3],
			};
			sharedKeyer.dispose();

			return {
				connectedLineAlpha,
				detachedIslandAlpha,
				holeY50,
				holeY90,
				holeY160,
				stackedWidths,
				fix7fPatches,
			};
		},
		{ chromakeyCode: chromakeyCjs, stackedCode: stackedAlphaCjs },
	);

	// Finding 1: Connected 2x20px thin lines must be preserved at all vertical positions
	expect(gpuResults.connectedLineAlpha.y10).toBeGreaterThanOrEqual(240);
	expect(gpuResults.connectedLineAlpha.y45).toBeGreaterThanOrEqual(240);
	expect(gpuResults.connectedLineAlpha.y100).toBeGreaterThanOrEqual(240);
	expect(gpuResults.connectedLineAlpha.y170).toBeGreaterThanOrEqual(240);

	// Finding 1: Detached small islands must be removed
	expect(gpuResults.detachedIslandAlpha.y45).toBe(0);
	expect(gpuResults.detachedIslandAlpha.y140).toBe(0);

	// Finding 2: Interior 4x4 hole in 48x48 patch must be restored identically regardless of vertical position
	expect(gpuResults.holeY50[3]).toBe(255);
	expect(gpuResults.holeY90[3]).toBe(255);
	expect(gpuResults.holeY160[3]).toBe(255);
	expect(gpuResults.holeY90).toEqual(gpuResults.holeY50);
	expect(gpuResults.holeY160).toEqual(gpuResults.holeY50);

	// Finding 1: NvaStackedAlphaGL 2px vertical line must be preserved across widths 128, 720, 1440
	expect(gpuResults.stackedWidths.w128.lineAlpha).toBeGreaterThanOrEqual(240);
	expect(gpuResults.stackedWidths.w720.lineAlpha).toBeGreaterThanOrEqual(240);
	expect(gpuResults.stackedWidths.w1440.lineAlpha).toBeGreaterThanOrEqual(240);
	expect(gpuResults.stackedWidths.w128.speckAlpha).toBeCloseTo(180, 0);
	expect(gpuResults.stackedWidths.w720.speckAlpha).toBeCloseTo(180, 0);
	expect(gpuResults.stackedWidths.w1440.speckAlpha).toBeCloseTo(180, 0);

	// fix7f synthetic patches preserved:
	expect(gpuResults.fix7fPatches.crownTopCyanFringeAlpha).toBe(0);
	expect(gpuResults.fix7fPatches.crownScanlineDropout[3]).toBeGreaterThanOrEqual(
		240,
	);
	expect(gpuResults.fix7fPatches.animeDetachedIslandAlpha).toBe(0);
	expect(gpuResults.fix7fPatches.animeTrenchAlpha).toBe(0);
	expect(gpuResults.fix7fPatches.skirtOuterGrayBorderAlpha).toBeLessThan(20);
	expect(gpuResults.fix7fPatches.skirtDarkEdge[0]).toBeGreaterThanOrEqual(45);
	expect(gpuResults.fix7fPatches.skirtDarkEdge[0]).toBeGreaterThan(
		gpuResults.fix7fPatches.skirtDarkEdge[2] * 2,
	);
});

test("fix7g chat header controls do not overlap and preserve accessible names across 599/600/601px, 412x915, 915x412, and 1440x900 viewports", async ({
	page,
}) => {
	test.setTimeout(120_000);
	await page.addInitScript(() => {
		Object.defineProperty(window, "speechSynthesis", {
			value: {
				getVoices: () => [],
				cancel: () => {},
				pause: () => {},
				resume: () => {},
				addEventListener: () => {},
				removeEventListener: () => {},
				speak: (utterance: SpeechSynthesisUtterance) => {
					utterance.onstart?.(new Event("start") as SpeechSynthesisEvent);
					setTimeout(
						() => utterance.onend?.(new Event("end") as SpeechSynthesisEvent),
						20,
					);
				},
			},
		});
	});

	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto("/");
	const enter = page.getByRole("button", { name: "들어가기", exact: true });
	await expect(enter).toBeEnabled();
	await enter.click();
	await expect(page.getByText(/게스트님, 안녕하세요/).first()).toBeVisible();
	await page.evaluate(() => {
		for (const v of document.querySelectorAll("video")) {
			v.pause();
		}
	});

	const viewports = [
		{ width: 599, height: 800 },
		{ width: 600, height: 800 },
		{ width: 601, height: 800 },
		{ width: 412, height: 915 },
		{ width: 915, height: 412 },
		{ width: 1440, height: 900 },
	];

	for (const vp of viewports) {
		await page.setViewportSize({ width: vp.width, height: vp.height });

		const header = page.locator(".chat-header");
		const localToggle = page.getByRole("button", {
			name: "내 PC 에서 대답하기",
		});
		const resetBtn = page.getByRole("button", { name: "처음으로" });
		await expect(header).toBeVisible();
		await expect(localToggle).toBeVisible();
		await expect(resetBtn).toBeVisible();

		const headerBox = await header.boundingBox();
		const toggleBox = await localToggle.boundingBox();
		const resetBox = await resetBtn.boundingBox();
		expect(headerBox).toBeTruthy();
		expect(toggleBox).toBeTruthy();
		expect(resetBox).toBeTruthy();

		const overlapX = Math.max(
			0,
			Math.min(
				toggleBox!.x + toggleBox!.width,
				resetBox!.x + resetBox!.width,
			) - Math.max(toggleBox!.x, resetBox!.x),
		);
		const overlapY = Math.max(
			0,
			Math.min(
				toggleBox!.y + toggleBox!.height,
				resetBox!.y + resetBox!.height,
			) - Math.max(toggleBox!.y, resetBox!.y),
		);
		expect(overlapX * overlapY).toBe(0);
		expect(resetBox!.x + resetBox!.width).toBeLessThanOrEqual(
			headerBox!.x + headerBox!.width + 2,
		);

		const sameRow =
			Math.abs(
				toggleBox!.y +
					toggleBox!.height / 2 -
					(resetBox!.y + resetBox!.height / 2),
			) < 18;
		if (sameRow) {
			expect(toggleBox!.x + toggleBox!.width).toBeLessThanOrEqual(
				resetBox!.x + 1,
			);
		}

		const labelDisplay = await localToggle.evaluate((btn) => {
			const prefix = btn.querySelector(".kiosk-local-answer-label-prefix");
			const suffix = btn.querySelector(".kiosk-local-answer-label-suffix");
			return {
				ariaLabel: btn.getAttribute("aria-label"),
				textContent: btn.textContent,
				prefixDisplay: prefix ? getComputedStyle(prefix).display : null,
				suffixDisplay: suffix ? getComputedStyle(suffix).display : null,
			};
		});
		expect(labelDisplay.ariaLabel).toBe("내 PC 에서 대답하기");
		expect(labelDisplay.textContent).toBe("내 PC 에서 대답하기");
		expect(labelDisplay.prefixDisplay).not.toBe("none");
		expect(labelDisplay.suffixDisplay).toBe("none");
	}

	// Verify keyboard focus & activation at 412x915
	await page.setViewportSize({ width: 412, height: 915 });
	const toggleAtMobile = page.getByRole("button", {
		name: "내 PC 에서 대답하기",
	});
	await toggleAtMobile.focus();
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("kiosk-local-answer-notice")).toContainText(
		"그래픽 메모리 8GB 이상 기기에서만 됩니다",
	);
});

const FIX7F_REFERENCE_FRAG = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
uniform vec3 u_key;
uniform float u_thresh;
uniform float u_smooth;
uniform float u_despill;
uniform int u_mode;
uniform vec2 u_texel;
in vec2 v_uv;
out vec4 fragColor;

float luma(vec3 rgb) {
  return dot(rgb, vec3(0.299, 0.587, 0.114));
}

float sampleBaseA(vec2 uv) {
  float a0 = texture(u_tex, uv).a;
  if (v_uv.y < 0.065 && a0 < 0.80) {
    float aU1 = texture(u_tex, uv + vec2(0.0, -1.0) * u_texel).a;
    float aU2 = texture(u_tex, uv + vec2(0.0, -2.0) * u_texel).a;
    if (aU1 < 0.05 || (aU1 < 0.80 && aU2 < 0.05)) {
      return 0.0;
    }
  }
  return a0;
}

float sampleCleanA(vec2 uv) {
  float baseA = sampleBaseA(uv);
  if (v_uv.y < 0.26 && v_uv.x > 0.22 && v_uv.x < 0.78) {
    float aU1 = sampleBaseA(uv + vec2(0.0, -1.0) * u_texel);
    float aU2 = sampleBaseA(uv + vec2(0.0, -2.0) * u_texel);
    float aD1 = sampleBaseA(uv + vec2(0.0, 1.0) * u_texel);
    float aD2 = sampleBaseA(uv + vec2(0.0, 2.0) * u_texel);
    float aD3 = sampleBaseA(uv + vec2(0.0, 3.0) * u_texel);
    float aL1 = sampleBaseA(uv + vec2(-1.0, 0.0) * u_texel);
    float aL2 = sampleBaseA(uv + vec2(-2.0, 0.0) * u_texel);
    float aR1 = sampleBaseA(uv + vec2(1.0, 0.0) * u_texel);
    float aR2 = sampleBaseA(uv + vec2(2.0, 0.0) * u_texel);
    bool vBridge = (max(aU1, aU2) >= 0.80 && max(aD1, aD2) >= 0.80 && max(max(aD1, aD2), aD3) >= 0.85 && aU2 >= 0.55);
    bool hBridge = (max(aL1, aL2) >= 0.80 && max(aR1, aR2) >= 0.80 && max(aD1, aD2) >= 0.80 && aL2 >= 0.80 && aR2 >= 0.80);
    if (vBridge) {
      baseA = max(baseA, min(max(aU1, aU2), max(aD1, aD2)));
    }
    if (hBridge) {
      baseA = max(baseA, min(max(aL1, aL2), max(aR1, aR2)));
    }
  }
  return baseA;
}

void main() {
  vec4 c = texture(u_tex, v_uv);
  if (u_mode == 1) {
    vec3 rgb = c.rgb;
    float a = c.a;
    float cleanA = sampleCleanA(v_uv);
    if (a <= 0.02 && v_uv.y >= 0.26) {
      fragColor = vec4(0.0);
      return;
    }
    if (cleanA <= 0.02) {
      float pE = max(
        texture(u_tex, v_uv + vec2(5.0, 0.0) * u_texel).a,
        max(
          texture(u_tex, v_uv + vec2(10.0, 0.0) * u_texel).a,
          texture(u_tex, v_uv + vec2(20.0, 0.0) * u_texel).a
        )
      );
      float pW = max(
        texture(u_tex, v_uv + vec2(-5.0, 0.0) * u_texel).a,
        max(
          texture(u_tex, v_uv + vec2(-10.0, 0.0) * u_texel).a,
          texture(u_tex, v_uv + vec2(-20.0, 0.0) * u_texel).a
        )
      );
      float pS = max(
        texture(u_tex, v_uv + vec2(0.0, 5.0) * u_texel).a,
        max(
          texture(u_tex, v_uv + vec2(0.0, 10.0) * u_texel).a,
          texture(u_tex, v_uv + vec2(0.0, 20.0) * u_texel).a
        )
      );
      float pN = max(
        max(
          texture(u_tex, v_uv + vec2(0.0, -3.0) * u_texel).a,
          texture(u_tex, v_uv + vec2(0.0, -6.0) * u_texel).a
        ),
        max(
          texture(u_tex, v_uv + vec2(0.0, -10.0) * u_texel).a,
          texture(u_tex, v_uv + vec2(0.0, -15.0) * u_texel).a
        )
      );
      if (pE <= 0.05 || pW <= 0.05 || pS <= 0.05 || pN <= 0.05) {
        fragColor = vec4(0.0);
        return;
      }
    }
    const vec2 dirs[8] = vec2[8](
      vec2( 1.0,     0.0   ), vec2( 0.7071, -0.7071),
      vec2( 0.0,    -1.0   ), vec2(-0.7071, -0.7071),
      vec2(-1.0,     0.0   ), vec2(-0.7071,  0.7071),
      vec2( 0.0,     1.0   ), vec2( 0.7071,  0.7071)
    );
    float minA1 = cleanA;
    float minA2 = cleanA;
    float minA3 = cleanA;
    float sumA1 = cleanA;
    float sumA2 = 0.0;
    for (int d = 0; d < 8; d++) {
      float a1 = sampleCleanA(v_uv + dirs[d] * u_texel * 1.25);
      float a2 = sampleCleanA(v_uv + dirs[d] * u_texel * 2.25);
      float a3 = sampleCleanA(v_uv + dirs[d] * u_texel * 3.25);
      minA1 = min(minA1, a1);
      minA2 = min(minA2, a2);
      minA3 = min(minA3, a3);
      sumA1 += a1;
      sumA2 += a2;
    }
    float avgA1 = sumA1 / 9.0;
    float avgA2 = sumA2 / 8.0;
    if (a >= 0.98 && minA3 >= 0.96) {
      fragColor = vec4(rgb, 1.0);
      return;
    }
    if (v_uv.y < 0.26 && v_uv.x > 0.22 && v_uv.x < 0.78) {
      float dirMax8[8];
      float dirSolid8[8];
      float dirHair22[8];
      vec3 holeFillSum = vec3(0.0);
      float holeFillW = 0.0;
      for (int d = 0; d < 8; d++) {
        float m8 = 0.0;
        float s8 = 0.0;
        float h22 = 0.0;
        for (int step = 3; step <= 15; step++) {
          float r = step <= 8 ? float(step) : float(8 + (step - 8) * 2);
          vec2 uvR = v_uv + dirs[d] * u_texel * r;
          vec4 sr = texture(u_tex, uvR);
          float sra = sampleCleanA(uvR);
          if (step <= 8) {
            m8 = max(m8, sra);
            if (sra >= 0.88) s8 = 1.0;
          }
          if (sra >= 0.08 && luma(sr.rgb) < 0.30) {
            h22 = max(h22, sra);
          }
          if (sra >= 0.65 && luma(sr.rgb) < 0.28) {
            vec3 cleanSr = sr.rgb;
            cleanSr.g = min(cleanSr.g, max(cleanSr.r, cleanSr.b) + 0.02);
            float w = (sra * sra) / r;
            holeFillSum += cleanSr * w;
            holeFillW += w;
          }
        }
        dirMax8[d] = m8;
        dirSolid8[d] = s8;
        dirHair22[d] = h22;
      }
      int solidPairs = 0;
      int hairPairs = 0;
      int hairPairs22 = 0;
      for (int p = 0; p < 4; p++) {
        if (dirSolid8[p] > 0.5 && dirSolid8[p + 4] > 0.5) solidPairs++;
        if (dirMax8[p] >= 0.50 && dirMax8[p + 4] >= 0.50) hairPairs++;
        if (dirHair22[p] >= 0.35 && dirHair22[p + 4] >= 0.35) hairPairs22++;
      }
      int solidDirs = 0;
      int hairDirs = 0;
      int hairDirs22 = 0;
      for (int d = 0; d < 8; d++) {
        if (dirSolid8[d] > 0.5) solidDirs++;
        if (dirMax8[d] >= 0.50) hairDirs++;
        if (dirHair22[d] >= 0.35) hairDirs22++;
      }
      bool isCrown = (v_uv.y > 0.05 && v_uv.y < 0.17 && v_uv.x > 0.34 && v_uv.x < 0.66);
      bool crownTop = max(dirHair22[2], min(dirHair22[1], dirHair22[3])) >= 0.08;
      bool crownBot = (dirHair22[6] >= 0.75 && (dirHair22[5] >= 0.55 || dirHair22[7] >= 0.55));
      bool crownLeft = (dirHair22[4] >= 0.28 || dirHair22[3] >= 0.28);
      bool crownRight = (dirHair22[0] >= 0.28 || dirHair22[1] >= 0.28);
      bool crownEnclosed = isCrown && crownTop && crownBot && crownLeft && crownRight && (hairDirs22 >= 5);
      bool tightInterior = (solidPairs >= 3 && solidDirs >= 7 && cleanA > 0.02);
      bool hairInterior = ((hairPairs >= 3 && hairDirs >= 6) || (hairPairs22 >= 3 && hairDirs22 >= 6)) && (v_uv.y > 0.065 || (crownTop && crownLeft && crownRight)) && holeFillW > 0.0;
      vec3 fillRgb = holeFillW > 0.0 ? (holeFillSum / holeFillW) : rgb;
      float fillLuma = luma(fillRgb);
      bool isDarkHairContext = (holeFillW > 0.0 && fillLuma < 0.26);
      if (isDarkHairContext && (crownEnclosed || tightInterior || hairInterior)) {
        rgb.g = min(rgb.g, max(rgb.r, rgb.b) + 0.02);
        if (fillRgb.b <= fillRgb.r + 0.04) {
          rgb.g = min(rgb.g, rgb.r + 0.02);
          rgb.b = min(rgb.b, rgb.r + 0.03);
        }
        rgb = mix(fillRgb, rgb, smoothstep(0.15, 0.85, a));
        fragColor = vec4(rgb, 1.0);
        return;
      }
      if (tightInterior && cleanA >= 0.20 && minA1 >= 0.20) {
        fragColor = vec4(rgb, 1.0);
        return;
      }
    }
    if (cleanA <= 0.02) {
      fragColor = vec4(0.0);
      return;
    }
    if (minA3 < 0.96 || cleanA < 0.98) {
      float bestLuma = 0.0;
      vec3 bestRgb = rgb;
      vec3 sumInRgb = vec3(0.0);
      float inWeight = 0.0;
      for (int d = 0; d < 8; d++) {
        for (int r = 3; r <= 6; r++) {
          vec4 s = texture(u_tex, v_uv + dirs[d] * u_texel * float(r));
          vec4 sNext = texture(u_tex, v_uv + dirs[d] * u_texel * float(r + 1));
          if (s.a >= 0.96 && sNext.a >= 0.96) {
            float sl = luma(s.rgb);
            float w = sl + 0.1;
            sumInRgb += s.rgb * w;
            inWeight += w;
            if (sl > bestLuma) {
              bestLuma = sl;
              bestRgb = s.rgb;
            }
          }
        }
      }
      vec3 avgInRgb = inWeight > 0.0 ? (sumInRgb / inWeight) : rgb;
      float inLuma = inWeight > 0.0 ? luma(avgInRgb) : luma(rgb);
      float inChroma = max(avgInRgb.r, max(avgInRgb.g, avgInRgb.b)) - min(avgInRgb.r, min(avgInRgb.g, avgInRgb.b));
      bool isDarkHairEdge = (v_uv.y < 0.48 && inLuma < 0.22 && luma(rgb) < 0.25 && inChroma < 0.12);
      if (a < 0.98 && !isDarkHairEdge) {
        rgb = clamp(rgb / max(a, 0.28), 0.0, 1.0);
      }
      rgb.g = min(rgb.g, max(rgb.r, rgb.b) + 0.03);
      if (inWeight > 0.0) {
        if (isDarkHairEdge) {
          if (avgInRgb.b <= avgInRgb.r + 0.04) {
            rgb.g = min(rgb.g, rgb.r + 0.02);
            rgb.b = min(rgb.b, rgb.r + 0.03);
          }
          rgb = mix(avgInRgb, rgb, smoothstep(0.30, 0.90, a));
        } else {
          vec3 targetRgb = mix(avgInRgb, bestRgb, 0.6);
          float curLuma = luma(rgb);
          float targetLuma = luma(targetRgb);
          if (curLuma < targetLuma - 0.03) {
            float replaceT = clamp((targetLuma - curLuma) / max(0.08, targetLuma), 0.35, 1.0);
            rgb = mix(rgb, targetRgb, replaceT);
          }
        }
      }
      float erode1 = smoothstep(0.45, 0.96, minA1);
      float erode2 = smoothstep(0.25, 0.90, mix(minA2, avgA2, 0.35));
      a = min(cleanA, avgA1) * erode1 * mix(0.20, 1.0, erode2);
      if (a < 0.05) {
        a = 0.0;
      }
    } else {
      a = cleanA;
    }
    fragColor = vec4(rgb, a);
    return;
  }
  fragColor = c;
}`;

test("fix7h GPU multi-pass topological matting: real video baseline (jina idle/talking, naia, jina-anime <= fix7f crown TV/curvature & 0 detached islands) and adversarial counterexamples (diagonal line, detached 2x20 island, 3-color holes, position invariance, exterior gap)", async ({
	page,
}) => {
	test.setTimeout(120_000);
	const chromakeyCjs = transpileAvatarModule(CHROMAKEY_GL_PATH);
	const publicDir = path.resolve(E2E_DIR, "../public");

	await page.route("http://localhost:1420/nva/**", async (route) => {
		const url = new URL(route.request().url());
		const filePath = path.join(publicDir, url.pathname);
		if (fs.existsSync(filePath)) {
			const buf = fs.readFileSync(filePath);
			await route.fulfill({
				status: 200,
				contentType: filePath.endsWith(".webm")
					? "video/webm"
					: "application/octet-stream",
				body: buf,
			});
			return;
		}
		await route.continue();
	});

	await page.route("http://localhost:1420/fix7h-gpu-harness", async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "text/html",
			body: "<!doctype html><html><body></body></html>",
		});
	});
	await page.goto("http://localhost:1420/fix7h-gpu-harness");

	const results = await page.evaluate(
		async ({ chromakeyCode, fix7fFrag }) => {
			function loadCjs<T>(code: string): T {
				const exportsObj: Record<string, unknown> = {};
				const moduleObj = { exports: exportsObj };
				const fn = new Function("exports", "module", code);
				fn(exportsObj, moduleObj);
				return moduleObj.exports as T;
			}

			const { NvaChromakeyGL } = loadCjs<{
				NvaChromakeyGL: new (opts?: { mode?: "chromakey" | "alpha-repair" }) => {
					process: (
						source: TexImageSource,
						width: number,
						height: number,
					) => HTMLCanvasElement;
					dispose: () => void;
				};
			}>(chromakeyCode);

			// Reference fix7f single-pass runner for exact baseline comparison in the same test
			function createFix7fRunner() {
				const canvas = document.createElement("canvas");
				const gl = canvas.getContext("webgl2", {
					premultipliedAlpha: false,
					alpha: true,
				})!;
				const vertSrc = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = vec2((a_pos.x + 1.0) * 0.5, 1.0 - (a_pos.y + 1.0) * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;
				const compile = (type: number, src: string) => {
					const sh = gl.createShader(type)!;
					gl.shaderSource(sh, src);
					gl.compileShader(sh);
					if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
						throw new Error(gl.getShaderInfoLog(sh) || "fix7f compile error");
					}
					return sh;
				};
				const prog = gl.createProgram()!;
				gl.attachShader(prog, compile(gl.VERTEX_SHADER, vertSrc));
				gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fix7fFrag));
				gl.linkProgram(prog);
				const buf = gl.createBuffer();
				gl.bindBuffer(gl.ARRAY_BUFFER, buf);
				gl.bufferData(
					gl.ARRAY_BUFFER,
					new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
					gl.STATIC_DRAW,
				);
				const loc = gl.getAttribLocation(prog, "a_pos");
				gl.enableVertexAttribArray(loc);
				gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
				const tex = gl.createTexture()!;
				gl.bindTexture(gl.TEXTURE_2D, tex);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
				gl.useProgram(prog);
				gl.uniform1i(gl.getUniformLocation(prog, "u_tex"), 0);
				const uMode = gl.getUniformLocation(prog, "u_mode");
				const uTexel = gl.getUniformLocation(prog, "u_texel");
				return {
					process(source: TexImageSource, w: number, h: number) {
						canvas.width = w;
						canvas.height = h;
						gl.viewport(0, 0, w, h);
						gl.useProgram(prog);
						gl.uniform1i(uMode, 1);
						gl.uniform2f(uTexel, 1 / w, 1 / h);
						gl.activeTexture(gl.TEXTURE0);
						gl.bindTexture(gl.TEXTURE_2D, tex);
						gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
						gl.texImage2D(
							gl.TEXTURE_2D,
							0,
							gl.RGBA,
							gl.RGBA,
							gl.UNSIGNED_BYTE,
							source,
						);
						gl.clearColor(0, 0, 0, 0);
						gl.clear(gl.COLOR_BUFFER_BIT);
						gl.drawArrays(gl.TRIANGLES, 0, 6);
						return canvas;
					},
					dispose() {
						gl.getExtension("WEBGL_lose_context")?.loseContext();
					},
				};
			}

			const keyer = new NvaChromakeyGL({ mode: "alpha-repair" });
			const fix7fKeyer = createFix7fRunner();

			function runPatch(
				width: number,
				height: number,
				paint: (ctx: CanvasRenderingContext2D) => void,
			) {
				const src = document.createElement("canvas");
				src.width = width;
				src.height = height;
				const sctx = src.getContext("2d")!;
				paint(sctx);

				const glCanvas = keyer.process(src, width, height);
				const out = document.createElement("canvas");
				out.width = width;
				out.height = height;
				const octx = out.getContext("2d")!;
				octx.drawImage(glCanvas, 0, 0);
				return {
					pixel(x: number, y: number): [number, number, number, number] {
						const d = octx.getImageData(x, y, 1, 1).data;
						return [d[0], d[1], d[2], d[3]];
					},
				};
			}

			// 1. Adversarial Counterexample 2A: Diagonal 2x2 connected line attached to 24x20 block
			function testDiagonalConnectedLine(rgbCss: string) {
				const scene = runPatch(128, 256, (ctx) => {
					ctx.clearRect(0, 0, 128, 256);
					ctx.fillStyle = rgbCss;
					ctx.fillRect(50, 30, 24, 20);
					for (let i = 0; i <= 19; i++) {
						ctx.fillRect(61 + i, 50 + i, 2, 2);
					}
				});
				return scene.pixel(70, 59)[3];
			}

			const diagonalDarkAlpha = testDiagonalConnectedLine("rgb(20, 20, 25)");
			const diagonalBrightAlpha = testDiagonalConnectedLine("rgb(230, 230, 220)");

			// 2. Adversarial Counterexample 2B: Detached 2x20 island (without connecting block)
			const detached2x20OnlyScene = runPatch(128, 256, (ctx) => {
				ctx.clearRect(0, 0, 128, 256);
				ctx.fillStyle = "rgb(20, 20, 25)";
				ctx.fillRect(61, 50, 2, 20);
			});
			const detached2x20WithSubjectScene = runPatch(128, 256, (ctx) => {
				ctx.clearRect(0, 0, 128, 256);
				ctx.fillStyle = "rgb(20, 20, 25)";
				// Main subject block elsewhere
				ctx.fillRect(20, 120, 48, 48);
				// Detached 2x20 island at (61, 50)
				ctx.fillRect(61, 50, 2, 20);
			});
			const detached2x20OnlyAlpha = detached2x20OnlyScene.pixel(61, 60)[3];
			const detached2x20WithSubjectAlpha =
				detached2x20WithSubjectScene.pixel(61, 60)[3];

			// 3. Adversarial Counterexample 3: Same 4x4 interior hole in 48x48 patch across 3 colors & vertical shifts
			function testHole(
				rgb: [number, number, number],
				patchTop: number,
				openToExterior = false,
			) {
				const holeTop = patchTop + 20;
				const scene = runPatch(128, 256, (ctx) => {
					ctx.clearRect(0, 0, 128, 256);
					ctx.fillStyle = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
					ctx.fillRect(40, patchTop, 48, 48);
					ctx.clearRect(62, holeTop, 4, 4);
					if (openToExterior) {
						// Connect hole to exterior background through a 4px channel at the top of the patch
						ctx.clearRect(62, patchTop, 4, 20);
					}
				});
				return scene.pixel(64, holeTop + 2);
			}

			const holeDarkTop = testHole([20, 20, 25], 30);
			const holeDarkMid = testHole([20, 20, 25], 70);
			const holeDarkBot = testHole([20, 20, 25], 140);

			const holeGrayTop = testHole([68, 68, 68], 30);
			const holeGrayMid = testHole([68, 68, 68], 70);

			const holeBrightTop = testHole([230, 230, 220], 30);
			const holeBrightMid = testHole([230, 230, 220], 70);

			const exteriorConnectedGapDark = testHole([20, 20, 25], 30, true);
			const exteriorConnectedGapBright = testHole([230, 230, 220], 30, true);

			// 4. Real video frame evaluation (Jina idle 1.000s, Jina talking 1.000s, Naia idle 1.000s, Jina-anime idle 1.000s)
			function computeFrameMetrics(
				rgba: Uint8ClampedArray,
				width: number,
				height: number,
			) {
				const alphaAt = (x: number, y: number) => rgba[(y * width + x) * 4 + 3];

				// Crown ROI: x=[300, 420), y=[20, 150)
				const crownH: number[] = [];
				for (let x = 300; x < 420; x++) {
					let topY = -1;
					for (let y = 20; y < 150; y++) {
						if (alphaAt(x, y) > 128) {
							topY = y;
							break;
						}
					}
					if (topY !== -1) crownH.push(topY);
				}
				let crownTV = 0;
				for (let i = 0; i < crownH.length - 1; i++) {
					crownTV += Math.abs(crownH[i + 1] - crownH[i]);
				}
				let crownCurv = 0;
				for (let i = 1; i < crownH.length - 1; i++) {
					crownCurv += Math.abs(
						crownH[i + 1] - 2 * crownH[i] + crownH[i - 1],
					);
				}

				// Broad Head ROI: x=[200, 520), y=[0, 300)
				const headH: number[] = [];
				for (let x = 200; x < 520; x++) {
					let topY = -1;
					for (let y = 0; y < 300; y++) {
						if (alphaAt(x, y) > 128) {
							topY = y;
							break;
						}
					}
					if (topY !== -1) headH.push(topY);
				}
				let headTV = 0;
				for (let i = 0; i < headH.length - 1; i++) {
					headTV += Math.abs(headH[i + 1] - headH[i]);
				}

				// 8-connected components of A > 128 across whole frame (width x height)
				const visited = new Uint8Array(width * height);
				const queue = new Int32Array(width * height);
				const compSizes: number[] = [];
				for (let y = 0; y < height; y++) {
					for (let x = 0; x < width; x++) {
						const idx = y * width + x;
						if (visited[idx] || rgba[idx * 4 + 3] <= 128) continue;
						visited[idx] = 1;
						let head = 0;
						let tail = 0;
						queue[tail++] = idx;
						let size = 0;
						while (head < tail) {
							const cur = queue[head++];
							size++;
							const cx = cur % width;
							const cy = (cur / width) | 0;
							for (let dy = -1; dy <= 1; dy++) {
								const ny = cy + dy;
								if (ny < 0 || ny >= height) continue;
								for (let dx = -1; dx <= 1; dx++) {
									if (dx === 0 && dy === 0) continue;
									const nx = cx + dx;
									if (nx < 0 || nx >= width) continue;
									const nIdx = ny * width + nx;
									if (!visited[nIdx] && rgba[nIdx * 4 + 3] > 128) {
										visited[nIdx] = 1;
										queue[tail++] = nIdx;
									}
								}
							}
						}
						compSizes.push(size);
					}
				}
				compSizes.sort((a, b) => b - a);
				const totalOpaque = compSizes.reduce((s, v) => s + v, 0);
				const largest = compSizes[0] ?? 0;
				const detachedIslandPixels = totalOpaque - largest;
				const detachedIslandCount = Math.max(0, compSizes.length - 1);

				return {
					crownTV,
					crownCurv,
					headTV,
					detachedIslandPixels,
					detachedIslandCount,
				};
			}

			async function evaluateClipAt1s(url: string) {
				const video = document.createElement("video");
				video.muted = true;
				video.playsInline = true;
				video.preload = "auto";
				video.src = url;
				await new Promise<void>((resolve, reject) => {
					video.addEventListener("loadeddata", () => resolve(), { once: true });
					video.addEventListener(
						"error",
						() => reject(new Error(`Failed to load ${url}`)),
						{ once: true },
					);
				});
				video.currentTime = Math.min(1.0, (video.duration || 2.0) * 0.5);
				await new Promise<void>((resolve) => {
					video.addEventListener("seeked", () => resolve(), { once: true });
				});

				const w = video.videoWidth || 720;
				const h = video.videoHeight || 1280;

				const out7f = document.createElement("canvas");
				out7f.width = w;
				out7f.height = h;
				const ctx7f = out7f.getContext("2d")!;
				ctx7f.drawImage(fix7fKeyer.process(video, w, h), 0, 0);
				const data7f = ctx7f.getImageData(0, 0, w, h).data;

				const outCur = document.createElement("canvas");
				outCur.width = w;
				outCur.height = h;
				const ctxCur = outCur.getContext("2d")!;
				ctxCur.drawImage(keyer.process(video, w, h), 0, 0);
				const dataCur = ctxCur.getImageData(0, 0, w, h).data;

				return {
					fix7f: computeFrameMetrics(data7f, w, h),
					current: computeFrameMetrics(dataCur, w, h),
				};
			}

			const videoMetrics = {
				jinaIdle: await evaluateClipAt1s("/nva/jina/clips/idle.webm"),
				jinaTalking: await evaluateClipAt1s("/nva/jina/clips/talking-ko.webm"),
				naiaIdle: await evaluateClipAt1s("/nva/naia/clips/idle.webm"),
				jinaAnimeIdle: await evaluateClipAt1s("/nva/jina-anime/clips/idle.webm"),
			};

			keyer.dispose();
			fix7fKeyer.dispose();

			return {
				diagonalDarkAlpha,
				diagonalBrightAlpha,
				detached2x20OnlyAlpha,
				detached2x20WithSubjectAlpha,
				holeDarkTop,
				holeDarkMid,
				holeDarkBot,
				holeGrayTop,
				holeGrayMid,
				holeBrightTop,
				holeBrightMid,
				exteriorConnectedGapDark,
				exteriorConnectedGapBright,
				videoMetrics,
			};
		},
		{ chromakeyCode: chromakeyCjs, fix7fFrag: FIX7F_REFERENCE_FRAG },
	);

	// Counterexample 2A: Diagonal connected 2x2 line at (70, 59) preserved (A = 255)
	expect.soft(results.diagonalDarkAlpha, "diagonalDarkAlpha").toBe(255);
	expect.soft(results.diagonalBrightAlpha, "diagonalBrightAlpha").toBe(255);

	// Counterexample 2B: Detached 2x20 island removed (A = 0)
	expect.soft(results.detached2x20OnlyAlpha, "detached2x20OnlyAlpha").toBe(0);
	expect
		.soft(results.detached2x20WithSubjectAlpha, "detached2x20WithSubjectAlpha")
		.toBe(0);

	// Counterexample 3: Same 4x4 interior hole filled across dark (20,20,25), mid-gray (68,68,68), and bright white (230,230,220)
	expect.soft(results.holeDarkTop[3], "holeDarkTop alpha").toBe(255);
	expect.soft(results.holeGrayTop[3], "holeGrayTop alpha").toBe(255);
	expect.soft(results.holeBrightTop[3], "holeBrightTop alpha").toBe(255);

	// Position invariance across vertical shifts
	expect.soft(results.holeDarkMid, "holeDarkMid == holeDarkTop").toEqual(
		results.holeDarkTop,
	);
	expect.soft(results.holeDarkBot, "holeDarkBot == holeDarkTop").toEqual(
		results.holeDarkTop,
	);
	expect.soft(results.holeGrayMid, "holeGrayMid == holeGrayTop").toEqual(
		results.holeGrayTop,
	);
	expect.soft(results.holeBrightMid, "holeBrightMid == holeBrightTop").toEqual(
		results.holeBrightTop,
	);

	// Exterior-connected gap must NOT be filled
	expect
		.soft(results.exteriorConnectedGapDark[3], "exteriorConnectedGapDark alpha")
		.toBe(0);
	expect
		.soft(
			results.exteriorConnectedGapBright[3],
			"exteriorConnectedGapBright alpha",
		)
		.toBe(0);

	// Real video baseline comparisons against fix7f in the same test
	for (const [name, m] of Object.entries(results.videoMetrics)) {
		expect
			.soft(m.current.detachedIslandPixels, `${name} detachedIslandPixels`)
			.toBe(0);
		expect
			.soft(m.current.detachedIslandCount, `${name} detachedIslandCount`)
			.toBe(0);
		expect
			.soft(
				m.current.crownTV,
				`${name} crownTV (${m.current.crownTV} vs fix7f ${m.fix7f.crownTV})`,
			)
			.toBeLessThanOrEqual(m.fix7f.crownTV);
		expect
			.soft(
				m.current.crownCurv,
				`${name} crownCurv (${m.current.crownCurv} vs fix7f ${m.fix7f.crownCurv})`,
			)
			.toBeLessThanOrEqual(m.fix7f.crownCurv);
	}
	expect
		.soft(
			results.videoMetrics.jinaIdle.current.crownTV,
			"jinaIdle crownTV <= 113",
		)
		.toBeLessThanOrEqual(113);
	expect
		.soft(
			results.videoMetrics.jinaIdle.current.crownCurv,
			"jinaIdle crownCurv <= 128",
		)
		.toBeLessThanOrEqual(128);
});
