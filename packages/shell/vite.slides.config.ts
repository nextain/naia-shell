import { existsSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import packageJson from "./package.json";

export default defineConfig(({ mode }) => {
	const hosted = mode === "web";
	let outputDirectory = "";
	return {
		define: { __USAGE_VERSION__: JSON.stringify(packageJson.version) },
		base: "./",
		plugins: [
			react(),
			{
				// The standalone app always gets an empty private kiosk deck.
				name: "naia-slides-no-private-slides",
				resolveId(id: string) {
					if (id === "virtual:kiosk-private-slides") return `\0${id}`;
				},
				load(id: string) {
					if (id === "\0virtual:kiosk-private-slides") {
						return "export default { slides: [] };";
					}
				},
			},
			{
				name: "naia-slides-strip-crossorigin",
				enforce: "post",
				transformIndexHtml(html) {
					// Tauri's asset protocol does not answer CORS-mode fetches.
					const entry = html.replace(
						/\s+crossorigin(=(["'][^"']*["']|\S+))?/g,
						"",
					);
					// Classic script loading also works from an opaque-origin web iframe.
					return hosted
						? entry.replace(
								/<script type="module" src=("[^"]+")><\/script>/g,
								"<script defer src=$1></script>",
							)
						: entry;
				},
			},
			{
				name: "naia-slides-package-index",
				configResolved(config) {
					outputDirectory = resolve(config.root, config.build.outDir);
				},
				closeBundle() {
					const source = resolve(outputDirectory, "slides.html");
					if (existsSync(source)) {
						renameSync(source, resolve(outputDirectory, "index.html"));
					}
				},
			},
		],
		publicDir: "src/apps/slides/package-public",
		build: {
			outDir: "dist-slides",
			emptyOutDir: true,
			rollupOptions: {
				input: { index: resolve(__dirname, "slides.html") },
				...(hosted
					? { output: { format: "iife", inlineDynamicImports: true } }
					: {}),
			},
		},
	};
});
