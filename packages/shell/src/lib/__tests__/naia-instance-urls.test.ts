import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	applyNaiaInstanceEnv,
	NAIA_INSTANCE_URLS,
	naiaLaunchMode,
	naiaWebUrl,
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

	it("treats the explicit dev-gateway flag as the instance, not Vite DEV", () => {
		expect(
			naiaLaunchMode({ useDevGateway: "1", viteDev: true }),
		).toBe("dev");
		expect(
			naiaLaunchMode({
				useDevGateway: "0",
				webBaseUrl: "https://www.naia.land",
				viteDev: true,
			}),
		).toBe("prod");
	});

	it("does not fall a flagged-dev instance back to prod API when the URL is empty", () => {
		const env = applyNaiaInstanceEnv({}, "dev");
		expect(env.VITE_NAIA_USE_DEV_GATEWAY).toBe("1");
		expect(env.VITE_NAIA_WEB_BASE_URL).toBe("https://dev.naia.land");
		expect(env.VITE_NAIA_DEV_GATEWAY_URL).toBe("https://api-dev.naia.land");
	});

	it("joins web paths against the instance base", () => {
		expect(naiaWebUrl("/ko/billing", NAIA_INSTANCE_URLS.dev.web)).toBe(
			"https://dev.naia.land/ko/billing",
		);
		expect(naiaWebUrl("api/announcements", NAIA_INSTANCE_URLS.dev.web)).toBe(
			"https://dev.naia.land/api/announcements",
		);
	});

	it("keeps the launch script catalog identical to the UI helper", () => {
		const srcRoot = dirname(fileURLToPath(import.meta.url));
		const helper = readFileSync(resolve(srcRoot, "../naia-instance-urls.ts"), "utf8");
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
