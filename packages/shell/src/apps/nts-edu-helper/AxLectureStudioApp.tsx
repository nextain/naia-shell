import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Logger } from "../../lib/logger";
import {
	type AxMessageKey,
	type AxWorkbookFields,
	type ChecklistCategoryId,
	OPENCODE_SCENE_SLIDES,
	type PresetId,
	TOTAL_SLIDES,
	axText,
	buildStage1Prompt,
	buildStage2Prompt,
	buildStage3WireframePrompt,
	getChapterForSlide,
	getChapters,
	getDefaultSlideNarration,
	getPresetWorkbookFields,
	resolveAxLocale,
} from "./locales/messages";
import { getLocalizedWireframeDownloadName } from "./locales/wireframe-copy";
import { resolveSlideImageUrl } from "./slide-url";
import {
	type AxStudioBridge,
	createWindowAxStudioBridge,
} from "./studio-bridge";
import {
	type WorkbookStageTab,
	buildAxContextPayload,
	handleAxStudioToolCall,
} from "./tools";
import {
	applyStage1AiReply,
	applyStage2AiReply,
	buildAxStarterProjectFiles,
	compileWorkbookMarkdown,
	cycleChecklistStatus,
	extractHtmlFromModelReply,
	generateInteractiveWireframeHtml,
	synthesizeStage1OfflineDraft,
	synthesizeStage2OfflineDraft,
} from "./workbook-domain";
import "./ax-studio.css";

const TAG = "AxLectureStudioApp";

type MobilePanel = "lecture" | "workbook";
type WireframeSubTab = "preview" | "source";

const PRESET_IDS: readonly PresetId[] = [
	"nts_tax",
	"local_gov",
	"hr_faq",
	"custom",
];

export interface AxLectureStudioAppProps {
	bridge?: AxStudioBridge;
	localeOverride?: string;
}

function downloadFileBlob(
	filename: string,
	content: string,
	mimeType: string,
): void {
	if (typeof document === "undefined" || typeof URL === "undefined") return;
	if (typeof URL.createObjectURL !== "function") return;
	const blob = new Blob([content], { type: mimeType });
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	link.style.display = "none";
	document.body.appendChild(link);
	link.click();
	document.body.removeChild(link);
	URL.revokeObjectURL(url);
}

function isEditableTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	const tag = target.tagName;
	return (
		tag === "INPUT" ||
		tag === "TEXTAREA" ||
		tag === "SELECT" ||
		target.isContentEditable
	);
}

