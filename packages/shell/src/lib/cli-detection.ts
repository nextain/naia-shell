/**
 * Shell-side helpers for descriptor-driven CLI detection (#605).
 * Rust owns detection; this module persists results and enabled names.
 */

import { invoke } from "@tauri-apps/api/core";
import { loadConfig, saveConfig } from "./config";
import { Logger } from "./logger";

export type CliReadinessStatus =
	| "ready"
	| "not-installed"
	| "login-required"
	| "waiting-input"
	| "error";

export interface CliDetectionResult {
	id: string;
	displayName: string;
	installed: boolean;
	path?: string;
	version?: string;
	status: CliReadinessStatus;
}

export interface CliDetectionSnapshot {
	refreshedAt: string;
	results: CliDetectionResult[];
}

/** Shell gesture toggles shown beside CLI checkboxes. */
export const SHELL_GESTURES = [
	{
		id: "youtube",
		skillName: "skill_youtube_bgm",
		labelKey: "skills.gestureYoutube" as const,
		hintKey: "skills.gestureYoutubeHint" as const,
	},
] as const;

export type ShellGestureId = (typeof SHELL_GESTURES)[number]["id"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function normalizeDetectionResult(value: unknown): CliDetectionResult {
	if (
		!isRecord(value) ||
		typeof value.id !== "string" ||
		typeof value.displayName !== "string" ||
		typeof value.installed !== "boolean"
	) {
		throw new Error("cli_detect_invalid_result");
	}
	return {
		id: value.id,
		displayName: value.displayName,
		installed: value.installed,
		...(typeof value.path === "string" ? { path: value.path } : {}),
		...(typeof value.version === "string" ? { version: value.version } : {}),
		status: normalizeStatus(
			typeof value.status === "string" ? value.status : "error",
		),
	};
}

function normalizeSnapshot(value: unknown): CliDetectionSnapshot {
	if (!isRecord(value) || !Array.isArray(value.results)) {
		throw new Error("cli_detect_invalid_snapshot");
	}
	return {
		refreshedAt:
			typeof value.refreshedAt === "string"
				? value.refreshedAt
				: String(Date.now()),
		results: value.results.map(normalizeDetectionResult),
	};
}

function cachedResults(): CliDetectionResult[] {
	const results = loadConfig()?.cliDetection?.results;
	return Array.isArray(results) ? results.map(normalizeDetectionResult) : [];
}

export async function refreshCliDetection(): Promise<CliDetectionSnapshot> {
	const snapshot = normalizeSnapshot(
		await invoke<unknown>("cli_detect_refresh"),
	);
	const config = loadConfig();
	if (config) {
		const installedIds = new Set(
			snapshot.results.filter((r) => r.installed).map((r) => r.id),
		);
		const prevEnabled = config.enabledClis ?? [];
		// Drop checkboxes for CLIs that disappeared; keep prior enabled set otherwise.
		const enabledClis = prevEnabled.filter((id) => installedIds.has(id));
		saveConfig({
			...config,
			cliDetection: {
				refreshedAt: snapshot.refreshedAt,
				results: snapshot.results,
			},
			enabledClis,
		});
	}
	return snapshot;
}

export async function refreshCliDetectionOne(
	id: string,
): Promise<CliDetectionResult> {
	const result = normalizeDetectionResult(
		await invoke<unknown>("cli_detect_one", { id }),
	);
	const config = loadConfig();
	if (config) {
		const prev = getCachedCliDetectionResults();
		const next = [...prev.filter((r) => r.id !== result.id), result];
		const installedIds = new Set(
			next.filter((r) => r.installed).map((r) => r.id),
		);
		saveConfig({
			...config,
			cliDetection: {
				refreshedAt: String(Date.now()),
				results: next,
			},
			enabledClis: (config.enabledClis ?? []).filter((x) =>
				installedIds.has(x),
			),
		});
	}
	return result;
}

export async function openCliLogin(id: string): Promise<void> {
	await invoke("cli_open_login", { id });
}

export function getEnabledClis(): string[] {
	const config = loadConfig();
	const enabled = Array.isArray(config?.enabledClis)
		? config.enabledClis.filter((id): id is string => typeof id === "string")
		: [];
	const results = config?.cliDetection?.results;
	if (!Array.isArray(results)) return enabled;
	const installed = new Set(
		results
			.filter((result) => result?.installed === true)
			.map((result) => result.id),
	);
	return enabled.filter((id) => installed.has(id));
}

export function setCliEnabled(id: string, enabled: boolean): void {
	const config = loadConfig();
	if (!config) return;
	const results = config.cliDetection?.results;
	if (
		enabled &&
		Array.isArray(results) &&
		!results.some((result) => result.id === id && result.installed)
	) {
		return;
	}
	const set = new Set(config.enabledClis ?? []);
	if (enabled) set.add(id);
	else set.delete(id);
	saveConfig({ ...config, enabledClis: [...set] });
}

export function isGestureDisabled(id: ShellGestureId): boolean {
	return (loadConfig()?.disabledGestures ?? []).includes(id);
}

export function setGestureEnabled(id: ShellGestureId, enabled: boolean): void {
	const config = loadConfig();
	if (!config) return;
	const disabled = new Set(config.disabledGestures ?? []);
	if (enabled) disabled.delete(id);
	else disabled.add(id);
	saveConfig({ ...config, disabledGestures: [...disabled] });
}

export function normalizeStatus(status: string): CliReadinessStatus {
	switch (status) {
		case "ready":
		case "not-installed":
		case "login-required":
		case "waiting-input":
		case "error":
			return status;
		default:
			return "error";
	}
}

export function getCachedCliDetectionResults(): CliDetectionResult[] {
	try {
		return cachedResults();
	} catch {
		return [];
	}
}

/** Best-effort boot refresh — never throws into the UI bootstrap path. */
export async function refreshCliDetectionOnBoot(): Promise<void> {
	try {
		await refreshCliDetection();
	} catch (err) {
		Logger.warn("cli-detection", "boot refresh failed", {
			error: String(err),
		});
	}
}
