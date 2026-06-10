import { useEffect } from "react";
import { createPortal } from "react-dom";
import { t } from "../lib/i18n";
import type { PendingApproval } from "../stores/chat";
import { usePanelStore } from "../stores/panel";

interface Props {
	pending: PendingApproval;
	onDecision: (decision: "once" | "always" | "reject") => void;
}

export function PermissionModal({ pending, onDecision }: Props) {
	const tierLabel =
		pending.tier >= 2 ? t("permission.tier2") : t("permission.tier1");
	const tierClass = pending.tier >= 2 ? "tier-2" : "tier-1";
	const pushModal = usePanelStore((s) => s.pushModal);
	const popModal = usePanelStore((s) => s.popModal);

	// Hide Chrome X11 embed while permission modal is visible
	useEffect(() => {
		pushModal();
		return () => popModal();
	}, [pushModal, popModal]);

	return createPortal(
		<div className="permission-overlay">
			<div className="permission-modal">
				<h3>{t("permission.title")}</h3>

				<div className="permission-info">
					<span className={`permission-tier-badge ${tierClass}`}>
						{tierLabel}
					</span>
					<span className="permission-tool-name">{pending.description}</span>
				</div>

				<div className="permission-args">
					<pre>{JSON.stringify(pending.args, null, 2)}</pre>
				</div>

				<div className="permission-actions">
					<button
						type="button"
						className="permission-btn-once"
						onClick={() => onDecision("once")}
					>
						{t("permission.allowOnce")}
					</button>
					<button
						type="button"
						className="permission-btn-always"
						onClick={() => onDecision("always")}
					>
						{t("permission.allowAlways")}
					</button>
					<button
						type="button"
						className="permission-btn-reject"
						onClick={() => onDecision("reject")}
					>
						{t("permission.reject")}
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}
