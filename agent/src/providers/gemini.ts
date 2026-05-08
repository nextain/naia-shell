import { randomUUID } from "node:crypto";
import { FunctionCallingConfigMode, GoogleGenAI } from "@google/genai";
import type {
	AgentStream,
	ChatMessage,
	LLMProvider,
	ToolDefinition,
} from "./types.js";

function toGeminiContents(messages: ChatMessage[]) {
	return messages.map((m) => {
		if (m.toolCalls && m.toolCalls.length > 0) {
			return {
				role: "model",
				parts: m.toolCalls.map((tc) => ({
					functionCall: { id: tc.id, name: tc.name, args: tc.args },
					...(tc.thoughtSignature
						? { thoughtSignature: tc.thoughtSignature }
						: {}),
				})),
			};
		}
		if (m.role === "tool") {
			// Strip base64 image data — Gemini function responses don't support inline images
			const content = m.content.startsWith("data:image/")
				? "[screenshot captured — vision not available for this provider]"
				: m.content;
			return {
				role: "user",
				parts: [
					{
						functionResponse: {
							id: m.toolCallId,
							name: m.name,
							response: { output: content },
						},
					},
				],
			};
		}
		return {
			role: m.role === "assistant" ? "model" : "user",
			parts: [{ text: m.content }],
		};
	});
}

/** Gemini 3 series recommends temperature 1.0 (default). Lower values may cause looping. */
function isGemini3(model: string): boolean {
	return model.startsWith("gemini-3");
}

export function createGeminiProvider(
	apiKey: string,
	model: string,
): LLMProvider {
	const client = new GoogleGenAI({ apiKey });

	return {
		async *stream(messages, systemPrompt, tools, signal): AgentStream {
			const contents = toGeminiContents(messages);

			const geminiTools = tools
				? [
						{
							functionDeclarations: tools.map((t) => ({
								name: t.name,
								description: t.description,
								parameters: t.parameters,
							})),
						},
					]
				: undefined;

			const temperature = isGemini3(model) ? 1.0 : 0.7;

			const response = await client.models.generateContentStream({
				model,
				contents,
				config: {
					systemInstruction: systemPrompt,
					temperature,
					tools: geminiTools,
					toolConfig: geminiTools
						? {
								functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO },
							}
						: undefined,
				},
			});

			let inputTokens = 0;
			let outputTokens = 0;

			for await (const chunk of response) {
				if (signal?.aborted) break;
				const text = chunk.text;
				if (text) {
					yield { type: "text", text };
				}

				// Access raw parts to capture thoughtSignature (Gemini 3 requirement)
				const parts = chunk.candidates?.[0]?.content?.parts;
				if (parts) {
					for (const part of parts) {
						if (part.functionCall) {
							yield {
								type: "tool_use",
								id: part.functionCall.id || randomUUID(),
								name: part.functionCall.name || "unknown",
								args: (part.functionCall.args as Record<string, unknown>) || {},
								thoughtSignature: part.thoughtSignature,
							};
						}
					}
				}

				if (chunk.usageMetadata) {
					inputTokens = chunk.usageMetadata.promptTokenCount ?? inputTokens;
					outputTokens =
						chunk.usageMetadata.candidatesTokenCount ?? outputTokens;
				}
			}

			if (inputTokens > 0 || outputTokens > 0) {
				yield { type: "usage", inputTokens, outputTokens };
			}
			yield { type: "finish" };
		},
	};
}
