/**
 * Memory Bridge — naia-memory MemorySystem ↔ @nextain/agent-types MemoryProvider.
 *
 * R4 Phase 4.1 Day 4.5.1 — naia-os MemorySystem (naia-memory ref impl) 을
 * @nextain/agent-types MemoryProvider interface로 wrap. external Agent.run()
 * 또는 HostContext.memory에 주입할 수 있도록 contract 정합.
 *
 * Spec: r4-phase4-day1-1-interface-mapping.md §3.3 (Memory)
 *       4-repo plan A.6 (memory = naia-memory adapter)
 *
 * Mapping:
 *   naia-memory `MemorySystem.encode(input, context)` →
 *     MemoryProvider `encode(input)` — context 자동 생성 (project/sessionId)
 *   naia-memory `MemorySystem.recall(query, context) → {episodes, facts, reflections}` →
 *     MemoryProvider `recall(query, opts) → MemoryHit[]` — facts/episodes 통합
 *   naia-memory `consolidateNow()` → MemoryProvider `consolidate() → ConsolidationSummary`
 *   naia-memory `sessionRecall()` → MemoryProvider SessionRecallCapable (capability)
 *   naia-memory `compact()` → MemoryProvider CompactableCapable (capability)
 *   naia-memory `close()` → MemoryProvider `close()`
 */

import type { MemorySystem } from "@nextain/naia-memory";
import type {
	CompactableCapable,
	CompactionInput,
	CompactionResult,
	ConsolidationSummary,
	MemoryHit,
	MemoryInput,
	MemoryProvider,
	RecallOpts,
	SessionRecallCapable,
} from "@nextain/agent-types";

export interface NaiaMemoryProviderOptions {
	/** Default project context for encode/recall (HostContext source). */
	defaultProject?: string;
	/** Default session id for context continuity. */
	defaultSessionId?: string;
}

/**
 * Wrap an naia-memory MemorySystem instance as MemoryProvider + capabilities.
 *
 * Usage:
 *   const ms = new MemorySystem({ adapter: new LocalAdapter(path) });
 *   const provider = createNaiaMemoryProvider(ms, { defaultProject: "naia-os" });
 *   // pass to HostContext.memory for external Agent.run()
 */
export function createNaiaMemoryProvider(
	memorySystem: MemorySystem,
	opts: NaiaMemoryProviderOptions = {},
): MemoryProvider & SessionRecallCapable & CompactableCapable {
	const defaultProject = opts.defaultProject ?? "naia-os";

	const provider: MemoryProvider & SessionRecallCapable & CompactableCapable = {
		async encode(input: MemoryInput): Promise<void> {
			// naia-memory encode requires EncodingContext — synthesize from
			// MemoryProvider input.context if present, else use defaults.
			// Note: naia-memory MemoryInput.context is `string | undefined`
			// (single-string scoring hint), while MemoryProvider input.context is
			// `Record<string, string>`. We translate: take .context.scoring (or
			// stringify) for naia-memory's scoring string, pass other keys via
			// EncodingContext (project / sessionId / activeFile).
			const project = input.context?.["project"] ?? defaultProject;
			const sessionId = input.context?.["sessionId"] ?? opts.defaultSessionId;
			const activeFile = input.context?.["activeFile"];
			const scoringHint = input.context?.["scoring"];

			const ctx: { project?: string; sessionId?: string; activeFile?: string } = { project };
			if (sessionId !== undefined) ctx.sessionId = sessionId;
			if (activeFile !== undefined) ctx.activeFile = activeFile;

			// Translate to naia-memory's MemoryInput shape.
			const amInput: { content: string; role: "user" | "assistant" | "tool"; context?: string; timestamp?: number } = {
				content: input.content,
				role: input.role,
			};
			if (scoringHint !== undefined) amInput.context = scoringHint;
			if (input.timestamp !== undefined) amInput.timestamp = input.timestamp;

			await memorySystem.encode(amInput, ctx);
		},

		async recall(query: string, options: RecallOpts = {}): Promise<MemoryHit[]> {
			const topK = options.topK ?? 5;
			const recallContext: {
				topK: number;
				deepRecall?: boolean;
				project?: string;
			} = { topK };
			if (options.deepRecall !== undefined) {
				recallContext.deepRecall = options.deepRecall;
			}
			recallContext.project = options.context?.["project"] ?? defaultProject;

			const result = await memorySystem.recall(query, recallContext);
			const hits: MemoryHit[] = [];

			// Facts first (most processed/normalized).
			for (const fact of result.facts) {
				hits.push({
					id: fact.id,
					content: fact.content,
					score: normalizeScore(fact.importance ?? 0.5),
					timestamp: fact.createdAt,
					metadata: { source: "fact", status: fact.status },
				});
			}

			// Episodes second (raw events with summary).
			for (const ep of result.episodes) {
				hits.push({
					id: ep.id,
					content: ep.content,
					summary: ep.summary,
					score: normalizeScore(ep.strength ?? ep.importance?.utility ?? 0.5),
					timestamp: ep.timestamp,
					metadata: { source: "episode", role: ep.role },
				});
			}

			// Apply minStrength filter if requested.
			const filtered = options.minStrength !== undefined
				? hits.filter((h) => h.score >= options.minStrength!)
				: hits;

			// Sort by score descending, cap at topK.
			filtered.sort((a, b) => b.score - a.score);
			return filtered.slice(0, topK);
		},

		async consolidate(): Promise<ConsolidationSummary> {
			const startedAt = Date.now();
			const result = await memorySystem.consolidateNow(false);
			return {
				factsCreated: result.factsCreated ?? 0,
				durationMs: Date.now() - startedAt,
			};
		},

		async close(): Promise<void> {
			await memorySystem.close();
		},

		// SessionRecallCapable
		async sessionRecall(text: string, sessionOpts?: { topK?: number }): Promise<string | null> {
			const ctx: { topK: number; project?: string } = {
				topK: sessionOpts?.topK ?? 20,
				project: defaultProject,
			};
			const text_or_empty = await memorySystem.sessionRecall(text, ctx);
			return text_or_empty.length > 0 ? text_or_empty : null;
		},

		// CompactableCapable
		async compact(input: CompactionInput): Promise<CompactionResult> {
			// naia-memory compact() signature subset matching.
			const result = await memorySystem.compact({
				messages: input.messages.map((m) => ({
					role: m.role,
					content: m.content,
					...(m.timestamp !== undefined ? { timestamp: m.timestamp } : {}),
				})),
				keepTail: input.keepTail,
				targetTokens: input.targetTokens,
				...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
			});
			return {
				summary: {
					role: "assistant",
					content: result.summary?.content ?? "",
				},
				droppedCount: result.droppedCount ?? 0,
				...(result.realtime !== undefined ? { realtime: result.realtime } : {}),
			};
		},
	};

	return provider;
}

/** Normalize score to [0, 1] — naia-memory uses [0, 1] semantics already. */
function normalizeScore(s: number): number {
	if (Number.isNaN(s)) return 0;
	if (s < 0) return 0;
	if (s > 1) return 1;
	return s;
}
