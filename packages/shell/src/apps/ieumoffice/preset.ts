import { Logger } from "../../lib/logger";

const TAG = "IeumOfficePreset";

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
	Logger.debug(TAG, "building fallback Naia preset", {
		hasGateway: Boolean(gatewayUrl),
	});
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
