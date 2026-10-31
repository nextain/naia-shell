import { existsSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	base: "./",
	plugins: [
		react(),
		{
			name: "naia-cafelua-tarot-package-index",
			enforce: "post",
			transformIndexHtml(html) {
				return html.replace(/\s+crossorigin(=((["'][^"']*["'])|\S+))?/g, "");
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
		},
	},
});
