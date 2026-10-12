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
import { appRegistry } from "../../../lib/app-registry";
import { setLocale } from "../../../lib/i18n";
import { ProjectsApp } from "../ProjectsApp";
import { PROJECT_APP_TRANSLATIONS } from "../translations";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
	open: vi.fn(async () => "/selected/naia-pj-adk"),
}));

const readyCatalog = {
	projects: [
		{
			directoryName: "naia-shell",
			projectId: "naia-shell",
			name: "Naia Shell",
			repository: "nextain/naia-shell",
			issueTracker: "github",
			profile: "server",
			configErrors: [],
		},
	],
};

describe("ProjectsApp — F-01", () => {
	afterEach(cleanup);

	beforeEach(async () => {
		vi.clearAllMocks();
		await setLocale("en");
		vi.mocked(invoke).mockImplementation(async (command) => {
			if (command === "projects_scan_checkout") return readyCatalog;
			return null;
		});
	});

	it("registers a built-in keep-alive app without replacing existing app registrations", async () => {
		const { useAppStore } = await import("../../../stores/app");
		const appListVersion = useAppStore.getState().appListVersion;
		await import("../index");
		expect(appRegistry.get("projects")?.builtIn).toBe(true);
		expect(appRegistry.get("projects")?.keepAlive).toBe(true);
		expect(appRegistry.get("projects")?.deferMountUntilActive).toBe(true);
		expect(appRegistry.get("projects")?.id).toBe("projects");
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

	it("shows a loading state, opens a selected project, and keeps its title across all three views", async () => {
		let finishScan: ((value: typeof readyCatalog) => void) | undefined;
		vi.mocked(invoke).mockImplementation(async (command) => {
			if (command === "projects_scan_checkout") {
				return new Promise((resolve) => {
					finishScan = resolve;
				});
			}
			return null;
		});
		render(<ProjectsApp />);
		fireEvent.click(screen.getByRole("button", { name: "Choose checkout" }));
		expect(
			await screen.findByText("Reading projects and configuration…"),
		).toBeTruthy();
		finishScan?.(readyCatalog);

		const projectButton = await screen.findByRole("button", {
			name: /Naia Shell/,
		});
		fireEvent.click(projectButton);
		expect(
			screen.getByRole("heading", { name: "Naia Shell", level: 1 }),
		).toBeTruthy();
		for (const label of ["Coding Agent", "Dashboard", "Internal Issues"]) {
			const tab = screen.getByRole("tab", { name: label });
			fireEvent.click(tab);
			expect(tab.getAttribute("aria-selected")).toBe("true");
			expect(
				screen.getByRole("heading", { name: "Naia Shell", level: 1 }),
			).toBeTruthy();
			expect(screen.getByRole("tabpanel").textContent).toContain(
				"stage 1 placeholder",
			);
		}
		expect(invoke).toHaveBeenCalledWith("projects_scan_checkout", {
			checkoutPath: "/selected/naia-pj-adk",
		});
	});

	it("supports arrow and boundary-key navigation between accessible tabs", async () => {
		render(<ProjectsApp />);
		fireEvent.click(screen.getByRole("button", { name: "Choose checkout" }));
		fireEvent.click(await screen.findByRole("button", { name: /Naia Shell/ }));
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

	it("shows an empty catalog and a next action", async () => {
		vi.mocked(invoke).mockImplementation(async (command) =>
			command === "projects_scan_checkout" ? { projects: [] } : null,
		);
		render(<ProjectsApp />);
		fireEvent.click(screen.getByRole("button", { name: "Choose checkout" }));
		expect(await screen.findByText("No projects found")).toBeTruthy();
		expect(screen.getByText(/Check the checkout's projects\//)).toBeTruthy();
	});

	it("shows scan limits as an informational notice with cutoff evidence", async () => {
		vi.mocked(invoke).mockImplementation(async (command) =>
			command === "projects_scan_checkout"
				? {
						...readyCatalog,
						truncation: {
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
						},
					}
				: null,
		);
		render(<ProjectsApp />);
		fireEvent.click(screen.getByRole("button", { name: "Choose checkout" }));

		const notice = await screen.findByRole("status", {
			name: "Some project details were skipped",
		});
		expect(notice.textContent).toContain("200 of 200 project entries");
		expect(notice.textContent).toContain("projects/large/project.yaml");
		expect(notice.textContent).toContain("65537 bytes");
		expect(screen.queryByRole("alert")).toBeNull();
		expect(
			screen.getByRole("heading", { name: "Select a project" }),
		).toBeTruthy();
	});

	it("does not open a project with configuration errors and tells the user what to fix", async () => {
		vi.mocked(invoke).mockImplementation(async (command) => {
			if (command !== "projects_scan_checkout") return null;
			return {
				projects: [
					{
						directoryName: "broken",
						projectId: "broken",
						name: "Broken Project",
						repository: null,
						issueTracker: null,
						profile: "local",
						configErrors: [
							{
								file: "profiles/local/workspace/repos.json",
								reason: "invalid_json",
							},
						],
					},
				],
			};
		});
		render(<ProjectsApp />);
		fireEvent.click(screen.getByRole("button", { name: "Choose checkout" }));
		expect(
			await screen.findByText(
				"This project has a configuration problem and cannot be opened.",
			),
		).toBeTruthy();
		expect(
			screen.getByText("profiles/local/workspace/repos.json"),
		).toBeTruthy();
		expect(screen.getByText(/Check the listed file/)).toBeTruthy();
		expect(
			screen.getAllByRole("heading", { name: "Select a project" }),
		).toHaveLength(1);
	});

	it("shows a recoverable checkout error and retries with a newly selected folder", async () => {
		let scans = 0;
		vi.mocked(invoke).mockImplementation(async (command) => {
			if (command !== "projects_scan_checkout") return null;
			scans += 1;
			if (scans === 1) throw new Error("unreadable");
			return readyCatalog;
		});
		const { open } = await import("@tauri-apps/plugin-dialog");
		vi.mocked(open)
			.mockResolvedValueOnce("/bad/checkout")
			.mockResolvedValueOnce("/next/checkout");
		render(<ProjectsApp />);
		fireEvent.click(screen.getByRole("button", { name: "Choose checkout" }));
		expect(await screen.findByRole("alert")).toBeTruthy();
		fireEvent.click(
			screen.getByRole("button", { name: "Choose another checkout" }),
		);
		await waitFor(() => expect(screen.getByText("checkout")).toBeTruthy());
		expect(
			await screen.findByRole("button", { name: /Naia Shell/ }),
		).toBeTruthy();
	});
});
