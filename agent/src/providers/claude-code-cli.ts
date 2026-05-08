import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AgentStream,
	ChatMessage,
	LLMProvider,
	ToolDefinition,
} from "./types.js";

// ── Internal types matching Claude Code CLI stream-json output ──

interface ClaudeUsage {
	input_tokens?: number;
	output_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
}

type ContentBlock =
	| { type: "text"; text?: string }
	| { type: "thinking"; thinking?: string }
	| { type: "redacted_thinking"; data?: string }
	| { type: "tool_use"; id?: string; name?: string; input?: unknown }
	| { type: string; [key: string]: unknown };

type ClaudeCodeMessage =
	| {
			type: "system";
			subtype: string;
			apiKeySource?: string;
			[key: string]: unknown;
	  }
	| {
			type: "assistant";
			message: {
				content: ContentBlock[];
				usage?: ClaudeUsage;
				stop_reason?: string;
			};
			[key: string]: unknown;
	  }
	| {
			type: "error";
			error?: { message?: string; type?: string };
			[key: string]: unknown;
	  }
	| {
			type: "result";
			total_cost_usd?: number;
			is_error?: boolean;
			result?: string;
			[key: string]: unknown;
	  };

// ── Constants ──

const CLAUDE_CODE_TIMEOUT_MS = 600_000;
const SYSTEM_PROMPT_FILE_THRESHOLD = 64 * 1024; // 64KB
const DEFAULT_MAX_OUTPUT_TOKENS = "32000";

// Keep Claude Code from executing local tools directly.
// Ref: Careti project — prevents conflicts with our own tool system.
const DISALLOWED_TOOLS = [
	"Task",
	"Bash",
	"Glob",
	"Grep",
	"LS",
	"Read",
	"Edit",
	"MultiEdit",
	"Write",
	"NotebookRead",
	"NotebookEdit",
	"WebFetch",
	"TodoRead",
	"TodoWrite",
	"WebSearch",
].join(",");

// ── Partial JSON recovery (from Careti) ──

function attemptParseChunk(data: string): ClaudeCodeMessage | null {
	try {
		return JSON.parse(data) as ClaudeCodeMessage;
	} catch {
		return null;
	}
}

// ── API Error JSON extraction (from Careti) ──

function extractApiErrorMessage(text: string): string {
	const jsonStart = text.indexOf("{");
	if (jsonStart === -1) return text;
	const jsonStr = text.slice(jsonStart);
	try {
		const parsed = JSON.parse(jsonStr);
		const msg = parsed?.error?.message;
		if (typeof msg === "string" && msg.includes("Invalid model name")) {
			return `${text}\n\nAPI keys and subscription plans allow different models. Make sure the selected model is included in your plan.`;
		}
		return jsonStr;
	} catch {
		return text;
	}
}

// ── Message conversion ──

export function toClaudeMessages(
	messages: ChatMessage[],
): Array<Record<string, unknown>> {
	const result: Array<Record<string, unknown>> = [];
	for (const m of messages) {
		if (m.toolCalls && m.toolCalls.length > 0) {
			result.push({
				role: "assistant",
				content: m.toolCalls.map((tc) => ({
					type: "tool_use",
					id: tc.id,
					name: tc.name,
					input: tc.args,
				})),
			});
			continue;
		}

		if (m.role === "tool") {
			// claude-code-cli doesn't support image blocks in tool results — strip base64
			const content = m.content.startsWith("data:image/")
				? "[screenshot captured — vision not available in CLI mode]"
				: m.content;
			result.push({
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: m.toolCallId,
						content,
					},
				],
			});
			continue;
		}

		result.push({
			role: m.role === "assistant" ? "assistant" : "user",
			content: m.content,
		});
	}
	return result;
}

// ── Provider ──

