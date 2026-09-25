import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { t } from "../lib/i18n";
import { Logger } from "../lib/logger";

type PairStatus = "pending" | "verified" | "approved" | "rejected";

interface NodePublic {
	nodeId: string;
	displayName: string;
	platform: string;
	createdAt: number;
	lastSeen?: number;
	hasToken: boolean;
}

interface PairRequestPublic {
	requestId: string;
	nodeId: string;
	displayName: string;
	platform: string;
	status: PairStatus;
	createdAt: number;
	expiresAt: number;
}

interface PairRequestCreated {
	request: PairRequestPublic;
	code: string;
}

interface ApprovedNode {
	node: NodePublic;
	token: string;
}

export function DevicePairingSection() {
	const [nodes, setNodes] = useState<NodePublic[]>([]);
	const [requests, setRequests] = useState<PairRequestPublic[]>([]);
	const [loading, setLoading] = useState(false);
	const [name, setName] = useState("");
	const [verifyCode, setVerifyCode] = useState("");
	const [onceSecret, setOnceSecret] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		setLoading(true);
		try {
			const [nextNodes, nextRequests] = await Promise.all([
				invoke<NodePublic[]>("device_list"),
				invoke<PairRequestPublic[]>("device_list_requests"),
			]);
			setNodes(nextNodes);
			setRequests(nextRequests);
			setError(null);
		} catch (err) {
			Logger.warn("DevicePairing", "Failed to fetch devices", {
				error: String(err),
			});
			setError(String(err));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const run = useCallback(
		async (action: () => Promise<void>) => {
			try {
				await action();
				await refresh();
			} catch (err) {
				Logger.warn("DevicePairing", "device action failed", {
					error: String(err),
				});
				setError(String(err));
			}
		},
		[refresh],
	);

	return (
		<div className="device-section" data-testid="device-section">
			<div className="settings-section-divider">
				<span>{t("settings.deviceSection")}</span>
			</div>
			<div className="settings-field">
				<span className="settings-hint">{t("settings.deviceHint")}</span>
			</div>
			{error && (
				<div className="settings-field">
					<span className="settings-hint">{error}</span>
				</div>
			)}
			{onceSecret && (
				<div className="settings-field">
					<span className="settings-hint" data-testid="device-once-secret">
						{onceSecret}
					</span>
				</div>
			)}
			<div className="settings-field">
				<input
					data-testid="device-name-input"
					placeholder={t("settings.deviceNamePlaceholder")}
					value={name}
					onChange={(e) => setName(e.target.value)}
				/>
				<button
					type="button"
					data-testid="device-request-pair"
					onClick={() =>
						run(async () => {
							const created = await invoke<PairRequestCreated>(
								"device_pair_request",
								{ displayName: name, platform: "windows" },
							);
							setOnceSecret(
								t("settings.deviceCodeOnce", { code: created.code }),
							);
							setName("");
						})
					}
				>
					{t("settings.deviceRequestPair")}
				</button>
			</div>
			{loading ? (
				<div className="settings-field">
					<span className="settings-hint">{t("settings.deviceLoading")}</span>
				</div>
			) : nodes.length === 0 ? (
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
							<span className="device-node-platform">{node.platform}</span>
							<button
								type="button"
								onClick={() =>
									run(async () => {
										await invoke("device_rename", {
											nodeId: node.nodeId,
											displayName: "e2e-node",
										});
									})
								}
							>
								{t("settings.deviceRename")}
							</button>
							<button
								type="button"
								data-testid="device-rotate"
								onClick={() =>
									run(async () => {
										const token = await invoke<string>("device_token_rotate", {
											nodeId: node.nodeId,
										});
										setOnceSecret(t("settings.deviceTokenOnce", { token }));
									})
								}
							>
								{t("settings.deviceRotate")}
							</button>
							<button
								type="button"
								data-testid="device-revoke"
								onClick={() =>
									run(async () => {
										if (!globalThis.confirm(t("settings.deviceRevokeConfirm"))) return;
										await invoke("device_token_revoke", {
											nodeId: node.nodeId,
										});
									})
								}
							>
								{t("settings.deviceRevoke")}
							</button>
						</div>
					))}
				</div>
			)}
			{requests.length > 0 && (
				<>
					<div className="settings-field">
						<label>{t("settings.devicePairRequests")}</label>
					</div>
					<div className="device-pair-requests">
						{requests.map((req) => (
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
											value={verifyCode}
											onChange={(e) => setVerifyCode(e.target.value)}
										/>
										<button
											type="button"
											data-testid="device-verify"
											onClick={() =>
												run(async () => {
													await invoke("device_pair_verify", {
														requestId: req.requestId,
														code: verifyCode,
													});
													setVerifyCode("");
												})
											}
										>
											{t("settings.deviceVerify")}
										</button>
										<button
											type="button"
											className="device-pair-reject"
											onClick={() =>
												run(async () => {
													await invoke("device_pair_reject", {
														requestId: req.requestId,
													});
												})
											}
										>
											{t("settings.deviceReject")}
										</button>
									</div>
								)}
								{req.status === "verified" && (
									<button
										type="button"
										className="device-pair-approve"
										data-testid="device-approve"
										onClick={() =>
											run(async () => {
												const approved = await invoke<ApprovedNode>(
													"device_pair_approve",
													{ requestId: req.requestId },
												);
												setOnceSecret(
													t("settings.deviceTokenOnce", {
														token: approved.token,
													}),
												);
											})
										}
									>
										{t("settings.deviceApprove")}
									</button>
								)}
							</div>
						))}
					</div>
				</>
			)}
			{requests.length === 0 && nodes.length > 0 && (
				<div className="settings-field">
					<span className="settings-hint">
						{t("settings.deviceNoPairRequests")}
					</span>
				</div>
			)}
		</div>
	);
}
