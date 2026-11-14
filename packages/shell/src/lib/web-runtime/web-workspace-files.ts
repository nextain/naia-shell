import { isKioskDemo } from "../kiosk-demo/flag";
import { WEB_ADK_PATH } from "./web-adk-path";
import { isKioskReadableParts, splitWebAdkPath } from "./web-adk-policy";

/** Resolve only files inside this browser's ADK directory. */
export async function getWebWorkspaceFile(path: string): Promise<File> {
	if (!path.startsWith(`${WEB_ADK_PATH}/`))
		throw new Error("web_workspace_invalid_path");
	const parts = splitWebAdkPath(path);
	if (!parts || (isKioskDemo() && !isKioskReadableParts(parts))) {
		throw new Error("web_workspace_invalid_path");
	}
	let dir = await navigator.storage.getDirectory();
	dir = await dir.getDirectoryHandle("naia-adk");
	for (const part of parts.slice(0, -1))
		dir = await dir.getDirectoryHandle(part);
	return (await dir.getFileHandle(parts[parts.length - 1])).getFile();
}
