import { resetKioskMemory } from "../lib/kiosk-demo/memory";
import { unlockAudioContext } from "../lib/voice/audio-queue";
import { useChatStore } from "../stores/chat";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { requestKioskGreeting, resetKioskVisit } from "../lib/kiosk-demo/entry";
import { isKioskDemo } from "../lib/kiosk-demo/flag";
import { Logger } from "../lib/logger";
import { prepareKioskDemoOnboarding } from "../lib/onboarding-core";
import { bootWebRuntimeAndModel } from "../lib/web-runtime/auto-install";
import { installWebRuntime } from "../lib/web-runtime/install";
import { seedKioskDemoWebAuth } from "../lib/web-runtime/web-auth";
import "./KioskDemoGate.css";

type Phase = "preparing" | "ready" | "missing-key" | "error";

async function prepare(): Promise<Phase> {
	try {
		if (!seedKioskDemoWebAuth()) return "missing-key";
		installWebRuntime();
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
	if (!enabled || entered) return <>{children}</>;
	return (
		<main className="kiosk-entry" lang="ko">
			<section aria-labelledby="kiosk-title" className="kiosk-entry__card">
				<p>NAIA · NEXTAIN</p>
				<h1 id="kiosk-title">지나와 이야기해 보세요</h1>
				<p>
					나이아와 넥스테인이 궁금하신가요?
					<br />
					게스트님을 따뜻하게 안내해 드릴게요.
				</p>
				{phase === "missing-key" ? (
					<p role="alert">시연 열쇠 없음</p>
				) : phase === "error" ? (
					<p role="alert">시연을 준비하지 못했어요. 다시 시도해 주세요.</p>
				) : (
					<output>
						{phase === "preparing"
							? "지나가 대화를 준비하고 있어요…"
							: "들어가기를 누르면 음성 안내가 시작됩니다."}
					</output>
				)}
				<div className="kiosk-entry__actions">
					{phase === "error" ? (
						<button
							type="button"
							onClick={() => {
								setPhase("preparing");
								preparation.current = prepare();
								void preparation.current.then(setPhase);
							}}
						>
							다시 시도
						</button>
					) : (
						<button
							type="button"
							disabled={phase !== "ready" || resetting}
							onClick={() => {
								if (accepted.current) return;
								accepted.current = true;
								unlockAudioContext();
								requestKioskGreeting();
								setEntered(true);
							}}
						>
							들어가기
						</button>
					)}
					<button
						className="kiosk-entry__reset"
						type="button"
						disabled={phase !== "ready" || resetting}
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
						처음으로
					</button>
				</div>
				{resetting && <p role="status">처음 화면으로 돌아가고 있어요…</p>}
				{resetFailed && (
					<p role="alert">
						기억을 초기화하지 못했어요. 처음으로를 다시 눌러 주세요.
					</p>
				)}
			</section>
		</main>
	);
}
