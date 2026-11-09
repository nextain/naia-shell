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

export const resolveKioskEvidenceFiles = (msg: ChatMessage): string[] => {
	if (msg.role !== "assistant" || msg.failure || !msg.content.trim()) {
		return [];
	}
	if (Array.isArray(msg.evidenceFiles) && msg.evidenceFiles.length > 0) {
		const explicit = new Set<string>();
		for (const item of msg.evidenceFiles) {
			const normalized = normalizeKioskEvidenceFile(item);
			if (normalized) explicit.add(normalized);
		}
		if (explicit.size > 0) {
			return Array.from(explicit);
		}
	}
	const files = new Set<string>(["AGENTS.md"]);
	const addFile = (raw: string) => {
		const normalized = normalizeKioskEvidenceFile(raw);
		if (normalized) files.add(normalized);
	};

	const contentMatches = msg.content.match(/([a-zA-Z0-9_-]+\.md)\b/g);
	if (contentMatches && contentMatches.length > 0) {
		for (const match of contentMatches) {
			addFile(match);
		}
	} else if (Array.isArray(msg.toolCalls)) {
		for (const tc of msg.toolCalls) {
			for (const file of extractKioskToolFiles(tc)) {
				addFile(file);
			}
		}
	}
	files.add("memory/guest-memory.md");
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
