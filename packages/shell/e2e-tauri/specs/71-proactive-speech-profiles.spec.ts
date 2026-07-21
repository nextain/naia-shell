import { S } from "../helpers/selectors.js";
import { safeRefresh } from "../helpers/settings.js";

let originalLocalConfig = "";
let originalUiConfig = "";
let adkPath = "";
let snapshotCaptured = false;
let agentProfileMutated = false;

async function tauriInvoke<T>(
	command: string,
	args: Record<string, unknown> = {},
): Promise<T> {
	return (await browser.execute(
		async (cmd: string, a: Record<string, unknown>) => {
			const w = window as unknown as {
				__TAURI_INTERNALS__?: {
					invoke: (c: string, a: unknown) => Promise<unknown>;
				};
				__TAURI__?: {
					core?: { invoke: (c: string, a: unknown) => Promise<unknown> };
				};
			};
			const invoke = w.__TAURI_INTERNALS__?.invoke ?? w.__TAURI__?.core?.invoke;
			if (!invoke) throw new Error("Tauri invoke unavailable");
			return invoke(cmd, a);
		},
		command,
		args,
	)) as T;
}

async function submitProfilePhrase(phrase: string): Promise<void> {
	const before = await browser.execute(
		(sel: string) => document.querySelectorAll(sel).length,
		S.userMessage,
	);
	await browser.execute(
		(inputSelector: string, text: string) => {
			const input = document.querySelector(
				inputSelector,
			) as HTMLTextAreaElement | null;
			if (!input) throw new Error("chat input unavailable");
			const setter = Object.getOwnPropertyDescriptor(
				HTMLTextAreaElement.prototype,
				"value",
			)?.set;
			setter?.call(input, text);
			input.dispatchEvent(new Event("input", { bubbles: true }));
		},
		S.chatInput,
		phrase,
	);
	await browser.pause(100);
	await browser.execute((buttonSelector: string) => {
		const button = document.querySelector(
			buttonSelector,
		) as HTMLButtonElement | null;
		if (!button) throw new Error("chat send button unavailable");
		button.click();
	}, S.chatSendBtn);
	await browser.waitUntil(
		async () =>
			(await browser.execute(
				(sel: string) => document.querySelectorAll(sel).length,
				S.userMessage,
			)) ===
			before + 1,
		{
			timeout: 10_000,
			timeoutMsg: `profile phrase was not consumed: ${phrase}`,
		},
	);
}

async function storedProfile(): Promise<Record<string, unknown>> {
	return browser.execute(() => {
		const raw = localStorage.getItem("naia-config");
		return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
	});
}

