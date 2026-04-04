/**
 * MemorySystem — Orchestrator for Alpha's memory architecture.
 *
 * Coordinates the 4-store memory system:
 * - Working Memory: managed by ContextManager (#65)
 * - Episodic Memory: timestamped events via MemoryAdapter
 * - Semantic Memory: facts/knowledge via MemoryAdapter
 * - Procedural Memory: skills/reflections via MemoryAdapter
 *
 * This class handles:
 * - Memory encoding (with importance gating)
 * - Memory retrieval (with context-dependent recall)
 * - Consolidation scheduling (sleep cycle analog)
 */

import { randomUUID } from "node:crypto";
import { scoreImportance, shouldStore } from "./importance.js";
import { findContradictions } from "./reconsolidation.js";
import type {
	ConsolidationResult,
	EncodingContext,
	Episode,
	Fact,
	MemoryAdapter,
	MemoryInput,
	RecallContext,
	Reflection,
} from "./types.js";

/**
 * Callback for extracting facts from episodes.
 * In production, this would call an LLM. For testing, a simple heuristic.
 */
export type FactExtractor = (episodes: Episode[]) => Promise<ExtractedFact[]>;

/** A fact extracted from episodes (before insertion) */
export interface ExtractedFact {
	content: string;
	entities: string[];
	topics: string[];
	importance: number;
	sourceEpisodeIds: string[];
}

export interface MemorySystemOptions {
	adapter: MemoryAdapter;
	/** Consolidation interval in ms (default: 30 minutes) */
	consolidationIntervalMs?: number;
	/** Custom fact extractor (default: heuristic). Inject LLM-based extractor in production. */
	factExtractor?: FactExtractor;
}

/**
 * Default heuristic fact extractor — no LLM needed.
 * Extracts "facts" by finding sentences with decision/preference keywords,
 * then merges facts that share entities (consolidation compression).
 */
async function heuristicFactExtractor(
	episodes: Episode[],
): Promise<ExtractedFact[]> {
	const rawFacts: ExtractedFact[] = [];
	const FACT_PATTERNS = [
		/(?:decided|decision|chose|prefer|always|never|must|use|switched)/i,
		/(?:결정|선택|항상|절대|반드시|사용|바꿨|변경)/,
	];

	const STOP_WORDS = new Set([
		"The",
		"This",
		"That",
		"What",
		"When",
		"How",
		"But",
		"And",
		"For",
		"We",
		"They",
		"You",
		"He",
		"She",
		"Its",
		"Our",
		"My",
		"Your",
		"Never",
		"Always",
		"Also",
		"Just",
		"Only",
		"Not",
		"All",
		"Any",
		"Team",
		"Some",
		"Each",
		"Every",
		"Most",
		"Many",
		"Much",
		"New",
		"Old",
		"First",
		"Last",
		"Next",
		"Other",
	]);

	for (const ep of episodes) {
		const hasFactPattern = FACT_PATTERNS.some((p) => p.test(ep.content));
		if (!hasFactPattern) continue;
		if (ep.importance.utility < 0.3) continue;

		// Extract simple entities: capitalized words or quoted strings
		const entities: string[] = [];
		const capWords = ep.content.match(/\b[A-Z][a-zA-Z]+(?:\.[a-zA-Z]+)?\b/g);
		if (capWords) {
			for (const w of capWords) {
				if (!STOP_WORDS.has(w)) {
					entities.push(w);
				}
			}
		}

		const uniqueEntities = [...new Set(entities)];
		rawFacts.push({
			content: ep.content.slice(0, 300),
			entities: uniqueEntities,
			topics: ep.encodingContext.project ? [ep.encodingContext.project] : [],
			importance: ep.importance.utility,
			sourceEpisodeIds: [ep.id],
		});
	}

	// Merge related facts (entity overlap + content similarity + temporal proximity)
	return mergeRelatedFacts(rawFacts, episodes);
}

