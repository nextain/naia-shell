// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppCenterProps } from "../../../lib/app-registry";
import { setLocale } from "../../../lib/i18n";
import { setWebAssetsModeForTests } from "../../../lib/web-runtime/web-assets";
import { getWebWorkspaceFile } from "../../../lib/web-runtime/web-workspace-files";
import WebWorkspace, { isVisibleWebWorkspaceEntry } from "../WebWorkspace";
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
			"AGENTS.md",
			"CLAUDE.md",
			"GEMINI.md",
			"README.md",
			"agents-rules-detail.json",
		]) {
			expect(isVisibleWebWorkspaceEntry(hidden, "opfs://naia-adk", true)).toBe(
				false,
			);
		}
		expect(
			isVisibleWebWorkspaceEntry("kiosk-demo", "opfs://naia-adk", true),
		).toBe(true);
		expect(
			isVisibleWebWorkspaceEntry("conversations", "opfs://naia-adk", true),
		).toBe(true);
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
			getWebWorkspaceFile("opfs://naia-adk/AGENTS.md"),
		).rejects.toThrow("web_workspace_invalid_path");

		render(<WebWorkspace />);
		expect(
			screen.getByTestId("web-workspace-tab-offline"),
		).toHaveTextContent("브라우저 안 오프라인 공간");
		expect(screen.queryByText(/온라인/)).toBeNull();

		const knowledgeTab = screen.getByTestId("web-workspace-tab-knowledge");
		expect(knowledgeTab).toHaveTextContent("지식");
		fireEvent.click(knowledgeTab);
		expect(
			screen.getByTestId("web-workspace-knowledge-list").querySelectorAll("li")
				.length,
		).toBe(21);
		expect(screen.getByTestId("web-workspace-resizer")).toBeInTheDocument();
		expect(screen.getByTestId("web-workspace-viewer")).toBeInTheDocument();
	});
});
