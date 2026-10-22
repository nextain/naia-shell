import { describe, expect, it } from "vitest";
import { setLocale } from "../../i18n";
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

		const inStorage = await fs.readText("naia-adk/naia-settings/config.json");
		expect(inStorage).not.toBeNull();
		const parsedInStorage = JSON.parse(inStorage as string);
		// WO-03: 초기 config는 번들 아바타·배경 기본값을 함께 seed한다 (리터럴 고정).
		const expectedConfig = {
			provider: "webllm",
			model: "Qwen3-4B-q4f16_1-MLC",
			agentName: "Naia",
			speechStyle: "casual",
			persona: "You are Naia, an AI companion. Speak casually and warmly.",
			onboardingComplete: true,
			avatarProvider: "vrm",
			vrmModel: "/avatars/03-OL_Woman.vrm",
			backgroundVideo: "ol-woman-dusk.webp",
			NAIA_LOCALE: "en",
		};
		expect(INITIAL_WEB_WORKSPACE_CONFIG).toMatchObject({
			avatarProvider: "vrm",
			vrmModel: "/avatars/03-OL_Woman.vrm",
			backgroundVideo: "ol-woman-dusk.webp",
		});
		expect(parsedInStorage).toEqual(expectedConfig);
		expect(JSON.parse(first)).toEqual(expectedConfig);

		const second = (await handleWebWorkspaceCommand(
			"read_naia_config",
			{ adkPath: "opfs://naia-adk" },
			fs,
		)) as string;
		expect(JSON.parse(second)).toEqual(expectedConfig);
	});

	it("rejects read_naia_config when initial config writeBytes fails", async () => {
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

		await expect(
			handleWebWorkspaceCommand(
				"read_naia_config",
				{ adkPath: "opfs://naia-adk" },
				failingFs,
			),
		).rejects.toThrow("Disk full or permission denied");
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

	it("WO13C-S1 initial-config-locale", async () => {
		try {
			await setLocale("ko");
			const fs = createMemoryWebFs();
			const result = (await handleWebWorkspaceCommand(
				"read_naia_config",
				{ adkPath: "opfs://naia-adk" },
				fs,
			)) as string;

			const expectedConfig = {
				provider: "webllm",
				model: "Qwen3-4B-q4f16_1-MLC",
				agentName: "Naia",
				speechStyle: "casual",
				persona: "You are Naia, an AI companion. Speak casually and warmly.",
				onboardingComplete: true,
				avatarProvider: "vrm",
				vrmModel: "/avatars/03-OL_Woman.vrm",
				backgroundVideo: "ol-woman-dusk.webp",
				NAIA_LOCALE: "ko",
			};
			expect(JSON.parse(result)).toEqual(expectedConfig);

			const inStorage = await fs.readText("naia-adk/naia-settings/config.json");
			expect(JSON.parse(inStorage as string)).toEqual(expectedConfig);
		} finally {
			await setLocale("en");
		}
	});

	it("WO13C-S2 existing-config-untouched", async () => {
		const fs = createMemoryWebFs();
		const rawConfig = JSON.stringify({
			provider: "webllm",
			model: "Qwen3-4B-q4f16_1-MLC",
			agentName: "ExistingNaia",
		});
		await fs.writeBytes("naia-adk/naia-settings/config.json", rawConfig);

		const result = (await handleWebWorkspaceCommand(
			"read_naia_config",
			{ adkPath: "opfs://naia-adk" },
			fs,
		)) as string;

		expect(result).toBe(rawConfig);
		const inStorage = await fs.readText("naia-adk/naia-settings/config.json");
		expect(inStorage).toBe(rawConfig);
	});
});
