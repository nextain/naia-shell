import { Logger } from "../logger";
import { WEB_ADK_PATH, webAdkOpfsPath } from "./web-adk-path";
import { WEB_LLM_MODEL_ID } from "./webllm-model";
import type { WebFs } from "./web-fs";

export const INITIAL_WEB_WORKSPACE_CONFIG = {
	provider: "webllm",
	model: WEB_LLM_MODEL_ID,
	agentName: "Naia",
	speechStyle: "casual",
	persona: "You are Naia, an AI companion. Speak casually and warmly.",
	onboardingComplete: true,
};

function parseArgs(
	cmd: string,
	args: unknown,
): { adkPath: string; json?: unknown } {
	if (!args || typeof args !== "object") {
		throw new Error(`web_invalid_args:${cmd}`);
	}
	const obj = args as Record<string, unknown>;
	if (typeof obj.adkPath !== "string") {
		throw new Error(`web_invalid_args:${cmd}`);
	}
	return obj as { adkPath: string; json?: unknown };
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
			return existing;
		}
		const initialText = JSON.stringify(INITIAL_WEB_WORKSPACE_CONFIG, null, 2);
		try {
			await fs.writeBytes(configPath, initialText);
		} catch (e) {
			Logger.warn("WebWorkspace", "failed to write initial config", {
				error: String(e),
			});
		}
		return initialText;
	}

	if (cmd === "read_naia_ui_config") {
		const content = await fs.readText(uiConfigPath);
		return content !== null ? content : "";
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
		try {
			await fs.writeBytes(targetPath, jsonVal);
		} catch (e) {
			Logger.warn("WebWorkspace", `${cmd} write failed`, {
				error: String(e),
			});
			throw new Error("naia_config_write_failed");
		}
		return null;
	}

	throw new Error(`unknown web workspace command: ${cmd}`);
}