/** Tokenize content for similarity comparison */
function contentTokens(text: string): Set<string> {
	const COMMON_WORDS = new Set([
		"the",
		"a",
		"an",
		"is",
		"are",
		"was",
		"were",
		"be",
		"been",
		"being",
		"have",
		"has",
		"had",
		"do",
		"does",
		"did",
		"will",
		"would",
		"could",
		"should",
		"may",
		"might",
		"shall",
		"can",
		"to",
		"of",
		"in",
		"for",
		"on",
		"with",
		"at",
		"by",
		"from",
		"as",
		"into",
		"about",
		"like",
		"we",
		"they",
		"it",
		"our",
		"its",
		"all",
		"no",
		"not",
		"but",
		"or",
		"if",
		"so",
		"up",
		"out",
		"just",
		"use",
		"over",
		"going",
		"forward",
	]);
	return new Set(
		text
			.toLowerCase()
			.replace(/[^\p{L}\p{N}\s]/gu, " ")
			.split(/\s+/)
			.filter((t) => t.length > 2 && !COMMON_WORDS.has(t)),
	);
}

/** Jaccard similarity between two token sets */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
	let intersection = 0;
	for (const t of a) {
		if (b.has(t)) intersection++;
	}
	const union = a.size + b.size - intersection;
	return union === 0 ? 0 : intersection / union;
}

/** Time window for temporal grouping: episodes within 30 minutes are likely one conversation */
const TEMPORAL_GROUP_WINDOW_MS = 30 * 60 * 1000;

/** Maximum episodes processed per consolidation cycle — guards against OOM on large backlogs */
const MAX_EPISODES_PER_CYCLE = 200;

/**
 * Merge extracted facts that share entities, have similar content, or
 * originate from temporally close episodes in the same project.
 * Uses union-find to group related facts, then combines each group into one.
 */
function mergeRelatedFacts(
	facts: ExtractedFact[],
	sourceEpisodes?: Episode[],
): ExtractedFact[] {
	if (facts.length <= 1) return facts;

	// Union-find parent array
	const parent = facts.map((_, i) => i);
	function find(idx: number): number {
		let cur = idx;
		while (parent[cur] !== cur) {
			parent[cur] = parent[parent[cur]];
			cur = parent[cur];
		}
		return cur;
	}
	function union(a: number, b: number): void {
		const ra = find(a);
		const rb = find(b);
		if (ra !== rb) parent[ra] = rb;
	}

	// 1. Union facts that share an entity
	const entityIndex = new Map<string, number[]>();
	for (let i = 0; i < facts.length; i++) {
		for (const e of facts[i].entities) {
			const key = e.toLowerCase();
			const list = entityIndex.get(key) ?? [];
			list.push(i);
			entityIndex.set(key, list);
		}
	}
	for (const indices of entityIndex.values()) {
		for (let i = 1; i < indices.length; i++) {
			union(indices[0], indices[i]);
		}
	}

	// 2. Union facts with content similarity (Jaccard ≥ 0.15)
	const tokenSets = facts.map((f) => contentTokens(f.content));
	for (let i = 0; i < facts.length; i++) {
		for (let j = i + 1; j < facts.length; j++) {
			if (find(i) === find(j)) continue;
			if (jaccardSimilarity(tokenSets[i], tokenSets[j]) >= 0.15) {
				union(i, j);
			}
		}
	}

	// 3. Temporal grouping: facts from episodes in the same project within a time window
	if (sourceEpisodes) {
		// Build source episode ID → episode map
		const epMap = new Map<string, Episode>();
		for (const ep of sourceEpisodes) {
			epMap.set(ep.id, ep);
		}

		for (let i = 0; i < facts.length; i++) {
			for (let j = i + 1; j < facts.length; j++) {
				if (find(i) === find(j)) continue;

				// Get representative episodes for each fact
				const epI = facts[i].sourceEpisodeIds
					.map((id) => epMap.get(id))
					.filter(Boolean) as Episode[];
				const epJ = facts[j].sourceEpisodeIds
					.map((id) => epMap.get(id))
					.filter(Boolean) as Episode[];
				if (epI.length === 0 || epJ.length === 0) continue;

				// Check if same project and within time window
				const sameProject = epI.some((a) =>
					epJ.some(
						(b) =>
							a.encodingContext.project &&
							a.encodingContext.project === b.encodingContext.project &&
							Math.abs(a.timestamp - b.timestamp) < TEMPORAL_GROUP_WINDOW_MS,
					),
				);
				if (sameProject) {
					// Cap group size to prevent over-merging (max 3 facts per group)
					// Use fresh find() for both sides to avoid stale roots after path compression
					const rootI = find(i);
					const rootJ = find(j);
					let groupSizeI = 0;
					let groupSizeJ = 0;
					for (let k = 0; k < facts.length; k++) {
						const rk = find(k);
						if (rk === rootI) groupSizeI++;
						if (rk === rootJ) groupSizeJ++;
					}
					if (groupSizeI + groupSizeJ <= 3) {
						union(i, j);
					}
				}
			}
		}
	}

	// Group by root
	const groups = new Map<number, number[]>();
	for (let i = 0; i < facts.length; i++) {
		const root = find(i);
		const g = groups.get(root) ?? [];
		g.push(i);
		groups.set(root, g);
	}

	// Merge each group into one fact (cap merged content at 600 chars)
	const MAX_MERGED_CONTENT = 600;
	const merged: ExtractedFact[] = [];
	for (const indices of groups.values()) {
		const group = indices.map((i) => facts[i]);
		const joinedContent = group.map((f) => f.content).join(" | ");
		merged.push({
			content: joinedContent.slice(0, MAX_MERGED_CONTENT),
			entities: [...new Set(group.flatMap((f) => f.entities))],
			topics: [...new Set(group.flatMap((f) => f.topics))],
			importance: Math.max(...group.map((f) => f.importance)),
			sourceEpisodeIds: group.flatMap((f) => f.sourceEpisodeIds),
		});
	}

	return merged;
}

