import {
	type PointerEvent as ReactPointerEvent,
	type RefObject,
	Suspense,
	lazy,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { t } from "../../lib/i18n";
import {
	UI_PREFERENCE_KEYS,
	patchUiPreferences,
	useUiPreference,
} from "../../lib/ui-preferences";
import { QuadIframePane, normalizeQuadPaneUrl, probeServerHealth } from "./QuadIframePane";
export { normalizeQuadPaneUrl, probeServerHealth };
import type { FileLocation, TerminalHandle } from "./Terminal";
import type { TerminalSource, TerminalSourceKind } from "./terminal-source";

const LazyTerminal = lazy(() =>
	import("./Terminal").then((module) => ({ default: module.Terminal })),
);

export interface WorkspaceQuadViewProps {
	terminalSource: TerminalSource;
	terminalRef?: RefObject<TerminalHandle>;
	onAskAi?: (path: string) => void;
	onFileLocation?: (location: FileLocation) => void;
	availableSources?: TerminalSourceKind[];
	selectedSourceKind?: TerminalSourceKind;
	onSelectSourceKind?: (kind: TerminalSourceKind) => void;
	workspaceRoot?: string;
}

export const DEFAULT_RATIOS = [0.34, 0.33, 0.33];
export const MIN_RATIO = 0.15;

export function validateRatios(val: unknown): number[] {
	if (!Array.isArray(val) || val.length !== 3) {
		return [...DEFAULT_RATIOS];
	}
	const [r0, r1, r2] = val;
	if (
		typeof r0 !== "number" ||
		!Number.isFinite(r0) ||
		typeof r1 !== "number" ||
		!Number.isFinite(r1) ||
		typeof r2 !== "number" ||
		!Number.isFinite(r2)
	) {
		return [...DEFAULT_RATIOS];
	}
	if (r0 < MIN_RATIO || r1 < MIN_RATIO || r2 < MIN_RATIO) {
		return [...DEFAULT_RATIOS];
	}
	const sum = r0 + r1 + r2;
	if (Math.abs(sum - 1.0) > 0.05) {
		return [...DEFAULT_RATIOS];
	}
	return [r0, r1, r2];
}

export function WorkspaceQuadView(props: WorkspaceQuadViewProps) {
	const savedRatios = useUiPreference<number[]>(
		UI_PREFERENCE_KEYS.workspaceSplitRatios,
		DEFAULT_RATIOS,
	);

	const [ratios, setRatios] = useState<number[]>(() =>
		validateRatios(savedRatios),
	);
	const latestRatiosRef = useRef<number[]>(ratios);
	latestRatiosRef.current = ratios;
	const [isResizing, setIsResizing] = useState(false);

	const containerRef = useRef<HTMLDivElement>(null);
	const dragRef = useRef<{
		handleIndex: number;
		startX: number;
		startRatios: number[];
		containerWidth: number;
	} | null>(null);

	useEffect(() => {
		if (!dragRef.current) {
			const valid = validateRatios(savedRatios);
			setRatios((current) => {
				if (
					Math.abs(current[0] - valid[0]) < 0.001 &&
					Math.abs(current[1] - valid[1]) < 0.001 &&
					Math.abs(current[2] - valid[2]) < 0.001
				) {
					return current;
				}
				latestRatiosRef.current = valid;
				return valid;
			});
		}
	}, [savedRatios]);

	const handlePointerDown = useCallback(
		(handleIndex: number, event: ReactPointerEvent<HTMLDivElement>) => {
			const container = containerRef.current;
			if (!container) return;
			const rect = container.getBoundingClientRect();
			if (rect.width <= 0) return;

			dragRef.current = {
				handleIndex,
				startX: event.clientX,
				startRatios: [...ratios],
				containerWidth: rect.width,
			};

			setIsResizing(true);
			document.body.classList.add("resizing-col");
			if (typeof (event.currentTarget as HTMLElement).setPointerCapture === "function") {
				try {
					(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
				} catch {}
			}
		},
		[ratios],
	);

	const handlePointerMove = useCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			const drag = dragRef.current;
			if (!drag) return;

			const deltaX = event.clientX - drag.startX;
			const deltaRatio = deltaX / drag.containerWidth;
			const next = [...drag.startRatios];

			if (drag.handleIndex === 0) {
				let r0 = drag.startRatios[0] + deltaRatio;
				let r1 = drag.startRatios[1] - deltaRatio;
				const sum = drag.startRatios[0] + drag.startRatios[1];

				r0 = Math.max(MIN_RATIO, Math.min(sum - MIN_RATIO, r0));
				r1 = sum - r0;

				next[0] = Math.round(r0 * 1000) / 1000;
				next[1] = Math.round(r1 * 1000) / 1000;
			} else if (drag.handleIndex === 1) {
				let r1 = drag.startRatios[1] + deltaRatio;
				let r2 = drag.startRatios[2] - deltaRatio;
				const sum = drag.startRatios[1] + drag.startRatios[2];

				r1 = Math.max(MIN_RATIO, Math.min(sum - MIN_RATIO, r1));
				r2 = sum - r1;

				next[1] = Math.round(r1 * 1000) / 1000;
				next[2] = Math.round(r2 * 1000) / 1000;
			}

			latestRatiosRef.current = next;
			setRatios(next);
		},
		[],
	);

	const endDrag = useCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			if (!dragRef.current) return;
			dragRef.current = null;
			setIsResizing(false);
			document.body.classList.remove("resizing-col");

			if (typeof (event.currentTarget as HTMLElement).releasePointerCapture === "function") {
				try {
					(event.currentTarget as HTMLElement).releasePointerCapture(
						event.pointerId,
					);
				} catch {}
			}

			const toSave = latestRatiosRef.current;
			void patchUiPreferences({
				[UI_PREFERENCE_KEYS.workspaceSplitRatios]: toSave,
			});
		},
		[],
	);

	const {
		terminalSource,
		terminalRef,
		onAskAi,
		onFileLocation,
		availableSources,
		selectedSourceKind,
		onSelectSourceKind,
	} = props;

	return (
		<div
			ref={containerRef}
			className={`workspace-quad${isResizing ? " workspace-quad--resizing" : ""}`}
			data-testid="workspace-quad"
		>
			<div
				className="workspace-quad__pane workspace-quad__pane--terminal"
				data-testid="quad-pane-terminal"
				style={{ flex: `${ratios[0]} 1 0%`, minWidth: "140px" }}
			>
				<header className="workspace-quad__pane-header">
					<div className="workspace-quad__pane-title-group">
						<span className="workspace-quad__pane-title">
							{t("workspace.quadTerminal")}
						</span>
						{availableSources &&
							availableSources.length > 1 &&
							onSelectSourceKind && (
								<div
									className="workspace-quad__source-switch"
									role="radiogroup"
									aria-label={t("workspace.quadSourceSelect")}
								>
									{availableSources.map((kind) => (
										<button
											key={kind}
											type="button"
											className={`workspace-quad__source-btn${selectedSourceKind === kind ? " workspace-quad__source-btn--active" : ""}`}
											onClick={() => onSelectSourceKind(kind)}
											data-testid={`quad-source-${kind}`}
										>
											{kind === "pty" ? "PTY" : "Herdr"}
										</button>
									))}
								</div>
							)}
					</div>
					<div className="workspace-quad__pane-actions">
						{terminalSource.runOpencode && (
							<button
								type="button"
								className="workspace-quad__opencode-btn"
								onClick={terminalSource.runOpencode}
								title={t("workspace.quadRunOpencode")}
								data-testid="quad-run-opencode"
							>
								opencode
							</button>
						)}
						<button
							type="button"
							className="workspace-quad__pane-btn"
							onClick={terminalSource.retry}
							title={t("workspace.herdrRetry")}
							data-testid="quad-terminal-restart"
						>
							↻
						</button>
					</div>
				</header>

				<div className="workspace-quad__pane-content workspace-quad__terminal-host">
					{terminalSource.pty ? (
						<Suspense fallback={null}>
							<LazyTerminal
								ref={terminalRef}
								pty_id={terminalSource.pty.pty_id}
								active={true}
								workingDir={terminalSource.workingDir}
								onExit={terminalSource.onPtyExit}
								onReady={terminalSource.onTerminalReady}
								onFileLocation={onFileLocation}
								onAskAi={onAskAi}
							/>
						</Suspense>
					) : terminalSource.launchError ? (
						<div
							className="workspace-quad__state"
							role="alert"
							data-testid="quad-terminal-state"
						>
							<span>{terminalSource.launchError}</span>
							<button
								type="button"
								className="workspace-quad__retry-btn"
								onClick={terminalSource.retry}
								data-testid="quad-terminal-reconnect"
							>
								{t("workspace.herdrRetry")}
							</button>
						</div>
					) : (
						<div
							className="workspace-quad__state"
							role="status"
							aria-live="polite"
							data-testid="quad-terminal-state"
						>
							<span>
								{terminalSource.launching
									? t("workspace.herdrStarting")
									: t("workspace.herdrExited")}
							</span>
							{!terminalSource.launching && (
								<button
									type="button"
									className="workspace-quad__retry-btn"
									onClick={terminalSource.retry}
									data-testid="quad-terminal-reconnect"
								>
									{t("workspace.herdrRetry")}
								</button>
							)}
						</div>
					)}
				</div>
			</div>

			<div
				role="separator"
				aria-orientation="vertical"
				className="resize-handle workspace-quad__handle"
				data-testid="quad-handle-0"
				onPointerDown={(e) => handlePointerDown(0, e)}
				onPointerMove={handlePointerMove}
				onPointerUp={endDrag}
				onPointerCancel={endDrag}
				tabIndex={0}
				title={t("workspace.quadResizeHandle")}
			/>

			<div
				className="workspace-quad__pane-wrapper"
				style={{ flex: `${ratios[1]} 1 0%`, minWidth: "140px" }}
			>
				<QuadIframePane
					title={t("workspace.quadDocs")}
					paneId="docs"
				/>
			</div>

			<div
				role="separator"
				aria-orientation="vertical"
				className="resize-handle workspace-quad__handle"
				data-testid="quad-handle-1"
				onPointerDown={(e) => handlePointerDown(1, e)}
				onPointerMove={handlePointerMove}
				onPointerUp={endDrag}
				onPointerCancel={endDrag}
				tabIndex={0}
				title={t("workspace.quadResizeHandle")}
			/>

			<div
				className="workspace-quad__pane-wrapper"
				style={{ flex: `${ratios[2]} 1 0%`, minWidth: "140px" }}
			>
				<QuadIframePane
					title={t("workspace.quadBoard")}
					paneId="dashboard"
				/>
			</div>
		</div>
	);
}
