import { t } from "../../lib/i18n";

export interface SlidesFileActionsProps {
	nativePickerAvailable: boolean;
	picking: boolean;
	focusMode: boolean;
	notesVisible: boolean;
	onPickNative: () => void;
	onPdfSelected: (file: File) => void;
	onScriptSelected: (file: File) => void;
	onToggleFocus: () => void;
	onShowNotes: () => void;
}

/** File inputs and the native picker hint live together so the center stays focused on presentation state. */
export function SlidesFileActions({
	nativePickerAvailable,
	picking,
	focusMode,
	notesVisible,
	onPickNative,
	onPdfSelected,
	onScriptSelected,
	onToggleFocus,
	onShowNotes,
}: SlidesFileActionsProps) {
	return (
		<div className="slides-app__file-actions">
			<label
				className="slides-app__file-button"
				data-testid="slides-open-document"
				title={
					nativePickerAvailable
						? t("slides.pptxNativeHint")
						: t("slides.pptxBrowserHint")
				}
			>
				{nativePickerAvailable
					? t("slides.openPresentation")
					: t("slides.openPdf")}
				<input
					aria-label={
						nativePickerAvailable
							? t("slides.openPresentation")
							: t("slides.openPdf")
					}
					type="file"
					accept="application/pdf,.pdf"
					disabled={picking}
					onClick={(event) => {
						if (!nativePickerAvailable) return;
						event.preventDefault();
						onPickNative();
					}}
					onChange={(event) => {
						const file = event.currentTarget.files?.[0];
						if (file) onPdfSelected(file);
						event.currentTarget.value = "";
					}}
				/>
			</label>
			<small className="slides-app__picker-hint">
				{nativePickerAvailable
					? t("slides.pptxNativeHint")
					: t("slides.pptxBrowserHint")}
			</small>
			<label className="slides-app__file-button slides-app__file-button--secondary">
				{t("slides.openScript")}
				<input
					aria-label={t("slides.openScript")}
					type="file"
					accept="text/markdown,text/plain,.md,.txt"
					disabled={picking}
					onChange={(event) => {
						const file = event.currentTarget.files?.[0];
						if (file) onScriptSelected(file);
						event.currentTarget.value = "";
					}}
				/>
			</label>
			<div className="slides-app__file-actions slides-app__file-actions--secondary">
				<button
					type="button"
					className="slides-app__focus-button"
					onClick={onToggleFocus}
				>
					{focusMode ? t("slides.focusExit") : t("slides.focusStart")}
				</button>
				{!notesVisible ? (
					<button
						type="button"
						className="slides-app__focus-button"
						aria-expanded={false}
						aria-controls="slides-speaker-notes"
						onClick={onShowNotes}
					>
						{t("slides.notesShow")}
					</button>
				) : null}
			</div>
		</div>
	);
}
