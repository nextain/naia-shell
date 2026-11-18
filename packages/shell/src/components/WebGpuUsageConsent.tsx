import { useEffect, useState } from "react";
import { t } from "../lib/i18n";
import {
	WEBGPU_ANALYTICS_CONSENT_EVENT,
	WEBGPU_ANALYTICS_CONSENT_KEY,
	type WebGpuAnalyticsConsent,
	getWebGpuAnalyticsConsent,
	setWebGpuAnalyticsConsent,
	watchWebGpuAnalyticsConsent,
} from "../lib/web-runtime/usage-analytics";

export function WebGpuUsageConsent() {
	const [choice, setChoice] = useState<WebGpuAnalyticsConsent>(null);
	const [open, setOpen] = useState(true);

	useEffect(() => {
		const refresh = () => {
			const next = getWebGpuAnalyticsConsent();
			setChoice(next);
			setOpen(next === null);
		};
		refresh();
		const unwatch = watchWebGpuAnalyticsConsent();
		const onStorage = (event: StorageEvent) => {
			if (event.key === WEBGPU_ANALYTICS_CONSENT_KEY || event.key === null)
				refresh();
		};
		window.addEventListener("storage", onStorage);
		window.addEventListener(WEBGPU_ANALYTICS_CONSENT_EVENT, refresh);
		return () => {
			unwatch();
			window.removeEventListener("storage", onStorage);
			window.removeEventListener(WEBGPU_ANALYTICS_CONSENT_EVENT, refresh);
		};
	}, []);

	function choose(value: Exclude<WebGpuAnalyticsConsent, null>) {
		if (!setWebGpuAnalyticsConsent(value)) return;
		setChoice(value);
		setOpen(false);
	}

	if (!open) {
		return (
			<button
				type="button"
				className="web-usage-consent__manage"
				aria-haspopup="dialog"
				onClick={() => setOpen(true)}
			>
				{t("webUsage.manage")}
				<span className="sr-only">
					{choice === "accepted" ? t("webUsage.allowed") : t("webUsage.denied")}
				</span>
			</button>
		);
	}

	return (
		<dialog open className="web-usage-consent" aria-label={t("webUsage.title")}>
			<div className="web-usage-consent__copy">
				<strong>{t("webUsage.title")}</strong>
				<p>{t("webUsage.description")}</p>
			</div>
			<div className="web-usage-consent__actions">
				<button type="button" onClick={() => choose("essential-only")}>
					{t("webUsage.decline")}
				</button>
				<button type="button" onClick={() => choose("accepted")}>
					{t("webUsage.allow")}
				</button>
			</div>
		</dialog>
	);
}
