// @vitest-environment jsdom
import { invoke } from "@tauri-apps/api/core";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAdkPath, setAdkPath } from "../../../lib/adk-store";
import { appRegistry } from "../../../lib/app-registry";
import { setLocale } from "../../../lib/i18n";
import { ProjectsApp } from "../ProjectsApp";
import { resetProjectAgentRuntimeForTests } from "../project-agent-runtime";
import {
	PROJECT_SESSION_STORAGE_KEY,
	saveProjectSession,
} from "../project-session";
import { PROJECT_APP_TRANSLATIONS } from "../translations";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
	open: vi.fn(async () => "/fixture/naia-adk"),
}));
vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn(async () => vi.fn()),
}));
vi.mock("../ProjectAgentTerminal", () => ({
	ProjectAgentTerminal: ({
		label,
		output,
	}: { label: string; output: string }) => (
		<div aria-label={label} data-project-terminal="true">
			{output}
		</div>
	),
}));
vi.mock("../../../lib/adk-store", () => ({
	getAdkPath: vi.fn(() => localStorage.getItem("naia-adk-path")),
	setAdkPath: vi.fn(async (path: string) => {
		localStorage.setItem("naia-adk-path", path.replace(/[/\\]+$/, ""));
	}),
}));
vi.mock("../project-session", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../project-session")>();
	return {
		...actual,
		saveProjectSession: vi.fn(actual.saveProjectSession),
	};
});

const makeProject = (projectId: string, sourceRoot = "naia-pj-adk") => ({
	adapterRoot: "/fixture/adapter-root",
	projectPath: `/fixture/naia-adk/projects/${sourceRoot}/projects/${projectId}`,
	sourcePath: `projects/${sourceRoot}/projects/${projectId}`,
	projectId,
	name: projectId === "example-app" ? "Example App" : "Example Library",
	repository: `octocat/${projectId}`,
	issueTracker: "github",
	dashboardUrl: "https://dashboard.example.test/project",
	issuesUrl: null,
});

const readyCatalog = {
	projects: [makeProject("example-app"), makeProject("example-library")],
	catalogErrors: [],
	truncation: {
		maxEntries: 200,
		scannedEntries: 9,
		moreEntriesAvailable: false,
		maxRows: 200,
		shownRows: 2,
		moreRowsAvailable: false,
		maxConfigFileBytes: 65536,
		oversizedFiles: [],
	},
};

