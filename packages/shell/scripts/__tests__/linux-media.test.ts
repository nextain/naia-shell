import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { verifyAppImageMedia } from "../verify-appimage-media.mjs";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateConf } from "../stage-runtime.mjs";
const matrix = JSON.parse(
	readFileSync(
		new URL("../../src-tauri/platform-matrix.json", import.meta.url),
		"utf8",
	),
);
const conf = generateConf(matrix, "linux");
const workflow = readFileSync(
	new URL(
		"../../../../.github/workflows/build-installers.yml",
		import.meta.url,
	),
	"utf8",
);
describe("Linux media bundle", () => {
	it("enables the Tauri GStreamer plugin and its isolated AppRun environment", () => {
		expect(conf.bundle.linux?.appimage?.bundleMediaFramework).toBe(true);
	});
	it("installs codec plugins and checks the extracted AppImage", () => {
		expect(workflow).toContain("gstreamer1.0-plugins-base");
		expect(workflow).toContain("gstreamer1.0-plugins-good");
		expect(workflow).toContain("verify-appimage-media.mjs");
	});
});

it("rejects absent plugins and an environment that loads host plugins", () => {
	const root = mkdtempSync(join(tmpdir(), "r15-media-"));
	try {
		expect(() => verifyAppImageMedia(root)).toThrow("missing GStreamer plugin");
		mkdirSync(join(root, "usr/lib/gstreamer-1.0"), { recursive: true });
		for (const plugin of [
			"app",
			"playback",
			"vpx",
			"videoconvertscale",
			"matroska",
			"typefindfunctions",
			"coreelements",
		])
			writeFileSync(
				join(root, `usr/lib/gstreamer-1.0/libgst${plugin}.so`),
				"fixture",
			);
		mkdirSync(join(root, "usr/lib/gstreamer1.0/gstreamer-1.0"), {
			recursive: true,
		});
		writeFileSync(
			join(root, "usr/lib/gstreamer1.0/gstreamer-1.0/gst-plugin-scanner"),
			"fixture",
		);
		mkdirSync(join(root, "apprun-hooks"));
		const hook = join(root, "apprun-hooks/linuxdeploy-plugin-gstreamer.sh");
		writeFileSync(hook, 'export GST_PLUGIN_PATH_1_0="/usr/lib/gstreamer-1.0"');
		expect(() => verifyAppImageMedia(root)).toThrow("missing isolated");
		writeFileSync(
			hook,
			[
				"GST_PLUGIN_SYSTEM_PATH_1_0",
				"GST_PLUGIN_PATH_1_0",
				"GST_PLUGIN_SCANNER_1_0",
			]
				.map((key) => "export " + key + '="${APPDIR}/usr/lib/test"')
				.join("\n"),
		);
		expect(verifyAppImageMedia(root)).toBe(7);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
