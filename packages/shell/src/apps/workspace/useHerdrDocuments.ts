import { invoke } from "@tauri-apps/api/core";
import {
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import type { AppCenterProps } from "../../lib/app-registry";
import { Logger } from "../../lib/logger";
import {
	UI_PREFERENCE_KEYS,
	useUiPreference,
} from "../../lib/ui-preferences";
import { useAppStore } from "../../stores/app";
import type { EditorHandle } from "./Editor";
import type { FileLocation, TerminalHandle } from "./Terminal";
import type { HerdrSnapshot } from "./herdr";
import type { ClassifiedDir } from "./types";

interface DocumentsOptions {
	naia: AppCenterProps["naia"];
	locationGenerationRef: RefObject<number>;
	snapshotRef: RefObject<HerdrSnapshot | null>;
	setSurface: (surface: "herdr" | "viewer") => void;
	showHerdr: () => void;
	terminalRef: RefObject<TerminalHandle>;
}

function useClassifyDirs() {
	return useUiPreference<ClassifiedDir[] | null>(
		UI_PREFERENCE_KEYS.classifiedDirs,
		null,
	);
}

export function useHerdrDocuments({
	naia: _naia,
	locationGenerationRef,
	snapshotRef,
	setSurface,
	showHerdr,
	terminalRef,
}: DocumentsOptions) {
	const [openDocs, setOpenDocs] = useState<string[]>([]);
	const [openFilePath, setOpenFilePath] = useState("");
	const [quickOpenVisible, setQuickOpenVisible] = useState(false);
	const editorRef = useRef<EditorHandle>(null);
	const fileTreeRegionRef = useRef<HTMLDivElement>(null);
	const classifiedDirs = useClassifyDirs();
	const resolveFile = useCallback(
		(path: string) => {
			const snapshot = snapshotRef.current;
			if (!snapshot?.focused_workspace_id) {
				return Promise.reject(
					new Error("Herdr has no focused workspace for file resolution"),
				);
			}
			return invoke<string>("workspace_resolve_file_location", {
				path,
				expectedWorkspaceId: snapshot.focused_workspace_id,
				expectedPaneId: snapshot?.focused_pane_id ?? null,
			});
		},
		[snapshotRef],
	);

	const openResolvedFile = useCallback(
		async (path: string) => {
			const generation = locationGenerationRef.current;
			const resolved = await resolveFile(path);
			if (generation !== locationGenerationRef.current) {
				throw new Error("Workspace changed while resolving file location");
			}
			setOpenDocs((docs) =>
				docs.includes(resolved) ? docs : [...docs, resolved],
			);
			setOpenFilePath(resolved);
			setSurface("viewer");
			requestAnimationFrame(() =>
				fileTreeRegionRef.current?.focus({ preventScroll: true }),
			);
			return resolved;
		},
		[locationGenerationRef, resolveFile, setSurface],
	);

	const openLocation = useCallback(
		async (location: FileLocation) => {
			const generation = locationGenerationRef.current;
			try {
				const path = await resolveFile(location.path);
				if (generation !== locationGenerationRef.current) return;
				setOpenDocs((docs) => (docs.includes(path) ? docs : [...docs, path]));
				setOpenFilePath(path);
				setSurface("viewer");
				requestAnimationFrame(() => {
					fileTreeRegionRef.current?.focus({ preventScroll: true });
					if (location.line) {
						editorRef.current?.revealLocation(
							location.line,
							location.column,
							path,
						);
					}
				});
			} catch (error) {
				Logger.warn("HerdrWorkspace", "Rejected terminal file location", {
					error: String(error),
					path: location.path,
				});
			}
		},
		[locationGenerationRef, resolveFile, setSurface],
	);

	const openFilePathRef = useRef(openFilePath);
	openFilePathRef.current = openFilePath;

	const closeDoc = useCallback(
		(path: string) => {
			setOpenDocs((docs) => {
				const index = docs.indexOf(path);
				const next = docs.filter((doc) => doc !== path);
				setOpenFilePath((active) => {
					if (active !== path) return active;
					const replacement = next[Math.min(index, next.length - 1)] ?? "";
					if (!replacement) {
						showHerdr();
						requestAnimationFrame(() => terminalRef.current?.focus());
					}
					return replacement;
				});
				return next;
			});
		},
		[showHerdr, terminalRef],
	);

	const closeDocRef = useRef(closeDoc);
	closeDocRef.current = closeDoc;

	useEffect(() => {
		const handler = (event: KeyboardEvent) => {
			if (!(event.ctrlKey || event.metaKey)) return;
			const key = event.key.toLowerCase();
			if (key === "p") {
				if (useAppStore.getState().activeApp !== "workspace") return;
				event.preventDefault();
				setQuickOpenVisible((visible) => !visible);
			} else if (key === "w") {
				if (useAppStore.getState().activeApp !== "workspace") return;
				if (!openFilePathRef.current) return;
				event.preventDefault();
				closeDocRef.current(openFilePathRef.current);
			}
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, []);

	const openFromTree = useCallback(
		(path: string) => {
			setOpenDocs((docs) => (docs.includes(path) ? docs : [...docs, path]));
			setOpenFilePath(path);
			setSurface("viewer");
		},
		[setSurface],
	);
	const sendToNaia = useCallback((path: string) => {
		window.dispatchEvent(new CustomEvent("naia:ask-ai", { detail: path }));
	}, []);

	return {
		openDocs,
		openFilePath,
		quickOpenVisible,
		classifiedDirs,
		editorRef,
		fileTreeRegionRef,
		setOpenFilePath,
		setQuickOpenVisible,
		openResolvedFile,
		openLocation,
		openFromTree,
		sendToNaia,
		closeDoc,
	};
}
