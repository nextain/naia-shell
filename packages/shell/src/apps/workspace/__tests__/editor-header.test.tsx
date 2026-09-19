// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Editor } from "../Editor";

const mockInvoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
	invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("../../../lib/i18n", () => ({
	t: (key: string) => key,
}));

describe("Editor Header UX (#678)", () => {
	it("displays the full file path and title tooltip in the header", async () => {
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "workspace_read_file") {
				return Promise.resolve("console.log('hello');");
			}
			return Promise.resolve();
		});

		const testPath = "/var/home/luke/project/packages/shell/src/index.ts";
		render(<Editor filePath={testPath} />);

		await waitFor(() => {
			const filenameSpan = screen.getByTitle(testPath);
			expect(filenameSpan).toBeInTheDocument();
			expect(filenameSpan).toHaveClass("workspace-editor__filename");
			expect(filenameSpan).toHaveTextContent(testPath);
		});
	});

	it("displays full file path in the load error state header", async () => {
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "workspace_read_file") {
				return Promise.reject(new Error("File not found"));
			}
			return Promise.resolve();
		});

		const testPath = "/var/home/luke/project/missing-file.ts";
		render(<Editor filePath={testPath} />);

		await waitFor(() => {
			const filenameSpan = screen.getByTitle(testPath);
			expect(filenameSpan).toBeInTheDocument();
			expect(filenameSpan).toHaveClass("workspace-editor__filename");
			expect(filenameSpan).toHaveTextContent(testPath);
		});
	});
});
