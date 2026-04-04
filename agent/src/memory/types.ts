/**
 * Alpha Memory System — Type definitions
 *
 * 4-store architecture inspired by Tulving's memory taxonomy + CLS theory:
 * - Episodic (Hippocampus): timestamped events with context
 * - Semantic (Neocortex): facts, entities, relationships
 * - Procedural (Basal Ganglia): skills, learned strategies
 * - Working Memory managed by ContextManager (#65)
 */

// ─── Importance Scoring (Amygdala) ───────────────────────────────────────────

/** 3-axis importance score inspired by CraniMem (2025) */
export interface ImportanceScore {
	/** How relevant to user's current goals (0.0–1.0) */
	importance: number;
	/** How unexpected/novel this information is (0.0–1.0) */
	surprise: number;
	/** User's emotional valence detected (0.0–1.0, where 0.5 = neutral) */
	emotion: number;
	/** Combined utility score */
	utility: number;
}

/** Input to the importance scoring function */
export interface MemoryInput {
	content: string;
	role: "user" | "assistant" | "tool";
	/** Current conversation context for scoring */
	context?: string;
}

// ─── Episodic Memory (Hippocampus) ───────────────────────────────────────────

/** A single episode — a timestamped event with full context */
export interface Episode {
	id: string;
	/** The content of the episode */
	content: string;
	/** Speaker role */
	role?: "user" | "assistant" | "tool";
	/** Summary for retrieval (shorter than content) */
	summary: string;
	/** When this happened */
	timestamp: number;
	/** Importance score at time of encoding */
	importance: ImportanceScore;
	/** Context at encoding (for encoding specificity principle) */
	encodingContext: EncodingContext;
	/** Has this episode been consolidated into semantic memory? */
	consolidated: boolean;
	/** Number of times this episode has been recalled */
	recallCount: number;
	/** Last time this episode was accessed */
	lastAccessed: number;
	/** Current memory strength (Ebbinghaus decay applied) */
	strength: number;
}

/** Context captured at the time of memory encoding (Tulving's encoding specificity) */
export interface EncodingContext {
	/** What project/workspace was active */
	project?: string;
	/** What file was being discussed */
	activeFile?: string;
	/** What task was being worked on */
	taskDescription?: string;
	/** Session identifier */
	sessionId?: string;
}

/** Context used when recalling episodes */
export interface RecallContext {
	/** Current project for context-dependent retrieval */
	project?: string;
	/** Current file being discussed */
	activeFile?: string;
	/** Max number of episodes to return */
	topK?: number;
	/** Minimum strength threshold */
	minStrength?: number;
	/**
	 * Deep recall mode — search long-term memory ignoring decay.
	 * Triggered when user explicitly asks about forgotten memories
	 * ("왜 잊었어?", "예전에 뭐라고 했었지?").
	 * Uses pure vector similarity without strength weighting.
	 */
	deepRecall?: boolean;
}

// ─── Semantic Memory (Neocortex) ─────────────────────────────────────────────

/** A semantic fact — general knowledge extracted from episodes */
export interface Fact {
	id: string;
	/** The fact content */
	content: string;
	/** Extracted entities (people, tools, concepts) */
	entities: string[];
	/** Topic categories */
	topics: string[];
	/** When first created */
	createdAt: number;
	/** When last updated (reconsolidation) */
	updatedAt: number;
	/** Base importance (set at creation, modifiable) */
	importance: number;
	/** Number of times retrieved */
	recallCount: number;
	/** Last accessed timestamp */
	lastAccessed: number;
	/** Current strength (Ebbinghaus decay) */
	strength: number;
	/** Source episode IDs that contributed to this fact */
	sourceEpisodes: string[];
	/** Cosine similarity score from vector search (0.0–1.0, optional) */
	relevanceScore?: number;
}

// ─── Procedural Memory (Basal Ganglia / Cerebellum) ──────────────────────────

/** A learned skill/strategy from experience */
export interface Skill {
	id: string;
	/** Skill name / identifier */
	name: string;
	/** What this skill does */
	description: string;
	/** When was the strategy learned */
	learnedAt: number;
	/** How many times successfully applied */
	successCount: number;
	/** How many times it failed */
	failureCount: number;
	/** Current confidence (success / (success + failure)) */
	confidence: number;
}

/** A self-reflection from a failure (Reflexion pattern) */
export interface Reflection {
	/** What task was attempted */
	task: string;
	/** What went wrong */
	failure: string;
	/** Self-critique: why it failed */
	analysis: string;
	/** What to do differently next time */
	correction: string;
	/** When this reflection was created */
	timestamp: number;
}

// ─── Consolidation ──────────────────────────────────────────────────────────

/** Result of a consolidation cycle (sleep cycle analog) */
export interface ConsolidationResult {
	/** Number of episodes processed */
	episodesProcessed: number;
	/** Number of new facts extracted */
	factsCreated: number;
	/** Number of existing facts updated (reconsolidated) */
	factsUpdated: number;
	/** Number of weak memories pruned (below decay threshold) */
	memoriesPruned: number;
	/** Associations strengthened */
	associationsUpdated: number;
}

// ─── Memory Adapter Interface ───────────────────────────────────────────────

/**
 * Abstract memory adapter — gateway-independent.
 *
 * LocalAdapter (JSON file) is always functional.
 * Future adapters (cloud, distributed) can be added without changing consumers.
 */
export interface MemoryAdapter {
	/** Episodic memory operations (Hippocampus) */
	episode: {
		/** Store a new episode */
		store(event: Episode): Promise<void>;
		/** Recall episodes matching query + context (encoding specificity) */
		recall(query: string, context: RecallContext): Promise<Episode[]>;
		/** Get N most recent episodes */
		getRecent(n: number): Promise<Episode[]>;
		/** Get unconsolidated episodes for background processing */
		getUnconsolidated(): Promise<Episode[]>;
		/** Mark episodes as consolidated */
		markConsolidated(ids: string[]): Promise<void>;
	};

	/** Semantic memory operations (Neocortex) */
	semantic: {
		/** Insert or update a fact (includes reconsolidation logic) */
		upsert(fact: Fact): Promise<void>;
		/** Search facts by query string. deepRecall ignores decay for long-term retrieval. */
		search(query: string, topK: number, deepRecall?: boolean): Promise<Fact[]>;
		/** Run Ebbinghaus decay sweep, returns number of pruned memories */
		decay(now: number): Promise<number>;
		/** Strengthen association between two entities (Hebbian) */
		associate(entityA: string, entityB: string, weight?: number): Promise<void>;
		/** Get all facts (for full consolidation) */
		getAll(): Promise<Fact[]>;
		/** Delete a fact by ID. Returns true if found and deleted. */
		delete(id: string): Promise<boolean>;
	};

	/** Procedural memory operations (Basal Ganglia) */
	procedural: {
		/** Get a learned skill by name */
		getSkill(name: string): Promise<Skill | null>;
		/** Record a skill usage result */
		recordOutcome(name: string, success: boolean): Promise<void>;
		/** Store a self-reflection from a failure (Reflexion pattern) */
		learnFromFailure(reflection: Reflection): Promise<void>;
		/** Get reflections relevant to a task */
		getReflections(task: string, topK: number): Promise<Reflection[]>;
	};

	/** Run a full consolidation cycle (sleep cycle analog) */
	consolidate(): Promise<ConsolidationResult>;

	/** Close the adapter and release resources */
	close(): Promise<void>;
}
