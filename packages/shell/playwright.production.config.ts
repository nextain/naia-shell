import { defineConfig } from "@playwright/test";

const port = 1421;
const useExistingBuild = process.env.NAIA_E2E_USE_EXISTING_BUILD === "1";

export default defineConfig({
	testDir: "./e2e",
	testMatch: "deferred-chat-area.spec.ts",
	timeout: 60_000,
	expect: { timeout: 30_000 },
	fullyParallel: false,
	workers: 1,
	retries: 0,
	use: {
		storageState: {
			cookies: [],
			origins: [
				{
					origin: `http://localhost:${port}`,
					localStorage: [
						{
							name: "naia-usage-consent-v1",
							value: '{"enabled":false,"epoch":"e2e-opt-out"}',
						},
					],
				},
			],
		},
		baseURL: `http://localhost:${port}`,
		trace: "on-first-retry",
	},
	projects: [{ name: "chromium", use: { browserName: "chromium" } }],
	webServer: {
		command: `${useExistingBuild ? "" : "pnpm build && "}pnpm preview --host localhost --port ${port}`,
		port,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
