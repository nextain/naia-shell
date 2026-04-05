/**
 * LocalAdapter — JSON file-backed MemoryAdapter implementation.
 *
 * Always functional, no external dependencies.
 * Uses atomic write (write-to-temp + rename) for crash safety.
 * Suitable for desktop companion use — the data volume is manageable in JSON.
 *
 * Future: can be swapped to SQLite (better-sqlite3) if query performance
 * becomes a bottleneck. For now, simplicity wins (ChatGPT Memory approach).
 */

import {
	createCipheriv,
	createDecipheriv,
	pbkdf2,
	randomBytes,
	randomUUID,
} from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { calculateStrength, shouldPrune } from "../decay.js";
import {
	type KGState,
	KnowledgeGraph,
	emptyKGState,
} from "../knowledge-graph.js";
import type {
	BackupCapable,
	ConsolidationResult,
	Episode,
	Fact,
	MemoryAdapter,
	RecallContext,
	Reflection,
	Skill,
} from "../types.js";

const pbkdf2Async = promisify(pbkdf2);

/** On-disk schema for JSON persistence */
interface MemoryStore {
	version: 1;
	episodes: Episode[];
	facts: Fact[];
	skills: Skill[];
	reflections: Reflection[];
	/** Hebbian association weights: "entityA::entityB" → weight */
	associations: Record<string, number>;
	/** Knowledge graph state (Phase 2) */
	knowledgeGraph?: KGState;
}

function emptyStore(): MemoryStore {
	return {
		version: 1,
		episodes: [],
		facts: [],
		skills: [],
		reflections: [],
		associations: {},
	};
}

/** Normalize association key (alphabetical order for consistency) */
function assocKey(a: string, b: string): string {
	const sorted = [a.toLowerCase(), b.toLowerCase()].sort();
	return `${sorted[0]}::${sorted[1]}`;
}

/** Simple keyword tokenizer for search */
function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.split(/\s+/)
		.filter((t) => t.length > 1);
}

/**
 * Score relevance of a document to a query.
 * Uses substring matching as fallback for Korean particles (e.g., "TypeScript로")
 * and partial matches that exact tokenization misses.
 */
function keywordScore(query: string, document: string): number {
	const queryTokens = tokenize(query);
	const docLower = document.toLowerCase();
	const docTokens = new Set(tokenize(document));
	if (queryTokens.length === 0) return 0;

	let hits = 0;
	for (const qt of queryTokens) {
		if (docTokens.has(qt)) {
			hits++;
		} else if (docLower.includes(qt)) {
			// Substring match — handles Korean particles (TypeScript로, Cursor로)
			hits += 0.8;
		}
	}
	return hits / queryTokens.length;
}

export class LocalAdapter implements MemoryAdapter, BackupCapable {
	private store: MemoryStore;
	private readonly storePath: string;
	private dirty = false;
	private kg: KnowledgeGraph;

	constructor(storePath?: string) {
		this.storePath =
			storePath ?? join(homedir(), ".naia", "memory", "alpha-memory.json");
		this.store = this.load();
		// Initialize knowledge graph from persisted state
		if (!this.store.knowledgeGraph) {
			this.store.knowledgeGraph = emptyKGState();
		}
		this.kg = new KnowledgeGraph(this.store.knowledgeGraph);
	}

	// ─── Persistence ──────────────────────────────────────────────────────

	private load(): MemoryStore {
		try {
			if (existsSync(this.storePath)) {
				const raw = readFileSync(this.storePath, "utf-8");
				const parsed = JSON.parse(raw) as MemoryStore;
				if (parsed.version === 1) return parsed;
			}
		} catch {
			// Corrupted file — start fresh
		}
		return emptyStore();
	}

	private save(): void {
		if (!this.dirty) return;
		const dir = dirname(this.storePath);
		mkdirSync(dir, { recursive: true });
		const tmpPath = `${this.storePath}.tmp`;
		writeFileSync(tmpPath, JSON.stringify(this.store, null, "\t"), "utf-8");
		renameSync(tmpPath, this.storePath);
		this.dirty = false;
	}

	private markDirty(): void {
		this.dirty = true;
	}

	// ─── Episodic Memory ──────────────────────────────────────────────────

