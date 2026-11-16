import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Logger } from "../../lib/logger";
import { CodeMirrorEditor } from "./CodeMirrorEditor";
import {
	type BlackjackTableState,
	type Card,
	type ExecutionMode,
	adjustBet,
	createInitialTableState,
	dealRound,
	hitPlayer,
	prepareNextBettingRound,
	standPlayer,
} from "./domain";
import { type BlackjackGradeReport, gradeBlackjackCode } from "./grader";
import {
	type BlackjackMessageKey,
	blackjackText,
	buildFallbackTutorReply,
	buildStarterProjectBundle,
	buildTutorAskPrompt,
	getStarterCode,
	getStepCurriculum,
	resolveBlackjackLocale,
} from "./locales/messages";
import {
	type BlackjackStudioBridge,
	createWindowBlackjackBridge,
} from "./studio-bridge";
import {
	buildBlackjackContextPayload,
	handleBlackjackTutorToolCall,
} from "./tools";
import "./blackjack.css";

const TAG = "BlackjackStudioApp";

type MobilePane = "mission" | "editor" | "table";

export interface BlackjackStudioAppProps {
	bridge?: BlackjackStudioBridge;
	localeOverride?: string;
	initialCode?: string;
	random?: () => number;
}

function isRedSuit(suit: string): boolean {
	return suit === "♥" || suit === "♦";
}

function triggerTextDownload(filename: string, content: string): void {
	if (typeof document === "undefined" || typeof URL === "undefined") return;
	if (typeof URL.createObjectURL !== "function") return;
	const blob = new Blob([content], { type: "text/javascript;charset=utf-8" });
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	anchor.style.display = "none";
	document.body.appendChild(anchor);
	anchor.click();
	document.body.removeChild(anchor);
	URL.revokeObjectURL(url);
}

