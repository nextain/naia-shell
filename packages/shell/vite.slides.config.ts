import { existsSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import packageJson from "./package.json";

export default defineConfig({
	define: { __USAGE_VERSION__: JSON.stringify(packageJson.version) },
	base: "./",
	plugins: [
		react(),
		{
			// Classic <script defer> + IIFE avoids CORS preflight/Origin:null blocks in
			// both Tauri asset.localhost iframes and Web App Store opaque sandboxes.
			name: "naia-slides-classic-script",
			enforce: "post",
			transformIndexHtml(html) {
				return html
					.replace(/\s+crossorigin(=(["'][^"']*["']|\S+))?/g, "")
					.replace(
						/<script\s+type=["']module["']\s+src=(["'][^"']+["'])\s*><\/script>/g,
						"<script defer src=$1></script>",
					);
			},
		},
		{
			name: "naia-slides-package-index",
			closeBundle() {
				const source = resolve(__dirname, "dist-slides/slides.html");
				if (existsSync(source)) {
					renameSync(source, resolve(__dirname, "dist-slides/index.html"));
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
			output: {
				format: "iife",
				inlineDynamicImports: true,
			},
		},
	},
});
