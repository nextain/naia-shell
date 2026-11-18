import { type ReactNode, useEffect, useRef, useState } from "react";
import { prewarmWebSpeechAssets } from "../lib/avatar/nva-speech/speech-asset-prewarm";
import { loadConfig } from "../lib/config";
import {
	KIOSK_DEMO_UNAVAILABLE_EVENT,
	getKioskIdleTimeoutMs,
	isKioskVisitExpired,
	recordKioskVisitActivity,
	requestKioskGreeting,
	resetKioskVisit,
	shouldResetKioskVisitOnEnter,
} from "../lib/kiosk-demo/entry";
import { isKioskDemo } from "../lib/kiosk-demo/flag";
import {
	KIOSK_PASSCODE_LENGTH,
	KIOSK_PASSCODE_SHA256,
	hasPassedKioskPasscode,
	markKioskPasscodePassed,
	verifyKioskPasscode,
} from "../lib/kiosk-demo/passcode";
import { Logger } from "../lib/logger";
import { prepareKioskDemoOnboarding } from "../lib/onboarding-core";
import { resolveEffectiveLayoutOrientation } from "../lib/ui-preferences";
import { unlockAudioContext } from "../lib/voice/audio-queue";
import { bootWebRuntimeAndModel } from "../lib/web-runtime/auto-install";
import { installWebRuntime } from "../lib/web-runtime/install";
import { restoreKioskAdkOriginals } from "../lib/web-runtime/web-adk-edit";
import {
	seedKioskDemoWebAuth,
	verifyKioskDemoWebAuth,
} from "../lib/web-runtime/web-auth";
import { clearWebConversations } from "../lib/web-runtime/web-workspace-commands";
import { useAppStore } from "../stores/app";
import { useChatStore } from "../stores/chat";
import "./KioskDemoGate.css";

type Phase = "preparing" | "ready" | "missing-key" | "unavailable" | "error";

async function cleanupExpiredPreviousVisit(): Promise<void> {
	if (!shouldResetKioskVisitOnEnter()) return;
	await resetKioskVisit({
		cancel: () => undefined,
		clearConversations: clearWebConversations,
		newConversation: () => useChatStore.getState().newConversation(),
		reload: () => undefined,
	});
}

type AccessRefusal = "missing-key" | "unavailable";
interface AccessCheckOutcome {
	refusal: AccessRefusal | null;
	lookupFailed: boolean;
}

/**
 * Gateway's word on the demo session. It runs beside the local preparation and
 * never holds the entry button on a slow balance lookup: once a valid session
 * token is acquired, a slow balance lookup lets the visitor in, and a refusal
 * that lands later closes the gate again.
 */
async function checkAccess(): Promise<AccessCheckOutcome> {
	if (typeof verifyKioskDemoWebAuth !== "function") {
		return { refusal: null, lookupFailed: false };
	}
	try {
		const verified = await verifyKioskDemoWebAuth();
		if (!verified.ok) {
			if (
				verified.reason === "missing-key" ||
				verified.reason === "unavailable"
			) {
				return { refusal: verified.reason, lookupFailed: false };
			}
			return { refusal: null, lookupFailed: true };
		}
	} catch {
		// Do not log arbitrary provider exceptions: they may contain credentials.
		Logger.debug("KioskDemo", "access check failed");
		return { refusal: null, lookupFailed: true };
	}
	return { refusal: null, lookupFailed: false };
}

