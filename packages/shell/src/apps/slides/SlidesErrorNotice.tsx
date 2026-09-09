import { t } from "../../lib/i18n";

export type SlidesFileError =
	| "pdf"
	| "script"
	| "import"
	| "unsaved"
	| "export"
	| "exportUnsaved"
	| "converter"
	| "invalidPptx"
	| "conversionFailed"
	| "conversionTimeout"
	| "busy";

export interface SlidesErrorNoticeProps {
	speechError: boolean;
	recordingError: string | null;
	fullscreenError: boolean;
	fileError: SlidesFileError | null;
}

export function SlidesErrorNotice({
	speechError,
	recordingError,
	fullscreenError,
	fileError,
}: SlidesErrorNoticeProps) {
	return (
		<>
			{speechError ? (
				<div className="slides-app__error" role="alert">
					{t("slides.speechError")}
				</div>
			) : null}
			{recordingError ? (
				<div className="slides-app__error" role="alert">
					{recordingError}
				</div>
			) : null}
			{fullscreenError ? (
				<div className="slides-app__error" role="alert">
					{t("slides.fullscreenError")}
				</div>
			) : null}
			{fileError ? (
				<div className="slides-app__error" role="alert">
					{fileError === "script"
						? t("slides.scriptError")
						: fileError === "import"
							? t("slides.importError")
							: fileError === "unsaved"
								? t("slides.scriptChangesUnsaved")
								: fileError === "export"
									? t("slides.exportError")
									: fileError === "exportUnsaved"
										? t("slides.exportUnsaved")
									: fileError === "converter"
										? t("slides.converterUnavailable")
										: fileError === "invalidPptx"
											? t("slides.invalidPptx")
											: fileError === "conversionFailed"
												? t("slides.conversionFailed")
												: fileError === "conversionTimeout"
													? t("slides.conversionTimeout")
													: fileError === "busy"
														? t("slides.importBusy")
														: t("slides.loadError")}
				</div>
			) : null}
		</>
	);
}
