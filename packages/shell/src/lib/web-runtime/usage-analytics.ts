export const WEBGPU_ANALYTICS_CONSENT_KEY = "naia_webgpu_analytics_consent";
export const WEBGPU_ANALYTICS_CONSENT_EVENT =
	"naia-webgpu-analytics-consent-changed";

export const WEBGPU_ANALYTICS_EVENTS = [
	"webgpu_model_download_start",
	"webgpu_model_download_complete",
	"webgpu_model_ready",
	"webgpu_model_download_fail",
	"webgpu_unsupported",
	"webgpu_first_reply",
	"webgpu_reply_fail",
] as const;

export type WebGpuAnalyticsEvent = (typeof WEBGPU_ANALYTICS_EVENTS)[number];
export type WebGpuAnalyticsConsent = "accepted" | "essential-only" | null;

type AnalyticsWindow = Window & {
	dataLayer?: unknown[][];
	gtag?: (...args: unknown[]) => void;
	__naiaWebGpuAnalyticsReady?: boolean;
	__naiaWebGpuPendingEvents?: unknown[][];
};

declare global {
	interface ImportMetaEnv {
		readonly VITE_WEBGPU_GA4_MEASUREMENT_ID?: string;
	}
}

function measurementId(): string | null {
	if (import.meta.env.MODE !== "web") return null;
	const value = import.meta.env.VITE_WEBGPU_GA4_MEASUREMENT_ID?.trim() ?? "";
	return /^G-[A-Z0-9]+$/.test(value) ? value : null;
}

export function getWebGpuAnalyticsConsent(): WebGpuAnalyticsConsent {
	try {
		const value = window.localStorage.getItem(WEBGPU_ANALYTICS_CONSENT_KEY);
		return value === "accepted" || value === "essential-only" ? value : null;
	} catch {
		return null;
	}
}

function hasConsent(): boolean {
	return getWebGpuAnalyticsConsent() === "accepted";
}

