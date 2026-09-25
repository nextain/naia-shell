// platforms: linux
// 리눅스 음성 프로필(linux_trt_6g)을 확인한다. 윈도우 짝은 94-voice-6g-shell.
import { readFileSync } from "node:fs";
import { sendMessage } from "../helpers/chat.js";

// Linux twin of 94-voice-6g-shell (#537). Same journey through the real Tauri
// Shell — install status, standalone start, settings, external LLM reply spoken
// sentence by sentence — with the profile taken from the host instead of a
// spelled operating system. A custom test voice is optional here: the shipped
// CC0 palette is the default the product actually uses.
const TEST_VOICE_PATH = process.env.NAIA_E2E_VOXCPM2_TEST_VOICE ?? "";

describe("Linux VoxCPM2 voice profile through the real Tauri Shell", () => {
	async function tauriInvoke<T>(
		command: string,
		args: Record<string, unknown> = {},
	): Promise<T> {
		return (await browser.execute(
			async (name: string, payload: Record<string, unknown>) => {
				const shell = window as unknown as {
					__TAURI_INTERNALS__?: {
						invoke: (command: string, value: unknown) => Promise<unknown>;
					};
				};
				if (!shell.__TAURI_INTERNALS__?.invoke)
					throw new Error("Tauri invoke unavailable");
				return shell.__TAURI_INTERNALS__.invoke(name, payload);
			},
			command,
			args,
		)) as T;
	}

	after(async () => {
		try {
			await tauriInvoke("stop_voxcpm2");
		} catch {
			// A failed startup has no managed process to stop.
		}
	});

	it("starts standalone VoxCPM2 TRT, renders VRM, and speaks an external LLM reply", async () => {
		await browser.waitUntil(
			() => browser.execute(() => document.querySelector(".app-root") !== null),
			{ timeout: 45_000, timeoutMsg: "Shell app root did not render" },
		);
		const detectedVramGb = await tauriInvoke<number | null>("detect_gpu_vram");
		expect(detectedVramGb).toBeGreaterThanOrEqual(6);

		// The saved profile must restore after the secure credential is hydrated;
		// a direct start below is then only an idempotent readiness read.
		await browser.waitUntil(() => tauriInvoke<boolean>("voxcpm2_status"), {
			timeout: 240_000,
			timeoutMsg:
				"Standalone 6GB VoxCPM2 runtime did not restore from the saved profile",
		});

		const installation = await tauriInvoke<{
			canStart: boolean;
			steps: Array<{
				id: string;
				state: string;
				failure?: { code: string };
			}>;
		}>("voxcpm2_installation_status");
		if (!installation.canStart) {
			throw new Error(
				`standalone VoxCPM2 prerequisites: ${JSON.stringify(installation)}`,
			);
		}
		const host = await tauriInvoke<{ profile: string | null; gpus: unknown[] }>(
			"voice_host_profile",
		);
		expect(host.profile).toBe("linux_trt_6g");
		expect(host.gpus.length).toBeGreaterThanOrEqual(1);
		const ready = JSON.parse(
			await tauriInvoke<string>("start_voxcpm2", {
				expectedLoaderProfile: host.profile,
			}),
		) as {
			service?: string;
			capabilities?: string[];
			port?: number;
			local_access_token?: string;
		};
		expect(ready).toMatchObject({
			service: "voxcpm2-tensorrt",
			capabilities: ["tts"],
			port: 8910,
		});
		expect(ready.local_access_token).toMatch(/^[a-f0-9]{64}$/);

		const health = (await fetch("http://127.0.0.1:8910/health").then(
			(response) => response.json(),
		)) as { service: string; capabilities: string[]; ready: boolean };
		expect(health).toMatchObject({
			service: "voxcpm2-tensorrt",
			capabilities: ["tts"],
			ready: true,
		});
		await expect(fetch("http://127.0.0.1:8902/health")).rejects.toThrow();

		const unauthenticated = await fetch("http://127.0.0.1:8910/ref/voices");
		expect(unauthenticated.status).toBe(401);
		const authorization = `Bearer ${ready.local_access_token}`;
		const voiceBase64 = TEST_VOICE_PATH
			? readFileSync(TEST_VOICE_PATH).toString("base64")
			: "";
		if (voiceBase64) {
			const installedVoice = await fetch("http://127.0.0.1:8910/voice", {
				method: "PUT",
				headers: {
					Authorization: authorization,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ audio_base64: voiceBase64 }),
			});
			expect(installedVoice.status).toBe(200);
		}
		const voices = (await fetch("http://127.0.0.1:8910/ref/voices", {
			headers: { Authorization: authorization },
		}).then((response) => response.json())) as { voices?: unknown[] };
		// 0.2.2 thin runtime ships the complete approved CC0 reference palette
		// (FR-V017.37) — the facade must expose all eight voices with the
		// canonical default, not an empty list.
		const palette = (voices.voices ?? []) as {
			name?: string;
			default?: boolean;
		}[];
		expect(palette.map((voice) => voice.name)).toEqual([
			"cc0-ko-female-01",
			"cc0-ko-female-02",
			"cc0-ko-female-03",
			"cc0-ko-male-01",
			"cc0-ko-male-02",
			"cc0-ko-male-03",
			"cc0-ko-male-04",
			"cc0-ko-male-05",
		]);
		expect(palette[0]?.default).toBe(true);
		await browser.execute(
			(base64: string, token: string) => {
				if (base64) localStorage.setItem("naia.voiceRefAudioB64", base64);
				sessionStorage.setItem("naia.voxcpm2AccessToken", token);
			},
			voiceBase64,
			ready.local_access_token as string,
		);

		await browser.execute(() => {
			(
				document.querySelector(".app-bar-settings") as HTMLButtonElement | null
			)?.click();
		});
		await $("[data-settings-tab='voice']").waitForDisplayed({
			timeout: 30_000,
		});
		await browser.execute(() => {
			(
				document.querySelector(
					"[data-settings-tab='voice']",
				) as HTMLButtonElement | null
			)?.click();
		});
		// A fresh boot intentionally normalizes a gated local provider before the
		// secure member key is hydrated. Select it through the actual customer UI
		// after activation instead of forcing localStorage behind React's state.
		const ttsProvider = await $("#tts-provider-select");
		await ttsProvider.waitForDisplayed({ timeout: 30_000 });
		await ttsProvider.selectByAttribute("value", "naia-local-voice");
		await browser.waitUntil(
			async () => (await ttsProvider.getValue()) === "naia-local-voice",
			{
				timeout: 30_000,
				timeoutMsg: "Naia Local provider was not selected through Settings",
			},
		);
		const ttsToggle = await $("#tts-toggle");
		if (!(await ttsToggle.isSelected())) await ttsToggle.click();
		await $("[data-testid='ref-audio-file-button']").waitForDisplayed({
			timeout: 30_000,
			timeoutMsg: "Naia Local audio-file attachment control did not render",
		});
		await expect($("[data-testid='ref-audio-file-input']")).toHaveAttribute(
			"accept",
			"audio/*",
		);
		if ((voices.voices?.length ?? 0) > 0) {
			await browser.waitUntil(
				() =>
					browser.execute(() => {
						const details = Array.from(
							document.querySelectorAll("details"),
						).find((item) =>
							/Pick from presets|프리셋에서 고르기/.test(
								item.textContent ?? "",
							),
						);
						if (!details) return false;
						details.open = true;
						details.dispatchEvent(new Event("toggle", { bubbles: true }));
						return true;
					}),
				{
					timeout: 30_000,
					timeoutMsg: "Local voice preset section did not render",
				},
			);
			// The preset picker is the PUBLIC cloud catalog by design — binding it
			// to the engine's auth-gated /ref/audio made browse/preview dead until
			// the ~77s model load (a shipped regression, since removed). The
			// engine-independent contract: rows render from the catalog, and
			// applying a preset persists its public sampleUrl as the active voice.
			await browser.waitUntil(
				() =>
					browser.execute(
						() => document.querySelectorAll(".ref-preset-item").length > 0,
					),
				{
					timeout: 30_000,
					timeoutMsg: "Local voice preset rows did not render",
				},
			);
			await browser.execute(() => {
				const row = document.querySelector(".ref-preset-item");
				const apply = row?.querySelectorAll("button").item(1);
				if (apply instanceof HTMLButtonElement) apply.click();
			});
			await browser.waitUntil(
				() =>
					browser.execute(() => {
						const config = JSON.parse(
							localStorage.getItem("naia-config") ?? "{}",
						);
						return /\.wav($|\?)/i.test(String(config.voiceRefUrl ?? ""));
					}),
				{
					timeout: 30_000,
					timeoutMsg: "Selected local voice was not persisted",
				},
			);
		}
		// The file-backed config is authoritative on boot. Reload only after the
		// debounced persistence boundary, then prove the user voice survives
		// startup hydration before asking the external LLM for speech.
		await browser.pause(1_200);
		await browser.refresh();
		await browser.waitUntil(
			() => browser.execute(() => document.querySelector(".app-root") !== null),
			{
				timeout: 30_000,
				timeoutMsg: "Shell app root did not restore after preset selection",
			},
		);
		await browser.waitUntil(
			() =>
				browser.execute(() => {
					const config = JSON.parse(
						localStorage.getItem("naia-config") ?? "{}",
					);
					// Applying a preset supersedes the seeded custom clip by design
					// (it clears the ADK copy and persists the public sampleUrl), so
					// the surviving reference voice is EITHER the custom B64 or the
					// applied preset URL — never neither.
					const refB64 = localStorage.getItem("naia.voiceRefAudioB64");
					const refUrl = String(config.voiceRefUrl ?? "");
					return (
						config.ttsEnabled === true &&
						(refB64 !== null || /\.wav($|\?)/i.test(refUrl)) &&
						sessionStorage.getItem("naia.voxcpm2AccessToken") !== null
					);
				}),
			{
				timeout: 30_000,
				timeoutMsg: "User local voice did not survive startup hydration",
			},
		);
		expect(await tauriInvoke<boolean>("voxcpm2_status")).toBe(true);
		await browser.execute(() => {
			(
				document.querySelector(
					".chat-tab:first-child",
				) as HTMLButtonElement | null
			)?.click();
		});

		await browser.execute(() => {
			const shell = window as typeof window & {
				__voice6gFetches?: Array<{
					path: string;
					status?: number;
					voice?: string;
					text?: string;
					streamingAtRequest: boolean;
				}>;
			};
			shell.__voice6gFetches = [];
			const original = window.fetch.bind(window);
			window.fetch = async (...args) => {
				const request = args[0];
				const raw =
					typeof request === "string"
						? request
						: request instanceof Request
							? request.url
							: String(request);
				let event:
					| {
							path: string;
							status?: number;
							voice?: string;
							text?: string;
							streamingAtRequest: boolean;
					  }
					| undefined;
				try {
					const init = args[1];
					const body =
						typeof init?.body === "string" ? JSON.parse(init.body) : {};
					event = {
						path: new URL(raw).pathname,
						voice: typeof body.voice === "string" ? body.voice : undefined,
						text: typeof body.input === "string" ? body.input : undefined,
						streamingAtRequest:
							document.querySelector(".chat-message.assistant.streaming") !==
							null,
					};
					shell.__voice6gFetches?.push(event);
				} catch {
					// Non-URL fetches are irrelevant to the local TRT assertion.
				}
				const response = await original(...args);
				if (event) event.status = response.status;
				return response;
			};
		});

		await sendMessage(
			"Respond with exactly these two sentences and nothing else: 6GB voice profile is ready. Sentence streaming is verified.",
			{ completedMessageTimeoutMs: 360_000 },
		);
		await browser.waitUntil(
			() =>
				browser.execute(() => {
					const events =
						(
							window as typeof window & {
								__voice6gFetches?: Array<{ path: string; status: number }>;
							}
						).__voice6gFetches ?? [];
					return (
						events.filter(
							(event) =>
								event.path === "/v1/audio/speech" && event.status === 200,
						).length === 2
					);
				}),
			{
				timeout: 360_000,
				timeoutMsg: "Shell chat never synthesized the external LLM reply",
			},
		);
		const paths = await browser.execute(
			() =>
				(
					window as typeof window & {
						__voice6gFetches?: Array<{
							path: string;
							status?: number;
							voice?: string;
							text?: string;
							streamingAtRequest: boolean;
						}>;
					}
				).__voice6gFetches ?? [],
		);
		expect(paths.some((event) => event.path === "/stream")).toBe(false);
		const speechRequests = paths.filter(
			(event) => event.path === "/v1/audio/speech" && event.status === 200,
		);
		expect(speechRequests).toHaveLength(2);
		// The test genuinely applies a catalog preset above, which supersedes the
		// PUT-installed custom clip — so the engine must speak with the LAST
		// APPLIED voice (the preset's file basename), not the "current" custom
		// slot. Read the applied voice back from the persisted config so the
		// assertion follows the user's actual selection.
		const appliedVoice = await browser.execute(() => {
			const config = JSON.parse(localStorage.getItem("naia-config") ?? "{}");
			const url = String(config.voiceRefUrl ?? "");
			return url ? (url.split("/").pop() ?? "current") : "current";
		});
		expect(speechRequests.map((event) => event.voice)).toEqual([
			appliedVoice,
			appliedVoice,
		]);
		expect(speechRequests.map((event) => event.text)).toEqual([
			"6GB voice profile is ready.",
			"Sentence streaming is verified.",
		]);
		expect(speechRequests[0]?.streamingAtRequest).toBe(true);
		await browser.waitUntil(
			() =>
				browser.execute(() => {
					const avatar = document.querySelector<HTMLElement>(
						"[data-avatar-loaded]",
					);
					return avatar?.dataset.avatarLoaded === "true";
				}),
			{
				timeout: 90_000,
				timeoutMsg: "Shell 3D VRM did not become visible",
			},
		);
		expect(await $("[data-video-avatar]").isExisting()).toBe(false);
		expect(
			await $("[data-avatar-loaded]").getAttribute("data-avatar-model-path"),
		).toMatch(/[\\/]01-OL_Woman\.vrm$/);
		await browser.waitUntil(
			async () =>
				(await $("[data-avatar-loaded]").getAttribute("data-avatar-loaded")) ===
				"true",
			{
				timeout: 30_000,
				timeoutMsg: "Shell 3D VRM did not remain visible after speech",
			},
		);
		if (process.env.NAIA_E2E_VOICE_SCREENSHOT) {
			await browser.saveScreenshot(process.env.NAIA_E2E_VOICE_SCREENSHOT);
		}
	});
});
