// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	PROJECT_SESSION_STORAGE_KEY,
	loadProjectSession,
	normalizeProjectPath,
	saveProjectSession,
	stageForProject,
} from "../project-session";

describe("project session persistence", () => {
	beforeEach(() => localStorage.clear());
	afterEach(() => vi.unstubAllGlobals());

	it("normalizes Windows separators and drive-letter case for project identity", () => {
		expect(normalizeProjectPath("C:\\Fixture\\project\\")).toBe(
			"c:/Fixture/project",
		);
	});

	it("saves and restores the last project and its per-project stage", () => {
		const session = {
			version: 1 as const,
			lastProject: { id: "public-demo", path: "/adk/projects/demo" },
			stagesByProjectPath: { "/adk/projects/demo": "dashboard" as const },
		};
		expect(saveProjectSession(session)).toBe(true);
		expect(localStorage.getItem(PROJECT_SESSION_STORAGE_KEY)).not.toBeNull();
		const loaded = loadProjectSession();
		expect(loaded.invalid).toBe(false);
		expect(loaded.session).toEqual(session);
		expect(stageForProject(loaded.session, "/adk/projects/demo")).toBe(
			"dashboard",
		);
		expect(stageForProject(loaded.session, "/adk/projects/new")).toBe("agent");
	});

	it("returns false when browser storage rejects the session write", () => {
		vi.stubGlobal("localStorage", {
			setItem() {
				throw new Error("storage unavailable");
			},
		});
		expect(
			saveProjectSession({
				version: 1,
				lastProject: null,
				stagesByProjectPath: {},
			}),
		).toBe(false);
	});

	it("marks malformed or unsupported state for recovery without trusting it", () => {
		localStorage.setItem(
			PROJECT_SESSION_STORAGE_KEY,
			JSON.stringify({
				version: 1,
				lastProject: { id: "demo", path: "/adk/demo" },
				stagesByProjectPath: { "/adk/demo": "runtime" },
			}),
		);
		const loaded = loadProjectSession();
		expect(loaded.invalid).toBe(true);
		expect(loaded.session.lastProject).toBeNull();
	});
});
