import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { getLastAssistantMessage, sendMessage } from "../helpers/chat.js";
import { S } from "../helpers/selectors.js";

/**
 * 89 — LLM Provider Switching E2E (#60)
 *
 * Verifies each LLM provider can receive a chat response.
 * - Sets provider + model + API key in localStorage
 * - Refreshes app
 * - Sends message, verifies response
 * - Captures response content and errors for debugging
 * - Restores original config after all tests
 *
 * Observability (multiple methods):
 * 1. CAFE_DEBUG_E2E=1 → Rust logs all agent events to ~/.naia/logs/naia.log
 * 2. agent logLlm() → ~/.naia/logs/llm-debug.log (provider+model+error per request)
 * 3. log_entry chunks → DiagnosticsTab / ui-message-trace.ndjson
 * 4. Screenshots → e2e-tauri/.artifacts/screenshots/ (on success + failure)
 * 5. Browser console logs → appended to e2e-tauri/.artifacts/browser-console.ndjson
 *
 * Does NOT touch STT/TTS — pure LLM verification.
 */

const ARTIFACTS_DIR = resolve(import.meta.dirname, "../.artifacts");
const SCREENSHOTS_DIR = resolve(ARTIFACTS_DIR, "screenshots");
const BROWSER_LOG_FILE = resolve(ARTIFACTS_DIR, "browser-console.ndjson");
const LLM_LOG_PATH = resolve(homedir(), ".naia/logs/llm-debug.log");

function ensureArtifactDirs(): void {
	mkdirSync(SCREENSHOTS_DIR, { recursive: true });
	mkdirSync(ARTIFACTS_DIR, { recursive: true });
}

/** Save screenshot to .artifacts/screenshots/{name}.png */
async function screenshot(name: string): Promise<void> {
	try {
		ensureArtifactDirs();
		const path = resolve(SCREENSHOTS_DIR, `${name}.png`);
		await browser.saveScreenshot(path);
		console.log(`[89:screenshot] Saved: ${path}`);
	} catch (e) {
		console.warn(`[89:screenshot] Failed to save ${name}: ${e}`);
	}
}

/** Dump browser console logs to .artifacts/browser-console.ndjson */
async function dumpBrowserLogs(context: string): Promise<void> {
	try {
		ensureArtifactDirs();
		const logs = await browser.getLogs("browser");
		if (logs.length === 0) return;
		const lines = logs
			.map((entry) =>
				JSON.stringify({ ts: new Date().toISOString(), context, ...entry }),
			)
			.join("\n");
		appendFileSync(BROWSER_LOG_FILE, `${lines}\n`);
		const errors = logs.filter(
			(l) => l.level === "SEVERE" || l.level === "ERROR",
		);
		if (errors.length > 0) {
			console.error(`[89:browserlog] ${context} — ${errors.length} error(s):`);
			for (const e of errors) console.error(`  [${e.level}] ${e.message}`);
		}
	} catch {
		// getLogs may be unsupported in some WebKit versions — ignore
	}
}

/** Read last N lines of ~/.naia/logs/llm-debug.log and print them */
function printLlmDebugLog(lastN = 20): void {
	try {
		if (!existsSync(LLM_LOG_PATH)) {
			console.log("[89:llm-log] ~/.naia/logs/llm-debug.log not found yet");
			return;
		}
		const lines = readFileSync(LLM_LOG_PATH, "utf-8").trim().split("\n");
		const tail = lines.slice(-lastN);
		console.log(`[89:llm-log] Last ${tail.length} entries from llm-debug.log:`);
		for (const line of tail) {
			try {
				const entry = JSON.parse(line) as Record<string, unknown>;
				console.log(
					`  ${entry.ts} [${entry.event}] provider=${entry.provider} model=${entry.model}${entry.error ? ` ERROR=${entry.error}` : ""}${entry.durationMs != null ? ` ${entry.durationMs}ms` : ""}${entry.textLen != null ? ` textLen=${entry.textLen}` : ""}`,
				);
			} catch {
				console.log(`  ${line}`);
			}
		}
	} catch (e) {
		console.warn(`[89:llm-log] Failed to read llm-debug.log: ${e}`);
	}
}

