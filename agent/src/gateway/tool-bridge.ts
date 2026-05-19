import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { CronScheduler } from "../cron/scheduler.js";
import { CronStore } from "../cron/store.js";
import type { ToolDefinition } from "../providers/types.js";
import { createAgentBrowserSkill } from "../skills/built-in/agent-browser.js";
import { createAgentsSkill } from "../skills/built-in/agents.js";
import { createApprovalsSkill } from "../skills/built-in/approvals.js";
import { createBotmadangSkill } from "../skills/built-in/botmadang.js";
import { createChannelsSkill } from "../skills/built-in/channels.js";
import { createConfigSkill } from "../skills/built-in/config.js";
import { createCronSkill } from "../skills/built-in/cron.js";
import { createDeviceSkill } from "../skills/built-in/device.js";
import { createDiagnosticsSkill } from "../skills/built-in/diagnostics.js";
import { createMemoSkill } from "../skills/built-in/memo.js";
import { createNaiaDiscordSkill } from "../skills/built-in/naia-discord.js";
import { createNotifyDiscordSkill } from "../skills/built-in/notify-discord.js";
import { createNotifyGoogleChatSkill } from "../skills/built-in/notify-google-chat.js";
import { createNotifySlackSkill } from "../skills/built-in/notify-slack.js";
import { createPanelSkill } from "../skills/built-in/panel.js";
import { createSessionsSkill } from "../skills/built-in/sessions.js";
import { createSkillManagerSkill } from "../skills/built-in/skill-manager.js";
import { createSystemStatusSkill } from "../skills/built-in/system-status.js";
import { createTimeSkill } from "../skills/built-in/time.js";
import { createTtsSkill } from "../skills/built-in/tts.js";
import { createVoiceWakeSkill } from "../skills/built-in/voicewake.js";
import { createWeatherSkill } from "../skills/built-in/weather.js";
import { createYoutubeBgmSkill } from "../skills/built-in/youtube-bgm.js";
import { createWelcomeSkill } from "../skills/built-in/welcome.js";
import { bootstrapDefaultSkills, loadCustomSkills } from "../skills/loader.js";
import { SkillRegistry } from "../skills/registry.js";
import { GatewayRequestError } from "./client.js";
import { executeSessionsSpawn } from "./sessions-spawn.js";
import type { CommandExecutor, GatewayAdapter } from "./types.js";

export type { ToolDefinition };

/** Global skill registry with built-in skills */
export const skillRegistry = new SkillRegistry();
skillRegistry.register(createAgentBrowserSkill());
skillRegistry.register(createAgentsSkill());
skillRegistry.register(createApprovalsSkill());
skillRegistry.register(createBotmadangSkill());
skillRegistry.register(createChannelsSkill());
skillRegistry.register(createConfigSkill());
skillRegistry.register(createDeviceSkill());
skillRegistry.register(createDiagnosticsSkill());
skillRegistry.register(createMemoSkill());
skillRegistry.register(createNaiaDiscordSkill());
skillRegistry.register(createNotifyDiscordSkill());
skillRegistry.register(createNotifyGoogleChatSkill());
skillRegistry.register(createNotifySlackSkill());
skillRegistry.register(createPanelSkill());
skillRegistry.register(createSessionsSkill());
skillRegistry.register(createSkillManagerSkill(skillRegistry));
skillRegistry.register(createSystemStatusSkill());
skillRegistry.register(createTimeSkill());
skillRegistry.register(createTtsSkill());
skillRegistry.register(createVoiceWakeSkill());
skillRegistry.register(createWeatherSkill());
skillRegistry.register(createYoutubeBgmSkill());
skillRegistry.register(createWelcomeSkill());

// Cron skill — persistent store in ~/.naia/cron-jobs.json
import { homedir } from "node:os";
const cronStorePath = `${homedir()}/.naia/cron-jobs.json`;
const cronStore = new CronStore(cronStorePath);
skillRegistry.register(createCronSkill(cronStore));

/** Cron scheduler — fires job payloads to stdout for the Shell to handle */
export const cronScheduler = new CronScheduler((payload) => {
	const msg = JSON.stringify({
		type: "cron_fire",
		jobId: payload.jobId,
		label: payload.label,
		task: payload.task,
		firedAt: payload.firedAt,
	});
	process.stdout.write(`${msg}\n`);
});

// Restore persisted enabled jobs on module load
cronScheduler.restoreFromStore(cronStore);

