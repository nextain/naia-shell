import {
	countCompletedAssistantMessages,
	getNewAssistantMessages,
	sendMessage,
} from "../helpers/chat.js";
import { S } from "../helpers/selectors.js";

const RESPONSE_MARKER = "NAIA_SHELL_CODEX_E2E_OK_20260721";

let adkPath = "";
let originalFileConfig = "";
let originalLocalConfig = "";
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
			const invoke = w.__TAURI_INTERNALS__?.invoke ?? w.__TAURI__?.core?.invoke;
			if (!invoke) throw new Error("Tauri invoke unavailable");
			return invoke(cmd, a);
		},
		command,
		args,
	)) as T;
}

async function reloadAgentSettings(): Promise<void> {
	await tauriInvoke("send_to_agent_command", {
		message: JSON.stringify({ type: "reload_settings" }),
	});
	await browser.pause(2_000);
}

describe("90 — Codex live chat through the real Naia Shell", () => {
	before(async () => {
		const appRoot = await $(S.appRoot);
		await appRoot.waitForDisplayed({ timeout: 30_000 });
		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 60_000 });
		// File-backed settings hydrate asynchronously and are the authority. Capture
		// only after the initial boot merge so the test cannot overwrite a user's
		// settings with a stale localStorage cache.
		await browser.pause(1_500);

		const snapshot = await browser.execute(() => ({
			adkPath: localStorage.getItem("naia-adk-path") ?? "",
			localConfig: localStorage.getItem("naia-config") ?? "",
		}));
		adkPath = snapshot.adkPath;
		originalLocalConfig = snapshot.localConfig;
		if (!adkPath) throw new Error("ADK path unavailable for Codex live E2E");

		originalFileConfig = await tauriInvoke<string>("read_naia_config", {
			adkPath,
		});
		snapshotCaptured = true;
		const current = originalFileConfig ? JSON.parse(originalFileConfig) : {};
		const currentLocal = originalLocalConfig
			? JSON.parse(originalLocalConfig)
			: {};
		const codexRole = {
			provider: "codex",
			model: "gpt-5.4",
			credentialRef: "codex-login",
		};
		const codexFileConfig = {
			...current,
			provider: "codex",
			model: "gpt-5.4",
			NAIA_MAIN_PROVIDER: "codex",
			NAIA_MAIN_MODEL: "gpt-5.4",
			llmRoles: {
				...(current.llmRoles ?? {}),
				main: codexRole,
			},
		};
		await tauriInvoke("write_naia_config", {
			adkPath,
			json: JSON.stringify(codexFileConfig, null, 2),
		});
		await browser.execute((next: Record<string, unknown>) => {
			localStorage.setItem("naia-config", JSON.stringify(next));
			window.dispatchEvent(new CustomEvent("naia-config-changed"));
		}, {
			...currentLocal,
			...codexFileConfig,
			enableTools: false,
			ttsEnabled: false,
			locale: "ko",
			onboardingComplete: true,
		});
		await reloadAgentSettings();
	});

	after(async () => {
		if (!snapshotCaptured) return;
		await tauriInvoke("write_naia_config", {
			adkPath,
			json: originalFileConfig,
		});
		await browser.execute((raw: string) => {
			if (raw) localStorage.setItem("naia-config", raw);
			else localStorage.removeItem("naia-config");
			window.dispatchEvent(new CustomEvent("naia-config-changed"));
		}, originalLocalConfig);
		await reloadAgentSettings();
	});

	it("renders a real Codex response and usage in the Shell chat UI", async () => {
		const before = await countCompletedAssistantMessages();
		await sendMessage(
			`운영 종단간 검증입니다. 다른 설명이나 마크다운 없이 정확히 ${RESPONSE_MARKER} 만 응답하세요.`,
		);
		const messages = await getNewAssistantMessages(before);
		const text = messages.at(-1) ?? "";
		// eslint-disable-next-line no-console
		console.log(`=== NAIA SHELL CODEX RESPONSE ===\n${text}\n==================================`);
		expect(text).toContain(RESPONSE_MARKER);
		expect(text).not.toMatch(
			/\[오류\]|login required|API key|Bad Request|provider error|failed:|\b40[0-9]\b|\b500\b/i,
		);

		const tokens = await browser.execute(() => {
			const badges = document.querySelectorAll(
				".chat-message.assistant:not(.streaming) .cost-badge",
			);
			const last = badges[badges.length - 1]?.textContent ?? "";
			const match = last.match(/(\d[\d,]*)\s*(?:토큰|tokens?)/i);
			return match ? Number(match[1].replace(/,/g, "")) : 0;
		});
		expect(tokens).toBeGreaterThan(0);
	});
});
