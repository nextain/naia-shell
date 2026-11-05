import type { AgentFact } from "../db";
import { type WebFs, getWebFs } from "../web-runtime/web-fs";
import { isKioskDemo } from "./flag";

const PATH = "naia-adk/naia-settings/memory/kiosk-store.json";
interface Store {
	version: 1;
	generation: string;
	facts: AgentFact[];
	episodes: { content: string; role: "user" | "assistant"; timestamp: number }[];
}
const queues = new WeakMap<WebFs, Promise<unknown>>();
function serialized<T>(fs: WebFs, run: () => Promise<T>): Promise<T> {
	const task = (queues.get(fs) ?? Promise.resolve())
		.catch(() => {})
		.then(async () => {
			// OPFS is shared by the UI and Worker; Web Locks prevent lost updates.
			if (globalThis.navigator?.locks)
				return await navigator.locks.request("naia-kiosk-memory", run);
			return run();
		});
	queues.set(fs, task);
	return task;
}
function fact(content: string, id: string = crypto.randomUUID()): AgentFact {
	const now = Date.now();
	return {
		id,
		content,
		entities: [],
		topics: [],
		createdAt: now,
		updatedAt: now,
		importance: 0.7,
		recallCount: 0,
		lastAccessed: now,
		strength: 1,
		sourceEpisodes: [],
	};
}
function empty(): Store {
	return {
		version: 1,
		generation: crypto.randomUUID(),
		facts: [fact("사용자 호칭은 게스트님이다.", "kiosk-guest")],
		episodes: [],
	};
}
function validate(value: unknown): Store {
	const s = value as Store;
	if (
		!s ||
		s.version !== 1 ||
		typeof s.generation !== "string" ||
		!Array.isArray(s.facts) ||
		!Array.isArray(s.episodes) ||
		s.facts.some(
			(f) =>
				!f ||
				typeof f.id !== "string" ||
				typeof f.content !== "string" ||
				!Array.isArray(f.entities) ||
				!Array.isArray(f.topics),
		) ||
		s.episodes.some(
			(e) =>
				!e ||
				typeof e.content !== "string" ||
				(e.role !== "user" && e.role !== "assistant") ||
				!Number.isFinite(e.timestamp),
		)
	) {
		throw new Error("Invalid kiosk memory store");
	}
	return s;
}
async function read(fs: WebFs): Promise<Store> {
	const raw = await fs.readText(PATH);
	if (raw !== null) return validate(JSON.parse(raw));
	const store = empty();
	await write(fs, store);
	return store;
}
async function write(fs: WebFs, s: Store): Promise<void> {
	await fs.writeBytes(PATH, JSON.stringify(s));
}
function enabled(): void {
	if (!isKioskDemo()) throw new Error("kiosk_memory_disabled");
}

/** MemoryPort consumed by the desktop ChatTurnHandler; user evidence only. */
export function createKioskMemory(
	fs: WebFs = getWebFs(),
	diag?: { debug?(message: string, ctx?: unknown): void },
) {
	diag?.debug?.("KioskMemory.create", {
		timestamp: Date.now(),
		storage: "OPFS",
	});
	let generation: string | undefined;
	return {
		async recall(query: string, opts?: { topK?: number; touch?: boolean }) {
			diag?.debug?.("KioskMemory.recall", { timestamp: Date.now() });
			enabled();
			return serialized(fs, async () => {
				const s = await read(fs);
				generation = s.generation;
				if (!query.trim()) return { facts: [], episodes: [] };
				const k = Math.max(1, Math.min(opts?.topK ?? 10, 20));
				return {
					facts: [
						s.facts.find((f) => f.id === "kiosk-guest")?.content ?? "",
						...s.facts
							.filter((f) => f.id !== "kiosk-guest")
							.slice(-k)
							.map((f) => f.content.slice(0, 500)),
					].filter(Boolean),
					episodes: s.episodes
						.slice(-k)
						.map((e) => ({ ...e, content: e.content.slice(0, 500) })),
				};
			});
		},
		async save(
			userText: string,
			assistantText: string,
			opts?: {
				signal?: AbortSignal;
				idempotencyKey?: string;
				durable?: boolean;
			},
		) {
			diag?.debug?.("KioskMemory.save", { timestamp: Date.now() });
			enabled();
			const expectedGeneration = generation;
			await serialized(fs, async () => {
				const s = await read(fs);
				if (
					opts?.signal?.aborted ||
					(expectedGeneration !== undefined &&
						s.generation !== expectedGeneration)
				)
					return;
				const content = userText.trim().slice(0, 4000);
				const assistantContent = (assistantText ?? "").trim().slice(0, 4000);
				if (!content && !assistantContent) return;
				const now = Date.now();
				if (content) {
					if (!s.facts.some((f) => f.content === content))
						s.facts.push(fact(content));
					s.episodes.push({ content, role: "user", timestamp: now });
				}
				if (assistantContent) {
					s.episodes.push({
						content: assistantContent,
						role: "assistant",
						timestamp: now,
					});
				}
				s.facts = [
					...s.facts.filter((f) => f.id === "kiosk-guest"),
					...s.facts.filter((f) => f.id !== "kiosk-guest").slice(-200),
				];
				s.episodes = s.episodes.slice(-200);
				await write(fs, s);
			});
		},
	};
}

