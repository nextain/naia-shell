import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	applyNaiaInstanceEnv,
	naiaLaunchMode,
	resolveLabGatewayUrl,
	resolveNaiaInstance,
} from "../naia-instance-urls";

describe("canonical Naia instance URLs", () => {
	it("maps tauri:dev to dev.naia.land and api-dev.naia.land", () => {
		expect(resolveNaiaInstance("dev")).toEqual({
			web: "https://dev.naia.land",
			api: "https://api-dev.naia.land",
		});
	});

	it("maps tauri:prod to www.naia.land and the prod gateway", () => {
		expect(resolveNaiaInstance("prod")).toEqual({
			web: "https://www.naia.land",
			api: "https://api.nextain.io",
		});
	});

	it("treats the explicit dev-gateway flag as the instance", () => {
		expect(naiaLaunchMode({ useDevGateway: "1" })).toBe("dev");
		expect(
			naiaLaunchMode({
				useDevGateway: "0",
				webBaseUrl: "https://www.naia.land",
			}),
		).toBe("prod");
	});

	it("does not fall a flagged-dev instance back to prod API when the URL is empty", () => {
		expect(
			resolveLabGatewayUrl({
				useDevGateway: "1",
				devGatewayUrl: "",
				prodGatewayUrl: "https://api.nextain.io",
			}),
		).toBe("https://api-dev.naia.land");
	});

	it("aligns Agent env with the same API credit fetch uses", () => {
		const fromProdShell = applyNaiaInstanceEnv(
			{
				NAIA_ANYLLM_BASE_URL: "https://api.nextain.io",
				NAIA_GATEWAY_URL: "https://api.nextain.io",
				VITE_NAIA_DEV_GATEWAY_URL: "",
			},
			"dev",
		);
		expect(fromProdShell.VITE_NAIA_USE_DEV_GATEWAY).toBe("1");
		expect(fromProdShell.VITE_NAIA_WEB_BASE_URL).toBe("https://dev.naia.land");
		expect(fromProdShell.VITE_NAIA_DEV_GATEWAY_URL).toBe(
			"https://api-dev.naia.land",
		);
		expect(fromProdShell.NAIA_ANYLLM_BASE_URL).toBe(
			"https://api-dev.naia.land",
		);
		expect(fromProdShell.NAIA_GATEWAY_URL).toBe("https://api-dev.naia.land");
	});

	it("keeps a nonempty local gateway override for tauri:dev", () => {
		const env = applyNaiaInstanceEnv(
			{ VITE_NAIA_DEV_GATEWAY_URL: "http://127.0.0.1:8000" },
			"dev",
		);
		expect(env.VITE_NAIA_DEV_GATEWAY_URL).toBe("http://127.0.0.1:8000");
		expect(env.NAIA_ANYLLM_BASE_URL).toBe("http://127.0.0.1:8000");
	});

	it("keeps the launch script catalog identical to the UI helper", () => {
		const srcRoot = dirname(fileURLToPath(import.meta.url));
		const helper = readFileSync(
			resolve(srcRoot, "../naia-instance-urls.ts"),
			"utf8",
		);
		const launch = readFileSync(
			resolve(srcRoot, "../../../scripts/naia-instance-urls.mjs"),
			"utf8",
		);
		for (const host of [
			"https://dev.naia.land",
			"https://api-dev.naia.land",
			"https://www.naia.land",
			"https://api.nextain.io",
		]) {
			expect(helper).toContain(host);
			expect(launch).toContain(host);
		}
	});
});
