// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../lib/types";
import {
	formatStructuredAgentChunk,
	resolveKioskEvidenceFiles,
} from "../chat-presentation";

describe("formatStructuredAgentChunk", () => {
	it("formats grounding sources without losing provenance", () => {
		expect(
			formatStructuredAgentChunk({
				type: "grounding",
				requestId: "request-1",
				status: "grounded",
				sources: [
					{
						title: "Naia docs",
						sourceUris: ["https://naia.nextain.io/docs"],
					},
				],
			}),
		).toBe(
			"\n\n[Grounding: grounded] Naia docs (https://naia.nextain.io/docs)",
		);
	});

	it("formats artifact metadata", () => {
		expect(
			formatStructuredAgentChunk({
				type: "artifact",
				requestId: "request-1",
				artifact: {
					id: "artifact-1",
					kind: "image",
					name: "report.md",
					localRef: "/tmp/report.md",
					mimeType: "text/markdown",
					sizeBytes: 42,
				},
			}),
		).toContain("[Artifact: image report.md] id=artifact-1");
	});

	it("formats provider session and processing disclosure state", () => {
		expect(
			formatStructuredAgentChunk({
				type: "provider_session",
				requestId: "request-1",
				state: "started",
				sessionId: "session-1",
				providerSessionRef: "provider-1",
			}),
		).toContain("[Provider session: started]");

		expect(
			formatStructuredAgentChunk({
				type: "processing_disclosure",
				requestId: "request-1",
				workload: "main_llm",
				destination: "external_cloud",
				decision: "allowed",
				processingProfileRef: "profile-1",
				provider: "openai",
				model: "gpt-5",
			}),
		).toContain("openai/gpt-5");
	});
});

describe("resolveKioskEvidenceFiles", () => {
	const reply = (extra: Partial<ChatMessage> = {}): ChatMessage => ({
		id: "a1",
		role: "assistant",
		content: "안녕하세요. AGENTS.md 와 guest-memory.md 를 참고했어요.",
		timestamp: 0,
		...extra,
	});

	it("shows no evidence for a plain reply without knowledge tool results", () => {
		expect(resolveKioskEvidenceFiles(reply())).toEqual([]);
	});

	it("shows only knowledge files from successful knowledge tool results", () => {
		expect(
			resolveKioskEvidenceFiles(
				reply({
					toolCalls: [
						{
							toolCallId: "t1",
							toolName: "skill_knowledge_ask",
							args: { question: "나이아?" },
							status: "success",
							output:
								"opfs://naia-adk/.bundle/knowledge/naia.md AGENTS.md guest-memory.md",
						},
						{
							toolCallId: "t2",
							toolName: "skill_knowledge_search",
							args: {},
							status: "error",
							output: "knowledge/broken.md",
						},
						{
							toolCallId: "t3",
							toolName: "skill_memory_recall",
							args: {},
							status: "success",
							output: "memory/guest-memory.md",
						},
					],
				}),
			),
		).toEqual(["knowledge/naia.md"]);
	});

	it("drops stored instruction/memory evidence and keeps explicit knowledge files", () => {
		expect(
			resolveKioskEvidenceFiles(
				reply({ evidenceFiles: ["AGENTS.md", "memory/guest-memory.md"] }),
			),
		).toEqual([]);
		expect(
			resolveKioskEvidenceFiles(
				reply({ evidenceFiles: ["AGENTS.md", "knowledge/slides.md"] }),
			),
		).toEqual(["knowledge/slides.md"]);
	});
});