// Bootstrap default skills from bundled assets (first-run only)
const customSkillsDir = `${homedir()}/.naia/skills`;
const bundledSkillsDir = new URL("../../assets/default-skills", import.meta.url)
	.pathname;
bootstrapDefaultSkills(customSkillsDir, bundledSkillsDir);

// Load custom skills from ~/.naia/skills/
loadCustomSkills(skillRegistry, customSkillsDir);

// --- Gateway tool safety metadata ---
import { ALWAYS_FALSE, ALWAYS_TRUE } from "../skills/registry.js";
// Reuse typed safety predicate constants from registry (fail-closed defaults)

skillRegistry.registerToolSafety("execute_command", {
	isConcurrencySafe: ALWAYS_FALSE,
	isDestructive: ALWAYS_TRUE,
	isReadOnly: ALWAYS_FALSE,
});
skillRegistry.registerToolSafety("read_file", {
	isConcurrencySafe: ALWAYS_TRUE,
	isDestructive: ALWAYS_FALSE,
	isReadOnly: ALWAYS_TRUE,
});
skillRegistry.registerToolSafety("write_file", {
	isConcurrencySafe: ALWAYS_FALSE,
	isDestructive: ALWAYS_TRUE,
	isReadOnly: ALWAYS_FALSE,
});
skillRegistry.registerToolSafety("search_files", {
	isConcurrencySafe: ALWAYS_TRUE,
	isDestructive: ALWAYS_FALSE,
	isReadOnly: ALWAYS_TRUE,
});
skillRegistry.registerToolSafety("web_search", {
	isConcurrencySafe: ALWAYS_TRUE,
	isDestructive: ALWAYS_FALSE,
	isReadOnly: ALWAYS_TRUE,
});
skillRegistry.registerToolSafety("apply_diff", {
	isConcurrencySafe: ALWAYS_FALSE,
	isDestructive: ALWAYS_TRUE,
	isReadOnly: ALWAYS_FALSE,
});
skillRegistry.registerToolSafety("browser", {
	isConcurrencySafe: ALWAYS_TRUE,
	isDestructive: ALWAYS_FALSE,
	isReadOnly: ALWAYS_TRUE,
});
skillRegistry.registerToolSafety("sessions_spawn", {
	isConcurrencySafe: ALWAYS_TRUE,
	isDestructive: ALWAYS_FALSE,
	isReadOnly: ALWAYS_FALSE,
});

/** Get all tools: Gateway tools + skill tools (minus disabled) */
export function getAllTools(
	hasGateway: boolean,
	disabledSkills?: string[],
): ToolDefinition[] {
	const skillTools = skillRegistry.toToolDefinitions(hasGateway);
	const filtered =
		disabledSkills && disabledSkills.length > 0
			? skillTools.filter((t) => !disabledSkills.includes(t.name))
			: skillTools;
	return [...GATEWAY_TOOLS, ...filtered];
}

/** Result from tool execution */
export interface ToolResult {
	success: boolean;
	output: string;
	error?: string;
}