const TEST_PROVIDERS: {
	provider: string;
	model: string;
	label: string;
	keyEnv?: string;
	keyField?: "apiKey" | "naiaKey";
	extraConfig?: Record<string, unknown>;
}[] = [
	{
		provider: "gemini",
		model: "gemini-2.5-flash",
		label: "Gemini 2.5 Flash",
		keyEnv: "GEMINI_API_KEY",
	},
	{
		provider: "openai",
		model: "gpt-4o",
		label: "OpenAI GPT-4o",
		keyEnv: "OPENAI_API_KEY",
	},
	{
		provider: "anthropic",
		model: "claude-haiku-4-5-20251001",
		label: "Anthropic Haiku",
		keyEnv: "ANTHROPIC_API_KEY",
	},
	{
		provider: "xai",
		model: "grok-3-mini",
		label: "xAI Grok 3 Mini",
		keyEnv: "XAI_API_KEY",
	},
	{
		provider: "zai",
		model: "glm-4.7",
		label: "Zhipu AI GLM-4.7",
		keyEnv: "ZHIPU_API_KEY",
	},
	{
		provider: "nextain",
		model: "gemini-2.5-flash",
		label: "Nextain (lab-proxy)",
		keyEnv: "NAIA_API_KEY",
		keyField: "naiaKey",
	},
	{
		provider: "ollama",
		model: "qwen3.5:9b",
		label: "Ollama qwen3.5:9b",
		extraConfig: { ollamaHost: "http://localhost:11434" },
	},
	{
		provider: "vllm",
		model: "Qwen/Qwen2.5-1.5B-Instruct",
		label: "vLLM (localhost:8000)",
		extraConfig: { vllmHost: "http://localhost:8000" },
	},
	{
		provider: "claude-code-cli",
		model: "claude-sonnet-4-6",
		label: "Claude Code CLI",
	},
];

function getApiKey(envName?: string): string {
	if (!envName) return "";
	return process.env[envName] ?? "";
}

/** Read current config from localStorage */
async function readConfig(): Promise<Record<string, unknown>> {
	return browser.execute(() => {
		const raw = localStorage.getItem("naia-config");
		return raw ? JSON.parse(raw) : {};
	});
}

/** Write config to localStorage */
async function writeConfig(patch: Record<string, unknown>): Promise<void> {
	await browser.execute((patchStr: string) => {
		const raw = localStorage.getItem("naia-config");
		const config = raw ? JSON.parse(raw) : {};
		Object.assign(config, JSON.parse(patchStr));
		localStorage.setItem("naia-config", JSON.stringify(config));
	}, JSON.stringify(patch));
}

/** Refresh app and wait for chat input to be ready */
async function refreshAndWaitForChat(): Promise<void> {
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			await browser.refresh();
			break;
		} catch {
			if (attempt === 2)
				throw new Error("browser.refresh() failed after 3 attempts");
			await browser.pause(2_000);
		}
	}

	// Wait for onboarding overlay to disappear
	await browser.waitUntil(
		async () =>
			browser.execute(
				(sel: string) => !document.querySelector(sel),
				S.onboardingOverlay,
			),
		{
			timeout: 30_000,
			timeoutMsg: "Onboarding overlay still visible after 30s",
		},
	);

	// Wait for tabs to render, then explicitly click the chat tab
	await browser.waitUntil(
		async () =>
			browser.execute(
				() => document.querySelectorAll(".chat-tabs .chat-tab").length >= 1,
			),
		{ timeout: 20_000, timeoutMsg: "Chat tabs not rendered after 20s" },
	);
	// Click the first (chat) tab to ensure it is active
	await browser.execute((sel: string) => {
		const el = document.querySelector(sel) as HTMLElement | null;
		if (el) el.click();
	}, S.chatTab);
	await browser.pause(1_000);

	// Diagnose what's visible before waiting for chat input
	const domState = await browser.execute((chatSel: string) => {
		const chatInput = document.querySelector(chatSel);
		const body = document.body.className;
		const activeTab =
			document.querySelector(".chat-tab.active")?.className ?? "(none)";
		const chatPanel = document.querySelector(".chat-panel");
		const chatInputStyle = chatInput
			? window.getComputedStyle(chatInput).display
			: "(not in DOM)";
		return {
			chatInputExists: !!chatInput,
			chatInputDisplay: chatInputStyle,
			activeTab,
			chatPanelExists: !!chatPanel,
			bodyClass: body,
			tabCount: document.querySelectorAll(".chat-tabs .chat-tab").length,
		};
	}, S.chatInput);
	console.log(`[89] DOM state after tab click: ${JSON.stringify(domState)}`);

	// Wait for chat input — use waitForExist first to diagnose
	const chatInput = await $(S.chatInput);
	await chatInput.waitForExist({ timeout: 30_000 });
	await chatInput.waitForDisplayed({ timeout: 30_000 });
}

/** Capture current app state for debugging */
async function captureAppState(): Promise<{
	provider: string;
	model: string;
	hasApiKey: boolean;
	hasNaiaKey: boolean;
	lastMessage: string;
	tabCount: number;
	hasOnboarding: boolean;
}> {
	return browser.execute((onboardSel: string) => {
		const raw = localStorage.getItem("naia-config");
		const cfg = raw ? JSON.parse(raw) : {};
		const msgs = document.querySelectorAll(
			".chat-message.assistant .message-content",
		);
		const lastMsg =
			msgs.length > 0 ? (msgs[msgs.length - 1]?.textContent?.trim() ?? "") : "";
		return {
			provider: cfg.provider ?? "",
			model: cfg.model ?? "",
			hasApiKey: !!cfg.apiKey,
			hasNaiaKey: !!cfg.naiaKey,
			lastMessage: lastMsg.slice(0, 200),
			tabCount: document.querySelectorAll(".chat-tabs .chat-tab").length,
			hasOnboarding: !!document.querySelector(onboardSel),
		};
	}, S.onboardingOverlay);
}

