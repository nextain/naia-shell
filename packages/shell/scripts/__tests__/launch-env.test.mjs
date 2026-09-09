import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";
import { loadEnv } from "vite";

import { interactiveLaunchEnv } from "../launch-env.mjs";

function withViteProcessEnv(next, callback) {
	const previous = Object.fromEntries(
		Object.entries(process.env).filter(([key]) => key.startsWith("VITE_")),
	);
	for (const key of Object.keys(previous)) delete process.env[key];
	Object.assign(process.env, next);
	try {
		return callback();
	} finally {
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("VITE_")) delete process.env[key];
		}
		Object.assign(process.env, previous);
	}
}

test("interactive launch removes native E2E workspace overrides", () => {
	const source = {
		PATH: "C:/Windows/System32",
		CAFE_DEBUG_E2E: "1",
		NAIA_E2E_ADK_PATH: "C:/tmp/e2e/workspace",
		NAIA_E2E_RUNTIME_DIR: "C:/tmp/e2e/runtime",
		VITE_NAIA_E2E_ADK_PATH: "C:/tmp/e2e/workspace",
		VITE_NAIA_E2E_AUTOCHAT: "1",
		TAURI_WEBDRIVER_PORT: "4450",
		WEBVIEW2_USER_DATA_FOLDER: "C:/tmp/e2e/webview2",
		NAIA_AGENT_SCRIPT: "C:/paired/agent.mjs",
	};

	const actual = interactiveLaunchEnv(source);

	expect(actual).toEqual({
		PATH: "C:/Windows/System32",
		NAIA_AGENT_SCRIPT: "C:/paired/agent.mjs",
	});
	expect(source.NAIA_E2E_ADK_PATH).toBe("C:/tmp/e2e/workspace");
});

test("interactive launch preserves user and paired-runtime settings", () => {
	const actual = interactiveLaunchEnv({
		NAIA_PROD_KEY: "secret",
		NAIA_AGENT_SCRIPT: "C:/paired/agent.mjs",
		NAIA_AGENT_PROTO_DIR: "C:/paired/grpc",
		NAIA_CASCADE_LOADER_DIR: "C:/cascade",
		VITE_NAIA_NEW_CORE: "1",
	});

	expect(actual.NAIA_PROD_KEY).toBe("secret");
	expect(actual.NAIA_AGENT_SCRIPT).toBe("C:/paired/agent.mjs");
	expect(actual.NAIA_AGENT_PROTO_DIR).toBe("C:/paired/grpc");
	expect(actual.NAIA_CASCADE_LOADER_DIR).toBe("C:/cascade");
	expect(actual.VITE_NAIA_NEW_CORE).toBe("1");
});

test("Vite .env.local can reintroduce prod dev gateway before finalization", () => {
	const envDir = mkdtempSync(join(tmpdir(), "naia-launch-env-"));
	try {
		writeFileSync(
			join(envDir, ".env.local"),
			"VITE_NAIA_USE_DEV_GATEWAY=1\nVITE_NAIA_DEV_GATEWAY_URL=https://dev.example.invalid\n",
		);
		writeFileSync(
			join(envDir, ".env.prod"),
			"VITE_NAIA_WEB_BASE_URL=https://www.example.invalid\n",
		);

		const fileEnv = withViteProcessEnv({}, () =>
			loadEnv("prod", envDir, "VITE_"),
		);
		expect(fileEnv.VITE_NAIA_USE_DEV_GATEWAY).toBe("1");
		expect(fileEnv.VITE_NAIA_DEV_GATEWAY_URL).toBe(
			"https://dev.example.invalid",
		);
	} finally {
		rmSync(envDir, { recursive: true, force: true });
	}
});

test("prod finalization wins Vite file values while dev keeps its gateway", () => {
	const envDir = mkdtempSync(join(tmpdir(), "naia-launch-env-"));
	try {
		writeFileSync(
			join(envDir, ".env.local"),
			"VITE_NAIA_USE_DEV_GATEWAY=1\nVITE_NAIA_DEV_GATEWAY_URL=https://dev.example.invalid\n",
		);
		writeFileSync(
			join(envDir, ".env.prod"),
			"VITE_NAIA_WEB_BASE_URL=https://www.example.invalid\n",
		);

		const rawProdEnv = withViteProcessEnv({}, () =>
			loadEnv("prod", envDir, "VITE_"),
		);
		const prodEnv = interactiveLaunchEnv(rawProdEnv, "prod");
		const resolvedProdEnv = withViteProcessEnv(prodEnv, () =>
			loadEnv("prod", envDir, "VITE_"),
		);
		expect(resolvedProdEnv.VITE_NAIA_USE_DEV_GATEWAY).toBe("0");
		expect(resolvedProdEnv.VITE_NAIA_DEV_GATEWAY_URL).toBe("");
		expect(resolvedProdEnv.VITE_NAIA_WEB_BASE_URL).toBe(
			"https://www.example.invalid",
		);

		const devEnv = interactiveLaunchEnv(
			{
				VITE_NAIA_USE_DEV_GATEWAY: "1",
				VITE_NAIA_DEV_GATEWAY_URL: "https://dev.example.invalid",
			},
			"dev",
		);
		const resolvedDevEnv = withViteProcessEnv(devEnv, () =>
			loadEnv("dev", envDir, "VITE_"),
		);
		expect(resolvedDevEnv.VITE_NAIA_USE_DEV_GATEWAY).toBe("1");
		expect(resolvedDevEnv.VITE_NAIA_DEV_GATEWAY_URL).toBe(
			"https://dev.example.invalid",
		);
	} finally {
		rmSync(envDir, { recursive: true, force: true });
	}
});
