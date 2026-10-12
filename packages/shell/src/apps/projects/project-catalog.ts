import { invoke } from "@tauri-apps/api/core";

export type ProjectConfigIssueReason =
	| "missing"
	| "unreadable"
	| "invalid_yaml"
	| "invalid_json"
	| "missing_project_id"
	| "missing_profile"
	| "unsafe_path";

export interface ProjectConfigIssue {
	file: string;
	reason: ProjectConfigIssueReason;
}

export interface CatalogProject {
	directoryName: string;
	projectId: string;
	name: string;
	repository: string | null;
	issueTracker: string | null;
	profile: string | null;
	configErrors: ProjectConfigIssue[];
}

export interface ProjectCatalog {
	projects: CatalogProject[];
}

const TEMPLATE_DIRECTORIES = new Set(["_template", "_template-local"]);
const ISSUE_REASONS = new Set<ProjectConfigIssueReason>([
	"missing",
	"unreadable",
	"invalid_yaml",
	"invalid_json",
	"missing_project_id",
	"missing_profile",
	"unsafe_path",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseIssue(value: unknown): ProjectConfigIssue {
	if (!isRecord(value)) throw new Error("Invalid project configuration issue.");
	const file = optionalString(value.file);
	const reason = value.reason;
	if (
		!file ||
		typeof reason !== "string" ||
		!ISSUE_REASONS.has(reason as ProjectConfigIssueReason)
	) {
		throw new Error("Invalid project configuration issue.");
	}
	return { file, reason: reason as ProjectConfigIssueReason };
}

function parseProject(value: unknown): CatalogProject {
	if (!isRecord(value)) throw new Error("Invalid project catalog entry.");
	const directoryName = optionalString(value.directoryName);
	const projectId = optionalString(value.projectId);
	const name = optionalString(value.name);
	if (
		!directoryName ||
		!projectId ||
		!name ||
		!Array.isArray(value.configErrors)
	) {
		throw new Error("Invalid project catalog entry.");
	}
	return {
		directoryName,
		projectId,
		name,
		repository: optionalString(value.repository),
		issueTracker: optionalString(value.issueTracker),
		profile: optionalString(value.profile),
		configErrors: value.configErrors.map(parseIssue),
	};
}

/** Validate the native catalog response before displaying any entry. */
export function normalizeProjectCatalog(value: unknown): ProjectCatalog {
	if (!isRecord(value) || !Array.isArray(value.projects)) {
		throw new Error("Invalid project catalog response.");
	}
	const projects = value.projects.map(parseProject);
	return {
		projects: projects.filter(
			(project) => !TEMPLATE_DIRECTORIES.has(project.directoryName),
		),
	};
}

export async function scanProjectCatalog(
	checkoutPath: string,
): Promise<ProjectCatalog> {
	const response = await invoke<unknown>("projects_scan_checkout", {
		checkoutPath,
	});
	return normalizeProjectCatalog(response);
}
