import { getLocale } from "../i18n";
import { Logger } from "../logger";
import { WEB_ADK_PATH, webAdkOpfsPath } from "./web-adk-path";
import {
	WEB_DEFAULT_BACKGROUND,
	WEB_DEFAULT_NVA,
	normalizeRetiredWebBackgroundInRecord,
} from "./web-assets";
import { getWebAuthenticatedUserId, isWebLoginGateDisabled } from "./web-auth";
import type { WebFs } from "./web-fs";
import { getDefaultLlmModel } from "../llm/registry";

export const INITIAL_WEB_WORKSPACE_CONFIG = {
	provider: "nextain",
	model: getDefaultLlmModel("nextain"),
	webAutoDefaultModel: true,
	agentName: "Naia",
	speechStyle: "casual",
	persona: "You are Naia, an AI companion. Speak casually and warmly.",
	onboardingComplete: true,
	// WO-03: 웹판 첫 부팅부터 아바타·배경이 보이도록 번들 기본값.
	// NVA is loaded from the static catalog on demand, like desktop's naia preset.
	avatarProvider: "naia-video-avatar",
	nvaModel: WEB_DEFAULT_NVA,
	backgroundVideo: WEB_DEFAULT_BACKGROUND,
};

/**
 * 데스크톱 Rust `safe_session_base` 와 동일한 파일명 정규화 (traversal·경로 인젝션 차단).
 * 영숫자/`_`/`-` 외는 `_`로 치환, 선행 `_`/`.` 제거, 최대 128자, 빈 문자열이면 `"default"`.
 */
export function safeSessionBase(sessionId: string): string {
	const mapped = Array.from(sessionId)
		.map((c) => (/^[a-zA-Z0-9_-]$/.test(c) ? c : "_"))
		.join("");
	const base = Array.from(mapped.replace(/^[_.]+/, ""))
		.slice(0, 128)
		.join("");
	return base.length === 0 ? "default" : base;
}

export interface WebConversationEntry {
	role: "user" | "assistant";
	content: string;
	timestamp: number;
}

let conversationWriteTail: Promise<void> = Promise.resolve();

/**
 * 로그인한 사용자 ID가 있으면 사용자별 대화 폴더(`naia-adk/conversations/u-<safeUserId>`)를 반환하고,
 * 로그인 문을 끈 빌드(`VITE_NAIA_WEB_LOGIN_REQUIRED=0`)이거나 사용자 ID가 없으면 공용 경로(`naia-adk/conversations`)를 반환한다.
 */
export function resolveWebConversationsDir(
	userIdOverride?: string | null,
): string {
	if (isWebLoginGateDisabled()) {
		return webAdkOpfsPath("conversations");
	}
	const rawUserId =
		userIdOverride !== undefined ? userIdOverride : getWebAuthenticatedUserId();
	const trimmed = typeof rawUserId === "string" ? rawUserId.trim() : "";
	if (trimmed.length > 0) {
		return webAdkOpfsPath(`conversations/u-${safeSessionBase(trimmed)}`);
	}
	return webAdkOpfsPath("conversations");
}

/**
 * 웹판 대화 턴을 `{conversationsDir}/{session}.jsonl` 에 영구 기록한다.
 * 데스크톱 `naia-agent` 의 `FileConversationLogStore` 와 동일한 JSONL 줄 형식을 쓴다.
 * `conversationsDirOverride` 가 주어지면 호출 시점의 로그인 상태와 무관하게 고정된 폴더에 기록한다.
 */
export function appendWebConversationMessages(
	sessionId: string,
	entries: readonly WebConversationEntry[],
	fs: WebFs,
	conversationsDirOverride?: string,
): Promise<void> {
	if (entries.length === 0) return Promise.resolve();
	const convDir =
		typeof conversationsDirOverride === "string" &&
		conversationsDirOverride.trim().length > 0
			? conversationsDirOverride.trim()
			: resolveWebConversationsDir();
	const filePath = `${convDir}/${safeSessionBase(sessionId)}.jsonl`;
	const linesToAppend = entries
		.map((entry) =>
			JSON.stringify({
				role: entry.role,
				content: entry.content,
				timestamp: entry.timestamp,
			}),
		)
		.join("\n");

	const op = conversationWriteTail.then(async () => {
		const existing = await fs.readText(filePath);
		const prefix =
			existing && existing.length > 0
				? existing.endsWith("\n")
					? existing
					: `${existing}\n`
				: "";
		await fs.writeBytes(filePath, `${prefix}${linesToAppend}\n`);
	});
	conversationWriteTail = op.then(
		() => undefined,
		() => undefined,
	);
	return op;
}

function migrateRetiredBackgroundJsonText(rawText: string): {
	text: string;
	changed: boolean;
} {
	try {
		const parsed: unknown = JSON.parse(rawText);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { text: rawText, changed: false };
		}
		const record = parsed as Record<string, unknown>;
		if (!normalizeRetiredWebBackgroundInRecord(record)) {
			return { text: rawText, changed: false };
		}
		return { text: JSON.stringify(record, null, 2), changed: true };
	} catch {
		return { text: rawText, changed: false };
	}
}

function parseArgs(
	cmd: string,
	args: unknown,
): { adkPath: string; json?: unknown; sessionId?: unknown } {
	if (!args || typeof args !== "object") {
		throw new Error(`web_invalid_args:${cmd}`);
	}
	const obj = args as Record<string, unknown>;
	if (typeof obj.adkPath !== "string") {
		throw new Error(`web_invalid_args:${cmd}`);
	}
	return obj as { adkPath: string; json?: unknown; sessionId?: unknown };
}