export class MemorySystem {
	private readonly adapter: MemoryAdapter;
	private consolidationTimer: ReturnType<typeof setInterval> | null = null;
	private readonly consolidationIntervalMs: number;
	private readonly factExtractor: FactExtractor;
	private _isConsolidating = false;

	constructor(options: MemorySystemOptions) {
		this.adapter = options.adapter;
		this.consolidationIntervalMs =
			options.consolidationIntervalMs ?? 30 * 60 * 1000;
		this.factExtractor = options.factExtractor ?? heuristicFactExtractor;
	}

	/** Whether a consolidation cycle is currently running */
	get isConsolidating(): boolean {
		return this._isConsolidating;
	}

	// ─── Memory Encoding ──────────────────────────────────────────────────

	/**
	 * Encode a new memory from a conversation turn.
	 * Applies importance gating (amygdala analog) — low-utility inputs are dropped.
	 * Checks for contradictions with existing facts (reconsolidation).
	 *
	 * @returns The episode if stored, null if gated out
	 */
	async encode(
		input: MemoryInput,
		context: EncodingContext,
	): Promise<Episode | null> {
		const score = scoreImportance(input);

		if (!shouldStore(score)) {
			return null; // Gated out — not worth storing
		}

		const now = Date.now();
		const episode: Episode = {
			id: randomUUID(),
			content: input.content,
			role: input.role,
			summary: input.content.slice(0, 200),
			timestamp: now,
			importance: score,
			encodingContext: context,
			consolidated: false,
			recallCount: 0,
			lastAccessed: now,
			strength: score.utility,
		};

		await this.adapter.episode.store(episode);

		// Reconsolidation: check if new info contradicts existing facts
		// Runs for all stored messages — contradiction detection is cheap
		await this.checkAndReconsolidate(input.content, now);

		// Strengthen associations between entities in the encoding context
		if (context.project && context.activeFile) {
			await this.adapter.semantic.associate(
				context.project,
				context.activeFile,
			);
		}

		return episode;
	}

	/**
	 * Check new information against existing facts for contradictions.
	 * Automatically updates facts when contradictions are detected (reconsolidation).
	 *
	 * Uses vector search instead of getAll() — O(topK) instead of O(N).
	 */
	private async checkAndReconsolidate(
		newInfo: string,
		now: number,
	): Promise<void> {
		// Search for semantically similar facts instead of loading all
		const candidates = await this.adapter.semantic.search(newInfo, 10);
		const contradictions = findContradictions(candidates, newInfo);

		// Update only the first contradicted fact to avoid creating semantic duplicates
		const firstUpdate = contradictions.find(
			({ result }) => result.action === "update" && result.updatedContent,
		);
		if (firstUpdate) {
			await this.adapter.semantic.upsert({
				...firstUpdate.fact,
				content: firstUpdate.result.updatedContent!,
				updatedAt: now,
				importance: Math.max(firstUpdate.fact.importance, 0.7),
			});
		}
	}

