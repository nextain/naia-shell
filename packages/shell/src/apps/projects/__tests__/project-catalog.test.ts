import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	normalizeProjectCatalog,
	scanProjectCatalog,
} from "../project-catalog";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const project = (
	directoryName: string,
	extra: Record<string, unknown> = {},
) => ({
	directoryName,
	projectId: directoryName,
	name: directoryName,
	repository: null,
	issueTracker: null,
	configErrors: [],
	...extra,
});

describe("Project catalog — F-01", () => {
	beforeEach(() => vi.clearAllMocks());

	it("lists ready projects and excludes both template directories", () => {
		const result = normalizeProjectCatalog({
			projects: [
				project("_template"),
				project("_template-local"),
				project("example-project", {
					projectId: "example-project-id",
					repository: "example-org/example-project",
					issueTracker: "github",
				}),
			],
		});

		expect(result.projects).toEqual([
			{
				directoryName: "example-project",
				projectId: "example-project-id",
				name: "example-project",
				repository: "example-org/example-project",
				issueTracker: "github",
				configErrors: [],
			},
		]);
	});

	it("returns an empty list when the checkout contains no projects", () => {
		expect(normalizeProjectCatalog({ projects: [] })).toEqual({ projects: [] });
	});

	it("preserves entry and file-size cutoff evidence from the native scan", () => {
		const truncation = {
			maxEntries: 200,
			scannedEntries: 200,
			moreEntriesAvailable: true,
			maxConfigFileBytes: 65536,
			oversizedFiles: [
				{
					file: "projects/large/project.yaml",
					observedBytes: 65537,
				},
			],
		};
		expect(
			normalizeProjectCatalog({ projects: [], truncation }).truncation,
		).toEqual(truncation);
	});

	it("preserves supported project configuration errors", () => {
		const reasons = [
			"missing",
			"unreadable",
			"invalid_yaml",
			"missing_project_id",
			"unsafe_path",
		] as const;
		const issues = reasons.map((reason) => ({
			file: `projects/demo/${reason}`,
			reason,
		}));
		const result = normalizeProjectCatalog({
			projects: [project("demo", { configErrors: issues })],
		});

		expect(result.projects[0].configErrors).toEqual(issues);
	});

	it("rejects malformed native responses rather than presenting an empty success", () => {
		expect(() =>
			normalizeProjectCatalog({ projects: [{ directoryName: "broken" }] }),
		).toThrow("Invalid project catalog entry.");
		expect(() => normalizeProjectCatalog({ projects: null })).toThrow(
			"Invalid project catalog response.",
		);
	});

	it("scans only the checkout selected by the user", async () => {
		vi.mocked(invoke).mockResolvedValue({
			projects: [project("example-project")],
		});
		const result = await scanProjectCatalog("/selected/workspace");

		expect(invoke).toHaveBeenCalledWith("projects_scan_checkout", {
			checkoutPath: "/selected/workspace",
		});
		expect(result.projects[0].projectId).toBe("example-project");
	});
});
