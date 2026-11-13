// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppCenterProps } from "../../../lib/app-registry";
import { setLocale } from "../../../lib/i18n";
import { setWebAssetsModeForTests } from "../../../lib/web-runtime/web-assets";
import { getWebWorkspaceFile } from "../../../lib/web-runtime/web-workspace-files";
import WebWorkspace, {
	isVisibleWebWorkspaceEntry,
	sortWebWorkspaceEntries,
} from "../WebWorkspace";
import { DeferredHerdrWorkspaceCenterArea } from "../index";

describe("web workspace path", () => {
	afterEach(() => {
		cleanup();
		localStorage.removeItem("naia-adk-path");
		setWebAssetsModeForTests(null);
		vi.unstubAllEnvs();
	});

	it("shows the configured browser workspace path", () => {
		setWebAssetsModeForTests(true);
		localStorage.setItem("naia-adk-path", "opfs://naia-adk");
		render(<DeferredHerdrWorkspaceCenterArea {...({} as AppCenterProps)} />);
		expect(screen.getByTestId("web-workspace-path")).toHaveTextContent("opfs://naia-adk");
	});

	it("does not display a stale native path as a browser workspace", () => {
		setWebAssetsModeForTests(true);
		localStorage.setItem("naia-adk-path", "/native/stale");
		render(<DeferredHerdrWorkspaceCenterArea {...({} as AppCenterProps)} />);
		expect(screen.queryByTestId("web-workspace-path")).toBeNull();
	});

	it("FR-WEB-KIOSK-R3.5~8 removes online button, rewords offline label, filters internal ADK files, and exposes knowledge tab + resizer in kiosk mode", async () => {
		await setLocale("ko");
		vi.stubEnv("MODE", "web");
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "1");

		for (const hidden of [
			".agents",
			".users",
			"naia-settings",
			"projects",
			"CLAUDE.md",
			"GEMINI.md",
			"README.md",
			"agents-rules-detail.json",
		]) {
			expect(isVisibleWebWorkspaceEntry(hidden, "opfs://naia-adk", true)).toBe(
				false,
			);
		}
		for (const allowedRoot of [
			"AGENTS.md",
			"persona",
			"memory",
			"knowledge",
			"rules",
			"conversations",
			"kiosk-demo",
		]) {
			expect(
				isVisibleWebWorkspaceEntry(allowedRoot, "opfs://naia-adk", true),
			).toBe(true);
		}
		expect(
			sortWebWorkspaceEntries(
				[
					{ name: "rules", kind: "directory" },
					{ name: "knowledge", kind: "directory" },
					{ name: "AGENTS.md", kind: "file" },
					{ name: "memory", kind: "directory" },
					{ name: "persona", kind: "directory" },
				],
				"opfs://naia-adk",
				true,
			).map((e) => e.name),
		).toEqual(["AGENTS.md", "persona", "memory", "knowledge", "rules"]);
		expect(
			isVisibleWebWorkspaceEntry(
				"naia.md",
				"opfs://naia-adk/kiosk-demo/knowledge",
				true,
			),
		).toBe(true);

		await expect(
			getWebWorkspaceFile("opfs://naia-adk/.agents/context/agents-rules-detail.json"),
		).rejects.toThrow("web_workspace_invalid_path");
		await expect(
			getWebWorkspaceFile("opfs://naia-adk/CLAUDE.md"),
		).rejects.toThrow("web_workspace_invalid_path");

		render(<WebWorkspace />);
		expect(
			screen.getByTestId("web-workspace-tab-offline"),
		).toHaveTextContent("브라우저 안 오프라인 공간");
		expect(screen.queryByText(/온라인/)).toBeNull();

		// AGENTS.md is open by default in the viewer when WebWorkspace mounts in kiosk mode
		const viewerBefore = screen.getByTestId("web-workspace-viewer");
		expect(
			viewerBefore.querySelector(".web-workspace-viewer-bar code")?.textContent,
		).toBe("AGENTS.md");

		const knowledgeTab = screen.getByTestId("web-workspace-tab-knowledge");
		expect(knowledgeTab).toHaveTextContent("지식");
		fireEvent.click(knowledgeTab);
		expect(
			screen.getByTestId("web-workspace-knowledge-list").querySelectorAll("li")
				.length,
		).toBe(21);
		expect(screen.getByTestId("web-workspace-resizer")).toBeInTheDocument();
		const viewer = screen.getByTestId("web-workspace-viewer");
		expect(viewer).toBeInTheDocument();
		const barCode = viewer.querySelector(".web-workspace-viewer-bar code");
		expect(barCode?.textContent).toBe("adk.md");
		expect(barCode?.getAttribute("title")).toBe(
			"opfs://naia-adk/kiosk-demo/knowledge/adk.md",
		);
	});

	it("defaults file explorer to closed on mobile portrait and allows toggling open and closed", async () => {
		await setLocale("ko");
		vi.stubEnv("MODE", "web");
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "1");
		const origInnerWidth = window.innerWidth;
		const origInnerHeight = window.innerHeight;
		Object.defineProperty(window, "innerWidth", {
			configurable: true,
			value: 412,
		});
		Object.defineProperty(window, "innerHeight", {
			configurable: true,
			value: 915,
		});
		try {
			render(<WebWorkspace />);
			// Closed by default on mobile portrait when a file is open
			expect(screen.queryByTestId("web-workspace-tree")).toBeNull();
			const toggleBtn = screen.getByTestId("web-workspace-tree-toggle");
			expect(toggleBtn).toHaveAttribute("aria-expanded", "false");

			// Open file explorer
			fireEvent.click(toggleBtn);
			expect(screen.getByTestId("web-workspace-tree")).toBeInTheDocument();
			expect(toggleBtn).toHaveAttribute("aria-expanded", "true");

			// Collapse via tree header button
			fireEvent.click(screen.getByTestId("web-workspace-tree-collapse"));
			expect(screen.queryByTestId("web-workspace-tree")).toBeNull();
			expect(toggleBtn).toHaveAttribute("aria-expanded", "false");
		} finally {
			Object.defineProperty(window, "innerWidth", {
				configurable: true,
				value: origInnerWidth,
			});
			Object.defineProperty(window, "innerHeight", {
				configurable: true,
				value: origInnerHeight,
			});
		}
	});

	it("does not mutate layout storage keys when toggling explorer and closes explorer tree when switching to portrait orientation", async () => {
		await setLocale("ko");
		vi.stubEnv("MODE", "web");
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "1");

		localStorage.setItem("naia:layoutOrientation", "landscape");
		localStorage.setItem("naia:chatHeightRatio", "0.64");
		localStorage.setItem("naia:naiaWidth", "280");
		localStorage.setItem("naia:chatMode", "workspace");
		localStorage.setItem("naia:railCollapsed", "true");

		const { container } = render(<WebWorkspace />);
		const toggleBtn = screen.getByTestId("web-workspace-tree-toggle");

		// Toggle explorer closed then open on desktop landscape
		fireEvent.click(toggleBtn);
		expect(container.querySelector(".web-workspace--tree-closed")).not.toBeNull();
		fireEvent.click(toggleBtn);
		expect(container.querySelector(".web-workspace--tree-open")).not.toBeNull();

		// Switching orientation to portrait closes the explorer tree so the viewer fills 100%
		act(() => {
			window.dispatchEvent(
				new CustomEvent("naia:layout-orientation-change", {
					detail: "portrait",
				}),
			);
		});
		expect(screen.getByTestId("web-workspace-tree-toggle")).toHaveAttribute(
			"aria-expanded",
			"false",
		);
		expect(container.querySelector(".web-workspace--tree-closed")).not.toBeNull();

		// All user layout settings remain intact
		expect(localStorage.getItem("naia:layoutOrientation")).toBe("landscape");
		expect(localStorage.getItem("naia:chatHeightRatio")).toBe("0.64");
		expect(localStorage.getItem("naia:naiaWidth")).toBe("280");
		expect(localStorage.getItem("naia:chatMode")).toBe("workspace");
		expect(localStorage.getItem("naia:railCollapsed")).toBe("true");
	});
});
