import { useState } from "react";
import { t } from "../lib/i18n";

export function WebPushSettings() {
	const [status, setStatus] = useState("");
	const [subscription, setSubscription] = useState("");
	const [busy, setBusy] = useState(false);
	async function enable() {
		setBusy(true);
		setSubscription("");
		try {
			if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
				setStatus(t("webPush.unsupported"));
				return;
			}
			const permission = await Notification.requestPermission();
			if (permission !== "granted") {
				setStatus(t("webPush.permissionDenied"));
				return;
			}
			const registration = await navigator.serviceWorker.ready;
			let existing = await registration.pushManager.getSubscription();
			const publicKey = import.meta.env.VITE_WEB_PUSH_VAPID_PUBLIC_KEY as string | undefined;
			if (!existing && publicKey) {
				existing = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey });
			}
			if (!existing) {
				setStatus(t("webPush.waitingServer"));
				return;
			}
			setSubscription(JSON.stringify(existing.toJSON(), null, 2));
			setStatus(t("webPush.subscriptionAvailable"));
		} catch {
			setStatus(t("webPush.failed"));
		} finally {
			setBusy(false);
		}
	}
	return (
		<details className="settings-field" data-testid="web-push-settings">
			<summary>{t("webPush.title")}</summary>
			<p>{t("webPush.description")}</p>
			<button type="button" className="voice-preview-btn" disabled={busy} onClick={() => void enable()}>{t("webPush.enable")}</button>
			<p role="status">{status}</p>
			{subscription && <details><summary>{t("webPush.subscriptionDetails")}</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{subscription}</pre></details>}
		</details>
	);
}
