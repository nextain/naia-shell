import { invoke } from "@tauri-apps/api/core";
import { Logger } from "../../lib/logger";

export type ProjectConfigIssueReason =
	| "missing"
	| "file_unreadable"
	| "invalid_yaml"
	| "missing_project_id"
	| "unsafe_path"
	| "directory_unreadable"
	| "entry_unreadable"
	| "file_too_large";

export interface CatalogIssue {
	path: string;
	reason: ProjectConfigIssueReason;
}

export interface CatalogProject {
	/** Verified project adapter root, supplied by native candidate scanning. */
	adapterRoot: string;
	projectPath: string;
	sourcePath: string;
	projectId: string;
	name: string;
	repository: string | null;
	issueTracker: string | null;
	dashboardUrl: string | null;
	issuesUrl: string | null;
}

export type ProjectUrlState = "missing" | "invalid" | "configured";

export interface ProjectCatalog {
	projects: CatalogProject[];
	catalogErrors: CatalogIssue[];
	truncation?: ProjectCatalogTruncation;
}

export interface ProjectCatalogTruncation {
	maxEntries: number;
	scannedEntries: number;
	moreEntriesAvailable: boolean;
	maxRows: number;
	shownRows: number;
	moreRowsAvailable: boolean;
	maxConfigFileBytes: number;
	oversizedFiles: Array<{
		file: string;
		observedBytes: number;
	}>;
}

const ISSUE_REASONS = new Set<ProjectConfigIssueReason>([
	"missing",
	"file_unreadable",
	"invalid_yaml",
	"missing_project_id",
	"unsafe_path",
	"directory_unreadable",
	"entry_unreadable",
	"file_too_large",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	Logger.debug("ProjectCatalog", "checking catalog record shape");
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
	Logger.debug("ProjectCatalog", "normalizing optional catalog text");
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalUrlText(value: unknown): string | null {
	Logger.debug("ProjectCatalog", "reading optional project URL field");
	if (typeof value !== "string") return null;
	return value.trim() ? value : null;
}

/** Classify a configured URL without repairing or replacing its source value. */
export function classifyProjectUrl(value: string | null): ProjectUrlState {
	Logger.debug("ProjectCatalog", "classifying project URL", {
		configured: value !== null,
	});
	if (value === null || !value.trim()) return "missing";
	if (
		value !== value.trim() ||
		/\s/.test(value) ||
		value.includes("\\") ||
		!/^https?:\/\//i.test(value)
	) {
		Logger.debug(
			"ProjectCatalog",
			"project URL rejected because source syntax is not absolute http(s)",
		);
		return "invalid";
	}
	try {
		const parsed = new URL(value);
		if (
			(parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
			!parsed.hostname ||
			parsed.username.length > 0 ||
			parsed.password.length > 0
		) {
			Logger.debug(
				"ProjectCatalog",
				"project URL rejected by protocol or host checks",
			);
			return "invalid";
		}
		return "configured";
	} catch {
		Logger.debug(
			"ProjectCatalog",
			"project URL parser rejected configured value",
		);
		return "invalid";
	}
}

function parseIssue(value: unknown): CatalogIssue {
	if (!isRecord(value)) throw new Error("Invalid project catalog issue.");
	const path = optionalString(value.path);
	const reason = value.reason;
	if (
		!path ||
		typeof reason !== "string" ||
		!ISSUE_REASONS.has(reason as ProjectConfigIssueReason)
	) {
		throw new Error("Invalid project catalog issue.");
	}
	return { path, reason: reason as ProjectConfigIssueReason };
}

function parseProject(value: unknown): CatalogProject {
	Logger.debug("ProjectCatalog", "parsing project catalog entry");
	if (!isRecord(value)) throw new Error("Invalid project catalog entry.");
	const adapterRoot = optionalString(value.adapterRoot);
	const projectPath = optionalString(value.projectPath);
	const sourcePath = optionalString(value.sourcePath);
	const projectId = optionalString(value.projectId);
	const name = optionalString(value.name);
	if (
		!adapterRoot ||
		!projectPath ||
		!sourcePath ||
		!projectId ||
		!name ||
		sourcePath.startsWith("/") ||
		sourcePath.split("/").includes("..")
	) {
		throw new Error("Invalid project catalog entry.");
	}
	return {
		adapterRoot,
		projectPath,
		sourcePath,
		projectId,
		name,
		repository: optionalString(value.repository),
		issueTracker: optionalString(value.issueTracker),
		dashboardUrl: optionalUrlText(value.dashboardUrl),
		issuesUrl: optionalUrlText(value.issuesUrl),
	};
}

function parseProjectCatalogTruncation(
	value: unknown,
): ProjectCatalogTruncation | undefined {
	if (value === undefined || value === null) return undefined;
	if (!isRecord(value)) throw new Error("Invalid project catalog truncation.");
	const maxEntries = value.maxEntries;
	const scannedEntries = value.scannedEntries;
	const maxRows = value.maxRows;
	const shownRows = value.shownRows;
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
		typeof maxRows !== "number" ||
		!Number.isSafeInteger(maxRows) ||
		maxRows <= 0 ||
		typeof shownRows !== "number" ||
		!Number.isSafeInteger(shownRows) ||
		shownRows < 0 ||
		shownRows > maxRows ||
		typeof value.moreRowsAvailable !== "boolean" ||
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
		maxRows,
		shownRows,
		moreRowsAvailable: value.moreRowsAvailable,
		maxConfigFileBytes,
		oversizedFiles,
	};
}

/** Validate the native catalog response before displaying any entry. */
export function normalizeProjectCatalog(value: unknown): ProjectCatalog {
	Logger.debug("ProjectCatalog", "validating native project catalog response");
	if (!isRecord(value) || !Array.isArray(value.projects)) {
		throw new Error("Invalid project catalog response.");
	}
	const projects = value.projects.map(parseProject);
	const catalogErrors = Array.isArray(value.catalogErrors)
		? value.catalogErrors.map(parseIssue)
		: [];
	const truncation = parseProjectCatalogTruncation(value.truncation);
	return {
		projects,
		catalogErrors,
		...(truncation ? { truncation } : {}),
	};
}

export async function scanProjectCatalog(
	adkPath: string,
): Promise<ProjectCatalog> {
	Logger.debug("ProjectCatalog", "requesting native project scan");
	const response = await invoke<unknown>("projects_scan_adk", { adkPath });
	return normalizeProjectCatalog(response);
}
