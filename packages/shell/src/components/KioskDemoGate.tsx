import { resetKioskMemory } from "../lib/kiosk-demo/memory";
import { unlockAudioContext } from "../lib/voice/audio-queue";
import { useAppStore } from "../stores/app";
import { useChatStore } from "../stores/chat";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
	KIOSK_DEMO_UNAVAILABLE_EVENT,
	getKioskIdleTimeoutMs,
	isKioskVisitExpired,
	recordKioskVisitActivity,
	requestKioskGreeting,
	resetKioskVisit,
	shouldResetKioskVisitOnEnter,
} from "../lib/kiosk-demo/entry";
import { getLocale, t } from "../lib/i18n";
import { isKioskDemo } from "../lib/kiosk-demo/flag";
import { Logger } from "../lib/logger";
import { prepareKioskDemoOnboarding } from "../lib/onboarding-core";
import { resolveEffectiveLayoutOrientation } from "../lib/ui-preferences";
import { bootWebRuntimeAndModel } from "../lib/web-runtime/auto-install";
import { installWebRuntime } from "../lib/web-runtime/install";
import {
	seedKioskDemoWebAuth,
	verifyKioskDemoWebAuth,
} from "../lib/web-runtime/web-auth";
import { clearWebConversations } from "../lib/web-runtime/web-workspace-commands";
import "./KioskDemoGate.css";

type Phase = "preparing" | "ready" | "missing-key" | "unavailable" | "error";

async function cleanupExpiredPreviousVisit(): Promise<void> {
	if (!shouldResetKioskVisitOnEnter()) return;
	await resetKioskVisit({
		cancel: () => undefined,
		resetMemory: resetKioskMemory,
		clearConversations: clearWebConversations,
		newConversation: () => useChatStore.getState().newConversation(),
		reload: () => undefined,
	});
}

async function prepare(): Promise<Phase> {
	try {
		if (!seedKioskDemoWebAuth()) return "missing-key";
		if (typeof verifyKioskDemoWebAuth === "function") {
			const verified = await verifyKioskDemoWebAuth();
			if (!verified.ok) {
				if (verified.reason === "missing-key") return "missing-key";
				if (verified.reason === "unavailable") return "unavailable";
			}
		}
		installWebRuntime();
		await cleanupExpiredPreviousVisit();
		await prepareKioskDemoOnboarding();
		await bootWebRuntimeAndModel({
			consumeAuthCallback: async () => undefined,
		});
		return "ready";
	} catch {
		// Do not log arbitrary storage/provider exceptions: they may contain credentials.
		Logger.debug("KioskDemo", "preparation failed");
		return "error";
	}
}

