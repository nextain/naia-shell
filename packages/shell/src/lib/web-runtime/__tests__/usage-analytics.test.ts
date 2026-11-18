// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	resetFirstWebGpuReplyForTests,
	setWebGpuAnalyticsConsent,
	trackWebGpuAnalyticsEvent,
} from "../usage-analytics";

beforeEach(() => {
	vi.stubEnv("MODE", "web");
	vi.stubEnv("VITE_WEBGPU_GA4_MEASUREMENT_ID", "G-TEST123");
	localStorage.clear();
	Reflect.deleteProperty(window, "gtag");
	Reflect.deleteProperty(window, "dataLayer");
	Reflect.deleteProperty(window, "__naiaWebGpuAnalyticsReady");
	Reflect.deleteProperty(window, "__naiaWebGpuPendingEvents");
	for (const script of document.querySelectorAll(
		"script[data-naia-web-gpu-analytics]",
	))
		script.remove();
	resetFirstWebGpuReplyForTests();
});

afterEach(() => {
	localStorage.clear();
	for (const script of document.querySelectorAll(
		"script[data-naia-web-gpu-analytics]",
	))
		script.remove();
	Reflect.deleteProperty(window, "gtag");
	Reflect.deleteProperty(window, "dataLayer");
	Reflect.deleteProperty(window, "__naiaWebGpuAnalyticsReady");
	Reflect.deleteProperty(window, "__naiaWebGpuPendingEvents");
	resetFirstWebGpuReplyForTests();
	vi.unstubAllEnvs();
});

describe("WebGPU analytics consent and payload", () => {
	it("creates no tag or event without consent", () => {
		expect(trackWebGpuAnalyticsEvent("webgpu_model_ready")).toBe(false);
		expect(
			document.querySelector("script[src*='googletagmanager.com']"),
		).toBeNull();
		expect(
			(window as unknown as { dataLayer?: unknown[] }).dataLayer,
		).toBeUndefined();
	});

	it("sends only the fixed event and numeric first-reply duration", () => {
		expect(setWebGpuAnalyticsConsent("accepted")).toBe(true);
		expect(
			trackWebGpuAnalyticsEvent("webgpu_first_reply", {
				elapsed_seconds: 2.34,
				email: "PRIVATE_EMAIL",
				question: "PRIVATE_QUESTION",
				url: "?PRIVATE_QUERY",
			}),
		).toBe(true);
		const target = window as unknown as {
			dataLayer: unknown[][];
			__naiaWebGpuPendingEvents: unknown[][];
		};
		const config = target.dataLayer.find((command) => command[0] === "config");
		expect(config?.[2]).toMatchObject({
			page_location: `${window.location.origin}/webgpu`,
			page_referrer: "",
		});
		expect(target.__naiaWebGpuPendingEvents).toEqual([
			["event", "webgpu_first_reply", { elapsed_seconds: 2.3 }],
		]);
		expect(JSON.stringify(target.dataLayer)).not.toMatch(
			/PRIVATE_EMAIL|PRIVATE_QUESTION|PRIVATE_QUERY/,
		);
	});

	it("drops a pending event when consent is withdrawn while gtag.js is loading", () => {
		setWebGpuAnalyticsConsent("accepted");
		trackWebGpuAnalyticsEvent("webgpu_model_ready");
		expect(setWebGpuAnalyticsConsent("essential-only")).toBe(true);
		const script = document.querySelector(
			"script[data-naia-web-gpu-analytics]",
		) as HTMLScriptElement;
		script.onload?.(new Event("load"));
		const target = window as unknown as {
			dataLayer: unknown[][];
			__naiaWebGpuPendingEvents: unknown[][];
		};
		expect(target.dataLayer.some((command) => command[0] === "event")).toBe(
			false,
		);
		expect(target.__naiaWebGpuPendingEvents).toEqual([]);
		expect(
			(window as unknown as Record<string, unknown>)["ga-disable-G-TEST123"],
		).toBe(true);
	});

	it("rejects unknown names, missing duration, and an empty receiver ID", () => {
		setWebGpuAnalyticsConsent("accepted");
		expect(
			trackWebGpuAnalyticsEvent("webgpu_first_reply", {
				elapsed_seconds: "1.2",
			}),
		).toBe(false);
		expect(trackWebGpuAnalyticsEvent("unknown" as never)).toBe(false);
		vi.stubEnv("VITE_WEBGPU_GA4_MEASUREMENT_ID", " ");
		expect(trackWebGpuAnalyticsEvent("webgpu_model_ready")).toBe(false);
	});
});
