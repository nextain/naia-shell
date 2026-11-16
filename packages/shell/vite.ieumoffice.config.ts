import { existsSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	base: "./",
	plugins: [
		react(),
		{
			name: "naia-ieumoffice-strip-crossorigin",
			enforce: "post",
			transformIndexHtml(html) {
				return html.replace(/\s+crossorigin(=(["'][^"']*["']|\S+))?/g, "");
			},
		},
		{
			name: "naia-ieumoffice-package-index",
			closeBundle() {
				const source = resolve(__dirname, "dist-ieumoffice/ieumoffice.html");
				if (existsSync(source)) {
					renameSync(source, resolve(__dirname, "dist-ieumoffice/index.html"));
				}
			},
		},
	],
	publicDir: "src/apps/ieumoffice/package-public",
	build: {
		outDir: "dist-ieumoffice",
		emptyOutDir: true,
		rollupOptions: {
			input: { index: resolve(__dirname, "ieumoffice.html") },
		},
	},
});
