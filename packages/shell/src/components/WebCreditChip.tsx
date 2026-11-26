import { useCallback, useEffect, useRef, useState } from "react";
import {
	LAB_GATEWAY_URL,
	NAIA_WEB_BASE_URL,
	getNaiaKeySecure,
	loadConfig,
	saveConfig,
} from "../lib/config";
import { formatWebCredits } from "../lib/credits";
import { usePaymentLinksHidden } from "../lib/distribution";
import { getLocale, t } from "../lib/i18n";
import { isKioskDemo } from "../lib/kiosk-demo/flag";
import {
	fetchLabBalancePayload,
	isLabBalanceUnauthorized,
	markNaiaKeyUnauthorized,
	onNaiaKeyUnauthorized,
	onWebCreditRefresh,
	parseLabCredits,
	primeLabCredits,
} from "../lib/lab-balance";
import { Logger } from "../lib/logger";
import { naiaWebUrl } from "../lib/naia-instance-urls";
import { isWebMode } from "../lib/web-runtime/web-assets";
import { readNavigatorGpu } from "../lib/web-runtime/webgpu-check";
import { WEB_LLM_MODEL_ID } from "../lib/web-runtime/webllm-model";
import { useAppStore } from "../stores/app";

/** SP-00: balance under this shows orange. */
export const WEB_CREDIT_LOW_THRESHOLD = 50;
const REFRESH_INTERVAL_MS = 60_000;
const FETCH_TIMEOUT_MS = 8_000;

export type WebCreditLevel = "ok" | "low" | "empty";

export function webCreditLevel(balance: number): WebCreditLevel {
	if (balance <= 0) return "empty";
	if (balance < WEB_CREDIT_LOW_THRESHOLD) return "low";
	return "ok";
}

function hasWebGpu(): boolean {
	return typeof navigator !== "undefined" && "gpu" in navigator;
}

function openNaiaWeb(path: string) {
	window.open(
		naiaWebUrl(`${getLocale()}/${path}`, NAIA_WEB_BASE_URL),
		"_blank",
		"noopener",
	);
}

/**
 * Web build top-bar credit balance (SP-00) and zero-credit card (SP-10).
 * Re-reads the balance every minute and when the tab regains focus, so a
 * charge finished in the naia.land billing tab shows up on return.
 */
