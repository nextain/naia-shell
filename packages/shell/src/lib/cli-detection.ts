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
	status: CliReadinessStatus | string;
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

export async function refreshCliDetection(): Promise<CliDetectionSnapshot> {
	const snapshot = await invoke<CliDetectionSnapshot>("cli_detect_refresh");
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
				results: snapshot.results.map((r) => ({
					id: r.id,
					displayName: r.displayName,
					installed: r.installed,
					...(r.path ? { path: r.path } : {}),
					...(r.version ? { version: r.version } : {}),
					status: normalizeStatus(r.status),
				})),
			},
			enabledClis,
		});
	}
	return snapshot;
}

export async function refreshCliDetectionOne(
	id: string,
): Promise<CliDetectionResult> {
	const result = await invoke<CliDetectionResult>("cli_detect_one", { id });
	const config = loadConfig();
	if (config) {
		const prev = config.cliDetection?.results ?? [];
		const next = [
			...prev.filter((r) => r.id !== result.id),
			{
				id: result.id,
				displayName: result.displayName,
				installed: result.installed,
				...(result.path ? { path: result.path } : {}),
				...(result.version ? { version: result.version } : {}),
				status: normalizeStatus(result.status),
			},
		];
		const installedIds = new Set(next.filter((r) => r.installed).map((r) => r.id));
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
	return loadConfig()?.enabledClis ?? [];
}

export function setCliEnabled(id: string, enabled: boolean): void {
	const config = loadConfig();
	if (!config) return;
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
