import { type Page, expect, test } from "@playwright/test";
import {
	SEED_ADK_PATH,
	TAURI_BASE_MOCK_FALLBACK,
} from "./helpers/tauri-base-mock";

const PROACTIVE_MOCK = `
(function() {
	window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
	window.__TAURI_EVENT_PLUGIN_INTERNALS__ = window.__TAURI_EVENT_PLUGIN_INTERNALS__ || {};
	window.__TAURI_INTERNALS__.metadata = { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } };
	var callbacks = new Map(); var nextId = 1; var listeners = new Map();
	window.__TAURI_INTERNALS__.transformCallback = function(fn, once) {
		var id = nextId++; callbacks.set(id, function(data) {
			if (once) callbacks.delete(id); return fn && fn(data);
		}); return id;
	};
	window.__TAURI_INTERNALS__.unregisterCallback = function(id) { callbacks.delete(id); };
	window.__TAURI_INTERNALS__.runCallback = function(id, data) {
		var callback = callbacks.get(id); if (callback) callback(data);
	};
	window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = function() {};
	window.__TAURI_INTERNALS__.convertFileSrc = function(path, protocol) {
		return (protocol || "asset") + "://localhost/" + encodeURIComponent(path);
	};
	function emit(event, payload) {
		(listeners.get(event) || []).forEach(function(handler) {
			window.__TAURI_INTERNALS__.runCallback(handler, { event: event, payload: payload });
		});
	}
	window.__PA_DJ_E2E__ = {
		order: [], speakTexts: [], audioPlayed: 0, commands: [], lastSubmitAt: 0,
		subscriptionEpoch: 0, failConfigure: false,
		emitActivity: function(chunk) {
			if (chunk.subscriptionEpoch == null) {
				chunk.subscriptionEpoch = window.__PA_DJ_E2E__.subscriptionEpoch;
			}
			emit("agent_response", JSON.stringify(chunk));
		}
	};
	document.addEventListener("keydown", function(event) {
		if (event.key === "Enter") {
			window.__PA_DJ_E2E__.lastSubmitAt = performance.now();
		}
	}, true);
	Object.defineProperty(window, "speechSynthesis", { configurable: true, value: {
		speak: function(utterance) {
			window.__PA_DJ_E2E__.speakTexts.push(utterance.text);
			window.__PA_DJ_E2E__.order.push("speak:" + utterance.text);
			setTimeout(function() {
				if (utterance.onstart) utterance.onstart();
				if (utterance.onend) utterance.onend();
			}, 10);
		},
		cancel: function() { window.__PA_DJ_E2E__.order.push("cancel"); },
		getVoices: function() { return []; }, pause: function() {}, resume: function() {}
	}});
	Object.defineProperty(window, "SpeechSynthesisUtterance", {
		configurable: true, writable: true,
		value: function(text) {
			this.text = text; this.lang = ""; this.onstart = null;
			this.onend = null; this.onerror = null;
		}
	});
	window.Audio = function(src) {
		var audio = { src: src || "", paused: true, onended: null };
		audio.play = function() {
			window.__PA_DJ_E2E__.audioPlayed++;
			window.__PA_DJ_E2E__.order.push("audio");
			setTimeout(function() { if (audio.onended) audio.onended(); }, 10);
			return Promise.resolve();
		};
		audio.pause = function() {};
		Object.defineProperty(audio, "currentTime", { get: function() { return 0; }, set: function() {} });
		return audio;
	};
	window.__TAURI_INTERNALS__.invoke = async function(command, args) {
		if (command === "plugin:event|listen") {
			if (!listeners.has(args.event)) listeners.set(args.event, []);
			listeners.get(args.event).push(args.handler);
			return args.handler;
		}
		if (command === "plugin:event|emit") {
			emit(args.event, args.payload); return null;
		}
		if (command === "plugin:event|unlisten") return null;
		if (command === "send_to_agent_command") {
			var message = JSON.parse(args.message);
			window.__PA_DJ_E2E__.commands.push(Object.assign(
				{
					_capturedAt: performance.now(),
					_submittedAt: window.__PA_DJ_E2E__.lastSubmitAt
				},
				message
			));
			window.__PA_DJ_E2E__.order.push("send:" + (message.action || message.type));
			if (message.type === "chat_request") {
				setTimeout(function() {
					emit("agent_response", JSON.stringify({
						type: "finish", requestId: message.requestId
					}));
				}, 10);
			}
			if (message.type === "configure_speech_profile") {
				var ok = !window.__PA_DJ_E2E__.failConfigure;
				if (ok) window.__PA_DJ_E2E__.subscriptionEpoch++;
				var epoch = window.__PA_DJ_E2E__.subscriptionEpoch;
				setTimeout(function() {
					emit("agent_response", JSON.stringify({
						type: "speech_profile_configured",
						requestId: message.requestId,
						ok: ok,
						profile: message.profile,
						subscriptionEpoch: epoch
					}));
				}, 10);
			}
			if (message.type === "yield_speech_activity") {
				setTimeout(function() {
					emit("agent_response", JSON.stringify({
						type: "speech_activity_yielded",
						requestId: message.requestId,
						ok: true,
						sessionId: message.sessionId,
						activityId: message.activityId,
						profileGeneration: 7,
						yieldGeneration: 1,
						resumeToken: "resume-token"
					}));
				}, 10);
			}
			return null;
		}
		return undefined;
	};
})();
`;

