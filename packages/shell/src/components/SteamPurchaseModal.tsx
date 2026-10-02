import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "../lib/i18n";
import { clearCachedLabCredits } from "../lib/lab-balance";
import { Logger } from "../lib/logger";
import { getNaiaKeySecure } from "../lib/config";
import {
	createSteamAuthListener,
	createSteamOrder,
	fetchSteamPacks,
	finalizeSteamOrder,
	isAllowedSteamUrl,
	openSteamUrl,
	type SteamAuthListener,
	type SteamOrderResponse,
	type SteamPack,
	VALID_STEAM_ORDER_STATUSES,
} from "../lib/steam-billing";

export type PurchaseFlowState =
	| "idle"
	| "creating"
	| "delayed"
	| "authorizing"
	| "web_flow"
	| "finalizing"
	| "success"
	| "error";

export interface SteamPurchaseModalProps {
	isOpen: boolean;
	onClose: () => void;
	naiaKey?: string;
	gatewayUrl?: string;
	onPurchaseSuccess?: () => void;
	onSuccess?: () => void;
	onNavigateToSettings?: () => void;
	pollIntervalMs?: number;
	maxPollAttempts?: number;
}

export function SteamPurchaseModal({
	isOpen,
	onClose,
	naiaKey,
	gatewayUrl,
	onPurchaseSuccess,
	onSuccess,
	onNavigateToSettings,
	pollIntervalMs,
	maxPollAttempts,
}: SteamPurchaseModalProps) {
	const [packs, setPacks] = useState<SteamPack[]>([]);
	const [loadingPacks, setLoadingPacks] = useState(false);
	const [selectedPackId, setSelectedPackId] = useState<string | null>(null);
	const [flowState, setFlowState] = useState<PurchaseFlowState>("idle");
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const [currentOrder, setCurrentOrder] = useState<SteamOrderResponse | null>(null);
	const [activeIdempotencyKey, setActiveIdempotencyKey] = useState<string | null>(null);

	const authListenerRef = useRef<SteamAuthListener | null>(null);
	const finalizingOrderIdsRef = useRef<Set<string>>(new Set());
	const finalizedOrderIdsRef = useRef<Set<string>>(new Set());
	const abortControllerRef = useRef<AbortController | null>(null);

	const handleClose = useCallback(() => {
		authListenerRef.current?.unlisten();
		authListenerRef.current = null;
		abortControllerRef.current?.abort();
		abortControllerRef.current = null;
		onClose();
	}, [onClose]);

	// Clean up listeners on unmount
	useEffect(() => {
		return () => {
			authListenerRef.current?.unlisten();
			authListenerRef.current = null;
			abortControllerRef.current?.abort();
			abortControllerRef.current = null;
		};
	}, []);

	// Reset state when modal opens or closes
	useEffect(() => {
		if (isOpen) {
			setFlowState("idle");
			setErrorMessage(null);
			setCurrentOrder(null);
			setActiveIdempotencyKey(null);
			finalizingOrderIdsRef.current.clear();
			finalizedOrderIdsRef.current.clear();

			setLoadingPacks(true);
			fetchSteamPacks(gatewayUrl)
				.then((p) => {
					setPacks(p);
					if (p.length > 0) {
						setSelectedPackId(p[0].id);
					}
				})
				.catch((err) => {
					Logger.warn("SteamPurchaseModal", "Failed to fetch packs", {
						error: String(err),
					});
					setErrorMessage(String(err));
				})
				.finally(() => setLoadingPacks(false));
		} else {
			authListenerRef.current?.unlisten();
			authListenerRef.current = null;
			abortControllerRef.current?.abort();
			abortControllerRef.current = null;
		}
	}, [isOpen, gatewayUrl]);

	// Keyboard ESC to close
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape" && isOpen && flowState !== "finalizing") {
				handleClose();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [isOpen, flowState, handleClose]);

	const handleFinalize = useCallback(
		async (orderId: string, key: string) => {
			const idStr = String(orderId);
			if (
				finalizingOrderIdsRef.current.has(idStr) ||
				finalizedOrderIdsRef.current.has(idStr)
			) {
				return;
			}
			finalizingOrderIdsRef.current.add(idStr);
			setFlowState("finalizing");
			try {
				const res = await finalizeSteamOrder(key, idStr, {
					gatewayUrl,
					signal: abortControllerRef.current?.signal,
				});
				finalizedOrderIdsRef.current.add(idStr);
				finalizingOrderIdsRef.current.delete(idStr);

				clearCachedLabCredits();
				window.dispatchEvent(new Event("naia_auth_ready"));

				if (res.granted_now) {
					onPurchaseSuccess?.();
					onSuccess?.();
				}
				setFlowState("success");
			} catch (err: any) {
				finalizingOrderIdsRef.current.delete(idStr);
				Logger.warn("SteamPurchaseModal", "Finalize failed", { error: String(err) });
				const errStr = String(err?.message || err);
				if (
					errStr.includes("steam_failed") ||
					errStr.includes("order_reversed") ||
					errStr.includes("order_init_failed")
				) {
					setErrorMessage(t("steam.purchase.cancelled"));
				} else {
					setErrorMessage(errStr);
				}
				setFlowState("error");
			}
		},
		[gatewayUrl, onPurchaseSuccess, onSuccess],
	);

	const executeOrder = async (idempotencyKey: string) => {
		if (!selectedPackId) return;
		let effectiveNaiaKey = naiaKey;
		if (!effectiveNaiaKey) {
			try {
				effectiveNaiaKey = (await getNaiaKeySecure()) ?? undefined;
			} catch (err) {
				Logger.warn("SteamPurchaseModal", "Failed to get naiaKey", {
					error: String(err),
				});
			}
		}

		if (!effectiveNaiaKey) {
			setFlowState("error");
			setErrorMessage(t("steam.purchase.authRequired"));
			return;
		}

		// Register microtransaction listener BEFORE sending the order request (#729 P1 지적 9)
		authListenerRef.current?.unlisten();
		try {
			const listener = await createSteamAuthListener();
			authListenerRef.current = listener;
		} catch (e) {
			Logger.warn("SteamPurchaseModal", "Failed to register early auth listener", {
				error: String(e),
			});
		}

		setFlowState("creating");
		setErrorMessage(null);

		const controller = new AbortController();
		abortControllerRef.current = controller;

		try {
			const order = await createSteamOrder(effectiveNaiaKey, selectedPackId, {
				gatewayUrl,
				idempotencyKey,
				signal: controller.signal,
				pollIntervalMs,
				maxPollAttempts,
			});
			setCurrentOrder(order);

			// P1 지적 6: Check order.status 7종 BEFORE branching by flow
			if (
				!VALID_STEAM_ORDER_STATUSES.has(order.status) ||
				order.status === "INIT_FAILED" ||
				order.status === "FAILED" ||
				order.status === "MISMATCH" ||
				order.status === "REVERSED"
			) {
				setFlowState("error");
				setErrorMessage(t("steam.purchase.cancelled"));
				return;
			}

			if (order.status === "GRANTED") {
				clearCachedLabCredits();
				window.dispatchEvent(new Event("naia_auth_ready"));
				onPurchaseSuccess?.();
				onSuccess?.();
				setFlowState("success");
				return;
			}

			if (order.status === "CREATED") {
				// 10s poll limit reached while still CREATED (#729 P1 지적 8)
				setFlowState("delayed");
				return;
			}

			if (order.status === "INITIATED") {
				if (order.flow === "web") {
					if (!order.steamurl || !isAllowedSteamUrl(order.steamurl)) {
						setFlowState("error");
						setErrorMessage(t("steam.purchase.invalidUrl"));
						return;
					}
					try {
						await openSteamUrl(order.steamurl);
						setFlowState("web_flow");
					} catch (err: any) {
						setFlowState("error");
						setErrorMessage(String(err?.message || err));
					}
				} else {
					// Client flow
					setFlowState("authorizing");
					authListenerRef.current?.waitForOrder(order.order_id, {
						onAuthorized: () => {
							handleFinalize(order.order_id, effectiveNaiaKey!);
						},
						onCancelled: () => {
							setFlowState("error");
							setErrorMessage(t("steam.purchase.cancelled"));
						},
					});
				}
			}
		} catch (err: any) {
			if (controller.signal.aborted) return;
			Logger.warn("SteamPurchaseModal", "Order creation failed", {
				error: String(err),
			});
			const msg = String(err?.message || err);
			if (msg === "steam_not_linked") {
				setErrorMessage(t("steam.purchase.notLinkedNotice"));
			} else if (
				msg.includes("steam_failed") ||
				msg.includes("order_reversed") ||
				msg.includes("order_init_failed")
			) {
				setErrorMessage(t("steam.purchase.cancelled"));
			} else {
				setErrorMessage(msg);
			}
			setFlowState("error");
		}
	};

	// Start a brand-new purchase attempt (generates a new idempotency key)
	const handleStartPurchase = () => {
		const key =
			typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
				? crypto.randomUUID()
				: `naia-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
		setActiveIdempotencyKey(key);
		executeOrder(key);
	};

	// Retry existing purchase attempt (preserves existing idempotency key)
	const handleRetryAttempt = () => {
		if (activeIdempotencyKey) {
			executeOrder(activeIdempotencyKey);
		} else {
			handleStartPurchase();
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
				if (e.target === e.currentTarget && flowState !== "finalizing") {
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
						borderBottom:
							"1px solid var(--border-color, rgba(255, 255, 255, 0.1))",
						paddingBottom: 12,
					}}
				>
					<h3 id="steam-purchase-title" style={{ margin: 0, fontSize: "1.1rem" }}>
						{t("steam.purchase.title")}
					</h3>
					{flowState !== "finalizing" && (
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
				) : flowState === "delayed" ? (
					<div
						style={{
							display: "flex",
							flexDirection: "column",
							gap: 16,
							textAlign: "center",
							padding: "16px 0",
						}}
					>
						<p style={{ fontSize: "1rem" }}>{t("steam.purchase.delayedNotice")}</p>
						<div
							style={{
								display: "flex",
								justifyContent: "center",
								gap: 8,
								marginTop: 8,
							}}
						>
							<button
								type="button"
								className="voice-preview-btn"
								onClick={handleClose}
								style={{ background: "transparent", opacity: 0.8 }}
							>
								{t("apps.close")}
							</button>
							<button
								type="button"
								className="voice-preview-btn"
								onClick={handleRetryAttempt}
								style={{
									background: "var(--cream, #fff)",
									color: "var(--espresso, #1a1a1a)",
									fontWeight: "bold",
								}}
							>
								{t("steam.purchase.retryCheck")}
							</button>
						</div>
					</div>
				) : flowState === "authorizing" ? (
					<div
						style={{
							display: "flex",
							flexDirection: "column",
							gap: 16,
							textAlign: "center",
							padding: "20px 0",
						}}
					>
						<p style={{ marginBottom: 8, fontWeight: "bold" }}>
							{t("steam.purchase.authorizing")}
						</p>
						<p style={{ fontSize: "0.85rem", opacity: 0.7 }}>
							{t("steam.purchase.delayedNotice")}
						</p>
						<button
							type="button"
							className="voice-preview-btn"
							style={{
								background: "var(--cream, #fff)",
								color: "var(--espresso, #1a1a1a)",
								marginTop: 12,
							}}
							onClick={async () => {
								let key = naiaKey;
								if (!key) {
									try {
										key = (await getNaiaKeySecure()) ?? undefined;
									} catch {
										/* empty */
									}
								}
								if (key && currentOrder) {
									handleFinalize(currentOrder.order_id, key);
								}
							}}
						>
							{t("steam.purchase.completedWebButton")}
						</button>
					</div>
				) : flowState === "web_flow" ? (
					<div
						style={{
							display: "flex",
							flexDirection: "column",
							gap: 16,
							padding: "12px 0",
						}}
					>
						<p>{t("steam.purchase.webFlowInstructions")}</p>
						{currentOrder?.steamurl && (
							<button
								type="button"
								className="voice-preview-btn"
								onClick={async () => {
									try {
										await openSteamUrl(currentOrder.steamurl!);
									} catch (err: any) {
										setErrorMessage(String(err?.message || err));
									}
								}}
							>
								{t("steam.purchase.reopenWebButton")}
							</button>
						)}
						<button
							type="button"
							className="voice-preview-btn"
							style={{
								background: "var(--cream, #fff)",
								color: "var(--espresso, #1a1a1a)",
							}}
							onClick={async () => {
								let key = naiaKey;
								if (!key) {
									try {
										key = (await getNaiaKeySecure()) ?? undefined;
									} catch {
										/* empty */
									}
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
						<p>{t("steam.purchase.preparing")}</p>
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
									display: "flex",
									flexDirection: "column",
									gap: 8,
								}}
							>
								<div>{errorMessage}</div>
								{errorMessage === t("steam.purchase.notLinkedNotice") && (
									<button
										type="button"
										className="voice-preview-btn"
										style={{ alignSelf: "flex-start", padding: "4px 10px" }}
										onClick={() => {
											handleClose();
											onNavigateToSettings?.();
										}}
									>
										{t("steam.purchase.goToSettings")}
									</button>
								)}
								{activeIdempotencyKey && (
									<button
										type="button"
										className="voice-preview-btn"
										style={{ alignSelf: "flex-start", padding: "4px 10px" }}
										onClick={handleRetryAttempt}
									>
										{t("steam.purchase.retryPurchase")}
									</button>
								)}
							</div>
						)}

						{loadingPacks ? (
							<p
								style={{
									textAlign: "center",
									padding: "24px 0",
									opacity: 0.8,
								}}
							>
								{t("steam.purchase.loadingPacks")}
							</p>
						) : packs.length === 0 ? (
							<p
								style={{
									textAlign: "center",
									padding: "24px 0",
									opacity: 0.8,
								}}
							>
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
												background: isSelected
													? "rgba(255, 255, 255, 0.08)"
													: "transparent",
												transition: "all 0.15s ease",
											}}
										>
											<div
												style={{
													fontWeight: "bold",
													fontSize: "1rem",
													marginBottom: 4,
												}}
											>
												{t("steam.purchase.packCredits", {
													credits: pack.credits,
												})}
											</div>
											<div style={{ opacity: 0.8, fontSize: "0.9rem" }}>
												{priceStr}
											</div>
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
								borderTop:
									"1px solid var(--border-color, rgba(255, 255, 255, 0.1))",
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
