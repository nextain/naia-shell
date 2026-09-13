import { useCallback, useEffect, useState } from "react";
import { isAdkInitialized } from "../lib/adk-store";
import {
	type DeviceNode,
	type DevicePairRequest,
	approveDevicePair,
	describeDeviceNode,
	listDeviceNodes,
	listDevicePairRequests,
	rejectDevicePair,
	renameDeviceNode,
	requestDevicePair,
	revokeDeviceToken,
	rotateDeviceToken,
	verifyDevicePair,
} from "../lib/device-store";
import { t } from "../lib/i18n";
import { Logger } from "../lib/logger";

const TAG = "DevicePairing";

export function DevicePairingSection() {
	const [nodes, setNodes] = useState<DeviceNode[]>([]);
	const [pairRequests, setPairRequests] = useState<DevicePairRequest[]>([]);
	const [loading, setLoading] = useState(false);
	const [renameDraft, setRenameDraft] = useState<Record<string, string>>({});
	const [verifyCode, setVerifyCode] = useState<Record<string, string>>({});
	const [revokeConfirmId, setRevokeConfirmId] = useState<string | null>(null);
	const [oneTimeToken, setOneTimeToken] = useState<string | null>(null);
	const [oneTimeCode, setOneTimeCode] = useState<string | null>(null);
	const [described, setDescribed] = useState<DeviceNode | null>(null);
	const hasAdk = isAdkInitialized();

	const refresh = useCallback(async () => {
		if (!isAdkInitialized()) {
			setNodes([]);
			setPairRequests([]);
			return;
		}
		setLoading(true);
		try {
			const [nextNodes, nextRequests] = await Promise.all([
				listDeviceNodes(),
				listDevicePairRequests(),
			]);
			setNodes(nextNodes);
			setPairRequests(nextRequests);
		} catch (err) {
			Logger.warn(TAG, "Failed to fetch devices", { error: String(err) });
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const onRequestPair = async () => {
		try {
			const created = await requestDevicePair({
				displayName: `node-${Date.now().toString(36)}`,
				platform: "linux",
			});
			setOneTimeCode(created.code);
			setOneTimeToken(null);
			await refresh();
		} catch (err) {
			Logger.warn(TAG, "pair request failed", { error: String(err) });
		}
	};

	const onVerify = async (requestId: string) => {
		try {
			await verifyDevicePair(requestId, verifyCode[requestId] ?? "");
			setVerifyCode((prev) => ({ ...prev, [requestId]: "" }));
			await refresh();
		} catch (err) {
			Logger.warn(TAG, "pair verify failed", { error: String(err) });
		}
	};

	const onApprove = async (requestId: string) => {
		try {
			const approved = await approveDevicePair(requestId);
			setOneTimeToken(approved.token);
			setOneTimeCode(null);
			await refresh();
		} catch (err) {
			Logger.warn(TAG, "pair approve failed", { error: String(err) });
		}
	};

	const onReject = async (requestId: string) => {
		try {
			await rejectDevicePair(requestId);
			await refresh();
		} catch (err) {
			Logger.warn(TAG, "pair reject failed", { error: String(err) });
		}
	};

	const onRename = async (nodeId: string) => {
		try {
			await renameDeviceNode(nodeId, renameDraft[nodeId] ?? "");
			setRenameDraft((prev) => ({ ...prev, [nodeId]: "" }));
			await refresh();
		} catch (err) {
			Logger.warn(TAG, "rename failed", { error: String(err) });
		}
	};

	const onRotate = async (nodeId: string) => {
		try {
			const rotated = await rotateDeviceToken(nodeId);
			setOneTimeToken(rotated.token);
			setOneTimeCode(null);
			await refresh();
		} catch (err) {
			Logger.warn(TAG, "rotate failed", { error: String(err) });
		}
	};

	const onRevoke = async (nodeId: string) => {
		try {
			await revokeDeviceToken(nodeId);
			setRevokeConfirmId(null);
			setOneTimeToken(null);
			await refresh();
		} catch (err) {
			Logger.warn(TAG, "revoke failed", { error: String(err) });
		}
	};

	const onDescribe = async (nodeId: string) => {
		try {
			setDescribed(await describeDeviceNode(nodeId));
		} catch (err) {
			Logger.warn(TAG, "describe failed", { error: String(err) });
		}
	};

	const pending = pairRequests.filter(
		(req) => req.status === "pending" || req.status === "verified",
	);

	return (
		<div className="device-section" data-testid="device-section">
			<div className="settings-section-divider">
				<span>{t("settings.deviceSection")}</span>
			</div>
			<div className="settings-field">
				<span className="settings-hint">{t("settings.deviceHint")}</span>
			</div>
			{!hasAdk ? (
				<div className="settings-field">
					<span className="settings-hint">{t("settings.deviceNoAdk")}</span>
				</div>
			) : loading ? (
				<div className="settings-field">
					<span className="settings-hint">{t("settings.deviceLoading")}</span>
				</div>
			) : (
				<>
					<div className="settings-field">
						<button
							type="button"
							className="device-pair-approve"
							data-testid="device-pair-request"
							onClick={() => void onRequestPair()}
						>
							{t("settings.deviceRequestPair")}
						</button>
					</div>
					{oneTimeCode && (
						<div className="settings-field">
							<label>{t("settings.deviceCode")}</label>
							<code className="device-one-time" data-testid="device-one-time-code">
								{oneTimeCode}
							</code>
						</div>
					)}
					{oneTimeToken && (
						<div className="settings-field">
							<label>{t("settings.deviceTokenOnce")}</label>
							<code
								className="device-one-time"
								data-testid="device-one-time-token"
							>
								{oneTimeToken}
							</code>
						</div>
					)}
					{nodes.length === 0 ? (
						<div className="settings-field">
							<span className="settings-hint">{t("settings.deviceEmpty")}</span>
						</div>
					) : (
						<div className="device-nodes-list">
							{nodes.map((node) => (
								<div
									key={node.nodeId}
									className="device-node-card"
									data-testid="device-node-card"
								>
									<span className="device-node-name">{node.displayName}</span>
									{node.platform && (
										<span className="device-node-platform">{node.platform}</span>
									)}
									<div className="device-node-actions">
										<button
											type="button"
											data-testid="device-describe"
											onClick={() => void onDescribe(node.nodeId)}
										>
											{t("settings.deviceShowDetails")}
										</button>
										<input
											data-testid="device-rename-input"
											value={renameDraft[node.nodeId] ?? ""}
											placeholder={t("settings.deviceNamePlaceholder")}
											onChange={(e) =>
												setRenameDraft((prev) => ({
													...prev,
													[node.nodeId]: e.target.value,
												}))
											}
										/>
										<button
											type="button"
											data-testid="device-rename"
											onClick={() => void onRename(node.nodeId)}
										>
											{t("settings.deviceRename")}
										</button>
										<button
											type="button"
											data-testid="device-rotate"
											disabled={node.revoked}
											onClick={() => void onRotate(node.nodeId)}
										>
											{t("settings.deviceRotate")}
										</button>
										{revokeConfirmId === node.nodeId ? (
											<>
												<span>{t("settings.deviceRevokeConfirm")}</span>
												<button
													type="button"
													data-testid="device-revoke-confirm"
													onClick={() => void onRevoke(node.nodeId)}
												>
													{t("settings.deviceApprove")}
												</button>
												<button
													type="button"
													onClick={() => setRevokeConfirmId(null)}
												>
													{t("settings.deviceReject")}
												</button>
											</>
										) : (
											<button
												type="button"
												data-testid="device-revoke"
												onClick={() => setRevokeConfirmId(node.nodeId)}
											>
												{t("settings.deviceRevoke")}
											</button>
										)}
									</div>
								</div>
							))}
						</div>
					)}
					{described && (
						<div className="settings-field" data-testid="device-describe-result">
							<code>
								{described.nodeId} · {described.displayName} ·{" "}
								{described.platform} · revoked={String(described.revoked)}
							</code>
						</div>
					)}
					<div className="settings-field">
						<label>{t("settings.devicePairRequests")}</label>
					</div>
					{pending.length === 0 ? (
						<div className="settings-field">
							<span className="settings-hint">
								{t("settings.deviceNoPairRequests")}
							</span>
						</div>
					) : (
						<div className="device-pair-requests">
							{pending.map((req) => (
								<div key={req.requestId} className="device-pair-card">
									<span className="device-pair-node">{req.displayName}</span>
									<span className="device-pair-status">
										{req.status === "pending"
											? t("settings.devicePending")
											: req.status}
									</span>
									{req.status === "pending" && (
										<div className="device-pair-actions">
											<input
												data-testid="device-verify-code"
												value={verifyCode[req.requestId] ?? ""}
												placeholder={t("settings.deviceVerifyCode")}
												onChange={(e) =>
													setVerifyCode((prev) => ({
														...prev,
														[req.requestId]: e.target.value,
													}))
												}
											/>
											<button
												type="button"
												data-testid="device-pair-verify"
												onClick={() => void onVerify(req.requestId)}
											>
												{t("settings.deviceVerify")}
											</button>
											<button
												type="button"
												className="device-pair-reject"
												onClick={() => void onReject(req.requestId)}
											>
												{t("settings.deviceReject")}
											</button>
										</div>
									)}
									{req.status === "verified" && (
										<div className="device-pair-actions">
											<button
												type="button"
												className="device-pair-approve"
												data-testid="device-pair-approve"
												onClick={() => void onApprove(req.requestId)}
											>
												{t("settings.deviceApprove")}
											</button>
										</div>
									)}
								</div>
							))}
						</div>
					)}
				</>
			)}
		</div>
	);
}
