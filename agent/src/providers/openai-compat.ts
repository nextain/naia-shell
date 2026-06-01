/**
 * Shared OpenAI-compatible message/tool conversion utilities.
 * Used by xai.ts, openai.ts, zai.ts, and lab-proxy.ts.
 */
import type { ChatMessage, ToolDefinition } from "./types.js";

/** OpenAI chat completion message (minimal type for cross-provider use) */
export interface OpenAICompatMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string | null;
	tool_calls?: Array<{
		id: string;
		type: "function";
		function: { name: string; arguments: string };
	}>;
	tool_call_id?: string;
}

/** OpenAI chat completion tool definition */
export interface OpenAICompatTool {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

/** Convert ChatMessage[] to OpenAI-compatible message format */
export function toOpenAIMessages(
	messages: ChatMessage[],
	systemPrompt: string,
): OpenAICompatMessage[] {
	const result: OpenAICompatMessage[] = [
		{ role: "system", content: systemPrompt },
	];
	for (const m of messages) {
		if (m.toolCalls && m.toolCalls.length > 0) {
			result.push({
				role: "assistant",
				content: m.content || null,
				tool_calls: m.toolCalls.map((tc) => ({
					id: tc.id,
					type: "function" as const,
					function: {
						name: tc.name,
						arguments: JSON.stringify(tc.args),
					},
				})),
			});
		} else if (m.role === "tool") {
			// Strip base64 image data — OpenAI tool results don't support inline images here
			const content = m.content.startsWith("data:image/")
				? "[screenshot captured — vision not available for this provider]"
				: m.content;
			result.push({
				role: "tool",
				tool_call_id: m.toolCallId!,
				content,
			});
		} else {
			result.push({
				role: m.role as "user" | "assistant",
				content: m.content,
			});
		}
	}
	return result;
}

/** Convert ToolDefinition[] to OpenAI-compatible tool format */
export function toOpenAITools(tools: ToolDefinition[]): OpenAICompatTool[] {
	return tools.map((t) => ({
		type: "function" as const,
		function: {
			name: t.name,
			description: t.description,
			parameters: t.parameters as Record<string, unknown>,
		},
	}));
}

/** A tool call recovered from plain text (not native tool_calls). */
export interface SniffedToolCall {
	id: string;
	name: string;
	args: Record<string, unknown>;
}

/**
 * Extract a single JSON object string from model text. Handles a bare object
 * (`{...}`) and a ```json fenced block. Returns null if no object is found.
 * Deliberately conservative — only the outermost {...} span is considered, so
 * prose surrounding a JSON blob does not get misparsed.
 */
function extractJsonObject(text: string): string | null {
	const trimmed = text.trim();
	// ```json ... ``` or ``` ... ``` fence
	const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const body = (fence ? fence[1] : trimmed).trim();
	const start = body.indexOf("{");
	const end = body.lastIndexOf("}");
	if (start === -1 || end === -1 || end <= start) return null;
	return body.slice(start, end + 1);
}

function asArgsObject(value: unknown): Record<string, unknown> | null {
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			return null;
		}
	}
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return null;
}

/**
 * Recover a tool call that a model emitted as plain text instead of a native
 * `tool_calls` delta. Small local models (e.g. Ollama qwen3.5:4b) sometimes do
 * this. Guarded against false positives: only fires when the parsed JSON maps
 * unambiguously onto exactly one of the provided tools.
 *
 * Recognized shapes (in priority order):
 *   A. {"name": "skill_x", "arguments"|"parameters": {...}}   — explicit name
 *   B. {"skill_x": {...args...}}                              — single tool-named key
 *   C. {"action": "...", ...}                                 — bare args; promoted
 *      ONLY when exactly one tool's schema matches the arg keys (all keys are
 *      known properties + all required present).
 *
 * Returns null when nothing matches — caller then treats the text as a normal
 * answer. This is a recovery net, not the primary path; native tool_calls
 * always take precedence and this is only consulted when there are none.
 */
export function sniffTextToolCall(
	content: string,
	tools: ToolDefinition[],
): SniffedToolCall | null {
	if (!content || tools.length === 0) return null;
	const jsonStr = extractJsonObject(content);
	if (!jsonStr) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonStr);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const obj = parsed as Record<string, unknown>;
	const names = new Set(tools.map((t) => t.name));

	// Shape A — explicit tool name + arguments/parameters
	if (typeof obj.name === "string" && names.has(obj.name)) {
		const args = asArgsObject(obj.arguments ?? obj.parameters ?? {});
		if (args) return { id: `call_recovered_${obj.name}`, name: obj.name, args };
	}

	// Shape B — single key that is a tool name, value is the args
	const keys = Object.keys(obj);
	if (keys.length === 1 && names.has(keys[0])) {
		const args = asArgsObject(obj[keys[0]]);
		if (args) return { id: `call_recovered_${keys[0]}`, name: keys[0], args };
	}

	// Shape C — bare args; promote only if exactly one tool's schema fits
	if (!("name" in obj) && keys.length > 0) {
		const candidates = tools.filter((t) => {
			const params = t.parameters as {
				properties?: Record<string, unknown>;
				required?: string[];
			};
			const propNames = new Set(Object.keys(params.properties ?? {}));
			if (propNames.size === 0) return false;
			const required = params.required ?? [];
			return (
				keys.every((k) => propNames.has(k)) &&
				required.every((r) => keys.includes(r))
			);
		});
		if (candidates.length === 1) {
			return { id: `call_recovered_${candidates[0].name}`, name: candidates[0].name, args: obj };
		}
	}

	return null;
}
