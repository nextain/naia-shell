import { afterEach, describe, expect, it, vi } from "vitest";
import { getWebWorkspaceFile } from "../web-workspace-files";

afterEach(() => vi.unstubAllGlobals());

describe("browser workspace file access", () => {
	it("reads only an ADK file through its directory handles", async () => {
		const file = new File(["hello"], "test.txt");
		const nested = {
			getFileHandle: vi.fn().mockResolvedValue({ getFile: async () => file }),
		};
		const adk = { getDirectoryHandle: vi.fn().mockResolvedValue(nested) };
		const root = { getDirectoryHandle: vi.fn().mockResolvedValue(adk) };
		vi.stubGlobal("navigator", { storage: { getDirectory: async () => root } });
		expect(await getWebWorkspaceFile("opfs://naia-adk/docs/test.txt")).toBe(
			file,
		);
		expect(root.getDirectoryHandle).toHaveBeenCalledWith("naia-adk");
		expect(adk.getDirectoryHandle).toHaveBeenCalledWith("docs");
	});

	it.each([
		"/etc/passwd",
		"opfs://naia-adk/../secret",
		"opfs://naia-adk/a//b",
		"opfs://naia-adk/a\\b",
	])("rejects escaping paths: %s", async (path) => {
		await expect(getWebWorkspaceFile(path)).rejects.toThrow(
			"web_workspace_invalid_path",
		);
	});
});