export function AxLectureStudioApp({
	bridge: injectedBridge,
	localeOverride,
}: AxLectureStudioAppProps) {
	const defaultBridge = useMemo(() => createWindowAxStudioBridge(), []);
	const bridge = injectedBridge ?? defaultBridge;

	const [hostLocale, setHostLocale] = useState<string | undefined>(undefined);
	const locale = resolveAxLocale(hostLocale ?? localeOverride);

	const msg = useCallback(
		(
			key: AxMessageKey,
			params?: Readonly<Record<string, string | number>>,
		) => axText(key, params, locale),
		[locale],
	);

	const chapters = useMemo(() => getChapters(locale), [locale]);

	const [mobilePanel, setMobilePanel] = useState<MobilePanel>("lecture");
	const [currentSlide, setCurrentSlide] = useState<number>(1);
	const [openCodeOnly, setOpenCodeOnly] = useState<boolean>(false);
	const [customNotesBySlide, setCustomNotesBySlide] = useState<
		Record<number, string>
	>({});
	const [continuousSpeak, setContinuousSpeak] = useState<boolean>(false);
	const [speakingId, setSpeakingId] = useState<string | null>(null);

	const [activeStage, setActiveStage] = useState<WorkbookStageTab>("stage1");
	const [workbook, setWorkbook] = useState<AxWorkbookFields>(() =>
		getPresetWorkbookFields("nts_tax", locale),
	);
	const [showMarkdownPreview, setShowMarkdownPreview] =
		useState<boolean>(false);

	const [wireframeHtml, setWireframeHtml] = useState<string>(() =>
		generateInteractiveWireframeHtml(
			getPresetWorkbookFields("nts_tax", locale),
			locale,
		),
	);
	const [previousWireframeHtml, setPreviousWireframeHtml] = useState<
		string | null
	>(null);
	const [wireframeSubTab, setWireframeSubTab] =
		useState<WireframeSubTab>("preview");

	const [busyAi, setBusyAi] = useState<boolean>(false);
	const [statusBanner, setStatusBanner] = useState<string | null>(null);
	const [errorBanner, setErrorBanner] = useState<string | null>(null);

	const stateRef = useRef({
		currentSlide,
		openCodeOnly,
		activeStage,
		workbook,
		wireframeHtml,
		locale,
		continuousSpeak,
		customNotesBySlide,
	});
	stateRef.current = {
		currentSlide,
		openCodeOnly,
		activeStage,
		workbook,
		wireframeHtml,
		locale,
		continuousSpeak,
		customNotesBySlide,
	};

	const clampSlide = (n: number) =>
		Math.max(1, Math.min(TOTAL_SLIDES, Math.trunc(n)));

	const getNextSlideNumber = useCallback(
		(fromSlide: number, delta: 1 | -1, onlyOpenCode: boolean): number | null => {
			if (!onlyOpenCode) {
				const target = fromSlide + delta;
				if (target < 1 || target > TOTAL_SLIDES) return null;
				return target;
			}
			const currentIdx = OPENCODE_SCENE_SLIDES.indexOf(fromSlide);
			if (currentIdx === -1) {
				return OPENCODE_SCENE_SLIDES[0] ?? 1;
			}
			const nextIdx = currentIdx + delta;
			if (nextIdx < 0 || nextIdx >= OPENCODE_SCENE_SLIDES.length) return null;
			return OPENCODE_SCENE_SLIDES[nextIdx] ?? null;
		},
		[],
	);

	const speakSlideByNumber = useCallback(
		(slideNum: number) => {
			const note =
				stateRef.current.customNotesBySlide[slideNum] ??
				getDefaultSlideNarration(slideNum, stateRef.current.locale);
			const { requestId } = bridge.speak(note, (status) => {
				setSpeakingId((prev) => (prev === requestId ? null : prev));
				if (status === "finished" && stateRef.current.continuousSpeak) {
					const next = getNextSlideNumber(
						slideNum,
						1,
						stateRef.current.openCodeOnly,
					);
					if (next !== null) {
						setCurrentSlide(next);
						speakSlideByNumber(next);
					}
				}
			});
			setSpeakingId(requestId);
		},
		[bridge, getNextSlideNumber],
	);

	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (isEditableTarget(e.target)) return;
			if (e.key === "ArrowRight") {
				const next = getNextSlideNumber(
					stateRef.current.currentSlide,
					1,
					stateRef.current.openCodeOnly,
				);
				if (next !== null) setCurrentSlide(next);
			} else if (e.key === "ArrowLeft") {
				const prev = getNextSlideNumber(
					stateRef.current.currentSlide,
					-1,
					stateRef.current.openCodeOnly,
				);
				if (prev !== null) setCurrentSlide(prev);
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [getNextSlideNumber]);

	useEffect(() => {
		bridge.pushContext(
			buildAxContextPayload({
				currentSlide,
				openCodeOnly,
				activeStage,
				workbook,
				wireframeHtml,
				locale,
			}),
		);
	}, [bridge, currentSlide, openCodeOnly, activeStage, workbook, wireframeHtml, locale]);

	useEffect(() => {
		return () => {
			bridge.pushContext(null);
		};
	}, [bridge]);

	useEffect(() => {
		return bridge.subscribeHostEvents({
			onLocale(nextLocale) {
				setHostLocale(nextLocale);
			},
			onToolCall(tool, args) {
				if (tool !== "skill_ax_lecture_studio") {
					return { ok: false, error: `Unknown tool: ${tool}` };
				}
				return handleAxStudioToolCall(args, {
					getSnapshot: () => ({
						currentSlide: stateRef.current.currentSlide,
						openCodeOnly: stateRef.current.openCodeOnly,
						activeStage: stateRef.current.activeStage,
						workbook: stateRef.current.workbook,
						wireframeHtml: stateRef.current.wireframeHtml,
						locale: stateRef.current.locale,
					}),
					gotoSlide: (s) => {
						setOpenCodeOnly(false);
						setCurrentSlide(clampSlide(s));
					},
					patchWorkbook: (patch) => {
						const updated = { ...stateRef.current.workbook, ...patch };
						setWorkbook(updated);
						return updated;
					},
					regenerateWireframe: () => {
						const nextHtml = generateInteractiveWireframeHtml(
							stateRef.current.workbook,
							stateRef.current.locale,
						);
						setPreviousWireframeHtml(stateRef.current.wireframeHtml);
						setWireframeHtml(nextHtml);
						setActiveStage("stage3");
						return nextHtml;
					},
				});
			},
		});
	}, [bridge]);

	const activeChapter = getChapterForSlide(currentSlide, locale);
	const currentNote =
		customNotesBySlide[currentSlide] ??
		getDefaultSlideNarration(currentSlide, locale);

	const compiledMarkdown = useMemo(
		() => compileWorkbookMarkdown(workbook, locale),
		[workbook, locale],
	);

	const handleSelectPreset = (presetId: PresetId) => {
		Logger.debug(TAG, "switching agency workbook preset", { presetId });
		const nextFields = getPresetWorkbookFields(presetId, locale);
		setWorkbook(nextFields);
		const nextHtml = generateInteractiveWireframeHtml(nextFields, locale);
		setPreviousWireframeHtml(wireframeHtml);
		setWireframeHtml(nextHtml);
	};

	const updateField = <
		K extends keyof Omit<AxWorkbookFields, "presetId" | "checklist">,
	>(
		key: K,
		value: string,
	) => {
		setWorkbook((prev) => ({ ...prev, [key]: value }));
	};

	const handleToggleChecklistStatus = (catId: ChecklistCategoryId) => {
		setWorkbook((prev) => ({
			...prev,
			checklist: prev.checklist.map((item) =>
				item.id === catId
					? { ...item, status: cycleChecklistStatus(item.status) }
					: item,
			),
		}));
	};

	const handleUpdateChecklistNote = (
		catId: ChecklistCategoryId,
		note: string,
	) => {
		setWorkbook((prev) => ({
			...prev,
			checklist: prev.checklist.map((item) =>
				item.id === catId ? { ...item, note } : item,
			),
		}));
	};

	const handleAskStage1 = async () => {
		if (busyAi) return;
		setBusyAi(true);
		setErrorBanner(null);
		const prompt = buildStage1Prompt(workbook, locale);
		const reply = await bridge.askModel(prompt);
		setWorkbook((prev) =>
			reply.ok
				? applyStage1AiReply(prev, reply.text)
				: synthesizeStage1OfflineDraft(prev, locale),
		);
		setStatusBanner(msg("ax.statusDraftUpdated"));
		setBusyAi(false);
	};

	const handleAskStage2 = async () => {
		if (busyAi) return;
		setBusyAi(true);
		setErrorBanner(null);
		const prompt = buildStage2Prompt(workbook, locale);
		const reply = await bridge.askModel(prompt);
		setWorkbook((prev) =>
			reply.ok
				? applyStage2AiReply(prev, reply.text)
				: synthesizeStage2OfflineDraft(prev, locale),
		);
		setStatusBanner(msg("ax.statusDraftUpdated"));
		setBusyAi(false);
	};

	const handleSynthesizeWireframe = () => {
		setPreviousWireframeHtml(wireframeHtml);
		const nextHtml = generateInteractiveWireframeHtml(workbook, locale);
		setWireframeHtml(nextHtml);
		setWireframeSubTab("preview");
		setStatusBanner(msg("ax.statusWireframeGenerated"));
	};

	const handleAskWireframeEnhance = async () => {
		if (busyAi) return;
		setBusyAi(true);
		setErrorBanner(null);
		const prompt = buildStage3WireframePrompt(workbook, locale);
		const reply = await bridge.askModel(prompt);
		const extracted = reply.ok ? extractHtmlFromModelReply(reply.text) : null;
		const nextHtml =
			extracted ?? generateInteractiveWireframeHtml(workbook, locale);
		setPreviousWireframeHtml(wireframeHtml);
		setWireframeHtml(nextHtml);
		setWireframeSubTab("preview");
		setStatusBanner(msg("ax.statusWireframeGenerated"));
		setBusyAi(false);
	};

	const handleUndoWireframe = () => {
		if (!previousWireframeHtml) return;
		setWireframeHtml(previousWireframeHtml);
		setPreviousWireframeHtml(null);
		setStatusBanner(msg("ax.statusWireframeRestored"));
	};

	const handleCopyMarkdown = async () => {
		try {
			if (navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(compiledMarkdown);
				setStatusBanner(msg("ax.statusCopiedMd"));
				return;
			}
		} catch (err) {
			Logger.warn(TAG, "clipboard copy failed", { error: String(err) });
		}
		setErrorBanner(msg("ax.errorClipboard"));
	};

	const handleDownloadMarkdown = () => {
		downloadFileBlob(
			"01-ax-service-plan.md",
			compiledMarkdown,
			"text/markdown;charset=utf-8",
		);
		setStatusBanner(msg("ax.statusDownloadedMd"));
	};

	const handleDownloadWireframe = () => {
		downloadFileBlob(
			getLocalizedWireframeDownloadName(locale),
			wireframeHtml,
			"text/html;charset=utf-8",
		);
		setStatusBanner(msg("ax.statusDownloadedHtml"));
	};

	const handleProvisionLocalPackage = async () => {
		setErrorBanner(null);
		const files = buildAxStarterProjectFiles(workbook, wireframeHtml, locale);
		const res = await bridge.provisionProject(files, true);
		if (res.ok) {
			setStatusBanner(
				msg("ax.statusProvisioned", {
					dir: res.data.projectDir,
					written: res.data.writtenFiles.length,
					skipped: res.data.skippedFiles.length,
				}),
			);
		} else {
			setErrorBanner(
				res.error === "standalone_mode"
					? msg("ax.errorStandalone")
					: res.error,
			);
		}
	};

	const handleOpenProjectsApp = async () => {
		setErrorBanner(null);
		const res = await bridge.openProjectsApp();
		if (res.ok) {
			setStatusBanner(msg("ax.statusOpenedProjects"));
		} else {
			setErrorBanner(
				res.error === "standalone_mode"
					? msg("ax.errorStandalone")
					: String(res.error),
			);
		}
	};

	const slideSrc = resolveSlideImageUrl(currentSlide);
	const prevTarget = getNextSlideNumber(currentSlide, -1, openCodeOnly);
	const nextTarget = getNextSlideNumber(currentSlide, 1, openCodeOnly);

	return (
		<div className="ax-studio" data-testid="ax-studio-root">
			<header className="ax-header">
				<div>
					<span className="ax-header__badge">{msg("ax.badgeVersion")}</span>
					<h1 className="ax-header__title">{msg("ax.appTitle")}</h1>
					<p className="ax-header__subtitle">{msg("ax.appSubtitle")}</p>
				</div>
			</header>

			{statusBanner && (
				<div className="ax-banner ax-banner--status" role="status">
					<span>{statusBanner}</span>
					<button
						type="button"
						className="ax-btn ax-btn--ghost ax-btn--xs"
						data-usage-event="ax-lecture-app.ctrl-1.click" onClick={() => setStatusBanner(null)}
					>
						{msg("ax.dismiss")}
					</button>
				</div>
			)}

			{errorBanner && (
				<div className="ax-banner ax-banner--error" role="alert">
					<span>{errorBanner}</span>
					<button
						type="button"
						className="ax-btn ax-btn--ghost ax-btn--xs"
						data-usage-event="ax-lecture-app.ctrl-2.click" onClick={() => setErrorBanner(null)}
					>
						{msg("ax.dismiss")}
					</button>
				</div>
			)}

			<nav className="ax-mobile-tabs" aria-label="AX studio panels">
				<button
					type="button"
					className={`ax-mobile-tab ${mobilePanel === "lecture" ? "ax-mobile-tab--active" : ""}`}
					data-usage-event="ax-lecture-app.ctrl-3.click" onClick={() => setMobilePanel("lecture")}
				>
					{msg("ax.mobileTabLecture")}
				</button>
				<button
					type="button"
					className={`ax-mobile-tab ${mobilePanel === "workbook" ? "ax-mobile-tab--active" : ""}`}
					data-usage-event="ax-lecture-app.ctrl-4.click" onClick={() => setMobilePanel("workbook")}
				>
					{msg("ax.mobileTabWorkbook")}
				</button>
			</nav>

			<main className="ax-split">
				{/* Left Panel: 7-Session 97-Slide Viewer + Naia Voice Presenter */}
				<section
					className={`ax-pane ${mobilePanel === "lecture" ? "ax-pane--mobile-active" : ""}`}
					data-testid="ax-pane-lecture"
				>
					<div className="ax-card">
						<div className="ax-chapters" role="group">
							{chapters.map((ch) => {
								const isCurrent = !openCodeOnly && activeChapter.id === ch.id;
								return (
									<button
										key={ch.id}
										type="button"
										className={`ax-chap-pill ${isCurrent ? "ax-chap-pill--active" : ""}`}
										data-testid={`ax-chapter-${ch.id}`}
										data-usage-event="ax-lecture-app.ctrl-5.click" onClick={() => {
											setOpenCodeOnly(false);
											setCurrentSlide(ch.startSlide);
										}}
									>
										{ch.label}
									</button>
								);
							})}
							<button
								type="button"
								className={`ax-chap-pill ax-chap-pill--oc ${openCodeOnly ? "ax-chap-pill--active" : ""}`}
								data-testid="ax-opencode-filter-btn"
								data-usage-event="ax-lecture-app.ctrl-6.click" onClick={() => {
									const nextMode = !openCodeOnly;
									setOpenCodeOnly(nextMode);
									if (nextMode && !OPENCODE_SCENE_SLIDES.includes(currentSlide)) {
										setCurrentSlide(OPENCODE_SCENE_SLIDES[0] ?? 2);
									}
								}}
							>
								{msg("ax.openCodeFilter", {
									count: OPENCODE_SCENE_SLIDES.length,
								})}
							</button>
						</div>

						<div className="ax-viewer">
							<img
								className="ax-viewer__img"
								data-testid="ax-slide-img"
								src={slideSrc}
								alt={`${activeChapter.label} - ${currentSlide}`}
							/>
							<div className="ax-viewer__bar">
								<button
									type="button"
									className="ax-btn ax-btn--ghost"
									data-testid="ax-slide-prev"
									disabled={prevTarget === null}
									data-usage-event="ax-lecture-app.ctrl-7.click" onClick={() => {
										if (prevTarget !== null) setCurrentSlide(prevTarget);
									}}
								>
									{msg("ax.prevSlide")}
								</button>
								<span className="ax-viewer__counter" data-testid="ax-slide-counter">
									{openCodeOnly
										? msg("ax.slideCounterOpenCode", {
												index:
													Math.max(
														0,
														OPENCODE_SCENE_SLIDES.indexOf(currentSlide),
													) + 1,
												total: OPENCODE_SCENE_SLIDES.length,
												current: currentSlide,
											})
										: msg("ax.slideCounter", {
												current: currentSlide,
												total: TOTAL_SLIDES,
											})}
								</span>
								<button
									type="button"
									className="ax-btn ax-btn--primary"
									data-testid="ax-slide-next"
									disabled={nextTarget === null}
									data-usage-event="ax-lecture-app.ctrl-8.click" onClick={() => {
										if (nextTarget !== null) setCurrentSlide(nextTarget);
									}}
								>
									{msg("ax.nextSlide")}
								</button>
								<label className="ax-jump-box">
									<span>{msg("ax.slideJumpLabel")}</span>
									<input
										type="number"
										min={1}
										max={TOTAL_SLIDES}
										value={currentSlide}
										data-testid="ax-slide-jump-input"
										onChange={(e) => {
											const val = Number(e.target.value);
											if (Number.isFinite(val) && val >= 1 && val <= TOTAL_SLIDES) {
												setOpenCodeOnly(false);
												setCurrentSlide(Math.trunc(val));
											}
										}}
									/>
								</label>
								<span className="ax-kbd-hint">{msg("ax.keyboardHint")}</span>
							</div>
						</div>

						<div className="ax-presenter-box">
							<div className="ax-presenter-box__head">
								<h2 className="ax-section-title">{msg("ax.narrationHeading")}</h2>
								<div className="ax-row">
									<button
										type="button"
										className="ax-btn ax-btn--primary ax-btn--xs"
										data-testid="ax-speak-btn"
										data-usage-event="ax-lecture-app.ctrl-9.click" onClick={() => {
											if (speakingId) bridge.cancelSpeak(speakingId);
											speakSlideByNumber(currentSlide);
										}}
									>
										{speakingId ? msg("ax.speakingBtn") : msg("ax.speakSlideBtn")}
									</button>
									<button
										type="button"
										className="ax-btn ax-btn--ghost ax-btn--xs"
										data-testid="ax-speak-stop-btn"
										disabled={!speakingId}
										data-usage-event="ax-lecture-app.ctrl-10.click" onClick={() => {
											if (!speakingId) return;
											bridge.cancelSpeak(speakingId);
											setSpeakingId(null);
										}}
									>
										{msg("ax.stopSpeakBtn")}
									</button>
									<button
										type="button"
										className={`ax-btn ax-btn--xs ${continuousSpeak ? "ax-btn--emerald" : "ax-btn--ghost"}`}
										aria-pressed={continuousSpeak}
										data-testid="ax-continuous-toggle"
										data-usage-event="ax-lecture-app.ctrl-11.click" onClick={() => setContinuousSpeak((v) => !v)}
									>
										{msg("ax.continuousToggle")}
									</button>
								</div>
							</div>
							<textarea
								className="ax-narration-textarea"
								rows={3}
								aria-label={msg("ax.narrationEditLabel", {
									slide: currentSlide,
								})}
								data-testid="ax-narration-textarea"
								value={currentNote}
								onChange={(e) =>
									setCustomNotesBySlide((prev) => ({
										...prev,
										[currentSlide]: e.target.value,
									}))
								}
							/>
						</div>
					</div>
				</section>

				{/* Right Panel: Interactive 3-Stage AX Workbook + Wireframe Preview */}
				<section
					className={`ax-pane ${mobilePanel === "workbook" ? "ax-pane--mobile-active" : ""}`}
					data-testid="ax-pane-workbook"
				>
					{/* Agency & Workflow Setup Header */}
					<div className="ax-card">
						<h2 className="ax-section-title">{msg("ax.agencyBarTitle")}</h2>
						<div className="ax-preset-strip">
							{PRESET_IDS.map((pid) => (
								<button
									key={pid}
									type="button"
									className={`ax-preset-btn ${workbook.presetId === pid ? "ax-preset-btn--active" : ""}`}
									data-testid={`ax-preset-${pid}`}
									data-usage-event="ax-lecture-app.ctrl-12.click" onClick={() => handleSelectPreset(pid)}
								>
									{msg(`ax.preset.${pid}`)}
								</button>
							))}
						</div>

						<div className="ax-fields-grid">
							<label className="ax-field">
								<span>{msg("ax.field.agencyName")}</span>
								<input
									type="text"
									data-testid="ax-input-agency"
									value={workbook.agencyName}
									onChange={(e) => updateField("agencyName", e.target.value)}
								/>
							</label>
							<label className="ax-field">
								<span>{msg("ax.field.serviceName")}</span>
								<input
									type="text"
									data-testid="ax-input-service"
									value={workbook.serviceName}
									onChange={(e) => updateField("serviceName", e.target.value)}
								/>
							</label>
							<label className="ax-field">
								<span>{msg("ax.field.targetUser")}</span>
								<input
									type="text"
									value={workbook.targetUser}
									onChange={(e) => updateField("targetUser", e.target.value)}
								/>
							</label>
							<label className="ax-field">
								<span>{msg("ax.field.sourceDocs")}</span>
								<input
									type="text"
									value={workbook.sourceDocs}
									onChange={(e) => updateField("sourceDocs", e.target.value)}
								/>
							</label>
						</div>
					</div>

					{/* 3-Stage Tabs */}
					<div className="ax-card">
						<div className="ax-stage-tabs" role="tablist">
							<button
								type="button"
								role="tab"
								aria-selected={activeStage === "stage1"}
								className={`ax-stage-tab ${activeStage === "stage1" ? "ax-stage-tab--active" : ""}`}
								data-testid="ax-tab-stage1"
								data-usage-event="ax-lecture-app.ctrl-13.click" onClick={() => setActiveStage("stage1")}
							>
								{msg("ax.stageTab1")}
							</button>
							<button
								type="button"
								role="tab"
								aria-selected={activeStage === "stage2"}
								className={`ax-stage-tab ${activeStage === "stage2" ? "ax-stage-tab--active" : ""}`}
								data-testid="ax-tab-stage2"
								data-usage-event="ax-lecture-app.ctrl-14.click" onClick={() => setActiveStage("stage2")}
							>
								{msg("ax.stageTab2")}
							</button>
							<button
								type="button"
								role="tab"
								aria-selected={activeStage === "stage3"}
								className={`ax-stage-tab ${activeStage === "stage3" ? "ax-stage-tab--active" : ""}`}
								data-testid="ax-tab-stage3"
								data-usage-event="ax-lecture-app.ctrl-15.click" onClick={() => setActiveStage("stage3")}
							>
								{msg("ax.stageTab3")}
							</button>
						</div>

						{/* Stage 1: Problem Statement & Public AI 6-Category Checklist */}
						{activeStage === "stage1" && (
							<div className="ax-stage-panel" data-testid="ax-panel-stage1">
								<p className="ax-stage-hint">{msg("ax.stage1Hint")}</p>
								<div className="ax-row ax-row--mb">
									<button
										type="button"
										className="ax-btn ax-btn--primary"
										data-testid="ax-ask-stage1-btn"
										disabled={busyAi}
										data-usage-event="ax-lecture-app.ctrl-16.click" onClick={() => void handleAskStage1()}
									>
										{busyAi ? msg("ax.busyGenerating") : msg("ax.askStage1Btn")}
									</button>
								</div>

								<label className="ax-field">
									<span>{msg("ax.field.bottleneckRisk")}</span>
									<textarea
										rows={2}
										data-testid="ax-input-bottleneck"
										value={workbook.bottleneckRisk}
										onChange={(e) =>
											updateField("bottleneckRisk", e.target.value)
										}
									/>
								</label>
								<label className="ax-field">
									<span>{msg("ax.field.noPiiPrinciple")}</span>
									<textarea
										rows={2}
										value={workbook.noPiiPrinciple}
										onChange={(e) =>
											updateField("noPiiPrinciple", e.target.value)
										}
									/>
								</label>
								<label className="ax-field">
									<span>{msg("ax.field.approvalStopRule")}</span>
									<textarea
										rows={2}
										data-testid="ax-input-stop-rule"
										value={workbook.approvalStopRule}
										onChange={(e) =>
											updateField("approvalStopRule", e.target.value)
										}
									/>
								</label>

								<h3 className="ax-section-title ax-mt">
									{msg("ax.checklistHeading")}
								</h3>
								<div className="ax-checklist">
									{workbook.checklist.map((item) => (
										<div key={item.id} className="ax-checklist-row">
											<div className="ax-checklist-row__top">
												<strong>{msg(`ax.cat.${item.id}`)}</strong>
												<button
													type="button"
													className={`ax-status-pill ax-status-pill--${item.status}`}
													data-testid={`ax-checklist-toggle-${item.id}`}
													data-usage-event="ax-lecture-app.ctrl-17.click" onClick={() => handleToggleChecklistStatus(item.id)}
												>
													{msg(`ax.status.${item.status}`)}
												</button>
											</div>
											<input
												type="text"
												className="ax-checklist-note"
												placeholder={msg("ax.checklistNotePlaceholder")}
												value={item.note}
												onChange={(e) =>
													handleUpdateChecklistNote(item.id, e.target.value)
												}
											/>
										</div>
									))}
								</div>
							</div>
						)}

						{/* Stage 2: 2-Page Product & Screen Plan */}
						{activeStage === "stage2" && (
							<div className="ax-stage-panel" data-testid="ax-panel-stage2">
								<p className="ax-stage-hint">{msg("ax.stage2Hint")}</p>
								<div className="ax-row ax-row--mb">
									<button
										type="button"
										className="ax-btn ax-btn--primary"
										data-testid="ax-ask-stage2-btn"
										disabled={busyAi}
										data-usage-event="ax-lecture-app.ctrl-18.click" onClick={() => void handleAskStage2()}
									>
										{busyAi ? msg("ax.busyGenerating") : msg("ax.askStage2Btn")}
									</button>
									<button
										type="button"
										className="ax-btn ax-btn--ghost"
										data-testid="ax-toggle-md-preview-btn"
										data-usage-event="ax-lecture-app.ctrl-19.click" onClick={() => setShowMarkdownPreview((v) => !v)}
									>
										{showMarkdownPreview
											? msg("ax.hideMdPreview")
											: msg("ax.toggleMdPreview")}
									</button>
									<button
										type="button"
										className="ax-btn ax-btn--ghost"
										data-testid="ax-copy-md-btn"
										data-usage-event="ax-lecture-app.ctrl-20.click" onClick={() => void handleCopyMarkdown()}
									>
										{msg("ax.copyMdBtn")}
									</button>
								</div>

								<label className="ax-field">
									<span>{msg("ax.field.purpose")}</span>
									<textarea
										rows={2}
										data-testid="ax-input-purpose"
										value={workbook.purpose}
										onChange={(e) => updateField("purpose", e.target.value)}
									/>
								</label>
								<label className="ax-field">
									<span>{msg("ax.field.aiRole")}</span>
									<textarea
										rows={3}
										value={workbook.aiRole}
										onChange={(e) => updateField("aiRole", e.target.value)}
									/>
								</label>
								<label className="ax-field">
									<span>{msg("ax.field.humanRole")}</span>
									<textarea
										rows={2}
										value={workbook.humanRole}
										onChange={(e) => updateField("humanRole", e.target.value)}
									/>
								</label>
								<label className="ax-field">
									<span>{msg("ax.field.approvalGate")}</span>
									<textarea
										rows={2}
										value={workbook.approvalGate}
										onChange={(e) => updateField("approvalGate", e.target.value)}
									/>
								</label>
								<label className="ax-field">
									<span>{msg("ax.field.screenAreas")}</span>
									<textarea
										rows={2}
										value={workbook.screenAreas}
										onChange={(e) => updateField("screenAreas", e.target.value)}
									/>
								</label>

								{showMarkdownPreview && (
									<pre
										className="ax-md-preview"
										data-testid="ax-markdown-preview"
									>
										{compiledMarkdown}
									</pre>
								)}
							</div>
						)}

						{/* Stage 3: Live HTML Wireframe Generator & Preview */}
						{activeStage === "stage3" && (
							<div className="ax-stage-panel" data-testid="ax-panel-stage3">
								<p className="ax-stage-hint">{msg("ax.stage3Hint")}</p>
								<div className="ax-row ax-row--mb">
									<button
										type="button"
										className="ax-btn ax-btn--emerald"
										data-testid="ax-synth-wireframe-btn"
										data-usage-event="ax-lecture-app.ctrl-21.click" onClick={handleSynthesizeWireframe}
									>
										{msg("ax.synthWireframeBtn")}
									</button>
									<button
										type="button"
										className="ax-btn ax-btn--primary"
										data-testid="ax-ask-wireframe-btn"
										disabled={busyAi}
										data-usage-event="ax-lecture-app.ctrl-22.click" onClick={() => void handleAskWireframeEnhance()}
									>
										{busyAi
											? msg("ax.busyGenerating")
											: msg("ax.askWireframeBtn")}
									</button>
									{previousWireframeHtml !== null && (
										<button
											type="button"
											className="ax-btn ax-btn--ghost"
											data-testid="ax-undo-wireframe-btn"
											data-usage-event="ax-lecture-app.ctrl-23.click" onClick={handleUndoWireframe}
										>
											{msg("ax.undoWireframeBtn")}
										</button>
									)}
								</div>

								<div className="ax-subtabs" role="group">
									<button
										type="button"
										className={`ax-subtab ${wireframeSubTab === "preview" ? "ax-subtab--active" : ""}`}
										data-testid="ax-subtab-preview"
										data-usage-event="ax-lecture-app.ctrl-24.click" onClick={() => setWireframeSubTab("preview")}
									>
										{msg("ax.subTabPreview")}
									</button>
									<button
										type="button"
										className={`ax-subtab ${wireframeSubTab === "source" ? "ax-subtab--active" : ""}`}
										data-testid="ax-subtab-source"
										data-usage-event="ax-lecture-app.ctrl-25.click" onClick={() => setWireframeSubTab("source")}
									>
										{msg("ax.subTabSource")}
									</button>
								</div>

								{wireframeSubTab === "preview" ? (
									<iframe
										className="ax-wireframe-iframe"
										title="AX Screen Wireframe Preview"
										data-testid="ax-wireframe-iframe"
										sandbox="allow-scripts"
										srcDoc={wireframeHtml}
									/>
								) : (
									<textarea
										className="ax-wireframe-editor"
										aria-label={msg("ax.subTabSource")}
										data-testid="ax-wireframe-source-editor"
										value={wireframeHtml}
										onChange={(e) => setWireframeHtml(e.target.value)}
										spellCheck={false}
									/>
								)}
							</div>
						)}
					</div>

					{/* Deliverable Export & Local Project Bridge Bar */}
					<div className="ax-card">
						<h3 className="ax-section-title">{msg("ax.exportBarTitle")}</h3>
						<div className="ax-row">
							<button
								type="button"
								className="ax-btn ax-btn--ghost ax-btn--xs"
								data-testid="ax-download-md-btn"
								data-usage-event="ax-lecture-app.ctrl-26.click" onClick={handleDownloadMarkdown}
							>
								{msg("ax.downloadMdBtn")}
							</button>
							<button
								type="button"
								className="ax-btn ax-btn--ghost ax-btn--xs"
								data-testid="ax-download-html-btn"
								data-usage-event="ax-lecture-app.ctrl-27.click" onClick={handleDownloadWireframe}
							>
								{msg("ax.downloadHtmlBtn")}
							</button>
							<button
								type="button"
								className="ax-btn ax-btn--primary ax-btn--xs"
								data-testid="ax-provision-local-btn"
								data-usage-event="ax-lecture-app.ctrl-28.click" onClick={() => void handleProvisionLocalPackage()}
							>
								{msg("ax.provisionLocalBtn")}
							</button>
							<button
								type="button"
								className="ax-btn ax-btn--emerald ax-btn--xs"
								data-testid="ax-open-projects-btn"
								data-usage-event="ax-lecture-app.ctrl-29.click" onClick={() => void handleOpenProjectsApp()}
							>
								{msg("ax.openProjectsBtn")}
							</button>
						</div>
					</div>
				</section>
			</main>
		</div>
	);
}
