import {
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
	type BuildPptxSlideInput,
	PPTX_MIME_TYPE,
	type ParsedPptxDeck,
	buildPptxPresentation,
	parsePptxPresentation,
	slidesFromPageTextsAndNotes,
} from "../../lib/pptx-ooxml";
import {
	EMPTY_SLIDE_PRESENTER_STATE,
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
import { replaceSlideScriptPage } from "../../lib/slide-script";
import {
	type SlidesOpenedPdf,
	openSlidesDocument,
	watchSlidesPickerAvailable,
} from "../../lib/slides-files";
import {
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

export interface SlidesAppApi {
	start: () => void;
	pause: () => void;
	resume: () => void;
	stop: () => void;
	next: () => void;
	previous: () => void;
	goto: (page: number) => void;
	exportPptx: () => string | null;
}

function stateLabel(mode: string): string {
	const key = `slides.state.${mode}` as Parameters<typeof t>[0];
	return t(key);
}

function deckBaseName(pdfName: string, scriptName: string): string {
	const source = pdfName || scriptName || "slides";
	const base = source.replace(/\.(?:markdown|md|txt|pdf|pptx)$/i, "").trim();
	return base || "slides";
}

function scriptDownloadName(scriptName: string, pdfName: string): string {
	return `${deckBaseName(scriptName, pdfName)}.edited.md`;
}

function pptxDownloadName(pdfName: string, scriptName: string): string {
	return `${deckBaseName(pdfName, scriptName)}.pptx`;
}

function isPptxFile(file: File): boolean {
	return (
		file.name.toLowerCase().endsWith(".pptx") || file.type === PPTX_MIME_TYPE
	);
}

async function readFileUint8Array(file: File): Promise<Uint8Array> {
	if (typeof file.arrayBuffer === "function") {
		return new Uint8Array(await file.arrayBuffer());
	}
	return new Uint8Array(await new Response(file).arrayBuffer());
}

export function SlidesCenterArea({
	naia,
	sampleDeck,
}: AppCenterProps & { sampleDeck?: { pdfUrl: string; scriptUrl: string } }) {
	const [state, dispatch] = useReducer(
		reduceSlidePresenter,
		EMPTY_SLIDE_PRESENTER_STATE,
	);
	const stateRef = useRef(state);
	stateRef.current = state;
	const [pdfFile, setPdfFile] = useState<File | null>(null);
	const [pptxDeck, setPptxDeck] = useState<ParsedPptxDeck | null>(null);
	const [pdfName, setPdfName] = useState("");
	const [scriptName, setScriptName] = useState("");
	const [nativePickerAvailable, setNativePickerAvailable] = useState(false);
	const [pickingPdf, setPickingPdf] = useState(false);
	const [importPhase, setImportPhase] = useState<string | null>(null);
	const [fileError, setFileError] = useState<SlidesFileError | null>(null);
	const selectedFileRef = useRef<File | null>(null);
	const samplePromiseRef = useRef<Promise<SlidesOpenedPdf | null> | null>(null);
	const browserInputRef = useRef<HTMLInputElement>(null);
	const scriptRevisionRef = useRef(0);
	const pickerAbortRef = useRef<AbortController | null>(null);
	const [scriptMarkdown, setScriptMarkdown] = useState("");
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
	const [notesVisible, setNotesVisible] = useState(true);
	const activeSpeechRef = useRef<string | null>(null);
	const notesRef = useRef(speakerNotes);
	const pageTextsRef = useRef(pageTexts);
	const pptxDeckRef = useRef(pptxDeck);
	const pdfNameRef = useRef(pdfName);
	const scriptNameRef = useRef(scriptName);
	const draftDirtyRef = useRef(draftDirty);
	notesRef.current = speakerNotes;
	pageTextsRef.current = pageTexts;
	pptxDeckRef.current = pptxDeck;
	pdfNameRef.current = pdfName;
	scriptNameRef.current = scriptName;
	draftDirtyRef.current = draftDirty;
	const hasUnsavedScript = draftDirty || unexportedScript;
	scriptDirtyRef.current = hasUnsavedScript;

	useTabSkills(viewerRef, naia);

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
		cancelSlidePresenterSpeech({
			requestId: requestId ?? undefined,
			generation: stateRef.current.generation,
		});
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
			if (["pause", "stop", "next", "previous", "question"].includes(action)) {
				cancelSpeech();
			}
			dispatch({ type: action });
			Logger.info(TAG, "presentation action", {
				action,
				page: stateRef.current.page,
			});
		},
		[cancelSpeech, scriptEditorOpen],
	);

	const gotoPage = useCallback(
		(page: number) => {
			if (scriptEditorOpen) return;
			cancelSpeech();
			dispatch({ type: "goto", page });
		},
		[cancelSpeech, scriptEditorOpen],
	);

	const applyParsedPptxDeck = useCallback(
		(file: File, deck: ParsedPptxDeck) => {
			cancelSpeech();
			scriptRevisionRef.current++;
			selectedFileRef.current = file;
			setPdfFile(null);
			setPptxDeck(deck);
			setPdfName(file.name);
			setPageTexts(deck.pageTexts);
			setScriptMarkdown(deck.scriptMarkdown);
			setSpeakerNotes(deck.speakerNotes);
			setScriptName(
				deck.speakerNotes.size > 0
					? `${deckBaseName(file.name, "")}.notes.md`
					: "",
			);
			setScriptEditorOpen(false);
			setEditingPage(null);
			setDraftText("");
			setDraftDirty(false);
			setUnexportedScript(false);
			setImportPhase(null);
			setFileError(null);
			dispatch({ type: "load" });
			dispatch({
				type: "loaded",
				totalPages: deck.slides.length,
				range: presentationRangeForNotes(deck.speakerNotes, deck.slides.length),
			});
			Logger.info(TAG, "PPTX presentation loaded in browser", {
				fileName: file.name,
				slides: deck.slides.length,
				notes: deck.speakerNotes.size,
			});
		},
		[cancelSpeech],
	);

	const exportPptxDeck = useCallback((): string | null => {
		if (draftDirtyRef.current) {
			setFileError("exportUnsaved");
			return null;
		}
		const currentTotal = stateRef.current.totalPages;
		if (!currentTotal) return null;

		let url = "";
		try {
			if (typeof URL === "undefined" || !URL.createObjectURL) {
				throw new Error("download_unavailable");
			}
			const activePptx = pptxDeckRef.current;
			const currentNotes = notesRef.current;
			const slides: BuildPptxSlideInput[] = activePptx
				? activePptx.slides.map((slide, idx) => ({
						title: slide.title,
						subtitle: slide.subtitle,
						bullets: slide.bullets,
						tables: slide.tables,
						images: slide.images,
						backgroundHex: slide.backgroundHex,
						notes: currentNotes.get(idx + 1) ?? slide.notes,
					}))
				: slidesFromPageTextsAndNotes(
						pageTextsRef.current,
						currentNotes,
						currentTotal,
					);

			const fileName = pptxDownloadName(
				pdfNameRef.current,
				scriptNameRef.current,
			);
			const bytes = buildPptxPresentation({
				title: deckBaseName(pdfNameRef.current, scriptNameRef.current),
				creator: "Naia Slides",
				slideWidthEmu: activePptx?.slideWidthEmu,
				slideHeightEmu: activePptx?.slideHeightEmu,
				slides,
			});
			const blob = new Blob([bytes as unknown as BlobPart], {
				type: PPTX_MIME_TYPE,
			});
			url = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = fileName;
			anchor.style.display = "none";
			document.body.append(anchor);
			anchor.click();
			anchor.remove();
			setFileError(null);
			Logger.info(TAG, "PPTX presentation exported", {
				fileName,
				slides: slides.length,
				bytes: bytes.length,
			});
			return fileName;
		} catch (error) {
			setFileError("pptxExport");
			Logger.warn(TAG, "PPTX export failed", { error: String(error) });
			return null;
		} finally {
			if (url) window.setTimeout(() => URL.revokeObjectURL(url), 0);
		}
	}, []);

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
		activeSpeechRef.current = requestId;
		requestSlidePresenterSpeech({
			requestId,
			generation: state.generation,
			page: state.page,
			text,
		});
		dispatch({ type: "speech-requested", generation: state.generation });
		Logger.info(TAG, "narration requested", {
			page: state.page,
			generation: state.generation,
			characters: text.length,
		});
	}, [
		cancelSpeech,
		currentNarration,
		state.generation,
		state.mode,
		state.page,
		state.speech,
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
				format: pptxDeck ? "pptx" : pdfFile ? "pdf" : "empty",
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
		pdfFile,
		pdfName,
		pptxDeck,
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
				} else if (action === "export_pptx") {
					const exported = exportPptxDeck();
					return JSON.stringify({
						ok: Boolean(exported),
						exported,
						page: current.page,
						totalPages: current.totalPages,
					});
				} else if (action === "create_deck") {
					const rawSlides = Array.isArray(args.slides) ? args.slides : [];
					if (rawSlides.length === 0) {
						return JSON.stringify({
							ok: false,
							error: "slides_required",
						});
					}
					const title =
						typeof args.title === "string" && args.title.trim()
							? args.title.trim()
							: "naia-deck";
					const slideInputs: BuildPptxSlideInput[] = rawSlides.map(
						(item, idx) => {
							const record =
								item && typeof item === "object"
									? (item as Record<string, unknown>)
									: {};
							return {
								title:
									typeof record.title === "string" && record.title.trim()
										? record.title.trim()
										: `Slide ${idx + 1}`,
								subtitle:
									typeof record.subtitle === "string"
										? record.subtitle
										: undefined,
								bullets: Array.isArray(record.bullets)
									? record.bullets.map((b) => String(b))
									: [],
								notes:
									typeof record.notes === "string" ? record.notes : undefined,
							};
						},
					);
					const pptxBytes = buildPptxPresentation({
						title,
						creator: "Naia Slides",
						slides: slideInputs,
					});
					const parsed = await parsePptxPresentation(pptxBytes);
					const safeName = `${title.replace(/\.pptx$/i, "")}.pptx`;
					const file = new File([pptxBytes as unknown as BlobPart], safeName, {
						type: PPTX_MIME_TYPE,
					});
					applyParsedPptxDeck(file, parsed);
					return JSON.stringify({
						ok: true,
						fileName: safeName,
						state: "ready",
						page: 1,
						totalPages: parsed.slides.length,
					});
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
	}, [applyParsedPptxDeck, exportPptxDeck, gotoPage, naia, runAction]);

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
			exportPptx: exportPptxDeck,
		});
		return () => appRegistry.updateApi("slides", undefined);
	}, [exportPptxDeck, gotoPage, runAction]);

	function loadPdf(file: File, companion?: SlidesOpenedPdf) {
		cancelSpeech();
		scriptRevisionRef.current++;
		selectedFileRef.current = file;
		setPptxDeck(null);
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

	async function loadSelectedDocument(file: File) {
		if (!confirmScriptReplacement()) return;
		if (!isPptxFile(file)) {
			loadPdf(file);
			return;
		}
		setPickingPdf(true);
		setImportPhase("parsing");
		try {
			const bytes = await readFileUint8Array(file);
			const deck = await parsePptxPresentation(bytes);
			applyParsedPptxDeck(file, deck);
		} catch (error) {
			setFileError(documentErrorKey(error));
			setImportPhase(null);
			Logger.warn(TAG, "browser PPTX import failed", {
				fileName: file.name,
				error: String(error),
			});
		} finally {
			setPickingPdf(false);
		}
	}

	useEffect(() => {
		if (!sampleDeck || selectedFileRef.current) return;
		if (!samplePromiseRef.current) {
			const nameFromUrl = (url: string) =>
				new URL(url, window.location.href).pathname.split("/").pop() || "";
			samplePromiseRef.current = (async () => {
				const scriptPromise = fetch(sampleDeck.scriptUrl)
					.then(async (response) => {
						if (!response.ok) return null;
						const contentType = response.headers.get("content-type") ?? "";
						if (contentType.includes("text/html")) return null;
						const text = await response.text();
						if (text.trimStart().startsWith("<!DOCTYPE") || text.trimStart().startsWith("<html")) {
							return null;
						}
						return {
							name: nameFromUrl(sampleDeck.scriptUrl),
							text,
						};
					})
					.catch(() => null);
				try {
					const response = await fetch(sampleDeck.pdfUrl);
					if (!response.ok) return null;
					const buf = new Uint8Array(await response.arrayBuffer());
					if (
						buf.length < 5 ||
						buf[0] !== 0x25 ||
						buf[1] !== 0x50 ||
						buf[2] !== 0x44 ||
						buf[3] !== 0x46
					) {
						return null;
					}
					const file = new File(
						[buf as unknown as BlobPart],
						nameFromUrl(sampleDeck.pdfUrl),
						{ type: "application/pdf" },
					);
					return { file, script: await scriptPromise, scriptReadFailed: false };
				} catch {
					return null;
				}
			})();
		}
		let cancelled = false;
		void samplePromiseRef.current.then((sample) => {
			if (!cancelled && sample && !selectedFileRef.current) {
				loadPdf(sample.file, sample);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [sampleDeck]);

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
			setScriptMarkdown(markdown);
			setSpeakerNotes(notes);
			if (stateRef.current.totalPages) {
				cancelSpeech();
				dispatch({
					type: "set-range",
					...presentationRangeForNotes(notes, stateRef.current.totalPages),
				});
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
		cancelSpeech();
		if (stateRef.current.mode === "presenting") dispatch({ type: "pause" });
		const nextMarkdown = replaceSlideScriptPage(
			scriptMarkdown,
			editingPage ?? state.page,
			draftText,
		);
		const nextNotes = parseSlideSpeakerNotes(nextMarkdown);
		setScriptMarkdown(nextMarkdown);
		setSpeakerNotes(nextNotes);
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
			// A failed stop retains native ownership, so keep Stop available to retry.
			setRecordingError(String(error));
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
					browserInputRef={browserInputRef}
					onPickNative={() => void pickPdf()}
					onPdfSelected={(file) => void loadSelectedDocument(file)}
					onScriptSelected={(file) => void loadScript(file)}
					onToggleFocus={() => setFocusMode((focused) => !focused)}
					onShowNotes={() => setNotesVisible(true)}
				/>
			</header>
			{focusMode ? (
				<button
					type="button"
					className="slides-app__focus-exit slides-app__focus-button"
					data-usage-event="slides-center-area.set-focus-mode-1.click"
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
					pptxDeck={pptxDeck}
					fileName={pdfName}
					page={state.page}
					viewerRef={viewerRef}
					viewerWidth={viewerWidth}
					totalPages={state.totalPages}
					onReady={(file, totalPages, texts) => {
						if (selectedFileRef.current !== file) return;
						dispatch({
							type: "loaded",
							totalPages,
							range: presentationRangeForNotes(notesRef.current, totalPages),
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
						onExportPptx={() => void exportPptxDeck()}
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
					dispatch({ type: "set-range", start, end });
				}}
				onGoto={gotoPage}
				onToggleRepeat={() => {
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
			/>
		</section>
	);
}