/** Escape a string for safe use inside a shell single-quoted context */
function shellEscape(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Sensitive paths that agent tools must never read/write (CWE-22). */
const SENSITIVE_PATH_PATTERNS = [
	/^\/?etc\//,
	/^\/?proc\//,
	/^\/?sys\//,
	/^\/?dev\//,
	/\/\.ssh\//,
	/\/\.gnupg\//,
	/\/\.aws\//,
	/\/\.config\/gcloud\//,
	/\/\.kube\//,
	/\/\.docker\/config\.json$/,
];

/** Validate path has no null bytes, directory traversal, or sensitive targets */
function validatePath(path: string): string | null {
	if (path.includes("\0")) {
		return "Invalid path: contains null byte";
	}
	const normalized = path.replace(/\\/g, "/");
	if (normalized.split("/").includes("..")) {
		return "Invalid path: directory traversal";
	}
	if (SENSITIVE_PATH_PATTERNS.some((p) => p.test(normalized))) {
		return "Invalid path: access to sensitive system path denied";
	}
	return null;
}

/** Default tools available when Gateway is connected */
export const GATEWAY_TOOLS: ToolDefinition[] = [
	{
		name: "execute_command",
		description:
			"Execute a shell command on the system. Use for installing packages, running scripts, git operations, etc.",
		parameters: {
			type: "object",
			properties: {
				command: {
					type: "string",
					description: "The shell command to execute",
				},
				workdir: {
					type: "string",
					description: "Working directory (optional, defaults to home)",
				},
			},
			required: ["command"],
		},
	},
	{
		name: "read_file",
		description: "Read the contents of a file at the given path.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Absolute or relative file path" },
			},
			required: ["path"],
		},
	},
	{
		name: "write_file",
		description: "Write content to a file, creating it if it does not exist.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "File path to write to" },
				content: { type: "string", description: "Content to write" },
			},
			required: ["path", "content"],
		},
	},
	{
		name: "search_files",
		description:
			"Search for files by name pattern or search file contents with a regex pattern.",
		parameters: {
			type: "object",
			properties: {
				pattern: {
					type: "string",
					description: "Glob pattern for filenames or regex for content search",
				},
				path: {
					type: "string",
					description: "Directory to search in (defaults to home)",
				},
				content: {
					type: "boolean",
					description: "If true, search file contents instead of names",
				},
			},
			required: ["pattern"],
		},
	},
	{
		name: "web_search",
		description: "Search the web for information.",
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "Search query" },
			},
			required: ["query"],
		},
	},
	{
		name: "apply_diff",
		description:
			"Apply a search-and-replace edit to a file. Provide the exact text to find and its replacement. Use for precise, targeted file modifications.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "File path to edit" },
				search: {
					type: "string",
					description: "Exact text to find in the file",
				},
				replace: {
					type: "string",
					description: "Text to replace the found text with",
				},
			},
			required: ["path", "search", "replace"],
		},
	},
	{
		name: "browser",
		description:
			"Fetch and read the content of a web page. Returns the page text content (HTML stripped to readable text).",
		parameters: {
			type: "object",
			properties: {
				url: { type: "string", description: "URL of the web page to read" },
			},
			required: ["url"],
		},
	},
	{
		name: "sessions_spawn",
		description:
			"Spawn a sub-agent to handle a complex task asynchronously. The sub-agent runs in a separate session and returns its result when done. Use for tasks requiring deep analysis, multi-file exploration, or independent research.",
		parameters: {
			type: "object",
			properties: {
				task: {
					type: "string",
					description: "Description of the task for the sub-agent to perform",
				},
				label: {
					type: "string",
					description: "Short label for display (optional)",
				},
			},
			required: ["task"],
		},
	},
];

/** Blocked command patterns (Tier 3) */
const BLOCKED_PATTERNS = [
	/^rm\s+-rf\s+\//,
	/^sudo\s/,
	/^chmod\s+777/,
	/\|\s*bash$/,
	/^curl\s.*\|\s*sh/,
	/^mkfs\./,
	/^dd\s+if=/,
];

/** Commands targeting sensitive paths — defense in depth with validatePath */
const SENSITIVE_COMMAND_PATTERNS = [
	/\b\/etc\//,
	/\b\/proc\//,
	/\b\/sys\//,
	/\b~?\/?\.ssh\//,
	/\b~?\/?\.gnupg\//,
	/\b~?\/?\.aws\//,
	/\b~?\/?\.kube\//,
];

function isBlockedCommand(command: string): boolean {
	const trimmed = command.trim();
	if (BLOCKED_PATTERNS.some((pattern) => pattern.test(trimmed))) {
		return true;
	}
	if (SENSITIVE_COMMAND_PATTERNS.some((pattern) => pattern.test(trimmed))) {
		return true;
	}
	return false;
}

function hasMethod(client: GatewayAdapter, method: string): boolean {
	const methods = client.availableMethods;
	// Backward-compatible default for tests/mocks that do not provide
	// method capability metadata from hello-ok.
	if (!Array.isArray(methods) || methods.length === 0) {
		return true;
	}
	return methods.includes(method);
}

function hasAllMethods(client: GatewayAdapter, methods: string[]): boolean {
	return methods.every((method) => hasMethod(client, method));
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object") {
		return null;
	}
	return value as Record<string, unknown>;
}

function formatError(err: unknown): string {
	if (err instanceof Error) {
		return err.message;
	}
	return String(err);
}

function isMethodUnavailableError(err: unknown): boolean {
	if (err instanceof GatewayRequestError) {
		const code = err.code.toUpperCase();
		if (
			code === "UNKNOWN_METHOD" ||
			code === "METHOD_NOT_FOUND" ||
			code === "NOT_IMPLEMENTED" ||
			code === "UNSUPPORTED_METHOD" ||
			code === "UNKNOWN"
		) {
			return true;
		}
	}
	return /unknown method|method not found|not implemented|unsupported/i.test(
		formatError(err),
	);
}

