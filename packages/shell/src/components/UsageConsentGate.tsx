import { type ReactNode, useEffect, useState } from "react";
import { t } from "../lib/i18n";
import { installUsageListeners, usage } from "../lib/usage-runtime";

export function UsageConsentGate({ children }: { children: ReactNode }) {
	const [ready, setReady] = useState(false);
	const [error, setError] = useState(false);
	useEffect(() => {
		installUsageListeners();
		if (usage.choice() !== null) void usage.sync().then(() => setReady(true));
	}, []);
	async function choose(enabled: boolean) {
		if (await usage.choose(enabled)) setReady(true);
		else setError(true);
	}
	if (ready) return children;
	return (
		<div className="onboarding-overlay">
			<main
				className="onboarding-card usage-consent"
				aria-labelledby="usage-title"
			>
				<h2 id="usage-title">{t("usage.title")}</h2>
				<p className="onboarding-description">{t("usage.description")}</p>
				<p className="onboarding-description">{t("usage.optional")}</p>
				{error && <p role="alert">{t("usage.saveError")}</p>}
				<div className="usage-actions">
					<button
						type="button"
						className="onboarding-skip-btn"
						onClick={() => void choose(false)}
					>
						{t("usage.decline")}
					</button>
					<button
						type="button"
						className="onboarding-next-btn"
						onClick={() => void choose(true)}
					>
						{t("usage.allow")}
					</button>
				</div>
				{error && (
					<button
						type="button"
						className="onboarding-skip-btn"
						onClick={() => {
							usage.stop();
							setReady(true);
						}}
					>
						{t("usage.continueOff")}
					</button>
				)}
			</main>
		</div>
	);
}

export function UsageSettings() {
	const [enabled, setEnabled] = useState(usage.choice()?.enabled === true);
	const [error, setError] = useState(false);
	useEffect(() => {
		const sync = () => setEnabled(usage.choice()?.enabled === true);
		window.addEventListener("storage", sync);
		return () => window.removeEventListener("storage", sync);
	}, []);
	return (
		<section className="usage-settings" aria-labelledby="usage-settings-title">
			<h3 id="usage-settings-title">{t("usage.title")}</h3>
			<p>{t("usage.description")}</p>
			<label>
				<input
					type="checkbox"
					checked={enabled}
					onChange={async (event) => {
						const next = event.target.checked;
						const saved = await usage.choose(next);
						setEnabled(saved && next);
						setError(!saved);
					}}
				/>
				{t("usage.enabled")}
			</label>
			<p>{t("usage.stopNotice")}</p>
			{error && <p role="alert">{t("usage.saveError")}</p>}
		</section>
	);
}