	episode = {
		store: async (event: Episode): Promise<void> => {
			this.store.episodes.push(event);
			this.markDirty();
			this.save();
		},

		recall: async (
			query: string,
			context: RecallContext,
		): Promise<Episode[]> => {
			const now = Date.now();
			const topK = context.topK ?? 5;
			const minStrength = context.minStrength ?? 0.05;

			const deepRecall = context.deepRecall ?? false;

			const scored = this.store.episodes
				.map((ep) => {
					// Recalculate strength with current time
					const strength = calculateStrength(
						ep.importance.utility,
						ep.timestamp,
						ep.recallCount,
						ep.lastAccessed,
						now,
					);

					// deepRecall: skip strength filter to retrieve old memories
					if (!deepRecall && strength < minStrength) return null;

					// Keyword relevance
					const textScore = keywordScore(query, `${ep.content} ${ep.summary}`);

					// Context bonus (encoding specificity)
					let contextBonus = 0;
					if (
						context.project &&
						ep.encodingContext.project === context.project
					) {
						contextBonus += 0.2;
					}
					if (
						context.activeFile &&
						ep.encodingContext.activeFile === context.activeFile
					) {
						contextBonus += 0.1;
					}

					// deepRecall: ignore decay in scoring
					const finalScore = deepRecall
						? textScore + contextBonus
						: textScore * strength + contextBonus;
					return { episode: ep, score: finalScore, strength };
				})
				.filter((x): x is NonNullable<typeof x> => x !== null && x.score > 0)
				.sort((a, b) => b.score - a.score)
				.slice(0, topK);

			// Update recall counts (reconsolidation: retrieval strengthens memory)
			for (const { episode } of scored) {
				episode.recallCount++;
				episode.lastAccessed = now;
				episode.strength = calculateStrength(
					episode.importance.utility,
					episode.timestamp,
					episode.recallCount,
					episode.lastAccessed,
					now,
				);
			}
			if (scored.length > 0) {
				this.markDirty();
				this.save();
			}

			return scored.map((s) => s.episode);
		},

		getRecent: async (n: number): Promise<Episode[]> => {
			return this.store.episodes
				.slice()
				.sort((a, b) => b.timestamp - a.timestamp)
				.slice(0, n);
		},

		getUnconsolidated: async (): Promise<Episode[]> => {
			return this.store.episodes.filter((ep) => !ep.consolidated);
		},

		markConsolidated: async (ids: string[]): Promise<void> => {
			const idSet = new Set(ids);
			for (const ep of this.store.episodes) {
				if (idSet.has(ep.id)) {
					ep.consolidated = true;
				}
			}
			this.markDirty();
			this.save();
		},
	};

	// ─── Semantic Memory ──────────────────────────────────────────────────