function getNumberField(
	rec: Record<string, unknown>,
	key: string,
): number | undefined {
	const value = rec[key];
	return typeof value === "number" ? value : undefined;
}

function getStringField(
	rec: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = rec[key];
	return typeof value === "string" ? value : undefined;
}

interface RpcCommandResult {
	exitCode: number;
	stdout: string;
	stderr?: string;
}

function parseRpcCommandResult(payload: unknown, depth = 0): RpcCommandResult {
	const rec = asRecord(payload);
	if (!rec) {
		return {
			exitCode: 0,
			stdout: typeof payload === "string" ? payload : JSON.stringify(payload),
		};
	}

	// Handle wrapped payloads from node.invoke implementations (max 3 levels).
	if (depth < 3) {
		const nested = asRecord(rec.result) ?? asRecord(rec.payload);
		if (nested) {
			return parseRpcCommandResult(nested, depth + 1);
		}
	}

	const stdout =
		getStringField(rec, "stdout") ??
		getStringField(rec, "output") ??
		getStringField(rec, "text") ??
		"";
	const stderr =
		getStringField(rec, "stderr") ??
		getStringField(rec, "error") ??
		getStringField(rec, "message");
	const exitCode =
		getNumberField(rec, "exitCode") ??
		getNumberField(rec, "code") ??
		getNumberField(rec, "statusCode") ??
		0;

	return { exitCode, stdout, stderr };
}

function toToolResult(result: RpcCommandResult): ToolResult {
	return {
		success: result.exitCode === 0,
		output: result.stdout || result.stderr || "",
		error: result.exitCode !== 0 ? result.stderr : undefined,
	};
}

/** Per-client nodeId cache to avoid repeated node.list RPC calls.
 *  Call `clearNodeIdCache(client)` on reconnect to prevent stale routing. */
const nodeIdCache = new WeakMap<GatewayAdapter, string | null>();

/** Invalidate cached nodeId — must be called on reconnect / close. */
export function clearNodeIdCache(client: GatewayAdapter): void {
	nodeIdCache.delete(client);
}

async function resolveNodeId(client: GatewayAdapter): Promise<string | null> {
	if (nodeIdCache.has(client)) {
		return nodeIdCache.get(client)!;
	}

	if (!hasMethod(client, "node.list")) {
		nodeIdCache.set(client, null);
		return null;
	}

	const payload = await client.request("node.list", {});
	const rec = asRecord(payload);

	let nodes: unknown[] = [];
	if (Array.isArray(payload)) {
		nodes = payload;
	} else if (rec && Array.isArray(rec.nodes)) {
		nodes = rec.nodes;
	}

	for (const node of nodes) {
		const nodeRec = asRecord(node);
		if (!nodeRec) continue;
		const id =
			getStringField(nodeRec, "nodeId") || getStringField(nodeRec, "id");
		if (id) {
			nodeIdCache.set(client, id);
			return id;
		}
	}

	nodeIdCache.set(client, null);
	return null;
}

async function runExecBash(
	client: GatewayAdapter,
	command: string,
	workdir?: string,
): Promise<ToolResult> {
	const payload = await client.request("exec.bash", {
		command,
		workdir: workdir || undefined,
	});
	return toToolResult(parseRpcCommandResult(payload));
}

async function runNodeInvoke(
	client: GatewayAdapter,
	command: string,
	workdir?: string,
): Promise<ToolResult> {
	const nodeId = await resolveNodeId(client);
	if (!nodeId) {
		return {
			success: false,
			output: "",
			error: "No paired node available for node.invoke",
		};
	}

	const payload = await client.request("node.invoke", {
		nodeId,
		idempotencyKey: randomUUID(),
		command: "system.run",
		params: {
			command: ["bash", "-lc", command],
			cwd: workdir || undefined,
		},
	});

	return toToolResult(parseRpcCommandResult(payload));
}

