// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "../../i18n";
import { setWebAssetsModeForTests } from "../web-assets";
import {
	completeWebNaiaLogin,
	logoutWebSession,
	setWebLoginRequiredForTests,
} from "../web-auth";
import { type WebFs, createMemoryWebFs } from "../web-fs";
import {
	INITIAL_WEB_WORKSPACE_CONFIG,
	appendWebConversationMessages,
	handleWebWorkspaceCommand,
	resolveWebConversationsDir,
	safeSessionBase,
} from "../web-workspace-commands";

afterEach(() => {
	setWebAssetsModeForTests(null);
	setWebLoginRequiredForTests(null);
	localStorage.clear();
	sessionStorage.clear();
});

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
			provider: "nextain",
			model: "gpt-6.1-terra",
			webAutoDefaultModel: true,
			agentName: "Naia",
			speechStyle: "casual",
			persona: "You are Naia, an AI companion. Speak casually and warmly.",
			onboardingComplete: true,
			avatarProvider: "naia-video-avatar",
			nvaModel: "naia",
			backgroundVideo: "naia-autumn-office-live.mp4",
			NAIA_LOCALE: "en",
		};
		expect(INITIAL_WEB_WORKSPACE_CONFIG).toMatchObject({
			avatarProvider: "naia-video-avatar",
			nvaModel: "naia",
			backgroundVideo: "naia-autumn-office-live.mp4",
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
			async listEntries() {
				return [];
			},
			async removeFile() {},
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
			async listEntries() {
				return [];
			},
			async removeFile() {},
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
			await expect(handleWebWorkspaceCommand(cmd, args, fs)).rejects.toThrow(
				`web_adk_path_mismatch:${mismatchPath}`,
			);
		}
	});

	it("rejects empty adkPath in write_naia_path_cache with 'adk_path is empty'", async () => {
		const fs = createMemoryWebFs();
		await expect(
			handleWebWorkspaceCommand("write_naia_path_cache", { adkPath: "" }, fs),
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
				provider: "nextain",
				model: "gpt-6.1-terra",
			webAutoDefaultModel: true,
				agentName: "Naia",
				speechStyle: "casual",
				persona: "You are Naia, an AI companion. Speak casually and warmly.",
				onboardingComplete: true,
				avatarProvider: "naia-video-avatar",
				nvaModel: "naia",
				backgroundVideo: "naia-autumn-office-live.mp4",
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

	it("migrates retired face-crop background filenames in read_naia_config and read_naia_ui_config", async () => {
		const fs = createMemoryWebFs();
		await fs.writeBytes(
			"naia-adk/naia-settings/config.json",
			JSON.stringify({
				provider: "webllm",
				backgroundVideo: "ol-woman-dusk.webp",
			}),
		);
		await fs.writeBytes(
			"naia-adk/naia-settings/ui-config.json",
			JSON.stringify({
				backgroundVideo: "shino-uniform-dusk.webp",
			}),
		);

		const cfgRaw = (await handleWebWorkspaceCommand(
			"read_naia_config",
			{ adkPath: "opfs://naia-adk" },
			fs,
		)) as string;
		expect(JSON.parse(cfgRaw).backgroundVideo).toBe(
			"naia-autumn-office-live.mp4",
		);

		const uiRaw = (await handleWebWorkspaceCommand(
			"read_naia_ui_config",
			{ adkPath: "opfs://naia-adk" },
			fs,
		)) as string;
		expect(JSON.parse(uiRaw).backgroundVideo).toBe(
			"naia-autumn-office-live.mp4",
		);
	});

	it("persists, lists, reads, and deletes web conversations in OPFS JSONL format", async () => {
		const fs = createMemoryWebFs();

		await appendWebConversationMessages(
			"session_alpha",
			[
				{
					role: "user",
					content: "첫 번째 질문입니다",
					timestamp: 1700000001000,
				},
				{
					role: "assistant",
					content: "첫 번째 답변입니다",
					timestamp: 1700000002000,
				},
			],
			fs,
		);
		await appendWebConversationMessages(
			"session_beta",
			[
				{
					role: "user",
					content: "두 번째 대화 제목",
					timestamp: 1700000003000,
				},
				{
					role: "assistant",
					content: "두 번째 답변",
					timestamp: 1700000004000,
				},
			],
			fs,
		);

		const listRaw = (await handleWebWorkspaceCommand(
			"list_conversations",
			{ adkPath: "opfs://naia-adk" },
			fs,
		)) as string;
		const parsedList = JSON.parse(listRaw) as {
			sessions: Array<{
				key: string;
				label: string;
				messageCount: number;
				createdAt: number;
				updatedAt: number;
			}>;
		};

		expect(parsedList.sessions).toHaveLength(2);
		expect(parsedList.sessions[0]).toMatchObject({
			key: "session_beta",
			label: "두 번째 대화 제목",
			messageCount: 2,
		});
		expect(parsedList.sessions[1]).toMatchObject({
			key: "session_alpha",
			label: "첫 번째 질문입니다",
			messageCount: 2,
		});

		const readRaw = (await handleWebWorkspaceCommand(
			"read_conversation",
			{ adkPath: "opfs://naia-adk", sessionId: "session_alpha" },
			fs,
		)) as string;
		const readLines = readRaw.trim().split("\n");
		expect(readLines).toHaveLength(2);
		expect(JSON.parse(readLines[0])).toMatchObject({
			role: "user",
			content: "첫 번째 질문입니다",
		});
		expect(JSON.parse(readLines[1])).toMatchObject({
			role: "assistant",
			content: "첫 번째 답변입니다",
		});

		await handleWebWorkspaceCommand(
			"delete_conversation",
			{ adkPath: "opfs://naia-adk", sessionId: "session_alpha" },
			fs,
		);

		const afterDeleteRaw = (await handleWebWorkspaceCommand(
			"list_conversations",
			{ adkPath: "opfs://naia-adk" },
			fs,
		)) as string;
		const afterDelete = JSON.parse(afterDeleteRaw) as {
			sessions: Array<{ key: string }>;
		};
		expect(afterDelete.sessions.map((c) => c.key)).toEqual(["session_beta"]);
	});

	it("sanitizes sessionId via safeSessionBase and rejects non-string sessionId", async () => {
		const fs = createMemoryWebFs();
		expect(safeSessionBase("../secret")).toBe("secret");
		expect(safeSessionBase("a/b")).toBe("a_b");
		expect(safeSessionBase("...")).toBe("default");

		await expect(
			handleWebWorkspaceCommand(
				"read_conversation",
				{ adkPath: "opfs://naia-adk", sessionId: 123 },
				fs,
			),
		).rejects.toThrow("web_invalid_args:read_conversation");

		await expect(
			handleWebWorkspaceCommand(
				"delete_conversation",
				{ adkPath: "opfs://naia-adk" },
				fs,
			),
		).rejects.toThrow("web_invalid_args:delete_conversation");
	});

	it("isolates conversations per logged-in user and preserves OPFS files across logout and user switches", async () => {
		setWebAssetsModeForTests(true);
		const fs = createMemoryWebFs();

		// 1. User A logs in and saves a conversation
		await completeWebNaiaLogin("naia_live_key_user_a_12345", "user-alpha");
		expect(resolveWebConversationsDir()).toBe(
			"naia-adk/conversations/u-user-alpha",
		);
		await appendWebConversationMessages(
			"chat-a-1",
			[
				{ role: "user", content: "A의 비밀 질문", timestamp: 1700000010000 },
				{ role: "assistant", content: "A의 답변", timestamp: 1700000011000 },
			],
			fs,
		);

		const listA1 = JSON.parse(
			(await handleWebWorkspaceCommand(
				"list_conversations",
				{ adkPath: "opfs://naia-adk" },
				fs,
			)) as string,
		) as { sessions: Array<{ key: string; label: string }> };
		expect(listA1.sessions.map((s) => s.key)).toEqual(["chat-a-1"]);

		// 2. User A logs out -> OPFS file is preserved
		logoutWebSession();
		expect(
			await fs.exists("naia-adk/conversations/u-user-alpha/chat-a-1.jsonl"),
		).toBe(true);

		// 3. User B logs in -> User A's conversation is not visible in list or read
		await completeWebNaiaLogin("naia_live_key_user_b_67890", "user-beta");
		expect(resolveWebConversationsDir()).toBe(
			"naia-adk/conversations/u-user-beta",
		);
		const listB = JSON.parse(
			(await handleWebWorkspaceCommand(
				"list_conversations",
				{ adkPath: "opfs://naia-adk" },
				fs,
			)) as string,
		) as { sessions: Array<{ key: string }> };
		expect(listB.sessions).toEqual([]);

		const readAFromB = (await handleWebWorkspaceCommand(
			"read_conversation",
			{ adkPath: "opfs://naia-adk", sessionId: "chat-a-1" },
			fs,
		)) as string;
		expect(readAFromB).toBe("");

		// 4. User A logs back in -> User A's conversation is visible again
		logoutWebSession();
		await completeWebNaiaLogin("naia_live_key_user_a_12345", "user-alpha");
		const listA2 = JSON.parse(
			(await handleWebWorkspaceCommand(
				"list_conversations",
				{ adkPath: "opfs://naia-adk" },
				fs,
			)) as string,
		) as { sessions: Array<{ key: string; label: string }> };
		expect(listA2.sessions).toHaveLength(1);
		expect(listA2.sessions[0]).toMatchObject({
			key: "chat-a-1",
			label: "A의 비밀 질문",
		});

		// 5. When login gate is disabled (VITE_NAIA_WEB_LOGIN_REQUIRED=0), uses shared path
		setWebLoginRequiredForTests(false);
		expect(resolveWebConversationsDir()).toBe("naia-adk/conversations");

		// 6. Optional conversationsDirOverride writes to the pinned folder regardless of current login state
		setWebLoginRequiredForTests(null);
		await completeWebNaiaLogin("naia_live_key_user_b_67890", "user-beta");
		await appendWebConversationMessages(
			"chat-a-pinned",
			[
				{
					role: "user",
					content: "A의 고정 폴더 질문",
					timestamp: 1700000020000,
				},
				{
					role: "assistant",
					content: "A의 고정 폴더 답변",
					timestamp: 1700000021000,
				},
			],
			fs,
			"naia-adk/conversations/u-user-alpha",
		);
		expect(
			await fs.exists("naia-adk/conversations/u-user-beta/chat-a-pinned.jsonl"),
		).toBe(false);
		expect(
			await fs.exists(
				"naia-adk/conversations/u-user-alpha/chat-a-pinned.jsonl",
			),
		).toBe(true);
	});
});