	semantic = {
		upsert: async (fact: Fact): Promise<void> => {
			const now = Date.now();
			const existing = this.store.facts.find((f) => f.id === fact.id);
			if (existing) {
				// Reconsolidation: update content, merge entities/topics, refresh timestamp
				existing.content = fact.content;
				existing.entities = [
					...new Set([...existing.entities, ...fact.entities]),
				];
				existing.topics = [...new Set([...existing.topics, ...fact.topics])];
				existing.updatedAt = fact.updatedAt;
				existing.importance = Math.max(existing.importance, fact.importance);
				existing.sourceEpisodes = [
					...new Set([...existing.sourceEpisodes, ...fact.sourceEpisodes]),
				];
			} else {
				this.store.facts.push(fact);
			}

			// Register entities in knowledge graph and strengthen co-occurrence edges
			const entities = existing?.entities ?? fact.entities;
			for (const entity of entities) {
				this.kg.touchNode(entity, now);
			}
			// Strengthen edges between all entity pairs in this fact (Hebbian)
			for (let i = 0; i < entities.length; i++) {
				for (let j = i + 1; j < entities.length; j++) {
					this.kg.strengthen(entities[i], entities[j], 0.05, now);
				}
			}

			this.markDirty();
			this.save();
		},

		search: async (
			query: string,
			topK: number,
			deepRecall = false,
		): Promise<Fact[]> => {
			const now = Date.now();
			const queryTokens = tokenize(query);

			// Spreading activation: find related entities via knowledge graph
			const activatedEntities = this.kg.spreadingActivation(
				queryTokens,
				2,
				0.5,
			);
			const activationMap = new Map<string, number>();
			for (const { entity, activation } of activatedEntities) {
				activationMap.set(entity, activation);
			}

			const scored = this.store.facts
				.map((fact) => {
					const strength = calculateStrength(
						fact.importance,
						fact.createdAt,
						fact.recallCount,
						fact.lastAccessed,
						now,
					);

					// Keyword match on content + entities + topics
					const searchText = [
						fact.content,
						...fact.entities,
						...fact.topics,
					].join(" ");
					const textScore = keywordScore(query, searchText);

					// Entity exact match bonus
					let entityBonus = 0;
					for (const qt of queryTokens) {
						if (fact.entities.some((e) => e.toLowerCase().includes(qt))) {
							entityBonus += 0.15;
						}
					}

					// Spreading activation bonus: boost facts with associated entities
					let activationBonus = 0;
					for (const entity of fact.entities) {
						const act = activationMap.get(entity.toLowerCase());
						if (act) activationBonus += act * 0.1;
					}

					// deepRecall: ignore decay, use pure text relevance
					const finalScore = deepRecall
						? textScore + entityBonus + activationBonus
						: (textScore + entityBonus + activationBonus) * strength;
					return { fact, score: finalScore, strength };
				})
				.filter((x) => x.score > 0)
				.sort((a, b) => b.score - a.score)
				.slice(0, topK);

			// Update recall counts
			for (const { fact } of scored) {
				fact.recallCount++;
				fact.lastAccessed = now;
				fact.strength = calculateStrength(
					fact.importance,
					fact.createdAt,
					fact.recallCount,
					fact.lastAccessed,
					now,
				);
			}
			if (scored.length > 0) {
				this.markDirty();
				this.save();
			}

			return scored.map((s) => s.fact);
		},

		decay: async (now: number): Promise<number> => {
			const before = this.store.facts.length;
			this.store.facts = this.store.facts.filter((fact) => {
				const strength = calculateStrength(
					fact.importance,
					fact.createdAt,
					fact.recallCount,
					fact.lastAccessed,
					now,
				);
				fact.strength = strength;
				return !shouldPrune(strength);
			});
			const pruned = before - this.store.facts.length;

			// Also decay episodes
			const epBefore = this.store.episodes.length;
			this.store.episodes = this.store.episodes.filter((ep) => {
				const strength = calculateStrength(
					ep.importance.utility,
					ep.timestamp,
					ep.recallCount,
					ep.lastAccessed,
					now,
				);
				ep.strength = strength;
				// Keep consolidated episodes longer (they've contributed to semantic memory)
				return !shouldPrune(strength) || ep.consolidated;
			});
			const totalPruned = pruned + (epBefore - this.store.episodes.length);

			if (totalPruned > 0) {
				this.markDirty();
				this.save();
			}
			return totalPruned;
		},

		associate: async (
			entityA: string,
			entityB: string,
			weight = 0.1,
		): Promise<void> => {
			const key = assocKey(entityA, entityB);
			const current = this.store.associations[key] ?? 0;
			// Hebbian: strengthen on co-access, cap at 1.0
			this.store.associations[key] = Math.min(1.0, current + weight);
			// Also update knowledge graph
			this.kg.strengthen(entityA, entityB, weight);
			this.markDirty();
			this.save();
		},

		getAll: async (): Promise<Fact[]> => {
			return [...this.store.facts];
		},

		delete: async (id: string): Promise<boolean> => {
			const idx = this.store.facts.findIndex((f) => f.id === id);
			if (idx === -1) return false;
			this.store.facts.splice(idx, 1);
			this.markDirty();
			this.save();
			return true;
		},
	};

	// ─── Procedural Memory ────────────────────────────────────────────────

