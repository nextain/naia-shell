// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockInvoke, mockUnlisten, scrollIntoView } = vi.hoisted(() => ({
	mockInvoke: vi.fn(),
	mockUnlisten: vi.fn(),
	scrollIntoView: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
	invoke: (...args: unknown[]) => mockInvoke(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn().mockResolvedValue(mockUnlisten),
}));
vi.mock("../../../lib/logger", () => ({
	Logger: { info: vi.fn(), warn: vi.fn() },
}));

import { getLocale, setLocale } from "../../../lib/i18n";
import { FileTree, isUnresolvedTemplateEntry } from "../FileTree";

describe("FileTree open-file reveal", () => {
	let previousLocale = getLocale();

	beforeEach(async () => {
		previousLocale = getLocale();
		await setLocale("en");
	});

	afterEach(async () => {
		cleanup();
		mockInvoke.mockReset();
		mockUnlisten.mockReset();
		scrollIntoView.mockReset();
		await setLocale(previousLocale);
	});

	it("recursively expands ancestors, selects the file, and scrolls it into view", async () => {
		Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
			configurable: true,
			value: scrollIntoView,
		});
		mockInvoke.mockImplementation(
			async (command: string, args?: Record<string, unknown>) => {
				if (command !== "workspace_list_dirs") return null;
				if (args?.parent === "/work/naia") {
					return [{ name: "src", path: "/work/naia/src", is_dir: true }];
				}
				if (args?.parent === "/work/naia/src") {
					return [
						{ name: "nested", path: "/work/naia/src/nested", is_dir: true },
					];
				}
				if (args?.parent === "/work/naia/src/nested") {
					return [
						{
							name: "App.tsx",
							path: "/work/naia/src/nested/App.tsx",
							is_dir: false,
						},
					];
				}
				return [];
			},
		);

		render(
			<FileTree
				workspaceRoot="/work/naia"
				openFilePath="/work/naia/src/nested/App.tsx"
				onFileSelect={vi.fn()}
			/>,
		);

		const file = await screen.findByRole("button", { name: /App\.tsx/ });
		expect(file).toHaveClass("workspace-tree__node--open");
		await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
		expect(mockInvoke).toHaveBeenCalledWith("workspace_list_dirs", {
			parent: "/work/naia/src",
		});
		expect(mockInvoke).toHaveBeenCalledWith("workspace_list_dirs", {
			parent: "/work/naia/src/nested",
		});
	});

	it("renders context-menu copy actions in the selected locale", async () => {
		await setLocale("ko");
		mockInvoke.mockResolvedValue([
			{ name: "README.md", path: "/work/naia/README.md", is_dir: false },
		]);

		render(<FileTree workspaceRoot="/work/naia" onFileSelect={vi.fn()} />);
		const file = await screen.findByRole("button", { name: /README\.md/ });
		file.dispatchEvent(
			new MouseEvent("contextmenu", {
				bubbles: true,
				clientX: 10,
				clientY: 10,
			}),
		);

		expect(await screen.findByText("상대 경로 복사")).toBeInTheDocument();
		expect(screen.getByText("절대 경로 복사")).toBeInTheDocument();
	});

	it("hides unresolved root template entries without hiding valid names", async () => {
		expect(isUnresolvedTemplateEntry("${backup_dir}")).toBe(true);
		expect(isUnresolvedTemplateEntry("${WORKSPACE2}")).toBe(true);
		expect(isUnresolvedTemplateEntry("project-${name}")).toBe(false);
		expect(isUnresolvedTemplateEntry("${project-name}")).toBe(false);

		mockInvoke.mockResolvedValue([
			{ name: "${backup_dir}", path: "/work/naia/${backup_dir}", is_dir: true },
			{ name: "alpha-adk", path: "/work/naia/alpha-adk", is_dir: true },
		]);

		render(<FileTree workspaceRoot="/work/naia" onFileSelect={vi.fn()} />);
		expect(await screen.findByText("alpha-adk")).toBeInTheDocument();
		expect(screen.queryByText("${backup_dir}")).not.toBeInTheDocument();
	});

	it("displays external file indicator when open file is outside workspaceRoot and does not auto-expand internal tree", async () => {
		mockInvoke.mockResolvedValue([
			{ name: "src", path: "/work/naia/src", is_dir: true },
		]);

		const onSelect = vi.fn();
		render(
			<FileTree
				workspaceRoot="/work/naia"
				openFilePath="/var/external/outside.md"
				onFileSelect={onSelect}
			/>,
		);

		expect(
			await screen.findByTestId("workspace-tree-external-file"),
		).toBeInTheDocument();
		expect(screen.getByText("외부 파일")).toBeInTheDocument();
		expect(screen.getByText("outside.md")).toBeInTheDocument();

		// Clicking the external file triggers onFileSelect
		screen.getByText("outside.md").click();
		expect(onSelect).toHaveBeenCalledWith("/var/external/outside.md");

		// Does not attempt to recursively list internal directories for external path
		expect(mockInvoke).not.toHaveBeenCalledWith("workspace_list_dirs", {
			parent: "/work/naia/src",
		});
	});
});
