import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
	countCompletedAssistantMessages,
	getNewAssistantMessages,
	sendMessage,
} from "../helpers/chat.js";
import { S } from "../helpers/selectors.js";

const RESPONSE_MARKER = "NAIA_SHELL_CODEX_E2E_OK_20260722";
const adkPath = process.env.NAIA_E2E_ADK_PATH;
let logPath = "";
let logStart = 0;

async function tauriInvoke<T>(
	command: string,
	args: Record<string, unknown> = {},
): Promise<T> {
	return (await browser.execute(
		async (cmd: string, payload: Record<string, unknown>) => {
			const w = window as unknown as {
				__TAURI_INTERNALS__?: {
					invoke: (name: string, value: unknown) => Promise<unknown>;
				};
				__TAURI__?: {
					core?: { invoke: (name: string, value: unknown) => Promise<unknown> };
				};
			};
			const invoke = w.__TAURI_INTERNALS__?.invoke ?? w.__TAURI__?.core?.invoke;
			if (!invoke) throw new Error("Tauri invoke unavailable");
			return invoke(cmd, payload);
		},
		command,
		args,
	)) as T;
}

function readCurrentRunLog(): string {
	if (!logPath) return "";
	try {
		return readFileSync(logPath).subarray(logStart).toString("utf8");
	} catch {
		return "";
	}
}

async function waitForRunLog(fragment: string): Promise<void> {
	await browser.waitUntil(() => readCurrentRunLog().includes(fragment), {
		timeout: 20_000,
		timeoutMsg: `Naia runtime log did not contain: ${fragment}`,
	});
}

describe("Codex live chat through the isolated real Naia Shell", () => {
	before(async () => {
		if (!adkPath) throw new Error("NAIA_E2E_ADK_PATH is required for Codex live E2E");
		expect(adkPath).toContain(
			resolve(process.env.USERPROFILE ?? "", ".naia", "run", "codex-live-e2e"),
		);
		const appRoot = await $(S.appRoot);
		await appRoot.waitForDisplayed({ timeout: 45_000 });
		const seeded = JSON.parse(
			readFileSync(resolve(adkPath, "naia-settings/config.json"), "utf8"),
		);
		expect(seeded.provider).toBe("codex");
		expect(seeded.model).toBe("gpt-5.4");
		await browser.execute((path: string, config: Record<string, unknown>) => {
			localStorage.setItem("naia-adk-path", path);
			localStorage.setItem(
				"naia-config",
				JSON.stringify({
					...config,
					enableTools: false,
					ttsEnabled: false,
					locale: "ko",
					onboardingComplete: true,
					workspaceRoot: path,
				}),
			);
			window.dispatchEvent(new CustomEvent("naia-config-changed"));
		}, adkPath, seeded);
		const chatInput = await $(S.chatInput);
		await chatInput.waitForEnabled({ timeout: 90_000 });
		logPath = await tauriInvoke<string>("get_gateway_log_path");
		try {
			logStart = statSync(logPath).size;
		} catch {
			logStart = 0;
		}
		await tauriInvoke("send_to_agent_command", {
			message: JSON.stringify({ type: "reload_settings" }),
		});
		await waitForRunLog("loaded=true codex/gpt-5.4");
	});

	it("boots the embedded Windows UI and renders a real Codex response", async () => {
		const before = await countCompletedAssistantMessages();
		logStart = statSync(logPath).size;
		await sendMessage(`Respond with exactly ${RESPONSE_MARKER} and nothing else.`);
		await waitForRunLog("[E2E-DEBUG] chat_request requestId=");
		const requestMatch = readCurrentRunLog().match(
			/\[E2E-DEBUG\] chat_request requestId=([^ ]+) provider=codex\b/,
		);
		expect(requestMatch).not.toBeNull();
		const requestId = requestMatch?.[1] ?? "";
		await waitForRunLog(`[E2E-DEBUG] agent_event requestId=${requestId} type=usage`);
		await waitForRunLog(`[E2E-DEBUG] agent_event requestId=${requestId} type=finish`);
		const text = (await getNewAssistantMessages(before)).at(-1) ?? "";
		expect(text).toContain(RESPONSE_MARKER);
		expect(text).not.toMatch(
			/login required|API key|Bad Request|provider error|failed:|\b40[0-9]\b|\b500\b/i,
		);
		// The provider does not promise token counts. A real usage event plus the
		// rendered response is the cross-process assertion; do not invent tokens.
	});
});
