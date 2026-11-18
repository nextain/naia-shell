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
			// The packaged Slides app loads inside a Tauri asset-protocol iframe
			// (convertFileSrc → http://asset.localhost/…). Vite tags its module
			// script/stylesheet with `crossorigin`, which forces a CORS-mode fetch
			// that the asset protocol does not answer with the required headers —
			// so the module never executes and `#root` stays blank (2026-08-31
			// rehearsal: installed Slides app rendered empty in real WebView2 while
			// the browser Playwright e2e passed). Strip `crossorigin`; the assets
			// are same-origin as the iframe document and need no CORS handshake.
			name: "naia-slides-strip-crossorigin",
			enforce: "post",
			transformIndexHtml(html) {
				return html.replace(/\s+crossorigin(=(["'][^"']*["']|\S+))?/g, "");
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
		},
	},
});