export function BlackjackStudioApp({
	bridge: injectedBridge,
	localeOverride,
	initialCode,
	random,
}: BlackjackStudioAppProps) {
	const defaultBridge = useMemo(() => createWindowBlackjackBridge(), []);
	const bridge = injectedBridge ?? defaultBridge;

	const [hostLocale, setHostLocale] = useState<string | undefined>(undefined);
	const locale = resolveBlackjackLocale(hostLocale ?? localeOverride);

	const msg = useCallback(
		(
			key: BlackjackMessageKey,
			params?: Readonly<Record<string, string | number>>,
		) => blackjackText(key, params, locale),
		[locale],
	);

	const curriculum = useMemo(() => getStepCurriculum(locale), [locale]);

	const [mobilePane, setMobilePane] = useState<MobilePane>("mission");
	const [currentStep, setCurrentStep] = useState<1 | 2 | 3 | 4 | 5>(1);
	const [openedHintsByStep, setOpenedHintsByStep] = useState<
		Record<number, number>
	>({
		1: 0,
		2: 0,
		3: 0,
		4: 0,
		5: 0,
	});

	const [code, setCode] = useState<string>(
		() => initialCode ?? getStarterCode(locale),
	);
	const [gradeReport, setGradeReport] = useState<BlackjackGradeReport>(() =>
		gradeBlackjackCode(initialCode ?? getStarterCode(locale)),
	);

	const [executionMode, setExecutionMode] = useState<ExecutionMode>("learner");
	const [table, setTable] = useState<BlackjackTableState>(() =>
		createInitialTableState(500),
	);

	const [speakingId, setSpeakingId] = useState<string | null>(null);
	const [askInput, setAskInput] = useState<string>("");
	const [askingTutor, setAskingTutor] = useState<boolean>(false);
	const [tutorReply, setTutorReply] = useState<{
		text: string;
		fromFallback: boolean;
	} | null>(null);

	const [confirmReset, setConfirmReset] = useState<boolean>(false);
	const [statusBanner, setStatusBanner] = useState<string | null>(null);
	const [errorBanner, setErrorBanner] = useState<string | null>(null);

	const snapshotRef = useRef({
		currentStep,
		openedHintsByStep,
		table,
		gradeReport,
		locale,
		code,
	});
	snapshotRef.current = {
		currentStep,
		openedHintsByStep,
		table,
		gradeReport,
		locale,
		code,
	};

	const runGraderWithCode = useCallback((targetCode: string) => {
		Logger.debug(TAG, "running blackjack auto-grader");
		const nextReport = gradeBlackjackCode(targetCode);
		setGradeReport(nextReport);
		return nextReport;
	}, []);

	useEffect(() => {
		const payload = buildBlackjackContextPayload({
			currentStep,
			openedHintsByStep,
			table,
			gradeReport,
			locale,
		});
		bridge.pushContext(payload);
	}, [bridge, currentStep, openedHintsByStep, table, gradeReport, locale]);

	useEffect(() => {
		return () => {
			bridge.pushContext(null);
		};
	}, [bridge]);

	useEffect(() => {
		const unsubscribe = bridge.subscribeHostEvents({
			onLocale(nextLocale) {
				setHostLocale(nextLocale);
			},
			onToolCall(tool, args) {
				if (tool !== "skill_blackjack_tutor") {
					return { ok: false, error: `Unknown tool: ${tool}` };
				}
				return handleBlackjackTutorToolCall(args, {
					getSnapshot: () => ({
						currentStep: snapshotRef.current.currentStep,
						openedHintsByStep: snapshotRef.current.openedHintsByStep,
						table: snapshotRef.current.table,
						gradeReport: snapshotRef.current.gradeReport,
						locale: snapshotRef.current.locale,
					}),
					setStep: (step) => setCurrentStep(step),
					openNextHint: (step) => {
						const prev = snapshotRef.current.openedHintsByStep[step] ?? 0;
						const next = Math.min(3, prev + 1);
						setOpenedHintsByStep((map) => ({ ...map, [step]: next }));
						return next;
					},
					runGrader: () => runGraderWithCode(snapshotRef.current.code),
				});
			},
		});
		return unsubscribe;
	}, [bridge, runGraderWithCode]);

	const activeLesson = curriculum[currentStep - 1] ?? curriculum[0]!;
	const openedHintsCount = openedHintsByStep[currentStep] ?? 0;

	const handleSpeakLesson = () => {
		if (speakingId) {
			bridge.cancelSpeak(speakingId);
		}
		const { requestId } = bridge.speak(activeLesson.voiceScript, () => {
			setSpeakingId((current) => (current === requestId ? null : current));
		});
		setSpeakingId(requestId);
	};

	const handleStopSpeak = () => {
		if (!speakingId) return;
		bridge.cancelSpeak(speakingId);
		setSpeakingId(null);
	};

	const handleOpenNextHint = () => {
		setOpenedHintsByStep((prev) => {
			const current = prev[currentStep] ?? 0;
			return { ...prev, [currentStep]: Math.min(3, current + 1) };
		});
	};

	const submitTutorQuestion = async (questionText: string) => {
		const trimmed = questionText.trim();
		if (!trimmed || askingTutor) return;
		setAskingTutor(true);
		setErrorBanner(null);
		const latestReport = runGraderWithCode(code);
		const latestFailed = latestReport.steps
			.flatMap((s) => s.checks)
			.filter((c) => !c.passed)
			.map((c) => msg(c.labelKey));

		const prompt = buildTutorAskPrompt({
			step: currentStep,
			question: trimmed,
			code,
			failedCheckLabels: latestFailed,
			localeOverride: locale,
		});
		const reply = await bridge.askTutor(prompt, () =>
			buildFallbackTutorReply({
				step: currentStep,
				question: trimmed,
				failedCheckLabels: latestFailed,
				localeOverride: locale,
			}),
		);
		setTutorReply(reply);
		setAskingTutor(false);
	};

	const handleCopyAgentPrompt = async () => {
		const textToCopy = `${activeLesson.agentPrompt}\n\n\`\`\`js\n${code.trimEnd()}\n\`\`\``;
		try {
			if (navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(textToCopy);
				setStatusBanner(msg("bj.copiedNotice"));
				setErrorBanner(null);
				return;
			}
		} catch (err) {
			Logger.warn(TAG, "clipboard write failed", { error: String(err) });
		}
		setErrorBanner(msg("bj.copyFailedNotice"));
	};

	const handleRunAndGrade = useCallback(() => {
		const report = runGraderWithCode(code);
		setErrorBanner(null);
		if (table.phase !== "player_turn") {
			setTable((prev) => ({
				...prev,
				fallbackFunctions: [],
			}));
		}
		return report;
	}, [code, runGraderWithCode, table.phase]);

	const handleConfirmResetStarter = () => {
		const starter = getStarterCode(locale);
		setCode(starter);
		runGraderWithCode(starter);
		setConfirmReset(false);
		setStatusBanner(msg("bj.statusResetDone"));
	};

	const handleProvisionLocal = async () => {
		setErrorBanner(null);
		const files = buildStarterProjectBundle(code, locale);
		const res = await bridge.provisionProject(files, false);
		if (res.ok) {
			setStatusBanner(
				msg("bj.statusProvisioned", {
					dir: res.data.projectDir,
					written: res.data.writtenFiles.length,
					skipped: res.data.skippedFiles.length,
				}),
			);
		} else {
			setErrorBanner(
				res.error === "standalone_mode"
					? msg("bj.errorStandaloneBridge")
					: res.error,
			);
		}
	};

	const handleSyncLocal = async () => {
		setErrorBanner(null);
		const res = await bridge.syncFiles([
			{ path: "blackjack-rules.js", content: `${code.trimEnd()}\n` },
		]);
		if (res.ok) {
			setStatusBanner(msg("bj.statusSynced", { dir: res.data.projectDir }));
		} else {
			setErrorBanner(
				res.error === "standalone_mode"
					? msg("bj.errorStandaloneBridge")
					: res.error,
			);
		}
	};

	const handleReadLocal = async () => {
		setErrorBanner(null);
		const res = await bridge.readFiles(["blackjack-rules.js"]);
		if (res.ok) {
			const ruleFile = res.files.find((f) => f.path === "blackjack-rules.js");
			if (ruleFile) {
				setCode(ruleFile.content);
				runGraderWithCode(ruleFile.content);
				setStatusBanner(msg("bj.statusReadBack"));
			}
		} else {
			setErrorBanner(
				res.error === "standalone_mode"
					? msg("bj.errorStandaloneBridge")
					: res.error,
			);
		}
	};

	const handleOpenProjectsApp = async () => {
		setErrorBanner(null);
		const res = await bridge.openProjectsApp();
		if (res.ok) {
			setStatusBanner(msg("bj.statusOpenedProjects"));
		} else {
			setErrorBanner(
				res.error === "standalone_mode"
					? msg("bj.errorStandaloneBridge")
					: String(res.error),
			);
		}
	};

	const handleDownloadStarter = () => {
		triggerTextDownload("blackjack-rules.js", `${code.trimEnd()}\n`);
		setStatusBanner(msg("bj.statusDownloaded"));
	};

	const handleDeal = () => {
		const latest = runGraderWithCode(code);
		setTable((prev) => {
			const base =
				prev.phase === "round_over" ? prepareNextBettingRound(prev) : prev;
			return dealRound(base, latest.compiledRules, executionMode, random);
		});
	};

	const handleHit = () => {
		setTable((prev) => hitPlayer(prev, gradeReport.compiledRules, executionMode));
	};

	const handleStand = () => {
		setTable((prev) =>
			standPlayer(prev, gradeReport.compiledRules, executionMode),
		);
	};

	const handleNewRound = () => {
		setTable((prev) => prepareNextBettingRound(prev));
	};

	const renderPlayingCard = (card: Card, hidden = false, idx = 0) => {
		if (hidden) {
			return (
				<div
					key={`hidden-${idx}`}
					className="bj-playing-card bj-playing-card--hidden"
					data-testid="blackjack-hidden-dealer-card"
				>
					<span className="bj-playing-card__back">?</span>
				</div>
			);
		}
		const red = isRedSuit(card.suit);
		return (
			<div
				key={`${card.suit}-${card.rank}-${idx}`}
				className={`bj-playing-card ${red ? "bj-playing-card--red" : "bj-playing-card--dark"}`}
			>
				<span className="bj-playing-card__rank">{card.rank}</span>
				<span className="bj-playing-card__suit">{card.suit}</span>
			</div>
		);
	};

	return (
		<div className="bj-studio" data-testid="blackjack-studio-root">
			<header className="bj-header">
				<div className="bj-header__brand">
					<span className="bj-header__badge">{msg("bj.badgeVersion")}</span>
					<h1 className="bj-header__title">{msg("bj.appTitle")}</h1>
					<p className="bj-header__subtitle">{msg("bj.appSubtitle")}</p>
				</div>
				<div
					className="bj-step-strip"
					aria-label={msg("bj.stepProgressLabel", {
						passed: gradeReport.passedSteps.length,
					})}
				>
					{curriculum.map((item) => {
						const passed = gradeReport.passedSteps.includes(item.step);
						const active = currentStep === item.step;
						return (
							<button
								key={item.step}
								type="button"
								className={`bj-step-pill ${active ? "bj-step-pill--active" : ""} ${passed ? "bj-step-pill--passed" : ""}`}
								data-testid={`blackjack-step-btn-${item.step}`}
								data-usage-event="blackjack-app.ctrl-1.click" onClick={() => setCurrentStep(item.step)}
							>
								<span className="bj-step-pill__text">{item.shortTitle}</span>
								<span className="bj-step-pill__status">
									{passed ? "✓" : "•"}
								</span>
							</button>
						);
					})}
				</div>
			</header>

			{statusBanner && (
				<div className="bj-banner bj-banner--status" role="status">
					<span>{statusBanner}</span>
					<button
						type="button"
						className="bj-btn bj-btn--subtle bj-btn--xs"
						data-usage-event="blackjack-app.ctrl-2.click" onClick={() => setStatusBanner(null)}
					>
						{msg("bj.errorDismiss")}
					</button>
				</div>
			)}

			{errorBanner && (
				<div className="bj-banner bj-banner--error" role="alert">
					<span>{errorBanner}</span>
					<button
						type="button"
						className="bj-btn bj-btn--subtle bj-btn--xs"
						data-usage-event="blackjack-app.ctrl-3.click" onClick={() => setErrorBanner(null)}
					>
						{msg("bj.errorDismiss")}
					</button>
				</div>
			)}

			<nav className="bj-mobile-tabs" aria-label="Studio workspace views">
				<button
					type="button"
					className={`bj-mobile-tab ${mobilePane === "mission" ? "bj-mobile-tab--active" : ""}`}
					data-usage-event="blackjack-app.ctrl-4.click" onClick={() => setMobilePane("mission")}
				>
					{msg("bj.mobileTabMission")}
				</button>
				<button
					type="button"
					className={`bj-mobile-tab ${mobilePane === "editor" ? "bj-mobile-tab--active" : ""}`}
					data-usage-event="blackjack-app.ctrl-5.click" onClick={() => setMobilePane("editor")}
				>
					{msg("bj.mobileTabEditor")}
				</button>
				<button
					type="button"
					className={`bj-mobile-tab ${mobilePane === "table" ? "bj-mobile-tab--active" : ""}`}
					data-usage-event="blackjack-app.ctrl-6.click" onClick={() => setMobilePane("table")}
				>
					{msg("bj.mobileTabTable")}
				</button>
			</nav>

			<main className="bj-grid">
				{/* Column 1: 5-Step Mission + Socratic Hints + Ask Naia Tutor */}
				<section
					className={`bj-col ${mobilePane === "mission" ? "bj-col--mobile-active" : ""}`}
					data-testid="blackjack-col-mission"
				>
					<div className="bj-card">
						<div className="bj-card__eyebrow">
							<span>{msg("bj.stepLabel", { step: activeLesson.step })}</span>
							<span
								className={`bj-badge ${gradeReport.passedSteps.includes(activeLesson.step) ? "bj-badge--ok" : "bj-badge--pending"}`}
							>
								{gradeReport.passedSteps.includes(activeLesson.step)
									? msg("bj.stepPassedBadge")
									: msg("bj.stepPendingBadge")}
							</span>
						</div>
						<h2 className="bj-card__title">{activeLesson.title}</h2>
						<p className="bj-card__body">{activeLesson.missionSummary}</p>

						<div className="bj-socratic-box">
							<h3 className="bj-socratic-box__heading">
								{msg("bj.socraticHeading")}
							</h3>
							<p className="bj-socratic-box__question">
								{activeLesson.socraticQuestion}
							</p>
							<div className="bj-row">
								<button
									type="button"
									className="bj-btn bj-btn--primary"
									data-testid="blackjack-speak-btn"
									data-usage-event="blackjack-app.ctrl-7.click" onClick={handleSpeakLesson}
								>
									{speakingId ? msg("bj.speakActive") : msg("bj.speakButton")}
								</button>
								<button
									type="button"
									className="bj-btn bj-btn--subtle"
									data-testid="blackjack-speak-stop-btn"
									disabled={!speakingId}
									data-usage-event="blackjack-app.ctrl-8.click" onClick={handleStopSpeak}
								>
									{msg("bj.speakStopButton")}
								</button>
							</div>
						</div>

						<div className="bj-hints">
							<div className="bj-hints__header">
								<h3 className="bj-section-label">{msg("bj.hintLadderTitle")}</h3>
								{openedHintsCount < 3 ? (
									<button
										type="button"
										className="bj-btn bj-btn--accent bj-btn--xs"
										data-testid="blackjack-open-hint-btn"
										data-usage-event="blackjack-app.ctrl-9.click" onClick={handleOpenNextHint}
									>
										{msg("bj.hintOpenButton", { level: openedHintsCount + 1 })}
									</button>
								) : (
									<span className="bj-hints__done">
										{msg("bj.hintAllOpened")}
									</span>
								)}
							</div>
							{openedHintsCount > 0 && (
								<ol className="bj-hints__list" data-testid="blackjack-hint-list">
									{activeLesson.hints
										.slice(0, openedHintsCount)
										.map((hint, idx) => (
											<li key={`${activeLesson.step}-${idx}`} className="bj-hint-item">
												<span className="bj-hint-item__badge">
													{msg("bj.hintLevelBadge", { level: idx + 1 })}
												</span>
												<span>{hint}</span>
											</li>
										))}
								</ol>
							)}
						</div>
						<p className="bj-pedagogy-note">{msg("bj.pedagogyToggle")}</p>
					</div>

					<div className="bj-card">
						<h3 className="bj-card__title">{msg("bj.askHeading")}</h3>
						<div className="bj-preset-chips">
							<button
								type="button"
								className="bj-chip-btn"
								data-testid="blackjack-ask-preset-ace"
								data-usage-event="blackjack-app.ctrl-10.click" onClick={() => {
									const q = msg("bj.askPresetAce");
									setAskInput(q);
									void submitTutorQuestion(q);
								}}
							>
								{msg("bj.askPresetAce")}
							</button>
							<button
								type="button"
								className="bj-chip-btn"
								data-testid="blackjack-ask-preset-next"
								data-usage-event="blackjack-app.ctrl-11.click" onClick={() => {
									const q = msg("bj.askPresetNext");
									setAskInput(q);
									void submitTutorQuestion(q);
								}}
							>
								{msg("bj.askPresetNext")}
							</button>
							<button
								type="button"
								className="bj-chip-btn"
								data-usage-event="blackjack-app.ctrl-12.click" onClick={() => {
									const q = msg("bj.askPresetEdge");
									setAskInput(q);
									void submitTutorQuestion(q);
								}}
							>
								{msg("bj.askPresetEdge")}
							</button>
						</div>
						<div className="bj-ask-box">
							<textarea
								className="bj-ask-input"
								rows={2}
								aria-label={msg("bj.askHeading")}
								placeholder={msg("bj.askPlaceholder")}
								value={askInput}
								onChange={(e) => setAskInput(e.target.value)}
							/>
							<button
								type="button"
								className="bj-btn bj-btn--primary"
								data-testid="blackjack-ask-send-btn"
								disabled={askingTutor || !askInput.trim()}
								data-usage-event="blackjack-app.ctrl-13.click" onClick={() => void submitTutorQuestion(askInput)}
							>
								{askingTutor ? msg("bj.askBusy") : msg("bj.askSendButton")}
							</button>
						</div>
						{tutorReply && (
							<div
								className="bj-tutor-reply"
								data-testid="blackjack-tutor-reply"
								role="status"
							>
								<div className="bj-tutor-reply__head">
									<strong>{msg("bj.tutorReplyTitle")}</strong>
									{tutorReply.fromFallback && (
										<span className="bj-badge bj-badge--pending">
											{msg("bj.tutorFallbackBadge")}
										</span>
									)}
								</div>
								<p className="bj-tutor-reply__body">{tutorReply.text}</p>
							</div>
						)}
						<div className="bj-row bj-row--mt">
							<button
								type="button"
								className="bj-btn bj-btn--subtle bj-btn--full"
								data-testid="blackjack-copy-agent-prompt"
								data-usage-event="blackjack-app.ctrl-14.click" onClick={() => void handleCopyAgentPrompt()}
							>
								{msg("bj.copyAgentPromptButton")}
							</button>
						</div>
					</div>
				</section>

				{/* Column 2: CodeMirror 6 Starter Code Editor + Local Workspace Sync */}
				<section
					className={`bj-col ${mobilePane === "editor" ? "bj-col--mobile-active" : ""}`}
					data-testid="blackjack-col-editor"
				>
					<div className="bj-card bj-card--editor">
						<div className="bj-editor-head">
							<div>
								<h2 className="bj-card__title">{msg("bj.editorTitle")}</h2>
								<p className="bj-editor-hint">{msg("bj.editorShortcutHint")}</p>
							</div>
							<div className="bj-row">
								<button
									type="button"
									className="bj-btn bj-btn--emerald"
									data-testid="blackjack-run-grade-btn"
									data-usage-event="blackjack-app.ctrl-15.click" onClick={handleRunAndGrade}
								>
									{msg("bj.runAndGradeButton")}
								</button>
								{!confirmReset ? (
									<button
										type="button"
										className="bj-btn bj-btn--subtle"
										data-testid="blackjack-reset-starter-btn"
										data-usage-event="blackjack-app.ctrl-16.click" onClick={() => setConfirmReset(true)}
									>
										{msg("bj.resetStarterButton")}
									</button>
								) : (
									<div className="bj-inline-confirm" role="group">
										<span className="bj-inline-confirm__text">
											{msg("bj.resetConfirmPrompt")}
										</span>
										<button
											type="button"
											className="bj-btn bj-btn--accent bj-btn--xs"
											data-testid="blackjack-reset-confirm-yes"
											data-usage-event="blackjack-app.ctrl-17.click" onClick={handleConfirmResetStarter}
										>
											{msg("bj.resetConfirmYes")}
										</button>
										<button
											type="button"
											className="bj-btn bj-btn--subtle bj-btn--xs"
											data-usage-event="blackjack-app.ctrl-18.click" onClick={() => setConfirmReset(false)}
										>
											{msg("bj.resetConfirmCancel")}
										</button>
									</div>
								)}
							</div>
						</div>

						<CodeMirrorEditor
							value={code}
							ariaLabel={msg("bj.editorTitle")}
							onChange={setCode}
							onRunShortcut={handleRunAndGrade}
						/>

						<div className="bj-workspace-bar">
							<h3 className="bj-section-label">
								{msg("bj.localWorkspaceTitle")}
							</h3>
							<div className="bj-row">
								<button
									type="button"
									className="bj-btn bj-btn--primary bj-btn--xs"
									data-testid="blackjack-provision-btn"
									data-usage-event="blackjack-app.ctrl-19.click" onClick={() => void handleProvisionLocal()}
								>
									{msg("bj.provisionButton")}
								</button>
								<button
									type="button"
									className="bj-btn bj-btn--subtle bj-btn--xs"
									data-testid="blackjack-sync-local-btn"
									data-usage-event="blackjack-app.ctrl-20.click" onClick={() => void handleSyncLocal()}
								>
									{msg("bj.syncToLocalButton")}
								</button>
								<button
									type="button"
									className="bj-btn bj-btn--subtle bj-btn--xs"
									data-testid="blackjack-read-local-btn"
									data-usage-event="blackjack-app.ctrl-21.click" onClick={() => void handleReadLocal()}
								>
									{msg("bj.readLocalButton")}
								</button>
								<button
									type="button"
									className="bj-btn bj-btn--accent bj-btn--xs"
									data-testid="blackjack-open-projects-btn"
									data-usage-event="blackjack-app.ctrl-22.click" onClick={() => void handleOpenProjectsApp()}
								>
									{msg("bj.openProjectsAppButton")}
								</button>
								<button
									type="button"
									className="bj-btn bj-btn--subtle bj-btn--xs"
									data-testid="blackjack-download-btn"
									data-usage-event="blackjack-app.ctrl-23.click" onClick={handleDownloadStarter}
								>
									{msg("bj.downloadStarterButton")}
								</button>
							</div>
						</div>
					</div>
				</section>

				{/* Column 3: Live Blackjack Table + Automated 5-Step Grader */}
				<section
					className={`bj-col ${mobilePane === "table" ? "bj-col--mobile-active" : ""}`}
					data-testid="blackjack-col-table"
				>
					<div className="bj-card bj-felt-card">
						<div className="bj-table-top">
							<h2 className="bj-card__title">{msg("bj.tableTitle")}</h2>
							<div className="bj-mode-toggle" role="group">
								<button
									type="button"
									className={`bj-mode-btn ${executionMode === "learner" ? "bj-mode-btn--active" : ""}`}
									data-testid="blackjack-mode-learner"
									data-usage-event="blackjack-app.ctrl-24.click" onClick={() => setExecutionMode("learner")}
								>
									{msg("bj.modeLearner")}
								</button>
								<button
									type="button"
									className={`bj-mode-btn ${executionMode === "reference" ? "bj-mode-btn--active" : ""}`}
									data-testid="blackjack-mode-reference"
									data-usage-event="blackjack-app.ctrl-25.click" onClick={() => setExecutionMode("reference")}
								>
									{msg("bj.modeReference")}
								</button>
							</div>
						</div>

						{executionMode === "learner" &&
							table.fallbackFunctions.length > 0 && (
								<div className="bj-fallback-note" role="status">
									{msg("bj.fallbackWarning", {
										fns: table.fallbackFunctions.join(", "),
									})}
								</div>
							)}

						<div className="bj-bankroll-bar">
							<div className="bj-stat-pill">
								<span>{msg("bj.chipsLabel")}</span>
								<strong data-testid="blackjack-chips-value">
									{table.chips}
								</strong>
							</div>
							<div className="bj-stat-pill">
								<span>{msg("bj.betLabel")}</span>
								<strong data-testid="blackjack-bet-value">{table.bet}</strong>
							</div>
							<div className="bj-bet-controls">
								<button
									type="button"
									className="bj-chip-wager"
									disabled={table.phase !== "betting"}
									data-usage-event="blackjack-app.ctrl-26.click" onClick={() => setTable((s) => adjustBet(s, 10))}
								>
									{msg("bj.betPlus10")}
								</button>
								<button
									type="button"
									className="bj-chip-wager"
									disabled={table.phase !== "betting"}
									data-usage-event="blackjack-app.ctrl-27.click" onClick={() => setTable((s) => adjustBet(s, 50))}
								>
									{msg("bj.betPlus50")}
								</button>
								<button
									type="button"
									className="bj-chip-wager"
									disabled={table.phase !== "betting"}
									data-usage-event="blackjack-app.ctrl-28.click" onClick={() => setTable((s) => adjustBet(s, 100))}
								>
									{msg("bj.betPlus100")}
								</button>
								<button
									type="button"
									className="bj-chip-wager bj-chip-wager--reset"
									disabled={table.phase !== "betting"}
									data-usage-event="blackjack-app.ctrl-29.click" onClick={() => setTable((s) => adjustBet(s, "reset"))}
								>
									{msg("bj.betReset")}
								</button>
							</div>
						</div>

						<div className="bj-table-hands">
							<div className="bj-hand-zone">
								<div className="bj-hand-zone__head">
									<span>{msg("bj.dealerHandLabel")}</span>
									<strong data-testid="blackjack-dealer-score">
										{table.dealerHand.length === 0
											? "-"
											: table.phase === "player_turn"
												? msg("bj.hiddenTotal")
												: String(table.dealerScore)}
									</strong>
								</div>
								<div className="bj-cards-row" data-testid="blackjack-dealer-cards">
									{table.dealerHand.map((card, idx) =>
										renderPlayingCard(
											card,
											table.phase === "player_turn" && idx === 0,
											idx,
										),
									)}
								</div>
							</div>

							<div className="bj-hand-zone">
								<div className="bj-hand-zone__head">
									<span>{msg("bj.playerHandLabel")}</span>
									<strong data-testid="blackjack-player-score">
										{table.playerHand.length === 0
											? "-"
											: String(table.playerScore)}
									</strong>
								</div>
								<div className="bj-cards-row" data-testid="blackjack-player-cards">
									{table.playerHand.map((card, idx) =>
										renderPlayingCard(card, false, idx),
									)}
								</div>
							</div>
						</div>

						<div
							className="bj-table-banner"
							data-testid="blackjack-table-banner"
							role="status"
						>
							{table.phase === "betting" && msg("bj.phaseBetting")}
							{table.phase === "player_turn" && msg("bj.phasePlayerTurn")}
							{table.phase === "round_over" &&
								table.outcome &&
								msg(`bj.outcome.${table.outcome}`, {
									payout: table.lastPayout,
								})}
						</div>

						<div className="bj-table-actions">
							{table.phase === "betting" && (
								<button
									type="button"
									className="bj-btn bj-btn--emerald"
									data-testid="blackjack-deal-btn"
									data-usage-event="blackjack-app.ctrl-30.click" onClick={handleDeal}
								>
									{msg("bj.dealButton")}
								</button>
							)}
							{table.phase === "player_turn" && (
								<>
									<button
										type="button"
										className="bj-btn bj-btn--emerald"
										data-testid="blackjack-hit-btn"
										data-usage-event="blackjack-app.ctrl-31.click" onClick={handleHit}
									>
										{msg("bj.hitButton")}
									</button>
									<button
										type="button"
										className="bj-btn bj-btn--accent"
										data-testid="blackjack-stand-btn"
										data-usage-event="blackjack-app.ctrl-32.click" onClick={handleStand}
									>
										{msg("bj.standButton")}
									</button>
								</>
							)}
							{table.phase === "round_over" && (
								<>
									<button
										type="button"
										className="bj-btn bj-btn--emerald"
										data-testid="blackjack-deal-btn"
										data-usage-event="blackjack-app.ctrl-33.click" onClick={handleDeal}
									>
										{msg("bj.dealButton")}
									</button>
									<button
										type="button"
										className="bj-btn bj-btn--subtle"
										data-testid="blackjack-new-round-btn"
										data-usage-event="blackjack-app.ctrl-34.click" onClick={handleNewRound}
									>
										{msg("bj.newRoundButton")}
									</button>
								</>
							)}
						</div>
					</div>

					<div className="bj-card" data-testid="blackjack-grader-card">
						<div className="bj-grader-head">
							<h2 className="bj-card__title">{msg("bj.graderTitle")}</h2>
							<span
								className="bj-grader-summary"
								data-testid="blackjack-grader-summary"
							>
								{msg("bj.graderSummary", {
									passedChecks: gradeReport.passedChecks,
									totalChecks: gradeReport.totalChecks,
									passedSteps: gradeReport.passedSteps.length,
								})}
							</span>
						</div>

						{gradeReport.compileError && (
							<div className="bj-compile-error" role="status">
								{msg("bj.graderCompileError", {
									error: gradeReport.compileError,
								})}
							</div>
						)}

						<ul className="bj-check-list">
							{gradeReport.steps
								.flatMap((s) => s.checks)
								.map((check) => (
									<li
										key={check.id}
										className={`bj-check-row ${check.passed ? "bj-check-row--pass" : "bj-check-row--fail"}`}
										data-testid={`blackjack-check-${check.id}`}
									>
										<span className="bj-check-row__badge">
											{check.passed ? msg("bj.checkPass") : msg("bj.checkFail")}
										</span>
										<div className="bj-check-row__text">
											<span>{msg(check.labelKey)}</span>
											<small>{check.detail}</small>
										</div>
									</li>
								))}
						</ul>
					</div>
				</section>
			</main>
		</div>
	);
}