type Activity = {
	type: "text";
	requestId: string;
	activityId: string;
	profileGeneration: number;
	subscriptionEpoch?: number;
	text: string;
};

async function setup(page: Page, ttsProvider: "browser" | "edge") {
	await page.addInitScript(PROACTIVE_MOCK);
	await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
	await page.addInitScript({ content: SEED_ADK_PATH });
	await page.addInitScript(
		(config: string) => localStorage.setItem("naia-config", config),
		JSON.stringify({
			provider: "ollama",
			model: "qwen3.6:27b",
			enableTools: false,
			ttsEnabled: true,
			ttsProvider,
			locale: "ko",
			onboardingComplete: true,
			proactiveSpeechProfile: "personal_radio_dj",
		}),
	);
	if (ttsProvider === "edge") {
		await page.route(/\/edge-tts(?:\?|$)/, (route) =>
			route.fulfill({
				status: 200,
				contentType: "audio/mpeg",
				body: Buffer.from([0xff, 0xf3, 0x64, 0xc4, 0x00, 0x01, 0x02]),
			}),
		);
	}
	await page.goto("/");
	await expect(page.locator(".chat-panel")).toBeVisible({ timeout: 10_000 });
	await page.waitForTimeout(150);
}

async function emitActivity(page: Page, activity: Activity) {
	await page.evaluate((chunk) => {
		(window as any).__PA_DJ_E2E__.emitActivity(chunk);
	}, activity);
}

async function telemetry(page: Page) {
	return page.evaluate(() => ({
		order: [...(window as any).__PA_DJ_E2E__.order] as string[],
		speakTexts: [...(window as any).__PA_DJ_E2E__.speakTexts] as string[],
		audioPlayed: (window as any).__PA_DJ_E2E__.audioPlayed as number,
		commands: [...(window as any).__PA_DJ_E2E__.commands] as Array<
			Record<string, unknown>
		>,
	}));
}

async function sendPhrase(page: Page, phrase: string) {
	const input = page.locator(".chat-input");
	await input.fill(phrase);
	await input.press("Enter");
}

