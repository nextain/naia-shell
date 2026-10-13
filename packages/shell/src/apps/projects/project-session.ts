export type ProjectStage = "agent" | "dashboard" | "issues";

export interface ProjectSession {
	version: 1;
	lastProject: { id: string; path: string } | null;
	stagesByProjectPath: Record<string, ProjectStage>;
}

export interface LoadedProjectSession {
	session: ProjectSession;
	invalid: boolean;
}

export const PROJECT_SESSION_STORAGE_KEY = "naia-project-app-session-v1";

const DEFAULT_SESSION: ProjectSession = {
	version: 1,
	lastProject: null,
	stagesByProjectPath: {},
};

const PROJECT_STAGES = new Set<ProjectStage>(["agent", "dashboard", "issues"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeProjectPath(path: string): string {
	const normalized = path.replace(/\\/g, "/").replace(/\/$/, "");
	return /^[A-Za-z]:/.test(normalized)
		? `${normalized[0].toLowerCase()}${normalized.slice(1)}`
		: normalized;
}

export function loadProjectSession(): LoadedProjectSession {
	try {
		const serialized = localStorage.getItem(PROJECT_SESSION_STORAGE_KEY);
		if (!serialized) return { session: { ...DEFAULT_SESSION }, invalid: false };
		const value: unknown = JSON.parse(serialized);
		if (
			!isRecord(value) ||
			value.version !== 1 ||
			!isRecord(value.stagesByProjectPath)
		) {
			return { session: { ...DEFAULT_SESSION }, invalid: true };
		}
		let lastProject: ProjectSession["lastProject"] = null;
		if (value.lastProject !== null) {
			if (
				!isRecord(value.lastProject) ||
				typeof value.lastProject.id !== "string" ||
				!value.lastProject.id.trim() ||
				typeof value.lastProject.path !== "string" ||
				!value.lastProject.path.trim()
			) {
				return { session: { ...DEFAULT_SESSION }, invalid: true };
			}
			lastProject = {
				id: value.lastProject.id,
				path: normalizeProjectPath(value.lastProject.path),
			};
		}
		const stagesByProjectPath: Record<string, ProjectStage> = {};
		for (const [path, stage] of Object.entries(value.stagesByProjectPath)) {
			if (
				!path.trim() ||
				typeof stage !== "string" ||
				!PROJECT_STAGES.has(stage as ProjectStage)
			) {
				return { session: { ...DEFAULT_SESSION }, invalid: true };
			}
			stagesByProjectPath[normalizeProjectPath(path)] = stage as ProjectStage;
		}
		return {
			session: { version: 1, lastProject, stagesByProjectPath },
			invalid: false,
		};
	} catch {
		return { session: { ...DEFAULT_SESSION }, invalid: true };
	}
}

export function saveProjectSession(session: ProjectSession): boolean {
	try {
		localStorage.setItem(
			PROJECT_SESSION_STORAGE_KEY,
			JSON.stringify({
				version: 1,
				lastProject: session.lastProject,
				stagesByProjectPath: session.stagesByProjectPath,
			}),
		);
		return true;
	} catch {
		return false;
	}
}

export function stageForProject(
	session: ProjectSession,
	projectPath: string,
): ProjectStage {
	return (
		session.stagesByProjectPath[normalizeProjectPath(projectPath)] ?? "agent"
	);
}
