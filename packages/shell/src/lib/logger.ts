/**
 * Minimal structured logger for Phase 1.
 * Replaces forbidden console.log/warn/error.
 * Bridges to Rust stderr via `frontend_log` command for terminal visibility.
 * TODO: Replace with @naia/shared/logger in Phase 2.
 */

import { invoke } from "@tauri-apps/api/core";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

const currentLevel: LogLevel = "debug";

function shouldLog(level: LogLevel): boolean {
	return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[currentLevel];
}

function formatMessage(
	level: LogLevel,
	component: string,
	message: string,
	data?: Record<string, unknown>,
): string {
	const timestamp = new Date().toISOString();
	const base = `[${timestamp}] [${level.toUpperCase()}] [${component}] ${message}`;
	if (data) {
		return `${base} ${JSON.stringify(data)}`;
	}
	return base;
}

/** Send log to Rust stderr (fire-and-forget, never blocks) */
function bridgeToRust(level: LogLevel, formatted: string): void {
	invoke("frontend_log", { level, message: formatted }).catch(() => {});
}

// biome-ignore lint/complexity/noStaticOnlyClass: Logger is intentionally a static utility
export class Logger {
	static debug(
		component: string,
		message: string,
		data?: Record<string, unknown>,
	) {
		if (!shouldLog("debug")) return;
		const msg = formatMessage("debug", component, message, data);
		globalThis.console.debug(msg);
		bridgeToRust("debug", msg);
	}

	static info(
		component: string,
		message: string,
		data?: Record<string, unknown>,
	) {
		if (!shouldLog("info")) return;
		const msg = formatMessage("info", component, message, data);
		globalThis.console.info(msg);
		bridgeToRust("info", msg);
	}

	static warn(
		component: string,
		message: string,
		data?: Record<string, unknown>,
	) {
		if (!shouldLog("warn")) return;
		const msg = formatMessage("warn", component, message, data);
		globalThis.console.warn(msg);
		bridgeToRust("warn", msg);
	}

	static error(
		component: string,
		message: string,
		data?: Record<string, unknown>,
	) {
		if (!shouldLog("error")) return;
		const msg = formatMessage("error", component, message, data);
		globalThis.console.error(msg);
		bridgeToRust("error", msg);
	}
}
