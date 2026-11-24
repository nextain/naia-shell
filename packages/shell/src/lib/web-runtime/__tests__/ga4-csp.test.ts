// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { WEB_CSP } from "../csp";

const SHELL_DIR = resolve(import.meta.dirname, "../../../..");
const GA4_SCRIPT = readFileSync(resolve(SHELL_DIR, "public/ga4.js"), "utf8");
const INDEX_HTML = readFileSync(resolve(SHELL_DIR, "index.html"), "utf8");

interface FakeGa4Window {
	location: { protocol: string; hostname: string };
	document: Document;
	dataLayer?: unknown[];
	gtag?: (...args: unknown[]) => void;
	__TAURI__?: unknown;
	__TAURI_INTERNALS__?: unknown;
}

function parseCspDirectives(csp: string): Map<string, string> {
	const map = new Map<string, string>();
	for (const part of csp.split(";")) {
		const trimmed = part.trim();
		if (!trimmed) continue;
		const spaceIdx = trimmed.indexOf(" ");
		if (spaceIdx === -1) map.set(trimmed, "");
		else map.set(trimmed.slice(0, spaceIdx), trimmed.slice(spaceIdx + 1));
	}
	return map;
}

function runGa4InSandbox(
	url: string,
	extra?: Partial<FakeGa4Window>,
): FakeGa4Window {
	const parsed = new URL(url);
	const win: FakeGa4Window = {
		location: {
			protocol: parsed.protocol,
			hostname: parsed.hostname,
		},
		document,
		...extra,
	};
	runInNewContext(GA4_SCRIPT, { window: win, Date });
	return win;
}

describe("Web CSP & GA4 instrumentation", () => {
	afterEach(() => {
		for (const el of document.querySelectorAll('script[src*="googletagmanager.com"]')) {
			el.remove();
		}
	});

	it("allows Google Tag Manager / GA4 domains in WEB_CSP without unsafe-inline", () => {
		const directives = parseCspDirectives(WEB_CSP);
		const scriptSrc = directives.get("script-src") ?? "";
		const imgSrc = directives.get("img-src") ?? "";

		expect(WEB_CSP).not.toContain("'unsafe-inline'");
		expect(scriptSrc).toContain("'self'");
		expect(scriptSrc).toContain("'wasm-unsafe-eval'");
		expect(scriptSrc).toContain("https://www.googletagmanager.com");
		expect(imgSrc).toContain("https://www.google-analytics.com");
		expect(imgSrc).toContain("https://*.google-analytics.com");
		expect(imgSrc).toContain("https://*.googletagmanager.com");
		expect(directives.get("worker-src")).toBe("'self'");
		expect(directives.get("object-src")).toBe("'none'");
		expect(directives.get("base-uri")).toBe("'self'");
	});

	it("loads external %BASE_URL%ga4.js with defer in index.html", () => {
		expect(INDEX_HTML).toMatch(/<script\s+defer\s+src="%BASE_URL%ga4\.js"\s*><\/script>/);
	});

	it("initializes GA4 Consent Mode v2 denied and injects G-R3HHTFQNGS on https://dev.naia.land/app", () => {
		const win = runGa4InSandbox("https://dev.naia.land/app");

		expect(typeof win.gtag).toBe("function");
		expect(Array.isArray(win.dataLayer)).toBe(true);

		const entries = (win.dataLayer ?? []).map((args) => Array.from(args as ArrayLike<unknown>));
		expect(entries).toContainEqual([
			"consent",
			"default",
			{
				analytics_storage: "denied",
				ad_storage: "denied",
				ad_user_data: "denied",
				ad_personalization: "denied",
			},
		]);
		expect(entries.some(([cmd, val]) => cmd === "js" && val instanceof Date)).toBe(true);
		expect(entries).toContainEqual(["config", "G-R3HHTFQNGS"]);

		const scripts = document.querySelectorAll(
			'script[src="https://www.googletagmanager.com/gtag/js?id=G-R3HHTFQNGS"]',
		);
		expect(scripts).toHaveLength(1);
		expect((scripts[0] as HTMLScriptElement).async).toBe(true);

		// Re-executing does not duplicate the gtag.js tag
		runInNewContext(GA4_SCRIPT, { window: win, Date });
		expect(
			document.querySelectorAll(
				'script[src="https://www.googletagmanager.com/gtag/js?id=G-R3HHTFQNGS"]',
			),
		).toHaveLength(1);
	});

	it.each([
		"http://localhost:5173/",
		"http://127.0.0.1:4173/app/",
		"http://0.0.0.0:4173/app/",
		"https://[::1]:4173/app/",
		"file:///app/index.html",
		"https://tauri.localhost/index.html",
	])("remains completely inert on %s", (url) => {
		const win = runGa4InSandbox(url);
		expect(win.dataLayer).toBeUndefined();
		expect(win.gtag).toBeUndefined();
		expect(
			document.querySelector('script[src*="googletagmanager.com"]'),
		).toBeNull();
	});

	it.each(["__TAURI_INTERNALS__", "__TAURI__"] as const)(
		"remains completely inert when %s is defined on a web origin",
		(tauriGlobal) => {
			const win = runGa4InSandbox("https://dev.naia.land/app", {
				[tauriGlobal]: {},
			});
			expect(win.dataLayer).toBeUndefined();
			expect(win.gtag).toBeUndefined();
			expect(
				document.querySelector('script[src*="googletagmanager.com"]'),
			).toBeNull();
		},
	);
});
