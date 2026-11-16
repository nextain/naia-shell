import { invoke } from "@tauri-apps/api/core";
import { getAdkPath } from "./adk-store";
import { loadConfig, saveConfig } from "./config";
import { Logger } from "./logger";
import { setIeumOfficeMcpToolsAllowed } from "./model-facing-tools";

const TAG = "IeumOfficeMcp";

export const IEUMOFFICE_OFFICIAL_REPO_URL =
	"https://github.com/pblsketch/ieumoffice";
export const IEUMOFFICE_OFFICIAL_RELEASES_URL =
	"https://github.com/pblsketch/ieumoffice/releases";
export const IEUMOFFICE_OFFICIAL_SITE_URL = "https://ieumoffice.com";

export interface IeumOfficeMcpLaunch {
	command: string;
	args: string[];
	env?: Record<string, string>;
}

export interface IeumOfficeNaiaPreset {
	cloudName: string;
	cloudBaseUrl: string;
	cloudModel: string;
	localName: string;
	localBaseUrl: string;
	localModel: string;
	officialRepoUrl: string;
	officialReleasesUrl: string;
	officialSiteUrl: string;
}

export interface IeumOfficeStatus {
	installed: boolean;
	binaryPath?: string;
	version?: string;
	mcpEnabled: boolean;
	autoConnected: boolean;
	mcpLaunch?: IeumOfficeMcpLaunch;
	officialRepoUrl: string;
	officialReleasesUrl: string;
	officialSiteUrl: string;
	naiaPreset: IeumOfficeNaiaPreset;
}

export interface IeumOfficeCodingAgentsResult {
	ok: boolean;
	exitCode: number | null;
	summary: string;
}

export function buildFallbackNaiaPreset(
	gatewayUrl?: string,
	model?: string,
): IeumOfficeNaiaPreset {
	const rawGateway = (gatewayUrl ?? "").trim().replace(/\/+$/, "");
	const cloudBaseUrl = rawGateway
		? rawGateway.endsWith("/v1")
			? rawGateway
			: `${rawGateway}/v1`
		: "https://api.naia.land/v1";
	return {
		cloudName: "Naia Cloud Gateway",
		cloudBaseUrl,
		cloudModel: (model ?? "").trim() || "naia/solar-pro4",
		localName: "Naia Local AI (Ollama)",
		localBaseUrl: "http://127.0.0.1:11434/v1",
		localModel: "qwen3:8b",
		officialRepoUrl: IEUMOFFICE_OFFICIAL_REPO_URL,
		officialReleasesUrl: IEUMOFFICE_OFFICIAL_RELEASES_URL,
		officialSiteUrl: IEUMOFFICE_OFFICIAL_SITE_URL,
	};
}

function syncStatusIntoShellConfig(status: IeumOfficeStatus | null | undefined): void {
	const active = Boolean(status?.installed && status?.mcpEnabled);
	setIeumOfficeMcpToolsAllowed(active);
	const config = loadConfig();
	if (config && config.ieumofficeMcpEnabled !== active) {
		saveConfig({
			...config,
			ieumofficeMcpEnabled: active,
		});
	}
}

export async function detectIeumOfficeStatus(): Promise<IeumOfficeStatus> {
	const config = loadConfig();
	const adkPath = getAdkPath() ?? config?.workspaceRoot ?? undefined;
	const gatewayUrl = config?.gatewayUrl ?? undefined;
	const model = config?.model ?? undefined;
	Logger.debug(TAG, "detecting ieumoffice status", {
		hasAdkPath: Boolean(adkPath),
	});
	const status = await invoke<IeumOfficeStatus>("ieumoffice_detect_status", {
		adkPath,
		gatewayUrl,
		model,
	});
	syncStatusIntoShellConfig(status);
	return status;
}

export async function setIeumOfficeMcpEnabled(
	enabled: boolean,
): Promise<IeumOfficeStatus> {
	const config = loadConfig();
	const adkPath = getAdkPath() ?? config?.workspaceRoot ?? undefined;
	Logger.info(TAG, "updating ieumoffice mcp enabled state", {
		enabled,
		hasAdkPath: Boolean(adkPath),
	});
	const status = await invoke<IeumOfficeStatus>("ieumoffice_set_mcp_enabled", {
		adkPath,
		enabled,
	});
	syncStatusIntoShellConfig(status);
	return status;
}

export async function registerIeumOfficeCodingAgents(): Promise<IeumOfficeCodingAgentsResult> {
	Logger.info(TAG, "registering ieumoffice mcp in coding agents");
	return invoke<IeumOfficeCodingAgentsResult>(
		"ieumoffice_register_coding_agents",
	);
}

export async function refreshIeumOfficeMcpOnBoot(): Promise<void> {
	const cached = loadConfig();
	if (cached?.ieumofficeMcpEnabled) {
		setIeumOfficeMcpToolsAllowed(true);
	}
	try {
		await detectIeumOfficeStatus();
	} catch (err) {
		Logger.warn(TAG, "boot ieumoffice detection skipped", {
			error: String(err),
		});
	}
}
