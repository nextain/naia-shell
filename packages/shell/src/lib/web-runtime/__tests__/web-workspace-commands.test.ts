import { describe, expect, it } from "vitest";
import { createMemoryWebFs, type WebFs } from "../web-fs";
import {
	handleWebWorkspaceCommand,
	INITIAL_WEB_WORKSPACE_CONFIG,
} from "../web-workspace-commands";

describe("web-workspace-commands", () => {
	it("read_naia_config writes initial config on first read and returns identical string on second read", async () => {
		const fs = createMemoryWebFs();
		const first = (await handleWebWorkspaceCommand(
			"read_naia_config",
			{ adkPath: "opfs://naia-adk" },
			fs,
		)) as string;

		const expected = JSON.stringify(INITIAL_WEB_WORKSPACE_CONFIG, null, 2);
		expect(first).toBe(expected);

		const inStorage = await fs.readText("naia-adk/naia-settings/config.json");
		expect(inStorage).toBe(expected);

		const second = (await handleWebWorkspaceCommand(
			"read_naia_config",
			{ adkPath: "opfs://naia-adk" },
			fs,
		)) as string;
		expect(second).toBe(expected);
	});

	it("write_naia_config roundtrips valid JSON configuration", async () => {
		const fs = createMemoryWebFs();
		const customConfig = {
			...INITIAL_WEB_WORKSPACE_CONFIG,
			agentName: "CustomNaia",
		};
		const customJson = JSON.stringify(customConfig, null, 2);

		const writeRes = await handleWebWorkspaceCommand(
			"write_naia_config",
			{ adkPath: "opfs://naia-adk", json: customJson },
			fs,
		);
		expect(writeRes).toBeNull();

		const readRes = await handleWebWorkspaceCommand(
			"read_naia_config",
			{ adkPath: "opfs://naia-adk" },
			fs,
		);
		expect(readRes).toBe(customJson);
	});

	it("rejects invalid JSON with naia_config_invalid_json for '{', '[]', and '1'", async () => {
		const fs = createMemoryWebFs();

		for (const invalid of ["{", "[]", "1"]) {
			await expect(
				handleWebWorkspaceCommand(
					"write_naia_config",
					{ adkPath: "opfs://naia-adk", json: invalid },
					fs,
				),
			).rejects.toThrow("naia_config_invalid_json");

			await expect(
				handleWebWorkspaceCommand(
					"write_naia_ui_config",
					{ adkPath: "opfs://naia-adk", json: invalid },
					fs,
				),
			).rejects.toThrow("naia_config_invalid_json");
		}
	});

	it("throws naia_config_write_failed when file writing fails", async () => {
		const failingFs: WebFs = {
			async readText() {
				return null;
			},
			async writeBytes() {
				throw new Error("Disk full or permission denied");
			},
			async exists() {
				return false;
			},
			async ensureDir() {},
		};

		const validJson = JSON.stringify({ key: "value" });
		await expect(
			handleWebWorkspaceCommand(
				"write_naia_config",
				{ adkPath: "opfs://naia-adk", json: validJson },
				failingFs,
			),
		).rejects.toThrow("naia_config_write_failed");

		await expect(
			handleWebWorkspaceCommand(
				"write_naia_ui_config",
				{ adkPath: "opfs://naia-adk", json: validJson },
				failingFs,
			),
		).rejects.toThrow("naia_config_write_failed");
	});

	it("read_naia_ui_config returns empty string when file is absent", async () => {
		const fs = createMemoryWebFs();
		const res = await handleWebWorkspaceCommand(
			"read_naia_ui_config",
			{ adkPath: "opfs://naia-adk" },
			fs,
		);
		expect(res).toBe("");
	});

	it("rejects path mismatch for all five path-bearing commands", async () => {
		const fs = createMemoryWebFs();
		const mismatchPath = "/unsupported/path";
		const validJson = JSON.stringify({ test: 1 });

		const commands = [
			{ cmd: "read_naia_config", args: { adkPath: mismatchPath } },
			{
				cmd: "write_naia_config",
				args: { adkPath: mismatchPath, json: validJson },
			},
			{ cmd: "read_naia_ui_config", args: { adkPath: mismatchPath } },
			{
				cmd: "write_naia_ui_config",
				args: { adkPath: mismatchPath, json: validJson },
			},
			{ cmd: "write_naia_path_cache", args: { adkPath: mismatchPath } },
		];

		for (const { cmd, args } of commands) {
			await expect(
				handleWebWorkspaceCommand(cmd, args, fs),
			).rejects.toThrow(`web_adk_path_mismatch:${mismatchPath}`);
		}
	});

	it("rejects empty adkPath in write_naia_path_cache with 'adk_path is empty'", async () => {
		const fs = createMemoryWebFs();
		await expect(
			handleWebWorkspaceCommand(
				"write_naia_path_cache",
				{ adkPath: "" },
				fs,
			),
		).rejects.toThrow("adk_path is empty");
	});

	it("succeeds with null for valid write_naia_path_cache", async () => {
		const fs = createMemoryWebFs();
		const res = await handleWebWorkspaceCommand(
			"write_naia_path_cache",
			{ adkPath: "opfs://naia-adk" },
			fs,
		);
		expect(res).toBeNull();
	});

	it("returns agent-unavailable structure for reload_agent_settings without arguments", async () => {
		const fs = createMemoryWebFs();
		const res = await handleWebWorkspaceCommand(
			"reload_agent_settings",
			undefined,
			fs,
		);
		expect(res).toEqual({
			available: false,
			memoryReloaded: false,
			memoryRetained: false,
			memoryStatus: "next_start",
		});
	});

	it("rejects invalid arguments structure with web_invalid_args", async () => {
		const fs = createMemoryWebFs();
		await expect(
			handleWebWorkspaceCommand("read_naia_config", null, fs),
		).rejects.toThrow("web_invalid_args:read_naia_config");

		await expect(
			handleWebWorkspaceCommand("read_naia_config", { adkPath: 123 }, fs),
		).rejects.toThrow("web_invalid_args:read_naia_config");
	});
});
