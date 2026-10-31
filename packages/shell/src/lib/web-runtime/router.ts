import { Logger } from "../logger";
import { getAgentBridge } from "./agent-bridge";
import { COMMAND_TABLE, STUB_RESPONSES } from "./command-table";
export { COMMAND_TABLE };
import {
	handleEventEmit,
	handleEventListen,
	handleEventUnlisten,
} from "./event-bus";
import { getWebFs } from "./web-fs";
import { handleWebWorkspaceCommand } from "./web-workspace-commands";
import { getWebWorkspaceFile } from "./web-workspace-files";

const warnedCommands = new Set<string>();

export async function routeCommand(
	cmd: string,
	args?: unknown,
	_options?: unknown,
): Promise<unknown> {
	const classification = COMMAND_TABLE[cmd];

	if (classification === "web") {
		if (cmd === "workspace_read_file" || cmd === "workspace_read_file_bytes" || cmd === "workspace_file_size") {
			const path = (args as { path?: unknown })?.path;
			if (typeof path !== "string") throw new Error("web_workspace_invalid_path");
			const file = await getWebWorkspaceFile(path);
			if (cmd === "workspace_file_size") return file.size;
			return cmd === "workspace_read_file" ? file.text() : Array.from(new Uint8Array(await file.arrayBuffer()));
		}
		if (cmd === "plugin:event|listen") {
			return handleEventListen(
				args as { event: string; target?: unknown; handler: number },
			);
		}
		if (cmd === "plugin:event|unlisten") {
			return handleEventUnlisten(args as { event?: string; eventId?: number });
		}
		if (cmd === "plugin:event|emit") {
			return handleEventEmit(args as { event: string; payload: unknown });
		}
		if (cmd === "send_to_agent_command") {
			const message = (args as { message?: string })?.message ?? "";
			const byteLen = new TextEncoder().encode(message).length;
			const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;
			if (byteLen > MAX_MESSAGE_BYTES) {
				throw new Error(`Message too large: ${byteLen} bytes`);
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(message);
			} catch (e) {
				throw new Error(
					`Invalid JSON from frontend: ${e instanceof Error ? e.message : String(e)}`,
				);
			}
			if (
				typeof parsed !== "object" ||
				parsed === null ||
				Array.isArray(parsed)
			) {
				throw new Error("Message must be a JSON object");
			}
			const typeVal = (parsed as { type?: unknown }).type;
			if (typeof typeVal !== "string") {
				throw new Error("Message must have a string 'type' field");
			}
			getAgentBridge().sendLine(message);
			return null;
		}
		if (cmd === "cancel_stream") {
			const requestId = (args as { requestId?: string })?.requestId;
			getAgentBridge().sendLine(
				JSON.stringify({ type: "cancel_stream", requestId }),
			);
			return null;
		}
		if (
			cmd === "read_naia_config" ||
			cmd === "write_naia_config" ||
			cmd === "read_naia_ui_config" ||
			cmd === "write_naia_ui_config" ||
			cmd === "write_naia_path_cache" ||
			cmd === "reload_agent_settings" ||
			cmd === "list_conversations" ||
			cmd === "read_conversation" ||
			cmd === "delete_conversation"
		) {
			return handleWebWorkspaceCommand(cmd, args, getWebFs());
		}
	}

	if (classification === "stub") {
		if (cmd in STUB_RESPONSES) {
			return STUB_RESPONSES[cmd];
		}
		return null;
	}

	// desktop-only or unlisted command
	if (!warnedCommands.has(cmd)) {
		warnedCommands.add(cmd);
		Logger.warn("WebRuntime", `desktop_only:${cmd}`);
	}

	throw new Error(`desktop_only:${cmd}`);
}

/** Reset warning tracking for isolated tests */
export function resetWarnedCommands(): void {
	warnedCommands.clear();
}
