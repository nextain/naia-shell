import type { AgentResponseChunk, ChatMessage } from "../lib/types";
import { extractKioskToolFiles } from "./ToolActivity";

const normalizeKioskEvidenceFile = (raw: string): string | null => {
	const trimmed = raw.trim().replace(/^opfs:\/\/naia-adk\//, "");
	const fileName = trimmed.split("/").pop() ?? trimmed;
	if (!fileName.endsWith(".md")) return null;
	if (/^AGENTS\.md$/i.test(fileName)) return "AGENTS.md";
	if (/^jina\.md$/i.test(fileName)) return "persona/jina.md";
	if (/^guest-memory\.md$/i.test(fileName)) return "memory/guest-memory.md";
	if (/^response-rules\.md$/i.test(fileName)) return "rules/response-rules.md";
	return `knowledge/${fileName}`;
};

// 근거 칩은 실제 지식 자료(knowledge/*.md)를 읽은 답에만 붙인다. 지시 파일(AGENTS.md)·기억 파일을
// 기본으로 붙이거나 답 본문에 적힌 파일 이름을 근거로 삼지 않는다.
const isKnowledgeEvidence = (file: string): boolean =>
	file.startsWith("knowledge/");

export const resolveKioskEvidenceFiles = (msg: ChatMessage): string[] => {
	if (msg.role !== "assistant" || msg.failure || !msg.content.trim()) {
		return [];
	}
	const files = new Set<string>();
	const addFile = (raw: string) => {
		const normalized = normalizeKioskEvidenceFile(raw);
		if (normalized && isKnowledgeEvidence(normalized)) files.add(normalized);
	};
	if (Array.isArray(msg.evidenceFiles) && msg.evidenceFiles.length > 0) {
		for (const item of msg.evidenceFiles) addFile(item);
		if (files.size > 0) return Array.from(files);
	}
	if (Array.isArray(msg.toolCalls)) {
		for (const tc of msg.toolCalls) {
			if (tc.status === "error") continue;
			for (const file of extractKioskToolFiles(tc)) addFile(file);
		}
	}
	return Array.from(files);
};

type StructuredAgentChunk = Extract<
	AgentResponseChunk,
	{
		type:
			| "grounding"
			| "artifact"
			| "provider_session"
			| "processing_disclosure";
	}
>;

export function formatStructuredAgentChunk(
	chunk: StructuredAgentChunk,
): string {
	switch (chunk.type) {
		case "grounding": {
			const sources = chunk.sources
				.map((source) => {
					const uris = source.sourceUris.join(", ");
					return uris ? `${source.title} (${uris})` : source.title;
				})
				.join("; ");
			return `\n\n[Grounding: ${chunk.status}]${sources ? ` ${sources}` : ""}`;
		}
		case "artifact": {
			const name = chunk.artifact.name ?? chunk.artifact.id;
			return `\n\n[Artifact: ${chunk.artifact.kind} ${name}] id=${chunk.artifact.id} localRef=${chunk.artifact.localRef} ${chunk.artifact.mimeType}, ${chunk.artifact.sizeBytes} bytes`;
		}
		case "provider_session":
			return `\n\n[Provider session: ${chunk.state}] sessionId=${chunk.sessionId} providerSessionRef=${chunk.providerSessionRef}`;
		case "processing_disclosure": {
			const target = [chunk.provider, chunk.model].filter(Boolean).join("/");
			return `\n\n[Processing: ${chunk.workload} -> ${chunk.destination}, ${chunk.decision}] processingProfileRef=${chunk.processingProfileRef}${target ? ` ${target}` : ""}`;
		}
	}
}