describe("ProjectsApp — single opened project", () => {
	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	beforeEach(async () => {
		vi.clearAllMocks();
		const actualSession =
			await vi.importActual<typeof import("../project-session")>(
				"../project-session",
			);
		vi.mocked(saveProjectSession).mockImplementation(
			actualSession.saveProjectSession,
		);
		localStorage.clear();
		resetProjectAgentRuntimeForTests();
		localStorage.setItem("naia-adk-path", "/fixture/naia-adk");
		await setLocale("en");
		vi.mocked(invoke).mockImplementation(async (command, args) => {
			if (command === "projects_scan_adk") return readyCatalog;
			if (command === "project_agent_availability") {
				return ["claude", "codex", "muse", "opencode"].map((appId) => ({
					appId,
					available: true,
				}));
			}
			if (
				command === "project_agent_pty_start" ||
				command === "project_agent_pty_attach"
			) {
				return {
					appId: (args as { appId: string }).appId,
					projectPath: (args as { projectPath: string }).projectPath,
					ptyId: `pty-${(args as { projectPath: string }).projectPath.split("/").at(-1)}`,
					running: true,
				};
			}
			if (command === "project_webview_open") return false;
			return null;
		});
		vi.mocked(getAdkPath).mockImplementation(() =>
			localStorage.getItem("naia-adk-path"),
		);
	});

	it("keeps one built-in project app entry without registering projects dynamically", async () => {
		const { useAppStore } = await import("../../../stores/app");
		const appListVersion = useAppStore.getState().appListVersion;
		await import("../index");
		expect(appRegistry.get("projects")?.builtIn).toBe(true);
		expect(appRegistry.get("projects")?.keepAlive).toBe(true);
		expect(appRegistry.get("projects")?.deferMountUntilActive).toBe(true);
		expect(appRegistry.get("projects")?.id).toBe("projects");
		expect(appRegistry.get("projects")?.icon).toBe("🤖");
		expect(useAppStore.getState().appListVersion).toBe(appListVersion + 1);
	});

	it("provides complete project UI translations in every shell locale", () => {
		const locales = [
			"ar",
			"bn",
			"de",
			"en",
			"es",
			"fr",
			"hi",
			"id",
			"ja",
			"ko",
			"pt",
			"ru",
			"vi",
			"zh",
		];
		const keys = Object.keys(PROJECT_APP_TRANSLATIONS.en).sort();
		expect(Object.keys(PROJECT_APP_TRANSLATIONS).sort()).toEqual(locales);
		for (const locale of locales) {
			const translations =
				PROJECT_APP_TRANSLATIONS[
					locale as keyof typeof PROJECT_APP_TRANSLATIONS
				];
			expect(Object.keys(translations).sort()).toEqual(keys);
			expect(Object.values(translations).every((value) => value.trim())).toBe(
				true,
			);
		}
	});

	it("loads the saved ADK catalog directly without asking for another folder", async () => {
		render(<ProjectsApp />);
		expect(
			await screen.findByRole("button", { name: /Example App/ }),
		).toBeTruthy();
		const { open } = await import("@tauri-apps/plugin-dialog");
		expect(open).not.toHaveBeenCalled();
		expect(invoke).toHaveBeenCalledWith("projects_scan_adk", {
			adkPath: "/fixture/naia-adk",
		});
	});

	it("asks once for naia-adk when its saved key is missing and persists only after scanning", async () => {
		localStorage.removeItem("naia-adk-path");
		localStorage.setItem(
			"naia-config",
			JSON.stringify({ workspaceRoot: "/stale/mirror" }),
		);
		render(<ProjectsApp />);
		expect(
			await screen.findByRole("button", { name: /Example App/ }),
		).toBeTruthy();
		const { open } = await import("@tauri-apps/plugin-dialog");
		expect(open).toHaveBeenCalledTimes(1);
		expect(setAdkPath).toHaveBeenCalledWith("/fixture/naia-adk");
		expect(getAdkPath).toHaveReturnedWith(null);
		expect(localStorage.getItem("naia-adk-path")).toBe("/fixture/naia-adk");
		expect(invoke).toHaveBeenCalledWith("projects_scan_adk", {
			adkPath: "/fixture/naia-adk",
		});
	});

	it("shows path recovery and retries after a saved folder fails and the first selection is canceled", async () => {
		const { open } = await import("@tauri-apps/plugin-dialog");
		vi.mocked(open)
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce("/fixture/naia-adk");
		vi.mocked(invoke).mockImplementation(async (command) => {
			if (command !== "projects_scan_adk") return null;
			if (
				vi.mocked(invoke).mock.calls.filter(([name]) => name === command)
					.length === 1
			) {
				throw new Error("saved folder missing");
			}
			return readyCatalog;
		});
		render(<ProjectsApp />);
		expect(await screen.findByRole("alert")).toBeTruthy();
		expect(screen.getByText(/Settings > naia-adk path reset/)).toBeTruthy();
		expect(open).toHaveBeenCalledTimes(1);
		fireEvent.click(
			screen.getByRole("button", { name: "Choose folder again" }),
		);
		expect(
			await screen.findByRole("button", { name: /Example App/ }),
		).toBeTruthy();
		expect(open).toHaveBeenCalledTimes(2);
	});

	it("shows a path error when selection is canceled and can be retried", async () => {
		localStorage.removeItem("naia-adk-path");
		const { open } = await import("@tauri-apps/plugin-dialog");
		vi.mocked(open)
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce("/fixture/naia-adk");
		render(<ProjectsApp />);
		expect(await screen.findByRole("alert")).toBeTruthy();
		fireEvent.click(
			screen.getByRole("button", { name: "Choose folder again" }),
		);
		expect(
			await screen.findByRole("button", { name: /Example App/ }),
		).toBeTruthy();
		expect(open).toHaveBeenCalledTimes(2);
	});

	it("opens one project at a time and restores each project's saved stage", async () => {
		render(<ProjectsApp />);
		fireEvent.click(await screen.findByRole("button", { name: /Example App/ }));
		expect(
			screen.getByRole("heading", { name: "Example App", level: 1 }),
		).toBeTruthy();
		expect(screen.queryByRole("searchbox")).toBeNull();
		fireEvent.click(screen.getByRole("tab", { name: "Dashboard" }));
		fireEvent.click(
			screen.getByRole("button", { name: "Open another project" }),
		);
		expect(
			screen.getByRole("searchbox", { name: "Search projects" }),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Back to Example App" }),
		).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: /Example Library/ }));
		expect(
			screen.getByRole("heading", { name: "Example Library", level: 1 }),
		).toBeTruthy();
		expect(
			screen
				.getByRole("tab", { name: "Coding Agent" })
				.getAttribute("aria-selected"),
		).toBe("true");
		fireEvent.click(screen.getByRole("tab", { name: "Internal Issues" }));
		fireEvent.click(
			screen.getByRole("button", { name: "Open another project" }),
		);
		fireEvent.click(screen.getByRole("button", { name: /Example App/ }));
		expect(
			screen
				.getByRole("tab", { name: "Dashboard" })
				.getAttribute("aria-selected"),
		).toBe("true");
		const stored = JSON.parse(
			localStorage.getItem(PROJECT_SESSION_STORAGE_KEY) ?? "{}",
		);
		expect(stored.lastProject).toEqual({
			id: "example-app",
			path: "/fixture/naia-adk/projects/naia-pj-adk/projects/example-app",
		});
		expect(
			stored.stagesByProjectPath[
				"/fixture/naia-adk/projects/naia-pj-adk/projects/example-app"
			],
		).toBe("dashboard");
		expect(
			stored.stagesByProjectPath[
				"/fixture/naia-adk/projects/naia-pj-adk/projects/example-library"
			],
		).toBe("issues");
	});

	it("shows only the four fixed agents and requires an explicit choice before structured start", async () => {
		render(<ProjectsApp />);
		fireEvent.click(await screen.findByRole("button", { name: /Example App/ }));
		const claude = await screen.findByRole("radio", { name: "Claude" });
		const codex = screen.getByRole("radio", { name: "Codex" });
		const muse = screen.getByRole("radio", { name: "Muse" });
		const opencode = screen.getByRole("radio", { name: "OpenCode" });
		expect([claude, codex, muse, opencode]).toHaveLength(4);
		expect(screen.queryByRole("radio", { checked: true })).toBeNull();

		fireEvent.click(codex);
		fireEvent.click(await screen.findByRole("button", { name: "Start Codex" }));
		await waitFor(() => {
			expect(invoke).toHaveBeenCalledWith("project_agent_pty_start", {
				appId: "codex",
				projectPath: makeProject("example-app").projectPath,
				adapterRoot: "/fixture/adapter-root",
			});
		});
		fireEvent.click(await screen.findByRole("button", { name: "Stop Codex" }));
		await waitFor(() => {
			expect(invoke).toHaveBeenCalledWith("project_agent_pty_stop", {
				appId: "codex",
				projectPath: makeProject("example-app").projectPath,
				adapterRoot: "/fixture/adapter-root",
			});
		});
		expect(
			await screen.findByText("Stopping the coding app…", {
				selector: "output",
			}),
		).toBeTruthy();
		expect(invoke).not.toHaveBeenCalledWith("pty_create", expect.anything());
		expect(localStorage.getItem(PROJECT_SESSION_STORAGE_KEY)).not.toContain(
			"pty-",
		);
	});

	it("keeps unavailable fixed apps visible but disabled with PATH recovery guidance", async () => {
		vi.mocked(invoke).mockImplementation(async (command) => {
			if (command === "projects_scan_adk") return readyCatalog;
			if (command === "project_agent_availability") {
				return [
					{ appId: "claude", available: true },
					{ appId: "codex", available: true },
					{ appId: "muse", available: false },
					{ appId: "opencode", available: true },
				];
			}
			return null;
		});
		render(<ProjectsApp />);
		fireEvent.click(await screen.findByRole("button", { name: /Example App/ }));
		const muse = await screen.findByRole("radio", { name: /Muse/ });
		expect(muse).toBeDisabled();
		expect(screen.getByText("Not found on PATH")).toBeTruthy();
		expect(
			screen.getByText(/Install it and make its executable available on PATH/),
		).toBeTruthy();
		expect(invoke).not.toHaveBeenCalledWith(
			"project_agent_pty_start",
			expect.objectContaining({ appId: "muse" }),
		);
	});

	it("shows only the relative expected checkout path and a recovery step when spawn is blocked", async () => {
		vi.mocked(invoke).mockImplementation(async (command) => {
			if (command === "projects_scan_adk") return readyCatalog;
			if (command === "project_agent_availability") {
				return ["claude", "codex", "muse", "opencode"].map((appId) => ({
					appId,
					available: true,
				}));
			}
			if (command === "project_agent_pty_start") {
				throw new Error("checkout_missing:checkouts/example-app");
			}
			return null;
		});
		render(<ProjectsApp />);
		fireEvent.click(await screen.findByRole("button", { name: /Example App/ }));
		fireEvent.click(await screen.findByRole("radio", { name: "Muse" }));
		fireEvent.click(await screen.findByRole("button", { name: "Start Muse" }));
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("checkouts/example-app");
		expect(alert).toHaveTextContent(
			"Create or clone the project checkout there yourself",
		);
		expect(alert.textContent).not.toContain("/fixture/");
	});

	it("reattaches the same in-memory project session after switching A to B and back", async () => {
		render(<ProjectsApp />);
		fireEvent.click(await screen.findByRole("button", { name: /Example App/ }));
		fireEvent.click(await screen.findByRole("radio", { name: "Claude" }));
		fireEvent.click(
			await screen.findByRole("button", { name: "Start Claude" }),
		);
		await waitFor(() => {
			expect(invoke).toHaveBeenCalledWith(
				"project_agent_pty_start",
				expect.objectContaining({ appId: "claude" }),
			);
		});

		fireEvent.click(
			screen.getByRole("button", { name: "Open another project" }),
		);
		fireEvent.click(screen.getByRole("button", { name: /Example Library/ }));
		fireEvent.click(
			screen.getByRole("button", { name: "Open another project" }),
		);
		fireEvent.click(screen.getByRole("button", { name: /Example App/ }));

		await waitFor(() => {
			expect(invoke).toHaveBeenCalledWith("project_agent_pty_attach", {
				appId: "claude",
				projectPath: makeProject("example-app").projectPath,
				adapterRoot: "/fixture/adapter-root",
			});
		});
	});

	it("opens configured project URLs only through the separate WebView command", async () => {
		render(<ProjectsApp />);
		fireEvent.click(await screen.findByRole("button", { name: /Example App/ }));
		fireEvent.click(screen.getByRole("tab", { name: "Dashboard" }));
		fireEvent.click(
			await screen.findByRole("button", { name: "Open dashboard" }),
		);
		expect(
			await screen.findByText(/not created in this test environment/),
		).toBeTruthy();
		expect(invoke).toHaveBeenCalledWith("project_webview_open", {
			adapterRoot: "/fixture/adapter-root",
			projectPath: makeProject("example-app").projectPath,
			view: "dashboard",
		});
		fireEvent.click(screen.getByRole("tab", { name: "Internal Issues" }));
		expect(
			await screen.findByText("This address is not configured"),
		).toBeTruthy();
		expect(
			vi
				.mocked(invoke)
				.mock.calls.filter(([command]) => command === "project_webview_open"),
		).toHaveLength(1);
	});

	it("restores the last project and stage after remounting", async () => {
		const first = render(<ProjectsApp />);
		fireEvent.click(
			await screen.findByRole("button", { name: /Example Library/ }),
		);
		fireEvent.click(screen.getByRole("tab", { name: "Dashboard" }));
		first.unmount();
		render(<ProjectsApp />);
		expect(
			await screen.findByRole("heading", { name: "Example Library", level: 1 }),
		).toBeTruthy();
		expect(
			screen
				.getByRole("tab", { name: "Dashboard" })
				.getAttribute("aria-selected"),
		).toBe("true");
	});

	it("shows a status message when project session storage fails", async () => {
		vi.mocked(saveProjectSession).mockReturnValue(false);

		render(<ProjectsApp />);
		fireEvent.click(await screen.findByRole("button", { name: /Example App/ }));

		expect(await screen.findByRole("status")).toHaveTextContent(
			"Project state could not be saved",
		);
	});

	it("returns to the opened project when the other-project catalog is canceled", async () => {
		render(<ProjectsApp />);
		fireEvent.click(await screen.findByRole("button", { name: /Example App/ }));
		fireEvent.click(
			screen.getByRole("button", { name: "Open another project" }),
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Back to Example App" }),
		);
		expect(
			screen.getByRole("heading", { name: "Example App", level: 1 }),
		).toBeTruthy();
		expect(screen.queryByRole("searchbox")).toBeNull();
	});

	it("shows metadata errors and catalog truncation as relative-path notices", async () => {
		vi.mocked(invoke).mockImplementation(async (command) =>
			command === "projects_scan_adk"
				? {
						...readyCatalog,
						catalogErrors: [
							{
								path: "projects/group/projects/broken/project.yaml",
								reason: "invalid_yaml",
							},
						],
						truncation: {
							...readyCatalog.truncation,
							scannedEntries: 200,
							moreEntriesAvailable: true,
							shownRows: 3,
							oversizedFiles: [
								{
									file: "projects/group/projects/large/project.yaml",
									observedBytes: 70000,
								},
							],
						},
					}
				: null,
		);
		render(<ProjectsApp />);
		expect(
			await screen.findByText("projects/group/projects/broken/project.yaml"),
		).toBeTruthy();
		expect(
			screen.getByText("projects/group/projects/large/project.yaml"),
		).toBeTruthy();
		expect(
			screen.getByRole("status", { name: "Some project details were skipped" }),
		).toBeTruthy();
	});

	it("shows index repair guidance when no project metadata is found", async () => {
		vi.mocked(invoke).mockImplementation(async (command) =>
			command === "projects_scan_adk"
				? {
						projects: [],
						catalogErrors: [
							{
								path: ".agents/context/project-index.yaml",
								reason: "invalid_yaml",
							},
						],
					}
				: null,
		);
		render(<ProjectsApp />);

		expect(
			await screen.findByRole("heading", { name: "No projects found" }),
		).toBeTruthy();
		expect(screen.getByText(".agents/context/project-index.yaml")).toBeTruthy();
		expect(screen.getByText(/is invalid\./)).toBeTruthy();
		expect(screen.getByText(/reset its path in Settings/)).toBeTruthy();
	});

	it("shows a recovery notice when the last project is no longer in the catalog", async () => {
		localStorage.setItem(
			PROJECT_SESSION_STORAGE_KEY,
			JSON.stringify({
				version: 1,
				lastProject: { id: "gone", path: "/fixture/naia-adk/projects/gone" },
				stagesByProjectPath: {},
			}),
		);
		render(<ProjectsApp />);
		expect(
			await screen.findByText(/last project is no longer in the catalog/),
		).toBeTruthy();
		expect(screen.getByRole("button", { name: /Example App/ })).toBeTruthy();
	});

	it("supports arrow and boundary-key navigation between the accessible tabs", async () => {
		render(<ProjectsApp />);
		fireEvent.click(await screen.findByRole("button", { name: /Example App/ }));
		const coding = screen.getByRole("tab", { name: "Coding Agent" });
		coding.focus();
		fireEvent.keyDown(coding, { key: "ArrowRight" });
		const dashboard = screen.getByRole("tab", { name: "Dashboard" });
		expect(dashboard.getAttribute("aria-selected")).toBe("true");
		expect(document.activeElement).toBe(dashboard);
		fireEvent.keyDown(dashboard, { key: "End" });
		expect(
			screen
				.getByRole("tab", { name: "Internal Issues" })
				.getAttribute("aria-selected"),
		).toBe("true");
		fireEvent.keyDown(screen.getByRole("tab", { name: "Internal Issues" }), {
			key: "Home",
		});
		expect(coding.getAttribute("aria-selected")).toBe("true");
	});
});