async function fileBackedUiConfig(): Promise<Record<string, unknown>> {
	const raw = await tauriInvoke<string>("read_naia_ui_config", { adkPath });
	return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

async function waitForPersistedProfile(profile: string): Promise<void> {
	await browser.waitUntil(
		async () => (await fileBackedUiConfig()).proactiveSpeechProfile === profile,
		{
			timeout: 10_000,
			timeoutMsg: `file-backed UI config did not persist profile: ${profile}`,
		},
	);
}

async function openGeneralSettings(): Promise<void> {
	const tabsAlreadyVisible = await browser.execute(() =>
		Boolean(document.querySelector('[data-settings-tab="general"]')),
	);
	if (!tabsAlreadyVisible) {
		await browser.waitUntil(
			async () =>
				browser.execute(() =>
					Boolean(document.querySelector(".app-bar-settings")),
				),
			{ timeout: 10_000, timeoutMsg: "settings button unavailable" },
		);
		await browser.execute(() => {
			const button = document.querySelector(
				".app-bar-settings",
			) as HTMLButtonElement | null;
			if (!button) throw new Error("settings button unavailable");
			button.click();
		});
	}
	await browser.waitUntil(
		async () =>
			browser.execute(() =>
				Boolean(document.querySelector('[data-settings-tab="general"]')),
			),
		{ timeout: 10_000, timeoutMsg: "settings tabs unavailable" },
	);
	await browser.execute(() => {
		const tab = document.querySelector(
			'[data-settings-tab="general"]',
		) as HTMLButtonElement | null;
		tab?.click();
	});
	await browser.waitUntil(
		async () =>
			browser.execute(() =>
				Boolean(
					document.querySelector('[data-testid="proactive-speech-settings"]'),
				),
			),
		{ timeout: 10_000, timeoutMsg: "proactive settings unavailable" },
	);
}

async function fillProactiveSettings(): Promise<void> {
	await browser.execute(() => {
		const changeValue = (selector: string, value: string) => {
			const element = document.querySelector(selector) as
				| HTMLInputElement
				| HTMLSelectElement
				| null;
			if (!element) throw new Error(`missing proactive control: ${selector}`);
			const prototype =
				element instanceof HTMLSelectElement
					? HTMLSelectElement.prototype
					: HTMLInputElement.prototype;
			const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
			setter?.call(element, value);
			element.dispatchEvent(new Event("change", { bubbles: true }));
			element.dispatchEvent(new Event("input", { bubbles: true }));
		};
		changeValue(
			'[data-testid="proactive-speech-profile"]',
			"personal_radio_dj",
		);
		const consent = document.querySelector(
			'[data-testid="proactive-weather-consent"]',
		) as HTMLInputElement | null;
		if (!consent) throw new Error("missing proactive weather consent");
		if (!consent.checked) consent.click();
		changeValue('[data-testid="proactive-weather-latitude"]', "37.5665");
		changeValue('[data-testid="proactive-weather-longitude"]', "126.978");
		changeValue('[data-testid="proactive-timezone"]', "Asia/Seoul");
		changeValue('[data-testid="proactive-idle-ms"]', "5000");
		changeValue('[data-testid="proactive-interval-ms"]', "30000");
		changeValue('[data-testid="proactive-knowledge-scope"]', "expo-2026");
		const bgm = document.querySelector(
			'[data-testid="proactive-bgm-autoplay"]',
		) as HTMLInputElement | null;
		if (!bgm) throw new Error("missing proactive BGM control");
		if (!bgm.checked) bgm.click();
		(
			document.querySelector(
				'[data-testid="proactive-settings-save"]',
			) as HTMLButtonElement | null
		)?.click();
	});
}

async function assistantMessages(): Promise<string[]> {
	return browser.execute(() =>
		Array.from(
			document.querySelectorAll(".chat-message.assistant .message-content"),
		)
			.map((node) => node.textContent?.trim() ?? "")
			.filter(Boolean),
	);
}

describe("71 — Proactive speech profiles (#82)", () => {
	before(async () => {
		const original = await browser.execute(() => ({
			config: localStorage.getItem("naia-config") ?? "",
			adkPath: localStorage.getItem("naia-adk-path") ?? "",
		}));
		originalLocalConfig = original.config;
		adkPath = original.adkPath;
		if (!adkPath) throw new Error("ADK path unavailable before test setup");
		originalUiConfig = await tauriInvoke<string>("read_naia_ui_config", {
			adkPath,
		});
		snapshotCaptured = true;

		await browser.execute(() => {
			const raw = localStorage.getItem("naia-config");
			const current = raw ? JSON.parse(raw) : {};
			localStorage.setItem(
				"naia-config",
				JSON.stringify({
					...current,
					provider: current.provider || "ollama",
					model: current.model || "qwen3.6:27b",
					agentName: current.agentName || "Naia",
					userName: current.userName || "Tester",
					vrmModel:
						current.vrmModel || "/avatars/01-Sendagaya-Shino-uniform.vrm",
					persona: current.persona || "Friendly AI companion",
					enableTools: true,
					locale: "ko",
					onboardingComplete: true,
					panelVisible: true,
					proactiveSpeechProfile: "disabled",
					proactiveSpeechIdleMs: 5_000,
					proactiveSpeechIntervalMs: 30_000,
				}),
			);
			location.reload();
		});
		await browser.waitUntil(
			async () =>
				browser.execute(
					(sel: string) => !!document.querySelector(sel),
					S.chatInput,
				),
			{
				timeout: 30_000,
				timeoutMsg: "chat input unavailable after proactive test setup",
			},
		);
		// The file-backed config is authoritative and hydrates asynchronously on
		// startup. Do not race a profile command against that one-time merge.
		await browser.pause(1_500);
		await browser.execute(() => {
			const raw = localStorage.getItem("naia-config");
			const current = raw ? JSON.parse(raw) : {};
			localStorage.setItem(
				"naia-config",
				JSON.stringify({
					...current,
					ttsEnabled: false,
					proactiveSpeechProfile: "disabled",
					proactiveSpeechIdleMs: 5_000,
					proactiveSpeechIntervalMs: 30_000,
				}),
			);
			window.dispatchEvent(new CustomEvent("naia-config-changed"));
		});
	});

	after(async () => {
		if (!snapshotCaptured) return;
		// A failed assertion must not leave the real development workspace in an
		// active speech profile or with test BGM/config values.
		if (agentProfileMutated) {
			await tauriInvoke("send_to_agent_command", {
				message: JSON.stringify({
					type: "configure_speech_profile",
					requestId: `e2e-cleanup-${Date.now()}`,
					sessionId: "agent:main:main",
					profile: "disabled",
				}),
			}).catch(() => undefined);
		}
		await browser.execute((raw: string) => {
			if (raw) localStorage.setItem("naia-config", raw);
			else localStorage.removeItem("naia-config");
			window.dispatchEvent(new CustomEvent("naia-config-changed"));
			return true;
		}, originalLocalConfig);
		// Let App's pending debounce settle, then restore the exact file snapshot
		// so this real-Tauri test is config-neutral across runs.
		await browser.pause(1_200);
		await tauriInvoke("write_naia_ui_config", {
			adkPath,
			json: originalUiConfig,
		});
	});

	it("starts and persists personal radio DJ through the real Tauri IPC path", async () => {
		agentProfileMutated = true;
		const before = (await assistantMessages()).length;
		await submitProfilePhrase("개인 라디오 시작해");

		const config = await storedProfile();
		expect(config.proactiveSpeechProfile).toBe("personal_radio_dj");
		expect(config.proactiveSpeechBgmAutoPlay).toBe(true);
		expect(config.proactiveSpeechIdleMs).toBe(5_000);
		await waitForPersistedProfile("personal_radio_dj");

		await browser.waitUntil(
			async () => {
				const current = await storedProfile();
				return (
					(await assistantMessages())
						.slice(before)
						.some((text) => text.includes("영상을 재생 중이에요")) &&
					current.bgmPlaying === true &&
					typeof current.bgmYoutubeVideoId === "string" &&
					current.bgmYoutubeVideoId.length > 0
				);
			},
			{
				timeout: 70_000,
				timeoutMsg:
					"radio DJ did not emit a proactive result and start real YouTube BGM",
			},
		);

		await submitProfilePhrase("라디오 종료");
		expect((await storedProfile()).proactiveSpeechProfile).toBe("disabled");
		await waitForPersistedProfile("disabled");
	});

	it("persists validated proactive settings after cache-clear native reload", async () => {
		await openGeneralSettings();
		await fillProactiveSettings();
		await browser.waitUntil(async () => {
			const config = await fileBackedUiConfig();
			return (
				config.proactiveSpeechProfile === "personal_radio_dj" &&
				config.proactiveSpeechTimezone === "Asia/Seoul" &&
				config.proactiveSpeechIdleMs === 5000 &&
				config.proactiveSpeechIntervalMs === 30000 &&
				config.proactiveSpeechBgmAutoPlay === true &&
				config.proactiveSpeechWeatherConsented === true &&
				config.proactiveSpeechWeatherLatitude === 37.5665 &&
				config.proactiveSpeechWeatherLongitude === 126.978 &&
				config.proactiveSpeechKnowledgeScope === "expo-2026"
			);
		});
		await browser.execute(() => {
			const raw = localStorage.getItem("naia-config");
			const config = raw ? JSON.parse(raw) : {};
			for (const key of Object.keys(config)) {
				if (key.startsWith("proactiveSpeech")) delete config[key];
			}
			localStorage.setItem("naia-config", JSON.stringify(config));
		});
		await safeRefresh();
		await browser.waitUntil(
			async () => {
				const restored = await storedProfile();
				return (
					restored.proactiveSpeechProfile === "personal_radio_dj" &&
					restored.proactiveSpeechTimezone === "Asia/Seoul" &&
					restored.proactiveSpeechIdleMs === 5000 &&
					restored.proactiveSpeechIntervalMs === 30000 &&
					restored.proactiveSpeechBgmAutoPlay === true &&
					restored.proactiveSpeechWeatherConsented === true &&
					restored.proactiveSpeechWeatherLatitude === 37.5665 &&
					restored.proactiveSpeechWeatherLongitude === 126.978 &&
					restored.proactiveSpeechKnowledgeScope === "expo-2026"
				);
			},
			{ timeout: 20_000 },
		);
		await openGeneralSettings();
		await browser.execute(() => {
			const consent = document.querySelector(
				'[data-testid="proactive-weather-consent"]',
			) as HTMLInputElement | null;
			if (!consent) throw new Error("missing reloaded weather consent");
			if (consent.checked) consent.click();
			(
				document.querySelector(
					'[data-testid="proactive-settings-save"]',
				) as HTMLButtonElement | null
			)?.click();
		});
		await browser.waitUntil(async () => {
			const config = await fileBackedUiConfig();
			return (
				config.proactiveSpeechWeatherConsented === false &&
				config.proactiveSpeechWeatherLatitude == null &&
				config.proactiveSpeechWeatherLongitude == null
			);
		});
	});

	it("starts exhibition introduction without waiting for ordinary chat", async () => {
		agentProfileMutated = true;
		const before = (await assistantMessages()).length;
		await submitProfilePhrase("행사 소개 시작");

		const config = await storedProfile();
		expect(config.proactiveSpeechProfile).toBe("exhibition_intro");
		expect(config.proactiveSpeechIdleMs).toBe(5_000);
		await waitForPersistedProfile("exhibition_intro");

		await browser.waitUntil(
			async () =>
				(await assistantMessages())
					.slice(before)
					.some((text) =>
						text.includes("넥스테인 전시에 오신 것을 환영합니다"),
					),
			{
				timeout: 30_000,
				timeoutMsg:
					"exhibition greeting did not arrive through the activity stream",
			},
		);

		await submitProfilePhrase("행사 소개 종료");
		expect((await storedProfile()).proactiveSpeechProfile).toBe("disabled");
		await waitForPersistedProfile("disabled");
	});
});
