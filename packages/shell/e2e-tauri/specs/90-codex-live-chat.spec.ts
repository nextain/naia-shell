import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
	CODEX_E2E_MODEL,
	E2E_WORKSPACE,
} from "../codex-e2e-environment.js";
import {
	countCompletedAssistantMessages,
	getNewAssistantMessages,
	sendMessage,
} from "../helpers/chat.js";
import { S } from "../helpers/selectors.js";

const RESPONSE_MARKER = "NAIA_SHELL_CODEX_E2E_OK_20260722";
const SECOND_RESPONSE_MARKER = "NAIA_SHELL_CODEX_SECOND_TURN_OK_20260722";
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
		if (!adkPath)
			throw new Error("NAIA_E2E_ADK_PATH is required for Codex live E2E");
		expect(resolve(adkPath)).toBe(E2E_WORKSPACE);
		const appRoot = await $(S.appRoot);
		await appRoot.waitForDisplayed({ timeout: 45_000 });
		const seeded = JSON.parse(
			readFileSync(resolve(adkPath, "naia-settings/config.json"), "utf8"),
		);
		expect(seeded.provider).toBe("codex");
		// 심는 쪽(codex-e2e-environment)과 같은 값을 본다. 모델 글자를 여기 따로
		// 적어 두었더니 기본 모델이 바뀐 뒤로 before 에서 곧장 죽었다.
		expect(seeded.model).toBe(CODEX_E2E_MODEL);
		await browser.execute(
			(path: string, config: Record<string, unknown>) => {
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
			},
			adkPath,
			seeded,
		);
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
		await waitForRunLog(`loaded=true codex/${CODEX_E2E_MODEL}`);
	});

	it("renders two consecutive real Codex turns in the embedded Windows UI", async () => {
		const before = await countCompletedAssistantMessages();
		logStart = statSync(logPath).size;
		await sendMessage(
			`Respond with exactly ${RESPONSE_MARKER} and nothing else.`,
		);
		await waitForRunLog("[E2E-DEBUG] chat_request requestId=");
		const requestMatch = readCurrentRunLog().match(
			/\[E2E-DEBUG\] chat_request requestId=([^ ]+) provider=codex\b/,
		);
		expect(requestMatch).not.toBeNull();
		const requestId = requestMatch?.[1] ?? "";
		await waitForRunLog(
			`[E2E-DEBUG] agent_event requestId=${requestId} type=usage`,
		);
		await waitForRunLog(
			`[E2E-DEBUG] agent_event requestId=${requestId} type=finish`,
		);
		const text = (await getNewAssistantMessages(before)).at(-1) ?? "";
		expect(text).toContain(RESPONSE_MARKER);
		expect(text).not.toMatch(
			/login required|API key|Bad Request|provider error|failed:|\b40[0-9]\b|\b500\b/i,
		);

		// Regression boundary: production reports showed that the first local or
		// remote answer could succeed while the second request failed with a
		// malformed-request error. Keep the same Shell/Agent session and require a
		// fresh request, usage, finish, and visible answer for turn two.
		const beforeSecondTurn = await countCompletedAssistantMessages();
		logStart = statSync(logPath).size;
		await sendMessage(
			`Respond with exactly ${SECOND_RESPONSE_MARKER} and nothing else.`,
		);
		await waitForRunLog("[E2E-DEBUG] chat_request requestId=");
		const secondRequestMatch = readCurrentRunLog().match(
			/\[E2E-DEBUG\] chat_request requestId=([^ ]+) provider=codex\b/,
		);
		expect(secondRequestMatch).not.toBeNull();
		const secondRequestId = secondRequestMatch?.[1] ?? "";
		expect(secondRequestId).not.toBe(requestId);
		await waitForRunLog(
			`[E2E-DEBUG] agent_event requestId=${secondRequestId} type=usage`,
		);
		await waitForRunLog(
			`[E2E-DEBUG] agent_event requestId=${secondRequestId} type=finish`,
		);
		const secondText =
			(await getNewAssistantMessages(beforeSecondTurn)).at(-1) ?? "";
		expect(secondText).toContain(SECOND_RESPONSE_MARKER);
		expect(secondText).not.toMatch(
			/\[오류\]|login required|API key|Bad Request|provider error|failed:|\b40[0-9]\b|\b500\b/i,
		);
		// The provider does not promise token counts. A real usage event plus the
		// rendered response is the cross-process assertion; do not invent tokens.
	});
});
