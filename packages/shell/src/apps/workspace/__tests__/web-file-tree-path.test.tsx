// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { HerdrWorkspaceRail } from "../HerdrWorkspaceRail";

vi.mock("../../../lib/adk-store", () => ({
	getAdkPath: () => "/workspace/adk",
}));
vi.mock("../FileTree", () => ({ FileTree: () => null }));
vi.mock("../WorkspaceContextApp", () => ({ WorkspaceContextApp: () => null }));

afterEach(() => {
	cleanup();
	Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

function rail() {
	return (
		<HerdrWorkspaceRail
			workspaceRoot=""
			openFilePath=""
			classifiedDirs={null}
			fileTreeRegionRef={createRef<HTMLDivElement>()}
			snapshot={null}
			onFileSelect={vi.fn()}
			onSendToNaia={vi.fn()}
			onShowHerdr={vi.fn()}
			onFocusWorkspace={vi.fn()}
			onFocusAgent={vi.fn()}
		/>
	);
}

it("reveals the selected ADK path when the browser file-tree heading is clicked", () => {
	render(rail());
	const heading = screen.getByRole("button", { name: "File Tree" });
	expect(screen.queryByText("/workspace/adk")).not.toBeInTheDocument();
	fireEvent.click(heading);
	expect(heading).toHaveAttribute("aria-expanded", "true");
	expect(screen.getByText("/workspace/adk")).toBeInTheDocument();
	fireEvent.click(heading);
	expect(screen.queryByText("/workspace/adk")).not.toBeInTheDocument();
});

it("preserves the non-interactive desktop heading", () => {
	Object.defineProperty(window, "__TAURI_INTERNALS__", {
		value: {},
		configurable: true,
	});
	render(rail());
	expect(
		screen.queryByRole("button", { name: "File Tree" }),
	).not.toBeInTheDocument();
});