async function runShellCommand(
	client: GatewayAdapter,
	command: string,
	workdir?: string,
): Promise<ToolResult> {
	const errors: string[] = [];

	let actualCommand = command;
	// Automatically route command to host if running inside a flatpak sandbox.
	// Use base64 encoding to avoid nested shell quoting issues (CWE-78).
	try {
		if (fs.existsSync("/.flatpak-info")) {
			const b64 = Buffer.from(command, "utf8").toString("base64");
			actualCommand = `flatpak-spawn --host bash -c "eval \\"\\$(echo ${b64} | base64 -d)\\""`;
		}
	} catch {
		/* ignore */
	}

	if (hasMethod(client, "exec.bash")) {
		try {
			return await runExecBash(client, actualCommand, workdir);
		} catch (err) {
			if (!isMethodUnavailableError(err)) {
				return {
					success: false,
					output: "",
					error: `exec.bash: ${formatError(err)}`,
				};
			}
			errors.push(`exec.bash unavailable: ${formatError(err)}`);
		}
	}

	if (hasMethod(client, "node.invoke")) {
		try {
			return await runNodeInvoke(client, actualCommand, workdir);
		} catch (err) {
			return {
				success: false,
				output: "",
				error: `node.invoke: ${formatError(err)}`,
			};
		}
	}

	return {
		success: false,
		output: "",
		error:
			errors.length > 0
				? errors.join(" | ")
				: "No supported command execution RPC (exec.bash/node.invoke)",
	};
}

async function invokeBrowserRequest(
	client: GatewayAdapter,
	url: string,
): Promise<unknown> {
	const attempts: Array<Record<string, unknown>> = [
		{
			method: "POST",
			path: "navigate",
			body: { url },
		},
		{
			method: "POST",
			path: "open",
			body: { url },
		},
		// Backward-compat path used by earlier internal adapter assumptions.
		{ url },
	];

	const errors: string[] = [];
	for (const params of attempts) {
		try {
			return await client.request("browser.request", params);
		} catch (err) {
			errors.push(String(err));
		}
	}

	throw new Error(errors.join(" | "));
}

/** Extra context passed to skill execution */
export interface ExecuteToolContext {
	writeLine?: (data: unknown) => void;
	requestId?: string;
	disabledSkills?: string[];
	/** Command executor for shell tools (execute_command, read_file, etc.) */
	executor?: CommandExecutor;
}

/**
 * Build a CommandExecutor that routes through the Gateway RPC.
 * Used as fallback when no NativeCommandExecutor is provided.
 */
function buildGatewayShellExecutor(client: GatewayAdapter): CommandExecutor {
	return {
		async execute(command, options) {
			return runShellCommand(client, command, options?.cwd);
		},
	};
}

/**
 * Execute a command-based tool (execute_command, read_file, write_file,
 * search_files, apply_diff) using the provided CommandExecutor.
 * Decoupled from Gateway — works with any executor implementation.
 */
async function executeCommandTool(
	executor: CommandExecutor,
	toolName: string,
	args: Record<string, unknown>,
): Promise<ToolResult> {
	switch (toolName) {
		case "execute_command": {
			const command = args.command as string;
			if (isBlockedCommand(command)) {
				return {
					success: false,
					output: "",
					error: `Blocked: "${command}" is not allowed for safety reasons`,
				};
			}
			const workdir = args.workdir as string | undefined;
			return executor.execute(command, workdir ? { cwd: workdir } : undefined);
		}

		case "read_file": {
			const path = args.path as string;
			const pathErr = validatePath(path);
			if (pathErr) {
				return { success: false, output: "", error: pathErr };
			}
			return executor.execute(`cat ${shellEscape(path)}`);
		}

		case "write_file": {
			const path = args.path as string;
			const pathErr = validatePath(path);
			if (pathErr) {
				return { success: false, output: "", error: pathErr };
			}
			const escapedPath = shellEscape(path);
			const escapedContent = shellEscape(args.content as string);
			const result = await executor.execute(
				`mkdir -p "$(dirname ${escapedPath})" && printf '%s' ${escapedContent} > ${escapedPath}`,
			);
			if (!result.success) {
				return result;
			}
			return { success: true, output: `File written: ${path}` };
		}

		case "search_files": {
			const pattern = args.pattern as string;
			const searchPath = (args.path as string) || "~";
			const patternErr = validatePath(pattern);
			const pathErr = validatePath(searchPath);
			if (patternErr || pathErr) {
				return {
					success: false,
					output: "",
					error: patternErr || pathErr || "Invalid input",
				};
			}
			const command = args.content
				? `grep -rl ${shellEscape(pattern)} ${shellEscape(searchPath)} 2>/dev/null | head -20`
				: `find ${shellEscape(searchPath)} -name ${shellEscape(pattern)} 2>/dev/null | head -20`;
			const result = await executor.execute(command);
			if (!result.success) {
				return result;
			}
			return { success: true, output: result.output || "No matches found" };
		}

		case "apply_diff": {
			const path = args.path as string;
			const pathErr = validatePath(path);
			if (pathErr) {
				return { success: false, output: "", error: pathErr };
			}
			const search = args.search as string;
			const replace = args.replace as string;
			if (!search) {
				return {
					success: false,
					output: "",
					error: "search text cannot be empty",
				};
			}
			try {
				const readResult = await executor.execute(`cat ${shellEscape(path)}`);
				if (!readResult.success) return readResult;

				const content = readResult.output || "";
				if (!content.includes(search)) {
					return {
						success: false,
						output: "",
						error: "Search text not found in file",
					};
				}
				const newContent = content.replace(search, replace);
				const escapedPath = shellEscape(path);
				const escapedContent = shellEscape(newContent);
				const writeResult = await executor.execute(
					`printf '%s' ${escapedContent} > ${escapedPath}`,
				);
				if (!writeResult.success) return writeResult;

				return { success: true, output: `Applied diff to ${path}` };
			} catch (err) {
				return { success: false, output: "", error: String(err) };
			}
		}

		default:
			return {
				success: false,
				output: "",
				error: `Unknown command tool: ${toolName}`,
			};
	}
}

