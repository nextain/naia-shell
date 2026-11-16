import { existsSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	base: "./",
	plugins: [
		react(),
		{
			name: "naia-blackjack-strip-crossorigin",
			enforce: "post",
			transformIndexHtml(html) {
				return html.replace(/\s+crossorigin(=(["'][^"']*["']|\S+))?/g, "");
			},
		},
		{
			name: "naia-blackjack-package-index",
			closeBundle() {
				const source = resolve(__dirname, "dist-blackjack/blackjack.html");
				if (existsSync(source)) {
					renameSync(source, resolve(__dirname, "dist-blackjack/index.html"));
				}
			},
		},
	],
	publicDir: "src/apps/blackjack/package-public",
	build: {
		outDir: "dist-blackjack",
		emptyOutDir: true,
		rollupOptions: {
			input: { index: resolve(__dirname, "blackjack.html") },
		},
	},
});
