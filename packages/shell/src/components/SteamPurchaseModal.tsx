import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getNaiaKeySecure } from "../lib/config";
import { t } from "../lib/i18n";
import { clearCachedLabCredits } from "../lib/lab-balance";
import { Logger } from "../lib/logger";
import {
	createSteamOrder,
	fetchSteamPacks,
	finalizeSteamOrder,
	listenToSteamAuthorization,
	openSteamUrl,
	type SteamOrderResponse,
	type SteamPack,
} from "../lib/steam-billing";
import { useAppStore } from "../stores/app";

export interface SteamPurchaseModalProps {
	isOpen: boolean;
	onClose: () => void;
	onPurchaseSuccess?: () => void;
	onSuccess?: () => void;
	naiaKey?: string;
	gatewayUrl?: string;
}

type ModalFlowState =
	| "idle"
	| "creating"
	| "authorizing"
	| "web_flow"
	| "finalizing"
	| "success"
	| "error";

export function SteamPurchaseModal({
	isOpen,
	onClose,
	onPurchaseSuccess,
	onSuccess,
	naiaKey,
	gatewayUrl,
}: SteamPurchaseModalProps) {
	const pushModal = useAppStore((s) => s.pushModal);
	const popModal = useAppStore((s) => s.popModal);

	const [packs, setPacks] = useState<SteamPack[]>([]);
	const [loadingPacks, setLoadingPacks] = useState(false);
	const [selectedPackId, setSelectedPackId] = useState<string | null>(null);
	const [flowState, setFlowState] = useState<ModalFlowState>("idle");
	const [delayedNotice, setDelayedNotice] = useState(false);
	const [currentOrder, setCurrentOrder] = useState<SteamOrderResponse | null>(null);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);

	const abortControllerRef = useRef<AbortController | null>(null);
	const unlistenRef = useRef<(() => void) | null>(null);

	// Modal stack tracking for Chrome embedding
	useEffect(() => {
		if (!isOpen) return;
		pushModal();
		return () => popModal();
	}, [isOpen, pushModal, popModal]);

	// Load packs on open
	useEffect(() => {
		if (!isOpen) {
			setFlowState("idle");
			setDelayedNotice(false);
			setCurrentOrder(null);
			setErrorMessage(null);
			setSelectedPackId(null);
			unlistenRef.current?.();
			unlistenRef.current = null;
			abortControllerRef.current?.abort();
			abortControllerRef.current = null;
			return;
		}

		let active = true;
		setLoadingPacks(true);
		fetchSteamPacks(gatewayUrl)
			.then((loadedPacks) => {
				if (!active) return;
				setPacks(loadedPacks);
				if (loadedPacks.length > 0) {
					setSelectedPackId(loadedPacks[0].id);
				}
				setLoadingPacks(false);
			})
			.catch((err) => {
				if (!active) return;
				Logger.warn("SteamPurchaseModal", "Failed to fetch Steam packs", { error: String(err) });
				setLoadingPacks(false);
			});

		return () => {
			active = false;
		};
	}, [isOpen, gatewayUrl]);

	// Clean up listeners on unmount
	useEffect(() => {
		return () => {
			unlistenRef.current?.();
			abortControllerRef.current?.abort();
		};
	}, []);

	// Handle Escape key
	useEffect(() => {
		if (!isOpen) return;
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape" && flowState !== "finalizing" && flowState !== "creating") {
				handleClose();
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [isOpen, flowState]);

	const handleClose = useCallback(() => {
		unlistenRef.current?.();
		unlistenRef.current = null;
		abortControllerRef.current?.abort();
		abortControllerRef.current = null;
		onClose();
	}, [onClose]);

	const handleFinalize = useCallback(
		async (orderId: string, key: string) => {
			setFlowState("finalizing");
			try {
				await finalizeSteamOrder(key, orderId, {
					gatewayUrl,
					signal: abortControllerRef.current?.signal,
				});
				clearCachedLabCredits();
				window.dispatchEvent(new Event("naia_auth_ready"));
				setFlowState("success");
				onPurchaseSuccess?.();
				onSuccess?.();
			} catch (err) {
				Logger.warn("SteamPurchaseModal", "Finalize failed", { error: String(err) });
				setFlowState("error");
				setErrorMessage(String(err));
			}
		},
		[gatewayUrl, onPurchaseSuccess, onSuccess],
	);

	const handleStartPurchase = async () => {
		if (!selectedPackId) return;
		let effectiveNaiaKey = naiaKey;
		if (!effectiveNaiaKey) {
			try {
				effectiveNaiaKey = (await getNaiaKeySecure()) ?? undefined;
			} catch (err) {
				Logger.warn("SteamPurchaseModal", "Failed to get naiaKey", { error: String(err) });
			}
		}

		if (!effectiveNaiaKey) {
			setFlowState("error");
			setErrorMessage("Naia account authentication required");
			return;
		}

		setFlowState("creating");
		setDelayedNotice(false);
		setErrorMessage(null);

		const controller = new AbortController();
		abortControllerRef.current = controller;

		try {
			const order = await createSteamOrder(effectiveNaiaKey, selectedPackId, {
				gatewayUrl,
				signal: controller.signal,
				onDelayNotice: () => setDelayedNotice(true),
			});
			setCurrentOrder(order);

			if (order.flow === "web") {
				setFlowState("web_flow");
				if (order.steamurl) {
					await openSteamUrl(order.steamurl).catch((err) => {
						Logger.warn("SteamPurchaseModal", "Failed to open steam URL", { error: String(err) });
					});
				}
			} else {
				// Client flow: wait for Steam microtransaction authorization event
				setFlowState("authorizing");
				const unlisten = await listenToSteamAuthorization(order.order_id, {
					onAuthorized: () => {
						handleFinalize(order.order_id, effectiveNaiaKey);
					},
					onCancelled: () => {
						setFlowState("idle");
						setErrorMessage(t("steam.purchase.cancelled"));
					},
				});
				unlistenRef.current = unlisten;
			}
		} catch (err) {
			Logger.warn("SteamPurchaseModal", "Order creation failed", { error: String(err) });
			setFlowState("error");
			setErrorMessage(String(err));
		}
	};

	if (!isOpen) return null;

	const selectedPack = packs.find((p) => p.id === selectedPackId);

	return createPortal(
		<div
			className="modal-overlay"
			role="dialog"
			aria-modal="true"
			aria-labelledby="steam-purchase-title"
			onClick={(e) => {
				if (e.target === e.currentTarget && flowState !== "finalizing" && flowState !== "creating") {
					handleClose();
				}
			}}
		>
			<div
				className="settings-modal"
				style={{
					width: 440,
					maxHeight: "90vh",
					display: "flex",
					flexDirection: "column",
					gap: 16,
				}}
			>
				<div
					style={{
						display: "flex",
						justifyContent: "space-between",
						alignItems: "center",
						borderBottom: "1px solid var(--border-color, rgba(255, 255, 255, 0.1))",
						paddingBottom: 12,
					}}
				>
					<h3 id="steam-purchase-title" style={{ margin: 0, fontSize: "1.1rem" }}>
						{t("steam.purchase.title")}
					</h3>
					{flowState !== "finalizing" && flowState !== "creating" && (
						<button
							type="button"
							onClick={handleClose}
							aria-label={t("apps.close")}
							style={{
								background: "transparent",
								border: "none",
								color: "var(--cream, #fff)",
								cursor: "pointer",
								fontSize: "1.2rem",
								padding: "0 4px",
							}}
						>
							✕
						</button>
					)}
				</div>

				{flowState === "success" ? (
					<div style={{ textAlign: "center", padding: "24px 0" }}>
						<div style={{ fontSize: "2.5rem", marginBottom: 12 }}>✓</div>
						<p style={{ fontWeight: "bold", fontSize: "1.1rem", marginBottom: 8 }}>
							{t("steam.purchase.success")}
						</p>
						{selectedPack && (
							<p style={{ opacity: 0.8, marginBottom: 20 }}>
								+{selectedPack.credits} {t("cost.labCredits")}
							</p>
						)}
						<button
							type="button"
							className="voice-preview-btn"
							onClick={handleClose}
							style={{ padding: "8px 24px" }}
						>
							{t("apps.close")}
						</button>
					</div>
				) : flowState === "finalizing" ? (
					<div style={{ textAlign: "center", padding: "32px 0" }}>
						<p>{t("steam.purchase.finalizing")}</p>
					</div>
				) : flowState === "authorizing" ? (
					<div style={{ textAlign: "center", padding: "24px 0" }}>
						<p style={{ marginBottom: 16 }}>{t("steam.purchase.authorizing")}</p>
						<p style={{ fontSize: "0.85rem", opacity: 0.7 }}>
							{t("steam.purchase.delayedNotice")}
						</p>
					</div>
				) : flowState === "web_flow" ? (
					<div style={{ display: "flex", flexDirection: "column", gap: 16, padding: "12px 0" }}>
						<p>{t("steam.purchase.webFlowInstructions")}</p>
						{currentOrder?.steamurl && (
							<button
								type="button"
								className="voice-preview-btn"
								onClick={() => openSteamUrl(currentOrder.steamurl!)}
							>
								Steam 결제 페이지 다시 열기
							</button>
						)}
						<button
							type="button"
							className="voice-preview-btn"
							style={{ background: "var(--cream, #fff)", color: "var(--espresso, #1a1a1a)" }}
							onClick={async () => {
								let key: string | undefined;
								try {
									key = await getNaiaKeySecure();
								} catch {
									/* empty */
								}
								if (key && currentOrder) {
									handleFinalize(currentOrder.order_id, key);
								}
							}}
						>
							{t("steam.purchase.completedWebButton")}
						</button>
					</div>
				) : flowState === "creating" ? (
					<div style={{ textAlign: "center", padding: "32px 0" }}>
						<p>{delayedNotice ? t("steam.purchase.delayedNotice") : t("steam.purchase.preparing")}</p>
					</div>
				) : (
					<div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
						{errorMessage && (
							<div
								style={{
									background: "rgba(255, 80, 80, 0.15)",
									border: "1px solid rgba(255, 80, 80, 0.3)",
									color: "#ff8080",
									padding: "8px 12px",
									borderRadius: 6,
									fontSize: "0.9rem",
								}}
							>
								{errorMessage}
							</div>
						)}

						{loadingPacks ? (
							<p style={{ textAlign: "center", padding: "24px 0", opacity: 0.8 }}>
								{t("steam.purchase.loadingPacks")}
							</p>
						) : packs.length === 0 ? (
							<p style={{ textAlign: "center", padding: "24px 0", opacity: 0.8 }}>
								{t("steam.purchase.emptyPacks")}
							</p>
						) : (
							<div
								role="radiogroup"
								aria-label="Credit Packs"
								style={{
									display: "grid",
									gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
									gap: 12,
								}}
							>
								{packs.map((pack) => {
									const isSelected = selectedPackId === pack.id;
									const priceStr = `${(pack.price_cents / 100).toFixed(2)} ${pack.currency}`;
									return (
										<div
											key={pack.id}
											role="radio"
											aria-checked={isSelected}
											tabIndex={0}
											onClick={() => setSelectedPackId(pack.id)}
											onKeyDown={(e) => {
												if (e.key === " " || e.key === "Enter") {
													setSelectedPackId(pack.id);
												}
											}}
											style={{
												border: isSelected
													? "2px solid var(--cream, #fff)"
													: "1px solid rgba(255, 255, 255, 0.15)",
												borderRadius: 8,
												padding: "12px 14px",
												cursor: "pointer",
												background: isSelected ? "rgba(255, 255, 255, 0.08)" : "transparent",
												transition: "all 0.15s ease",
											}}
										>
											<div style={{ fontWeight: "bold", fontSize: "1rem", marginBottom: 4 }}>
												{t("steam.purchase.packCredits", { credits: pack.credits })}
											</div>
											<div style={{ opacity: 0.8, fontSize: "0.9rem" }}>{priceStr}</div>
										</div>
									);
								})}
							</div>
						)}

						<div
							style={{
								display: "flex",
								justifyContent: "flex-end",
								gap: 8,
								marginTop: 8,
								borderTop: "1px solid var(--border-color, rgba(255, 255, 255, 0.1))",
								paddingTop: 12,
							}}
						>
							<button
								type="button"
								className="voice-preview-btn"
								onClick={handleClose}
								style={{ background: "transparent", opacity: 0.8 }}
							>
								{t("settings.cancel")}
							</button>
							<button
								type="button"
								className="voice-preview-btn"
								disabled={loadingPacks || packs.length === 0 || !selectedPackId}
								onClick={handleStartPurchase}
								style={{
									background: "var(--cream, #fff)",
									color: "var(--espresso, #1a1a1a)",
									fontWeight: "bold",
								}}
							>
								{t("steam.purchase.buyButton")}
							</button>
						</div>
					</div>
				)}
			</div>
		</div>,
		document.body,
	);
}
