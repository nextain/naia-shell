import { invoke } from "@tauri-apps/api/core";
import {
	IEUMOFFICE_OFFICIAL_RELEASES_URL,
	IEUMOFFICE_OFFICIAL_REPO_URL,
	IEUMOFFICE_OFFICIAL_SITE_URL,
	type IeumOfficeCodingAgentsResult,
	type IeumOfficeMcpLaunch,
	type IeumOfficeNaiaPreset,
	type IeumOfficeStatus,
	buildFallbackNaiaPreset,
} from "../apps/ieumoffice/preset";
import { getAdkPath } from "./adk-store";
import { loadConfig, saveConfig } from "./config";
import { Logger } from "./logger";
import { setIeumOfficeMcpToolsAllowed } from "./model-facing-tools";

const TAG = "IeumOfficeMcp";

export {
	IEUMOFFICE_OFFICIAL_RELEASES_URL,
	IEUMOFFICE_OFFICIAL_REPO_URL,
	IEUMOFFICE_OFFICIAL_SITE_URL,
	buildFallbackNaiaPreset,
};
export type {
	IeumOfficeCodingAgentsResult,
	IeumOfficeMcpLaunch,
	IeumOfficeNaiaPreset,
	IeumOfficeStatus,
};

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
