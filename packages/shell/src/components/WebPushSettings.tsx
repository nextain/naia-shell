import { useState } from "react";
import { getLocale } from "../lib/i18n";

export function WebPushSettings() {
	const ko = getLocale() === "ko";
	const [status, setStatus] = useState("");
	const [subscription, setSubscription] = useState("");
	const [busy, setBusy] = useState(false);
	async function enable() {
		setBusy(true);
		setSubscription("");
		try {
			if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
				setStatus(ko ? "이 브라우저에서는 푸시 알림을 지원하지 않습니다." : "Push notifications are not supported in this browser.");
				return;
			}
			const permission = await Notification.requestPermission();
			if (permission !== "granted") {
				setStatus(ko ? "알림 권한이 허용되지 않았습니다." : "Notification permission was not granted.");
				return;
			}
			const registration = await navigator.serviceWorker.ready;
			let existing = await registration.pushManager.getSubscription();
			const publicKey = import.meta.env.VITE_WEB_PUSH_VAPID_PUBLIC_KEY as string | undefined;
			if (!existing && publicKey) {
				existing = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey });
			}
			if (!existing) {
				setStatus(ko ? "알림 권한이 허용되었습니다. 푸시 서버 설정을 기다리는 중입니다." : "Notification permission granted. Waiting for push server configuration.");
				return;
			}
			setSubscription(JSON.stringify(existing.toJSON(), null, 2));
			setStatus(ko ? "이 브라우저의 구독 정보를 확인했습니다. 알림 발송은 준비 중입니다." : "Subscription available on this browser. Notification delivery is being prepared.");
		} catch {
			setStatus(ko ? "알림 설정을 완료하지 못했습니다. 브라우저 설정을 확인해 주세요." : "Could not set up notifications. Check your browser settings.");
		} finally {
			setBusy(false);
		}
	}
	return (
		<details className="settings-field" data-testid="web-push-settings">
			<summary>{ko ? "웹 알림 (실험적)" : "Web notifications (experimental)"}</summary>
			<p>{ko ? "알림 권한과 이 브라우저의 구독 정보를 확인합니다. 알림 발송 기능은 준비 중입니다." : "Check notification permission and this browser's subscription. Notification delivery is being prepared."}</p>
			<button type="button" className="voice-preview-btn" disabled={busy} onClick={() => void enable()}>{ko ? "알림 설정" : "Set up notifications"}</button>
			<p role="status">{status}</p>
			{subscription && <details><summary>{ko ? "구독 정보" : "Subscription details"}</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{subscription}</pre></details>}
		</details>
	);
}
