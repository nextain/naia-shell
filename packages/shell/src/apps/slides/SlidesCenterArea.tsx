import {
	Fragment,
	useCallback,
	useEffect,
	useMemo,
	useReducer,
	useRef,
	useState,
} from "react";
import type { AppCenterProps } from "../../lib/app-registry";
import { appRegistry } from "../../lib/app-registry";
import { t } from "../../lib/i18n";
import { Logger } from "../../lib/logger";
import {
	EMPTY_SLIDE_PRESENTER_STATE,
	type SlideVideoCue,
	boundedDeckContext,
	narrationForPage,
	parseSlideSpeakerNotes,
	presentationRangeForNotes,
	reduceSlidePresenter,
} from "../../lib/slide-presenter";
import {
	SLIDE_PRESENTER_SPEECH_RESULT_EVENT,
	type SlidePresenterSpeechResult,
	cancelSlidePresenterSpeech,
	requestSlidePresenterSpeech,
} from "../../lib/slide-presenter-events";
import {
	parseSlideVideoDirectives,
	replaceSlideScriptPage,
} from "../../lib/slide-script";
import {
	type SlidesOpenedPdf,
	openSlidesDocument,
	watchSlidesPickerAvailable,
} from "../../lib/slides-files";
import {
	isRecordingLost,
	setSlidesPresentationActive,
	startSlidesRecording,
	stopSlidesRecording,
} from "../../lib/slides-host";
import { useTabSkills } from "../../lib/tab-skills";
import { useAppStore } from "../../stores/app";
import { SlidesControls } from "./SlidesControls";
import { SlidesErrorNotice, type SlidesFileError } from "./SlidesErrorNotice";
import { SlidesFileActions } from "./SlidesFileActions";
import { SlidesScriptPanel } from "./SlidesScriptPanel";
import { SlidesStatus } from "./SlidesStatus";
import { SlidesViewer } from "./SlidesViewer";
import "./slides.css";

export { resolveSlidesPdfWorkerUrl } from "./SlidesViewer";
const TAG = "SlidesCenterArea";

interface SlideVideoAsset {
	name: string;
	file: File;
	url: string;
}

function videoContentForScript(
	markdown: string,
	assets: readonly SlideVideoAsset[],
	readFailures: readonly string[] = [],
): { cues: SlideVideoCue[]; errors: string[] } {
	const directives = parseSlideVideoDirectives(markdown);
	const assetNames = new Set(assets.map((asset) => asset.name));
	const errors = new Set(readFailures);
	const cues = directives.map((directive, index) => {
		const available = directive.validName && assetNames.has(directive.fileName);
		if (!available) errors.add(directive.fileName || "(파일 이름 없음)");
		return {
			id: `${directive.page}-${directive.order}-${index}`,
			page: directive.page,
			order: directive.order,
			fileName: directive.fileName,
			available,
		};
	});
	Logger.debug(TAG, "demo video directives resolved", {
		directives: cues.map(({ page, order, fileName, available }) => ({
			page,
			order,
			fileName,
			available,
		})),
		loadedFileCount: assets.length,
	});
	return { cues, errors: [...errors] };
}

function createVideoAssets(selection: SlidesOpenedPdf): SlideVideoAsset[] {
	const assets: SlideVideoAsset[] = [];
	for (const video of selection.videos ?? []) {
		try {
			assets.push({
				name: video.name,
				file: video.file,
				url: URL.createObjectURL(video.file),
			});
		} catch (error) {
			Logger.warn(TAG, "demo video Blob URL creation failed", {
				fileName: video.name,
				error: String(error),
			});
		}
	}
	return assets;
}

export interface SlidesAppApi {
	start: () => void;
	pause: () => void;
	resume: () => void;
	stop: () => void;
	next: () => void;
	previous: () => void;
	goto: (page: number) => void;
}

function stateLabel(mode: string): string {
	const key = `slides.state.${mode}` as Parameters<typeof t>[0];
	return t(key);
}

function scriptDownloadName(scriptName: string, pdfName: string): string {
	const source = scriptName || pdfName || "slides";
	const base = source.replace(/\.(?:markdown|md|txt|pdf|pptx)$/i, "");
	return `${base || "slides"}.edited.md`;
}

