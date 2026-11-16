import { invoke } from "@tauri-apps/api/core";
import { getAdkPath } from "../../lib/adk-store";
import { loadConfig } from "../../lib/config";
import { Logger } from "../../lib/logger";
import { useAppStore } from "../../stores/app";

const TAG = "CoursewareHostBridge";

export const COURSEWARE_APP_IDS = new Set<string>([
	"land.naia.blackjack",
	"land.naia.nts-edu-helper",
]);

export const COURSEWARE_PROVISION_MSG = "naia-courseware:provision";
export const COURSEWARE_SYNC_FILES_MSG = "naia-courseware:sync-files";
export const COURSEWARE_READ_FILES_MSG = "naia-courseware:read-files";
export const COURSEWARE_OPEN_PROJECTS_MSG = "naia-courseware:open-projects-app";
export const COURSEWARE_RESULT_MSG = "naia-courseware:result";

const MAX_STARTER_FILES = 32;
const MAX_STARTER_FILE_BYTES = 512 * 1024;
const PROJECT_SLUG_RE = /^[a-z0-9][a-z0-9-_]{1,62}$/;

export interface CoursewareStarterFileEntry {
	path: string;
	content: string;
}

export interface CoursewareProjectInfo {
	projectDir: string;
	projectSlug: string;
	writtenFiles: string[];
	skippedFiles: string[];
}

function validRequestId(value: unknown): value is string {
	return typeof value === "string" && /^[\w-]{1,100}$/.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function validProjectSlug(value: unknown): value is string {
	return typeof value === "string" && PROJECT_SLUG_RE.test(value);
}

function validRelativePath(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > 240) {
		return false;
	}
	if (
		value.includes("\0") ||
		value.startsWith("/") ||
		value.endsWith("/") ||
		value.includes("\\") ||
		value.includes(":")
	) {
		return false;
	}
	const segments = value.split("/");
	if (segments.length === 0 || segments.length > 8) return false;
	return segments.every(
		(part) =>
			part.length > 0 && part !== "." && part !== ".." && part !== ".git",
	);
}

function parseStarterFiles(
	raw: unknown,
): CoursewareStarterFileEntry[] | null {
	if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_STARTER_FILES) {
		return null;
	}
	const entries: CoursewareStarterFileEntry[] = [];
	const seen = new Set<string>();
	for (const item of raw) {
		if (!isPlainObject(item)) return null;
		if (!validRelativePath(item.path) || typeof item.content !== "string") {
			return null;
		}
		if (item.content.length > MAX_STARTER_FILE_BYTES) return null;
		if (seen.has(item.path)) return null;
		seen.add(item.path);
		entries.push({ path: item.path, content: item.content });
	}
	return entries;
}

function parseRelativePaths(raw: unknown): string[] | null {
	if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_STARTER_FILES) {
		return null;
	}
	const paths: string[] = [];
	const seen = new Set<string>();
	for (const item of raw) {
		if (!validRelativePath(item)) return null;
		if (seen.has(item)) return null;
		seen.add(item);
		paths.push(item);
	}
	return paths;
}

export function resolveCoursewareAdkPath(): string | null {
	const direct = getAdkPath()?.trim();
	if (direct) return direct;
	const cfg = loadConfig() as
		| ({ workspaceRoot?: string; adkPath?: string } & Record<string, unknown>)
		| null;
	const mirrored = (cfg?.adkPath ?? cfg?.workspaceRoot)?.trim();
	return mirrored || null;
}

function normalizeProjectInfo(raw: unknown): CoursewareProjectInfo {
	const obj = isPlainObject(raw) ? raw : {};
	return {
		projectDir: String(obj.projectDir ?? obj.project_dir ?? ""),
		projectSlug: String(obj.projectSlug ?? obj.project_slug ?? ""),
		writtenFiles: Array.isArray(obj.writtenFiles ?? obj.written_files)
			? ((obj.writtenFiles ?? obj.written_files) as unknown[]).map(String)
			: [],
		skippedFiles: Array.isArray(obj.skippedFiles ?? obj.skipped_files)
			? ((obj.skippedFiles ?? obj.skipped_files) as unknown[]).map(String)
			: [],
	};
}

