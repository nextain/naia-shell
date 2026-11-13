import type {
	PersonaFsRead,
	WorkspaceDirent,
	WorkspaceFsRead,
} from "@naia-agent/composition/browser-agent.js";
import { WEB_ADK_PATH } from "../src/lib/web-runtime/web-adk-path";

export interface AdkSnapshot {
	configText: string | null;
	rootFiles: ReadonlySet<string>;
	projects: { name: string; isDir: boolean }[] | null;
	agentsText?: string | null;
	personaText?: string | null;
	rulesText?: string | null;
	memoryText?: string | null;
}

export const EMPTY_ADK_SNAPSHOT: AdkSnapshot = Object.freeze({
	configText: null,
	rootFiles: new Set<string>(),
	projects: null,
	agentsText: null,
	personaText: null,
	rulesText: null,
	memoryText: null,
});

export interface FileLike {
	getFile(): Promise<{ text(): Promise<string> }>;
}

export interface DirLike {
	getDirectoryHandle(name: string): Promise<DirLike>;
	getFileHandle(name: string): Promise<FileLike>;
	values(): AsyncIterable<{ kind: "file" | "directory"; name: string }>;
}

function isNotFoundOrTypeMismatch(err: unknown): boolean {
	if (err && typeof err === "object") {
		const name = "name" in err ? (err as { name: unknown }).name : undefined;
		if (name === "NotFoundError" || name === "TypeMismatchError") return true;
	}
	return false;
}

export async function readAdkSnapshot(
	getRoot: () => Promise<DirLike>,
): Promise<AdkSnapshot> {
	const root = await getRoot();
	let adkDir: DirLike;
	try {
		adkDir = await root.getDirectoryHandle("naia-adk");
	} catch (err: unknown) {
		if (isNotFoundOrTypeMismatch(err)) {
			return EMPTY_ADK_SNAPSHOT;
		}
		throw err;
	}

	let configText: string | null = null;
	try {
		const settingsDir = await adkDir.getDirectoryHandle("naia-settings");
		const configFile = await settingsDir.getFileHandle("config.json");
		const file = await configFile.getFile();
		configText = await file.text();
	} catch (err: unknown) {
		if (!isNotFoundOrTypeMismatch(err)) {
			throw err;
		}
		configText = null;
	}

	let agentsText: string | null = null;
	const rootFiles = new Set<string>();
	for (const name of ["AGENTS.md", "CLAUDE.md"]) {
		try {
			const handle = await adkDir.getFileHandle(name);
			rootFiles.add(name);
			if (name === "AGENTS.md" && typeof handle?.getFile === "function") {
				const file = await handle.getFile();
				agentsText = await file.text();
			}
		} catch (err: unknown) {
			if (!isNotFoundOrTypeMismatch(err)) {
				throw err;
			}
		}
	}

	const readNestedText = async (
		dirName: string,
		fileName: string,
	): Promise<string | null> => {
		try {
			const subDir = await adkDir.getDirectoryHandle(dirName);
			const fileHandle = await subDir.getFileHandle(fileName);
			const file = await fileHandle.getFile();
			return await file.text();
		} catch (err: unknown) {
			if (!isNotFoundOrTypeMismatch(err)) {
				throw err;
			}
			return null;
		}
	};

	const personaText: string | null = null;
	const rulesText = await readNestedText("rules", "response-rules.md");
	const memoryText = await readNestedText("memory", "guest-memory.md");

	let projects: { name: string; isDir: boolean }[] | null = null;
	try {
		const projectsDir = await adkDir.getDirectoryHandle("projects");
		const list: { name: string; isDir: boolean }[] = [];
		for await (const entry of projectsDir.values()) {
			list.push({
				name: entry.name,
				isDir: entry.kind === "directory",
			});
		}
		projects = list;
	} catch (err: unknown) {
		if (!isNotFoundOrTypeMismatch(err)) {
			throw err;
		}
		projects = null;
	}

	return {
		configText,
		rootFiles,
		projects,
		agentsText,
		personaText,
		rulesText,
		memoryText,
	};
}

export interface ActiveSlideRequestContext {
	page: number;
	title: string;
	/** 근거로 삼는 발표 대본의 탐색기 경로 (`slides/*.md`). */
	source: string;
	script: string;
	restrictToSlide?: boolean;
	instructions: string;
}

