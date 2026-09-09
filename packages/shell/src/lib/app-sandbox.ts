import { invoke } from "@tauri-apps/api/core";
import { getAdkPath } from "./adk-store";

function adkPath(explicitPath?: string | null): string {
	const path = explicitPath === undefined ? getAdkPath() : explicitPath;
	if (!path) throw new Error("ADK path is not configured");
	return path;
}

export function getAppSandboxRoot(appId: string): Promise<string> {
	return invoke("app_sandbox_root", { adkPath: adkPath(), appId });
}

export function writeAppSandboxFile(
	appId: string,
	relativePath: string,
	bytes: number[],
	explicitAdkPath?: string | null,
): Promise<string> {
	return invoke("app_sandbox_write_file", {
		adkPath: adkPath(explicitAdkPath),
		appId,
		relativePath,
		bytes,
	});
}

export function readAppSandboxFile(appId: string, relativePath: string): Promise<number[]> {
	return invoke("app_sandbox_read_file", { adkPath: adkPath(), appId, relativePath });
}

export function openAppSandboxFileInWorkspace(appId: string, relativePath: string): Promise<string> {
	return invoke("app_sandbox_open_in_workspace", { adkPath: adkPath(), appId, relativePath });
}

export function startSlidesRecording(): Promise<void> {
	return invoke("slides_recording_start", { adkPath: adkPath() });
}

export function stopSlidesRecording(): Promise<string> {
	return invoke("slides_recording_stop");
}