async function prepare(
	refused: () => AccessRefusal | null,
	waitAccess: () => Promise<AccessCheckOutcome>,
): Promise<Phase> {
	try {
		installWebRuntime();
		await cleanupExpiredPreviousVisit();
		const seeded = await seedKioskDemoWebAuth();
		if (!seeded) {
			const outcome = await waitAccess();
			if (outcome.refusal) return outcome.refusal;
			return outcome.lookupFailed ? "error" : "missing-key";
		}
		await prepareKioskDemoOnboarding();
		// R3: 부팅 때마다 시연 ADK 원본(AGENTS.md 등)을 되돌려 안내와 일치시킨다.
		await restoreKioskAdkOriginals();
		// A refusal already known skips the model; a later one closes the gate.
		const refusal = refused();
		if (refusal) return refusal;
		// Mouth assets start loading here so the first greeting can already lip-sync.
		void prewarmWebSpeechAssets(loadConfig()?.nvaModel);
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

function KioskPasscodeForm({
	expectedSha256,
	onPassed,
}: {
	expectedSha256: string;
	onPassed: () => void;
}) {
	const [value, setValue] = useState("");
	const [wrong, setWrong] = useState(false);
	const checking = useRef(false);
	const submit = async (candidate: string) => {
		if (checking.current) return;
		checking.current = true;
		try {
			if (await verifyKioskPasscode(candidate, expectedSha256)) {
				markKioskPasscodePassed();
				onPassed();
				return;
			}
			setWrong(true);
			setValue("");
		} finally {
			checking.current = false;
		}
	};
	return (
		<form
			className="kiosk-entry__passcode"
			onSubmit={(event) => {
				event.preventDefault();
				void submit(value);
			}}
		>
			<h1 id="kiosk-title">비밀번호를 입력해 주세요</h1>
			<p>
				<label htmlFor="kiosk-passcode">숫자 {KIOSK_PASSCODE_LENGTH}자리</label>
			</p>
			<input
				id="kiosk-passcode"
				data-testid="kiosk-passcode-input"
				type="password"
				inputMode="numeric"
				pattern="[0-9]*"
				autoComplete="off"
				maxLength={KIOSK_PASSCODE_LENGTH}
				value={value}
				aria-invalid={wrong}
				aria-describedby={wrong ? "kiosk-passcode-error" : undefined}
				// biome-ignore lint/a11y/noAutofocus: 첫 화면의 하나뿐인 입력 칸
				autoFocus
				onChange={(event) => {
					const next = event.target.value
						.replace(/\D/g, "")
						.slice(0, KIOSK_PASSCODE_LENGTH);
					setValue(next);
					if (next) setWrong(false);
					if (next.length === KIOSK_PASSCODE_LENGTH) void submit(next);
				}}
			/>
			{wrong && (
				<p id="kiosk-passcode-error" role="alert">
					비밀번호가 맞지 않아요. 다시 입력해 주세요.
				</p>
			)}
			<div className="kiosk-entry__actions">
				<button type="submit" disabled={value.length !== KIOSK_PASSCODE_LENGTH}>
					확인
				</button>
			</div>
		</form>
	);
}

export function KioskDemoGate({
	children,
	passcodeSha256 = KIOSK_PASSCODE_SHA256,
}: {
	children: ReactNode;
	/** 시험에서 흉내 해시를 넣는 자리. 운영은 기본값을 쓴다. */
	passcodeSha256?: string;
}) {
	const enabled = isKioskDemo();
	const [passcodePassed, setPasscodePassed] = useState(hasPassedKioskPasscode);
	const [phase, setPhase] = useState<Phase>("preparing");
	const [entered, setEntered] = useState(false);
	const resetPending = useRef(false);
	const preparation = useRef<Promise<Phase> | null>(null);
	const access = useRef<Promise<AccessCheckOutcome> | null>(null);
	const refused = useRef<AccessRefusal | null>(null);
	const accepted = useRef(false);
	useEffect(() => {
		if (!enabled || !passcodePassed) return;
		let active = true;
		access.current ??= checkAccess().then((outcome) => {
			refused.current = outcome.refusal;
			return outcome;
		});
		preparation.current ??= prepare(
			() => refused.current,
			() =>
				access.current ??
				Promise.resolve({ refusal: null, lookupFailed: false }),
		);
		void access.current.then((outcome) => {
			if (!active || !outcome.refusal) return;
			accepted.current = false;
			setEntered(false);
			setPhase(outcome.refusal);
		});
		void preparation.current.then((next) => {
			if (active) setPhase(refused.current ?? next);
		});
		return () => {
			active = false;
		};
	}, [enabled, passcodePassed]);
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
		<main className="kiosk-entry" lang="ko">
			<section aria-labelledby="kiosk-title" className="kiosk-entry__card">
				<p>NAIA · NEXTAIN</p>
				{!passcodePassed ? (
					<KioskPasscodeForm
						expectedSha256={passcodeSha256}
						onPassed={() => setPasscodePassed(true)}
					/>
				) : phase === "unavailable" ? (
					<div role="alert" className="kiosk-entry__unavailable">
						<h1 id="kiosk-title">지금은 시연을 잠시 쉬고 있어요</h1>
						<p>오늘 준비한 시연 사용량을 다 썼어요.</p>
						<p>잠시 뒤 다시 들어와 주세요.</p>
					</div>
				) : (
					<>
						<h1 id="kiosk-title">지나와 이야기해 보세요</h1>
						<p>
							나이아와 넥스테인이 궁금하신가요?
							<br />
							게스트님을 따뜻하게 안내해 드릴게요.
							<br />
							실시간 인터넷 검색과 외부 브라우저 열기는 지원하지 않아요.
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
										refused.current = null;
										access.current = checkAccess().then((outcome) => {
											refused.current = outcome.refusal;
											return outcome;
										});
										preparation.current = prepare(
											() => refused.current,
											() =>
												access.current ??
												Promise.resolve({ refusal: null, lookupFailed: false }),
										);
										void access.current.then((outcome) => {
											if (!outcome.refusal) return;
											accepted.current = false;
											setEntered(false);
											setPhase(outcome.refusal);
										});
										void preparation.current.then((next) =>
											setPhase(refused.current ?? next),
										);
									}}
								>
									다시 시도
								</button>
							) : (
								<button
									type="button"
									disabled={phase !== "ready"}
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
									들어가기
								</button>
							)}
						</div>
					</>
				)}
			</section>
		</main>
	);
}
