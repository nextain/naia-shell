// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
	invoke: (...args: unknown[]) => mockInvoke(...args),
}));

import { QuickOpen } from "../workspace/QuickOpen";

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

const FAKE_FILES = [
	{
		name: "App.tsx",
		path: "/dev/project/src/App.tsx",
		is_dir: false,
		children: null,
	},
	{
		name: "Editor.tsx",
		path: "/dev/project/src/Editor.tsx",
		is_dir: false,
		children: null,
	},
	{
		name: "index.ts",
		path: "/dev/project/src/index.ts",
		is_dir: false,
		children: null,
	},
	{
		name: "utils",
		path: "/dev/project/src/utils",
		is_dir: true,
		children: null,
	},
];

const FAKE_UTILS_FILES = [
	{
		name: "helper.ts",
		path: "/dev/project/src/utils/helper.ts",
		is_dir: false,
		children: null,
	},
];

describe("QuickOpen", () => {
	it("renders input and file list", async () => {
		mockInvoke.mockImplementation((_cmd: string, args: { parent: string }) => {
			if (args.parent === "/dev/project") return Promise.resolve(FAKE_FILES);
			if (args.parent === "/dev/project/src/utils")
				return Promise.resolve(FAKE_UTILS_FILES);
			return Promise.resolve([]);
		});

		const onSelect = vi.fn();
		const onClose = vi.fn();
		render(
			<QuickOpen
				workspaceRoot="/dev/project"
				onSelect={onSelect}
				onClose={onClose}
			/>,
		);

		// Input is rendered
		expect(screen.getByPlaceholderText(/파일 이름/)).toBeInTheDocument();

		// Files should appear after loading
		await waitFor(() => {
			expect(screen.getByText("App.tsx")).toBeInTheDocument();
		});
	});

	it("filters files by query", async () => {
		mockInvoke.mockImplementation((_cmd: string, args: { parent: string }) => {
			if (args.parent === "/dev/project") return Promise.resolve(FAKE_FILES);
			if (args.parent === "/dev/project/src/utils")
				return Promise.resolve(FAKE_UTILS_FILES);
			return Promise.resolve([]);
		});

		render(
			<QuickOpen
				workspaceRoot="/dev/project"
				onSelect={vi.fn()}
				onClose={vi.fn()}
			/>,
		);
		await waitFor(() =>
			expect(screen.getByText("App.tsx")).toBeInTheDocument(),
		);

		const input = screen.getByPlaceholderText(/파일 이름/);
		fireEvent.change(input, { target: { value: "edit" } });

		// Only Editor.tsx should match
		expect(screen.getByText("Editor.tsx")).toBeInTheDocument();
		expect(screen.queryByText("App.tsx")).not.toBeInTheDocument();
	});

	it("calls onSelect and onClose when Enter is pressed", async () => {
		mockInvoke.mockResolvedValue(FAKE_FILES.filter((f) => !f.is_dir));

		const onSelect = vi.fn();
		const onClose = vi.fn();
		render(
			<QuickOpen
				workspaceRoot="/dev/project"
				onSelect={onSelect}
				onClose={onClose}
			/>,
		);
		await waitFor(() =>
			expect(screen.getByText("App.tsx")).toBeInTheDocument(),
		);

		const input = screen.getByPlaceholderText(/파일 이름/);
		fireEvent.keyDown(input, { key: "Enter" });

		expect(onSelect).toHaveBeenCalled();
		expect(onClose).toHaveBeenCalled();
	});

	it("calls onClose when Escape is pressed", async () => {
		mockInvoke.mockResolvedValue([]);

		const onClose = vi.fn();
		render(
			<QuickOpen
				workspaceRoot="/dev/project"
				onSelect={vi.fn()}
				onClose={onClose}
			/>,
		);

		const input = screen.getByPlaceholderText(/파일 이름/);
		fireEvent.keyDown(input, { key: "Escape" });

		expect(onClose).toHaveBeenCalled();
	});

	it("navigates with ArrowDown/ArrowUp", async () => {
		mockInvoke.mockResolvedValue(FAKE_FILES.filter((f) => !f.is_dir));

		render(
			<QuickOpen
				workspaceRoot="/dev/project"
				onSelect={vi.fn()}
				onClose={vi.fn()}
			/>,
		);
		await waitFor(() =>
			expect(screen.getByText("App.tsx")).toBeInTheDocument(),
		);

		const input = screen.getByPlaceholderText(/파일 이름/);

		// First item is selected by default
		expect(
			document.querySelector(".quick-open__item--selected"),
		).toHaveTextContent("App.tsx");

		// ArrowDown → select second item
		fireEvent.keyDown(input, { key: "ArrowDown" });
		expect(
			document.querySelector(".quick-open__item--selected"),
		).toHaveTextContent("Editor.tsx");

		// ArrowUp → back to first
		fireEvent.keyDown(input, { key: "ArrowUp" });
		expect(
			document.querySelector(".quick-open__item--selected"),
		).toHaveTextContent("App.tsx");
	});

	it("shows empty message when no matches", async () => {
		mockInvoke.mockResolvedValue(FAKE_FILES.filter((f) => !f.is_dir));

		render(
			<QuickOpen
				workspaceRoot="/dev/project"
				onSelect={vi.fn()}
				onClose={vi.fn()}
			/>,
		);
		await waitFor(() =>
			expect(screen.getByText("App.tsx")).toBeInTheDocument(),
		);

		const input = screen.getByPlaceholderText(/파일 이름/);
		fireEvent.change(input, { target: { value: "zzzznoexist" } });

		expect(screen.getByText("일치하는 파일이 없습니다")).toBeInTheDocument();
	});
});