export function createClaudeCodeCliProvider(model: string): LLMProvider {
	return {
		async *stream(messages, systemPrompt, tools, signal): AgentStream {
			const cliPath = process.env.CLAUDE_CODE_PATH || "claude";

			// Flatpak detection: use flatpak-spawn --host to access host CLI
			const isFlatpak =
				existsSync("/run/flatpak-info") || process.env.FLATPAK === "1";

			// System prompt: use temp file for large prompts or Windows
			let systemPromptFile: string | undefined;
			const args: string[] = [];

			if (systemPrompt.length > SYSTEM_PROMPT_FILE_THRESHOLD) {
				systemPromptFile = join(
					tmpdir(),
					`claude-system-prompt-${randomUUID()}.txt`,
				);
				writeFileSync(systemPromptFile, systemPrompt, "utf-8");
				args.push("--system-prompt-file", systemPromptFile);
			} else {
				args.push("--system-prompt", systemPrompt);
			}

			args.push(
				"--verbose",
				"--output-format",
				"stream-json",
				"--disallowedTools",
				DISALLOWED_TOOLS,
				"--max-turns",
				"1",
				"--model",
				model,
				"-p",
			);

			// Environment: remove API key leak, disable telemetry,
			// unset CLAUDECODE to allow nested invocation from within Claude Code sessions.
			// Ref: Careti — set sensible defaults while respecting user overrides.
			const env = { ...process.env };
			env.ANTHROPIC_API_KEY = undefined;
			env.CLAUDECODE = undefined;
			env.CLAUDE_CODE_MAX_OUTPUT_TOKENS =
				process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS || DEFAULT_MAX_OUTPUT_TOKENS;
			env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC =
				process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC || "1";
			env.DISABLE_NON_ESSENTIAL_MODEL_CALLS =
				process.env.DISABLE_NON_ESSENTIAL_MODEL_CALLS || "1";
			if (process.env.MAX_THINKING_TOKENS) {
				env.MAX_THINKING_TOKENS = process.env.MAX_THINKING_TOKENS;
			}

			// In Flatpak: wrap with flatpak-spawn --host to access host's claude CLI
			const spawnCmd = isFlatpak ? "flatpak-spawn" : cliPath;
			const spawnArgs = isFlatpak ? ["--host", cliPath, ...args] : args;

			const child = spawn(spawnCmd, spawnArgs, {
				stdio: ["pipe", "pipe", "pipe"],
				env,
			});

			let stderr = "";
			let inputTokens = 0;
			let outputTokens = 0;
			let processExited = false;
			let spawnErrorCode = "";
			let spawnErrorObj: Error | null = null;
			let partialData: string | null = null;

			const onAbort = () => {
				if (!child.killed) child.kill("SIGTERM");
			};
			signal?.addEventListener("abort", onAbort);

			try {
				if (!child.stdin || !child.stdout || !child.stderr) {
					throw new Error("Failed to start Claude Code CLI stdio pipes.");
				}

				child.stderr.setEncoding("utf8");
				child.stderr.on("data", (chunk: string) => {
					stderr += chunk;
				});

				const exitPromise = new Promise<number>((resolve) => {
					child.on("error", (err: Error & { code?: string }) => {
						spawnErrorCode = err.code ?? "";
						spawnErrorObj = err;
					});
					child.on("close", (code) => {
						processExited = true;
						resolve(code ?? -1);
					});
				});

				// Send conversation messages via stdin
				const payload = JSON.stringify(toClaudeMessages(messages));
				child.stdin.write(payload);
				child.stdin.end();

				// Parse stdout with manual line splitting + partial JSON recovery (Careti pattern)
				child.stdout.setEncoding("utf8");
				let buffer = "";

				for await (const rawChunk of child.stdout) {
					if (signal?.aborted) break;

					buffer += rawChunk;
					const lines = buffer.split("\n");
					// Keep incomplete line in buffer
					buffer = lines.pop() || "";

					for (const line of lines) {
						const trimmed = line.trim();
						if (!trimmed) continue;

						let msg: ClaudeCodeMessage | null;

						// Partial JSON recovery: accumulate across chunks
						if (partialData !== null) {
							partialData += trimmed;
							msg = attemptParseChunk(partialData);
							if (!msg) continue;
							partialData = null;
						} else {
							msg = attemptParseChunk(trimmed);
							if (!msg) {
								partialData = trimmed;
								continue;
							}
						}

						yield* processMessage(msg);
					}
				}

				// Process remaining buffer
				if (buffer.trim()) {
					const msg =
						partialData !== null
							? attemptParseChunk(partialData + buffer.trim())
							: attemptParseChunk(buffer.trim());
					if (msg) {
						yield* processMessage(msg);
					} else if (partialData !== null) {
						partialData += buffer.trim();
					}
				}

				// Truncated assistant recovery (Careti pattern):
				// If output was truncated, try to salvage partial assistant message
				if (partialData?.startsWith('{"type":"assistant"')) {
					// Best effort: yield the partial data as raw text
					yield { type: "text", text: "[Truncated response]" };
				}

				// Wait for process exit with timeout
				const timeoutPromise = new Promise<number>((resolve) =>
					setTimeout(() => resolve(-999), CLAUDE_CODE_TIMEOUT_MS),
				);
				const exitCode = await Promise.race([exitPromise, timeoutPromise]);

				if (exitCode === -999) {
					if (!child.killed) child.kill("SIGTERM");
					throw new Error("Claude Code CLI timed out.");
				}

				// Check spawn errors
				if (spawnErrorObj) {
					if (spawnErrorCode === "ENOENT") {
						throw new Error(
							"Claude Code CLI not found. Install `claude` or set CLAUDE_CODE_PATH.",
						);
					}
					if (spawnErrorCode === "E2BIG" || spawnErrorCode === "ENAMETOOLONG") {
						throw new Error(
							`Prompt too large for CLI execution (${spawnErrorCode}). Try a shorter system prompt.`,
						);
					}
					throw spawnErrorObj;
				}

				if (exitCode !== 0) {
					const errMsg = stderr.trim();
					// Outdated CLI detection (from Careti)
					if (errMsg.includes("unknown option '--system-prompt-file'")) {
						throw new Error(
							"The Claude Code CLI is outdated. Please update to the latest version.",
						);
					}
					if (errMsg.includes("ENOENT")) {
						throw new Error(
							"Claude Code CLI not found. Install `claude` or set CLAUDE_CODE_PATH.",
						);
					}
					throw new Error(
						errMsg || `Claude Code CLI exited with code ${String(exitCode)}.`,
					);
				}

				if (inputTokens > 0 || outputTokens > 0) {
					yield { type: "usage", inputTokens, outputTokens };
				}
				yield { type: "finish" };
			} finally {
				signal?.removeEventListener("abort", onAbort);
				if (!processExited && !child.killed) {
					child.kill("SIGTERM");
				}
				// Cleanup temp system prompt file
				if (systemPromptFile) {
					try {
						unlinkSync(systemPromptFile);
					} catch {
						// ignore cleanup errors
					}
				}
			}

			// ── Inner generator for processing a single message ──

			function* processMessage(msg: ClaudeCodeMessage) {
				if (msg.type === "error") {
					const errMsg = msg.error?.message || "Claude Code CLI error";
					throw new Error(errMsg);
				}

				if (msg.type === "result") {
					if (msg.is_error && msg.result) {
						throw new Error(msg.result);
					}
					// total_cost_usd tracked but not propagated (skipCost for claude-code-cli)
					return;
				}

				if (msg.type === "system") {
					// system.init — apiKeySource available for subscription detection
					return;
				}

				if (msg.type === "assistant" && msg.message) {
					const usage = msg.message.usage;
					if (usage) {
						// Per Anthropic docs: input_tokens already includes cache tokens.
						// No double-counting needed.
						inputTokens = usage.input_tokens ?? inputTokens;
						outputTokens = usage.output_tokens ?? outputTokens;
					}

					for (const block of msg.message.content ?? []) {
						if (block.type === "text" && typeof block.text === "string") {
							// Detect API Error in content text (enhanced: extract JSON)
							if (
								block.text.startsWith("API Error:") ||
								block.text.startsWith("API error:")
							) {
								throw new Error(extractApiErrorMessage(block.text));
							}
							yield { type: "text" as const, text: block.text };
						} else if (
							block.type === "thinking" &&
							typeof (block as { thinking?: string }).thinking === "string"
						) {
							yield {
								type: "thinking" as const,
								text: (block as { thinking: string }).thinking,
							};
						} else if (block.type === "redacted_thinking") {
							// Yield redacted thinking as indicator (from Careti)
							yield {
								type: "thinking" as const,
								text: "[Redacted thinking block]",
							};
						} else if (block.type === "tool_use") {
							const toolBlock = block as {
								type: "tool_use";
								id?: string;
								name?: string;
								input?: unknown;
							};
							const toolId =
								typeof toolBlock.id === "string" && toolBlock.id.length > 0
									? toolBlock.id
									: randomUUID();
							const toolName =
								typeof toolBlock.name === "string" && toolBlock.name.length > 0
									? toolBlock.name
									: "unknown";
							yield {
								type: "tool_use" as const,
								id: toolId,
								name: toolName,
								args:
									toolBlock.input && typeof toolBlock.input === "object"
										? (toolBlock.input as Record<string, unknown>)
										: {},
							};
						}
					}
				}
			}
		},
	};
}