export function SlidesCenterArea({ naia }: AppCenterProps) {
	const [state, dispatch] = useReducer(
		reduceSlidePresenter,
		EMPTY_SLIDE_PRESENTER_STATE,
	);
	const stateRef = useRef(state);
	stateRef.current = state;
	const [pdfFile, setPdfFile] = useState<File | null>(null);
	const [pdfName, setPdfName] = useState("");
	const [videoAssets, setVideoAssets] = useState<SlideVideoAsset[]>([]);
	const [videoErrors, setVideoErrors] = useState<string[]>([]);
	const videoAssetsRef = useRef<SlideVideoAsset[]>([]);
	const videoReadFailuresRef = useRef<string[]>([]);
	const videoElementsRef = useRef(new Map<string, HTMLVideoElement>());
	const lastVideoAttemptRef = useRef(new Map<string, number>());
	const [scriptName, setScriptName] = useState("");
	const [nativePickerAvailable, setNativePickerAvailable] = useState(false);
	const [pickingPdf, setPickingPdf] = useState(false);
	const [importPhase, setImportPhase] = useState<string | null>(null);
	const [fileError, setFileError] = useState<SlidesFileError | null>(null);
	const selectedFileRef = useRef<File | null>(null);
	const scriptRevisionRef = useRef(0);
	const pickerAbortRef = useRef<AbortController | null>(null);
	const [scriptMarkdown, setScriptMarkdown] = useState("");
	const scriptMarkdownRef = useRef("");
	const [scriptEditorOpen, setScriptEditorOpen] = useState(false);
	const [editingPage, setEditingPage] = useState<number | null>(null);
	const [draftText, setDraftText] = useState("");
	const [draftDirty, setDraftDirty] = useState(false);
	const [unexportedScript, setUnexportedScript] = useState(false);
	const draftOriginalRef = useRef("");
	const scriptDirtyRef = useRef(false);
	const [speakerNotes, setSpeakerNotes] = useState<Map<number, string>>(
		new Map(),
	);
	const [pageTexts, setPageTexts] = useState<string[]>([]);
	const [viewerWidth, setViewerWidth] = useState(960);
	const viewerRef = useRef<HTMLDivElement>(null);
	const appRef = useRef<HTMLElement>(null);
	const [fullscreen, setFullscreen] = useState(false);
	const [fullscreenError, setFullscreenError] = useState(false);
	const [recording, setRecording] = useState(false);
	const [recordingError, setRecordingError] = useState<string | null>(null);
	const [focusMode, setFocusMode] = useState(false);
	const slidePresentationActive =
		focusMode ||
		state.mode === "presenting" ||
		state.mode === "paused" ||
		state.mode === "answering";
	const [notesVisible, setNotesVisible] = useState(true);
	const activeSpeechRef = useRef<string | null>(null);
	const prefetchTicketRef = useRef<{
		id: string;
		page: number;
		text: string;
	} | null>(null);
	const prefetchSerialRef = useRef(0);
	const notesRef = useRef(speakerNotes);
	const pageTextsRef = useRef(pageTexts);
	notesRef.current = speakerNotes;
	pageTextsRef.current = pageTexts;
	const hasUnsavedScript = draftDirty || unexportedScript;
	scriptDirtyRef.current = hasUnsavedScript;
	videoAssetsRef.current = videoAssets;

	const registerVideoElement = useCallback(
		(url: string, element: HTMLVideoElement | null) => {
			if (element) videoElementsRef.current.set(url, element);
			else videoElementsRef.current.delete(url);
		},
		[],
	);
	const videoRefCallbacks = useMemo(
		() =>
			new Map(
				videoAssets.map((asset) => [
					asset.url,
					(element: HTMLVideoElement | null) =>
						registerVideoElement(asset.url, element),
				]),
			),
		[registerVideoElement, videoAssets],
	);

	useTabSkills(viewerRef, naia);

	useEffect(() => {
		setSlidesPresentationActive(slidePresentationActive);
		return () => setSlidesPresentationActive(false);
	}, [slidePresentationActive]);

	useEffect(() => {
		const onChange = () =>
			setFullscreen(document.fullscreenElement === appRef.current);
		document.addEventListener("fullscreenchange", onChange);
		return () => document.removeEventListener("fullscreenchange", onChange);
	}, []);

	async function toggleFullscreen() {
		try {
			setFullscreenError(false);
			if (document.fullscreenElement === appRef.current) {
				await document.exitFullscreen();
			} else {
				await appRef.current?.requestFullscreen();
			}
		} catch (error) {
			setFullscreenError(true);
			Logger.warn(TAG, "fullscreen failed", { error: String(error) });
		}
	}

	useEffect(() => watchSlidesPickerAvailable(setNativePickerAvailable), []);
	useEffect(
		() => () => {
			pickerAbortRef.current?.abort();
			scriptRevisionRef.current++;
			selectedFileRef.current = null;
		},
		[],
	);
	useEffect(
		() => () => {
			for (const asset of videoAssets) URL.revokeObjectURL(asset.url);
		},
		[videoAssets],
	);

	useEffect(() => {
		if (!hasUnsavedScript) return;
		const onBeforeUnload = (event: BeforeUnloadEvent) => {
			event.preventDefault();
			event.returnValue = t("slides.unsavedChangesConfirm");
		};
		window.addEventListener("beforeunload", onBeforeUnload);
		return () => window.removeEventListener("beforeunload", onBeforeUnload);
	}, [hasUnsavedScript]);

	function confirmScriptReplacement(): boolean {
		if (!scriptDirtyRef.current) return true;
		const discard = window.confirm(t("slides.unsavedChangesConfirm"));
		if (!discard) setFileError("unsaved");
		return discard;
	}

	function documentErrorKey(error: unknown): SlidesFileError {
		const code = String(error)
			.replace(/^Error:\s*/u, "")
			.toLowerCase();
		if (code.includes("converter_unavailable")) return "converter";
		if (code.includes("invalid_pptx")) return "invalidPptx";
		if (code.includes("conversion_timeout")) return "conversionTimeout";
		if (code.includes("conversion_failed")) return "conversionFailed";
		if (code.includes("picker_busy") || code.includes("import_busy"))
			return "busy";
		return "import";
	}

	const currentNarration = useMemo(
		() => narrationForPage(state.page, speakerNotes, pageTexts),
		[state.page, speakerNotes, pageTexts],
	);

	const deckContext = useMemo(
		() => boundedDeckContext(pageTexts, speakerNotes),
		[pageTexts, speakerNotes],
	);

	const cancelSpeech = useCallback(() => {
		const requestId = activeSpeechRef.current;
		activeSpeechRef.current = null;
		const prefetchId = prefetchTicketRef.current?.id;
		prefetchTicketRef.current = null;
		cancelSlidePresenterSpeech({
			requestId: requestId ?? undefined,
			generation: stateRef.current.generation,
			prefetchId,
			invalidateGeneration: true,
		});
	}, []);

	const cancelPrefetch = useCallback(() => {
		const ticket = prefetchTicketRef.current;
		prefetchTicketRef.current = null;
		if (!ticket) return;
		cancelSlidePresenterSpeech({
			generation: stateRef.current.generation,
			prefetchId: ticket.id,
			invalidateGeneration: false,
		});
	}, []);

	const pauseActiveVideo = useCallback(() => {
		const index = stateRef.current.activeVideoIndex;
		if (index === null) return;
		const cue = stateRef.current.videoCues[index];
		const asset = cue
			? videoAssetsRef.current.find(
					(candidate) => candidate.name === cue.fileName,
				)
			: undefined;
		if (asset) videoElementsRef.current.get(asset.url)?.pause();
	}, []);

	const runAction = useCallback(
		(
			action:
				| "start"
				| "pause"
				| "resume"
				| "stop"
				| "next"
				| "previous"
				| "question",
		) => {
			if (scriptEditorOpen) return;
			if (action !== "resume" && action !== "start") pauseActiveVideo();
			if (["pause", "stop", "next", "previous", "question"].includes(action)) {
				cancelSpeech();
			}
			dispatch({ type: action });
			Logger.info(TAG, "presentation action", {
				action,
				page: stateRef.current.page,
			});
		},
		[cancelSpeech, pauseActiveVideo, scriptEditorOpen],
	);

	const gotoPage = useCallback(
		(page: number) => {
			if (scriptEditorOpen) return;
			pauseActiveVideo();
			cancelSpeech();
			dispatch({ type: "goto", page });
		},
		[cancelSpeech, pauseActiveVideo, scriptEditorOpen],
	);

	useEffect(() => {
		if (state.mode !== "presenting" || state.speech !== "requested") return;
		const text = currentNarration.trim();
		if (!text) {
			if (notesRef.current.has(state.page)) {
				cancelSpeech();
				dispatch({ type: "pause" });
				return;
			}
			dispatch({
				type: "speech-failed",
				generation: state.generation,
				error: "empty_narration",
			});
			return;
		}
		const requestId = `slides-${state.generation}-${state.page}`;
		let prefetchId: string | undefined;
		const priorPrefetch = prefetchTicketRef.current;
		prefetchTicketRef.current = null;
		if (priorPrefetch?.page === state.page && priorPrefetch.text === text) {
			prefetchId = priorPrefetch.id;
		} else if (priorPrefetch) {
			cancelPrefetch();
		}
		const nextPage =
			state.page < state.rangeEnd
				? state.page + 1
				: state.repeat
					? state.rangeStart
					: null;
		let nextPrefetch: { id: string; page: number; text: string } | undefined;
		if (nextPage !== null) {
			const nextText = narrationForPage(
				nextPage,
				notesRef.current,
				pageTextsRef.current,
			).trim();
			if (nextText) {
				nextPrefetch = {
					id: `slides-prefetch-${++prefetchSerialRef.current}`,
					page: nextPage,
					text: nextText,
				};
				prefetchTicketRef.current = nextPrefetch;
			}
		}
		activeSpeechRef.current = requestId;
		requestSlidePresenterSpeech({
			requestId,
			generation: state.generation,
			page: state.page,
			text,
			prefetchId,
			nextPrefetch,
		});
		dispatch({ type: "speech-requested", generation: state.generation });
		Logger.info(TAG, "narration requested", {
			page: state.page,
			generation: state.generation,
			characters: text.length,
		});
	}, [
		currentNarration,
		state.generation,
		state.mode,
		state.page,
		state.rangeEnd,
		state.rangeStart,
		state.repeat,
		state.speech,
		cancelSpeech,
		cancelPrefetch,
	]);

	const activeVideo =
		state.activeVideoIndex === null
			? null
			: (state.videoCues[state.activeVideoIndex] ?? null);
	const preloadVideo =
		activeVideo ??
		(state.mode === "presenting"
			? (state.videoCues.find(
					(cue) => cue.page === state.page && cue.available,
				) ?? null)
			: null);

	useEffect(() => {
		if (
			state.mode !== "presenting" ||
			state.activeVideoIndex === null ||
			!activeVideo
		)
			return;
		const index = state.activeVideoIndex;
		const generation = state.generation;
		const attempt = state.videoAttempt;
		const asset = videoAssets.find(
			(candidate) => candidate.name === activeVideo.fileName,
		);
		const element = asset ? videoElementsRef.current.get(asset.url) : undefined;
		let live = true;
		const fail = (error: string) => {
			if (!live) return;
			Logger.warn(TAG, "demo video playback failed; skipping segment", {
				page: activeVideo.page,
				order: activeVideo.order,
				fileName: activeVideo.fileName,
				generation,
				error,
			});
			setVideoErrors((current) =>
				current.includes(activeVideo.fileName)
					? current
					: [...current, activeVideo.fileName],
			);
			dispatch({ type: "video-failed", generation, index, error });
		};
		if (!asset || !element) {
			fail("video_asset_unavailable");
			return () => {
				live = false;
			};
		}
		const onEnded = () => dispatch({ type: "video-ended", generation, index });
		const onError = () => fail("media_element_error");
		element.volume = 1;
		element.muted = false;
		element.addEventListener("ended", onEnded);
		element.addEventListener("error", onError);
		const previousAttempt = lastVideoAttemptRef.current.get(asset.url);
		if (previousAttempt !== attempt) {
			if (previousAttempt !== undefined) {
				try {
					element.currentTime = 0;
				} catch (error) {
					fail(`seek_failed: ${String(error)}`);
				}
			}
			lastVideoAttemptRef.current.set(asset.url, attempt);
		}
		Logger.info(TAG, "demo video playback started", {
			page: activeVideo.page,
			order: activeVideo.order,
			fileName: activeVideo.fileName,
			generation,
			attempt,
			volume: element.volume,
			muted: element.muted,
		});
		try {
			const playback = element.play();
			void playback?.catch((error) => fail(String(error)));
		} catch (error) {
			fail(String(error));
		}
		return () => {
			live = false;
			element.removeEventListener("ended", onEnded);
			element.removeEventListener("error", onError);
			try {
				element.pause();
			} catch {
				// The document may be unloading its WebKit media pipeline.
			}
		};
	}, [
		activeVideo,
		state.activeVideoIndex,
		state.generation,
		state.mode,
		state.videoAttempt,
		videoAssets,
	]);

	useEffect(() => {
		const onResult = (event: Event) => {
			const detail = (event as CustomEvent<SlidePresenterSpeechResult>).detail;
			if (!detail || detail.requestId !== activeSpeechRef.current) return;
			activeSpeechRef.current = null;
			if (detail.status === "finished") {
				dispatch({ type: "speech-finished", generation: detail.generation });
				return;
			}
			if (detail.status === "failed") {
				dispatch({
					type: "speech-failed",
					generation: detail.generation,
					error: detail.error ?? "speech_failed",
				});
				return;
			}
			if (detail.status === "cancelled") {
				dispatch({ type: "speech-cancelled", generation: detail.generation });
			}
		};
		window.addEventListener(SLIDE_PRESENTER_SPEECH_RESULT_EVENT, onResult);
		return () => {
			window.removeEventListener(SLIDE_PRESENTER_SPEECH_RESULT_EVENT, onResult);
			cancelSpeech();
		};
	}, [cancelSpeech]);

	useEffect(() => {
		const element = viewerRef.current;
		if (!element) return;
		const update = () =>
			setViewerWidth(Math.max(280, element.clientWidth - 32));
		update();
		const observer = new ResizeObserver(update);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		if (window.parent === window) return;
		const onMessage = (event: MessageEvent) => {
			if (
				event.source !== window.parent ||
				event.data?.type !== "naia-slides:speech-result"
			)
				return;
			window.dispatchEvent(
				new CustomEvent(SLIDE_PRESENTER_SPEECH_RESULT_EVENT, {
					detail: event.data.detail,
				}),
			);
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, []);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (
				window.parent === window &&
				useAppStore.getState().activeApp !== "slides"
			)
				return;
			if (
				(event.target as HTMLElement | null)?.matches("input, textarea, select")
			)
				return;
			// Focused controls own Space activation; do not pause instead of toggling repeat.
			if (
				event.key === " " &&
				(event.target as HTMLElement | null)?.closest("button")
			)
				return;
			if (["ArrowRight", "PageDown"].includes(event.key)) {
				event.preventDefault();
				runAction("next");
			} else if (["ArrowLeft", "PageUp"].includes(event.key)) {
				event.preventDefault();
				runAction("previous");
			} else if (event.key === " ") {
				event.preventDefault();
				runAction(stateRef.current.mode === "presenting" ? "pause" : "resume");
			} else if (event.key === "Escape") {
				runAction("stop");
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [runAction]);

	useEffect(() => {
		const onFocusShortcut = (event: KeyboardEvent) => {
			if (event.key.toLowerCase() !== "f") return;
			if (
				(event.target as HTMLElement | null)?.matches("input, textarea, select")
			)
				return;
			event.preventDefault();
			setFocusMode((focused) => !focused);
		};
		window.addEventListener("keydown", onFocusShortcut);
		return () => window.removeEventListener("keydown", onFocusShortcut);
	}, []);
	useEffect(() => {
		const context = {
			type: "slides",
			data: {
				fileName: pdfName,
				scriptName,
				state: state.mode,
				page: state.page,
				totalPages: state.totalPages,
				currentSlideText: pageTexts[state.page - 1] ?? "",
				currentSpeakerNote: currentNarration,
				rangeStart: state.rangeStart,
				rangeEnd: state.rangeEnd,
				repeat: state.repeat,
				deckContext,
			},
		};
		naia.pushContext(context);
	}, [
		currentNarration,
		deckContext,
		naia,
		pageTexts,
		pdfName,
		scriptName,
		state.mode,
		state.page,
		state.totalPages,
		state.rangeStart,
		state.rangeEnd,
		state.repeat,
	]);

	useEffect(() => {
		const unsubscribe = naia.onToolCall(
			"skill_slide_presenter",
			async (args) => {
				const action = String(args.action ?? "status");
				const current = stateRef.current;
				if (action === "goto") {
					gotoPage(Number(args.page ?? current.page));
				} else if (action === "get_context") {
					return JSON.stringify({
						page: current.page,
						totalPages: current.totalPages,
						state: current.mode,
						currentSlideText: pageTextsRef.current[current.page - 1] ?? "",
						currentSpeakerNote: narrationForPage(
							current.page,
							notesRef.current,
							pageTextsRef.current,
						),
						deckContext: boundedDeckContext(
							pageTextsRef.current,
							notesRef.current,
						),
					});
				} else if (
					action !== "status" &&
					[
						"start",
						"pause",
						"resume",
						"stop",
						"next",
						"previous",
						"question",
					].includes(action)
				) {
					runAction(
						action as
							| "start"
							| "pause"
							| "resume"
							| "stop"
							| "next"
							| "previous"
							| "question",
					);
				}
				const next = stateRef.current;
				return JSON.stringify({
					ok: next.totalPages > 0,
					state: next.mode,
					page: next.page,
					totalPages: next.totalPages,
				});
			},
		);
		return unsubscribe;
	}, [gotoPage, naia, runAction]);

	useEffect(() => {
		if (window.parent !== window) return;
		appRegistry.updateApi("slides", {
			start: () => runAction("start"),
			pause: () => runAction("pause"),
			resume: () => runAction("resume"),
			stop: () => runAction("stop"),
			next: () => runAction("next"),
			previous: () => runAction("previous"),
			goto: gotoPage,
		});
		return () => appRegistry.updateApi("slides", undefined);
	}, [gotoPage, runAction]);

	function loadPdf(file: File, companion?: SlidesOpenedPdf) {
		pauseActiveVideo();
		cancelSpeech();
		const nextAssets = companion ? createVideoAssets(companion) : [];
		videoAssetsRef.current = nextAssets;
		videoReadFailuresRef.current = companion?.videoReadFailures ?? [];
		scriptMarkdownRef.current = companion?.script?.text ?? "";
		setVideoAssets(nextAssets);
		const videoContent = videoContentForScript(
			companion?.script?.text ?? "",
			nextAssets,
			companion?.videoReadFailures ?? [],
		);
		setVideoErrors(videoContent.errors);
		for (const fileName of videoContent.errors) {
			Logger.warn(TAG, "demo video unavailable or rejected", { fileName });
		}
		scriptRevisionRef.current++;
		selectedFileRef.current = file;
		setPdfFile(file);
		setPdfName(file.name);
		setPageTexts([]);
		setScriptMarkdown(companion?.script?.text ?? "");
		setSpeakerNotes(
			companion?.script
				? parseSlideSpeakerNotes(companion.script.text)
				: new Map(),
		);
		setScriptName(companion?.script?.name ?? "");
		setScriptEditorOpen(false);
		setEditingPage(null);
		setDraftText("");
		setDraftDirty(false);
		setUnexportedScript(false);
		setImportPhase(null);
		setFileError(companion?.scriptReadFailed ? "script" : null);
		dispatch({ type: "load" });
		Logger.info(TAG, "PDF selected", {
			fileName: file.name,
			bytes: file.size,
			companion: !!companion?.script,
		});
	}

	async function pickPdf() {
		if (pickerAbortRef.current) return;
		const abort = new AbortController();
		pickerAbortRef.current = abort;
		setPickingPdf(true);
		setImportPhase("picking");
		try {
			const selection = await openSlidesDocument(abort.signal, setImportPhase);
			if (!abort.signal.aborted && selection && confirmScriptReplacement()) {
				loadPdf(selection.file, selection);
			}
		} catch (error) {
			if (!abort.signal.aborted) {
				setFileError(documentErrorKey(error));
				setImportPhase(null);
				Logger.warn(TAG, "document selection failed", { error: String(error) });
			}
		} finally {
			if (pickerAbortRef.current === abort) pickerAbortRef.current = null;
			setPickingPdf(false);
		}
	}

	function cancelImport() {
		const abort = pickerAbortRef.current;
		if (!abort) return;
		abort.abort();
		pickerAbortRef.current = null;
		setPickingPdf(false);
		setImportPhase(null);
	}

	async function loadScript(file: File) {
		const revision = ++scriptRevisionRef.current;
		try {
			const markdown = await file.text();
			if (revision !== scriptRevisionRef.current) return;
			if (!confirmScriptReplacement()) return;
			const notes = parseSlideSpeakerNotes(markdown);
			const videoContent = videoContentForScript(
				markdown,
				videoAssetsRef.current,
				videoReadFailuresRef.current,
			);
			scriptMarkdownRef.current = markdown;
			setScriptMarkdown(markdown);
			setSpeakerNotes(notes);
			setVideoErrors(videoContent.errors);
			for (const fileName of videoContent.errors) {
				Logger.warn(TAG, "demo video unavailable or rejected", { fileName });
			}
			if (stateRef.current.totalPages) {
				pauseActiveVideo();
				cancelSpeech();
				dispatch({
					type: "set-range",
					...presentationRangeForNotes(notes, stateRef.current.totalPages),
				});
				dispatch({ type: "set-video-cues", videoCues: videoContent.cues });
			}
			setScriptName(file.name);
			setScriptEditorOpen(false);
			setEditingPage(null);
			setDraftText("");
			setDraftDirty(false);
			setUnexportedScript(false);
			setFileError(null);
			Logger.info(TAG, "speaker script loaded", { fileName: file.name });
		} catch (error) {
			if (revision !== scriptRevisionRef.current) return;
			setFileError("script");
			Logger.warn(TAG, "speaker script load failed", { error: String(error) });
		}
	}

	function beginScriptEdit() {
		pauseActiveVideo();
		cancelSpeech();
		if (stateRef.current.mode === "presenting") dispatch({ type: "pause" });
		const initial = speakerNotes.has(state.page)
			? (speakerNotes.get(state.page) ?? "")
			: currentNarration;
		draftOriginalRef.current = initial;
		setEditingPage(state.page);
		setDraftText(initial);
		setDraftDirty(false);
		setScriptEditorOpen(true);
	}

	function cancelScriptEdit() {
		setDraftText("");
		setDraftDirty(false);
		setEditingPage(null);
		setScriptEditorOpen(false);
	}

	function applyScriptEdit() {
		if (!scriptEditorOpen) return;
		pauseActiveVideo();
		cancelSpeech();
		if (stateRef.current.mode === "presenting") dispatch({ type: "pause" });
		const nextMarkdown = replaceSlideScriptPage(
			scriptMarkdown,
			editingPage ?? state.page,
			draftText,
		);
		const nextNotes = parseSlideSpeakerNotes(nextMarkdown);
		const videoContent = videoContentForScript(
			nextMarkdown,
			videoAssetsRef.current,
			videoReadFailuresRef.current,
		);
		scriptMarkdownRef.current = nextMarkdown;
		setScriptMarkdown(nextMarkdown);
		setSpeakerNotes(nextNotes);
		setVideoErrors(videoContent.errors);
		if (stateRef.current.totalPages)
			dispatch({ type: "set-video-cues", videoCues: videoContent.cues });
		setUnexportedScript(true);
		setFileError(null);
		cancelScriptEdit();
		Logger.info(TAG, "slide script edit applied", {
			page: editingPage ?? state.page,
		});
	}

	function downloadEditedScript() {
		if (draftDirty) {
			setFileError("exportUnsaved");
			return;
		}
		if (!unexportedScript) return;
		let url = "";
		try {
			if (!URL.createObjectURL) throw new Error("download_unavailable");
			const blob = new Blob([scriptMarkdown], { type: "text/markdown" });
			url = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = scriptDownloadName(scriptName, pdfName);
			anchor.style.display = "none";
			document.body.append(anchor);
			anchor.click();
			anchor.remove();
			setUnexportedScript(false);
			setFileError(null);
		} catch (error) {
			setFileError("export");
			Logger.warn(TAG, "edited script download failed", {
				error: String(error),
			});
		} finally {
			if (url) window.setTimeout(() => URL.revokeObjectURL(url), 0);
		}
	}

	async function toggleRecording() {
		try {
			setRecordingError(null);
			if (!recording) {
				await startSlidesRecording();
				setRecording(true);
				return;
			}
			const output = await stopSlidesRecording();
			setRecording(false);
			const fileName = output.split(/[\\/]/).pop();
			if (fileName) await naia.openInWorkspace?.(`video/${fileName}`);
		} catch (error) {
			// A failed stop retains native ownership, so keep Stop available to
			// retry — unless the host reports the recording as lost.
			if (recording && isRecordingLost(error)) setRecording(false);
			setRecordingError(
				`${t("slides.recordingFailed")} (${String(error).replace(/^Error: /, "")})`,
			);
		}
	}

	return (
		<section
			ref={appRef}
			className="slides-app"
			aria-label={t("slides.title")}
			data-focus={focusMode}
			data-state={state.mode}
			data-notes-visible={notesVisible}
		>
			<header className="slides-app__header">
				<div>
					<h1>{t("slides.title")}</h1>
					<p>{t("slides.subtitle")}</p>
				</div>
				<SlidesFileActions
					nativePickerAvailable={nativePickerAvailable}
					picking={pickingPdf}
					focusMode={focusMode}
					notesVisible={notesVisible}
					onPickNative={() => void pickPdf()}
					onPdfSelected={(file) => {
						if (confirmScriptReplacement()) loadPdf(file);
					}}
					onScriptSelected={(file) => void loadScript(file)}
					onToggleFocus={() => setFocusMode((focused) => !focused)}
					onShowNotes={() => setNotesVisible(true)}
				/>
			</header>
			{focusMode ? (
				<button
					type="button"
					className="slides-app__focus-exit slides-app__focus-button"
					onClick={() => setFocusMode(false)}
				>
					{t("slides.focusExit")}
				</button>
			) : null}

			<SlidesStatus
				modeLabel={stateLabel(state.mode)}
				pdfName={pdfName}
				scriptName={scriptName}
				draftDirty={draftDirty}
				unexportedScript={unexportedScript}
				picking={pickingPdf}
				importPhase={importPhase}
				onCancelImport={cancelImport}
			/>

			<div className="slides-app__workspace">
				<SlidesViewer
					file={pdfFile}
					fileName={pdfName}
					page={state.page}
					viewerRef={viewerRef}
					viewerWidth={viewerWidth}
					totalPages={state.totalPages}
					hidden={activeVideo !== null}
					onReady={(file, totalPages, texts) => {
						if (selectedFileRef.current !== file) return;
						dispatch({
							type: "loaded",
							totalPages,
							range: presentationRangeForNotes(notesRef.current, totalPages),
							videoCues: videoContentForScript(
								scriptMarkdownRef.current,
								videoAssetsRef.current,
								videoReadFailuresRef.current,
							).cues,
						});
						setPageTexts(texts);
						Logger.info(TAG, "PDF ready", { pages: totalPages });
					}}
					onError={(file, error) => {
						if (selectedFileRef.current !== file) return;
						dispatch({ type: "fail", error: String(error) });
						Logger.warn(TAG, "PDF load failed", { error: String(error) });
					}}
				/>
				<div
					className="slides-app__viewer slides-app__video-viewer"
					data-testid="slides-video-viewer"
					hidden={activeVideo === null}
				>
					{videoAssets.map((asset) => (
						<Fragment key={asset.url}>
							{/* biome-ignore lint/a11y/useMediaCaption: selected media is authored externally and the script contract supplies no caption track. */}
							<video
								ref={videoRefCallbacks.get(asset.url)}
								src={asset.url}
								preload={
									preloadVideo?.fileName === asset.name ? "auto" : "metadata"
								}
								playsInline
								tabIndex={-1}
								aria-hidden={activeVideo?.fileName !== asset.name}
								aria-label={
									activeVideo?.fileName === asset.name
										? `${activeVideo.page}-${activeVideo.order} / 영상 ${asset.name}`
										: undefined
								}
								className={
									activeVideo?.fileName === asset.name
										? "slides-app__video slides-app__video--active"
										: "slides-app__video"
								}
								data-testid={`slides-video-${encodeURIComponent(asset.name)}`}
							/>
						</Fragment>
					))}
					{activeVideo ? (
						<output
							className="slides-app__video-indicator"
							data-testid="slides-video-indicator"
							aria-live="polite"
						>
							{activeVideo.page}-{activeVideo.order} / 영상
						</output>
					) : null}
				</div>

				{notesVisible ? (
					<SlidesScriptPanel
						page={state.page}
						totalPages={state.totalPages}
						currentNarration={currentNarration}
						scriptEditorOpen={scriptEditorOpen}
						draftText={draftText}
						draftDirty={draftDirty}
						unexportedScript={unexportedScript}
						onBeginEdit={beginScriptEdit}
						onDownload={downloadEditedScript}
						onHide={() => setNotesVisible(false)}
						onDraftChange={(value) => {
							setDraftText(value);
							setDraftDirty(value !== draftOriginalRef.current);
						}}
						onApply={applyScriptEdit}
						onCancel={cancelScriptEdit}
					/>
				) : null}
			</div>

			<SlidesControls
				state={state}
				fullscreen={fullscreen}
				recording={recording}
				editing={scriptEditorOpen}
				onAction={runAction}
				onRangeChange={(start, end) => {
					cancelSpeech();
					pauseActiveVideo();
					dispatch({ type: "set-range", start, end });
				}}
				onGoto={gotoPage}
				onToggleRepeat={() => {
					cancelPrefetch();
					dispatch({ type: "toggle-repeat" });
					Logger.info(TAG, "presentation repeat toggled", {
						enabled: !state.repeat,
					});
				}}
				onToggleFullscreen={() => void toggleFullscreen()}
				onToggleRecording={() => void toggleRecording()}
			/>
			<SlidesErrorNotice
				speechError={Boolean(state.error)}
				recordingError={recordingError}
				fullscreenError={fullscreenError}
				fileError={fileError}
				videoErrors={videoErrors}
			/>
		</section>
	);
}