describe("89 — LLM provider switching", () => {
	let originalConfig: string;

	// Save original config and set baseline
	before(async () => {
		ensureArtifactDirs();

		// Save original config for restoration
		originalConfig = await browser.execute(
			() => localStorage.getItem("naia-config") ?? "{}",
		);

		const geminiKey = process.env.GEMINI_API_KEY ?? "";
		console.log(`[89] GEMINI_API_KEY: ${geminiKey ? "available" : "MISSING"}`);
		console.log(
			`[89] OPENAI_API_KEY: ${process.env.OPENAI_API_KEY ? "available" : "MISSING"}`,
		);
		console.log(
			`[89] ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? "available" : "MISSING"}`,
		);
		console.log(
			`[89] XAI_API_KEY: ${process.env.XAI_API_KEY ? "available" : "MISSING"}`,
		);
		console.log(
			`[89] ZHIPU_API_KEY: ${process.env.ZHIPU_API_KEY ? "available" : "MISSING"}`,
		);
		console.log(
			`[89] NAIA_API_KEY: ${process.env.NAIA_API_KEY ? "available" : "MISSING"}`,
		);
		console.log(`[89] Artifacts dir: ${ARTIFACTS_DIR}`);
		console.log(`[89] LLM debug log: ${LLM_LOG_PATH}`);

		// Set baseline config: gemini + API key
		await writeConfig({
			provider: "gemini",
			model: "gemini-2.5-flash",
			apiKey: geminiKey,
			agentName: "Naia",
			userName: "Tester",
			persona: "Friendly AI companion",
			enableTools: true,
			locale: "ko",
			onboardingComplete: true,
			vrmModel: "/avatars/01-Sendagaya-Shino-uniform.vrm",
			panelVisible: true,
		});

		await refreshAndWaitForChat();

		// Log initial state
		const state = await captureAppState();
		console.log(`[89] Initial state: ${JSON.stringify(state)}`);
		await screenshot("89-initial-state");
	});

	// Restore original config after all tests
	after(async () => {
		// Print llm-debug.log summary for all test activity
		printLlmDebugLog(50);

		await browser.execute((cfg: string) => {
			localStorage.setItem("naia-config", cfg);
		}, originalConfig);
		console.log("[89] Original config restored");

		try {
			await browser.refresh();
		} catch {
			// best effort
		}
	});

	for (const tp of TEST_PROVIDERS) {
		const apiKey = getApiKey(tp.keyEnv);
		const skip = tp.keyEnv && !apiKey;

		describe(`${tp.label} (${tp.provider})`, () => {
			if (skip) {
				it(`[SKIP] ${tp.keyEnv} not set`, () => {
					console.log(`[89] SKIP: ${tp.keyEnv} not available for ${tp.label}`);
				});
				return;
			}

			it("should switch provider and verify config", async () => {
				// Set provider config
				const patch: Record<string, unknown> = {
					provider: tp.provider,
					model: tp.model,
					onboardingComplete: true,
				};
				const keyField = tp.keyField ?? "apiKey";
				if (apiKey) patch[keyField] = apiKey;
				if (tp.extraConfig) Object.assign(patch, tp.extraConfig);
				await writeConfig(patch);

				// Refresh to apply
				await refreshAndWaitForChat();

				// Verify config was applied
				const state = await captureAppState();
				console.log(
					`[89] ${tp.provider} state after switch: ${JSON.stringify(state)}`,
				);
				await screenshot(`89-${tp.provider}-after-switch`);
				expect(state.provider).toBe(tp.provider);
				expect(state.model).toBe(tp.model);
			});

			it("should get chat response", async () => {
				await dumpBrowserLogs(`${tp.provider}:before-send`);
				try {
					await sendMessage("Say hello in one word.");
					const response = await getLastAssistantMessage();
					console.log(
						`[89] ${tp.provider} response: "${response.slice(0, 200)}"`,
					);

					// Screenshot of successful response
					await screenshot(`89-${tp.provider}-response`);
					await dumpBrowserLogs(`${tp.provider}:after-response`);

					expect(response.length).toBeGreaterThan(0);

					// Check for error in response
					if (
						response.includes("[오류]") ||
						response.toLowerCase().includes("error")
					) {
						console.error(
							`[89] ${tp.provider} ERROR in response: ${response.slice(0, 300)}`,
						);
						await screenshot(`89-${tp.provider}-error-in-response`);
					}
				} catch (err) {
					// Capture state + screenshot on failure for debugging
					const state = await captureAppState();
					console.error(
						`[89] ${tp.provider} FAILED. App state: ${JSON.stringify(state)}`,
					);
					await screenshot(`89-${tp.provider}-FAILED`);
					await dumpBrowserLogs(`${tp.provider}:FAILED`);
					// Print current llm-debug.log to see what agent reported
					printLlmDebugLog(10);
					throw err;
				}
			});
		});
	}
});
