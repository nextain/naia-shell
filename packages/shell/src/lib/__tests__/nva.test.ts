import { describe, expect, it } from "vitest";
import { parseNvaManifest, resolveNvaAssetPath } from "../nva";

describe("NVA manifest contract", () => {
	it("parses a v1 video avatar bundle manifest", () => {
		const manifest = parseNvaManifest(
			JSON.stringify({
				schemaVersion: "naia-video-avatar/v1",
				name: "Alpha Real Video",
				defaultClip: "idle",
				clips: {
					idle: {
						video: "clips/idle.mp4",
						mask: "clips/idle-mask.png",
						width: 720,
						height: 1280,
						fps: 24,
						durationSec: 10,
					},
				},
			}),
		);

		expect(manifest.clips[manifest.defaultClip].video).toBe("clips/idle.mp4");
		expect(manifest.clips.idle.mask).toBe("clips/idle-mask.png");
	});

	it("rejects manifests without a default video clip", () => {
		expect(() =>
			parseNvaManifest(
				JSON.stringify({
					schemaVersion: "naia-video-avatar/v1",
					name: "Broken",
					defaultClip: "idle",
					clips: { idle: {} },
				}),
			),
		).toThrow(/default clip/);
	});

	it("resolves clip paths inside the extracted bundle directory", () => {
		expect(resolveNvaAssetPath("D:\\alpha\\naia-settings\\nva-files\\alpha", "clips/idle.mp4")).toBe(
			"D:\\alpha\\naia-settings\\nva-files\\alpha\\clips\\idle.mp4",
		);
	});

	it("blocks path traversal in clip paths", () => {
		expect(() => resolveNvaAssetPath("/adk/nva/alpha", "../secret.mp4")).toThrow(
			/Invalid NVA asset path/,
		);
	});
});
