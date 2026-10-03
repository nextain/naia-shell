import { Logger } from "../logger";
import { COMMAND_TABLE, STUB_RESPONSES } from "./command-table";
import {
	handleEventEmit,
	handleEventListen,
	handleEventUnlisten,
} from "./event-bus";

const warnedCommands = new Set<string>();

export async function routeCommand(
	cmd: string,
	args?: unknown,
	_options?: unknown,
): Promise<unknown> {
	const classification = COMMAND_TABLE[cmd];

	if (classification === "web") {
		if (cmd === "plugin:event|listen") {
			return handleEventListen(
				args as { event: string; target?: unknown; handler: number },
			);
		}
		if (cmd === "plugin:event|unlisten") {
			return handleEventUnlisten(
				args as { event?: string; eventId?: number },
			);
		}
		if (cmd === "plugin:event|emit") {
			return handleEventEmit(
				args as { event: string; payload: unknown },
			);
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
