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

export type ProjectCodingAppId = "claude" | "codex" | "muse" | "opencode";

export interface CatalogProjectClassConfig {
	baselineRef: string;
}

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
	codingApp?: ProjectCodingAppId | null;
	docsDirs?: string[];
	class?: CatalogProjectClassConfig | null;
}

export interface ProjectDocEntry {
	dir: string;
	relativePath: string;
	sizeBytes: number;
}

export interface ProjectClassResetResult {
	backupRelativePath: string;
	backedUpFiles: number;
	deletedFiles: number;
}

export interface ParsedProjectCommandError {
	code: string;
	relativePathDetail: string | null;
}

export function isSafeRelativeErrorDetail(detail: string): boolean {
	const trimmed = detail.trim();
	if (
		!trimmed ||
		trimmed.startsWith("/") ||
		trimmed.includes("\\") ||
		trimmed.includes(":") ||
		/[\r\n\0]/.test(trimmed)
	) {
		return false;
	}
	return trimmed
		.split("/")
		.every((part) => part.length > 0 && part !== "." && part !== "..");
}

export function parseProjectCommandError(
	error: unknown,
): ParsedProjectCommandError {
	Logger.debug("ProjectCatalog", "parsing native project command error");
	const raw =
		typeof error === "string"
			? error
			: error instanceof Error
				? error.message
				: String(error ?? "");
	const normalized = raw.replace(/^Error:\s*/i, "").trim();
	if (!normalized) {
		return { code: "unknown", relativePathDetail: null };
	}
	const colonIndex = normalized.indexOf(":");
	if (colonIndex === -1) {
		return { code: normalized, relativePathDetail: null };
	}
	const code = normalized.slice(0, colonIndex).trim() || "unknown";
	const rawDetail = normalized.slice(colonIndex + 1).trim();
	const relativePathDetail = isSafeRelativeErrorDetail(rawDetail)
		? rawDetail
		: null;
	return { code, relativePathDetail };
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

const VALID_CODING_APPS = new Set<ProjectCodingAppId>([
	"claude",
	"codex",
	"muse",
	"opencode",
]);

const MAX_DOCS_DIRS = 16;
const BASELINE_REF_PATTERN = /^[0-9a-fA-F]{7,40}$/;

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

export function normalizeProjectCodingApp(
	value: unknown,
): ProjectCodingAppId | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (VALID_CODING_APPS.has(trimmed as ProjectCodingAppId)) {
		return trimmed as ProjectCodingAppId;
	}
	Logger.debug("ProjectCatalog", "ignoring invalid coding_app value", {
		value: trimmed,
	});
	return null;
}

export function normalizeProjectDocsDirs(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const dirs: string[] = [];
	for (const entry of value) {
		if (dirs.length >= MAX_DOCS_DIRS) break;
		if (typeof entry !== "string") continue;
		const trimmed = entry.trim();
		if (
			!trimmed ||
			trimmed.startsWith("/") ||
			trimmed.includes("\\") ||
			trimmed.includes(":")
		) {
			Logger.debug("ProjectCatalog", "ignoring unsafe docs_dirs entry");
			continue;
		}
		const parts = trimmed.split("/");
		if (
			parts.some(
				(part) =>
					!part || part === "." || part === ".." || part.startsWith("."),
			)
		) {
			Logger.debug("ProjectCatalog", "ignoring invalid docs_dirs segment");
			continue;
		}
		const normalized = parts.join("/");
		if (!dirs.includes(normalized)) {
			dirs.push(normalized);
		}
	}
	return dirs;
}

export function normalizeProjectClassConfig(
	value: unknown,
): CatalogProjectClassConfig | null {
	if (!isRecord(value)) return null;
	const rawRef = value.baselineRef ?? value.baseline_ref;
	if (typeof rawRef !== "string") return null;
	const trimmed = rawRef.trim();
	if (!BASELINE_REF_PATTERN.test(trimmed)) {
		Logger.debug("ProjectCatalog", "ignoring invalid class.baseline_ref");
		return null;
	}
	return { baselineRef: trimmed };
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
	const dashboardUrl =
		optionalUrlText(value.docsUrl ?? value.docs_url) ??
		optionalUrlText(value.dashboardUrl ?? value.dashboard_url);
	const issuesUrl =
		optionalUrlText(value.tasksUrl ?? value.tasks_url) ??
		optionalUrlText(value.issuesUrl ?? value.issues_url);
	const codingApp = normalizeProjectCodingApp(
		value.codingApp ?? value.coding_app,
	);
	const docsDirs = normalizeProjectDocsDirs(value.docsDirs ?? value.docs_dirs);
	const classConfig = normalizeProjectClassConfig(value.class);
	return {
		adapterRoot,
		projectPath,
		sourcePath,
		projectId,
		name,
		repository: optionalString(value.repository),
		issueTracker: optionalString(value.issueTracker),
		dashboardUrl,
		issuesUrl,
		codingApp,
		docsDirs,
		class: classConfig,
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

export async function listProjectDocs(
	adapterRoot: string,
	projectPath: string,
): Promise<ProjectDocEntry[]> {
	Logger.debug("ProjectCatalog", "requesting project docs list");
	const response = await invoke<unknown>("project_docs_list", {
		adapterRoot,
		projectPath,
	});
	if (!Array.isArray(response)) {
		throw new Error("Invalid project_docs_list response.");
	}
	return response.map((entry) => {
		if (!isRecord(entry)) {
			throw new Error("Invalid project doc entry.");
		}
		const dir = optionalString(entry.dir);
		const relativePath = optionalString(
			entry.relativePath ?? entry.relative_path,
		);
		const sizeBytes = entry.sizeBytes ?? entry.size_bytes;
		if (
			!dir ||
			!relativePath ||
			typeof sizeBytes !== "number" ||
			!Number.isSafeInteger(sizeBytes) ||
			sizeBytes < 0
		) {
			throw new Error("Invalid project doc entry.");
		}
		return { dir, relativePath, sizeBytes };
	});
}

export async function readProjectDoc(
	adapterRoot: string,
	projectPath: string,
	relativePath: string,
): Promise<string> {
	Logger.debug("ProjectCatalog", "requesting project doc content");
	const response = await invoke<unknown>("project_docs_read", {
		adapterRoot,
		projectPath,
		relativePath,
	});
	if (typeof response !== "string") {
		throw new Error("Invalid project_docs_read response.");
	}
	return response;
}

export async function resetProjectClass(
	adapterRoot: string,
	projectPath: string,
): Promise<ProjectClassResetResult> {
	Logger.debug("ProjectCatalog", "requesting project class reset");
	const response = await invoke<unknown>("project_class_reset", {
		adapterRoot,
		projectPath,
	});
	if (!isRecord(response)) {
		throw new Error("Invalid project_class_reset response.");
	}
	const backupRelativePath = optionalString(
		response.backupRelativePath ?? response.backup_relative_path,
	);
	const backedUpFiles = response.backedUpFiles ?? response.backed_up_files;
	const deletedFiles = response.deletedFiles ?? response.deleted_files ?? 0;
	if (
		!backupRelativePath ||
		typeof backedUpFiles !== "number" ||
		!Number.isSafeInteger(backedUpFiles) ||
		backedUpFiles < 0 ||
		typeof deletedFiles !== "number" ||
		!Number.isSafeInteger(deletedFiles) ||
		deletedFiles < 0
	) {
		throw new Error("Invalid project_class_reset response.");
	}
	return { backupRelativePath, backedUpFiles, deletedFiles };
}