export async function handleWebWorkspaceCommand(
	cmd: string,
	args: unknown,
	fs: WebFs,
): Promise<unknown> {
	if (cmd === "reload_agent_settings") {
		return {
			available: false,
			memoryReloaded: false,
			memoryRetained: false,
			memoryStatus: "next_start",
		};
	}

	const parsed = parseArgs(cmd, args);

	if (cmd === "write_naia_path_cache") {
		if (parsed.adkPath === "") {
			throw new Error("adk_path is empty");
		}
		if (parsed.adkPath !== WEB_ADK_PATH) {
			throw new Error(`web_adk_path_mismatch:${parsed.adkPath}`);
		}
		return null;
	}

	if (parsed.adkPath !== WEB_ADK_PATH) {
		throw new Error(`web_adk_path_mismatch:${parsed.adkPath}`);
	}

	const configPath = webAdkOpfsPath("naia-settings/config.json");
	const uiConfigPath = webAdkOpfsPath("naia-settings/ui-config.json");

	if (cmd === "read_naia_config") {
		const existing = await fs.readText(configPath);
		if (existing !== null) {
			const migrated = migrateRetiredBackgroundJsonText(existing);
			if (migrated.changed) {
				try {
					await fs.writeBytes(configPath, migrated.text);
				} catch {
					// 쓰기 실패 시에도 마이그레이션된 텍스트를 반환한다.
				}
			}
			return migrated.text;
		}
		const initialText = JSON.stringify(
			{ ...INITIAL_WEB_WORKSPACE_CONFIG, NAIA_LOCALE: getLocale() },
			null,
			2,
		);
		try {
			await fs.writeBytes(configPath, initialText);
		} catch (e) {
			Logger.warn("WebWorkspace", "failed to write initial config", {
				error: String(e),
			});
			throw e;
		}
		return initialText;
	}

	if (cmd === "read_naia_ui_config") {
		const content = await fs.readText(uiConfigPath);
		if (content === null) return "";
		const migrated = migrateRetiredBackgroundJsonText(content);
		if (migrated.changed) {
			try {
				await fs.writeBytes(uiConfigPath, migrated.text);
			} catch {
				// ignore write-back failure on read
			}
		}
		return migrated.text;
	}

	if (cmd === "write_naia_config" || cmd === "write_naia_ui_config") {
		const targetPath = cmd === "write_naia_config" ? configPath : uiConfigPath;
		const jsonVal = parsed.json;
		if (typeof jsonVal !== "string") {
			throw new Error("naia_config_invalid_json");
		}
		let parsedJson: unknown;
		try {
			parsedJson = JSON.parse(jsonVal);
		} catch {
			throw new Error("naia_config_invalid_json");
		}
		if (
			parsedJson === null ||
			typeof parsedJson !== "object" ||
			Array.isArray(parsedJson)
		) {
			throw new Error("naia_config_invalid_json");
		}
		const record = parsedJson as Record<string, unknown>;
		const toWrite = normalizeRetiredWebBackgroundInRecord(record)
			? JSON.stringify(record, null, 2)
			: jsonVal;
		try {
			await fs.writeBytes(targetPath, toWrite);
		} catch (e) {
			Logger.warn("WebWorkspace", `${cmd} write failed`, {
				error: String(e),
			});
			throw new Error("naia_config_write_failed");
		}
		return null;
	}

	if (cmd === "list_conversations") {
		const convDir = resolveWebConversationsDir();
		const entries = (await fs.listEntries?.(convDir)) ?? [];
		const sessions: Array<{
			key: string;
			label: string;
			messageCount: number;
			createdAt: number;
			updatedAt: number;
		}> = [];

		for (const entry of entries) {
			if (!entry.endsWith(".jsonl")) continue;
			const stem = entry.slice(0, -".jsonl".length);
			if (!stem) continue;
			const content = await fs.readText(`${convDir}/${entry}`);
			if (!content) continue;
			const lines = content
				.split(/\r?\n/)
				.filter((line) => line.trim().length > 0);
			if (lines.length === 0) continue;

			const parseTs = (line: string): number => {
				try {
					const v = JSON.parse(line) as { timestamp?: unknown };
					return typeof v.timestamp === "number" && Number.isFinite(v.timestamp)
						? Math.max(0, Math.floor(v.timestamp))
						: 0;
				} catch {
					return 0;
				}
			};
			const created = parseTs(lines[0]);
			const updated = Math.max(parseTs(lines[lines.length - 1]), created);
			let label = "";
			for (const line of lines) {
				try {
					const v = JSON.parse(line) as {
						role?: unknown;
						content?: unknown;
					};
					if (v.role === "user") {
						const text = typeof v.content === "string" ? v.content : "";
						label = Array.from(text).slice(0, 40).join("");
						break;
					}
				} catch {
					// 손상 줄은 건너뛴다
				}
			}
			sessions.push({
				key: stem,
				label,
				messageCount: lines.length,
				createdAt: created,
				updatedAt: updated,
			});
		}

		sessions.sort((a, b) => b.updatedAt - a.updatedAt);
		return JSON.stringify({ sessions });
	}

	if (cmd === "read_conversation") {
		if (typeof parsed.sessionId !== "string") {
			throw new Error("web_invalid_args:read_conversation");
		}
		const convDir = resolveWebConversationsDir();
		const filePath = `${convDir}/${safeSessionBase(parsed.sessionId)}.jsonl`;
		const content = await fs.readText(filePath);
		return content ?? "";
	}

	if (cmd === "delete_conversation") {
		if (typeof parsed.sessionId !== "string") {
			throw new Error("web_invalid_args:delete_conversation");
		}
		const convDir = resolveWebConversationsDir();
		const filePath = `${convDir}/${safeSessionBase(parsed.sessionId)}.jsonl`;
		await fs.removeFile?.(filePath);
		return null;
	}

	throw new Error(`unknown web workspace command: ${cmd}`);
}
