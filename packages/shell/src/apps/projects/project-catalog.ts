import { invoke } from "@tauri-apps/api/core";

export type ProjectConfigIssueReason =
	| "missing"
	| "unreadable"
	| "invalid_yaml"
	| "missing_project_id"
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
	configErrors: ProjectConfigIssue[];
}

export interface ProjectCatalog {
	projects: CatalogProject[];
	truncation?: ProjectCatalogTruncation;
}

export interface ProjectCatalogTruncation {
	maxEntries: number;
	scannedEntries: number;
	moreEntriesAvailable: boolean;
	maxConfigFileBytes: number;
	oversizedFiles: Array<{
		file: string;
		observedBytes: number;
	}>;
}

const TEMPLATE_DIRECTORIES = new Set(["_template", "_template-local"]);
const ISSUE_REASONS = new Set<ProjectConfigIssueReason>([
	"missing",
	"unreadable",
	"invalid_yaml",
	"missing_project_id",
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
		configErrors: value.configErrors.map(parseIssue),
	};
}

function parseProjectCatalogTruncation(
	value: unknown,
): ProjectCatalogTruncation | undefined {
	if (value === undefined || value === null) return undefined;
	if (!isRecord(value)) throw new Error("Invalid project catalog truncation.");
	const maxEntries = value.maxEntries;
	const scannedEntries = value.scannedEntries;
	const maxConfigFileBytes = value.maxConfigFileBytes;
	if (
		typeof maxEntries !== "number" ||
		!Number.isSafeInteger(maxEntries) ||
		maxEntries <= 0 ||
		typeof scannedEntries !== "number" ||
		!Number.isSafeInteger(scannedEntries) ||
		scannedEntries < 0 ||
		scannedEntries > maxEntries ||
		typeof value.moreEntriesAvailable !== "boolean" ||
		typeof maxConfigFileBytes !== "number" ||
		!Number.isSafeInteger(maxConfigFileBytes) ||
		maxConfigFileBytes <= 0 ||
		!Array.isArray(value.oversizedFiles)
	) {
		throw new Error("Invalid project catalog truncation.");
	}
	const oversizedFiles = value.oversizedFiles.map((entry) => {
		if (!isRecord(entry)) {
			throw new Error("Invalid oversized project configuration record.");
		}
		const file = optionalString(entry.file);
		const observedBytes = entry.observedBytes;
		if (
			!file ||
			typeof observedBytes !== "number" ||
			!Number.isSafeInteger(observedBytes) ||
			observedBytes <= maxConfigFileBytes
		) {
			throw new Error("Invalid oversized project configuration record.");
		}
		return { file, observedBytes };
	});
	return {
		maxEntries,
		scannedEntries,
		moreEntriesAvailable: value.moreEntriesAvailable,
		maxConfigFileBytes,
		oversizedFiles,
	};
}

/** Validate the native catalog response before displaying any entry. */
export function normalizeProjectCatalog(value: unknown): ProjectCatalog {
	if (!isRecord(value) || !Array.isArray(value.projects)) {
		throw new Error("Invalid project catalog response.");
	}
	const projects = value.projects.map(parseProject);
	const visibleProjects = projects.filter(
		(project) => !TEMPLATE_DIRECTORIES.has(project.directoryName),
	);
	const truncation = parseProjectCatalogTruncation(value.truncation);
	return {
		projects: visibleProjects,
		...(truncation ? { truncation } : {}),
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
