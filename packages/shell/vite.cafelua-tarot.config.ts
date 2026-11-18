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
			name: "naia-cafelua-tarot-package-index",
			enforce: "post",
			transformIndexHtml(html) {
				return html
					.replace(/\s+crossorigin(=((["'][^"']*["'])|\S+))?/g, "")
					.replace(
						/<script\s+type=["']module["']\s+src=(["'][^"']+["'])\s*><\/script>/g,
						"<script defer src=$1></script>",
					);
			},
			closeBundle() {
				const source = resolve(
					__dirname,
					"dist-cafelua-tarot/cafelua-tarot.html",
				);
				if (existsSync(source))
					renameSync(
						source,
						resolve(__dirname, "dist-cafelua-tarot/index.html"),
					);
			},
		},
	],
	publicDir: "src/apps/cafelua-tarot/package-public",
	build: {
		outDir: "dist-cafelua-tarot",
		emptyOutDir: true,
		rollupOptions: {
			input: { "cafelua-tarot": resolve(__dirname, "cafelua-tarot.html") },
			output: {
				format: "iife",
				inlineDynamicImports: true,
			},
		},
	},
});
