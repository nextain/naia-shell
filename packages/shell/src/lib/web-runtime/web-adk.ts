import { Logger } from "../logger";
import { webAdkOpfsPath } from "./web-adk-path";
import {
	WEB_ADK_COMMIT,
	type WebAdkBundle,
} from "./web-adk-source";
import {
	getWebAdkStatus,
	setWebAdkStatus,
	type WebAdkStatus,
} from "./web-adk-status";
import type { WebFs } from "./web-fs";

export function decodeBase64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

export async function gitBlobSha1(bytes: Uint8Array): Promise<string> {
	const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
	const full = new Uint8Array(header.byteLength + bytes.byteLength);
	full.set(header, 0);
	full.set(bytes, header.byteLength);
	const digest = await crypto.subtle.digest("SHA-1", full);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export interface ProvisionWebAdkDeps {
	fs: WebFs;
	fetch?: (
		url: string,
	) => Promise<{
		ok: boolean;
		status: number;
		json(): Promise<unknown>;
	}>;
	baseUrl?: string;
	onProgress?: (done: number, total: number) => void;
}

export type ProvisionWebAdkResult =
	| { ok: true; written: string[] }
	| { ok: false; failed: { path: string; reason: string }[] };

export async function provisionWebAdk(
	deps: ProvisionWebAdkDeps,
): Promise<ProvisionWebAdkResult> {
	const markerPath = webAdkOpfsPath("naia-settings/.web-adk-source.json");
	const baseUrl =
		deps.baseUrl ??
		(typeof import.meta !== "undefined" && import.meta.env?.BASE_URL
			? import.meta.env.BASE_URL
			: "/");
	const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
	const bundleUrl = `${normalizedBase}web-adk/${WEB_ADK_COMMIT}.json`;
	const fetcher = deps.fetch ?? ((u: string) => fetch(u));

	try {
		const res = await fetcher(bundleUrl);
		if (!res.ok) {
			const reason = `http_${res.status}`;
			Logger.error("WebAdk", "bundle fetch failed", { url: bundleUrl, status: res.status });
			return {
				ok: false,
				failed: [{ path: bundleUrl, reason }],
			};
		}

		const bundle = (await res.json()) as WebAdkBundle;
		if (!bundle || !Array.isArray(bundle.files)) {
			return {
				ok: false,
				failed: [{ path: bundleUrl, reason: "invalid_bundle_format" }],
			};
		}

		// Reject duplicate paths within the bundle
		const seenPaths = new Set<string>();
		for (const file of bundle.files) {
			if (seenPaths.has(file.path)) {
				Logger.error("WebAdk", "duplicate path in bundle", { path: file.path });
				return {
					ok: false,
					failed: [{ path: file.path, reason: "duplicate_path" }],
				};
			}
			seenPaths.add(file.path);
		}

		if (Array.isArray(bundle.dirs)) {
			for (const dir of bundle.dirs) {
				await deps.fs.ensureDir(webAdkOpfsPath(dir));
			}
		}

		const total = bundle.files.length;
		let done = 0;
		deps.onProgress?.(0, total);

		const written: string[] = [];

		for (const file of bundle.files) {
			const targetPath = webAdkOpfsPath(file.path);
			const exists = await deps.fs.exists(targetPath);
			if (exists) {
				done++;
				deps.onProgress?.(done, total);
				continue;
			}

			if (typeof file.base64 !== "string") {
				return {
					ok: false,
					failed: [{ path: file.path, reason: "missing_content" }],
				};
			}

			const bytes = decodeBase64ToBytes(file.base64);
			if (bytes.byteLength !== file.size) {
				Logger.error("WebAdk", "size mismatch", {
					path: file.path,
					expected: file.size,
					actual: bytes.byteLength,
				});
				return {
					ok: false,
					failed: [{ path: file.path, reason: "size_mismatch" }],
				};
			}

			const sha1 = await gitBlobSha1(bytes);
			if (sha1 !== file.sha1) {
				Logger.error("WebAdk", "sha1 mismatch", {
					path: file.path,
					expected: file.sha1,
					actual: sha1,
				});
				return {
					ok: false,
					failed: [{ path: file.path, reason: "sha1_mismatch" }],
				};
			}

			await deps.fs.writeBytes(targetPath, bytes);
			written.push(file.path);
			done++;
			deps.onProgress?.(done, total);
		}

		const markerData = {
			source: "bundle",
			repo: bundle.repo,
			commit: bundle.commit,
			fileCount: bundle.files.length,
		};
		await deps.fs.writeBytes(markerPath, JSON.stringify(markerData, null, 2));
		return { ok: true, written };
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		Logger.error("WebAdk", "provisioning exception", { error: message });
		return {
			ok: false,
			failed: [{ path: bundleUrl, reason: message }],
		};
	}
}

export interface CheckWebAdkStartupDeps {
	fs?: WebFs;
	fetch?: (
		url: string,
	) => Promise<{
		ok: boolean;
		status: number;
		json(): Promise<unknown>;
	}>;
	baseUrl?: string;
}

export async function checkWebAdkStartup(
	deps: CheckWebAdkStartupDeps = {},
): Promise<WebAdkStatus> {
	setWebAdkStatus({ phase: "checking" });

	const fs = deps.fs ?? (await import("./web-fs")).getWebFs();
	const markerPath = webAdkOpfsPath("naia-settings/.web-adk-source.json");

	let marker: Record<string, unknown> | null = null;
	try {
		const text = await fs.readText(markerPath);
		if (text) {
			const parsed = JSON.parse(text);
			if (parsed && typeof parsed === "object") {
				marker = parsed;
			}
		}
	} catch {
		marker = null;
	}

	const agentsMdExists = await fs.exists(webAdkOpfsPath("AGENTS.md"));

	// Case 1: marker has source: "bundle" and matching commit -> ready
	if (marker && marker.source === "bundle" && marker.commit === WEB_ADK_COMMIT) {
		setWebAdkStatus({ phase: "ready" });
		return getWebAdkStatus();
	}

	// Case 2: existing workspace needing fill
	// - marker has source: "bundle" and commit differs
	// - OR marker exists without source field (round 2 style, even if commit matches)
	// - OR no marker, but AGENTS.md exists
	const isExistingWorkspace =
		(marker && marker.source === "bundle" && marker.commit !== WEB_ADK_COMMIT) ||
		(marker && !marker.source) ||
		(!marker && agentsMdExists);

	if (isExistingWorkspace) {
		setWebAdkStatus({ phase: "installing", done: 0, total: 0 });
		const result = await provisionWebAdk({
			fs,
			fetch: deps.fetch,
			baseUrl: deps.baseUrl,
			onProgress: (done, total) => {
				setWebAdkStatus({ phase: "installing", done, total });
			},
		});

		if (result.ok) {
			setWebAdkStatus({ phase: "ready" });
		} else {
			const reason = result.failed[0]?.reason ?? "provision_failed";
			setWebAdkStatus({ phase: "error", reason });
		}
		return getWebAdkStatus();
	}

	// Case 3: neither marker nor AGENTS.md -> needs-setup (even if config.json exists)
	setWebAdkStatus({ phase: "needs-setup" });
	return getWebAdkStatus();
}

export async function installDefaultWebAdk(
	deps: ProvisionWebAdkDeps,
): Promise<ProvisionWebAdkResult> {
	setWebAdkStatus({ phase: "installing", done: 0, total: 0 });
	const result = await provisionWebAdk({
		...deps,
		onProgress: (done, total) => {
			setWebAdkStatus({ phase: "installing", done, total });
			deps.onProgress?.(done, total);
		},
	});

	if (result.ok) {
		setWebAdkStatus({ phase: "ready" });
	} else {
		const reason = result.failed[0]?.reason ?? "provision_failed";
		setWebAdkStatus({ phase: "error", reason });
	}

	return result;
}
