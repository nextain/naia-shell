import { t } from "../../lib/i18n";

export interface SlidesStatusProps {
	modeLabel: string;
	pdfName: string;
	scriptName: string;
	draftDirty: boolean;
	unexportedScript: boolean;
	picking: boolean;
	importPhase: string | null;
	onCancelImport: () => void;
}

export function SlidesStatus({
	modeLabel,
	pdfName,
	scriptName,
	draftDirty,
	unexportedScript,
	picking,
	importPhase,
	onCancelImport,
}: SlidesStatusProps) {
	return (
		<output className="slides-app__status" aria-live="polite">
			<span className="slides-app__state-dot" />
			<strong>{modeLabel}</strong>
			<span>{pdfName || t("slides.noPdf")}</span>
			{scriptName ? <span>{scriptName}</span> : null}
			{draftDirty ? (
				<span data-testid="slides-script-unsaved">
					{t("slides.scriptDraftUnsaved")}
				</span>
			) : null}
			{unexportedScript ? (
				<span data-testid="slides-script-unexported">
					{t("slides.scriptChangesUnsaved")}
				</span>
			) : null}
			{picking ? (
				<span data-testid="slides-import-status">
					{t("slides.importing")}
					{importPhase ? (
						<>
							{" · "}
							{t(
								`slides.importPhase.${importPhase}` as Parameters<typeof t>[0],
							)}
						</>
					) : null}
					<button
						type="button"
						className="slides-app__focus-button"
						data-testid="slides-cancel-import"
						onClick={onCancelImport}
					>
						{t("slides.cancelImport")}
					</button>
				</span>
			) : null}
		</output>
	);
}