export function installCoursewareHostBridge(
	frame: HTMLIFrameElement,
	frameSrc: string,
	appId: string,
): () => void {
	if (!COURSEWARE_APP_IDS.has(appId)) {
		return () => {};
	}
	let origin: string;
	try {
		origin = new URL(frameSrc).origin;
		if (origin === "null") return () => {};
	} catch {
		return () => {};
	}

	Logger.debug(TAG, "install courseware host bridge", { appId, origin });
	let disposed = false;

	const sendResult = (payload: Record<string, unknown>) => {
		if (disposed) return;
		const contentWindow = frame.contentWindow;
		if (!contentWindow) return;
		try {
			contentWindow.postMessage(
				{ type: COURSEWARE_RESULT_MSG, ...payload },
				origin,
			);
		} catch (err) {
			Logger.warn(TAG, "failed to post courseware result to iframe", {
				appId,
				error: String(err),
			});
		}
	};

	const onMessage = (event: MessageEvent) => {
		const contentWindow = frame.contentWindow;
		if (
			!contentWindow ||
			event.source !== contentWindow ||
			event.origin !== origin
		) {
			return;
		}
		const message = event.data;
		if (!isPlainObject(message)) return;
		const msgType = message.type;
		if (
			msgType !== COURSEWARE_PROVISION_MSG &&
			msgType !== COURSEWARE_SYNC_FILES_MSG &&
			msgType !== COURSEWARE_READ_FILES_MSG &&
			msgType !== COURSEWARE_OPEN_PROJECTS_MSG
		) {
			return;
		}
		if (message.appId !== appId || !validRequestId(message.id)) {
			Logger.warn(TAG, "rejected malformed courseware bridge request", {
				appId,
				msgType,
			});
			return;
		}
		const requestId = message.id;

		if (msgType === COURSEWARE_OPEN_PROJECTS_MSG) {
			Logger.debug(TAG, "switching active shell app to projects", { appId });
			useAppStore.getState().setActiveApp("projects");
			sendResult({
				id: requestId,
				action: "open-projects-app",
				ok: true,
			});
			return;
		}

		if (!validProjectSlug(message.projectSlug)) {
			sendResult({
				id: requestId,
				action: msgType,
				ok: false,
				error: "invalid_project_slug",
			});
			return;
		}
		const projectSlug = message.projectSlug;
		const adkPath = resolveCoursewareAdkPath();
		if (!adkPath) {
			sendResult({
				id: requestId,
				action: msgType,
				ok: false,
				error: "adk_not_configured",
			});
			return;
		}

		if (msgType === COURSEWARE_PROVISION_MSG) {
			const files = parseStarterFiles(message.files);
			if (!files) {
				sendResult({
					id: requestId,
					action: "provision",
					ok: false,
					error: "invalid_files",
				});
				return;
			}
			const overwrite = Boolean(message.overwrite);
			Logger.debug(TAG, "invoking courseware_provision_starter", {
				appId,
				projectSlug,
				fileCount: files.length,
				overwrite,
			});
			void invoke("courseware_provision_starter", {
				adkPath,
				appId,
				projectSlug,
				files,
				overwrite,
			})
				.then((raw) => {
					const data = normalizeProjectInfo(raw);
					sendResult({
						id: requestId,
						action: "provision",
						ok: true,
						data,
					});
				})
				.catch((err) => {
					Logger.warn(TAG, "courseware_provision_starter failed", {
						appId,
						projectSlug,
						error: String(err),
					});
					sendResult({
						id: requestId,
						action: "provision",
						ok: false,
						error: String(err),
					});
				});
			return;
		}

		if (msgType === COURSEWARE_SYNC_FILES_MSG) {
			const files = parseStarterFiles(message.files);
			if (!files) {
				sendResult({
					id: requestId,
					action: "sync-files",
					ok: false,
					error: "invalid_files",
				});
				return;
			}
			Logger.debug(TAG, "invoking courseware_sync_files", {
				appId,
				projectSlug,
				fileCount: files.length,
			});
			void invoke("courseware_sync_files", {
				adkPath,
				projectSlug,
				files,
			})
				.then((raw) => {
					const data = normalizeProjectInfo(raw);
					sendResult({
						id: requestId,
						action: "sync-files",
						ok: true,
						data,
					});
				})
				.catch((err) => {
					Logger.warn(TAG, "courseware_sync_files failed", {
						appId,
						projectSlug,
						error: String(err),
					});
					sendResult({
						id: requestId,
						action: "sync-files",
						ok: false,
						error: String(err),
					});
				});
			return;
		}

		const paths = parseRelativePaths(message.paths);
		if (!paths) {
			sendResult({
				id: requestId,
				action: "read-files",
				ok: false,
				error: "invalid_paths",
			});
			return;
		}
		Logger.debug(TAG, "invoking courseware_read_files", {
			appId,
			projectSlug,
			pathCount: paths.length,
		});
		void invoke("courseware_read_files", {
			adkPath,
			projectSlug,
			paths,
		})
			.then((raw) => {
				const files = Array.isArray(raw)
					? raw
							.filter(isPlainObject)
							.map((entry) => ({
								path: String(entry.path ?? ""),
								content: String(entry.content ?? ""),
							}))
					: [];
				sendResult({
					id: requestId,
					action: "read-files",
					ok: true,
					files,
					data: files,
				});
			})
			.catch((err) => {
				Logger.warn(TAG, "courseware_read_files failed", {
					appId,
					projectSlug,
					error: String(err),
				});
				sendResult({
					id: requestId,
					action: "read-files",
					ok: false,
					error: String(err),
				});
			});
	};

	window.addEventListener("message", onMessage);
	return () => {
		disposed = true;
		window.removeEventListener("message", onMessage);
	};
}
