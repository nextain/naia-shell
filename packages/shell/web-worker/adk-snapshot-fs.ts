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
}

export const EMPTY_ADK_SNAPSHOT: AdkSnapshot = Object.freeze({
	configText: null,
	rootFiles: new Set<string>(),
	projects: null,
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

	const rootFiles = new Set<string>();
	for (const name of ["AGENTS.md", "CLAUDE.md"]) {
		try {
			await adkDir.getFileHandle(name);
			rootFiles.add(name);
		} catch (err: unknown) {
			if (!isNotFoundOrTypeMismatch(err)) {
				throw err;
			}
		}
	}

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
	};
}

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
