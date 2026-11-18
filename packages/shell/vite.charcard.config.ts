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
			name: "naia-charcard-classic-script",
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
			output: {
				format: "iife",
				inlineDynamicImports: true,
			},
		},
	},
});