function getGtag(): AnalyticsWindow["gtag"] | undefined {
	const target = window as AnalyticsWindow;
	const id = measurementId();
	if (!id || !hasConsent()) return undefined;
	(target as unknown as Record<string, unknown>)[`ga-disable-${id}`] = false;
	if (target.gtag) {
		target.gtag("consent", "update", { analytics_storage: "granted" });
		return target.gtag;
	}

	target.dataLayer = target.dataLayer ?? [];
	target.__naiaWebGpuAnalyticsReady = false;
	target.__naiaWebGpuPendingEvents = [];
	target.gtag = (...args: unknown[]) => {
		if (args[0] === "event") {
			if (!hasConsent()) return;
			if (!target.__naiaWebGpuAnalyticsReady) {
				target.__naiaWebGpuPendingEvents?.push(args);
				return;
			}
		}
		target.dataLayer?.push(args);
	};
	target.gtag("consent", "default", {
		analytics_storage: "denied",
		ad_storage: "denied",
		ad_user_data: "denied",
		ad_personalization: "denied",
	});
	target.gtag("consent", "update", { analytics_storage: "granted" });
	target.gtag("js", new Date());
	target.gtag("config", id, {
		send_page_view: false,
		allow_google_signals: false,
		allow_ad_personalization_signals: false,
		page_location: `${window.location.origin}/webgpu`,
		page_referrer: "",
	});

	const script = document.createElement("script");
	script.async = true;
	script.dataset.naiaWebGpuAnalytics = "true";
	script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`;
	script.onload = () => {
		target.__naiaWebGpuAnalyticsReady = true;
		if (!hasConsent()) {
			target.__naiaWebGpuPendingEvents = [];
			target.gtag?.("consent", "update", { analytics_storage: "denied" });
			return;
		}
		const pending = target.__naiaWebGpuPendingEvents ?? [];
		target.__naiaWebGpuPendingEvents = [];
		for (const event of pending) {
			if (!hasConsent()) break;
			target.dataLayer?.push(event);
		}
	};
	script.onerror = () => {
		target.__naiaWebGpuPendingEvents = [];
		target.__naiaWebGpuAnalyticsReady = false;
	};
	document.head.appendChild(script);
	return target.gtag;
}

function syncAnalyticsConsent(): void {
	const id = measurementId();
	if (!id) return;
	const target = window as AnalyticsWindow;
	if (hasConsent()) {
		getGtag();
		return;
	}
	(target as unknown as Record<string, unknown>)[`ga-disable-${id}`] = true;
	if (target.__naiaWebGpuPendingEvents)
		target.__naiaWebGpuPendingEvents.length = 0;
	target.gtag?.("consent", "update", { analytics_storage: "denied" });
}

export function setWebGpuAnalyticsConsent(
	value: Exclude<WebGpuAnalyticsConsent, null>,
): boolean {
	try {
		window.localStorage.setItem(WEBGPU_ANALYTICS_CONSENT_KEY, value);
	} catch {
		return false;
	}
	window.dispatchEvent(new Event(WEBGPU_ANALYTICS_CONSENT_EVENT));
	syncAnalyticsConsent();
	return true;
}

export function watchWebGpuAnalyticsConsent(): () => void {
	const onChange = () => syncAnalyticsConsent();
	const onStorage = (event: StorageEvent) => {
		if (event.key === WEBGPU_ANALYTICS_CONSENT_KEY || event.key === null)
			onChange();
	};
	window.addEventListener(WEBGPU_ANALYTICS_CONSENT_EVENT, onChange);
	window.addEventListener("storage", onStorage);
	syncAnalyticsConsent();
	return () => {
		window.removeEventListener(WEBGPU_ANALYTICS_CONSENT_EVENT, onChange);
		window.removeEventListener("storage", onStorage);
	};
}

function safeEventPayload(
	name: WebGpuAnalyticsEvent,
	params?: Record<string, unknown>,
): Record<string, number> | null {
	if (name === "webgpu_first_reply") {
		const elapsed = params?.elapsed_seconds;
		if (typeof elapsed !== "number" || !Number.isFinite(elapsed) || elapsed < 0)
			return null;
		return { elapsed_seconds: Math.round(elapsed * 10) / 10 };
	}
	return {};
}

export function trackWebGpuAnalyticsEvent(
	name: WebGpuAnalyticsEvent,
	params?: Record<string, unknown>,
): boolean {
	if (!(WEBGPU_ANALYTICS_EVENTS as readonly string[]).includes(name))
		return false;
	if (!measurementId() || !hasConsent()) return false;
	const payload = safeEventPayload(name, params);
	if (!payload) return false;
	const gtag = getGtag();
	if (!gtag) return false;
	gtag("event", name, payload);
	return true;
}

let firstReplyStartedAt: number | null = null;
let firstReplyFinished = false;

export function beginFirstWebGpuReply(): void {
	if (firstReplyStartedAt === null && !firstReplyFinished)
		firstReplyStartedAt = performance.now();
}

export function finishFirstWebGpuReply(): void {
	if (firstReplyStartedAt === null || firstReplyFinished) return;
	const elapsedSeconds = Math.max(
		0,
		(performance.now() - firstReplyStartedAt) / 1000,
	);
	firstReplyFinished = true;
	firstReplyStartedAt = null;
	trackWebGpuAnalyticsEvent("webgpu_first_reply", {
		elapsed_seconds: elapsedSeconds,
	});
}

export function failFirstWebGpuReply(): void {
	if (firstReplyStartedAt === null || firstReplyFinished) return;
	firstReplyFinished = true;
	firstReplyStartedAt = null;
	trackWebGpuAnalyticsEvent("webgpu_reply_fail");
}

export function cancelFirstWebGpuReply(): void {
	if (firstReplyStartedAt === null || firstReplyFinished) return;
	firstReplyFinished = true;
	firstReplyStartedAt = null;
}

export function resetFirstWebGpuReplyForTests(): void {
	firstReplyStartedAt = null;
	firstReplyFinished = false;
}