/** Execute a tool call (gateway tools need client; skills may not) */
export async function executeTool(
	client: GatewayAdapter | null,
	toolName: string,
	args: Record<string, unknown>,
	ctx?: ExecuteToolContext,
): Promise<ToolResult> {
	// Skills can run without gateway
	if (skillRegistry.has(toolName)) {
		return skillRegistry.execute(toolName, args, {
			gateway: client ?? undefined,
			writeLine: ctx?.writeLine,
			requestId: ctx?.requestId,
			disabledSkills: ctx?.disabledSkills,
		});
	}

	// Command-based tools: use executor if available, fall back to gateway RPC
	const executor = ctx?.executor;
	const COMMAND_TOOLS = [
		"execute_command",
		"read_file",
		"write_file",
		"search_files",
		"apply_diff",
	];
	if (COMMAND_TOOLS.includes(toolName)) {
		let exec: CommandExecutor | undefined = executor;
		if (!exec && client?.isConnected()) {
			exec = buildGatewayShellExecutor(client);
		}
		if (!exec) {
			return {
				success: false,
				output: "",
				error: "No command executor available (gateway not connected)",
			};
		}
		return executeCommandTool(exec, toolName, args);
	}

	// Gateway-only tools require connected client
	if (!client?.isConnected()) {
		return { success: false, output: "", error: "Gateway not connected" };
	}

	switch (toolName) {
		case "web_search": {
			try {
				let result: unknown;
				if (hasMethod(client, "skills.invoke")) {
					result = await client.request("skills.invoke", {
						skill: "web-search",
						args: { query: args.query },
					});
				} else if (hasMethod(client, "browser.request")) {
					const query = String(args.query ?? "").trim();
					if (!query) {
						return {
							success: false,
							output: "",
							error: "Search query is required",
						};
					}
					const url = `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
					result = await invokeBrowserRequest(client, url);
				} else {
					return {
						success: false,
						output: "",
						error:
							"No supported web search RPC (skills.invoke/browser.request)",
					};
				}

				return {
					success: true,
					output: JSON.stringify(result),
				};
			} catch (err) {
				return {
					success: false,
					output: "",
					error: `Web search failed: ${String(err)}`,
				};
			}
		}

		case "browser": {
			const url = args.url as string;
			if (!url) {
				return { success: false, output: "", error: "URL is required" };
			}
			try {
				let result: unknown;
				if (hasMethod(client, "skills.invoke")) {
					result = await client.request("skills.invoke", {
						skill: "browser",
						args: { url },
					});
				} else if (hasMethod(client, "browser.request")) {
					result = await invokeBrowserRequest(client, url);
				} else {
					return {
						success: false,
						output: "",
						error: "No supported browser RPC (skills.invoke/browser.request)",
					};
				}
				return {
					success: true,
					output: typeof result === "string" ? result : JSON.stringify(result),
				};
			} catch (err) {
				return {
					success: false,
					output: "",
					error: `Browser failed: ${String(err)}`,
				};
			}
		}

		case "sessions_spawn": {
			if (
				!hasAllMethods(client, [
					"sessions.spawn",
					"agent.wait",
					"sessions.transcript",
				])
			) {
				return {
					success: false,
					output: "",
					error: "sessions_spawn is not available on this Gateway",
				};
			}

			return executeSessionsSpawn(client, {
				task: args.task as string,
				label: args.label as string | undefined,
			});
		}

		default:
			return { success: false, output: "", error: `Unknown tool: ${toolName}` };
	}
}
