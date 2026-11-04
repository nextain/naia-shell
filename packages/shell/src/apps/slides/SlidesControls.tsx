import type { SlidePresenterState } from "../../lib/slide-presenter";
import { t } from "../../lib/i18n";

export type SlidesControlAction =
	| "start"
	| "pause"
	| "resume"
	| "stop"
	| "next"
	| "previous";

export interface SlidesControlsProps {
	state: SlidePresenterState;
	fullscreen: boolean;
	recording: boolean;
	editing: boolean;
	onAction: (action: SlidesControlAction) => void;
	onRangeChange: (start: number, end: number) => void;
	onGoto: (page: number) => void;
	onToggleRepeat: () => void;
	onToggleFullscreen: () => void;
	onToggleRecording: () => void;
}

export function SlidesControls({
	state,
	fullscreen,
	recording,
	editing,
	onAction,
	onRangeChange,
	onGoto,
	onToggleRepeat,
	onToggleFullscreen,
	onToggleRecording,
}: SlidesControlsProps) {
	return (
		<footer
			className="slides-app__controls"
			aria-label={t("slides.controls")}
		>
			<label className="slides-app__page-input">
				{t("slides.rangeStart")}
				<input
					type="number"
					min={1}
					max={Math.max(1, state.totalPages)}
					value={state.rangeStart}
					disabled={editing || !state.totalPages}
					onChange={(event) => {
						const start = Number(event.currentTarget.value);
						onRangeChange(start, Math.max(start, state.rangeEnd));
					}}
				/>
			</label>
			<label className="slides-app__page-input">
				{t("slides.rangeEnd")}
				<input
					type="number"
					min={1}
					max={Math.max(1, state.totalPages)}
					value={state.rangeEnd || 1}
					disabled={editing || !state.totalPages}
					onChange={(event) => {
						const end = Number(event.currentTarget.value);
						onRangeChange(Math.min(state.rangeStart, end), end);
					}}
				/>
			</label>
			<button
				type="button"
				data-usage-event="slides-controls.on-action-1.click"
				onClick={() => onAction("previous")}
				disabled={editing || state.totalPages === 0 || state.page <= 1}
				aria-label={t("slides.previous")}
			>
				←
			</button>
			<button
				type="button"
				className="slides-app__primary"
				data-usage-event="slides-controls.on-action-2.click"
				onClick={() =>
					onAction(
						state.mode === "presenting"
							? "pause"
							: state.mode === "paused" || state.mode === "answering"
								? "resume"
								: "start",
					)
				}
				disabled={editing || state.totalPages === 0}
			>
				{state.mode === "presenting"
					? t("slides.pause")
					: state.mode === "paused" || state.mode === "answering"
						? t("slides.resume")
						: t("slides.start")}
			</button>
			<button
				type="button"
				data-usage-event="slides-controls.on-action-3.click"
				onClick={() => onAction("stop")}
				disabled={editing || state.totalPages === 0}
			>
				{t("slides.stop")}
			</button>
			<button
				type="button"
				aria-pressed={state.repeat}
				className={state.repeat ? "slides-app__primary" : undefined}
				disabled={editing || state.totalPages === 0}
				data-usage-event="slides-controls.on-toggle-repeat-4.click"
				onClick={onToggleRepeat}
			>
				{t("slides.repeat")}
			</button>
			<button
				type="button"
				data-usage-event="slides-controls.on-action-5.click"
				onClick={() => onAction("next")}
				disabled={editing || state.totalPages === 0 || state.page >= state.totalPages}
				aria-label={t("slides.next")}
			>
				→
			</button>
			<label className="slides-app__page-input">
				{t("slides.goto")}
				<input
					type="number"
					min={1}
					max={Math.max(1, state.totalPages)}
					value={state.page}
					disabled={editing || state.totalPages === 0}
					onChange={(event) => onGoto(Number(event.currentTarget.value))}
				/>
			</label>
			<button
				type="button"
				data-usage-event="slides-controls.on-toggle-fullscreen-6.click"
				onClick={onToggleFullscreen}
				aria-pressed={fullscreen}
				disabled={editing || state.totalPages === 0}
			>
				{fullscreen ? t("slides.fullscreenExit") : t("slides.fullscreen")}
			</button>
			<button
				type="button"
				data-usage-event="slides-controls.on-toggle-recording-7.click"
				onClick={onToggleRecording}
				disabled={editing || state.totalPages === 0}
				aria-label={recording ? t("slides.recordStop") : t("slides.recordStart")}
			>
				{recording ? t("slides.recordStop") : t("slides.recordStart")}
			</button>
		</footer>
	);
}