	// ─── Memory Retrieval ─────────────────────────────────────────────────

	/**
	 * Recall relevant memories for a query.
	 * Combines episodic recall + semantic search + procedural reflections.
	 * Implements Tulving's encoding specificity — context at retrieval matters.
	 */
	async recall(
		query: string,
		context: RecallContext,
	): Promise<{
		episodes: Episode[];
		facts: Fact[];
		reflections: Reflection[];
	}> {
		const topK = context.topK ?? 3;

		const [episodes, facts, reflections] = await Promise.all([
			this.adapter.episode.recall(query, context),
			this.adapter.semantic.search(query, topK, context.deepRecall),
			this.adapter.procedural.getReflections(query, topK),
		]);

		return { episodes, facts, reflections };
	}

	/**
	 * Auto-recall for session init (L6 analog).
	 * Retrieves relevant context before first LLM call of a new session.
	 */
	async sessionRecall(
		firstMessage: string,
		context: RecallContext,
	): Promise<string> {
		const { episodes, facts, reflections } = await this.recall(firstMessage, {
			...context,
			topK: 5,
		});

		if (facts.length === 0 && reflections.length === 0 && episodes.length === 0) return "";

		const parts: string[] = [];

		if (facts.length > 0) {
			parts.push("## 관련 기억");
			for (const fact of facts) {
				parts.push(`- ${fact.content}`);
			}
		}

		// Surface recent episodes alongside facts, or as sole context when no facts exist yet.
		// Episodes capture conversations not yet consolidated into facts (consolidation runs
		// on a background timer — episodes may be more up-to-date than the fact store).
		if (episodes.length > 0) {
			parts.push("## 이전 대화에서");
			for (const ep of episodes) {
				// ep.role can be any string at runtime (JSON deserialization from older stores)
				const roleStr: string | undefined = ep.role;
				let prefix: string;
				if (roleStr === "user") {
					prefix = "사용자";
				} else if (roleStr === "assistant") {
					prefix = "Naia";
				} else if (roleStr === "tool") {
					prefix = "도구";
				} else if (roleStr === undefined) {
					prefix = "기록";
				} else {
					// Unexpected role value (e.g., corrupted stored data) — log for observability
					console.warn(`[MemorySystem] sessionRecall: unexpected episode role: ${roleStr}`);
					prefix = "기록";
				}
				parts.push(`- ${prefix}: ${ep.content}`);
			}
		}

		if (reflections.length > 0) {
			parts.push("## 과거 경험에서 배운 것");
			for (const ref of reflections) {
				parts.push(`- ${ref.task}: ${ref.correction}`);
			}
		}

		return parts.join("\n");
	}

	// ─── Procedural Learning ──────────────────────────────────────────────

	/**
	 * Record a task failure with self-reflection (Reflexion pattern).
	 */
	async reflectOnFailure(
		task: string,
		failure: string,
		analysis: string,
		correction: string,
	): Promise<void> {
		const reflection: Reflection = {
			task,
			failure,
			analysis,
			correction,
			timestamp: Date.now(),
		};
		await this.adapter.procedural.learnFromFailure(reflection);
	}

	// ─── Consolidation (Sleep Cycle) ──────────────────────────────────────

	/**
	 * Start the background consolidation timer.
	 * Runs periodically during idle time, like sleep-cycle memory consolidation.
	 *
	 * Neuroscience basis: during slow-wave sleep, the hippocampus replays
	 * recent experiences and transfers patterns to the neocortex.
	 */
	startConsolidation(): void {
		if (this.consolidationTimer) return;
		this.consolidationTimer = setInterval(async () => {
			try {
				await this.consolidateNow();
			} catch (err) {
				// Non-critical — log and continue
				console.error("[MemorySystem] consolidation error:", err);
			}
		}, this.consolidationIntervalMs);
	}

	/** Stop the consolidation timer */
	stopConsolidation(): void {
		if (this.consolidationTimer) {
			clearInterval(this.consolidationTimer);
			this.consolidationTimer = null;
		}
	}

