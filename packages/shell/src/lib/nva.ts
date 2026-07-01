export interface NvaClip {
	video: string;
	mask?: string;
	durationSec?: number;
	width?: number;
	height?: number;
	fps?: number;
}

export interface NvaManifest {
	schemaVersion: "naia-video-avatar/v1";
	name: string;
	defaultClip: string;
	clips: Record<string, NvaClip>;
}

export function parseNvaManifest(raw: string): NvaManifest {
	const parsed = JSON.parse(raw) as Partial<NvaManifest>;
	if (parsed.schemaVersion !== "naia-video-avatar/v1") {
		throw new Error("Unsupported NVA manifest schema");
	}
	if (!parsed.name || !parsed.defaultClip || !parsed.clips) {
		throw new Error("Invalid NVA manifest");
	}
	const clip = parsed.clips[parsed.defaultClip];
	if (!clip?.video) {
		throw new Error("NVA default clip is missing a video");
	}
	return parsed as NvaManifest;
}

export function resolveNvaAssetPath(bundleDir: string, relativePath: string): string {
	if (!relativePath || relativePath.includes("..")) {
		throw new Error("Invalid NVA asset path");
	}
	const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
	const sep = bundleDir.includes("\\") ? "\\" : "/";
	return `${bundleDir.replace(/[/\\]+$/, "")}${sep}${normalized.replace(/\//g, sep)}`;
}
