/** Verify the extracted artifact, including the environment used before WebKit starts. */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
export function verifyAppImageMedia(root) {
	const plugins = [
		"app",
		"playback",
		"vpx",
		"videoconvertscale",
		"matroska",
		"typefindfunctions",
		"coreelements",
	];
	for (const plugin of plugins) {
		const path = resolve(root, `usr/lib/gstreamer-1.0/libgst${plugin}.so`);
		if (!existsSync(path))
			throw new Error(`AppImage missing GStreamer plugin: ${path}`);
	}
	if (
		!existsSync(
			resolve(root, "usr/lib/gstreamer1.0/gstreamer-1.0/gst-plugin-scanner"),
		)
	)
		throw new Error("AppImage missing bundled gst-plugin-scanner");
	const hook = readFileSync(
		resolve(root, "apprun-hooks/linuxdeploy-plugin-gstreamer.sh"),
		"utf8",
	);
	for (const key of [
		"GST_PLUGIN_SYSTEM_PATH_1_0",
		"GST_PLUGIN_PATH_1_0",
		"GST_PLUGIN_SCANNER_1_0",
	]) {
		if (!hook.includes("export " + key + '="${APPDIR}/usr/lib/'))
			throw new Error(`AppImage missing isolated ${key}`);
	}
	return plugins.length;
}
if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	console.log(
		`AppImage media verified: ${verifyAppImageMedia(resolve(process.argv[2]))} plugins + scanner + isolated hook`,
	);
}
