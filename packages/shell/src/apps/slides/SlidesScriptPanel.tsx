import { t } from "../../lib/i18n";

export interface SlidesScriptPanelProps {
	page: number;
	totalPages: number;
	currentNarration: string;
	scriptEditorOpen: boolean;
	draftText: string;
	draftDirty: boolean;
	unexportedScript: boolean;
	onBeginEdit: () => void;
	onDownload: () => void;
	onHide: () => void;
	onDraftChange: (value: string) => void;
	onApply: () => void;
	onCancel: () => void;
}

export function SlidesScriptPanel({
	page,
	totalPages,
	currentNarration,
	scriptEditorOpen,
	draftText,
	draftDirty,
	unexportedScript,
	onBeginEdit,
	onDownload,
	onHide,
	onDraftChange,
	onApply,
	onCancel,
}: SlidesScriptPanelProps) {
	return (
		<aside
			id="slides-speaker-notes"
			className="slides-app__notes"
			aria-label={t("slides.notes")}
		>
			<div className="slides-app__progress">
				<span>{t("slides.current")}</span>
				<strong>{totalPages > 0 ? `${page} / ${totalPages}` : "—"}</strong>
			</div>
			<div className="slides-app__notes-heading">
				<h2>{t("slides.notes")}</h2>
				<div className="slides-app__notes-actions">
					<button
						type="button"
						className="slides-app__focus-button"
						data-testid="slides-edit-script"
						aria-label={t("slides.editScript")}
						disabled={!totalPages || scriptEditorOpen}
						onClick={onBeginEdit}
					>
						{t("slides.editScript")}
					</button>
					<button
						type="button"
						className="slides-app__focus-button"
						data-testid="slides-download-script"
						aria-label={t("slides.downloadEditedScript")}
						disabled={!unexportedScript && !draftDirty}
						onClick={onDownload}
					>
						{t("slides.downloadEditedScript")}
					</button>
				</div>
				<button
					type="button"
					className="slides-app__focus-button"
					aria-label={t("slides.notesHide")}
					aria-expanded={true}
					aria-controls="slides-speaker-notes"
					onClick={onHide}
				>
					×
				</button>
			</div>
			{scriptEditorOpen ? (
				<div className="slides-app__script-editor">
					<label htmlFor="slides-script-editor">
						{t("slides.scriptEditorLabel")}
					</label>
					<textarea
						id="slides-script-editor"
						data-testid="slides-script-editor"
						aria-label={t("slides.scriptEditorLabel")}
						value={draftText}
						onChange={(event) => onDraftChange(event.currentTarget.value)}
					/>
					<div className="slides-app__script-editor-actions">
						<button
							type="button"
							className="slides-app__primary"
							data-testid="slides-apply-script"
							aria-label={t("slides.applyScriptEdit")}
							onClick={onApply}
						>
							{t("slides.applyScriptEdit")}
						</button>
						<button
							type="button"
							data-testid="slides-cancel-script"
							aria-label={t("slides.cancelScriptEdit")}
							onClick={onCancel}
						>
							{t("slides.cancelScriptEdit")}
						</button>
					</div>
				</div>
			) : (
				<p data-testid="slides-current-note">
					{totalPages > 0 ? currentNarration : t("slides.noNotes")}
				</p>
			)}
			<div className="slides-app__shortcuts">
				<span>← →</span>
				<span>{t("slides.shortcutNavigate")}</span>
				<span>Space</span>
				<span>{t("slides.shortcutPause")}</span>
			</div>
		</aside>
	);
}