export function extractActiveSlideFromChatRequest(
	rawLine: string | null | undefined,
): ActiveSlideRequestContext | null {
	if (!rawLine) return null;
	try {
		const parsed = JSON.parse(rawLine) as {
			type?: unknown;
			environmentSegments?: Array<{
				kind?: unknown;
				entries?: Array<{
					type?: unknown;
					data?: Record<string, unknown>;
				}>;
			}>;
		};
		if (
			parsed?.type !== "chat_request" ||
			!Array.isArray(parsed.environmentSegments)
		) {
			return null;
		}
		for (const seg of parsed.environmentSegments) {
			if (seg?.kind !== "app" || !Array.isArray(seg.entries)) continue;
			for (const entry of seg.entries) {
				if (
					entry?.type === "Active IR Slide Context" &&
					entry.data &&
					typeof entry.data === "object"
				) {
					const d = entry.data;
					const page = typeof d.page === "number" ? d.page : 1;
					const title = typeof d.title === "string" ? d.title : "";
					const source =
						typeof d.source === "string" && d.source.trim()
							? d.source.trim()
							: "slides/nextain-ir-public.md";
					const script = typeof d.script === "string" ? d.script : "";
					const restrictToSlide = d.restrictToSlide !== false;
					const instructions =
						typeof d.instructions === "string" ? d.instructions : "";
					if (title || instructions) {
						return {
							page,
							title,
							source,
							script,
							restrictToSlide,
							instructions,
						};
					}
				}
			}
		}
	} catch {
		// ignore malformed line
	}
	return null;
}

export const buildKioskSystemPromptFromSnapshot = (
	snapshot: AdkSnapshot,
	basePrefix?: string,
	activeSlide?: ActiveSlideRequestContext | null,
): string => {
	const sections: string[] = [];
	if (snapshot.agentsText?.trim()) {
		sections.push(snapshot.agentsText.trim());
	}
	const trimmedBase = basePrefix?.trim() ?? "";
	if (trimmedBase) {
		sections.push(trimmedBase);
	}
	if (snapshot.configText) {
		try {
			const parsed = JSON.parse(snapshot.configText) as {
				persona?: unknown;
				personaDisabled?: unknown;
			};
			if (
				!parsed.personaDisabled &&
				typeof parsed.persona === "string" &&
				parsed.persona.trim() &&
				!trimmedBase.includes(parsed.persona.trim())
			) {
				sections.push(parsed.persona.trim());
			}
		} catch {
			// ignore malformed configText
		}
	}
	if (snapshot.personaText?.trim()) {
		sections.push(snapshot.personaText.trim());
	}
	if (snapshot.rulesText?.trim()) {
		sections.push(snapshot.rulesText.trim());
	}
	if (activeSlide?.instructions?.trim()) {
		if (activeSlide.restrictToSlide === false) {
			sections.push(
				"넥스테인·나이아·성장·제품·가능성 질문에는 skill_knowledge_search 또는 skill_knowledge_ask로 공개 지식을 먼저 확인하세요. 근거와 기준일을 보존하고 계획은 계획으로 설명하세요. 근거 없는 수치나 비공개 정보는 추측하지 마세요.",
			);
		}
		sections.push(activeSlide.instructions.trim());
	} else {
		sections.push(
			"넥스테인·나이아·성장·제품·가능성 질문에는 skill_knowledge_search 또는 skill_knowledge_ask로 공개 지식을 먼저 확인하세요. 근거와 기준일을 보존하고 계획은 계획으로 설명하세요. 근거 없는 수치나 비공개 정보는 추측하지 마세요.",
		);
	}
	return sections.join("\n\n");
};

export function makeSnapshotFs(
	get: () => AdkSnapshot,
): PersonaFsRead & WorkspaceFsRead {
	const configPath = `${WEB_ADK_PATH}/naia-settings/config.json`;
	const agentsPath = `${WEB_ADK_PATH}/AGENTS.md`;
	const claudePath = `${WEB_ADK_PATH}/CLAUDE.md`;
	const projectsPath = `${WEB_ADK_PATH}/projects`;

	return {
		existsSync(path: string): boolean {
			const clean = path.replace(/[\\/]+$/, "");
			const snap = get();
			if (clean === configPath) {
				return snap.configText !== null;
			}
			if (clean === agentsPath) {
				return snap.rootFiles.has("AGENTS.md");
			}
			if (clean === claudePath) {
				return snap.rootFiles.has("CLAUDE.md");
			}
			if (clean === projectsPath) {
				return snap.projects !== null;
			}
			return false;
		},

		readFileSync(path: string, _encoding?: "utf8"): string {
			const clean = path.replace(/[\\/]+$/, "");
			const snap = get();
			if (clean === configPath) {
				if (snap.configText !== null) {
					return snap.configText;
				}
			}
			throw new Error(`ENOENT: no such file or directory, open '${path}'`);
		},

		readdirSync(
			path: string,
			_opts: { withFileTypes: true },
		): readonly WorkspaceDirent[] {
			const clean = path.replace(/[\\/]+$/, "");
			const snap = get();
			if (clean === projectsPath) {
				if (snap.projects !== null) {
					return snap.projects.map((p) => ({
						name: p.name,
						isDirectory: () => p.isDir,
					}));
				}
			}
			throw new Error(`ENOENT: no such file or directory, scandir '${path}'`);
		},
	};
}
