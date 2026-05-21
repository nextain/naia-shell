import {
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { defaultPathResolver } from "./gateway/path-resolver.js";

export interface LocalSessionMessage {
	role: "user" | "assistant";
	content: string;
	timestamp: number;
}

export interface LocalSession {
	id: string;
	label: string;
	createdAt: number;
	updatedAt: number;
	messages: LocalSessionMessage[];
}

function ensureSessionsDir(): string {
	const dir = defaultPathResolver.sessionsPath();
	mkdirSync(dir, { recursive: true });
	return dir;
}

/**
 * Save (upsert) a local session.
 * Preserves `createdAt` from the existing file if it already exists.
 */
export function saveLocalSession(
	id: string,
	messages: LocalSessionMessage[],
): void {
	const dir = ensureSessionsDir();
	const path = join(dir, `${id}.json`);

	const firstUser = messages.find((m) => m.role === "user");
	const label = firstUser
		? firstUser.content.slice(0, 60).replace(/\n/g, " ")
		: id;

	let createdAt = Date.now();
	try {
		const existing = JSON.parse(readFileSync(path, "utf-8")) as LocalSession;
		if (existing.createdAt) createdAt = existing.createdAt;
	} catch {
		// New session — use current timestamp
	}

	const session: LocalSession = {
		id,
		label,
		createdAt,
		updatedAt: Date.now(),
		messages,
	};
	writeFileSync(path, JSON.stringify(session, null, 2), "utf-8");
}

/** List local sessions sorted by updatedAt descending. */
export function listLocalSessions(limit = 50): LocalSession[] {
	const dir = ensureSessionsDir();
	let files: string[];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".json"));
	} catch {
		return [];
	}

	const sessions: LocalSession[] = [];
	for (const file of files) {
		try {
			const raw = readFileSync(join(dir, file), "utf-8");
			const session = JSON.parse(raw) as LocalSession;
			sessions.push(session);
		} catch {
			// Skip corrupt files
		}
	}

	sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
	return sessions.slice(0, limit);
}

/** Get a single local session by ID. Returns null if not found. */
export function getLocalSession(id: string): LocalSession | null {
	const dir = ensureSessionsDir();
	try {
		const raw = readFileSync(join(dir, `${id}.json`), "utf-8");
		return JSON.parse(raw) as LocalSession;
	} catch {
		return null;
	}
}

/** Delete a local session. Returns true if deleted, false if not found. */
export function deleteLocalSession(id: string): boolean {
	const dir = ensureSessionsDir();
	try {
		rmSync(join(dir, `${id}.json`));
		return true;
	} catch {
		return false;
	}
}