export function WebCreditChip() {
	const [balance, setBalance] = useState<number | null>(null);
	const [open, setOpen] = useState(false);
	const [emptyDismissed, setEmptyDismissed] = useState(false);
	const paymentLinksHidden = usePaymentLinksHidden();
	const setActiveApp = useAppStore((s) => s.setActiveApp);
	const inFlight = useRef<AbortController | null>(null);
	const enabled = isWebMode() && !isKioskDemo();

	const refresh = useCallback(async () => {
		let naiaKey: string | null | undefined;
		try {
			naiaKey = await getNaiaKeySecure();
		} catch {
			naiaKey = null;
		}
		if (!naiaKey) {
			setBalance(null);
			return;
		}
		inFlight.current?.abort();
		const controller = new AbortController();
		inFlight.current = controller;
		const timeout = window.setTimeout(
			() => controller.abort(),
			FETCH_TIMEOUT_MS,
		);
		try {
			const value = parseLabCredits(
				await fetchLabBalancePayload(
					LAB_GATEWAY_URL,
					naiaKey,
					controller.signal,
				),
			);
			if (value === null) throw new Error("Invalid balance response");
			primeLabCredits(value);
			setBalance((prev) => {
				if (prev !== null && prev <= 0 && value > 0) setEmptyDismissed(false);
				return value;
			});
		} catch (err) {
			if (controller.signal.aborted && inFlight.current !== controller) return;
			Logger.warn("WebCreditChip", "balance fetch failed", {
				error: String(err),
			});
			if (isLabBalanceUnauthorized(err)) {
				setBalance(null);
				markNaiaKeyUnauthorized();
			}
		} finally {
			window.clearTimeout(timeout);
			if (inFlight.current === controller) inFlight.current = null;
		}
	}, []);

	useEffect(() => {
		if (!enabled) return;
		void refresh();
		const timer = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
		const onFocus = () => void refresh();
		const onVisible = () => {
			if (document.visibilityState === "visible") void refresh();
		};
		window.addEventListener("focus", onFocus);
		window.addEventListener("naia-web-auth-changed", onFocus);
		document.addEventListener("visibilitychange", onVisible);
		let creditRefreshDebounce: number | undefined;
		const offCreditRefresh = onWebCreditRefresh(() => {
			if (creditRefreshDebounce !== undefined) {
				window.clearTimeout(creditRefreshDebounce);
			}
			creditRefreshDebounce = window.setTimeout(() => {
				creditRefreshDebounce = undefined;
				void refresh();
			}, 300);
		});
		const offUnauthorized = onNaiaKeyUnauthorized(() => setBalance(null));
		return () => {
			window.clearInterval(timer);
			if (creditRefreshDebounce !== undefined) {
				window.clearTimeout(creditRefreshDebounce);
			}
			window.removeEventListener("focus", onFocus);
			window.removeEventListener("naia-web-auth-changed", onFocus);
			document.removeEventListener("visibilitychange", onVisible);
			offCreditRefresh();
			offUnauthorized();
			inFlight.current?.abort();
		};
	}, [enabled, refresh]);

	const handleChipClick = useCallback(() => {
		// Primary entry: open the usage dashboard in a new tab. The popover
		// stays as the balance-detail and separate charge entry, gated by the
		// distribution payment policy; closing the popover opens nothing.
		if (!open) openNaiaWeb("usage");
		setOpen((v) => !v);
	}, [open]);

	if (!enabled || balance === null) return null;
	const level = webCreditLevel(balance);
	const continueLocal = () => {
		setOpen(false);
		setEmptyDismissed(true);
		try {
			const existing =
				typeof loadConfig === "function" ? loadConfig() : undefined;
			if (typeof saveConfig === "function") {
				saveConfig({
					...(existing ?? { apiKey: "" }),
					provider: "webllm",
					model: WEB_LLM_MODEL_ID,
					ttsProvider: "browser",
					ttsEnabled: existing?.ttsEnabled ?? true,
					llmRoles: {
						...(existing?.llmRoles ?? {}),
						main: { provider: "webllm", model: WEB_LLM_MODEL_ID },
					},
				});
				window.dispatchEvent(new CustomEvent("naia-config-changed"));
				void Promise.all([
					import("../lib/web-runtime/model-start"),
					import("../lib/web-runtime/agent-bridge"),
				])
					.then(([{ startWebModel }, { getStartableAgentBridge }]) =>
						startWebModel({
							gpu: readNavigatorGpu(),
							storage:
								typeof localStorage !== "undefined" ? localStorage : null,
							engineKind: import.meta.env.VITE_NAIA_WEB_LLM,
							buildModel: import.meta.env.VITE_NAIA_WEB_LLM_MODEL,
							bridge: getStartableAgentBridge(),
						}),
					)
					.catch(() => {});
			} else {
				setActiveApp("settings");
			}
		} catch {
			setActiveApp("settings");
		}
	};

	return (
		<div className="web-credit">
			<button
				type="button"
				className={`web-credit__chip web-credit__chip--${level}`}
				onClick={handleChipClick}
				title={t("webCredit.title")}
				aria-label={`${t("webCredit.title")}: ${formatWebCredits(balance)}`}
				aria-expanded={open}
			>
				<span aria-hidden="true">⚡</span>
				{formatWebCredits(balance)}
			</button>
			{open && (
				<section
					className="web-credit__popover"
					aria-label={t("webCredit.title")}
				>
					<div className="web-credit__row">
						<span>{t("webCredit.title")}</span>
						<strong className={`web-credit__value--${level}`}>
							{formatWebCredits(balance, 2)}
						</strong>
					</div>
					<div className="web-credit__actions">
						{!paymentLinksHidden && (
							<button type="button" onClick={() => openNaiaWeb("billing")}>
								{t("cost.labCharge")}
							</button>
						)}
						<button type="button" onClick={() => openNaiaWeb("usage")}>
							{t("webCredit.usage")}
						</button>
					</div>
				</section>
			)}
			{level === "empty" && !emptyDismissed && (
				<div className="web-credit__empty" role="alert">
					<p>
						<strong>{t("webCredit.emptyTitle")}</strong>{" "}
						{t("webCredit.emptyBody")}
					</p>
					<div className="web-credit__actions">
						{hasWebGpu() && (
							<button type="button" onClick={continueLocal}>
								{t("webCredit.continueLocal")}
							</button>
						)}
						{!paymentLinksHidden && (
							<button
								type="button"
								className="web-credit__primary"
								onClick={() => openNaiaWeb("billing")}
							>
								{t("cost.labCharge")}
							</button>
						)}
						<button type="button" onClick={() => setEmptyDismissed(true)}>
							{t("webCredit.dismiss")}
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
