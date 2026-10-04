import { execFileSync } from "node:child_process";
import type { BrowserContext } from "@playwright/test";

export const FIXED_ADK_COMMIT = "13ea427991542965091f2f3211b9325a36dbd522";

export function getAdkRepo(): string {
	const repo = process.env.NAIA_E2E_ADK_REPO;
	if (!repo) {
		throw new Error(
			"NAIA_E2E_ADK_REPO environment variable is required for web workspace OPFS tests",
		);
	}
	return repo;
}

export interface RouteWebAdkOptions {
	adkRepo?: string;
	commit?: string;
	onIntercept?: (subPath: string) => void;
}

export async function routeWebAdkRepo(
	context: BrowserContext,
	options: RouteWebAdkOptions = {},
): Promise<{ interceptedPaths: string[] }> {
	const adkRepo = options.adkRepo ?? getAdkRepo();
	const commit = options.commit ?? FIXED_ADK_COMMIT;
	const interceptedPaths: string[] = [];

	await context.route("**/__naia_e2e_adk__/**", async (route, req) => {
		const url = req.url();
		const idx = url.indexOf("/__naia_e2e_adk__/");
		const sub = decodeURIComponent(
			url.slice(idx + "/__naia_e2e_adk__/".length),
		);
		interceptedPaths.push(sub);
		options.onIntercept?.(sub);
		try {
			const stdout = execFileSync("git", [
				"-C",
				adkRepo,
				"show",
				`${commit}:${sub}`,
			]);
			await route.fulfill({
				status: 200,
				contentType: "application/octet-stream",
				body: stdout,
			});
		} catch {
			await route.fulfill({ status: 404, body: "Not found" });
		}
	});

	return { interceptedPaths };
}
