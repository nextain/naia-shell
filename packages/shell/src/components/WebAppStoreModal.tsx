import { useCallback, useEffect, useState } from "react";
import {
	formatStoreProductPrice,
	localizeStoreProduct,
} from "../lib/app-catalog";
import { loadInstalledApps } from "../lib/app-loader";
import { appRegistry } from "../lib/app-registry";
import {
	AppStoreHttpError,
	type StoreProductSummary,
	getPlatformAppStoreAdapter,
} from "../lib/app-store-adapter";
import { NAIA_WEB_BASE_URL } from "../lib/config";
import { getLocale, t } from "../lib/i18n";
import { isKioskDemo } from "../lib/kiosk-demo/flag";
import { primeLabCredits, requestWebCreditRefresh } from "../lib/lab-balance";
import { naiaWebUrl } from "../lib/naia-instance-urls";
import { isWebMode } from "../lib/web-runtime/web-assets";
import { openWebLoginPrompt } from "../lib/web-runtime/web-login-prompt";
import { useAppStore } from "../stores/app";

export function WebAppStoreModal() {
	const [open, setOpen] = useState(false);
	const [items, setItems] = useState<StoreProductSummary[]>([]);
	const [loading, setLoading] = useState(false);
	const [busyAppId, setBusyAppId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const setActiveApp = useAppStore((s) => s.setActiveApp);
	const appListVersion = useAppStore((s) => s.appListVersion);
	const enabled = isWebMode() && !isKioskDemo();

	const refreshCatalog = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const catalog = await getPlatformAppStoreAdapter().listCatalog();
			setItems(catalog);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		if (!enabled) return;
		const onOpenDrawer = (event: Event) => {
			event.preventDefault();
			setOpen(true);
			void refreshCatalog();
		};
		window.addEventListener("naia-open-web-store-drawer", onOpenDrawer);
		return () => {
			window.removeEventListener("naia-open-web-store-drawer", onOpenDrawer);
		};
	}, [enabled, refreshCatalog]);

	useEffect(() => {
		if (!enabled || !open) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				setOpen(false);
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [enabled, open]);

	if (!enabled || !open) return null;

	const locale = getLocale();
	// Subscribe to appListVersion so installed state stays live
	void appListVersion;

	const handleLaunchOrInstall = async (item: StoreProductSummary) => {
		setError(null);
		setBusyAppId(item.appId);
		try {
			if (!appRegistry.get(item.appId)) {
				await getPlatformAppStoreAdapter().installApp(item.appId);
				await loadInstalledApps();
				requestWebCreditRefresh();
			}
			setOpen(false);
			setActiveApp(item.appId);
		} catch (err) {
			if (err instanceof AppStoreHttpError) {
				if (err.code === "auth_required" || err.code === "unauthorized") {
					setOpen(false);
					openWebLoginPrompt("app-store");
					return;
				}
				if (err.code === "insufficient_credits") {
					primeLabCredits(0);
					requestWebCreditRefresh();
				}
			}
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusyAppId(null);
		}
	};

	const openStudio = () => {
		setOpen(false);
		window.open(
			naiaWebUrl(`${locale}/studio`, NAIA_WEB_BASE_URL),
			"_blank",
			"noopener",
		);
	};

	const freeLabel = t("webAppStore.free");

	return (
		<div
			className="sync-dialog-overlay"
			data-testid="web-app-store-overlay"
			onClick={() => setOpen(false)}
			style={{ zIndex: 99980 }}
		>
			<section
				className="sync-dialog-card"
				role="dialog"
				aria-modal="true"
				aria-label={t("webAppStore.title")}
				data-testid="web-app-store-modal"
				onClick={(e) => e.stopPropagation()}
				style={{
					boxSizing: "border-box",
					maxWidth: 560,
					width: "92vw",
					maxHeight: "82vh",
					overflowY: "auto",
					padding: "20px 18px",
					borderRadius: 16,
					border: "1px solid rgba(148, 163, 184, 0.28)",
					background: "rgba(11, 17, 30, 0.96)",
					boxShadow: "0 20px 55px rgba(0, 0, 0, 0.65)",
				}}
			>
				<div
					style={{
						display: "flex",
						alignItems: "flex-start",
						justifyContent: "space-between",
						gap: 12,
						marginBottom: 14,
					}}
				>
					<div style={{ minWidth: 0 }}>
						<h2
							style={{
								margin: 0,
								fontSize: 18,
								color: "#f8fafc",
								overflowWrap: "anywhere",
							}}
						>
							🛍 {t("webAppStore.title")}
						</h2>
						<p
							style={{
								margin: "4px 0 0",
								fontSize: 12.5,
								color: "#94a3b8",
								overflowWrap: "anywhere",
							}}
						>
							{t("webAppStore.subtitle")}
						</p>
					</div>
					<button
						type="button"
						aria-label={t("webExplorer.close")}
						onClick={() => setOpen(false)}
						style={{
							flexShrink: 0,
							width: 30,
							height: 30,
							borderRadius: 999,
							border: "1px solid rgba(148, 163, 184, 0.25)",
							background: "rgba(30, 41, 59, 0.7)",
							color: "#e2e8f0",
							cursor: "pointer",
						}}
					>
						✕
					</button>
				</div>

				{error && (
					<div
						role="alert"
						style={{
							display: "flex",
							alignItems: "center",
							justifyContent: "space-between",
							flexWrap: "wrap",
							gap: 8,
							padding: "8px 12px",
							borderRadius: 8,
							background: "rgba(220, 38, 38, 0.16)",
							color: "#fca5a5",
							fontSize: 12.5,
							marginBottom: 12,
						}}
					>
						<span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
							{error}
						</span>
						<button
							type="button"
							data-testid="web-app-store-retry"
							onClick={() => void refreshCatalog()}
							style={{
								flexShrink: 0,
								padding: "4px 10px",
								borderRadius: 6,
								border: "1px solid rgba(252, 165, 165, 0.35)",
								background: "rgba(127, 29, 29, 0.45)",
								color: "#fee2e2",
								fontSize: 12,
								cursor: "pointer",
							}}
						>
							{t("webModel.retry")}
						</button>
					</div>
				)}

				{loading ? (
					<p role="status" style={{ color: "#94a3b8", fontSize: 13 }}>
						{t("webAppStore.loading")}
					</p>
				) : items.length === 0 ? (
					<p style={{ color: "#94a3b8", fontSize: 13 }}>
						{t("webAppStore.empty")}
					</p>
				) : (
					<div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
						{items.map((item) => {
							const installed = Boolean(appRegistry.get(item.appId));
							const { title, description: desc } = localizeStoreProduct(
								item,
								locale,
							);
							const priceLabel = formatStoreProductPrice(
								item.priceCredits,
								freeLabel,
							);
							const busy = busyAppId === item.appId;
							return (
								<div
									key={item.appId}
									data-testid={`web-store-item-${item.appId}`}
									style={{
										display: "flex",
										alignItems: "center",
										justifyContent: "space-between",
										flexWrap: "wrap",
										gap: 12,
										padding: "12px 14px",
										borderRadius: 12,
										border: "1px solid rgba(148, 163, 184, 0.18)",
										background: "rgba(15, 23, 42, 0.78)",
									}}
								>
									<div
										style={{
											display: "flex",
											gap: 12,
											minWidth: 0,
											flex: "1 1 200px",
										}}
									>
										<span
											aria-hidden="true"
											style={{
												fontSize: 22,
												width: 36,
												height: 36,
												display: "grid",
												placeItems: "center",
												borderRadius: 10,
												background: "rgba(99, 102, 241, 0.14)",
												flexShrink: 0,
											}}
										>
											{item.iconUrl ? (
												<img
													src={item.iconUrl}
													alt=""
													width={28}
													height={28}
													style={{ borderRadius: 6, objectFit: "cover" }}
												/>
											) : (
												item.manifest.icon || "📦"
											)}
										</span>
										<div style={{ minWidth: 0 }}>
											<div
												style={{
													display: "flex",
													alignItems: "center",
													gap: 8,
													flexWrap: "wrap",
												}}
											>
												<strong
													style={{
														fontSize: 14,
														color: "#f1f5f9",
														overflowWrap: "anywhere",
													}}
												>
													{title}
												</strong>
												<span style={{ fontSize: 11.5, color: "#64748b" }}>
													v{item.version}
												</span>
												<span
													data-testid={`web-store-price-${item.appId}`}
													style={{
														fontSize: 11.5,
														fontWeight: 600,
														padding: "1px 7px",
														borderRadius: 999,
														background: "rgba(99, 102, 241, 0.16)",
														color: "#c7d2fe",
													}}
												>
													{priceLabel}
												</span>
											</div>
											<p
												style={{
													margin: "3px 0 0",
													fontSize: 12.5,
													color: "#94a3b8",
													lineHeight: 1.45,
													overflowWrap: "anywhere",
												}}
											>
												{desc}
											</p>
										</div>
									</div>
									<button
										type="button"
										data-testid={`web-store-launch-${item.appId}`}
										disabled={busy}
										onClick={() => void handleLaunchOrInstall(item)}
										style={{
											flexShrink: 0,
											marginLeft: "auto",
											padding: "7px 14px",
											borderRadius: 9,
											border: "none",
											background: installed
												? "rgba(99, 102, 241, 0.25)"
												: "linear-gradient(135deg, #6366f1, #4f46e5)",
											color: "#f8fafc",
											fontWeight: 600,
											fontSize: 12.5,
											cursor: busy ? "wait" : "pointer",
										}}
									>
										{busy
											? "..."
											: installed
												? t("webAppStore.open")
												: t("webAppStore.launch")}
									</button>
								</div>
							);
						})}
					</div>
				)}

				<div
					style={{
						marginTop: 14,
						paddingTop: 12,
						borderTop: "1px solid rgba(148, 163, 184, 0.16)",
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						flexWrap: "wrap",
						gap: 10,
						fontSize: 12,
						color: "#94a3b8",
					}}
				>
					<span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
						{t("webAppStore.stage2Notice")}
					</span>
					<button
						type="button"
						onClick={openStudio}
						style={{
							flexShrink: 0,
							padding: "5px 10px",
							borderRadius: 8,
							border: "1px solid rgba(148, 163, 184, 0.25)",
							background: "transparent",
							color: "#c7d2fe",
							fontSize: 12,
							cursor: "pointer",
						}}
					>
						🎨 {t("webAppStore.studio")} ↗
					</button>
				</div>
			</section>
		</div>
	);
}
