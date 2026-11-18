import type { RefObject } from "react";
import { t } from "../../lib/i18n";
import { PPTX_MIME_TYPE } from "../../lib/pptx-ooxml";

export interface SlidesFileActionsProps {
	nativePickerAvailable: boolean;
	picking: boolean;
	focusMode: boolean;
	notesVisible: boolean;
	browserInputRef?: RefObject<HTMLInputElement>;
	onPickNative: () => void;
	onPdfSelected: (file: File) => void;
	onScriptSelected: (file: File) => void;
	onToggleFocus: () => void;
	onShowNotes: () => void;
}

const PRESENTATION_ACCEPT = `application/pdf,.pdf,${PPTX_MIME_TYPE},.pptx`;

/** File inputs and the document picker hint live together so the center stays focused on presentation state. */
export function SlidesFileActions({
	nativePickerAvailable,
	picking,
	focusMode,
	notesVisible,
	browserInputRef,
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
				title={t("slides.pptxNativeHint")}
			>
				{t("slides.openPresentation")}
				<input
					ref={browserInputRef}
					aria-label={t("slides.openPresentation")}
					type="file"
					accept={PRESENTATION_ACCEPT}
					disabled={picking}
					data-usage-event="slides-file-actions.on-pick-native-1.click"
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
				{t("slides.pptxNativeHint")}
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
					data-usage-event="slides-file-actions.on-toggle-focus-2.click"
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
						data-usage-event="slides-file-actions.on-show-notes-3.click"
						onClick={onShowNotes}
					>
						{t("slides.notesShow")}
					</button>
				) : null}
			</div>
		</div>
	);
}
