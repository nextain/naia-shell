import { S } from "../helpers/selectors.js";

let originalLocalConfig = "";
let originalUiConfig = "";
let adkPath = "";
let snapshotCaptured = false;

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
			const invoke =
				w.__TAURI_INTERNALS__?.invoke ?? w.__TAURI__?.core?.invoke;
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
		async () =>
			(await fileBackedUiConfig()).proactiveSpeechProfile === profile,
		{
			timeout: 10_000,
			timeoutMsg: `file-backed UI config did not persist profile: ${profile}`,
		},
	);
}

async function assistantMessages(): Promise<string[]> {
	return browser.execute(() =>
		Array.from(
			document.querySelectorAll(
				".chat-message.assistant .message-content",
			),
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
						current.vrmModel ||
						"/avatars/01-Sendagaya-Shino-uniform.vrm",
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
		await tauriInvoke("send_to_agent_command", {
			message: JSON.stringify({
				type: "configure_speech_profile",
				requestId: `e2e-cleanup-${Date.now()}`,
				sessionId: "agent:main:main",
				profile: "disabled",
			}),
		}).catch(() => undefined);
		await browser.execute((raw: string) => {
			if (raw) localStorage.setItem("naia-config", raw);
			else localStorage.removeItem("naia-config");
			window.dispatchEvent(new CustomEvent("naia-config-changed"));
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

	it("starts exhibition introduction without waiting for ordinary chat", async () => {
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
					.some((text) => text.includes("넥스테인 전시에 오신 것을 환영합니다")),
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
