import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
	plugins: [react()],
	define: {
		__BUILD_ID__: JSON.stringify(
			new Date().toISOString().replace(/[-:]/g, "").slice(0, 15),
		),
	},
	test: {
		exclude: [
			"e2e/**",
			"e2e-tauri/**",
			"node_modules/**",
			"src-tauri/target/**",
		],
		setupFiles: ["./vitest.setup.ts"],
		// Run test files sequentially. Several panel suites time out or leak shared
		// state when many files run in parallel under load (they pass individually
		// and with --no-file-parallelism); sequential keeps the suite green.
		fileParallelism: false,
		testTimeout: 15000,
	},
	clearScreen: false,
	server: {
		port: 1420,
		strictPort: true,
		host: host || false,
		hmr: host
			? {
					protocol: "ws",
					host,
					port: 1421,
				}
			: undefined,
		watch: {
			ignored: ["**/src-tauri/**"],
		},
	},
	resolve: {
		alias: {
			"@": "/src",
		},
	},
}));
