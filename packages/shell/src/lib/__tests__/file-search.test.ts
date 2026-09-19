import { describe, expect, it, vi, beforeEach } from "vitest";
import {
	collectFilesOnly,
	fuzzyMatch,
} from "../file-search";

const mockInvoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
	invoke: (...args: unknown[]) => mockInvoke(...args),
}));

describe("file-search", () => {
	beforeEach(() => {
		mockInvoke.mockReset();
	});

	it("collectFilesOnly invokes workspace_list_files_recursive first", async () => {
		mockInvoke.mockResolvedValueOnce([
			"/root/src/App.tsx",
			"/root/src/main.rs",
			"/root/package.json",
		]);

		const files = await collectFilesOnly("/root");
		expect(mockInvoke).toHaveBeenCalledWith("workspace_list_files_recursive", {
			parent: "/root",
		});
		expect(files).toEqual([
			"/root/src/App.tsx",
			"/root/src/main.rs",
			"/root/package.json",
		]);
	});

	it("collectFilesOnly falls back to workspace_list_dirs if recursive call fails", async () => {
		mockInvoke.mockImplementation((cmd: string, args: Record<string, unknown>) => {
			if (cmd === "workspace_list_files_recursive") {
				return Promise.reject(new Error("unsupported command"));
			}
			if (cmd === "workspace_list_dirs") {
				if (args.parent === "/root") {
					return Promise.resolve([
						{ name: "src", path: "/root/src", is_dir: true },
						{ name: "package.json", path: "/root/package.json", is_dir: false },
					]);
				}
				if (args.parent === "/root/src") {
					return Promise.resolve([
						{ name: "App.tsx", path: "/root/src/App.tsx", is_dir: false },
					]);
				}
			}
			return Promise.resolve([]);
		});

		const files = await collectFilesOnly("/root");
		expect(files).toContain("/root/package.json");
		expect(files).toContain("/root/src/App.tsx");
	});

	it("fuzzyMatch matches sub-sequences and handles choseong search", () => {
		expect(fuzzyMatch("apt", "App.tsx")).toBeGreaterThan(0);
		expect(fuzzyMatch("xyz", "App.tsx")).toBe(-1);

		// Korean choseong test
		expect(fuzzyMatch("ㅎㄱ", "한국어")).toBeGreaterThan(0);
		expect(fuzzyMatch("ㅂㄷ", "한국어")).toBe(-1);
	});
});
