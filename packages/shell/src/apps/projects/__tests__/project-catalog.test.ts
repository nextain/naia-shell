import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	classifyProjectUrl,
	normalizeProjectCatalog,
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
});