	procedural = {
		getSkill: async (name: string): Promise<Skill | null> => {
			return this.store.skills.find((s) => s.name === name) ?? null;
		},

		recordOutcome: async (name: string, success: boolean): Promise<void> => {
			const skill = this.store.skills.find((s) => s.name === name);
			if (skill) {
				if (success) skill.successCount++;
				else skill.failureCount++;
				skill.confidence =
					skill.successCount / (skill.successCount + skill.failureCount);
			} else {
				this.store.skills.push({
					id: randomUUID(),
					name,
					description: "",
					learnedAt: Date.now(),
					successCount: success ? 1 : 0,
					failureCount: success ? 0 : 1,
					confidence: success ? 1.0 : 0.0,
				});
			}
			this.markDirty();
			this.save();
		},

		learnFromFailure: async (reflection: Reflection): Promise<void> => {
			this.store.reflections.push(reflection);
			this.markDirty();
			this.save();
		},

		getReflections: async (
			task: string,
			topK: number,
		): Promise<Reflection[]> => {
			return this.store.reflections
				.map((r) => ({
					reflection: r,
					score: keywordScore(task, `${r.task} ${r.failure} ${r.analysis}`),
				}))
				.filter((x) => x.score > 0)
				.sort((a, b) => b.score - a.score)
				.slice(0, topK)
				.map((x) => x.reflection);
		},
	};

	// ─── Consolidation ────────────────────────────────────────────────────

	async consolidate(): Promise<ConsolidationResult> {
		const result: ConsolidationResult = {
			episodesProcessed: 0,
			factsCreated: 0,
			factsUpdated: 0,
			memoriesPruned: 0,
			associationsUpdated: 0,
		};

		const now = Date.now();

		// 1. Decay sweep
		result.memoriesPruned = await this.semantic.decay(now);

		// 2. Association decay (Hebbian: unused associations weaken)
		const keysToRemove: string[] = [];
		for (const [key, weight] of Object.entries(this.store.associations)) {
			const decayed = weight * 0.95; // 5% decay per consolidation cycle
			if (decayed < 0.01) {
				keysToRemove.push(key);
			} else {
				this.store.associations[key] = decayed;
				result.associationsUpdated++;
			}
		}
		for (const key of keysToRemove) {
			delete this.store.associations[key];
		}

		// 3. Knowledge graph edge decay
		result.associationsUpdated += this.kg.decayEdges(0.95, 0.01);

		// 4. Mark unconsolidated episodes older than 1 hour as ready for extraction
		// (actual fact extraction requires LLM — done by MemorySystem, not adapter)
		const unconsolidated = this.store.episodes.filter(
			(ep) => !ep.consolidated && now - ep.timestamp > 60 * 60 * 1000,
		);
		result.episodesProcessed = unconsolidated.length;

		this.markDirty();
		this.save();

		return result;
	}

	// ─── Backup / Restore (E2E Encrypted Blob) ───────────────────────────

	/**
	 * Export all memory as an AES-256-GCM encrypted blob.
	 *
	 * Blob layout:
	 *   4 bytes  magic    "NAIA"
	 *   1 byte   version  0x01
	 *   16 bytes salt     (PBKDF2 input)
	 *   12 bytes iv       (AES-GCM nonce)
	 *   16 bytes authTag  (AES-GCM authentication tag)
	 *   N bytes  ciphertext
	 *
	 * Total fixed header: 49 bytes. Integrity is provided by AES-GCM authTag —
	 * a separate SHA-256 over plaintext is not included because GCM already
	 * authenticates the ciphertext under the derived key.
	 *
	 * Key derivation: PBKDF2-SHA256, 200_000 iterations, 32-byte key.
	 * Password never leaves the client. Only the encrypted blob is transported.
	 *
	 * @param password  User-supplied passphrase (never stored)
	 * @returns         Encrypted blob as Uint8Array
	 */
	async export(password: string): Promise<Uint8Array> {
		if (!password) throw new Error("Password must not be empty");
		const plaintext = Buffer.from(JSON.stringify(this.store), "utf-8");
		const salt = randomBytes(16);
		const iv = randomBytes(12);

		// Derive key
		const key = await pbkdf2Async(password, salt, 200_000, 32, "sha256");

		// AES-256-GCM encrypt — authTag provides authenticated integrity
		const cipher = createCipheriv("aes-256-gcm", key, iv, {
			authTagLength: 16,
		});
		const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
		const authTag = cipher.getAuthTag(); // 16 bytes

		// Assemble: magic(4) + version(1) + salt(16) + iv(12) + authTag(16) + ciphertext
		const magic = Buffer.from("NAIA", "ascii");
		const version = Buffer.from([0x01]);
		return new Uint8Array(
			Buffer.concat([magic, version, salt, iv, authTag, encrypted]),
		);
	}

