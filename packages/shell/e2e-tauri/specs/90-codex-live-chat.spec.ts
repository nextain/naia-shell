import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
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
let logPath = "";
let logStart = 0;

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

function readCurrentRunLog(): string {
	if (!logPath) return "";
	try {
		// stat size is bytes, not UTF-16 string indices. Slice the Buffer first so
		// Korean log lines before this run cannot shift the provenance window.
		return readFileSync(logPath).subarray(logStart).toString("utf8");
	} catch {
		return "";
	}
}

async function waitForRunLog(fragment: string): Promise<void> {
	await browser.waitUntil(() => readCurrentRunLog().includes(fragment), {
		timeout: 15_000,
		timeoutMsg: `Naia runtime log did not contain: ${fragment}`,
	});
}

describe("90 — Codex live chat through the real Naia Shell", () => {
	before(async () => {
		const appRoot = await $(S.appRoot);
		await appRoot.waitForDisplayed({ timeout: 30_000 });
		adkPath = readFileSync(resolve(homedir(), ".naia/adk-path"), "utf8").trim();
		if (!adkPath) throw new Error("ADK path unavailable for Codex live E2E");
		originalLocalConfig = await browser.execute(
			() => localStorage.getItem("naia-config") ?? "",
		);
		originalFileConfig = await tauriInvoke<string>("read_naia_config", {
			adkPath,
		});
		const uiConfig = await tauriInvoke<string>("read_naia_ui_config", {
			adkPath,
		});
		await browser.execute(
			(path: string, fileRaw: string, uiRaw: string) => {
				const file = fileRaw ? JSON.parse(fileRaw) : {};
				const ui = uiRaw ? JSON.parse(uiRaw) : {};
				localStorage.setItem("naia-adk-path", path);
				localStorage.setItem(
					"naia-config",
					JSON.stringify({
						...file,
						...ui,
						onboardingComplete: true,
						workspaceRoot: path,
					}),
				);
				location.reload();
			},
			adkPath,
			originalFileConfig,
			uiConfig,
		);
		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 60_000 });
		// File-backed settings hydrate asynchronously and are the authority. Capture
		// only after the initial boot merge so the test cannot overwrite a user's
		// settings with a stale localStorage cache.
		await browser.pause(1_500);

		logPath = await tauriInvoke<string>("get_gateway_log_path");
		try {
			logStart = statSync(logPath).size;
		} catch {
			logStart = 0;
		}
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
		await browser.execute(
			(next: Record<string, unknown>) => {
				localStorage.setItem("naia-config", JSON.stringify(next));
				window.dispatchEvent(new CustomEvent("naia-config-changed"));
			},
			{
				...currentLocal,
				...codexFileConfig,
				enableTools: false,
				ttsEnabled: false,
				locale: "ko",
				onboardingComplete: true,
			},
		);
		await reloadAgentSettings();
		await waitForRunLog("loaded=true codex/gpt-5.4");
		// Recovery acceptance mode: terminate the worker after the real config
		// mutation, before Mocha can run `after`. The launcher-level onComplete
		// hook must restore the durable backup without help from this process.
		if (process.env.NAIA_CODEX_E2E_SIMULATE_WORKER_CRASH === "1") {
			process.exit(86);
		}
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
		// eslint-disable-next-line no-console
		console.log("[codex-live-e2e] restore command completed");
		const restored = await tauriInvoke<string>("read_naia_config", { adkPath });
		expect(JSON.parse(restored || "{}")).toEqual(
			JSON.parse(originalFileConfig || "{}"),
		);
		const restoredLocal = await browser.execute(
			() => localStorage.getItem("naia-config") ?? "",
		);
		expect(restoredLocal).toBe(originalLocalConfig);
		// eslint-disable-next-line no-console
		console.log("[codex-live-e2e] file/local restoration verified");
		const original = JSON.parse(originalFileConfig || "{}");
		if (original.provider && original.model) {
			await waitForRunLog(`loaded=true ${original.provider}/${original.model}`);
		}
		// eslint-disable-next-line no-console
		console.log("[codex-live-e2e] provider restoration verified");
		// End the native session while the worker is still in a bounded hook. On
		// WebKitGTK, leaving shutdown entirely to WDIO can retain the Tauri output
		// stream until the worker exhausts its heap after an otherwise passing test.
		await browser.deleteSession();
	});

	it("renders a real Codex response and usage in the Shell chat UI", async () => {
		const before = await countCompletedAssistantMessages();
		await sendMessage(
			`운영 종단간 검증입니다. 다른 설명이나 마크다운 없이 정확히 ${RESPONSE_MARKER} 만 응답하세요.`,
		);
		await waitForRunLog("[E2E-DEBUG] chat_request provider=codex");
		const messages = await getNewAssistantMessages(before);
		const text = messages.at(-1) ?? "";
		// eslint-disable-next-line no-console
		console.log(
			`=== NAIA SHELL CODEX RESPONSE ===\n${text}\n==================================`,
		);
		expect(text).toContain(RESPONSE_MARKER);
		expect(text).not.toMatch(
			/\[오류\]|login required|API key|Bad Request|provider error|failed:|\b40[0-9]\b|\b500\b/i,
		);

		const tokens = await browser.execute((newMessageIndex: number) => {
			const completed = document.querySelectorAll(
				".chat-message.assistant:not(.streaming)",
			);
			const newMessage = completed[newMessageIndex];
			if (!newMessage) return 0;
			const badge = newMessage.querySelector(".cost-badge");
			const label = badge?.textContent ?? "";
			const match = label.match(/(\d[\d,]*)\s*(?:토큰|tokens?)/i);
			return match ? Number(match[1].replace(/,/g, "")) : 0;
		}, before);
		expect(tokens).toBeGreaterThan(0);
		const runLog = readCurrentRunLog();
		expect(runLog).toContain("loaded=true codex/gpt-5.4");
		expect(runLog).toContain("[E2E-DEBUG] chat_request provider=codex");
	});
});
