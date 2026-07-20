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
const webServerCommand = process.env.PLAYWRIGHT_SERVER_COMMAND || "pnpm dev";
const webServerTimeout = readPositiveIntegerEnv(
	"PLAYWRIGHT_WEB_SERVER_TIMEOUT",
	30_000,
);

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
		command: webServerCommand,
		port,
		reuseExistingServer: true,
		timeout: webServerTimeout,
	},
});
