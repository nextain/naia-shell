import { Logger } from "../logger";
import { webAdkOpfsPath } from "./web-adk-path";
import type { WebFs } from "./web-fs";

export const DEFAULT_WEB_ADK_BASE =
	"https://raw.githubusercontent.com/nextain/naia-adk/13ea427991542965091f2f3211b9325a36dbd522/";

export interface WebAdkFileSpec {
	path: string;
	size: number;
	sha1: string;
}

export interface WebAdkSource {
	repo: string;
	commit: string;
	files: readonly WebAdkFileSpec[];
	dirs: readonly string[];
}

export const WEB_ADK_SOURCE: WebAdkSource = {
	repo: "nextain/naia-adk",
	commit: "13ea427991542965091f2f3211b9325a36dbd522",
	files: [
		{
			path: "AGENTS.md",
			size: 3860,
			sha1: "29350557ec7bef5b9f67ad4ddc26a06a8d6e2de0",
		},
		{
			path: "CLAUDE.md",
			size: 11,
			sha1: "43c994c2d3617f947bcb5adf1933e21dabe46bb5",
		},
	],
	dirs: ["projects/naia-template-project"],
};

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
	fetch: (
		url: string,
	) => Promise<{
		ok: boolean;
		status: number;
		arrayBuffer(): Promise<ArrayBuffer>;
	}>;
	base: string;
	source?: WebAdkSource;
}

export type ProvisionWebAdkResult =
	| { ok: true; written: string[] }
	| { ok: false; failed: { path: string; reason: string }[] };

export async function provisionWebAdk(
	deps: ProvisionWebAdkDeps,
): Promise<ProvisionWebAdkResult> {
	const source = deps.source ?? WEB_ADK_SOURCE;
	const markerPath = webAdkOpfsPath("naia-settings/.web-adk-source.json");

	try {
		const existingMarker = await deps.fs.readText(markerPath);
		if (existingMarker) {
			try {
				const parsed = JSON.parse(existingMarker);
				if (parsed && parsed.commit === source.commit) {
					return { ok: true, written: [] };
				}
			} catch {
				// marker invalid, proceed with provisioning
			}
		}

		for (const dir of source.dirs) {
			await deps.fs.ensureDir(webAdkOpfsPath(dir));
		}

		const base = deps.base.endsWith("/") ? deps.base : `${deps.base}/`;
		const written: string[] = [];
		const failed: { path: string; reason: string }[] = [];

		for (const file of source.files) {
			const targetPath = webAdkOpfsPath(file.path);
			const exists = await deps.fs.exists(targetPath);
			if (exists) {
				continue;
			}

			const url = `${base}${file.path}`;
			try {
				const res = await deps.fetch(url);
				if (!res.ok) {
					failed.push({ path: file.path, reason: `http_${res.status}` });
					continue;
				}
				const ab = await res.arrayBuffer();
				const bytes = new Uint8Array(ab);
				if (bytes.byteLength !== file.size) {
					failed.push({ path: file.path, reason: "size_mismatch" });
					continue;
				}
				const sha1 = await gitBlobSha1(bytes);
				if (sha1 !== file.sha1) {
					failed.push({ path: file.path, reason: "sha1_mismatch" });
					continue;
				}
				await deps.fs.writeBytes(targetPath, bytes);
				written.push(file.path);
			} catch (e) {
				failed.push({
					path: file.path,
					reason: e instanceof Error ? e.message : String(e),
				});
			}
		}

		if (failed.length > 0) {
			for (const f of failed) {
				Logger.error("WebAdk", "provision failed", {
					path: f.path,
					reason: f.reason,
				});
			}
			return { ok: false, failed };
		}

		const markerData = {
			repo: source.repo,
			commit: source.commit,
			files: source.files.map((f) => f.path),
			dirs: [...source.dirs],
		};
		await deps.fs.writeBytes(markerPath, JSON.stringify(markerData, null, 2));
		return { ok: true, written };
	} catch (e) {
		Logger.error("WebAdk", "provision failed", {
			path: markerPath,
			reason: e instanceof Error ? e.message : String(e),
		});
		return {
			ok: false,
			failed: [
				{
					path: markerPath,
					reason: e instanceof Error ? e.message : String(e),
				},
			],
		};
	}
}
