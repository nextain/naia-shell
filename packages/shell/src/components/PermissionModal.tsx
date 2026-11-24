import { useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { t } from "../lib/i18n";
import type { PendingApproval } from "../stores/chat";
import { useAppStore } from "../stores/app";
import {
	permissionDecisionFromKeyboardEvent,
	permissionShortcutLabel,
	type PermissionDecision,
} from "../lib/permission-shortcuts";

interface Props {
	pending: PendingApproval;
	onDecision: (decision: "once" | "always" | "reject") => void;
}

export function PermissionModal({ pending, onDecision }: Props) {
	const tierLabel =
		pending.tier >= 2 ? t("permission.tier2") : t("permission.tier1");
	const tierClass = pending.tier >= 2 ? "tier-2" : "tier-1";
	const pushModal = useAppStore((s) => s.pushModal);
	const popModal = useAppStore((s) => s.popModal);
	const settledRef = useRef(false);
	const decide = useCallback(
		(decision: PermissionDecision) => {
			if (settledRef.current) return;
			settledRef.current = true;
			onDecision(decision);
		},
		[onDecision],
	);

	// Hide Chrome X11 embed while permission modal is visible
	useEffect(() => {
		pushModal();
		return () => popModal();
	}, [pushModal, popModal]);

	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			const decision = permissionDecisionFromKeyboardEvent(event);
			if (!decision) return;
			event.preventDefault();
			event.stopPropagation();
			decide(decision);
		};
		window.addEventListener("keydown", handleKeyDown, true);
		return () => window.removeEventListener("keydown", handleKeyDown, true);
	}, [decide]);

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
						data-usage-event="permission-modal.button-1.click"
						onClick={() => decide("once")}
					>
						{t("permission.allowOnce")} ({permissionShortcutLabel("once")})
					</button>
					<button
						type="button"
						className="permission-btn-always"
						data-usage-event="permission-modal.button-2.click"
						onClick={() => decide("always")}
					>
						{t("permission.allowAlways")} ({permissionShortcutLabel("always")})
					</button>
					<button
						type="button"
						className="permission-btn-reject"
						data-usage-event="permission-modal.button-3.click"
						onClick={() => decide("reject")}
					>
						{t("permission.reject")} ({permissionShortcutLabel("reject")})
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}
