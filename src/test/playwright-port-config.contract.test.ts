import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_KEYS = [
	"PLAYWRIGHT_PORT",
	"PLAYWRIGHT_HOST",
	"PLAYWRIGHT_BASE_URL",
	"PLAYWRIGHT_SERVER_COMMAND",
	"PLAYWRIGHT_WEB_SERVER_TIMEOUT",
	"TAURI_DEV_HOST",
] as const;

let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>>;

function restoreEnv() {
	for (const key of ENV_KEYS) {
		const value = savedEnv[key];
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
}

beforeEach(() => {
	savedEnv = {};
	for (const key of ENV_KEYS) {
		savedEnv[key] = process.env[key];
	}
	vi.resetModules();
});

afterEach(() => {
	restoreEnv();
	vi.resetModules();
});

async function loadViteServerConfig(port: string) {
	vi.resetModules();
	process.env.PLAYWRIGHT_PORT = port;
	process.env.PLAYWRIGHT_HOST = "127.0.0.1";
	delete process.env.TAURI_DEV_HOST;

	const module = await import("../../packages/shell/vite.config.ts");
	const configFactory = module.default as unknown;
	const config =
		typeof configFactory === "function"
			? await configFactory({ command: "serve", mode: "test", isSsrBuild: false, isPreview: false })
			: configFactory;
	return (config as { server?: { port?: number; hmr?: { port?: number } } }).server;
}

async function loadPlaywrightConfig(port: string) {
	vi.resetModules();
	process.env.PLAYWRIGHT_PORT = port;
	process.env.PLAYWRIGHT_HOST = "127.0.0.1";
	process.env.PLAYWRIGHT_SERVER_COMMAND = "node -e \"setTimeout(()=>{}, 1000)\"";

	const module = await import("../../packages/shell/playwright.config.ts");
	return module.default as {
		use?: { baseURL?: string };
		webServer?: { port?: number };
	};
}

describe("shell Playwright port config", () => {
	it("loads Vite at the highest valid Playwright port and keeps HMR in range", async () => {
		const server = await loadViteServerConfig("65534");
		expect(server?.port).toBe(65534);
		expect(server?.hmr?.port).toBe(65535);
	});

	it("rejects a Playwright port that would overflow the Vite HMR port", async () => {
		await expect(loadViteServerConfig("65535")).rejects.toThrow(
			"PLAYWRIGHT_PORT must be a positive integer <= 65534",
		);
	});

	it("uses the same maximum in the Playwright webServer config", async () => {
		const config = await loadPlaywrightConfig("65534");
		expect(config.webServer?.port).toBe(65534);
		expect(config.use?.baseURL).toBe("http://127.0.0.1:65534");

		await expect(loadPlaywrightConfig("65535")).rejects.toThrow(
			"PLAYWRIGHT_PORT must be a positive integer <= 65534",
		);
	});
});