	/**
	 * Import memory from an encrypted blob created by `export()`.
	 * Replaces current memory entirely after successful decryption.
	 * Rolls back in-memory state if the disk write fails (crash safety).
	 *
	 * @param blob      Encrypted blob from export()
	 * @param password  User-supplied passphrase
	 * @throws          If decryption fails, JSON is invalid, or disk write fails
	 */
	async import(blob: Uint8Array, password: string): Promise<void> {
		if (!password) throw new Error("Password must not be empty");
		const buf = Buffer.from(blob);

		// Parse header: magic(4) + version(1) + salt(16) + iv(12) + authTag(16) = 49 bytes
		const HEADER_SIZE = 4 + 1 + 16 + 12 + 16;
		if (buf.length <= HEADER_SIZE) {
			throw new Error("Invalid backup blob: too short");
		}

		const magic = buf.subarray(0, 4).toString("ascii");
		if (magic !== "NAIA") {
			throw new Error("Invalid backup blob: bad magic");
		}

		const blobVersion = buf[4];
		if (blobVersion !== 0x01) {
			throw new Error(`Unsupported backup version: ${blobVersion}`);
		}

		const salt = buf.subarray(5, 21);
		const iv = buf.subarray(21, 33);
		const authTag = buf.subarray(33, 49);
		const ciphertext = buf.subarray(HEADER_SIZE);

		// Derive key
		const key = await pbkdf2Async(password, salt, 200_000, 32, "sha256");

		// AES-256-GCM decrypt — decipher.final() throws if authTag is invalid
		let plaintext: Buffer;
		try {
			const decipher = createDecipheriv("aes-256-gcm", key, iv, {
				authTagLength: 16,
			});
			decipher.setAuthTag(authTag);
			plaintext = Buffer.concat([
				decipher.update(ciphertext),
				decipher.final(),
			]);
		} catch {
			throw new Error("Decryption failed: wrong password or corrupted blob");
		}

		// Parse and validate store
		let parsed: MemoryStore;
		try {
			parsed = JSON.parse(plaintext.toString("utf-8")) as MemoryStore;
		} catch {
			throw new Error("Invalid backup: JSON parse failed");
		}
		if (parsed.version !== 1) {
			throw new Error(`Unsupported store version: ${parsed.version}`);
		}
		// Minimal shape guard — ensures downstream operations don't encounter missing arrays/objects
		if (
			!Array.isArray(parsed.episodes) ||
			!Array.isArray(parsed.facts) ||
			!Array.isArray(parsed.skills) ||
			!Array.isArray(parsed.reflections) ||
			typeof parsed.associations !== "object" ||
			Array.isArray(parsed.associations) ||
			parsed.associations === null
		) {
			throw new Error("Invalid backup: store shape mismatch");
		}

		// Replace memory — roll back in-memory state if disk write fails
		const previousStore = this.store;
		const previousKg = this.kg;
		// Ensure knowledgeGraph is always present before constructing KnowledgeGraph
		const importedKgState = parsed.knowledgeGraph ?? emptyKGState();
		parsed.knowledgeGraph = importedKgState;
		this.store = parsed;
		// Re-point KG to the newly imported state so all subsequent KG operations
		// operate on the imported KGState, not the old one.
		this.kg = new KnowledgeGraph(importedKgState);
		try {
			this.markDirty();
			this.save();
		} catch (err) {
			// Disk write failed — restore both store and KG to avoid divergence
			this.store = previousStore;
			this.kg = previousKg;
			throw err;
		}
	}

	// ─── Lifecycle ────────────────────────────────────────────────────────

	async close(): Promise<void> {
		this.save();
	}

	// ─── Testing Helpers ──────────────────────────────────────────────────

	/** Get raw store for testing/debugging */
	getStore(): Readonly<MemoryStore> {
		return this.store;
	}

	/** Get knowledge graph for direct queries */
	getKnowledgeGraph(): KnowledgeGraph {
		return this.kg;
	}

	/** Reset all memory (testing only) */
	reset(): void {
		this.store = emptyStore();
		this.markDirty();
		this.save();
	}
}
