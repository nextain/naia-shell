import { isKioskDemo } from "../kiosk-demo/flag";
import { WEB_ADK_OPFS_DIR, WEB_ADK_PATH } from "./web-adk-path";
import { isKioskReadableParts, splitWebAdkPath } from "./web-adk-policy";

export const WEB_WORKSPACE_IMPORT_ROOT = `${WEB_ADK_PATH}/work`;
const STAGING_DIRECTORY = "naia-workspace-import-staging";
const IMPORT_LOCK = "naia-web-workspace-file-import";
const TEMP_NAME = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export interface WebWorkspaceImportTarget {
	path: string;
	directory: FileSystemDirectoryHandle;
}

async function workspaceDirectory(
	parts: readonly string[],
): Promise<FileSystemDirectoryHandle> {
	const root = await navigator.storage.getDirectory();
	let directory = await root.getDirectoryHandle(WEB_ADK_OPFS_DIR);
	for (const part of parts) {
		directory = await directory.getDirectoryHandle(part);
	}
	return directory;
}

/** Resolve only files inside this browser's ADK directory. */
export async function getWebWorkspaceFile(path: string): Promise<File> {
	if (!path.startsWith(`${WEB_ADK_PATH}/`))
		throw new Error("web_workspace_invalid_path");
	const parts = splitWebAdkPath(path);
	if (!parts || (isKioskDemo() && !isKioskReadableParts(parts))) {
		throw new Error("web_workspace_invalid_path");
	}
	const dir = await workspaceDirectory(parts.slice(0, -1));
	return (await dir.getFileHandle(parts[parts.length - 1])).getFile();
}

export function isWebWorkspaceImportDirectory(path: string): boolean {
	const parts = splitWebAdkPath(path);
	return parts?.[0] === "work" && parts.every((part) => !part.startsWith("."));
}

export async function openWebWorkspaceImportRoot(): Promise<WebWorkspaceImportTarget> {
	if (isKioskDemo() || !navigator.locks?.request) {
		throw new DOMException("Workspace import unavailable", "NotSupportedError");
	}
	const workspace = await workspaceDirectory([]);
	return {
		path: WEB_WORKSPACE_IMPORT_ROOT,
		directory: await workspace.getDirectoryHandle("work", { create: true }),
	};
}

async function availableName(directory: FileSystemDirectoryHandle, name: string) {
	const dot = name.lastIndexOf(".");
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const suffix = dot > 0 ? name.slice(dot) : "";
	for (let i = 1; ; i += 1) {
		const candidate = i === 1 ? name : `${stem} (${i})${suffix}`;
		try {
			await directory.getFileHandle(candidate);
		} catch (error) {
			if (!(error instanceof DOMException)) throw error;
			if (error.name === "NotFoundError") return candidate;
			if (error.name !== "TypeMismatchError") throw error;
		}
	}
}

async function removeAbandonedImports(directory: FileSystemDirectoryHandle) {
	const entries = directory as FileSystemDirectoryHandle & {
		values(): AsyncIterable<FileSystemHandle>;
	};
	for await (const entry of entries.values()) {
		if (entry.kind === "file" && TEMP_NAME.test(entry.name)) {
			await directory.removeEntry(entry.name);
		}
	}
}

export async function importWebWorkspaceFile(
	target: WebWorkspaceImportTarget,
	file: File,
): Promise<string> {
	if (isKioskDemo() || !navigator.locks?.request) {
		throw new DOMException("Workspace import unavailable", "NotSupportedError");
	}
	const parts = splitWebAdkPath(target.path);
	const name = file.name;
	if (
		!parts ||
		!isWebWorkspaceImportDirectory(target.path) ||
		!name ||
		name === "." ||
		name === ".." ||
		name.includes("/") ||
		name.includes("\\") ||
		name.includes("\0")
	) {
		throw new DOMException("Invalid workspace import path", "InvalidCharacterError");
	}

	return navigator.locks.request(IMPORT_LOCK, async () => {
		const directory = await workspaceDirectory(parts);
		if (!(await directory.isSameEntry(target.directory))) {
			throw new DOMException("Workspace import directory changed", "NotFoundError");
		}
		const originRoot = await navigator.storage.getDirectory();
		const staging = await originRoot.getDirectoryHandle(STAGING_DIRECTORY, {
			create: true,
		});
		await removeAbandonedImports(staging);
		const temporaryName = crypto.randomUUID();
		const temporaryFile = (await staging.getFileHandle(temporaryName, {
			create: true,
		})) as FileSystemFileHandle & {
			move?: (destination: FileSystemDirectoryHandle, name: string) => Promise<void>;
		};

		try {
			if (typeof temporaryFile.move !== "function") {
				throw new DOMException("Workspace import unavailable", "NotSupportedError");
			}
			const writer = await temporaryFile.createWritable();
			try {
				await writer.write(file);
				await writer.close();
			} catch (error) {
				await writer.abort().catch(() => {});
				throw error;
			}
			const current = await workspaceDirectory(parts);
			if (!(await current.isSameEntry(directory))) {
				throw new DOMException("Workspace import directory changed", "NotFoundError");
			}
			const destination = await availableName(directory, name);
			await temporaryFile.move(directory, destination);
			return `${target.path}/${destination}`;
		} catch (error) {
			await staging.removeEntry(temporaryName).catch(() => {});
			throw error;
		}
	});
}