async function key(password: unknown, salt: Uint8Array): Promise<CryptoKey> {
	if (typeof password !== "string" || !password)
		throw new Error("Password must not be empty");
	const material = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(password),
		"PBKDF2",
		false,
		["deriveKey"],
	);
	return crypto.subtle.deriveKey(
		{
			name: "PBKDF2",
			hash: "SHA-256",
			salt: new Uint8Array(salt),
			iterations: 200_000,
		},
		material,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

export async function handleKioskMemoryCommand(
	cmd: string,
	args?: unknown,
	fs: WebFs = getWebFs(),
): Promise<unknown> {
	enabled();
	const a = (args ?? {}) as {
		password?: unknown;
		blob?: unknown;
		factId?: unknown;
	};
	return serialized(fs, async () => {
		const s = await read(fs);
		if (cmd === "memory_get_all_facts") return s.facts;
		if (cmd === "memory_delete_fact") {
			if (typeof a.factId !== "string") throw new Error("Invalid factId");
			const deleted = s.facts.find((f) => f.id === a.factId);
			if (!deleted) return false;
			s.facts = s.facts.filter((f) => f.id !== a.factId);
			s.episodes = s.episodes.filter((e) => e.content !== deleted.content);
			await write(fs, s);
			return true;
		}
		if (cmd === "memory_export_backup") {
			const salt = crypto.getRandomValues(new Uint8Array(16));
			const iv = crypto.getRandomValues(new Uint8Array(12));
			const encrypted = new Uint8Array(
				await crypto.subtle.encrypt(
					{ name: "AES-GCM", iv },
					await key(a.password, salt),
					new TextEncoder().encode(JSON.stringify(s)),
				),
			);
			// Desktop NAIA v1: magic/version, salt, IV, tag, ciphertext.
			return Array.from(
				new Uint8Array([
					78,
					65,
					73,
					65,
					1,
					...salt,
					...iv,
					...encrypted.slice(-16),
					...encrypted.slice(0, -16),
				]),
			);
		}
		if (cmd === "memory_import_backup") {
			if (
				!Array.isArray(a.blob) ||
				a.blob.length <= 49 ||
				a.blob.length > 4_000_000 ||
				a.blob.some((b) => !Number.isInteger(b) || b < 0 || b > 255)
			)
				throw new Error("Invalid backup blob");
			const b = new Uint8Array(a.blob);
			if (b.slice(0, 5).join() !== "78,65,73,65,1")
				throw new Error("Invalid backup version");
			const plaintext = await crypto.subtle.decrypt(
				{ name: "AES-GCM", iv: b.slice(21, 33) },
				await key(a.password, b.slice(5, 21)),
				new Uint8Array([...b.slice(49), ...b.slice(33, 49)]),
			);
			const imported = validate(
				JSON.parse(new TextDecoder().decode(plaintext)),
			);
			imported.generation = crypto.randomUUID();
			await write(fs, imported);
			return null;
		}
		throw new Error(`Unknown memory command: ${cmd}`);
	});
}

/** S3: await before starting the next visitor's conversation. No-op outside kiosk. */
export async function resetKioskMemory(fs: WebFs = getWebFs()): Promise<void> {
	if (!isKioskDemo()) return;
	await serialized(fs, () => write(fs, empty()));
}