export function KioskDemoGate({ children }: { children: ReactNode }) {
	const enabled = isKioskDemo();
	const [phase, setPhase] = useState<Phase>("preparing");
	const [entered, setEntered] = useState(false);
	const [resetting, setResetting] = useState(false);
	const [resetFailed, setResetFailed] = useState(false);
	const resetPending = useRef(false);
	const preparation = useRef<Promise<Phase> | null>(null);
	const accepted = useRef(false);
	useEffect(() => {
		if (!enabled) return;
		let active = true;
		preparation.current ??= prepare();
		void preparation.current.then((next) => {
			if (active) setPhase(next);
		});
		return () => {
			active = false;
		};
	}, [enabled]);
	useEffect(() => {
		if (!enabled || typeof window === "undefined") return;
		const onUnavailable = () => {
			accepted.current = false;
			setEntered(false);
			setPhase("unavailable");
		};
		window.addEventListener(KIOSK_DEMO_UNAVAILABLE_EVENT, onUnavailable);
		return () => {
			window.removeEventListener(KIOSK_DEMO_UNAVAILABLE_EVENT, onUnavailable);
		};
	}, [enabled]);
	useEffect(() => {
		if (!enabled || !entered || typeof window === "undefined") return;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const scheduleIdleReset = () => {
			if (timer !== null) clearTimeout(timer);
			const timeoutMs = getKioskIdleTimeoutMs();
			timer = setTimeout(() => {
				if (resetPending.current) return;
				resetPending.current = true;
				void resetKioskVisit({
					cancel: () => undefined,
					resetMemory: resetKioskMemory,
					newConversation: () => useChatStore.getState().newConversation(),
					reload: () => window.location.reload(),
				}).catch(() => {
					resetPending.current = false;
				});
			}, timeoutMs);
		};
		const onActivity = () => {
			recordKioskVisitActivity();
			scheduleIdleReset();
		};
		scheduleIdleReset();
		window.addEventListener("pointerdown", onActivity, { passive: true });
		window.addEventListener("keydown", onActivity);
		window.addEventListener("touchstart", onActivity, { passive: true });
		return () => {
			if (timer !== null) clearTimeout(timer);
			window.removeEventListener("pointerdown", onActivity);
			window.removeEventListener("keydown", onActivity);
			window.removeEventListener("touchstart", onActivity);
		};
	}, [enabled, entered]);
	if (!enabled || entered) return <>{children}</>;
	return (
		<main className="kiosk-entry" lang={getLocale()}>
			<section aria-labelledby="kiosk-title" className="kiosk-entry__card">
				<p>NAIA · NEXTAIN</p>
				{phase === "unavailable" ? (
					<div role="alert" className="kiosk-entry__unavailable">
						<h1 id="kiosk-title">{t("kiosk.unavailableTitle")}</h1>
						<p>{t("kiosk.unavailableBody1")}</p>
						<p>{t("kiosk.unavailableBody2")}</p>
					</div>
				) : (
					<>
						<h1 id="kiosk-title">{t("kiosk.entryTitle")}</h1>
						<p>
							{t("kiosk.entrySubtitle1")}
							<br />
							{t("kiosk.entrySubtitle2")}
						</p>
						{phase === "missing-key" ? (
							<p role="alert">{t("kiosk.missingKey")}</p>
						) : phase === "error" ? (
							<p role="alert">{t("kiosk.prepareError")}</p>
						) : (
							<output>
								{phase === "preparing"
									? t("kiosk.preparing")
									: t("kiosk.readyHint")}
							</output>
						)}
						<div className="kiosk-entry__actions">
							{phase === "error" ? (
								<button
									type="button"
									data-usage-event="kiosk-demo-gate.v026-add-1.click"
									onClick={() => {
										setPhase("preparing");
										preparation.current = prepare();
										void preparation.current.then(setPhase);
									}}
								>
									{t("common.retry")}
								</button>
							) : (
								<button
									type="button"
									disabled={phase !== "ready" || resetting}
									data-usage-event="kiosk-demo-gate.v026-add-2.click"
									onClick={() => {
										if (accepted.current) return;
										accepted.current = true;
										unlockAudioContext();
										const enterNow = () => {
											recordKioskVisitActivity();
											requestKioskGreeting();
											const isPortraitLayout =
												resolveEffectiveLayoutOrientation() === "portrait";
											if (!isPortraitLayout) {
												useAppStore.getState().setActiveApp("workspace");
											}
											setEntered(true);
										};
										if (isKioskVisitExpired()) {
											void cleanupExpiredPreviousVisit().finally(enterNow);
											return;
										}
										enterNow();
									}}
								>
									{t("kiosk.enter")}
								</button>
							)}
							<button
								className="kiosk-entry__reset"
								type="button"
								disabled={phase !== "ready" || resetting}
								data-usage-event="kiosk-demo-gate.v026-add-3.click"
								onClick={async () => {
									if (resetPending.current) return;
									resetPending.current = true;
									setResetting(true);
									setResetFailed(false);
									try {
										await resetKioskVisit({
											cancel: () => undefined,
											resetMemory: resetKioskMemory,
											newConversation: () =>
												useChatStore.getState().newConversation(),
											reload: () => window.location.reload(),
										});
									} catch {
										setResetFailed(true);
										setResetting(false);
										resetPending.current = false;
									}
								}}
							>
								{t("kiosk.reset")}
							</button>
						</div>
					</>
				)}
				{resetting && <p role="status">{t("kiosk.resetting")}</p>}
				{resetFailed && <p role="alert">{t("kiosk.resetFailed")}</p>}
			</section>
		</main>
	);
}
