import type {
	WebLLMChatChunk,
	WebLLMChatRequest,
	WebLLMEngineLike,
} from "@naia-agent/composition/browser-agent.js";

declare global {
	var __naiaFakeEngineRequests: WebLLMChatRequest["messages"][] | undefined;
}

export const FAKE_ENGINE_MARKER = "naia-fake-webllm-engine";

export function makeFakeWebLLMEngine(): WebLLMEngineLike {
	let interrupted = false;

	return {
		chat: {
			completions: {
				async create(
					req: WebLLMChatRequest,
				): Promise<AsyncIterable<WebLLMChatChunk>> {
					(globalThis.__naiaFakeEngineRequests ??= []).push(
						structuredClone(req.messages),
					);
					interrupted = false;

					const lastMsg = req.messages[req.messages.length - 1];
					let chunks = [
						`[${FAKE_ENGINE_MARKER}] `,
						"웹 가짜 엔진 ",
						"응답입니다.",
					];

					if (
						lastMsg &&
						lastMsg.role === "user" &&
						typeof lastMsg.content === "string"
					) {
						const content = lastMsg.content;
						if (content.includes("[fake-tool:read AGENTS.md]")) {
							chunks = [
								"<tool_",
								'call>\n{"name":"read_file","arguments":{"path":"AGENTS.md"}}\n</tool_call>',
							];
						} else if (content.includes("[fake-tool:list agents/context]")) {
							chunks = [
								"<tool_",
								'call>\n{"name":"list_dir","arguments":{"path":"agents/context"}}\n</tool_call>',
							];
						} else if (content.includes("[fake-tool:read .env]")) {
							chunks = [
								"<tool_",
								'call>\n{"name":"read_file","arguments":{"path":".env"}}\n</tool_call>',
							];
						} else if (content.startsWith("<tool_response>")) {
							const afterTag = content.startsWith("<tool_response>\n")
								? content.slice("<tool_response>\n".length)
								: content.slice("<tool_response>".length).replace(/^\n/, "");
							const firstLine = (afterTag.split("\n")[0] ?? "").slice(0, 80);
							chunks = [`[${FAKE_ENGINE_MARKER}] 도구 결과 받음: ${firstLine}`];
						}
					}

					async function* generator(): AsyncGenerator<WebLLMChatChunk> {
						for (const text of chunks) {
							if (interrupted) {
								yield {
									choices: [{ delta: {}, finish_reason: "abort" }],
								};
								return;
							}
							await new Promise((resolve) => setTimeout(resolve, 20));
							if (interrupted) {
								yield {
									choices: [{ delta: {}, finish_reason: "abort" }],
								};
								return;
							}
							yield {
								choices: [{ delta: { content: text }, finish_reason: null }],
							};
						}

						if (interrupted) {
							yield {
								choices: [{ delta: {}, finish_reason: "abort" }],
							};
							return;
						}

						yield {
							choices: [{ delta: {}, finish_reason: "stop" }],
							usage: { prompt_tokens: 1, completion_tokens: 3 },
						};
					}

					return generator();
				},
			},
		},
		interruptGenerate(): void {
			interrupted = true;
		},
	};
}