	/**
	 * Run a full consolidation cycle on demand.
	 *
	 * Pipeline:
	 * 1. Extract facts from unconsolidated episodes (hippocampal replay)
	 * 2. Check extracted facts against existing facts (reconsolidation)
	 * 3. Upsert new/updated facts into semantic memory
	 * 4. Mark processed episodes as consolidated
	 * 5. Run adapter-level decay + association cleanup
	 */
	async consolidateNow(): Promise<ConsolidationResult> {
		if (this._isConsolidating) {
			return {
				episodesProcessed: 0,
				factsCreated: 0,
				factsUpdated: 0,
				memoriesPruned: 0,
				associationsUpdated: 0,
			};
		}
		this._isConsolidating = true;

		try {
			const now = Date.now();
			let factsCreated = 0;
			let factsUpdated = 0;

			// 1. Get unconsolidated episodes
			// LocalAdapter returns insertion order (oldest-first); slice preserves that order.
			const unconsolidated = await this.adapter.episode.getUnconsolidated();
			const readyEpisodes = unconsolidated
				.filter((ep) => now - ep.timestamp > 5 * 60 * 1000) // At least 5 minutes old
				.slice(0, MAX_EPISODES_PER_CYCLE); // Cap batch size — oldest first

			if (readyEpisodes.length > 0) {
				// 2. Extract facts from episodes
				const extracted = await this.factExtractor(readyEpisodes);

				// Dedup entity-pair associations across the entire cycle (not just per-fact)
				const seenPairs = new Set<string>();

				// 3. For each extracted fact, check contradictions and upsert
				for (const ef of extracted) {
					// Search for semantically similar facts instead of getAll() — O(topK) not O(N)
					const existingFacts = await this.adapter.semantic.search(
						ef.content,
						10,
					);
					const contradictions = findContradictions(existingFacts, ef.content);

					if (contradictions.length > 0) {
						// Update only the first contradicted fact to avoid duplicates
						// Use result.updatedContent (reconciled by findContradictions) when available,
						// falling back to ef.content — consistent with checkAndReconsolidate().
						const firstUpdate = contradictions.find(
							({ result }) => result.action === "update" && result.updatedContent,
						);
						if (firstUpdate) {
							await this.adapter.semantic.upsert({
								...firstUpdate.fact,
								content: firstUpdate.result.updatedContent!,
								updatedAt: now,
								importance: Math.max(
									firstUpdate.fact.importance,
									ef.importance,
								),
								sourceEpisodes: [
									...new Set([
										...firstUpdate.fact.sourceEpisodes,
										...ef.sourceEpisodeIds,
									]),
								],
							});
							factsUpdated++;
						}
					} else {
						// New fact — create
						const newFact: Fact = {
							id: randomUUID(),
							content: ef.content,
							entities: ef.entities,
							topics: ef.topics,
							createdAt: now,
							updatedAt: now,
							importance: ef.importance,
							recallCount: 0,
							lastAccessed: now,
							strength: ef.importance,
							sourceEpisodes: ef.sourceEpisodeIds,
						};
						await this.adapter.semantic.upsert(newFact);
						factsCreated++;
					}

					// Strengthen associations between extracted entities (cycle-level dedup)
					for (let i = 0; i < ef.entities.length; i++) {
						for (let j = i + 1; j < ef.entities.length; j++) {
							const a = ef.entities[i].toLowerCase();
							const b = ef.entities[j].toLowerCase();
							const pairKey = a < b ? `${a}|${b}` : `${b}|${a}`;
							if (seenPairs.has(pairKey)) continue;
							seenPairs.add(pairKey);
							await this.adapter.semantic.associate(a, b, 0.05);
						}
					}
				}

				// 4. Mark episodes as consolidated
				await this.adapter.episode.markConsolidated(
					readyEpisodes.map((ep) => ep.id),
				);
			}

			// 5. Run adapter-level decay + cleanup
			const adapterResult = await this.adapter.consolidate();

			return {
				episodesProcessed: readyEpisodes.length,
				factsCreated,
				factsUpdated,
				memoriesPruned: adapterResult.memoriesPruned,
				associationsUpdated: adapterResult.associationsUpdated,
			};
		} finally {
			this._isConsolidating = false;
		}
	}

	// ─── Lifecycle ────────────────────────────────────────────────────────

	async close(): Promise<void> {
		this.stopConsolidation();
		await this.adapter.close();
	}
}
