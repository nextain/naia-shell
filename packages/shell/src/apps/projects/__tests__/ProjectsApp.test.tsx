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
import {
	loadProjectAgentAvailability,
	resetProjectAgentRuntimeForTests,
	writeProjectAgent,
} from "../project-agent-runtime";
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
		inputFailed,
	}: { label: string; output: string; inputFailed: boolean }) => (
		<div aria-label={label} data-project-terminal="true">
			{inputFailed && (
				<output role="alert">
					{PROJECT_APP_TRANSLATIONS.en["projects.agentInputFailed"]}
				</output>
			)}
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

const makeProject = (
	projectId: string,
	sourceRoot = "naia-pj-adk",
	extra: Record<string, unknown> = {},
) => ({
	adapterRoot: "/fixture/adapter-root",
	projectPath: `/fixture/naia-adk/projects/${sourceRoot}/projects/${projectId}`,
	sourcePath: `projects/${sourceRoot}/projects/${projectId}`,
	projectId,
	name: projectId === "example-app" ? "Example App" : "Example Library",
	repository: `octocat/${projectId}`,
	issueTracker: "github",
	dashboardUrl: "https://dashboard.example.test/project",
	issuesUrl: "https://issues.example.test/project",
	...extra,
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
		const entry = appRegistry.get("projects");
		expect(entry?.builtIn).toBe(true);
		expect(entry?.keepAlive).toBe(true);
		expect(entry?.deferMountUntilActive).toBe(true);
		expect(entry?.id).toBe("projects");
		expect(entry?.icon).not.toBe("🤖");
		expect(entry?.iconSvg).toContain("<svg");
		expect(entry?.iconSvg).toContain('viewBox="0 0 24 24"');
		expect(entry?.iconSvg).toContain("currentColor");
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
			expect(translations["projects.agentInstallHint"]).toContain(
				locale === "ko" ? "PATH에서 찾을 수 없음" : "Not found on PATH",
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
		fireEvent.click(screen.getByRole("tab", { name: "Docs" }));
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
		fireEvent.click(screen.getByRole("tab", { name: "Tasks" }));
		fireEvent.click(
			screen.getByRole("button", { name: "Open another project" }),
		);
		fireEvent.click(screen.getByRole("button", { name: /Example App/ }));
		expect(
			screen.getByRole("tab", { name: "Docs" }).getAttribute("aria-selected"),
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

	it("shows a localized terminal status after native PTY input is rejected", async () => {
		const project = makeProject("example-app");
		render(<ProjectsApp />);
		fireEvent.click(await screen.findByRole("button", { name: /Example App/ }));
		fireEvent.click(await screen.findByRole("radio", { name: "Claude" }));
		fireEvent.click(
			await screen.findByRole("button", { name: "Start Claude" }),
		);
		await screen.findByRole("button", { name: "Stop Claude" });

		vi.mocked(invoke).mockImplementation(async (command, args) => {
			if (command === "project_agent_pty_write")
				throw "write_failed:BrokenPipe";
			if (command === "project_agent_pty_start") {
				return {
					appId: (args as { appId: string }).appId,
					projectPath: (args as { projectPath: string }).projectPath,
					ptyId: "pty-example-app",
					running: true,
				};
			}
			return null;
		});
		await writeProjectAgent(
			project.projectPath,
			project.adapterRoot,
			"claude",
			"hello\r",
		);

		expect(
			await screen.findAllByText(
				"Terminal input was not delivered. Start a new session to retry.",
			),
		).toHaveLength(2);
		expect(screen.getAllByRole("alert")).toHaveLength(2);
		expect(screen.getByRole("button", { name: "Start Claude" })).toBeTruthy();
	});

	it("keeps a running available app selected when other coding apps are missing", async () => {
		vi.mocked(invoke).mockImplementation(async (command, args) => {
			if (command === "projects_scan_adk") return readyCatalog;
			if (command === "project_agent_availability") {
				return [
					{ appId: "claude", available: true },
					{ appId: "codex", available: false },
					{ appId: "muse", available: false },
					{ appId: "opencode", available: false },
				];
			}
			if (command === "project_agent_pty_start") {
				return {
					appId: (args as { appId: string }).appId,
					projectPath: (args as { projectPath: string }).projectPath,
					ptyId: "pty-running-claude",
					running: true,
				};
			}
			return null;
		});
		render(<ProjectsApp />);
		fireEvent.click(await screen.findByRole("button", { name: /Example App/ }));

		const claude = await screen.findByRole("radio", { name: "Claude" });
		fireEvent.click(claude);
		fireEvent.click(
			await screen.findByRole("button", { name: "Start Claude" }),
		);

		expect(
			await screen.findByRole("button", { name: "Stop Claude" }),
		).toBeTruthy();
		expect(claude).toBeChecked();
		expect(claude).toBeDisabled();
		expect(claude.closest("label")).toHaveClass(
			"projects-app__agent-option--selected",
		);
		expect(
			screen.getByText(/To use an app marked “Not found on PATH,”/),
		).toBeTruthy();
		expect(
			screen.getByText("Claude is running for this project."),
		).toBeTruthy();
		expect(
			screen.queryByText(/The selected coding app was not found on PATH/),
		).toBeNull();
	});

	it("shows the install guidance when every fixed coding app is missing", async () => {
		vi.mocked(invoke).mockImplementation(async (command) => {
			if (command === "projects_scan_adk") return readyCatalog;
			if (command === "project_agent_availability") {
				return ["claude", "codex", "muse", "opencode"].map((appId) => ({
					appId,
					available: false,
				}));
			}
			return null;
		});
		render(<ProjectsApp />);
		fireEvent.click(await screen.findByRole("button", { name: /Example App/ }));

		expect(
			await screen.findByText(/To use an app marked “Not found on PATH,”/),
		).toBeTruthy();
		for (const appName of ["Claude", "Codex", "Muse", "OpenCode"]) {
			expect(
				screen.getByRole("radio", { name: new RegExp(appName) }),
			).toBeDisabled();
		}
		expect(screen.queryByRole("button", { name: /Start/ })).toBeNull();
		expect(screen.queryByRole("radio", { checked: true })).toBeNull();
	});

	it("blocks starting a selected app after it disappears from PATH", async () => {
		let availabilityChecks = 0;
		vi.mocked(invoke).mockImplementation(async (command) => {
			if (command === "projects_scan_adk") return readyCatalog;
			if (command === "project_agent_availability") {
				availabilityChecks += 1;
				return ["claude", "codex", "muse", "opencode"].map((appId) => ({
					appId,
					available: availabilityChecks === 1,
				}));
			}
			return null;
		});
		render(<ProjectsApp />);
		fireEvent.click(await screen.findByRole("button", { name: /Example App/ }));

		const claude = await screen.findByRole("radio", { name: "Claude" });
		fireEvent.click(claude);
		expect(
			await screen.findByRole("button", { name: "Start Claude" }),
		).toBeTruthy();

		await loadProjectAgentAvailability();

		await waitFor(() => {
			expect(claude).toBeChecked();
			expect(claude).toBeDisabled();
			expect(claude.closest("label")).toHaveClass(
				"projects-app__agent-option--selected",
			);
			expect(screen.queryByRole("button", { name: "Start Claude" })).toBeNull();
		});
		expect(
			screen.getByText(/To use an app marked “Not found on PATH,”/),
		).toBeTruthy();
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
			screen.getByText(/To use an app marked “Not found on PATH,”/),
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
		fireEvent.click(screen.getByRole("tab", { name: "Docs" }));
		fireEvent.click(await screen.findByRole("button", { name: "Open docs" }));
		expect(
			await screen.findByText(/not created in this test environment/),
		).toBeTruthy();
		expect(invoke).toHaveBeenCalledWith("project_webview_open", {
			adapterRoot: "/fixture/adapter-root",
			projectPath: makeProject("example-app").projectPath,
			view: "dashboard",
		});
		fireEvent.click(screen.getByRole("tab", { name: "Tasks" }));
		fireEvent.click(await screen.findByRole("button", { name: "Open tasks" }));
		expect(invoke).toHaveBeenCalledWith("project_webview_open", {
			adapterRoot: "/fixture/adapter-root",
			projectPath: makeProject("example-app").projectPath,
			view: "issues",
		});
		expect(
			vi
				.mocked(invoke)
				.mock.calls.filter(([command]) => command === "project_webview_open"),
		).toHaveLength(2);
	});

	it("restores the last project and stage after remounting", async () => {
		const first = render(<ProjectsApp />);
		fireEvent.click(
			await screen.findByRole("button", { name: /Example Library/ }),
		);
		fireEvent.click(screen.getByRole("tab", { name: "Docs" }));
		first.unmount();
		render(<ProjectsApp />);
		expect(
			await screen.findByRole("heading", { name: "Example Library", level: 1 }),
		).toBeTruthy();
		expect(
			screen.getByRole("tab", { name: "Docs" }).getAttribute("aria-selected"),
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
		const docs = screen.getByRole("tab", { name: "Docs" });
		expect(docs.getAttribute("aria-selected")).toBe("true");
		expect(document.activeElement).toBe(docs);
		fireEvent.keyDown(docs, { key: "End" });
		expect(
			screen.getByRole("tab", { name: "Tasks" }).getAttribute("aria-selected"),
		).toBe("true");
		fireEvent.keyDown(screen.getByRole("tab", { name: "Tasks" }), {
			key: "Home",
		});
		expect(coding.getAttribute("aria-selected")).toBe("true");
	});

	it("renders renamed Korean and English labels for Docs and Tasks tabs and actions", async () => {
		expect(PROJECT_APP_TRANSLATIONS.en["projects.tabDashboard"]).toBe("Docs");
		expect(PROJECT_APP_TRANSLATIONS.en["projects.tabInternalIssues"]).toBe(
			"Tasks",
		);
		expect(PROJECT_APP_TRANSLATIONS.en["projects.webviewOpenDashboard"]).toBe(
			"Open docs",
		);
		expect(PROJECT_APP_TRANSLATIONS.en["projects.webviewOpenIssues"]).toBe(
			"Open tasks",
		);
		expect(PROJECT_APP_TRANSLATIONS.ko["projects.tabDashboard"]).toBe("문서");
		expect(PROJECT_APP_TRANSLATIONS.ko["projects.tabInternalIssues"]).toBe(
			"작업",
		);
		expect(PROJECT_APP_TRANSLATIONS.ko["projects.webviewOpenDashboard"]).toBe(
			"문서 열기",
		);
		expect(PROJECT_APP_TRANSLATIONS.ko["projects.webviewOpenIssues"]).toBe(
			"작업 열기",
		);

		await setLocale("ko");
		render(<ProjectsApp />);
		fireEvent.click(await screen.findByRole("button", { name: /Example App/ }));
		expect(screen.getByRole("tab", { name: "코딩 에이전트" })).toBeTruthy();
		expect(screen.getByRole("tab", { name: "문서" })).toBeTruthy();
		expect(screen.getByRole("tab", { name: "작업" })).toBeTruthy();
	});

	it("hides empty tabs, omits the tablist when only Coding Agent is visible, and falls back when a saved tab is hidden", async () => {
		const agentOnlyProject = makeProject("agent-only", "naia-pj-adk", {
			name: "Agent Only",
			dashboardUrl: null,
			issuesUrl: null,
			docsDirs: [],
		});
		const docsOnlyProject = makeProject("docs-only", "naia-pj-adk", {
			name: "Docs Only",
			dashboardUrl: null,
			issuesUrl: null,
			docsDirs: ["domain"],
		});
		localStorage.setItem(
			PROJECT_SESSION_STORAGE_KEY,
			JSON.stringify({
				version: 1,
				lastProject: {
					id: "agent-only",
					path: agentOnlyProject.projectPath,
				},
				stagesByProjectPath: {
					[agentOnlyProject.projectPath]: "issues",
				},
			}),
		);
		vi.mocked(invoke).mockImplementation(async (command) => {
			if (command === "projects_scan_adk") {
				return {
					...readyCatalog,
					projects: [agentOnlyProject, docsOnlyProject],
				};
			}
			if (command === "project_agent_availability") {
				return ["claude", "codex", "muse", "opencode"].map((appId) => ({
					appId,
					available: true,
				}));
			}
			if (command === "project_docs_list") return [];
			return null;
		});

		render(<ProjectsApp />);
		expect(
			await screen.findByRole("heading", { name: "Agent Only", level: 1 }),
		).toBeTruthy();
		expect(screen.queryByRole("tablist")).toBeNull();
		expect(
			screen.getByRole("heading", { name: "Coding Agent", level: 2 }),
		).toBeTruthy();

		fireEvent.click(
			screen.getByRole("button", { name: "Open another project" }),
		);
		fireEvent.click(screen.getByRole("button", { name: /Docs Only/ }));
		expect(screen.getByRole("tablist")).toBeTruthy();
		const tabs = screen.getAllByRole("tab");
		expect(tabs.map((tab) => tab.textContent)).toEqual([
			"Coding Agent",
			"Docs",
		]);
		expect(screen.queryByRole("tab", { name: "Tasks" })).toBeNull();

		tabs[0].focus();
		fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
		expect(tabs[1].getAttribute("aria-selected")).toBe("true");
		fireEvent.keyDown(tabs[1], { key: "ArrowRight" });
		expect(tabs[0].getAttribute("aria-selected")).toBe("true");
	});

	it("rescans the saved naia-adk path via the Reload button, keeps current project, and handles reload errors", async () => {
		let scanCalls = 0;
		const addedProject = makeProject("newly-added", "naia-pj-adk", {
			name: "Newly Added Project",
		});
		vi.mocked(invoke).mockImplementation(async (command) => {
			if (command === "projects_scan_adk") {
				scanCalls += 1;
				if (scanCalls === 1) return readyCatalog;
				if (scanCalls === 2) {
					return {
						...readyCatalog,
						projects: [...readyCatalog.projects, addedProject],
					};
				}
				throw new Error("reload scan failed");
			}
			if (command === "project_agent_availability") {
				return ["claude", "codex", "muse", "opencode"].map((appId) => ({
					appId,
					available: true,
				}));
			}
			return null;
		});

		render(<ProjectsApp />);
		fireEvent.click(await screen.findByRole("button", { name: /Example App/ }));
		fireEvent.click(
			screen.getByRole("button", { name: "Open another project" }),
		);
		expect(
			screen.queryByRole("button", { name: /Newly Added Project/ }),
		).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Reload" }));
		expect(
			await screen.findByRole("button", { name: /Newly Added Project/ }),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Back to Example App" }),
		).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Reload" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Could not read the naia-adk projects",
		);
	});

	it("preselects coding_app when the project has no selection yet and still allows changing it", async () => {
		const classProject = makeProject("class-app", "naia-pj-adk", {
			name: "Class App",
			codingApp: "opencode",
		});
		vi.mocked(invoke).mockImplementation(async (command) => {
			if (command === "projects_scan_adk") {
				return { ...readyCatalog, projects: [classProject] };
			}
			if (command === "project_agent_availability") {
				return ["claude", "codex", "muse", "opencode"].map((appId) => ({
					appId,
					available: true,
				}));
			}
			return null;
		});

		render(<ProjectsApp />);
		fireEvent.click(await screen.findByRole("button", { name: /Class App/ }));
		const opencode = await screen.findByRole("radio", { name: "OpenCode" });
		const claude = screen.getByRole("radio", { name: "Claude" });
		await waitFor(() => {
			expect(opencode).toBeChecked();
		});
		expect(
			await screen.findByRole("button", { name: "Start OpenCode" }),
		).toBeTruthy();

		fireEvent.click(claude);
		expect(claude).toBeChecked();
		expect(
			await screen.findByRole("button", { name: "Start Claude" }),
		).toBeTruthy();
	});

	it("renders the docs panel with grouped files, markdown preview, refresh, empty, and error states", async () => {
		let docListMode: "populated" | "empty" | "error" = "populated";
		let readErrorMode = false;
		const docsProject = makeProject("class-docs", "naia-pj-adk", {
			name: "Class Docs",
			dashboardUrl: "https://docs.example.test/portal",
			issuesUrl: null,
			docsDirs: ["domain", "자료"],
		});
		vi.mocked(invoke).mockImplementation(async (command, args) => {
			if (command === "projects_scan_adk") {
				return { ...readyCatalog, projects: [docsProject] };
			}
			if (command === "project_agent_availability") {
				return ["claude", "codex", "muse", "opencode"].map((appId) => ({
					appId,
					available: true,
				}));
			}
			if (command === "project_docs_list") {
				if (docListMode === "error")
					throw new Error("checkout_missing:checkouts/x");
				if (docListMode === "empty") return [];
				return [
					{
						dir: "domain",
						relativePath: "domain/overview.md",
						sizeBytes: 64,
					},
					{
						dir: "자료",
						relativePath: "자료/day1.md",
						sizeBytes: 120,
					},
				];
			}
			if (command === "project_docs_read") {
				if (readErrorMode) throw new Error("doc_too_large");
				const rel = (args as { relativePath: string }).relativePath;
				return rel === "자료/day1.md"
					? "# Day 1 Lesson\n\nPractice content."
					: "# Domain Overview\n\nWelcome to the class.";
			}
			return null;
		});

		render(<ProjectsApp />);
		fireEvent.click(await screen.findByRole("button", { name: /Class Docs/ }));
		fireEvent.click(screen.getByRole("tab", { name: "Docs" }));

		expect(
			await screen.findByRole("button", { name: "Open docs" }),
		).toBeTruthy();
		expect(
			await screen.findByRole("heading", { name: "Domain Overview" }),
		).toBeTruthy();
		expect(screen.getByRole("heading", { name: "domain" })).toBeTruthy();
		expect(screen.getByRole("heading", { name: "자료" })).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "day1.md" }));
		expect(
			await screen.findByRole("heading", { name: "Day 1 Lesson" }),
		).toBeTruthy();

		readErrorMode = true;
		fireEvent.click(screen.getByRole("button", { name: "overview.md" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"This document exceeds the 1 MiB preview limit.",
		);

		readErrorMode = false;
		docListMode = "empty";
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		expect(
			await screen.findByRole("heading", { name: "No documents found" }),
		).toBeTruthy();

		docListMode = "error";
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		const listAlert = await screen.findByRole("alert");
		expect(listAlert).toHaveTextContent(
			"The expected project checkout is missing.",
		);
		expect(listAlert).toHaveTextContent("checkouts/x");
	});

	it("shows Reset class only for class projects, handles Cancel/Escape, stops running agent before resetting, and surfaces errors", async () => {
		let resetShouldFail: string | null = null;
		let attachShouldFail: string | null = null;
		const classProject = makeProject("practice-class", "naia-pj-adk", {
			name: "Practice Class",
			codingApp: "opencode",
			docsDirs: ["domain"],
			class: { baselineRef: "1234567890abcdef" },
		});
		const regularProject = makeProject("regular-app", "naia-pj-adk", {
			name: "Regular App",
		});
		const callOrder: string[] = [];
		vi.mocked(invoke).mockImplementation(async (command, args) => {
			if (
				command === "project_agent_pty_stop" ||
				command === "project_agent_pty_attach" ||
				command === "project_class_reset"
			) {
				callOrder.push(command);
			}
			if (command === "projects_scan_adk") {
				return {
					...readyCatalog,
					projects: [classProject, regularProject],
				};
			}
			if (command === "project_agent_availability") {
				return ["claude", "codex", "muse", "opencode"].map((appId) => ({
					appId,
					available: true,
				}));
			}
			if (command === "project_agent_pty_start") {
				return {
					appId: (args as { appId: string }).appId,
					projectPath: (args as { projectPath: string }).projectPath,
					ptyId: "pty-class",
					running: true,
				};
			}
			if (command === "project_agent_pty_stop") {
				return null;
			}
			if (command === "project_agent_pty_attach" && attachShouldFail) {
				throw new Error(attachShouldFail);
			}
			if (command === "project_docs_list") {
				return [
					{
						dir: "domain",
						relativePath: "domain/lesson.md",
						sizeBytes: 42,
					},
				];
			}
			if (command === "project_docs_read") {
				return "# Lesson";
			}
			if (command === "project_class_reset") {
				if (resetShouldFail) throw new Error(resetShouldFail);
				return {
					backupRelativePath: "class-backups/practice-class-20261025-150000",
					backedUpFiles: 3,
					deletedFiles: 1,
				};
			}
			return null;
		});

		render(<ProjectsApp />);
		fireEvent.click(await screen.findByRole("button", { name: /Regular App/ }));
		expect(screen.queryByRole("button", { name: "Reset class" })).toBeNull();

		fireEvent.click(
			screen.getByRole("button", { name: "Open another project" }),
		);
		fireEvent.click(
			await screen.findByRole("button", { name: /Practice Class/ }),
		);
		const resetButton = screen.getByRole("button", { name: "Reset class" });
		expect(resetButton).toBeTruthy();

		fireEvent.click(resetButton);
		const dialog = screen.getByRole("dialog");
		expect(dialog.getAttribute("aria-modal")).toBe("true");
		const header = document.querySelector(".projects-app__project-header");
		const projectView = document.querySelector(".projects-app__project-view");
		expect(header?.hasAttribute("inert")).toBe(true);
		expect(header?.getAttribute("aria-hidden")).toBe("true");
		expect(projectView?.hasAttribute("inert")).toBe(true);
		expect(projectView?.getAttribute("aria-hidden")).toBe("true");

		const cancelButton = screen.getByRole("button", { name: "Cancel" });
		const confirmButton = screen.getByRole("button", { name: "Reset" });
		expect(document.activeElement).toBe(cancelButton);

		// Tab cycles Cancel -> Reset -> Cancel (last -> first)
		fireEvent.keyDown(window, { key: "Tab" });
		expect(document.activeElement).toBe(confirmButton);
		fireEvent.keyDown(window, { key: "Tab" });
		expect(document.activeElement).toBe(cancelButton);

		// Shift+Tab cycles Cancel -> Reset (first -> last) -> Cancel
		fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
		expect(document.activeElement).toBe(confirmButton);
		fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
		expect(document.activeElement).toBe(cancelButton);

		fireEvent.keyDown(window, { key: "Escape" });
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(header?.hasAttribute("inert")).toBe(false);
		expect(projectView?.hasAttribute("inert")).toBe(false);
		expect(document.activeElement).toBe(resetButton);

		fireEvent.click(resetButton);
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(document.activeElement).toBe(resetButton);

		fireEvent.click(
			await screen.findByRole("button", { name: "Start OpenCode" }),
		);
		await screen.findByRole("button", { name: "Stop OpenCode" });

		callOrder.length = 0;
		fireEvent.click(screen.getByRole("button", { name: "Reset class" }));
		fireEvent.click(screen.getByRole("button", { name: "Reset" }));

		expect(
			await screen.findByText(/Class checkout reset complete/),
		).toBeTruthy();
		expect(document.activeElement).toBe(
			screen.getByRole("button", { name: "Reset class" }),
		);
		expect(
			screen.getByText(
				/Backed up 3 file\(s\) to class-backups\/practice-class-20261025-150000\/files\./,
			),
		).toBeTruthy();
		expect(callOrder.indexOf("project_agent_pty_stop")).toBeGreaterThanOrEqual(
			0,
		);
		expect(callOrder.indexOf("project_class_reset")).toBeGreaterThan(
			callOrder.indexOf("project_agent_pty_stop"),
		);

		resetShouldFail = "checkout_missing:checkouts/x";
		fireEvent.click(screen.getByRole("button", { name: "Reset class" }));
		fireEvent.click(screen.getByRole("button", { name: "Reset" }));
		const checkoutAlert = await screen.findByRole("alert");
		expect(checkoutAlert).toHaveTextContent(
			"The expected project checkout is missing.",
		);
		expect(checkoutAlert).toHaveTextContent("checkouts/x");

		resetShouldFail = "baseline_missing";
		fireEvent.click(screen.getByRole("button", { name: "Reset class" }));
		fireEvent.click(screen.getByRole("button", { name: "Reset" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"The configured class.baseline_ref commit was not found in the checkout repository.",
		);

		fireEvent.click(await screen.findByRole("button", { name: "Start OpenCode" }));
		await screen.findByRole("button", { name: "Stop OpenCode" });
		attachShouldFail = "ipc_unavailable";
		callOrder.length = 0;
		fireEvent.click(screen.getByRole("button", { name: "Reset class" }));
		fireEvent.click(screen.getByRole("button", { name: "Reset" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Could not confirm whether the coding agent stopped.",
		);
		expect(callOrder).not.toContain("project_class_reset");
	});

	it("polls after stopProjectAgent for a delayed stop before calling project_class_reset", async () => {
		const classProject = makeProject("delayed-stop", "naia-pj-adk", {
			name: "Delayed Stop Class",
			codingApp: "opencode",
			class: { baselineRef: "1234567890abcdef" },
		});
		let attachPollCount = 0;
		const callOrder: string[] = [];
		vi.mocked(invoke).mockImplementation(async (command, args) => {
			if (
				command === "project_agent_pty_stop" ||
				command === "project_agent_pty_attach" ||
				command === "project_class_reset"
			) {
				callOrder.push(command);
			}
			if (command === "projects_scan_adk") {
				return { ...readyCatalog, projects: [classProject] };
			}
			if (command === "project_agent_availability") {
				return ["claude", "codex", "muse", "opencode"].map((appId) => ({
					appId,
					available: true,
				}));
			}
			if (command === "project_agent_pty_start") {
				return {
					appId: (args as { appId: string }).appId,
					projectPath: (args as { projectPath: string }).projectPath,
					ptyId: "pty-delayed",
					running: true,
				};
			}
			if (command === "project_agent_pty_stop") {
				return null;
			}
			if (command === "project_agent_pty_attach") {
				attachPollCount += 1;
				if (attachPollCount < 3) {
					return {
						appId: "opencode",
						projectPath: classProject.projectPath,
						ptyId: "pty-delayed",
						running: true,
					};
				}
				throw new Error("session_missing");
			}
			if (command === "project_class_reset") {
				return {
					backupRelativePath: "class-backups/delayed-stop-20261025-160000",
					backedUpFiles: 1,
					deletedFiles: 0,
				};
			}
			return null;
		});

		render(<ProjectsApp />);
		fireEvent.click(
			await screen.findByRole("button", { name: /Delayed Stop Class/ }),
		);
		fireEvent.click(
			await screen.findByRole("button", { name: "Start OpenCode" }),
		);
		await screen.findByRole("button", { name: "Stop OpenCode" });

		callOrder.length = 0;
		fireEvent.click(screen.getByRole("button", { name: "Reset class" }));
		fireEvent.click(screen.getByRole("button", { name: "Reset" }));

		expect(
			await screen.findByText(/Class checkout reset complete/),
		).toBeTruthy();
		expect(attachPollCount).toBe(3);
		expect(callOrder.indexOf("project_agent_pty_stop")).toBe(0);
		expect(callOrder.lastIndexOf("project_agent_pty_attach")).toBeLessThan(
			callOrder.indexOf("project_class_reset"),
		);

		fireEvent.click(
			await screen.findByRole("button", { name: "Start OpenCode" }),
		);
		await screen.findByRole("button", { name: "Stop OpenCode" });
		callOrder.length = 0;
		const nowSpy = vi.spyOn(Date, "now");
		let fakeNow = 1_000_000;
		nowSpy.mockImplementation(() => {
			fakeNow += 3_000;
			return fakeNow;
		});
		attachPollCount = -100;
		try {
			fireEvent.click(screen.getByRole("button", { name: "Reset class" }));
			fireEvent.click(screen.getByRole("button", { name: "Reset" }));
			expect(await screen.findByRole("alert")).toHaveTextContent(
				"A coding agent session is still running. Stop the coding agent and try again.",
			);
			expect(callOrder).not.toContain("project_class_reset");
		} finally {
			nowSpy.mockRestore();
		}
	});

	it("disables the coding agent start button while class reset is in progress and maps class_reset_in_progress in ko/en with English fallback", async () => {
		expect(
			PROJECT_APP_TRANSLATIONS.en["projects.agentClassResetInProgress"],
		).toContain("Class checkout reset is in progress");
		expect(
			PROJECT_APP_TRANSLATIONS.ko["projects.agentClassResetInProgress"],
		).toContain("수업 체크아웃 초기화가 진행 중입니다");
		expect(
			PROJECT_APP_TRANSLATIONS.fr["projects.agentClassResetInProgress"],
		).toBe(PROJECT_APP_TRANSLATIONS.en["projects.agentClassResetInProgress"]);

		const classProject = makeProject("reset-race", "naia-pj-adk", {
			name: "Reset Race Class",
			codingApp: "opencode",
			class: { baselineRef: "1234567890abcdef" },
		});
		let resolveReset: (value: unknown) => void = () => {};
		let startCallCount = 0;

		vi.mocked(invoke).mockImplementation(async (command) => {
			if (command === "projects_scan_adk") {
				return { ...readyCatalog, projects: [classProject] };
			}
			if (command === "project_agent_availability") {
				return ["claude", "codex", "muse", "opencode"].map((appId) => ({
					appId,
					available: true,
				}));
			}
			if (command === "project_agent_pty_start") {
				startCallCount += 1;
				throw new Error("class_reset_in_progress");
			}
			if (command === "project_class_reset") {
				return await new Promise((resolve) => {
					resolveReset = resolve;
				});
			}
			return null;
		});

		render(<ProjectsApp />);
		fireEvent.click(
			await screen.findByRole("button", { name: /Reset Race Class/ }),
		);
		const startButton = await screen.findByRole("button", {
			name: "Start OpenCode",
		});
		expect((startButton as HTMLButtonElement).disabled).toBe(false);

		fireEvent.click(screen.getByRole("button", { name: "Reset class" }));
		fireEvent.click(screen.getByRole("button", { name: "Reset" }));

		expect(await screen.findByText("Resetting class checkout…")).toBeTruthy();
		const disabledStartButton = screen.getByRole("button", {
			name: "Start OpenCode",
		}) as HTMLButtonElement;
		expect(disabledStartButton.disabled).toBe(true);
		const fieldset = document.querySelector(
			".projects-app__agent-options",
		) as HTMLFieldSetElement | null;
		expect(fieldset?.disabled).toBe(true);

		fireEvent.click(disabledStartButton);
		expect(startCallCount).toBe(0);

		resolveReset({
			backupRelativePath: "class-backups/reset-race-20261025-170000",
			backedUpFiles: 1,
			deletedFiles: 0,
		});
		expect(
			await screen.findByText(/Class checkout reset complete/),
		).toBeTruthy();
		expect(
			(
				screen.getByRole("button", {
					name: "Start OpenCode",
				}) as HTMLButtonElement
			).disabled,
		).toBe(false);

		// Verify backend class_reset_in_progress error is surfaced in UI when returned by start
		fireEvent.click(screen.getByRole("button", { name: "Start OpenCode" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			PROJECT_APP_TRANSLATIONS.en["projects.agentClassResetInProgress"],
		);
	});
});
