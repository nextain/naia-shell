import { existsSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	base: "./",
	plugins: [
		react(),
		{
			name: "naia-nts-edu-helper-strip-crossorigin",
			enforce: "post",
			transformIndexHtml(html) {
				return html.replace(/\s+crossorigin(=(["'][^"']*["']|\S+))?/g, "");
			},
		},
		{
			name: "naia-nts-edu-helper-package-index",
			closeBundle() {
				const source = resolve(
					__dirname,
					"dist-nts-edu-helper/nts-edu-helper.html",
				);
				if (existsSync(source)) {
					renameSync(
						source,
						resolve(__dirname, "dist-nts-edu-helper/index.html"),
					);
				}
			},
		},
	],
	publicDir: "src/apps/nts-edu-helper/package-public",
	build: {
		outDir: "dist-nts-edu-helper",
		emptyOutDir: true,
		rollupOptions: {
			input: { index: resolve(__dirname, "nts-edu-helper.html") },
		},
	},
});
