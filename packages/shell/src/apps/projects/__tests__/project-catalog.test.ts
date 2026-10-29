import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	classifyProjectUrl,
	listProjectDocs,
	normalizeProjectCatalog,
	parseProjectCommandError,
	readProjectDoc,
	resetProjectClass,
	scanProjectCatalog,
} from "../project-catalog";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const project = (
	projectId: string,
	sourcePath = `projects/naia-pj-adk/projects/${projectId}`,
	extra: Record<string, unknown> = {},
) => ({
	adapterRoot: "/fixture/adapter-root",
	projectPath: `/fixture/naia-adk/${sourcePath}`,
	sourcePath,
	projectId,
	name: projectId,
	repository: null,
	issueTracker: null,
	dashboardUrl: null,
	issuesUrl: null,
	...extra,
});

const truncation = {
	maxEntries: 200,
	scannedEntries: 198,
	moreEntriesAvailable: false,
	maxRows: 200,
	shownRows: 2,
	moreRowsAvailable: false,
	maxConfigFileBytes: 65536,
	oversizedFiles: [],
};

describe("Project catalog — naia-adk scan", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(invoke).mockResolvedValue(null);
	});

	it("normalizes discovered projects and keeps source paths relative", () => {
		const result = normalizeProjectCatalog({
			projects: [
				project("aipol", undefined, {
					name: "AI Policy",
					repository: "octocat/Hello-World",
					issueTracker: "github",
				}),
			],
			catalogErrors: [],
			truncation,
		});

		expect(result.projects).toEqual([
			{
				projectPath: "/fixture/naia-adk/projects/naia-pj-adk/projects/aipol",
				adapterRoot: "/fixture/adapter-root",
				sourcePath: "projects/naia-pj-adk/projects/aipol",
				projectId: "aipol",
				name: "AI Policy",
				repository: "octocat/Hello-World",
				issueTracker: "github",
				dashboardUrl: null,
				issuesUrl: null,
				codingApp: null,
				docsDirs: [],
				class: null,
			},
		]);
		expect(result.catalogErrors).toEqual([]);
		expect(result.truncation).toEqual(truncation);
	});

	it("returns an empty list without fabricating errors", () => {
		expect(
			normalizeProjectCatalog({ projects: [], catalogErrors: [] }),
		).toEqual({ projects: [], catalogErrors: [] });
	});

	it("preserves scan-entry, display-row, and oversized-file evidence", () => {
		const result = normalizeProjectCatalog({
			projects: [],
			catalogErrors: [
				{
					path: "projects/group/projects/demo/project.yaml",
					reason: "file_too_large",
				},
			],
			truncation: {
				...truncation,
				scannedEntries: 200,
				moreEntriesAvailable: true,
				shownRows: 1,
				maxRows: 200,
				oversizedFiles: [
					{
						file: "projects/group/projects/demo/project.yaml",
						observedBytes: 90000,
					},
				],
			},
		});

		expect(result.catalogErrors[0].reason).toBe("file_too_large");
		expect(result.truncation?.moreEntriesAvailable).toBe(true);
		expect(result.truncation?.oversizedFiles[0].observedBytes).toBe(90000);
	});

	it("accepts known catalog error reasons and rejects unknown reasons", () => {
		const result = normalizeProjectCatalog({
			projects: [],
			catalogErrors: [
				{
					path: "projects/group/projects/demo/project.yaml",
					reason: "invalid_yaml",
				},
				{ path: "projects/group/projects/linked", reason: "unsafe_path" },
			],
		});
		expect(result.catalogErrors).toHaveLength(2);
		expect(() =>
			normalizeProjectCatalog({
				projects: [],
				catalogErrors: [{ path: "projects/demo", reason: "unknown" }],
			}),
		).toThrow("Invalid project catalog issue.");
	});

	it("rejects absolute or escaping display paths", () => {
		expect(() =>
			normalizeProjectCatalog({
				projects: [project("escape", "../outside")],
			}),
		).toThrow("Invalid project catalog entry.");
		expect(() =>
			normalizeProjectCatalog({
				projects: [project("absolute", "/private/path")],
			}),
		).toThrow("Invalid project catalog entry.");
	});

	it("rejects malformed native responses instead of presenting an empty success", () => {
		expect(() =>
			normalizeProjectCatalog({ projects: [{ projectId: "broken" }] }),
		).toThrow("Invalid project catalog entry.");
		expect(() => normalizeProjectCatalog({ projects: null })).toThrow(
			"Invalid project catalog response.",
		);
	});

	it("preserves project URL source fields and rejects values that are not absolute web URLs", () => {
		const result = normalizeProjectCatalog({
			projects: [
				project("web", "projects/team/projects/web", {
					dashboardUrl: "https://dashboard.example.test/work",
					issuesUrl: "javascript:alert(1)",
				}),
			],
		});
		expect(result.projects[0].dashboardUrl).toBe(
			"https://dashboard.example.test/work",
		);
		expect(result.projects[0].issuesUrl).toBe("javascript:alert(1)");
		expect(classifyProjectUrl(result.projects[0].dashboardUrl)).toBe(
			"configured",
		);
		expect(classifyProjectUrl(result.projects[0].issuesUrl)).toBe("invalid");
		expect(classifyProjectUrl(null)).toBe("missing");
	});

	it.each([
		"/relative/path",
		"file:///tmp/local.html",
		"data:text/html,hello",
		"https://",
		"https://user:secret@example.test/",
		"https://dashboard.example.test\\path",
		" https://example.test/",
	])("does not accept invalid project URL %s", (value) => {
		expect(classifyProjectUrl(value)).toBe("invalid");
	});

	it("scans the configured naia-adk path", async () => {
		vi.mocked(invoke).mockResolvedValue({
			projects: [project("example")],
			catalogErrors: [],
		});
		const result = await scanProjectCatalog("/selected/naia-adk");

		expect(invoke).toHaveBeenCalledWith("projects_scan_adk", {
			adkPath: "/selected/naia-adk",
		});
		expect(result.projects[0].projectId).toBe("example");
	});

	it("normalizes docsUrl/tasksUrl aliases, codingApp, docsDirs, and class config", () => {
		const result = normalizeProjectCatalog({
			projects: [
				project("class-demo", "projects/team/projects/class-demo", {
					dashboardUrl: "https://legacy-dashboard.example.test/",
					docsUrl: "https://docs.example.test/guide",
					issuesUrl: "https://legacy-issues.example.test/",
					tasksUrl: "https://tasks.example.test/board",
					codingApp: "opencode",
					docsDirs: ["domain", "자료", "../escape", "/abs", "domain"],
					class: { baselineRef: "0123456789abcdef" },
				}),
				project("invalid-meta", "projects/team/projects/invalid-meta", {
					codingApp: "unknown-app",
					docsDirs: ["bad\\path"],
					class: { baselineRef: "not-hex!" },
				}),
			],
		});

		expect(result.projects[0].dashboardUrl).toBe(
			"https://docs.example.test/guide",
		);
		expect(result.projects[0].issuesUrl).toBe(
			"https://tasks.example.test/board",
		);
		expect(result.projects[0].codingApp).toBe("opencode");
		expect(result.projects[0].docsDirs).toEqual(["domain", "자료"]);
		expect(result.projects[0].class).toEqual({
			baselineRef: "0123456789abcdef",
		});
		expect(result.projects[1].codingApp).toBeNull();
		expect(result.projects[1].docsDirs).toEqual([]);
		expect(result.projects[1].class).toBeNull();
	});

	it("invokes project docs and class reset commands with normalized responses", async () => {
		vi.mocked(invoke).mockImplementation(async (command) => {
			if (command === "project_docs_list") {
				return [
					{
						dir: "domain",
						relativePath: "domain/guide.md",
						sizeBytes: 128,
					},
				];
			}
			if (command === "project_docs_read") {
				return "# Guide";
			}
			if (command === "project_class_reset") {
				return {
					backupRelativePath: "class-backups/practice-20261025-120000",
					backedUpFiles: 2,
					deletedFiles: 1,
				};
			}
			return null;
		});

		const docs = await listProjectDocs(
			"/fixture/adapter",
			"/fixture/naia-adk/projects/team/projects/class-demo",
		);
		expect(docs).toEqual([
			{
				dir: "domain",
				relativePath: "domain/guide.md",
				sizeBytes: 128,
			},
		]);
		const markdown = await readProjectDoc(
			"/fixture/adapter",
			"/fixture/naia-adk/projects/team/projects/class-demo",
			"domain/guide.md",
		);
		expect(markdown).toBe("# Guide");
		const reset = await resetProjectClass(
			"/fixture/adapter",
			"/fixture/naia-adk/projects/team/projects/class-demo",
		);
		expect(reset).toEqual({
			backupRelativePath: "class-backups/practice-20261025-120000",
			backedUpFiles: 2,
			deletedFiles: 1,
		});
	});

	it("parses code:detail errors and keeps only safe relative path details", () => {
		expect(
			parseProjectCommandError(new Error("checkout_missing:checkouts/x")),
		).toEqual({
			code: "checkout_missing",
			relativePathDetail: "checkouts/x",
		});
		expect(parseProjectCommandError("checkout_missing:/abs/secret")).toEqual({
			code: "checkout_missing",
			relativePathDetail: null,
		});
		expect(parseProjectCommandError("checkout_missing:../escape/path")).toEqual(
			{
				code: "checkout_missing",
				relativePathDetail: null,
			},
		);
		expect(parseProjectCommandError("baseline_missing")).toEqual({
			code: "baseline_missing",
			relativePathDetail: null,
		});
	});
});
