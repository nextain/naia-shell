import { S } from "../helpers/selectors.js";
import { safeRefresh } from "../helpers/settings.js";

let originalLocalConfig = "";
let originalUiConfig = "";
let adkPath = "";
let snapshotCaptured = false;
let agentProfileMutated = false;
let isolatedRun = false;

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
		await browser.execute((useCodex: boolean) => {
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

async function openDjSkillSettings(): Promise<void> {
	const tabsAlreadyVisible = await browser.execute(() =>
		Boolean(document.querySelector('[data-settings-tab="skills"]')),
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
	// 설정은 지연 렌더라 버튼을 누른 **직후**에는 안쪽 탭이 아직 없다. 기다리지 않고
	// 찾으면 `skills settings tab unavailable` 로 죽고, 그 뒤 프로필 설정이 통째로
	// 건너뛰어져 뒤따르는 단정들이 줄줄이 무너진다(재시험 2차에서 실측).
	await browser.waitUntil(
		async () =>
			browser.execute(() =>
				Boolean(document.querySelector('[data-settings-tab="skills"]')),
			),
		{ timeout: 10_000, timeoutMsg: "skills settings tab unavailable" },
	);
	await browser.execute(() => {
		const tab = document.querySelector(
			'[data-settings-tab="skills"]',
		) as HTMLButtonElement | null;
		if (!tab) throw new Error("skills settings tab unavailable");
		tab.click();
	});
	await browser.waitUntil(
		async () =>
			browser.execute(() =>
				Boolean(document.querySelector('[data-testid="youtube-bgm-skill-settings"]')),
			),
		{ timeout: 10_000, timeoutMsg: "YouTube BGM skill settings unavailable" },
	);
	await browser.execute(() => {
		const header = document.querySelector(
			".radio-dj-skill-card-header",
		) as HTMLButtonElement | null;
		if (!header) throw new Error("radio DJ skill card header unavailable");
		if (header.getAttribute("aria-expanded") !== "true") header.click();
	});
	await browser.waitUntil(
		async () =>
			browser.execute(() =>
				Boolean(document.querySelector('[data-testid="proactive-speech-settings"]')),
			),
		{ timeout: 10_000, timeoutMsg: "proactive DJ settings unavailable" },
	);
	// The DJ card owns BGM/profile controls. Exhibition knowledge scope belongs
	// to the exhibition section and is intentionally absent from this panel.
	expect(
		await browser.execute(() =>
			Boolean(document.querySelector('[data-testid="proactive-knowledge-scope"]')),
		),
	).toBe(false);
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
		const isolatedCodex = Boolean(process.env.NAIA_E2E_ADK_PATH);
		isolatedRun = isolatedCodex;
		const original = await browser.execute(() => ({
			config: localStorage.getItem("naia-config") ?? "",
			adkPath: localStorage.getItem("naia-adk-path") ?? "",
		}));
		originalLocalConfig = original.config;
		// The legacy Tauri suite injects this through ensureAppReady(), while
		// the isolated native suite owns the workspace through its environment.
		// Accept both so this UC never depends on global test setup or a real
		// developer workspace.
		adkPath = original.adkPath || process.env.NAIA_E2E_ADK_PATH || "";
		if (!adkPath) throw new Error("ADK path unavailable before test setup");
		if (!original.adkPath) {
			await browser.execute((path: string) => {
				localStorage.setItem("naia-adk-path", path);
			}, adkPath);
		}
		originalUiConfig = await tauriInvoke<string>("read_naia_ui_config", {
			adkPath,
		});
		snapshotCaptured = true;

		await browser.execute((useCodex: boolean) => {
			const raw = localStorage.getItem("naia-config");
			const current = raw ? JSON.parse(raw) : {};
			localStorage.setItem(
				"naia-config",
				JSON.stringify({
					...current,
					// The isolated native suite seeds a real Codex config. Do not
					// replace it with an unavailable local Ollama model merely because
					// localStorage starts empty in that owned WebView2 profile.
					provider: current.provider || (useCodex ? "codex" : "ollama"),
					model: current.model || (useCodex ? "gpt-5.4" : "qwen3.6:27b"),
					agentName: current.agentName || "Naia",
					userName: current.userName || "Tester",
					vrmModel:
						current.vrmModel || "/avatars/01-OL_Woman.vrm",
					persona: current.persona || "Friendly AI companion",
					enableTools: true,
					locale: "ko",
					onboardingComplete: true,
					appVisible: true,
					proactiveSpeechProfile: "disabled",
					proactiveSpeechPermitted: false,
					proactiveSpeechIdleMs: 5_000,
					proactiveSpeechIntervalMs: 30_000,
				}),
			);
			window.dispatchEvent(new CustomEvent("naia-config-changed"));
		}, isolatedCodex);
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
					proactiveSpeechPermitted: false,
					proactiveSpeechIdleMs: 5_000,
					proactiveSpeechIntervalMs: 30_000,
				}),
			);
			window.dispatchEvent(new CustomEvent("naia-config-changed"));
		});
	});

	after(async () => {
		if (!snapshotCaptured) return;
		// The Codex harness owns and removes this workspace, WebView2 profile, and
		// app-data root. Restoring through a WebView after its last reload can hang
		// teardown without protecting any developer state.
		if (isolatedRun) return;
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
		await submitProfilePhrase("개인 라디오 시작해");

		const config = await storedProfile();
		expect(config.proactiveSpeechProfile).toBe("personal_radio_dj");
		expect(config.proactiveSpeechPermitted).toBe(true);
		expect(config.proactiveSpeechBgmAutoPlay).toBe(true);
		expect(config.proactiveSpeechIdleMs).toBe(5_000);
		await waitForPersistedProfile("personal_radio_dj");

		await browser.waitUntil(
			async () => {
				const current = await storedProfile();
				return (
					// Provider wording is not deterministic; the persisted BGM request below is the contract.
					current.bgmSource === "youtube" &&
					typeof current.bgmYoutubeVideoId === "string" &&
					current.bgmYoutubeVideoId.length > 0
				);
			},
			{
				timeout: 70_000,
				timeoutMsg:
					"radio DJ did not persist a proactive YouTube BGM play request",
			},
		);

		await submitProfilePhrase("라디오 종료");
		expect((await storedProfile()).proactiveSpeechProfile).toBe("disabled");
		await waitForPersistedProfile("disabled");
	});

	it("persists validated proactive settings after cache-clear native reload", async () => {
		await openDjSkillSettings();
		await fillProactiveSettings();
		await browser.waitUntil(async () => {
			const config = await fileBackedUiConfig();
			return (
				config.proactiveSpeechProfile === "personal_radio_dj" &&
				config.proactiveSpeechPermitted === false &&
				config.proactiveSpeechTimezone === "Asia/Seoul" &&
				config.proactiveSpeechIdleMs === 5000 &&
				config.proactiveSpeechIntervalMs === 30000 &&
				config.proactiveSpeechBgmAutoPlay === true &&
				config.proactiveSpeechWeatherConsented === true &&
				config.proactiveSpeechWeatherLatitude === 37.5665 &&
				config.proactiveSpeechWeatherLongitude === 126.978
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
					restored.proactiveSpeechPermitted === false &&
					restored.proactiveSpeechTimezone === "Asia/Seoul" &&
					restored.proactiveSpeechIdleMs === 5000 &&
					restored.proactiveSpeechIntervalMs === 30000 &&
					restored.proactiveSpeechBgmAutoPlay === true &&
					restored.proactiveSpeechWeatherConsented === true &&
					restored.proactiveSpeechWeatherLatitude === 37.5665 &&
					restored.proactiveSpeechWeatherLongitude === 126.978
				);
			},
			{ timeout: 20_000 },
		);
		await openDjSkillSettings();
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

	it("persists exhibition settings through the visible General section after cache-clear native reload", async () => {
		await openGeneralSettings();
		const controls = await browser.execute(() => ({
			profileOptions: Array.from(
				document.querySelectorAll<HTMLSelectElement>(
					'[data-testid="proactive-speech-profile"] option',
				),
			).map((option) => option.value),
			bgmPresent: Boolean(
				document.querySelector('[data-testid="proactive-bgm-autoplay"]'),
			),
			knowledgeScopePresent: Boolean(
				document.querySelector('[data-testid="proactive-knowledge-scope"]'),
			),
		}));
		expect(controls.profileOptions).toEqual(["disabled", "exhibition_intro"]);
		expect(controls.bgmPresent).toBe(false);
		expect(controls.knowledgeScopePresent).toBe(true);

		await browser.execute(() => {
			const setValue = (selector: string, value: string) => {
				const element = document.querySelector(selector) as
					| HTMLInputElement
					| HTMLSelectElement
					| null;
				if (!element) throw new Error(`missing exhibition control: ${selector}`);
				const prototype =
					element instanceof HTMLSelectElement
						? HTMLSelectElement.prototype
						: HTMLInputElement.prototype;
				const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
				setter?.call(element, value);
				element.dispatchEvent(new Event("input", { bubbles: true }));
				element.dispatchEvent(new Event("change", { bubbles: true }));
			};
			setValue('[data-testid="proactive-speech-profile"]', "exhibition_intro");
			setValue('[data-testid="proactive-timezone"]', "Asia/Seoul");
			setValue('[data-testid="proactive-idle-ms"]', "5000");
			setValue('[data-testid="proactive-interval-ms"]', "30000");
			setValue('[data-testid="proactive-knowledge-scope"]', "expo-2026");
			(
				document.querySelector(
					'[data-testid="proactive-settings-save"]',
				) as HTMLButtonElement | null
			)?.click();
		});
		await browser.waitUntil(async () => {
			const config = await fileBackedUiConfig();
			return (
				config.proactiveSpeechProfile === "exhibition_intro" &&
				config.proactiveSpeechPermitted === false &&
				config.proactiveSpeechTimezone === "Asia/Seoul" &&
				config.proactiveSpeechIdleMs === 5000 &&
				config.proactiveSpeechIntervalMs === 30000 &&
				config.proactiveSpeechKnowledgeScope === "expo-2026"
			);
		}, { timeout: 10_000, timeoutMsg: "exhibition settings were not persisted" });

		const bootstrap = await browser.execute(() => {
			const raw = localStorage.getItem("naia-config");
			const config = raw ? JSON.parse(raw) : {};
			for (const key of Object.keys(config)) {
				if (key.startsWith("proactiveSpeech")) delete config[key];
			}
			localStorage.setItem("naia-config", JSON.stringify(config));
			return {
				pointer: localStorage.getItem("naia-adk-path"),
				proactiveKeys: Object.keys(config).filter((key) =>
					key.startsWith("proactiveSpeech"),
				),
			};
		});
		expect(bootstrap.pointer).toBe(adkPath);
		expect(bootstrap.proactiveKeys).toEqual([]);
		await safeRefresh();
		await browser.waitUntil(
			async () => {
				const restored = await storedProfile();
				return (
					restored.proactiveSpeechProfile === "exhibition_intro" &&
					restored.proactiveSpeechTimezone === "Asia/Seoul" &&
					restored.proactiveSpeechIdleMs === 5000 &&
					restored.proactiveSpeechIntervalMs === 30000 &&
					restored.proactiveSpeechKnowledgeScope === "expo-2026"
				);
			},
			{ timeout: 20_000, timeoutMsg: "exhibition settings did not restore from ADK file" },
		);
		await openGeneralSettings();
		const visible = await browser.execute(() => ({
			profile: (
				document.querySelector(
					'[data-testid="proactive-speech-profile"]',
				) as HTMLSelectElement | null
			)?.value,
			timezone: (
				document.querySelector(
					'[data-testid="proactive-timezone"]',
				) as HTMLInputElement | null
			)?.value,
			idleMs: (
				document.querySelector(
					'[data-testid="proactive-idle-ms"]',
				) as HTMLInputElement | null
			)?.value,
			intervalMs: (
				document.querySelector(
					'[data-testid="proactive-interval-ms"]',
				) as HTMLInputElement | null
			)?.value,
			knowledgeScope: (
				document.querySelector(
					'[data-testid="proactive-knowledge-scope"]',
				) as HTMLInputElement | null
			)?.value,
			bgmPresent: Boolean(
				document.querySelector('[data-testid="proactive-bgm-autoplay"]'),
			),
		}));
		expect(visible).toEqual({
			profile: "exhibition_intro",
			timezone: "Asia/Seoul",
			idleMs: "5000",
			intervalMs: "30000",
			knowledgeScope: "expo-2026",
			bgmPresent: false,
		});

		// Leave the isolated ADK in the opt-out state for later checks.
		await browser.execute(() => {
			const profile = document.querySelector(
				'[data-testid="proactive-speech-profile"]',
			) as HTMLSelectElement | null;
			if (!profile) throw new Error("exhibition profile control disappeared");
			const setter = Object.getOwnPropertyDescriptor(
				HTMLSelectElement.prototype,
				"value",
			)?.set;
			setter?.call(profile, "disabled");
			profile.dispatchEvent(new Event("change", { bubbles: true }));
			(
				document.querySelector(
					'[data-testid="proactive-settings-save"]',
				) as HTMLButtonElement | null
			)?.click();
		});
		await browser.waitUntil(
			async () => (await fileBackedUiConfig()).proactiveSpeechProfile === "disabled",
			{ timeout: 10_000, timeoutMsg: "exhibition cleanup did not persist disabled profile" },
		);
	});

	it("reports the standalone cascade boundary through registered native IPC", async () => {
		const status = await tauriInvoke<{
			phase: string;
			ready: boolean;
			canStart: boolean;
			summary: string;
			steps: Array<{ id: string; progressPercent: number; actionAvailable: boolean }>;
		}>("cascade_installation_status");
		expect(["ready", "ready-to-start", "blocked", "requires-action"]).toContain(
			status.phase,
		);
		expect(typeof status.ready).toBe("boolean");
		expect(typeof status.canStart).toBe("boolean");
		expect(status.summary.length).toBeGreaterThan(0);
		expect(status.steps.map((step) => step.id)).toEqual(
			expect.arrayContaining([
				"loader",
				"python-runtime",
				"cascade-service-bundle",

				"voxcpm2-model",
				"reference-voices",
			]),
		);
		for (const step of status.steps) {
			expect(step.progressPercent).toBeGreaterThanOrEqual(0);
			expect(step.progressPercent).toBeLessThanOrEqual(100);
		}
	});

	it("uses the visible AI/TTS control to allow and stop proactive cost", async () => {
		// #510 이후 능동 발화는 TTS 와 **독립**이다 — 버튼의 막힘은 프로필만 본다
		// (`AiControlBar.tsx` 의 `proactiveBlocked = proactive.profile === "disabled"`).
		// TTS 를 켜면 풀린다고 적힌 옛 모델로는, 프로필이 없는 깨끗한 프로필에서
		// 언제나 막힘이다. 이 시험이 재려는 것은 "허용/중지가 파일에 남는가" 이므로
		// 프로필을 먼저 세우고 잰 뒤 되돌린다.
		agentProfileMutated = true;
		await submitProfilePhrase("개인 라디오 시작해");
		await waitForPersistedProfile("personal_radio_dj");

		await browser.execute(() => {
			const tts = Array.from(document.querySelectorAll("button"))
				.find((button) => button.textContent?.trim() === "TTS") as HTMLButtonElement | undefined;
			if (!tts) throw new Error("TTS control unavailable");
			if (tts.getAttribute("aria-pressed") !== "true") tts.click();
			const proactive = document.querySelector(
				"button[data-proactive-state]",
			) as HTMLButtonElement | null;
			if (!proactive) throw new Error("visible proactive control unavailable");
			if (proactive.getAttribute("data-proactive-state") === "blocked") {
				throw new Error("proactive control stayed blocked after TTS enabled");
			}
			proactive.click();
		});
		await browser.waitUntil(
			async () => (await fileBackedUiConfig()).proactiveSpeechPermitted === true,
			{ timeout: 10_000, timeoutMsg: "visible proactive control did not persist permission" },
		);
		await browser.execute(() => {
			const proactive = document.querySelector(
				"button[data-proactive-state]",
			) as HTMLButtonElement | null;
			if (!proactive) throw new Error("visible proactive control disappeared");
			proactive.click();
		});
		await browser.waitUntil(
			async () => (await fileBackedUiConfig()).proactiveSpeechPermitted === false,
			{ timeout: 10_000, timeoutMsg: "visible proactive control did not stop permission" },
		);

		await submitProfilePhrase("라디오 종료");
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