test.describe("PA-DJ-05 proactive speech product acceptance", () => {
	test("speaks proactive text through browser TTS", async ({ page }) => {
		await setup(page, "browser");
		await emitActivity(page, {
			type: "text",
			requestId: "radio-dj:browser",
			activityId: "dj-browser",
			profileGeneration: 1,
			text: "첫 번째 DJ 멘트입니다.",
		});
		await expect
			.poll(async () => (await telemetry(page)).speakTexts)
			.toContain("첫 번째 DJ 멘트입니다.");
	});

	test("plays synthesized proactive audio", async ({ page }) => {
		await setup(page, "edge");
		await emitActivity(page, {
			type: "text",
			requestId: "radio-dj:edge",
			activityId: "dj-edge",
			profileGeneration: 1,
			text: "합성 음성 DJ 멘트입니다.",
		});
		await expect
			.poll(async () => (await telemetry(page)).audioPlayed)
			.toBeGreaterThan(0);
	});

	test("interrupts before every DJ control and drops stale output", async ({
		page,
	}) => {
		await setup(page, "browser");
		await emitActivity(page, {
			type: "text",
			requestId: "radio-dj:controls",
			activityId: "dj-controls",
			profileGeneration: 3,
			text: "제어 전 멘트입니다.",
		});
		const cases = [
			["음악만 틀어줘", "music_only"],
			["말 줄여", "talk_less"],
			["말을 더 해줘", "talk_more"],
			["분위기 바꿔줘", "change_vibe"],
			["다음 곡 틀어줘", "next"],
			["그만해", "stop"],
		] as const;
		for (const [phrase, action] of cases) {
			const before = (await telemetry(page)).order.length;
			await sendPhrase(page, phrase);
			await expect
				.poll(async () =>
					(await telemetry(page)).commands.some(
						(command) =>
							command.type === "control_speech_activity" &&
							command.action === action,
					),
				)
				.toBe(true);
			const order = (await telemetry(page)).order.slice(before);
			expect(order.indexOf("cancel")).toBeGreaterThanOrEqual(0);
			expect(order.indexOf(`send:${action}`)).toBeGreaterThan(
				order.indexOf("cancel"),
			);
			const captured = (await telemetry(page)).commands.findLast(
				(command) =>
					command.type === "control_speech_activity" &&
					command.action === action,
			);
			expect(
				Number(captured?._capturedAt) - Number(captured?._submittedAt),
			).toBeLessThanOrEqual(250);
		}

		await emitActivity(page, {
			type: "text",
			requestId: "radio-dj:new",
			activityId: "dj-new",
			profileGeneration: 4,
			text: "현재 세대 멘트입니다.",
		});
		const beforeStale = await telemetry(page);
		await emitActivity(page, {
			type: "text",
			requestId: "radio-dj:stale",
			activityId: "dj-controls",
			profileGeneration: 3,
			text: "폐기되어야 하는 멘트입니다.",
		});
		await page.waitForTimeout(100);
		const afterStale = await telemetry(page);
		expect(afterStale.speakTexts).not.toContain("폐기되어야 하는 멘트입니다.");
		expect(afterStale.speakTexts.length).toBe(beforeStale.speakTexts.length);
		await expect(page.getByText("폐기되어야 하는 멘트입니다.")).toHaveCount(0);
	});

	test("settings profile save retires current speech before reconfigure", async ({
		page,
	}) => {
		await setup(page, "browser");
		await emitActivity(page, {
			type: "text",
			requestId: "radio-dj:settings-old",
			activityId: "dj-settings-old",
			profileGeneration: 8,
			text: "설정 변경 전 멘트입니다.",
		});
		const before = (await telemetry(page)).order.length;
		await page.locator(".app-bar-settings").click();
		await page.locator('[data-settings-tab="general"]').click();
		await page.getByTestId("proactive-settings-save").click();
		await expect
			.poll(async () => (await telemetry(page)).order.slice(before))
			.toContain("cancel");

		await emitActivity(page, {
			type: "text",
			requestId: "radio-dj:settings-stale",
			activityId: "dj-settings-old",
			profileGeneration: 8,
			text: "설정 변경 뒤 폐기될 멘트입니다.",
		});
		await page.waitForTimeout(100);
		expect((await telemetry(page)).speakTexts).not.toContain(
			"설정 변경 뒤 폐기될 멘트입니다.",
		);
	});

	test("profile stream epoch rejects an unseen old activity arriving after save", async ({
		page,
	}) => {
		await setup(page, "browser");
		const oldEpoch = await page.evaluate(
			() => (window as any).__PA_DJ_E2E__.subscriptionEpoch as number,
		);
		await page.locator(".app-bar-settings").click();
		await page.locator('[data-settings-tab="general"]').click();
		await page.getByTestId("proactive-settings-save").click();
		await expect
			.poll(() => page.getByTestId("proactive-settings-save").isEnabled())
			.toBe(true);
		const newEpoch = await page.evaluate(
			() => (window as any).__PA_DJ_E2E__.subscriptionEpoch as number,
		);
		expect(newEpoch).toBeGreaterThan(oldEpoch);

		await emitActivity(page, {
			type: "text",
			requestId: "radio-dj:unseen-old",
			activityId: "dj-unseen-old",
			profileGeneration: 99,
			subscriptionEpoch: oldEpoch,
			text: "보이지 않던 이전 스트림 멘트입니다.",
		});
		await emitActivity(page, {
			type: "text",
			requestId: "radio-dj:new-epoch",
			activityId: "dj-new-epoch",
			profileGeneration: 1,
			subscriptionEpoch: newEpoch,
			text: "새 스트림 멘트입니다.",
		});
		await expect
			.poll(async () => (await telemetry(page)).speakTexts)
			.toContain("새 스트림 멘트입니다.");
		expect((await telemetry(page)).speakTexts).not.toContain(
			"보이지 않던 이전 스트림 멘트입니다.",
		);
	});

	test("profile phrase ACK failure stays fenced and does not claim local shutdown", async ({
		page,
	}) => {
		await setup(page, "browser");
		const oldEpoch = await page.evaluate(() => {
			(window as any).__PA_DJ_E2E__.failConfigure = true;
			return (window as any).__PA_DJ_E2E__.subscriptionEpoch as number;
		});
		await sendPhrase(page, "라디오 종료");
		await expect(
			page.getByText("설정을 적용하지 못해 능동 발화를 안전하게 차단했습니다."),
		).toBeVisible();
		const profile = await page.evaluate(() =>
			JSON.parse(localStorage.getItem("naia-config") ?? "{}")
				.proactiveSpeechProfile,
		);
		expect(profile).toBe("personal_radio_dj");
		await emitActivity(page, {
			type: "text",
			requestId: "radio-dj:failed-stop-old",
			activityId: "dj-failed-stop-old",
			profileGeneration: 100,
			subscriptionEpoch: oldEpoch,
			text: "실패 뒤 차단되어야 하는 멘트입니다.",
		});
		await page.waitForTimeout(100);
		expect((await telemetry(page)).speakTexts).not.toContain(
			"실패 뒤 차단되어야 하는 멘트입니다.",
		);
	});

	test("ordinary chat interrupts before yielding the active exhibition", async ({
		page,
	}) => {
		await setup(page, "browser");
		await emitActivity(page, {
			type: "text",
			requestId: "exhibition:intro",
			activityId: "expo-active",
			profileGeneration: 7,
			text: "전시 소개를 시작합니다.",
		});
		const before = (await telemetry(page)).order.length;
		await sendPhrase(page, "이 작품은 누가 만들었나요?");
		await expect
			.poll(async () =>
				(await telemetry(page)).commands.some(
					(command) => command.type === "yield_speech_activity",
				),
			)
			.toBe(true);
		const order = (await telemetry(page)).order.slice(before);
		expect(order.indexOf("cancel")).toBeGreaterThanOrEqual(0);
		expect(order.indexOf("send:yield_speech_activity")).toBeGreaterThan(
			order.indexOf("cancel"),
		);
		await emitActivity(page, {
			type: "text",
			requestId: "exhibition:resume",
			activityId: "expo-active",
			profileGeneration: 7,
			text: "질문 뒤 소개를 이어갑니다.",
		});
		await expect
			.poll(async () => (await telemetry(page)).speakTexts)
			.toContain("질문 뒤 소개를 이어갑니다.");
	});
});
