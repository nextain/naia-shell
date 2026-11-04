import { defineConfig } from "@playwright/test";

function readPositiveIntegerEnv(
	name: string,
	fallback: number,
	options: { max?: number } = {},
): number {
	const rawValue = process.env[name];
	if (rawValue === undefined || rawValue === "") {
		return fallback;
	}

	const value = Number(rawValue);
	if (
		!Number.isInteger(value) ||
		value <= 0 ||
		(options.max !== undefined && value > options.max)
	) {
		throw new Error(
			`${name} must be a positive integer${options.max !== undefined ? ` <= ${options.max}` : ""}`,
		);
	}

	return value;
}

const port = readPositiveIntegerEnv("PLAYWRIGHT_PORT", 1420, { max: 65534 });
const host = process.env.PLAYWRIGHT_HOST || "localhost";
const baseURL = process.env.PLAYWRIGHT_BASE_URL || `http://${host}:${port}`;
const webServerCommand =
	process.env.PLAYWRIGHT_SERVER_COMMAND || "pnpm -w build && pnpm dev";
const reuseExistingServer =
	process.env.PLAYWRIGHT_REUSE_EXISTING_SERVER === "1";
const webServerTimeout = readPositiveIntegerEnv(
	"PLAYWRIGHT_WEB_SERVER_TIMEOUT",
	30_000,
);

export default defineConfig({
	testDir: "./e2e",
	testIgnore: "deferred-chat-area.spec.ts",
	timeout: 60_000,
	expect: {
		timeout: 30_000,
	},
	fullyParallel: false,
	// Media-clock sync probes are load-sensitive on this laptop; keep E2E deterministic.
	workers: 1,
	retries: 0,
	use: {
		// Unrelated scenarios decline optional telemetry; consent tests override this state.
		storageState: {
			cookies: [],
			origins: [
				{
					origin: baseURL,
					localStorage: [
						{
							name: "naia-usage-consent-v1",
							value: '{"enabled":false,"epoch":"e2e-opt-out"}',
						},
					],
				},
			],
		},
		baseURL,
		trace: "on-first-retry",
	},
	projects: [
		{
			name: "chromium",
			use: { browserName: "chromium" },
		},
	],
	webServer: {
		// Only the E2E dev server receives this synthetic key. usage-events.spec.ts
		// intercepts the matching endpoint; installer/production builds stay unconfigured.
		env: {
			VITE_APPLICATIONINSIGHTS_CONNECTION_STRING:
				"InstrumentationKey=00000000-0000-4000-8000-000000000001;IngestionEndpoint=https://test.applicationinsights.azure.com/",
		},
		command: webServerCommand,
		port,
		// A server from another checkout can return a perfectly valid page while
		// exercising the wrong revision. Reuse is therefore an explicit local
		// optimization, never the default test contract.
		reuseExistingServer,
		timeout: webServerTimeout,
	},
});
