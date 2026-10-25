import { existsSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	base: "./",
	plugins: [
		react(),
		{
			// The packaged Character Card app loads inside a Tauri asset-protocol
			// iframe (convertFileSrc → http://asset.localhost/…). Strip `crossorigin`
			// so module scripts and stylesheets load cleanly without a CORS handshake.
			name: "naia-charcard-strip-crossorigin",
			enforce: "post",
			transformIndexHtml(html) {
				return html.replace(/\s+crossorigin(=(["'][^"']*["']|\S+))?/g, "");
			},
		},
		{
			name: "naia-charcard-package-index",
			closeBundle() {
				const source = resolve(__dirname, "dist-charcard/charcard.html");
				if (existsSync(source)) {
					renameSync(source, resolve(__dirname, "dist-charcard/index.html"));
				}
			},
		},
	],
	publicDir: "src/apps/charcard/package-public",
	build: {
		outDir: "dist-charcard",
		emptyOutDir: true,
		rollupOptions: {
			input: { index: resolve(__dirname, "charcard.html") },
		},
	},
});
