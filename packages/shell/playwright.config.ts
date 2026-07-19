import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./e2e",
	timeout: 60_000,
	expect: {
		timeout: 30_000,
	},
	fullyParallel: false,
	// Media-clock sync probes are load-sensitive on this laptop; keep E2E deterministic.
	workers: 1,
	retries: 0,
	use: {
		baseURL: "http://localhost:1420",
		trace: "on-first-retry",
	},
	projects: [
		{
			name: "chromium",
			use: { browserName: "chromium" },
		},
	],
	webServer: {
		command: "pnpm dev",
		port: 1420,
		reuseExistingServer: true,
		timeout: 30_000,
	},
});
