/**
 * Shared file collection and fuzzy search utilities.
 * Extracted from QuickOpen.tsx so both QuickOpen and AtMentionPopover can reuse.
 */
import { invoke } from "@tauri-apps/api/core";

export interface DirEntry {
	name: string;
	path: string;
	is_dir: boolean;
	children?: DirEntry[] | null;
	category?: string;
}

/** Maximum depth for recursive file listing */
const MAX_DEPTH = 6;

/** Directory names to exclude from search */
const IGNORE_DIRS = new Set([
	"node_modules",
	".git",
	".next",
	"dist",
	"build",
	".pnpm",
	".turbo",
	"__pycache__",
	".venv",
	"target",
	".flatpak-builder",
	"flatpak-repo",
]);

// ── File collection ─────────────────────────────────────────────────────────

export async function collectFiles(
	root: string,
	depth: number,
): Promise<string[]> {
	if (depth > MAX_DEPTH) return [];
	try {
		const entries = await invoke<DirEntry[]>("workspace_list_dirs", {
			parent: root,
		});
		const results: string[] = [];
		for (const entry of entries) {
			if (entry.is_dir) {
				if (IGNORE_DIRS.has(entry.name)) continue;
				// Include folder path (with trailing /)
				results.push(`${entry.path}/`);
				const children = await collectFiles(entry.path, depth + 1);
				results.push(...children);
			} else {
				results.push(entry.path);
			}
		}
		return results;
	} catch {
		return [];
	}
}

/** Collect only file paths (no folders). Used by QuickOpen. */
export async function collectFilesOnly(
	root: string,
	depth: number,
): Promise<string[]> {
	if (depth > MAX_DEPTH) return [];
	try {
		const entries = await invoke<DirEntry[]>("workspace_list_dirs", {
			parent: root,
		});
		const results: string[] = [];
		for (const entry of entries) {
			if (entry.is_dir) {
				if (IGNORE_DIRS.has(entry.name)) continue;
				const children = await collectFilesOnly(entry.path, depth + 1);
				results.push(...children);
			} else {
				results.push(entry.path);
			}
		}
		return results;
	} catch {
		return [];
	}
}

// ── Korean choseong (초성) matching ──────────────────────────────────────────

const CHOSEONG = [
	"ㄱ",
	"ㄲ",
	"ㄴ",
	"ㄷ",
	"ㄸ",
	"ㄹ",
	"ㅁ",
	"ㅂ",
	"ㅃ",
	"ㅅ",
	"ㅆ",
	"ㅇ",
	"ㅈ",
	"ㅉ",
	"ㅊ",
	"ㅋ",
	"ㅌ",
	"ㅍ",
	"ㅎ",
];

const HANGUL_BASE = 0xac00;
const HANGUL_END = 0xd7a3;

function getChoseong(ch: string): string {
	const code = ch.charCodeAt(0);
	if (code >= HANGUL_BASE && code <= HANGUL_END) {
		return CHOSEONG[Math.floor((code - HANGUL_BASE) / 588)];
	}
	return ch;
}

function isChoseongQuery(query: string): boolean {
	return [...query].every((ch) => CHOSEONG.includes(ch));
}

function choseongMatch(query: string, target: string): boolean {
	let qi = 0;
	for (let ti = 0; ti < target.length && qi < query.length; ti++) {
		if (getChoseong(target[ti]) === query[qi]) {
			qi++;
		}
	}
	return qi === query.length;
}

// ── File icon mapping ──────────────────────────────────────────────────────

/** Return an emoji icon for a filename based on its extension.
 *  Used by FileTree, AtMentionPopover, and QuickOpen. */
export function getFileIcon(name: string): string {
	const ext = name.split(".").pop()?.toLowerCase() ?? "";
	const icons: Record<string, string> = {
		ts: "📄",
		tsx: "⚛️",
		js: "📄",
		jsx: "⚛️",
		rs: "🦀",
		md: "📝",
		json: "{}",
		yaml: "📋",
		yml: "📋",
		toml: "📋",
		py: "🐍",
		sh: "💻",
		css: "🎨",
		html: "🌐",
		svg: "🖼️",
		png: "🖼️",
		jpg: "🖼️",
		gif: "🖼️",
		env: "🔒",
		lock: "🔒",
	};
	return icons[ext] ?? "📄";
}

// ── Fuzzy matching ──────────────────────────────────────────────────────────

function parseExtFilter(query: string): string | null {
	const trimmed = query.trim().toLowerCase();
	if (trimmed.startsWith("*.")) return trimmed.slice(2);
	if (trimmed.startsWith(".") && !trimmed.includes("/"))
		return trimmed.slice(1);
	return null;
}

function fuzzyScoreString(query: string, target: string): number {
	let qi = 0;
	let score = 0;
	let lastMatch = -1;
	for (let ti = 0; ti < target.length && qi < query.length; ti++) {
		if (target[ti] === query[qi]) {
			score += lastMatch === ti - 1 ? 2 : 1;
			if (
				ti === 0 ||
				target[ti - 1] === "/" ||
				target[ti - 1] === "-" ||
				target[ti - 1] === "_" ||
				target[ti - 1] === "."
			) {
				score += 3;
			}
			lastMatch = ti;
			qi++;
		}
	}
	return qi === query.length ? score : -1;
}

/** Fuzzy match with filename priority: all query chars must appear in order */
export function fuzzyMatch(query: string, rel: string): number {
	const q = query.toLowerCase();
	const filename = rel.split("/").pop() ?? rel;
	const filenameLower = filename.toLowerCase();
	const relLower = rel.toLowerCase();

	// Extension filter: *.svg, .svg
	const extFilter = parseExtFilter(q);
	if (extFilter) {
		const fileExt = filename.split(".").pop()?.toLowerCase() ?? "";
		return fileExt === extFilter ? 100 : -1;
	}

	// Korean choseong matching
	if (isChoseongQuery(q)) {
		const filenameMatch = choseongMatch(q, filename);
		const relMatch = choseongMatch(q, rel);
		if (filenameMatch) return 100;
		if (relMatch) return 50;
		return -1;
	}

	// Score filename match (higher priority)
	const filenameScore = fuzzyScoreString(q, filenameLower);
	if (filenameScore > 0) return filenameScore + 50;

	// Score full path match (lower priority)
	return fuzzyScoreString(q, relLower);
}
